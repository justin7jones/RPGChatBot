/**
 * web-server.js
 *
 * Web front end for RPG Chat -- an HTTP API + static site that sits
 * alongside the Discord bot (index.js) as a second, independent front end
 * to the same OpenAI-backed game-knowledge assistant. Meant to be run under
 * pm2 (see ecosystem.config.cjs) and reverse-proxied by NGINX (see
 * nginx/proxy02-rpgchat.conf) rather than exposed directly.
 *
 * Behavior:
 *  - Serves a single-page chat UI from ./public.
 *  - GET /api/campaigns lists the knowledge bases a visitor can chat
 *    against: every entry in guild-config.json (the same per-server RAG
 *    stores the Discord bot uses, here treated as generic "campaigns"
 *    rather than Discord servers) plus a "General" option backed by
 *    OPENAI_VECTOR_STORE_ID (or no RAG at all if that's blank).
 *  - POST /api/chat accepts a text message plus optional image uploads,
 *    and returns the assistant's reply. Unlike the Discord bot, this
 *    remembers conversation history per browser session (via
 *    previous_response_id chaining) so it feels like a real chat.
 *  - GET/PUT /api/campaigns/:id/prompt read and save a campaign's
 *    persistent chatbot prompt (stored in guild-config.json), which is
 *    appended to the system instructions on every chat for that campaign.
 *  - /api/campaigns/:id/files... manage the files in a campaign's vector
 *    store (list, upload, replace/edit, delete, view, download, and
 *    download-all as a ZIP) -- see vector-store-files.js, including why
 *    downloads are the extracted text rather than the original bytes.
 *  - POST /api/reset starts a fresh conversation for the current session
 *    without losing the selected campaign.
 *  - Session identity is a random id in an httpOnly cookie; state itself
 *    lives in session-store.js (in-memory -- see that file's header for
 *    why, and how to swap in persistent storage later).
 *  - If SITE_PASSWORD is set in .env, the site is gated behind a single
 *    shared password: GET /api/session reports whether the current
 *    session is logged in, POST /api/login checks a submitted password
 *    and flips the session to authenticated, and POST /api/logout clears
 *    it again. /api/campaigns, /api/chat, and /api/reset all require an
 *    authenticated session once a password is configured. The static
 *    site itself (public/) is not gated -- there's nothing sensitive in
 *    the page shell, and the frontend shows its own login screen when
 *    /api/session says it's needed. Leave SITE_PASSWORD blank to run
 *    with no password at all (e.g. behind NGINX auth_basic instead, or
 *    for local testing).
 */

import 'dotenv/config';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cookieParser from 'cookie-parser';
import multer from 'multer';
import { listGuildEntries, setGuildPrompt } from './guild-store.js';
import { queryOpenAI } from './openai-engine.js';
import {
  listStoreFiles,
  assertInStore,
  getFileText,
  addOrReplaceFiles,
  replaceFile,
  removeFile,
  buildStoreZip,
  downloadNameFor,
  isEditableText,
} from './vector-store-files.js';
import { getOrCreateSession, updateSession, resetSession } from './session-store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const WEB_PORT = Number(process.env.WEB_PORT) || 3001;
const OPENAI_VECTOR_STORE_ID = process.env.OPENAI_VECTOR_STORE_ID;
const SITE_PASSWORD = process.env.SITE_PASSWORD || '';
const MAX_PROMPT_CHARS = 4000;
const SESSION_COOKIE = 'rpgchat_session';

// Cap how many images can be attached to one message, and how large each
// one can be -- mirrors the Discord bot's own image cap, plus a hard byte
// limit since web uploads (unlike Discord CDN URLs) are sent as base64
// data straight into the request body.
const MAX_IMAGES_PER_MESSAGE = 5;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB per image

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMAGE_BYTES, files: MAX_IMAGES_PER_MESSAGE },
});

// RAG documents (rulebooks, session notes) are bigger than chat images.
const MAX_RAG_FILE_BYTES = 50 * 1024 * 1024; // 50 MB per file
const MAX_RAG_FILES_PER_UPLOAD = 20;

const ragUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_RAG_FILE_BYTES, files: MAX_RAG_FILES_PER_UPLOAD },
});

const app = express();
app.use(cookieParser());
app.use(express.json({ limit: '5mb' })); // room for in-browser edits of large notes
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Campaigns (knowledge bases)
// ---------------------------------------------------------------------------

