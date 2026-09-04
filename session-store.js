/**
 * session-store.js
 *
 * Tiny in-memory store for web chat sessions, keyed by a random session id
 * carried in an httpOnly cookie (see web-server.js). Mirrors the spirit of
 * guild-store.js (a small, dependency-free key-value store) but this one is
 * intentionally NOT persisted to disk -- conversation memory resetting on a
 * server restart is an acceptable tradeoff for an MVP, and avoids ever
 * writing chat content to a file. If you later want sessions to survive
 * restarts (or to scale beyond one process), swap this for Redis or a
 * small SQLite table without changing web-server.js's calling code.
 *
 * Each session holds:
 *   - previousResponseId: the last OpenAI response id, used to chain the
 *     next request for multi-turn memory (see openai-engine.js).
 *   - campaignId: the last campaign/knowledge-base the visitor picked.
 *   - authenticated: whether this session has entered the shared site
 *     password (see SITE_PASSWORD in web-server.js). Always true if no
 *     password is configured.
 *   - lastActive: timestamp (ms), used to expire idle sessions.
 */

const SESSION_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours of inactivity
const CLEANUP_INTERVAL_MS = 30 * 60 * 1000; // sweep every 30 minutes

const sessions = new Map();

/** Returns the session for id, creating a fresh one if it doesn't exist. */
export function getOrCreateSession(sessionId) {
  let session = sessions.get(sessionId);
  if (!session) {
    session = {
      previousResponseId: null,
      campaignId: null,
      authenticated: false,
      lastActive: Date.now(),
    };
    sessions.set(sessionId, session);
  }
  return session;
}

/** Merges the given fields into a session and refreshes its activity time. */
export function updateSession(sessionId, fields) {
  const session = getOrCreateSession(sessionId);
  Object.assign(session, fields, { lastActive: Date.now() });
  return session;
}

/** Clears conversation memory for a session (used by "New conversation"). */
export function resetSession(sessionId) {
  const session = getOrCreateSession(sessionId);
  session.previousResponseId = null;
  session.lastActive = Date.now();
  return session;
}

function sweepStaleSessions() {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [id, session] of sessions) {
    if (session.lastActive < cutoff) sessions.delete(id);
  }
}

setInterval(sweepStaleSessions, CLEANUP_INTERVAL_MS).unref();
