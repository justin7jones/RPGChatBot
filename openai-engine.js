/**
 * openai-engine.js
 *
 * Shared OpenAI Responses API caller, used by both the Discord bot
 * (index.js) and the web frontend's API server (web-server.js). Pulled out
 * of index.js so the two front ends can't drift out of sync on how a
 * prompt actually gets turned into a model call.
 *
 * Supports:
 *  - Plain text prompts, or vision prompts with attached image URLs
 *    (either remote URLs like a Discord CDN link, or data: URIs for
 *    directly-uploaded images).
 *  - Optional RAG via a single vector store id (file_search tool).
 *  - Optional multi-turn memory via previous_response_id -- callers that
 *    want stateless behavior (the Discord bot) simply never pass one in.
 */

import 'dotenv/config';
import OpenAI from 'openai';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-5.5';
const OPENAI_INSTRUCTIONS =
  process.env.OPENAI_INSTRUCTIONS ||
  "You are Justin's RPG Chat, a helpful assistant for tabletop RPG questions. " +
    'Answer using the knowledge available to you. Keep answers clear and concise.';

if (!OPENAI_API_KEY) {
  console.error('Missing OPENAI_API_KEY in environment (.env). Exiting.');
  process.exit(1);
}

export const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

/**
 * Calls the OpenAI Responses API.
 *
 * @param {object} opts
 * @param {string} opts.prompt - The user's text prompt.
 * @param {string[]} [opts.imageUrls] - Image URLs or data: URIs to attach.
 * @param {string} [opts.vectorStoreId] - Vector store to ground answers in
 *   via the file_search tool. Omit for a plain, ungrounded answer.
 * @param {string} [opts.previousResponseId] - Chain onto a prior response
 *   for multi-turn memory. Omit for a stateless, one-shot answer.
 * @param {string} [opts.instructions] - Override the default system prompt.
 * @returns {Promise<{text: string, responseId: string}>}
 */
export async function queryOpenAI({
  prompt,
  imageUrls = [],
  vectorStoreId,
  previousResponseId,
  instructions,
} = {}) {
  const request = {
    model: OPENAI_MODEL,
    instructions: instructions || OPENAI_INSTRUCTIONS,
  };

  if (imageUrls.length > 0) {
    request.input = [
      {
        role: 'user',
        content: [
          { type: 'input_text', text: prompt },
          ...imageUrls.map((url) => ({ type: 'input_image', image_url: url, detail: 'auto' })),
        ],
      },
    ];
  } else {
    request.input = prompt;
  }

  if (vectorStoreId) {
    request.tools = [
      {
        type: 'file_search',
        vector_store_ids: [vectorStoreId],
      },
    ];
  }

  if (previousResponseId) {
    request.previous_response_id = previousResponseId;
  }

  const response = await openai.responses.create(request);
  return {
    text: response.output_text || 'No response received.',
    responseId: response.id,
  };
}