/**
 * Builds the list of selectable campaigns from guild-config.json, plus a
 * "General" fallback. The Discord guild ID is reused purely as an opaque
 * campaign id here -- the web UI has no notion of Discord servers, it just
 * needs a stable key to send back on /api/chat.
 */
function listCampaigns() {
  const entries = listGuildEntries();
  const campaigns = Object.entries(entries).map(([guildId, entry]) => ({
    id: guildId,
    label: entry.label || guildId,
    hasPrompt: !!entry.prompt,
    hasStore: !!entry.vectorStoreId,
  }));
  campaigns.push({
    id: 'general',
    label: 'General',
    hasPrompt: false,
    hasStore: !!OPENAI_VECTOR_STORE_ID,
  });
  return campaigns;
}

/** Resolves a campaign id (from the client) to a vector store id, or undefined. */
function vectorStoreIdForCampaign(campaignId) {
  if (!campaignId || campaignId === 'general') return OPENAI_VECTOR_STORE_ID || undefined;
  const entries = listGuildEntries();
  return entries[campaignId]?.vectorStoreId || OPENAI_VECTOR_STORE_ID || undefined;
}

/**
 * Strict variant for file management: unlike vectorStoreIdForCampaign it
 * never falls back to the default store for an unknown campaign id, so a
 * typo can't end up editing the wrong store.
 */
function managedVectorStoreId(campaignId) {
  if (campaignId === 'general') return OPENAI_VECTOR_STORE_ID || undefined;
  return listGuildEntries()[campaignId]?.vectorStoreId || undefined;
}

/** Returns the saved campaign prompt for a campaign id, or undefined. */
function promptForCampaign(campaignId) {
  if (!campaignId || campaignId === 'general') return undefined;
  return listGuildEntries()[campaignId]?.prompt || undefined;
}

// ---------------------------------------------------------------------------
// Session cookie handling
// ---------------------------------------------------------------------------

function ensureSessionId(req, res) {
  let sessionId = req.cookies[SESSION_COOKIE];
  if (!sessionId) {
    sessionId = crypto.randomUUID();
    res.cookie(SESSION_COOKIE, sessionId, {
      httpOnly: true,
      sameSite: 'lax',
      // `secure` is left off here so this also works over plain HTTP during
      // local testing; NGINX terminates TLS in front of this in production,
      // so the cookie still only ever travels encrypted to real visitors.
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    });
  }
  return sessionId;
}

// ---------------------------------------------------------------------------
// Shared-password auth
// ---------------------------------------------------------------------------

/**
 * Constant-time password check. Hashing both sides first means the
 * comparison buffers are always the same length, so timingSafeEqual
 * doesn't leak how long the submitted password was (on top of not
 * leaking *where* it first differed).
 */
function verifyPassword(candidate) {
  if (!SITE_PASSWORD) return false;
  const a = crypto.createHash('sha256').update(String(candidate || '')).digest();
  const b = crypto.createHash('sha256').update(SITE_PASSWORD).digest();
  return crypto.timingSafeEqual(a, b);
}

