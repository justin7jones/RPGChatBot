/**
 * app.js
 *
 * Vanilla-JS chat UI for RPG Chat's web frontend. No build step, no
 * framework -- talks to web-server.js's /api/* endpoints with fetch().
 * Session identity (and therefore conversation memory) is carried by an
 * httpOnly cookie the server sets; this file never touches it directly.
 */

const loginScreen = document.getElementById('login-screen');
const loginForm = document.getElementById('login-form');
const loginPassword = document.getElementById('login-password');
const loginError = document.getElementById('login-error');
const appShell = document.getElementById('app-shell');
const logoutButton = document.getElementById('logout-button');

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

const promptButton = document.getElementById('prompt-button');
const promptDialog = document.getElementById('prompt-dialog');
const promptForm = document.getElementById('prompt-form');
const promptTitle = document.getElementById('prompt-title');
const promptText = document.getElementById('prompt-text');
const promptStatus = document.getElementById('prompt-status');
const promptCancel = document.getElementById('prompt-cancel');
const promptSave = document.getElementById('prompt-save');

const filesButton = document.getElementById('files-button');
const filesDialog = document.getElementById('files-dialog');
const filesTitle = document.getElementById('files-title');
const filesClose = document.getElementById('files-close');
const filesUpload = document.getElementById('files-upload');
const filesInput = document.getElementById('files-input');
const filesZip = document.getElementById('files-zip');
const filesRefresh = document.getElementById('files-refresh');
const filesStatus = document.getElementById('files-status');
const filesList = document.getElementById('files-list');
const viewerDialog = document.getElementById('viewer-dialog');
const viewerTitle = document.getElementById('viewer-title');
const viewerText = document.getElementById('viewer-text');
const viewerStatus = document.getElementById('viewer-status');
const viewerSave = document.getElementById('viewer-save');
const viewerCancel = document.getElementById('viewer-cancel');
const viewerClose = document.getElementById('viewer-close');

const MAX_IMAGES = 5;
let pendingImages = []; // { file, previewUrl }

checkSession();

// ---------------------------------------------------------------------------
// Login gate
// ---------------------------------------------------------------------------

async function checkSession() {
  try {
    const res = await fetch('/api/session');
    const data = await res.json();
    logoutButton.hidden = !data.passwordRequired;
    if (data.authenticated) {
      showApp();
    } else {
      showLogin();
    }
  } catch (err) {
    console.error('Failed to check session', err);
    showLogin();
  }
}

function showApp() {
  loginScreen.hidden = true;
  appShell.hidden = false;
  init();
}

function showLogin(message) {
  appShell.hidden = true;
  loginScreen.hidden = false;
  if (message) {
    loginError.textContent = message;
    loginError.hidden = false;
  } else {
    loginError.hidden = true;
  }
  loginPassword.value = '';
  loginPassword.focus();
}

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const password = loginPassword.value;
  if (!password) return;

  const submitBtn = loginForm.querySelector('button[type="submit"]');
  submitBtn.disabled = true;

  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    if (res.ok) {
      loginError.hidden = true;
      logoutButton.hidden = false;
      showApp();
    } else {
      const data = await res.json().catch(() => ({}));
      loginError.textContent = data.error || 'Incorrect password.';
      loginError.hidden = false;
      loginPassword.value = '';
      loginPassword.focus();
    }
  } catch (err) {
    console.error('Login request failed', err);
    loginError.textContent = 'Could not reach the server. Try again.';
    loginError.hidden = false;
  } finally {
    submitBtn.disabled = false;
  }
});

logoutButton.addEventListener('click', async () => {
  try {
    await fetch('/api/logout', { method: 'POST' });
  } catch (err) {
    console.error('Logout request failed', err);
  }
  showLogin();
});

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
    if (res.status === 401) return showLogin('Your session expired — please log in again.');
    const data = await res.json();
    campaignSelect.innerHTML = '';
    for (const campaign of data.campaigns) {
      const option = document.createElement('option');
      option.value = campaign.id;
      option.textContent = campaign.label;
      option.dataset.hasPrompt = campaign.hasPrompt ? '1' : '';
      option.dataset.hasStore = campaign.hasStore ? '1' : '';
      campaignSelect.appendChild(option);
    }
  } catch (err) {
    console.error('Failed to load campaigns', err);
    campaignSelect.innerHTML = '<option value="general">General</option>';
  }
  updatePromptButton();
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
  updatePromptButton();
  try {
    localStorage.setItem('rpgchat_campaign', campaignSelect.value);
  } catch {
    // ignore
  }
});

