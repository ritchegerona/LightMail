import { api, authHeaders } from './api.js';
import { icon } from './icons.js';
import { escapeHtml, fmtSize, toast } from './ui.js';

const el = id => document.getElementById(id);

const FULL_KEY = 'lm:compose-full';
let deps = { getAccountId: () => null, onSent: () => {} };
let draftCtx = null;       // { draftId, isLocalDraft }
let pendingFiles = [];     // uploaded: [{path, filename, mimetype, size}]
let initialSnapshot = '';
let minimized = false;

function isFullMode() { return localStorage.getItem(FULL_KEY) !== '0'; }

function applyFullMode() {
  const full = isFullMode();
  el('compose-panel').classList.toggle('full-mode', full);
  const btn = el('cp-full');
  if (btn) {
    btn.title = full ? 'Exit full view' : 'Full view';
    btn.setAttribute('aria-label', btn.title);
    btn.innerHTML = `<span class="ic-wrap">${icon(full ? 'collapse' : 'expand')}</span>`;
  }
}

function toggleFullMode() {
  localStorage.setItem(FULL_KEY, isFullMode() ? '0' : '1');
  applyFullMode();
}

function snapshot() {
  return JSON.stringify([val('to'), val('cc'), val('bcc'), val('subject'), val('body'), pendingFiles.length]);
}
function val(id) { return el(id)?.value?.trim() || ''; }

export function initCompose(d) {
  deps = d;
  el('compose-form').addEventListener('submit', (e) => { e.preventDefault(); send(); });
  el('cp-close').addEventListener('click', () => requestClose());
  el('cp-minimize').addEventListener('click', minimize);
  el('cp-full').addEventListener('click', toggleFullMode);
  applyFullMode();
  el('cp-attach').addEventListener('click', () => el('compose-files').click());
  el('compose-files').addEventListener('change', onFilesPicked);
  el('cp-show-cc').addEventListener('click', () => { el('cp-cc-row').classList.toggle('hidden'); });
  el('cp-show-bcc').addEventListener('click', () => { el('cp-bcc-row').classList.toggle('hidden'); });
  el('cp-save-draft').addEventListener('click', saveDraft);
  el('cp-discard').addEventListener('click', async () => {
    if (isDirty() && !confirm('Discard this message?')) return;
    await close();
  });
  el('compose-pill').addEventListener('click', restore);
}

export function isOpen() {
  return !el('compose-panel').classList.contains('hidden');
}

export function isMinimized() {
  return minimized;
}

function isDirty() {
  return JSON.stringify([val('to'), val('cc'), val('bcc'), val('subject'), val('body'), pendingFiles.length]) !== initialSnapshot;
}

export function openCompose(opts = {}) {
  const {
    mode = 'new', to = '', cc = '', bcc = '', subject = '', body = '',
    draftId = null, isLocalDraft = false,
  } = opts;

  draftCtx = draftId ? { draftId, isLocalDraft } : null;
  pendingFiles = [];

  const titles = {
    new: 'New Message',
    reply: 'Reply',
    forward: 'Forward',
    draft: 'Edit Draft',
  };
  el('cp-title').textContent = titles[mode] || titles.new;
  el('compose-to').value = to;
  el('compose-cc').value = cc;
  el('compose-bcc').value = bcc;
  el('compose-subject').value = subject;
  el('compose-body').value = body;
  el('cp-cc-row').classList.toggle('hidden', !cc);
  el('cp-bcc-row').classList.toggle('hidden', !bcc);
  el('cp-status').textContent = '';
  renderAtts();

  minimized = false;
  el('compose-pill').classList.add('hidden');
  el('compose-panel').classList.remove('hidden');
  el('compose-panel').classList.add('open');
  initialSnapshot = snapshot();

  setTimeout(() => {
    (to ? el('compose-subject') : el('compose-to')).focus();
  }, 250);
}

async function close() {
  el('compose-panel').classList.remove('open');
  setTimeout(() => {
    el('compose-panel').classList.add('hidden');
    ['compose-to', 'compose-cc', 'compose-bcc', 'compose-subject', 'compose-body'].forEach(id => { el(id).value = ''; });
    el('compose-files').value = '';
    pendingFiles = [];
    draftCtx = null;
    renderAtts();
  }, 280);
  el('compose-pill').classList.add('hidden');
  minimized = false;
}