/** Blocks a route unless the session is authenticated -- a no-op if no SITE_PASSWORD is set. */
function requireAuth(req, res, next) {
  if (!SITE_PASSWORD) return next();
  const sessionId = ensureSessionId(req, res);
  const session = getOrCreateSession(sessionId);
  if (!session.authenticated) {
    return res.status(401).json({ error: 'Not logged in.' });
  }
  next();
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.get('/api/session', (req, res) => {
  if (!SITE_PASSWORD) return res.json({ authenticated: true, passwordRequired: false });
  const sessionId = ensureSessionId(req, res);
  const session = getOrCreateSession(sessionId);
  res.json({ authenticated: !!session.authenticated, passwordRequired: true });
});

app.post('/api/login', (req, res) => {
  const sessionId = ensureSessionId(req, res);
  const { password } = req.body || {};

  if (verifyPassword(password)) {
    updateSession(sessionId, { authenticated: true });
    return res.json({ ok: true });
  }

  // A small fixed delay adds a little friction against rapid-fire guessing
  // without any real rate-limiting infrastructure.
  setTimeout(() => {
    res.status(401).json({ error: 'Incorrect password.' });
  }, 500);
});

app.post('/api/logout', (req, res) => {
  const sessionId = ensureSessionId(req, res);
  updateSession(sessionId, { authenticated: false });
  res.json({ ok: true });
});

app.get('/api/campaigns', requireAuth, (req, res) => {
  res.json({ campaigns: listCampaigns() });
});

app.get('/api/campaigns/:id/prompt', requireAuth, (req, res) => {
  const entry = listGuildEntries()[req.params.id];
  if (!entry) return res.status(404).json({ error: 'This campaign has no editable prompt.' });
  res.json({ prompt: entry.prompt || '', maxLength: MAX_PROMPT_CHARS });
});

app.put('/api/campaigns/:id/prompt', requireAuth, (req, res) => {
  const prompt = req.body?.prompt;
  if (typeof prompt !== 'string') return res.status(400).json({ error: 'Missing prompt text.' });
  if (prompt.length > MAX_PROMPT_CHARS) {
    return res.status(400).json({ error: `Prompt is too long (max ${MAX_PROMPT_CHARS} characters).` });
  }
  const entry = setGuildPrompt(req.params.id, prompt);
  if (!entry) return res.status(404).json({ error: 'This campaign has no editable prompt.' });
  res.json({ ok: true, prompt: entry.prompt || '' });
});

// ---------------------------------------------------------------------------
// Vector store file management
// ---------------------------------------------------------------------------

/** Resolves :id to a vector store (req.vectorStoreId) or answers 404. */
function withVectorStore(req, res, next) {
  const vectorStoreId = managedVectorStoreId(req.params.id);
  if (!vectorStoreId) {
    return res.status(404).json({ error: 'This campaign has no vector store.' });
  }
  req.vectorStoreId = vectorStoreId;
  next();
}

/** Wraps an async route: OpenAI 404s become 404s, everything else a 500 with a reason. */
function fileRoute(handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (err) {
      console.error(`Error in ${req.method} ${req.path}:`, err);
      if (err.status === 404) return res.status(404).json({ error: 'File not found in this campaign.' });
      if (err.code === 'file_not_ready') {
        return res.status(409).json({ error: 'This file is still being indexed. Try again in a moment.' });
      }
      res.status(500).json({ error: `Vector store error: ${err.message}` });
    }
  };
}

/** Like withVectorStore, then verifies :fileId really belongs to that store. */
const withStoreFile = [
  withVectorStore,
  async (req, res, next) => {
    try {
      await assertInStore(req.vectorStoreId, req.params.fileId);
      next();
    } catch (err) {
      if (err.status === 404) return res.status(404).json({ error: 'File not found in this campaign.' });
      console.error(`Error checking file ${req.params.fileId}:`, err);
      res.status(500).json({ error: `Vector store error: ${err.message}` });
    }
  },
];

const filesBase = '/api/campaigns/:id/files';

app.get(filesBase, requireAuth, withVectorStore, fileRoute(async (req, res) => {
  res.json({ files: await listStoreFiles(req.vectorStoreId) });
}));

app.post(
  filesBase,
  requireAuth,
  withVectorStore,
  ragUpload.array('files', MAX_RAG_FILES_PER_UPLOAD),
  fileRoute(async (req, res) => {
    const uploads = (req.files || []).map((f) => ({ buffer: f.buffer, filename: f.originalname }));
    if (uploads.length === 0) return res.status(400).json({ error: 'No files were uploaded.' });
    const result = await addOrReplaceFiles(req.vectorStoreId, uploads);
    console.log(`[web] ${req.params.id}: uploaded ${result.added} new, ${result.replaced} replaced`);
    res.json({ ok: true, ...result });
  }),
);

// Registered before the :fileId routes so "download.zip" isn't read as an id.
app.get(`${filesBase}/download.zip`, requireAuth, withVectorStore, fileRoute(async (req, res) => {
  const label = listGuildEntries()[req.params.id]?.label || req.params.id;
  const zip = await buildStoreZip(req.vectorStoreId);
  res.attachment(`${label}-files.zip`);
  res.type('application/zip').send(zip);
}));

app.get(`${filesBase}/:fileId/content`, requireAuth, ...withStoreFile, fileRoute(async (req, res) => {
  const files = await listStoreFiles(req.vectorStoreId);
  const file = files.find((f) => f.id === req.params.fileId);
  res.json({
    filename: file?.filename || req.params.fileId,
    editable: file ? isEditableText(file.filename) : false,
    text: await getFileText(req.vectorStoreId, req.params.fileId),
  });
}));