// ---------------------------------------------------------------------------
// Campaign prompt (persistent per-campaign instructions)
// ---------------------------------------------------------------------------

function selectedCampaignLabel() {
  return campaignSelect.selectedOptions[0]?.textContent || '';
}

// The "General" campaign has no saved entry to hold a prompt.
function updatePromptButton() {
  filesButton.hidden = !campaignSelect.selectedOptions[0]?.dataset.hasStore;
  promptButton.hidden = campaignSelect.value === 'general';
  promptButton.textContent = campaignSelect.selectedOptions[0]?.dataset.hasPrompt
    ? 'Campaign prompt ●'
    : 'Campaign prompt';
}

function setPromptStatus(message, isError = false) {
  promptStatus.textContent = message;
  promptStatus.classList.toggle('error', isError);
}

promptButton.addEventListener('click', async () => {
  promptTitle.textContent = `Campaign prompt — ${selectedCampaignLabel()}`;
  promptText.value = '';
  promptText.disabled = true;
  promptSave.disabled = true;
  setPromptStatus('Loading...');
  promptDialog.showModal();

  try {
    const res = await fetch(`/api/campaigns/${encodeURIComponent(campaignSelect.value)}/prompt`);
    if (res.status === 401) {
      promptDialog.close();
      return showLogin('Your session expired — please log in again.');
    }
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not load the prompt.');
    promptText.value = data.prompt;
    promptText.maxLength = data.maxLength;
    promptText.disabled = false;
    promptSave.disabled = false;
    setPromptStatus('');
    promptText.focus();
  } catch (err) {
    setPromptStatus(err.message, true);
  }
});

promptForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  promptSave.disabled = true;
  setPromptStatus('Saving...');

  try {
    const res = await fetch(`/api/campaigns/${encodeURIComponent(campaignSelect.value)}/prompt`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: promptText.value }),
    });
    if (res.status === 401) {
      promptDialog.close();
      return showLogin('Your session expired — please log in again.');
    }
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not save the prompt.');
    campaignSelect.selectedOptions[0].dataset.hasPrompt = data.prompt ? '1' : '';
    updatePromptButton();
    promptDialog.close();
  } catch (err) {
    setPromptStatus(err.message, true);
    promptSave.disabled = false;
  }
});

promptCancel.addEventListener('click', () => promptDialog.close());

// ---------------------------------------------------------------------------
// Campaign files (vector store management)
// ---------------------------------------------------------------------------

let filesRefreshTimer = null;
let filesCampaignId = null;

function filesUrl(suffix = '') {
  return `/api/campaigns/${encodeURIComponent(filesCampaignId)}/files${suffix}`;
}

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}

function setFilesStatus(message, isError = false) {
  filesStatus.textContent = message;
  filesStatus.classList.toggle('error', isError);
}

