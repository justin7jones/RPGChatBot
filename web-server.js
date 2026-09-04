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
 *  - POST /api/reset starts a fresh conversation for the current session
 *    without losing the selected campaign.
 *  - Session identity is a random id in an httpOnly cookie; state itself
 *    lives in session-store.js (in-memory -- see that file's header for
 *    why, and how to swap in persistent storage later).
 *
 * This process does not implement login/authentication itself. If you want
 * the site password-gated, the simplest approach is NGINX's auth_basic
 * directive on the reverse proxy (see nginx/proxy02-rpgchat.conf) -- that
 * keeps auth out of application code entirely.
 */

import 'dotenv/config';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cookieParser from 'cookie-parser';
import multer from 'multer';
import { listGuildEntries } from './guild-store.js';
import { queryOpenAI } from './openai-engine.js';
import { getOrCreateSession, updateSession, resetSession } from './session-store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const WEB_PORT = Number(process.env.WEB_PORT) || 3001;
const OPENAI_VECTOR_STORE_ID = process.env.OPENAI_VECTOR_STORE_ID;
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

const app = express();
app.use(cookieParser());
app.use(express.json());
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
  }));
  campaigns.push({ id: 'general', label: 'General' });
  return campaigns;
}

/** Resolves a campaign id (from the client) to a vector store id, or undefined. */
function vectorStoreIdForCampaign(campaignId) {
  if (!campaignId || campaignId === 'general') return OPENAI_VECTOR_STORE_ID || undefined;
  const entries = listGuildEntries();
  return entries[campaignId]?.vectorStoreId || OPENAI_VECTOR_STORE_ID || undefined;
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
// Routes
// ---------------------------------------------------------------------------

app.get('/api/campaigns', (req, res) => {
  res.json({ campaigns: listCampaigns() });
});

app.post('/api/chat', upload.array('images', MAX_IMAGES_PER_MESSAGE), async (req, res) => {
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

app.post('/api/reset', (req, res) => {
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
});

process.on('unhandledRejection', (err) => {
  console.error('Unhandled promise rejection:', err);
});
