/**
 * upload-rag-data.js
 *
 * Loads contextual RAG documents (rulebooks, lore, campaign notes, etc.)
 * into an OpenAI vector store so the RPG Chat bot can ground its answers
 * in them via the file_search tool.
 *
 * Usage:
 *   node upload-rag-data.js [--guild <discord-server-id>] [--label <name>] <file-or-folder> [...]
 *
 * Examples:
 *   # Default/global store (used by any server with no dedicated store):
 *   node upload-rag-data.js ./rag-docs
 *
 *   # Store scoped to one Discord server (multi-server setups):
 *   node upload-rag-data.js --guild 123456789012345678 --label shadowdark ./rag-docs
 *
 * How to find a Discord server ID: in Discord, enable Settings > Advanced >
 * Developer Mode, then right-click the server icon and choose "Copy Server ID".
 *
 * --- Default/global store (no --guild) ---
 * On first run (no OPENAI_VECTOR_STORE_ID in .env), this creates a new
 * vector store and prints its ID -- copy that into .env as
 * OPENAI_VECTOR_STORE_ID, then restart the bot (pm2 restart rpg-chat).
 * On later runs, set OPENAI_VECTOR_STORE_ID in .env first so new files get
 * added to the *same* store instead of creating a duplicate one.
 *
 * --- Per-server store (--guild <id>) ---
 * The first time you use a given --guild ID, this creates a new vector
 * store and saves the guildId -> vectorStoreId mapping to
 * guild-config.json. index.js reads that file on every message, so the
 * bot picks up the new server automatically -- no .env edits or restart
 * needed. Run the command again with the same --guild ID to add more
 * files to that same server's store.
 *
 * --- Re-running against files you've already uploaded ---
 * Before uploading, this script lists what's already in the target
 * vector store and compares each local file (by filename) against what's
 * there, using file size as a cheap change-detection signal:
 *   - New filename                 -> uploaded
 *   - Same filename, same size     -> skipped (assumed unchanged)
 *   - Same filename, different size -> old version deleted, new one
 *                                      uploaded in its place
 * This means it's safe to re-run the same command repeatedly (e.g. after
 * adding one new file to a folder) without creating duplicate content in
 * the store. Note: file size is a proxy for "changed," not a byte-for-byte
 * hash -- an edit that happens to produce the exact same file size won't
 * be detected. Also note: any duplicate filenames already in the store
 * from before this check existed aren't automatically cleaned up.
 */

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import OpenAI from 'openai';
import { getGuildVectorStoreId, setGuildVectorStoreId } from './guild-store.js';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.error('Missing OPENAI_API_KEY in environment (.env). Exiting.');
  process.exit(1);
}

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

/**
 * Parses argv into { guildId, label, files }. Supports both
 * "--flag value" and "--flag=value" forms; everything else is treated
 * as a file or folder path to upload.
 */
function parseArgs(argv) {
  const result = { guildId: null, label: null, files: [] };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === '--guild' || arg === '-g') {
      result.guildId = argv[++i];
    } else if (arg.startsWith('--guild=')) {
      result.guildId = arg.slice('--guild='.length);
    } else if (arg === '--label' || arg === '-l') {
      result.label = argv[++i];
    } else if (arg.startsWith('--label=')) {
      result.label = arg.slice('--label='.length);
    } else {
      result.files.push(arg);
    }
  }

  return result;
}

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes;
  let unitIndex = -1;
  do {
    value /= 1024;
    unitIndex++;
  } while (value >= 1024 && unitIndex < units.length - 1);
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