/** fetch() wrapper for the files API: bounces to login on 401, throws the server's error text otherwise. */
async function filesFetch(url, options) {
  const res = await fetch(url, options);
  if (res.status === 401) {
    filesDialog.close();
    viewerDialog.close();
    showLogin('Your session expired — please log in again.');
    throw new Error('Not logged in.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}

// OpenAI reports a file as enqueued/in_progress until it is indexed.
const isPendingStatus = (status) => !['completed', 'failed', 'cancelled'].includes(status);

async function loadFiles() {
  clearTimeout(filesRefreshTimer);
  try {
    const { files } = await filesFetch(filesUrl());
    renderFiles(files);
    // Keep checking while anything is still being indexed.
    if (filesDialog.open && files.some((f) => isPendingStatus(f.status))) {
      filesRefreshTimer = setTimeout(loadFiles, 3000);
    }
  } catch (err) {
    setFilesStatus(err.message, true);
  }
}

/**
 * Reloads after a change. OpenAI's file listing can lag a moment behind an
 * upload or delete, so follow the immediate reload with a couple more.
 */
function reloadFilesAfterChange() {
  loadFiles();
  setTimeout(() => filesDialog.open && loadFiles(), 2000);
  setTimeout(() => filesDialog.open && loadFiles(), 5000);
}

function renderFiles(files) {
  filesList.innerHTML = '';
  if (files.length === 0) {
    const li = document.createElement('li');
    li.className = 'file-empty';
    li.textContent = 'No files in this campaign yet.';
    filesList.appendChild(li);
    return;
  }

  for (const file of files) {
    const li = document.createElement('li');

    const info = document.createElement('div');
    info.className = 'file-info';
    const name = document.createElement('div');
    name.className = 'file-name';
    name.textContent = file.filename;
    const meta = document.createElement('div');
    meta.className = 'file-meta';
    meta.textContent = formatBytes(file.size);
    const status = document.createElement('span');
    if (file.status === 'completed') {
      // nothing extra to show for a healthy file
    } else if (file.status === 'failed' || file.status === 'cancelled') {
      status.className = 'failed';
      status.textContent = ` · ${file.status}${file.error ? `: ${file.error}` : ''}`;
    } else {
      status.textContent = ' · indexing…';
    }
    meta.appendChild(status);
    info.append(name, meta);

    const actions = document.createElement('div');
    actions.className = 'file-actions';

    const ready = file.status === 'completed';
    const viewBtn = document.createElement('button');
    viewBtn.type = 'button';
    viewBtn.textContent = file.editable ? 'View / Edit' : 'View';
    viewBtn.disabled = !ready;
    viewBtn.addEventListener('click', () => openViewer(file));

    const downloadLink = document.createElement('a');
    downloadLink.textContent = 'Download';
    if (ready) {
      downloadLink.href = filesUrl(`/${encodeURIComponent(file.id)}/download`);
    } else {
      downloadLink.setAttribute('aria-disabled', 'true');
      downloadLink.style.opacity = '0.5';
      downloadLink.style.pointerEvents = 'none';
    }

    const replaceBtn = document.createElement('button');
    replaceBtn.type = 'button';
    replaceBtn.textContent = 'Replace';
    replaceBtn.addEventListener('click', () => pickReplacement(file));

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'danger';
    deleteBtn.textContent = 'Delete';
    deleteBtn.addEventListener('click', () => deleteFile(file));

    actions.append(viewBtn, downloadLink, replaceBtn, deleteBtn);
    li.append(info, actions);
    filesList.appendChild(li);
  }
}

filesButton.addEventListener('click', () => {
  filesCampaignId = campaignSelect.value;
  filesTitle.textContent = `Files — ${selectedCampaignLabel()}`;
  filesZip.href = filesUrl('/download.zip');
  filesList.innerHTML = '';
  setFilesStatus('Loading...');
  filesDialog.showModal();
  loadFiles().then(() => {
    if (filesStatus.textContent === 'Loading...') setFilesStatus('');
  });
});

filesClose.addEventListener('click', () => filesDialog.close());
filesDialog.addEventListener('close', () => clearTimeout(filesRefreshTimer));
filesRefresh.addEventListener('click', loadFiles);

filesUpload.addEventListener('click', () => filesInput.click());

filesInput.addEventListener('change', async () => {
  const picked = [...filesInput.files];
  filesInput.value = '';
  if (picked.length === 0) return;

  const formData = new FormData();
  for (const file of picked) formData.append('files', file);

  filesUpload.disabled = true;
  setFilesStatus(`Uploading ${picked.length} file(s)...`);
  try {
    const result = await filesFetch(filesUrl(), { method: 'POST', body: formData });
    setFilesStatus(`Uploaded ${result.added} new, replaced ${result.replaced}.`);
    reloadFilesAfterChange();
  } catch (err) {
    setFilesStatus(err.message, true);
  } finally {
    filesUpload.disabled = false;
  }
});

function pickReplacement(file) {
  const input = document.createElement('input');
  input.type = 'file';
  input.addEventListener('change', async () => {
    if (!input.files[0]) return;
    const formData = new FormData();
    formData.append('file', input.files[0]);
    setFilesStatus(`Replacing ${file.filename}...`);
    try {
      await filesFetch(filesUrl(`/${encodeURIComponent(file.id)}`), { method: 'PUT', body: formData });
      setFilesStatus(`Replaced ${file.filename} (kept its name).`);
      reloadFilesAfterChange();
    } catch (err) {
      setFilesStatus(err.message, true);
    }
  });
  input.click();
}

async function deleteFile(file) {
  if (!confirm(`Delete "${file.filename}" from this campaign? This cannot be undone.`)) return;
  setFilesStatus(`Deleting ${file.filename}...`);
  try {
    await filesFetch(filesUrl(`/${encodeURIComponent(file.id)}`), { method: 'DELETE' });
    setFilesStatus(`Deleted ${file.filename}.`);
    reloadFilesAfterChange();
  } catch (err) {
    setFilesStatus(err.message, true);
  }
}

// -- Viewer / editor --------------------------------------------------------

let viewerFile = null;

function setViewerStatus(message, isError = false) {
  viewerStatus.textContent = message;
  viewerStatus.classList.toggle('error', isError);
}

async function openViewer(file) {
  viewerFile = file;
  viewerTitle.textContent = file.filename;
  viewerText.value = '';
  viewerText.readOnly = true;
  viewerSave.hidden = true;
  setViewerStatus('Loading...');
  viewerDialog.showModal();

  try {
    const data = await filesFetch(filesUrl(`/${encodeURIComponent(file.id)}/content`));
    viewerText.value = data.text;
    viewerText.readOnly = !data.editable;
    viewerSave.hidden = !data.editable;
    setViewerStatus(data.editable ? '' : 'Read-only: extracted text of a non-text file.');
  } catch (err) {
    setViewerStatus(err.message, true);
  }
}

viewerSave.addEventListener('click', async () => {
  viewerSave.disabled = true;
  setViewerStatus('Saving...');
  try {
    await filesFetch(filesUrl(`/${encodeURIComponent(viewerFile.id)}`), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: viewerText.value }),
    });
    viewerDialog.close();
    setFilesStatus(`Saved ${viewerFile.filename}. Re-indexing...`);
    reloadFilesAfterChange();
  } catch (err) {
    setViewerStatus(err.message, true);
  } finally {
    viewerSave.disabled = false;
  }
});

