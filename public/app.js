/**
 * app.js
 *
 * Vanilla-JS chat UI for RPG Chat's web frontend. No build step, no
 * framework -- talks to web-server.js's /api/* endpoints with fetch().
 * Session identity (and therefore conversation memory) is carried by an
 * httpOnly cookie the server sets; this file never touches it directly.
 */

const chatLog = document.getElementById('chat-log');
const emptyState = document.getElementById('empty-state');
const campaignSelect = document.getElementById('campaign-select');
const resetButton = document.getElementById('reset-button');
const composer = document.getElementById('composer');
const messageInput = document.getElementById('message-input');
const sendButton = document.getElementById('send-button');
const attachButton = document.getElementById('attach-button');
const imageInput = document.getElementById('image-input');
const attachmentsBar = document.getElementById('attachments');

const MAX_IMAGES = 5;
let pendingImages = []; // { file, previewUrl }

init();

async function init() {
  await loadCampaigns();
  restoreCampaignPreference();
  autoGrowTextarea();
  messageInput.focus();
}

// ---------------------------------------------------------------------------
// Campaigns
// ---------------------------------------------------------------------------

async function loadCampaigns() {
  try {
    const res = await fetch('/api/campaigns');
    const data = await res.json();
    campaignSelect.innerHTML = '';
    for (const campaign of data.campaigns) {
      const option = document.createElement('option');
      option.value = campaign.id;
      option.textContent = campaign.label;
      campaignSelect.appendChild(option);
    }
  } catch (err) {
    console.error('Failed to load campaigns', err);
    campaignSelect.innerHTML = '<option value="general">General</option>';
  }
}

function restoreCampaignPreference() {
  try {
    const saved = localStorage.getItem('rpgchat_campaign');
    if (saved && [...campaignSelect.options].some((o) => o.value === saved)) {
      campaignSelect.value = saved;
    }
  } catch {
    // localStorage can be unavailable (private browsing etc); safe to ignore.
  }
}

campaignSelect.addEventListener('change', () => {
  try {
    localStorage.setItem('rpgchat_campaign', campaignSelect.value);
  } catch {
    // ignore
  }
});

// ---------------------------------------------------------------------------
// New conversation
// ---------------------------------------------------------------------------

resetButton.addEventListener('click', async () => {
  try {
    await fetch('/api/reset', { method: 'POST' });
  } catch (err) {
    console.error('Failed to reset session', err);
  }
  chatLog.innerHTML = '';
  chatLog.appendChild(emptyState);
  emptyState.hidden = false;
});

// ---------------------------------------------------------------------------
// Image attachments
// ---------------------------------------------------------------------------

attachButton.addEventListener('click', () => imageInput.click());

imageInput.addEventListener('change', () => {
  const files = [...imageInput.files].slice(0, MAX_IMAGES - pendingImages.length);
  for (const file of files) {
    pendingImages.push({ file, previewUrl: URL.createObjectURL(file) });
  }
  imageInput.value = '';
  renderAttachments();
});

function renderAttachments() {
  attachmentsBar.innerHTML = '';
  attachmentsBar.hidden = pendingImages.length === 0;
  pendingImages.forEach((item, index) => {
    const chip = document.createElement('div');
    chip.className = 'attachment-chip';

    const img = document.createElement('img');
    img.src = item.previewUrl;
    img.alt = 'Attached image preview';
    chip.appendChild(img);

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.textContent = '✕';
    removeBtn.title = 'Remove';
    removeBtn.addEventListener('click', () => {
      URL.revokeObjectURL(item.previewUrl);
      pendingImages.splice(index, 1);
      renderAttachments();
    });
    chip.appendChild(removeBtn);

    attachmentsBar.appendChild(chip);
  });
}

// ---------------------------------------------------------------------------
// Sending messages
// ---------------------------------------------------------------------------

composer.addEventListener('submit', async (event) => {
  event.preventDefault();
  const text = messageInput.value.trim();
  if (!text && pendingImages.length === 0) return;

  const imagesToSend = pendingImages;
  pendingImages = [];
  renderAttachments();

  addUserMessage(text, imagesToSend.map((item) => item.previewUrl));
  messageInput.value = '';
  autoGrowTextarea();

  const pendingEl = addPendingMessage();
  setSending(true);

  try {
    const formData = new FormData();
    formData.append('message', text);
    formData.append('campaignId', campaignSelect.value);
    for (const item of imagesToSend) {
      formData.append('images', item.file);
    }

    const res = await fetch('/api/chat', { method: 'POST', body: formData });
    const data = await res.json();

    pendingEl.remove();
    if (!res.ok) {
      addErrorMessage(data.error || 'Something went wrong.');
    } else {
      addAssistantMessage(data.reply);
    }
  } catch (err) {
    console.error('Chat request failed', err);
    pendingEl.remove();
    addErrorMessage('Could not reach the server. Check your connection and try again.');
  } finally {
    setSending(false);
    messageInput.focus();
  }
});

messageInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    composer.requestSubmit();
  }
});

messageInput.addEventListener('input', autoGrowTextarea);

function autoGrowTextarea() {
  messageInput.style.height = 'auto';
  messageInput.style.height = `${Math.min(messageInput.scrollHeight, 160)}px`;
}

function setSending(isSending) {
  sendButton.disabled = isSending;
  messageInput.disabled = isSending;
}

// ---------------------------------------------------------------------------
// Rendering messages
// ---------------------------------------------------------------------------

function addUserMessage(text, imageUrls) {
  emptyState.hidden = true;
  const el = document.createElement('div');
  el.className = 'message user';

  if (imageUrls.length > 0) {
    const gallery = document.createElement('div');
    gallery.className = 'message-images';
    for (const url of imageUrls) {
      const img = document.createElement('img');
      img.src = url;
      img.alt = 'Attached image';
      gallery.appendChild(img);
    }
    el.appendChild(gallery);
  }

  if (text) {
    const textNode = document.createElement('div');
    textNode.textContent = text;
    el.appendChild(textNode);
  }

  chatLog.appendChild(el);
  scrollToBottom();
  return el;
}

function addAssistantMessage(text) {
  const el = document.createElement('div');
  el.className = 'message assistant';
  el.textContent = text;
  chatLog.appendChild(el);
  scrollToBottom();
  return el;
}

function addErrorMessage(text) {
  const el = document.createElement('div');
  el.className = 'message error';
  el.textContent = text;
  chatLog.appendChild(el);
  scrollToBottom();
  return el;
}

function addPendingMessage() {
  const el = document.createElement('div');
  el.className = 'message assistant pending';
  el.textContent = 'Thinking...';
  chatLog.appendChild(el);
  scrollToBottom();
  return el;
}

function scrollToBottom() {
  chatLog.scrollTop = chatLog.scrollHeight;
}