app.get(`${filesBase}/:fileId/download`, requireAuth, ...withStoreFile, fileRoute(async (req, res) => {
  const files = await listStoreFiles(req.vectorStoreId);
  const file = files.find((f) => f.id === req.params.fileId);
  const text = await getFileText(req.vectorStoreId, req.params.fileId);
  res.attachment(downloadNameFor(file?.filename || req.params.fileId));
  res.type('text/plain; charset=utf-8').send(text);
}));

// Replace a file's content, either by uploading a new file ("file" field)
// or by sending edited text as JSON ({ text }). The filename is kept.
app.put(
  `${filesBase}/:fileId`,
  requireAuth,
  ...withStoreFile,
  ragUpload.single('file'),
  fileRoute(async (req, res) => {
    let buffer;
    if (req.file) {
      buffer = req.file.buffer;
    } else if (typeof req.body?.text === 'string') {
      buffer = Buffer.from(req.body.text, 'utf8');
    } else {
      return res.status(400).json({ error: 'Send a replacement file or text.' });
    }
    const newId = await replaceFile(req.vectorStoreId, req.params.fileId, buffer);
    res.json({ ok: true, id: newId });
  }),
);

app.delete(`${filesBase}/:fileId`, requireAuth, ...withStoreFile, fileRoute(async (req, res) => {
  await removeFile(req.vectorStoreId, req.params.fileId);
  console.log(`[web] ${req.params.id}: deleted file ${req.params.fileId}`);
  res.json({ ok: true });
}));

app.post('/api/chat', requireAuth, upload.array('images', MAX_IMAGES_PER_MESSAGE), async (req, res) => {
  try {
    const sessionId = ensureSessionId(req, res);
    const session = getOrCreateSession(sessionId);

    const message = (req.body.message || '').trim();
    const campaignId = req.body.campaignId || session.campaignId || 'general';
    const files = req.files || [];

    const imageUrls = files.map(
      (file) => `data:${file.mimetype};base64,${file.buffer.toString('base64')}`,
    );

    if (!message && imageUrls.length === 0) {
      return res.status(400).json({ error: 'Send a message or attach an image.' });
    }

    const effectivePrompt =
      message ||
      'Describe what is in this image, and identify anything specific you can (e.g. names of games, items, or objects shown).';

    const vectorStoreId = vectorStoreIdForCampaign(campaignId);

    console.log(
      `[web:${sessionId.slice(0, 8)}] campaign=${campaignId}: ${effectivePrompt}${
        imageUrls.length ? ` (+${imageUrls.length} image(s))` : ''
      }`,
    );

    const { text, responseId } = await queryOpenAI({
      prompt: effectivePrompt,
      imageUrls,
      vectorStoreId,
      extraInstructions: promptForCampaign(campaignId),
      previousResponseId: session.previousResponseId || undefined,
    });

    updateSession(sessionId, { previousResponseId: responseId, campaignId });

    res.json({ reply: text });
  } catch (err) {
    console.error('Error in POST /api/chat:', err);
    const message = err.status
      ? `Error from Justin's RPG Chat: ${err.status} - ${err.message}`
      : `Justin's RPG Chat Exception: ${err.message}`;
    res.status(500).json({ error: message });
  }
});

app.post('/api/reset', requireAuth, (req, res) => {
  const sessionId = ensureSessionId(req, res);
  resetSession(sessionId);
  res.json({ ok: true });
});

// Multer errors (e.g. an image over the size limit) land here instead of
// the generic 500 handler above, so the browser gets a clear reason.
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: `Upload rejected: ${err.message}` });
  }
  next(err);
});

app.listen(WEB_PORT, () => {
  console.log(`RPG Chat web server listening on port ${WEB_PORT}`);
  const campaigns = listCampaigns();
  console.log(`Campaigns available: ${campaigns.map((c) => c.label).join(', ')}`);
  if (!OPENAI_VECTOR_STORE_ID) {
    console.log('No default vector store set — "General" gets plain ChatGPT responses.');
  }
  if (!SITE_PASSWORD) {
    console.log('No SITE_PASSWORD set — the web chat is open to anyone who can reach it.');
  } else {
    console.log('SITE_PASSWORD is set — visitors must log in before chatting.');
  }
});

process.on('unhandledRejection', (err) => {
  console.error('Unhandled promise rejection:', err);
});
