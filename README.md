# RPG Chat — Discord ↔ OpenAI (ChatGPT) bridge

Node.js bot that responds when @mentioned in Discord, sends the message to
the OpenAI Responses API (ChatGPT), and posts the reply back (split into
multiple messages if it exceeds Discord's 2000-character limit). Optionally
grounds answers in your own documents (rulebooks, lore, house rules) using
OpenAI's built-in RAG (file_search + vector stores).

Originally built against AnythingLLM; now uses the OpenAI API directly.

## Files

- `index.js` — Discord bot
- `web-server.js` — web frontend's HTTP API + static site host (see
  [Web frontend](#web-frontend) below)
- `openai-engine.js` — shared OpenAI Responses API caller used by both
  `index.js` and `web-server.js`, so the two front ends can't drift apart
- `session-store.js` — in-memory per-browser-session state for the web
  frontend (conversation memory, selected campaign)
- `public/` — the web frontend's static site (`index.html`, `app.js`, `styles.css`)
- `nginx/proxy02-rpgchat.conf` — reverse-proxy template for the web frontend
- `upload-rag-data.js` — CLI to load your RAG documents into OpenAI
- `list-rag-data.js` — CLI to browse existing vector stores and their files
- `guild-store.js` — helper that reads/writes `guild-config.json`
- `guild-config.json` — per-Discord-server vector store mapping (local
  state, not secret, but deployment-specific — see multi-server section).
  The web frontend also reads this file, treating each entry as a
  selectable "campaign" rather than a Discord server.
- `.env` — your real secrets (Discord token already filled in)
- `.env.example` — template, safe to commit
- `package.json` — dependencies (`discord.js`, `express`, `multer`,
  `cookie-parser`, `openai`, `dotenv`)
- `ecosystem.config.cjs` — pm2 process config for both `rpg-chat` (the
  Discord bot) and `rpg-chat-web` (the web frontend) (`.cjs` because the
  project uses ES modules; pm2's config format is still CommonJS)

## Setup (Ubuntu)

```bash
cd ~/rpg-chat
npm install
```

Edit `.env`:

- `DISCORD_TOKEN` — already filled in from your existing bot.
- `OPENAI_API_KEY` — create one at https://platform.openai.com/api-keys
  (needs an OpenAI account with billing enabled; the Responses API and
  vector storage are both pay-as-you-go).
- `OPENAI_MODEL` — defaults to `gpt-5.5`. Change to whatever model you want
  to use.
- `OPENAI_INSTRUCTIONS` — optional system prompt/persona.
- Leave `OPENAI_VECTOR_STORE_ID` blank for now — see the RAG section below.

Make sure "Message Content Intent" is enabled for the bot in the Discord
Developer Portal (Bot page) — required for the bot to read message text.

Run with pm2:

```bash
npm install -g pm2   # if not already installed
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup           # follow the printed instructions to enable on boot
```

## Loading contextual RAG data into ChatGPT

ChatGPT/OpenAI doesn't have a "workspace" concept like AnythingLLM. The
equivalent is a **vector store**: you upload documents to it, OpenAI chunks
and embeds them automatically, and the model uses the `file_search` tool to
pull relevant passages into context when answering — without you managing
embeddings or a database yourself.

This repo includes `upload-rag-data.js` to manage that for you. It supports
two modes: a single **default** store (original single-server setup) and
**per-server** stores (see [Multi-server support](#multi-server-support)
below).

**First-time setup — create the default store and load your docs:**

```bash
node upload-rag-data.js ./rag-docs
# or point at individual files:
node upload-rag-data.js shadowdark-rulebook.pdf house-rules.md session-notes.txt
```

The script will:
1. Create a new vector store (since `OPENAI_VECTOR_STORE_ID` is blank).
2. Upload each file and attach it to the store.
3. Wait for indexing to finish.
4. Print the new vector store ID.

Copy that ID into `.env`:

```
OPENAI_VECTOR_STORE_ID=vs_...
```

Then restart the bot so it picks it up:

```bash
pm2 restart rpg-chat
```

Once `OPENAI_VECTOR_STORE_ID` is set, `index.js` automatically attaches the
`file_search` tool to every request, so the bot's answers are grounded in
those documents. This default store is also the fallback for any Discord
server that doesn't have its own dedicated store configured.

**Adding more documents later:** with `OPENAI_VECTOR_STORE_ID` already set in
`.env`, just run the script again with the new files — it reuses the
existing store instead of creating a new one:

```bash
node upload-rag-data.js new-supplement.pdf
```

**Re-running against files already uploaded is safe.** Before uploading,
the script checks what's already in the vector store and compares each
local file (by filename) against it, using file size as a change signal:

- New filename → uploaded.
- Same filename, same size → skipped (assumed unchanged).
- Same filename, different size → old version deleted, new one uploaded.

So you can point it at a whole folder repeatedly — e.g. after adding one
new document — without creating duplicate content each time. This checks
size, not a byte-for-byte hash, so an edit that happens to produce the
exact same file size won't be detected as changed. It also won't clean up
duplicate filenames that were already in a store from before this check
existed.

**Supported file types** include `.pdf`, `.docx`, `.pptx`, `.txt`, `.md`,
`.json`, `.csv`, and several code/text formats — see OpenAI's
[file search guide](https://platform.openai.com/docs/guides/tools-file-search)
for the full list and current size limits.

**Removing/replacing documents:** OpenAI doesn't version files in place —
to update a document, upload the new version (it becomes a new file in the
store) and optionally remove the old one from the OpenAI dashboard under
Storage → Vector stores, or via `openai.vectorStores.files.del(...)` in a
small script.

## Browsing vector stores

Two ways to see what's actually loaded into a vector store:

**1. OpenAI's dashboard** — platform.openai.com → Storage → Vector stores.
Shows every store on the account, lets you click into one to see its files,
and preview chunked content. Requires logging into your OpenAI account
separately from this server.

**2. `list-rag-data.js`** (included here) — a terminal-only browser that
also cross-references `guild-config.json`, so you can see which Discord
server each store belongs to without leaving the shell:

```bash
# List every vector store on the account, and which server (if any) uses each:
node list-rag-data.js

# List the files inside one store, by ID:
node list-rag-data.js vs_6a57ca69daf88191b469f88d803e9838

# List the files inside one server's store, by Discord server ID:
node list-rag-data.js --guild 554439624412495894
```

Output includes file counts, storage size, indexing status per file, and
original filenames (resolved from OpenAI's Files API).

## Multi-server support

One bot process and one Discord bot token already work across every server
the bot is invited to — Discord bots are inherently multi-tenant, nothing
to change there. Just use your existing bot invite link (from the Discord
Developer Portal → OAuth2 → URL Generator, scope `bot`, with the same
permissions you originally set up) to add RPG Chat to additional servers.

What's new is **per-server RAG**: each server can have its own set of
documents instead of sharing one global knowledge base.

**1. Find the target server's ID.** In Discord: User Settings → Advanced →
enable Developer Mode. Then right-click the server icon (or its name at the
top of the channel list) → "Copy Server ID".

**2. Upload that server's documents, tagging them with its ID:**

```bash
node upload-rag-data.js --guild 123456789012345678 --label shadowdark ./rag-docs
```

`--label` is optional but recommended — it's used to name the vector store
(e.g. `rpg-chat-shadowdark`) so it's recognizable in the OpenAI dashboard.
Without it, the store is named `rpg-chat-guild-<id>`.

This creates a new vector store for that server (or reuses it if you've
already run the command with the same `--guild` ID) and saves the mapping
to `guild-config.json`. **No `.env` edit or bot restart is required** —
`index.js` reads `guild-config.json` fresh on every message.

**3. Repeat for each additional server** with its own `--guild` ID and
document set.

**Fallback behavior:** any server without an entry in `guild-config.json`
uses the default `OPENAI_VECTOR_STORE_ID` store from `.env` (or no RAG at
all if that's also blank). This means your existing single-server setup
keeps working unchanged — `--guild` is opt-in per server.

**Adding more docs to an existing server:** run the same `--guild` command
again with new files; it reuses that server's existing store.

## Image input (vision)

The bot can look at photos, not just read text. Attach an image to a
message and @mention the bot (with or without a question) and it's sent to
OpenAI alongside your text using the model's vision capability.

Examples:
- Attach a photo of some board games on a shelf and ask
  `@RPG Chat what games are these?` — it'll try to identify them by name.
- Attach a photo with no question at all — it defaults to describing what's
  in the image and calling out anything specific it recognizes.
- Attach up to 5 images in one message; all are sent together for one
  answer that can reference all of them.

Notes:
- This only works with a vision-capable model in `OPENAI_MODEL` (the
  default, `gpt-5.5`, supports it).
- Image RAG (recognizing things exclusive to your uploaded documents, like
  a house-ruled custom game) isn't part of this — `file_search` only
  retrieves from text/document content, not images. The model identifies
  what it can from its own general knowledge plus whatever text context
  `file_search` pulls in.
- Images are sent to OpenAI as the Discord CDN URL directly (no local
  download/re-upload step), so this only works while that URL is
  reachable, which is the case for the lifetime of a normal Discord
  message.

## Managing the bot

```bash
pm2 logs rpg-chat     # tail logs
pm2 restart rpg-chat  # restart after editing .env or index.js
pm2 stop rpg-chat
pm2 delete rpg-chat
```

## Web frontend

A second, independent front end to the same assistant: a small chat page
you host on the web instead of (or alongside) Discord. It shares
`openai-engine.js`, `guild-config.json`, and your OpenAI account with the
Discord bot — same knowledge bases, same model — so there's nothing to
duplicate or keep in sync.

**What it adds over the Discord bot:**
- A campaign dropdown (one option per entry in `guild-config.json`, plus
  "General") instead of one bot reply per Discord server.
- Multi-turn memory: unlike the Discord bot (which answers every message
  fresh), the web chat remembers the conversation within a browser session,
  using OpenAI's response chaining. Session state is in-memory in the
  Node process (see `session-store.js`) — it resets if the process
  restarts, and doesn't scale past one process. That's fine for a small
  group of players; swap in Redis or SQLite later if you outgrow it.
- Image attachments work the same way (up to 5 per message), but are
  uploaded from the browser instead of pulled from a Discord CDN URL.

**What it doesn't add:** login/authentication. The app itself trusts
whoever can reach it. If you want the page password-gated, the simplest
option is NGINX's `auth_basic` directive on the reverse proxy in front of
it (see the template below) — that keeps a password out of application
code entirely. If/when you want real per-user accounts, that's a bigger
change (a login provider, per-user session state) worth doing as its own
step.

### Running it

```bash
npm install        # picks up express/multer/cookie-parser
pm2 start ecosystem.config.cjs --only rpg-chat-web
pm2 save
```

It listens on `WEB_PORT` from `.env` (default `3001`) on `localhost` —
it's not meant to be exposed to the internet directly. Put NGINX in front
of it.

### NGINX (proxy02)

`nginx/proxy02-rpgchat.conf` is a template reverse-proxy config for a
separate NGINX host (e.g. `proxy02`) that forwards to the Ubuntu box
running `rpg-chat-web`. It handles TLS termination and (optionally) the
shared-password gate mentioned above. See the comments at the top of that
file for the install steps — in short: fill in the `CHANGE_ME` /
`APP_HOST` placeholders, drop it in `sites-available`, symlink it into
`sites-enabled`, and issue a certificate with certbot.

### Managing the web frontend

```bash
pm2 logs rpg-chat-web
pm2 restart rpg-chat-web   # after editing .env, web-server.js, or public/
pm2 stop rpg-chat-web
```

## Notes

- Only responds to a genuine, direct @mention (not @everyone/@here/roles).
- Mentioning it with no text and no image gets a "How can I help you
  today?" reply; mentioning it with an image but no text gets a default
  "describe this image" prompt instead.
- Long responses are split on paragraph/line/word boundaries where
  possible, capped at 1900 characters per message, sent as sequential
  messages.
- RAG is optional — with no default or per-server vector store configured,
  the bot behaves as a plain ChatGPT-backed assistant using
  `OPENAI_INSTRUCTIONS` as its persona.
- `guild-config.json` holds per-server vector store mappings and is
  deployment-specific state, not something to commit to source control.
