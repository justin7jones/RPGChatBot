/**
 * vector-store-files.js
 *
 * File management for an OpenAI vector store, used by the web frontend's
 * "Files" panel: list, add, replace, delete, read, and export-as-ZIP.
 *
 * One important limitation shapes this module: files uploaded for
 * retrieval (purpose "assistants", which is what upload-rag-data.js and
 * this module use) cannot be downloaded back from OpenAI in their original
 * form -- files.content() answers 400 "Not allowed to download files of
 * purpose: assistants". What the vector store *does* expose is the parsed
 * text of each file. For text formats (.md, .txt, .json, ...) that is the
 * file itself; for PDFs/Word docs it is the extracted text, so those are
 * downloaded as a .txt rendition. "Replace"/edit works by uploading new
 * content and deleting the old file, since OpenAI files are immutable.
 */

import { toFile } from 'openai';
import { zipSync, strToU8 } from 'fflate';
import { openai } from './openai-engine.js';

// Extensions whose extracted text is the same as the original file, so they
// can be downloaded under their own name and edited in the browser.
const TEXT_EXTENSIONS = new Set([
  '.md', '.markdown', '.txt', '.json', '.csv', '.html', '.htm', '.xml', '.yaml', '.yml',
]);

function extensionOf(filename) {
  const dot = filename.lastIndexOf('.');
  return dot === -1 ? '' : filename.slice(dot).toLowerCase();
}

export function isEditableText(filename) {
  return TEXT_EXTENSIONS.has(extensionOf(filename));
}

/** Filename to download a file's extracted text under. */
export function downloadNameFor(filename) {
  return isEditableText(filename) ? filename : `${filename}.txt`;
}

// OpenAI file objects are immutable, so filename/size can be cached by id
// to avoid a files.retrieve() round trip for every file on every listing.
const fileInfoCache = new Map(); // fileId -> { filename, bytes }

async function fileInfo(fileId) {
  const cached = fileInfoCache.get(fileId);
  if (cached) return cached;
  let info;
  try {
    const file = await openai.files.retrieve(fileId);
    info = { filename: file.filename, bytes: file.bytes };
  } catch {
    // The underlying file may be gone while still referenced; show the id.
    return { filename: fileId, bytes: 0 };
  }
  fileInfoCache.set(fileId, info);
  return info;
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

/** Lists the files in a vector store, sorted by filename. */
export async function listStoreFiles(vectorStoreId) {
  const entries = [];
  for await (const vsFile of openai.vectorStores.files.list(vectorStoreId, { limit: 100 })) {
    entries.push(vsFile);
  }

  const files = await mapLimit(entries, 6, async (vsFile) => {
    const info = await fileInfo(vsFile.id);
    return {
      id: vsFile.id,
      filename: info.filename,
      size: info.bytes,
      status: vsFile.status,
      error: vsFile.last_error?.message || null,
      createdAt: vsFile.created_at,
      editable: isEditableText(info.filename),
    };
  });

  return files.sort((a, b) => a.filename.localeCompare(b.filename));
}

/** Throws a 404-status error unless the file belongs to this vector store. */
export async function assertInStore(vectorStoreId, fileId) {
  await openai.vectorStores.files.retrieve(fileId, { vector_store_id: vectorStoreId });
}

/** Returns the extracted text of a file in the store. */
export async function getFileText(vectorStoreId, fileId) {
  const parts = [];
  for await (const chunk of openai.vectorStores.files.content(fileId, {
    vector_store_id: vectorStoreId,
  })) {
    if (chunk.type === 'text') parts.push(chunk.text);
  }
  return parts.join('\n');
}

/**
 * Uploads a buffer and attaches it to the vector store. Does not wait for
 * indexing to finish -- the file shows as "in_progress" until it does.
 * Returns the new file id.
 */
export async function addFile(vectorStoreId, { buffer, filename }) {
  const uploaded = await openai.files.create({
    file: await toFile(buffer, filename),
    purpose: 'assistants',
  });
  try {
    await openai.vectorStores.files.create(vectorStoreId, { file_id: uploaded.id });
  } catch (err) {
    await openai.files.delete(uploaded.id).catch(() => {});
    throw err;
  }
  fileInfoCache.set(uploaded.id, { filename, bytes: buffer.length });
  return uploaded.id;
}

/** Detaches a file from the vector store and deletes the underlying file. */
export async function removeFile(vectorStoreId, fileId) {
  await openai.vectorStores.files.delete(fileId, { vector_store_id: vectorStoreId });
  await openai.files.delete(fileId).catch((err) => {
    if (err.status !== 404) throw err;
  });
  fileInfoCache.delete(fileId);
}

/**
 * Uploads files, replacing any existing file with the same name (the same
 * behavior as upload-rag-data.js, so re-uploading an edited doc doesn't
 * leave duplicate content in the store). Returns { added, replaced }.
 */
export async function addOrReplaceFiles(vectorStoreId, files) {
  const existing = await listStoreFiles(vectorStoreId);
  let replaced = 0;
  for (const file of files) {
    const oldIds = existing.filter((e) => e.filename === file.filename).map((e) => e.id);
    await addFile(vectorStoreId, file);
    for (const oldId of oldIds) {
      await removeFile(vectorStoreId, oldId);
      replaced++;
    }
  }
  return { added: files.length - replaced, replaced };
}

/** Replaces one file's content, keeping its filename. Returns the new file id. */
export async function replaceFile(vectorStoreId, fileId, buffer) {
  const { filename } = await fileInfo(fileId);
  const newId = await addFile(vectorStoreId, { buffer, filename });
  await removeFile(vectorStoreId, fileId);
  return newId;
}

/**
 * Builds a ZIP of every file's extracted text. Files that can't be read
 * (still indexing, failed) are left out and listed in _skipped.txt.
 */
export async function buildStoreZip(vectorStoreId) {
  const files = await listStoreFiles(vectorStoreId);
  const entries = {};
  const skipped = [];
  const usedNames = new Set();

  const uniqueName = (name) => {
    if (!usedNames.has(name)) return name;
    const ext = extensionOf(name);
    const stem = name.slice(0, name.length - ext.length);
    let n = 2;
    while (usedNames.has(`${stem} (${n})${ext}`)) n++;
    return `${stem} (${n})${ext}`;
  };

  await mapLimit(files, 4, async (file) => {
    try {
      if (file.status !== 'completed') throw new Error(`status is ${file.status}`);
      const text = await getFileText(vectorStoreId, file.id);
      const name = uniqueName(downloadNameFor(file.filename).replace(/[\\/]/g, '_'));
      usedNames.add(name);
      entries[name] = strToU8(text);
    } catch (err) {
      skipped.push(`${file.filename}: ${err.message}`);
    }
  });

  if (skipped.length > 0) {
    entries['_skipped.txt'] = strToU8(`${skipped.sort().join('\n')}\n`);
  }

  return Buffer.from(zipSync(entries));
}
