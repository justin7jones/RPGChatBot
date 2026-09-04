/**
 * RPG Chat — Discord <-> OpenAI (ChatGPT) bridge
 *
 * Node.js / discord.js v14 bot, refactored from an original AnythingLLM
 * integration to use the OpenAI Responses API directly.
 * Meant to be run under pm2 (see ecosystem.config.js).
 *
 * Behavior:
 *  - Bot only responds when it is @mentioned in a message (a genuine,
 *    direct mention -- @everyone/@here and role mentions are ignored).
 *  - The mention is stripped out of the message content before sending
 *    the prompt to OpenAI.
 *  - If the user only mentions the bot with no text and no image, it
 *    replies with a friendly prompt instead of calling the API.
 *  - Image attachments (photos) are sent to OpenAI alongside any text, so
 *    the bot can answer questions about what's in a picture -- e.g.
 *    mention it with a photo of some board games and ask it to list them.
 *  - Shows a "typing..." indicator while waiting on OpenAI.
 *  - Supports installation on multiple Discord servers from one process.
 *    Each message's server (guild) ID is looked up in guild-config.json
 *    (via guild-store.js) to find that server's own vector store, so
 *    RAG answers are grounded in documents specific to that server. If a
 *    server has no dedicated store configured, OPENAI_VECTOR_STORE_ID from
 *    .env is used as the default. See upload-rag-data.js for how to load
 *    documents into a per-server (or default) store.
 *  - Splits long responses into multiple messages to respect Discord's
 *    2000-character limit, breaking on paragraph/line/word boundaries
 *    where possible instead of mid-word.
 */

import 'dotenv/config';
import { Client, GatewayIntentBits, Partials } from 'discord.js';
import { getGuildVectorStoreId } from './guild-store.js';
import { queryOpenAI as queryOpenAIEngine } from './openai-engine.js';

// ---------------------------------------------------------------------------
// Configuration (loaded from .env — see .env.example)
// ---------------------------------------------------------------------------

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;

// Default/fallback vector store, used for any server that doesn't have its
// own dedicated store in guild-config.json (see guild-store.js).
const OPENAI_VECTOR_STORE_ID = process.env.OPENAI_VECTOR_STORE_ID;

// Discord hard caps messages at 2000 characters. Leave a little headroom.
const DISCORD_CHUNK_SIZE = 1900;

// Cap how many attached images get sent per request (cost/latency guard --
// Discord allows up to 10 attachments per message).
const MAX_IMAGES_PER_MESSAGE = 5;

if (!DISCORD_TOKEN) {
  console.error('Missing DISCORD_TOKEN in environment (.env). Exiting.');
  process.exit(1);
}
// (OPENAI_API_KEY is validated by openai-engine.js on import.)

// ---------------------------------------------------------------------------
// Discord client
// ---------------------------------------------------------------------------

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

client.once('clientReady', () => {
  console.log(`Logged in as ${client.user.tag}`);
  console.log(`In ${client.guilds.cache.size} server(s): ${[...client.guilds.cache.values()].map((g) => g.name).join(', ')}`);
  if (OPENAI_VECTOR_STORE_ID) {
    console.log(`Default vector store (used when a server has no dedicated store): ${OPENAI_VECTOR_STORE_ID}`);
  } else {
    console.log('No default vector store set — servers without their own store get plain ChatGPT responses.');
  }
});

client.on('messageCreate', async (message) => {
  try {
    // Prevent the bot from replying to itself (or other bots, to avoid loops).
    if (message.author.bot) return;

    // Only respond to a genuine, direct @mention of the bot itself --
    // ignore @everyone/@here and role mentions that happen to include it.
    if (
      !client.user ||
      !message.mentions.has(client.user, { ignoreEveryone: true, ignoreRoles: true })
    ) {
      return;
    }

    // Strip every form of the bot's mention tag out of the message.
    const mentionPattern = new RegExp(`<@!?${client.user.id}>`, 'g');
    const userPrompt = message.content.replace(mentionPattern, '').trim();

    // Pick up any image attachments (photos) on the message.
    const imageUrls = [...message.attachments.values()]
      .filter((attachment) => attachment.contentType?.startsWith('image/'))
      .slice(0, MAX_IMAGES_PER_MESSAGE)
      .map((attachment) => attachment.url);

    if (!userPrompt && imageUrls.length === 0) {
      await message.channel.send('How can I help you today?');
      return;
    }

    // If they attached an image but didn't ask anything, default to a
    // sensible "what is this" style prompt instead of sending empty text.
    const effectivePrompt =
      userPrompt || 'Describe what is in this image, and identify anything specific you can (e.g. names of games, items, or objects shown).';

    const guildLabel = message.guild ? `${message.guild.name} (${message.guildId})` : 'DM';
    console.log(`[${guildLabel}] ${message.author.tag}: ${effectivePrompt}${imageUrls.length ? ` (+${imageUrls.length} image(s))` : ''}`);

    await sendWithTyping(message, effectivePrompt, imageUrls);
  } catch (err) {
    console.error('Unhandled error in messageCreate handler:', err);
  }
});