async function main() {
  const { guildId, label, files: inputs } = parseArgs(process.argv.slice(2));

  if (inputs.length === 0) {
    console.error('Usage: node upload-rag-data.js [--guild <discord-server-id>] [--label <name>] <file-or-folder> [...]');
    process.exit(1);
  }

  // Expand folders into their contained files (one level deep).
  const filePaths = [];
  for (const input of inputs) {
    if (!fs.existsSync(input)) {
      console.error(`Skipping "${input}": path does not exist.`);
      continue;
    }
    const stat = fs.statSync(input);
    if (stat.isDirectory()) {
      const entries = fs
        .readdirSync(input)
        .filter((f) => !f.startsWith('.'))
        .map((f) => path.join(input, f))
        .filter((f) => fs.statSync(f).isFile());
      filePaths.push(...entries);
    } else {
      filePaths.push(input);
    }
  }

  if (filePaths.length === 0) {
    console.error('No files found to upload.');
    process.exit(1);
  }

  const vectorStoreId = await resolveVectorStoreId(guildId, label);

  console.log('Checking what\'s already in the vector store...');
  const existingByFilename = await getExistingFilesByFilename(vectorStoreId);

  console.log(`Processing ${filePaths.length} file(s)...`);

  for (const filePath of filePaths) {
    const filename = path.basename(filePath);
    const localSize = fs.statSync(filePath).size;
    const existing = existingByFilename.get(filename);

    // Same filename, same size, and the previous upload actually finished
    // successfully -> nothing to do.
    if (existing && existing.bytes === localSize && existing.status !== 'failed') {
      console.log(`  ${filePath} ... unchanged (${formatBytes(localSize)}), skipping`);
      continue;
    }

    if (existing) {
      const reason = existing.status === 'failed' ? 'previous upload failed' : 'size changed';
      process.stdout.write(`  ${filePath} ... ${reason}, replacing old version ... `);
      try {
        await openai.vectorStores.files.delete(existing.fileId, { vector_store_id: vectorStoreId });
        await openai.files.delete(existing.fileId);
      } catch (err) {
        console.log(`(warning: couldn't remove old version: ${err.message}) `);
      }
    } else {
      process.stdout.write(`  ${filePath} ... `);
    }

    try {
      const uploaded = await openai.files.create({
        file: fs.createReadStream(filePath),
        purpose: 'assistants',
      });

      // Attach the file to the vector store and wait for OpenAI to finish
      // chunking/embedding it before moving on to the next file.
      const attached = await openai.vectorStores.files.createAndPoll(vectorStoreId, {
        file_id: uploaded.id,
      });

      console.log(`${attached.status} (file ${uploaded.id})`);
    } catch (err) {
      console.log('FAILED');
      console.error(`    ${err.message}`);
    }
  }

  console.log('\nCurrent files in vector store:');
  const finalList = await openai.vectorStores.files.list(vectorStoreId);
  for (const f of finalList.data) {
    console.log(`  - ${f.id}  status=${f.status}`);
  }

  console.log('\nDone. RAG data is live -- the bot will pick it up on its next request.');
}

/**
 * Builds a filename -> { fileId, bytes, status } map of everything
 * currently in the vector store, so uploads can be compared against it.
 * If the same filename appears more than once (e.g. duplicates from
 * before this check existed), the last one seen wins.
 */
async function getExistingFilesByFilename(vectorStoreId) {
  const byFilename = new Map();

  for await (const vsFile of openai.vectorStores.files.list(vectorStoreId)) {
    try {
      const fileObject = await openai.files.retrieve(vsFile.id);
      byFilename.set(fileObject.filename, {
        fileId: vsFile.id,
        bytes: fileObject.bytes,
        status: vsFile.status,
      });
    } catch {
      // Underlying file metadata unavailable (e.g. deleted out from under
      // the vector store) -- skip it, it'll just look "new" if re-uploaded.
    }
  }

  return byFilename;
}

/**
 * Figures out which vector store to upload into:
 *  - If --guild was passed, reuses (or creates) that server's dedicated
 *    store, recorded in guild-config.json.
 *  - Otherwise falls back to the legacy single/default store, driven by
 *    OPENAI_VECTOR_STORE_ID / OPENAI_VECTOR_STORE_NAME in .env.
 */
async function resolveVectorStoreId(guildId, label) {
  if (guildId) {
    const scopeDescription = `Discord server ${guildId}${label ? ` (${label})` : ''}`;
    const existing = getGuildVectorStoreId(guildId);

    if (existing) {
      console.log(`Using existing vector store for ${scopeDescription}: ${existing}`);
      return existing;
    }

    const storeName = label ? `rpg-chat-${label}` : `rpg-chat-guild-${guildId}`;
    const store = await openai.vectorStores.create({ name: storeName });
    setGuildVectorStoreId(guildId, store.id, label || undefined);

    console.log(`Created new vector store "${storeName}" for ${scopeDescription}: ${store.id}`);
    console.log('Saved to guild-config.json -- the bot will use it automatically, no restart needed.');
    return store.id;
  }

  // No --guild: legacy default/global store behavior.
  let vectorStoreId = process.env.OPENAI_VECTOR_STORE_ID;

  if (vectorStoreId) {
    console.log(`Using existing default vector store: ${vectorStoreId}`);
    return vectorStoreId;
  }

  const storeName = process.env.OPENAI_VECTOR_STORE_NAME || 'rpg-chat-knowledge-base';
  const store = await openai.vectorStores.create({ name: storeName });
  console.log(`Created new default vector store "${storeName}": ${store.id}`);
  console.log('\n>>> Add this to your .env, then restart the bot:');
  console.log(`>>> OPENAI_VECTOR_STORE_ID=${store.id}\n`);
  return store.id;
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