export async function requestClose() {
  if (isDirty() && !confirm('Discard this message?')) return;
  await close();
}

function minimize() {
  minimized = true;
  el('compose-panel').classList.remove('open');
  setTimeout(() => el('compose-panel').classList.add('hidden'), 300);
  const label = val('subject') || '(no subject)';
  el('compose-pill-text').textContent = `Draft — ${label}`;
  el('compose-pill').classList.remove('hidden');
}

export function restore() {
  minimized = false;
  el('compose-pill').classList.add('hidden');
  el('compose-panel').classList.remove('hidden');
  requestAnimationFrame(() => el('compose-panel').classList.add('open'));
}

// ── Attachments ──
function renderAtts() {
  const ul = el('compose-atts');
  ul.innerHTML = pendingFiles.map((f, i) => `
    <li class="${f.uploading ? 'uploading' : ''}" title="${escapeHtml(f.filename)}">
      ${icon('clip')}
      <span class="att-name">${escapeHtml(f.filename)}</span>
      <span class="att-size">${f.uploading ? 'uploading…' : fmtSize(f.size)}</span>
      ${f.uploading ? '' : `<button type="button" data-rm-att="${i}" aria-label="Remove attachment">${icon('x')}</button>`}
    </li>`).join('');
  ul.querySelectorAll('[data-rm-att]').forEach(btn => {
    btn.addEventListener('click', () => {
      pendingFiles.splice(parseInt(btn.dataset.rmAtt), 1);
      renderAtts();
    });
  });
}

async function onFilesPicked() {
  const files = [...(el('compose-files').files || [])];
  if (!files.length) return;
  for (const file of files) {
    const entry = { filename: file.name, size: file.size, mimetype: file.type || 'application/octet-stream', path: null, uploading: true };
    pendingFiles.push(entry);
    renderAtts();
    try {
      const fd = new FormData();
      fd.append('files', file, file.name);
      const res = await fetch('/api/upload', { method: 'POST', body: fd, headers: await authHeaders() });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Upload failed');
      entry.path = json.files[0].path;
      entry.uploading = false;
    } catch (err) {
      entry.uploading = false;
      pendingFiles = pendingFiles.filter(p => p !== entry);
      toast(`Could not attach ${file.name}: ${err.message}`, 'error');
    }
    renderAtts();
  }
  el('compose-files').value = '';
}

// ── Send / draft ──
async function saveDraft() {
  const accountId = deps.getAccountId();
  if (!accountId) return toast('Select an account first', 'error');
  const payload = {
    account_id: accountId,
    to: val('to'), cc: val('cc'), bcc: val('bcc'),
    subject: val('subject'), body: el('compose-body').value,
  };
  if (!payload.subject && !payload.body && !payload.to) return toast('Nothing to save', 'error');

  // Server-synced drafts become a fresh local draft on first save
  if (draftCtx && !draftCtx.isLocalDraft) draftCtx = null;

  try {
    el('cp-status').textContent = 'Saving…';
    if (draftCtx) payload.draft_id = draftCtx.draftId;
    const res = await api('POST', '/api/drafts', payload);
    draftCtx = { draftId: res.draft_id, isLocalDraft: true };
    el('cp-status').textContent = 'Draft saved';
    deps.onSaved?.();
    toast('Draft saved');
  } catch (err) {
    el('cp-status').textContent = '';
    toast('Could not save draft: ' + err.message, 'error');
  }
}

async function send() {
  const accountId = deps.getAccountId();
  if (!accountId) return toast('Select an account', 'error');
  if (pendingFiles.some(f => f.uploading)) return toast('Attachments still uploading…', 'error');

  const btn = el('cp-send');
  btn.disabled = true;
  el('cp-status').textContent = 'Sending…';
  try {
    await api('POST', '/api/send', {
      account_id: accountId,
      to: val('to'),
      cc: val('cc'),
      bcc: val('bcc'),
      subject: val('subject'),
      body: el('compose-body').value,
      attachments: pendingFiles.filter(f => f.path).map(f => ({
        path: f.path, filename: f.filename, mimetype: f.mimetype,
      })),
      ...(draftCtx && draftCtx.isLocalDraft ? { draft_id: draftCtx.draftId } : {}),
    });
    await close();
    toast('Message sent');
    deps.onSent();
  } catch (err) {
    el('cp-status').textContent = '';
    toast('Send failed: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
  }
}