/**
 * Shows a typing indicator while querying OpenAI, then replies.
 */
async function sendWithTyping(message, userPrompt, imageUrls) {
  let typingInterval;

  try {
    // Discord's typing indicator lasts ~10s; refresh it while we wait.
    await message.channel.sendTyping();
    typingInterval = setInterval(() => {
      message.channel.sendTyping().catch(() => {});
    }, 8000);

    const aiResponse = await queryOpenAI(userPrompt, message.guildId, imageUrls);
    const chunks = chunkMessage(aiResponse, DISCORD_CHUNK_SIZE);

    for (let i = 0; i < chunks.length; i++) {
      // Reply to the original message for the first chunk; send follow-ups
      // as plain channel messages so the reply chain isn't spammed.
      if (i === 0) {
        await message.reply(chunks[i]);
      } else {
        await message.channel.send(chunks[i]);
      }
    }
  } catch (err) {
    const errText = err.status
      ? `Error from Justin's RPG Chat: ${err.status} - ${err.message}`
      : `Justin's RPG Chat Exception: ${err.message}`;
    console.error(errText);
    await message.reply(truncate(errText, DISCORD_CHUNK_SIZE)).catch(() => {});
  } finally {
    if (typingInterval) clearInterval(typingInterval);
  }
}

/**
 * Calls the OpenAI Responses API (via the shared openai-engine module) and
 * returns the text response.
 *
 * The vector store used for file_search is chosen per Discord server:
 * the server's own store from guild-config.json if one is configured,
 * otherwise the OPENAI_VECTOR_STORE_ID default from .env. If neither is
 * set, the model answers with no RAG grounding at all.
 *
 * If imageUrls are provided, they're attached to the request as
 * input_image content alongside the text prompt, so vision-capable models
 * (like the default gpt-5.5) can see and describe them.
 *
 * Each Discord message is answered independently (no previous_response_id
 * chaining) -- this preserves the bot's existing stateless behavior. The
 * web frontend (web-server.js) uses the same engine but does chain
 * responses for multi-turn memory.
 */
async function queryOpenAI(prompt, guildId, imageUrls = []) {
  const vectorStoreId = (guildId && getGuildVectorStoreId(guildId)) || OPENAI_VECTOR_STORE_ID;
  const { text } = await queryOpenAIEngine({ prompt, imageUrls, vectorStoreId });
  return text;
}

// ---------------------------------------------------------------------------
// Message chunking helpers
// ---------------------------------------------------------------------------

/**
 * Splits text into chunks no larger than maxLength, preferring to break on
 * paragraph breaks, then line breaks, then spaces, and only falling back to
 * a hard character cut if a single "word" is itself longer than maxLength.
 */
function chunkMessage(text, maxLength) {
  if (!text) return ['No response received.'];
  if (text.length <= maxLength) return [text];

  const chunks = [];
  let remaining = text;

  while (remaining.length > maxLength) {
    let splitIndex = findSplitIndex(remaining, maxLength);
    chunks.push(remaining.slice(0, splitIndex).trimEnd());
    remaining = remaining.slice(splitIndex).trimStart();
  }

  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

/**
 * Finds the best index to split `text` at, at or before maxLength.
 * Tries (in order): double newline, single newline, space. Falls back to a
 * hard cut at maxLength if no good boundary is found.
 */
function findSplitIndex(text, maxLength) {
  const window = text.slice(0, maxLength);

  const boundaries = ['\n\n', '\n', ' '];
  for (const boundary of boundaries) {
    const idx = window.lastIndexOf(boundary);
    // Require the boundary to be reasonably far in, so we don't produce
    // tiny chunks when a boundary happens to appear near the start.
    if (idx > maxLength * 0.5) {
      return idx + boundary.length;
    }
  }

  return maxLength;
}

function truncate(text, maxLength) {
  return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

client.login(DISCORD_TOKEN);

process.on('unhandledRejection', (err) => {
  console.error('Unhandled promise rejection:', err);
});
