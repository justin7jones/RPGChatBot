/**
 * list-rag-data.js
 *
 * Browse your OpenAI vector stores and the files inside them from the
 * command line -- a lighter alternative to logging into the OpenAI
 * dashboard (platform.openai.com -> Storage -> Vector stores) just to
 * check what's loaded.
 *
 * Usage:
 *   node list-rag-data.js                             # list all vector stores
 *   node list-rag-data.js <vector-store-id>            # list files in one store
 *   node list-rag-data.js --guild <discord-server-id>  # list files for one server's store
 */

import 'dotenv/config';
import OpenAI from 'openai';
import { listGuildEntries } from './guild-store.js';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.error('Missing OPENAI_API_KEY in environment (.env). Exiting.');
  process.exit(1);
}

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

function parseArgs(argv) {
  const result = { guildId: null, vectorStoreId: null };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--guild' || arg === '-g') {
      result.guildId = argv[++i];
    } else if (arg.startsWith('--guild=')) {
      result.guildId = arg.slice('--guild='.length);
    } else if (!arg.startsWith('-')) {
      result.vectorStoreId = arg;
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
  const { guildId, vectorStoreId: explicitId } = parseArgs(process.argv.slice(2));

  let vectorStoreId = explicitId;

  if (guildId) {
    const entry = listGuildEntries()[guildId];
    if (!entry) {
      console.error(`No vector store configured for guild ${guildId} in guild-config.json.`);
      process.exit(1);
    }
    vectorStoreId = entry.vectorStoreId;
    console.log(`Guild ${guildId}${entry.label ? ` (${entry.label})` : ''} -> ${vectorStoreId}\n`);
  }

  if (vectorStoreId) {
    await listStoreFiles(vectorStoreId);
  } else {
    await listAllStores();
  }
}

/** Lists every vector store on the account, with which guild(s) use each. */
async function listAllStores() {
  const guildEntries = listGuildEntries();
  const guildLabelsByStore = {};
  for (const [gid, entry] of Object.entries(guildEntries)) {
    const label = entry.label ? `${entry.label} (${gid})` : gid;
    (guildLabelsByStore[entry.vectorStoreId] ||= []).push(label);
  }

  const stores = [];
  for await (const store of openai.vectorStores.list()) {
    stores.push(store);
  }

  if (stores.length === 0) {
    console.log('No vector stores found on this OpenAI account.');
    return;
  }

  console.log(`Found ${stores.length} vector store(s):\n`);

  for (const store of stores) {
    let usedBy = guildLabelsByStore[store.id]?.join(', ');
    if (!usedBy) {
      usedBy = store.id === process.env.OPENAI_VECTOR_STORE_ID ? 'default (.env)' : '(not mapped to any server)';
    }

    console.log(`${store.name}  (${store.id})`);
    console.log(
      `  files: ${store.file_counts.completed} completed, ${store.file_counts.in_progress} in progress, ${store.file_counts.failed} failed`
    );
    console.log(`  size: ${formatBytes(store.usage_bytes)}`);
    console.log(`  used by: ${usedBy}`);
    console.log('');
  }

  console.log('Tip: run "node list-rag-data.js <vector-store-id>" to see the files inside one.');
}

/** Lists the files inside one vector store, resolving filenames where possible. */
async function listStoreFiles(vectorStoreId) {
  const store = await openai.vectorStores.retrieve(vectorStoreId);
  console.log(`${store.name}  (${store.id})`);
  console.log(`Total size: ${formatBytes(store.usage_bytes)}\n`);

  const files = [];
  for await (const file of openai.vectorStores.files.list(vectorStoreId)) {
    files.push(file);
  }

  if (files.length === 0) {
    console.log('No files in this vector store yet.');
    return;
  }

  console.log(`${files.length} file(s):\n`);

  for (const file of files) {
    let filename = file.id;
    try {
      const fileObject = await openai.files.retrieve(file.id);
      filename = fileObject.filename;
    } catch {
      // The underlying file may have been deleted from Files while still
      // referenced here; fall back to showing the raw file ID.
    }

    console.log(`  - ${filename}`);
    console.log(`      id: ${file.id}  status: ${file.status}  size: ${formatBytes(file.usage_bytes)}`);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