viewerCancel.addEventListener('click', () => viewerDialog.close());
viewerClose.addEventListener('click', () => viewerDialog.close());

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

    if (res.status === 401) {
      pendingEl.remove();
      return showLogin('Your session expired — please log in again.');
    }

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

// On touch devices Enter should insert a newline (the Send button submits);
// on desktop, Enter sends and Shift+Enter adds a newline.
const isTouchDevice = window.matchMedia('(pointer: coarse)').matches;

messageInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !isTouchDevice) {
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
  el.className = 'message assistant markdown-body';
  el.innerHTML = renderMarkdown(text);
  chatLog.appendChild(el);
  scrollToBottom();
  return el;
}

/**
 * Renders the model's reply as Markdown (tables, bold, lists, code, etc.
 * -- the same formatting ChatGPT's own UI renders) instead of showing raw
 * asterisks and pipe characters. marked.parse() turns the text into HTML;
 * DOMPurify.sanitize() strips anything dangerous before it's inserted with
 * innerHTML, since this text ultimately originates from an external API
 * response rather than something we wrote ourselves.
 */
function renderMarkdown(text) {
  try {
    const html = marked.parse(text, { breaks: true, gfm: true });
    return DOMPurify.sanitize(html);
  } catch (err) {
    console.error('Markdown render failed, falling back to plain text', err);
    const fallback = document.createElement('div');
    fallback.textContent = text;
    return fallback.innerHTML;
  }
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
