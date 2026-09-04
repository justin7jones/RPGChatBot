/**
 * guild-store.js
 *
 * Tiny persistent key-value store mapping a Discord server (guild) ID to
 * the OpenAI vector store that holds that server's RAG documents. Backed
 * by guild-config.json sitting next to this file.
 *
 * This lets one bot process serve multiple Discord servers, each with its
 * own knowledge base, without any restart: upload-rag-data.js writes to
 * this file, and index.js reads from it on every message (with a cheap
 * mtime-based cache so it doesn't re-read the file when nothing changed).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, 'guild-config.json');

let cache = null;
let cacheMtimeMs = -1;

function readConfig() {
  try {
    const stat = fs.statSync(CONFIG_PATH);
    if (cache && stat.mtimeMs === cacheMtimeMs) {
      return cache;
    }
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    cache = raw.trim() ? JSON.parse(raw) : {};
    cacheMtimeMs = stat.mtimeMs;
    return cache;
  } catch (err) {
    if (err.code === 'ENOENT') {
      cache = {};
      cacheMtimeMs = -1;
      return cache;
    }
    console.error(`Failed to read ${CONFIG_PATH}:`, err.message);
    return cache || {};
  }
}

function writeConfig(config) {
  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  cache = config;
  try {
    cacheMtimeMs = fs.statSync(CONFIG_PATH).mtimeMs;
  } catch {
    cacheMtimeMs = -1;
  }
}

/** Returns the raw config entry for a guild, or undefined if unconfigured. */
export function getGuildEntry(guildId) {
  if (!guildId) return undefined;
  return readConfig()[guildId];
}

/** Returns just the vector store ID for a guild, or undefined. */
export function getGuildVectorStoreId(guildId) {
  return getGuildEntry(guildId)?.vectorStoreId;
}

/** Creates or updates a guild's mapping and persists it to disk. */
export function setGuildVectorStoreId(guildId, vectorStoreId, label) {
  const config = readConfig();
  config[guildId] = {
    ...(config[guildId] || {}),
    vectorStoreId,
    ...(label ? { label } : {}),
    updatedAt: new Date().toISOString(),
  };
  writeConfig(config);
  return config[guildId];
}

/** Returns the entire guildId -> entry mapping. */
export function listGuildEntries() {
  return readConfig();
}
