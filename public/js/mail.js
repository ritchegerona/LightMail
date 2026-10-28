import { api } from './api.js';
import { icon } from './icons.js';
import { escapeHtml, initials, avatarColor, timeAgo, fullDate, snippet, linkify, fmtSize, toast } from './ui.js';
import { openCompose, isOpen } from './compose.js';

export const state = {
  accounts: [],
  currentAccountId: null,
  currentMailbox: 'INBOX',
  emails: [],
  currentEmailId: null,
  isSyncing: false,
  offset: 0,
  limit: 50,
  selection: new Set(),
  unreadCounts: {},
  attCache: new Map(),      // emailId -> attachment rows
  htmlPref: new Map(),      // emailId -> 'html' | 'text'
  remoteImages: new Set(),  // emailIds allowed to load remote images
};

export const FOLDER_META = {
  INBOX:   { icon: 'inbox', title: 'Inbox' },
  STARRED: { icon: 'star', title: 'Starred' },
  Sent:    { icon: 'send', title: 'Sent' },
  Drafts:  { icon: 'draft', title: 'Drafts' },
  TRASH:   { icon: 'trash', title: 'Trash' },
};
export const FOLDER_ORDER = ['INBOX', 'STARRED', 'Sent', 'Drafts', 'TRASH'];

// ── Detail pane: full mode / resize / lightbox ──
const FULL_KEY = 'lm-detail-full';
const WIDTH_KEY = 'lm-detail-width';
const MIN_PANE_W = 360;

function isFullMode() {
  return document.getElementById('detail-pane').classList.contains('full-mode');
}

function setFullMode(on) {
  document.getElementById('detail-pane').classList.toggle('full-mode', on);
  localStorage.setItem(FULL_KEY, on ? '1' : '0');
  const btn = document.getElementById('act-expand');
  if (btn) {
    btn.innerHTML = icon(on ? 'collapse' : 'expand');
    btn.title = on ? 'Exit full view' : 'Full view';
  }
}

function toggleFullMode() {
  setFullMode(!isFullMode());
}

function setPaneWidth(px) {
  const max = Math.max(MIN_PANE_W, Math.floor(window.innerWidth * 0.85));
  const w = Math.min(Math.max(Math.round(px), MIN_PANE_W), max);
  document.getElementById('detail-pane').style.width = w + 'px';
}

export function openLightbox(src, alt = '') {
  const img = document.getElementById('lightbox-img');
  img.classList.remove('actual');
  img.src = src;
  img.alt = alt;
  document.getElementById('lightbox-caption').textContent = alt;
  document.getElementById('lightbox').classList.remove('hidden');
}

export function closeLightbox() {
  document.getElementById('lightbox').classList.add('hidden');
  const img = document.getElementById('lightbox-img');
  img.classList.remove('actual');
  img.removeAttribute('src');
}

// ── Data loading ──
export async function loadAccounts() {
  try {
    state.accounts = await api('GET', '/api/accounts');
    if (!state.currentAccountId && state.accounts.length > 0) {
      state.currentAccountId = state.accounts[0].id;
    }
    if (state.currentAccountId && !state.accounts.some(a => a.id === state.currentAccountId)) {
      state.currentAccountId = state.accounts[0]?.id ?? null;
    }
    if (state.currentAccountId) await loadEmails();
    render();
    refreshUnread();
  } catch (err) {
    console.error('Failed to load accounts', err);
  }
}

export async function loadEmails(opts = {}) {
  if (!state.currentAccountId) return;
  const { silent = false, append = false } = opts;
  const q = document.getElementById('search-input').value.trim();
  let url = `/api/emails?account_id=${state.currentAccountId}&limit=${state.limit}&offset=${append ? state.offset : 0}`;
  url += q ? `&q=${encodeURIComponent(q)}` : `&mailbox=${encodeURIComponent(state.currentMailbox)}`;

  if (!silent) renderLoading();
  try {
    const data = await api('GET', url);
    if (append) {
      const seen = new Set(state.emails.map(e => e.id));
      state.emails = state.emails.concat(data.filter(e => !seen.has(e.id)));
      state.offset = state.emails.length;
    } else {
      state.emails = data;
      state.offset = data.length;
    }
    // drop stale selection / open ids no longer present
    const ids = new Set(state.emails.map(e => e.id));
    state.selection = new Set([...state.selection].filter(id => ids.has(id)));
    if (state.currentEmailId && !ids.has(state.currentEmailId)) state.currentEmailId = null;
  } catch (err) {
    console.error('Failed to load emails', err);
    if (!append) state.emails = [];
  }
  render();
}

export async function refreshUnread() {
  if (!state.currentAccountId) return;
  try {
    state.unreadCounts = await api('GET', `/api/accounts/${state.currentAccountId}/unread`);
    renderFolders();
    renderCount();
  } catch (_) { /* non-critical */ }
}

// ── Render orchestration ──
export function render() {
  renderAccounts();
  renderFolders();
  renderList();
  renderDetail();
  renderTitle();
}

function isSearching() {
  return !!document.getElementById('search-input').value.trim();
}

function renderTitle() {
  const q = document.getElementById('search-input').value.trim();
  const titleEl = document.getElementById('folder-title');
  titleEl.textContent = q ? `Search “${q}”` : (FOLDER_META[state.currentMailbox]?.title || state.currentMailbox);
  renderCount();
}

function renderCount() {
  const countEl = document.getElementById('folder-count');
  if (!state.currentAccountId) { countEl.textContent = ''; return; }
  const total = state.emails.length;
  const unread = state.unreadCounts[state.currentMailbox];
  countEl.textContent = unread ? `${total} · ${unread} unread` : `${total}`;
}

function closeMobileNav() {
  document.getElementById('app').classList.remove('sidebar-open');
  document.querySelector('.sidebar-backdrop')?.remove();
}

// ── Sidebar ──
function renderAccounts() {
  const el = document.getElementById('account-list');
  el.innerHTML = state.accounts.map(a => `
    <div class="account-item ${state.currentAccountId === a.id ? 'active' : ''}" data-id="${a.id}" role="button" tabindex="0" title="${escapeHtml(a.email)}">
      <span>${escapeHtml(a.email)}</span>
      <span class="acc-btns">
        <span class="key-btn" data-key="${a.id}" role="button" aria-label="Update password" title="Update password">${icon('key')}</span>
        <span class="del-btn" data-del="${a.id}" role="button" aria-label="Remove account" title="Remove account">${icon('x')}</span>
      </span>
    </div>
  `).join('');
}

function renderFolders() {
  const el = document.getElementById('folder-list');
  if (!state.currentAccountId) {
    el.innerHTML = '<div class="sb-empty">Select an account</div>';
    return;
  }
  el.innerHTML = FOLDER_ORDER.map(f => {
    const meta = FOLDER_META[f];
    const count = state.unreadCounts[f] || 0;
    return `
      <div class="folder-item ${state.currentMailbox === f ? 'active' : ''}" data-folder="${f}" role="button" tabindex="0">
        <span class="f-icon">${icon(meta.icon)}</span>
        <span class="f-name">${meta.title}</span>
        <span class="folder-badge ${f === 'STARRED' ? 'starred-badge' : ''} ${count === 0 ? 'zero' : ''}">${count}</span>
      </div>
    `;
  }).join('');
}

// ── List ──
function renderLoading() {
  if (state.emails.length === 0) {
    document.getElementById('email-list').innerHTML = Array.from({ length: 7 }).map(() => `
      <div class="skel-row">
        <div class="skel avatar-sk"></div>
        <div style="flex:1"><div class="skel l1"></div><div class="skel l2"></div></div>
      </div>
    `).join('');
    document.getElementById('sync-btn').classList.add('spinning');
  }
}

export function renderList() {
  const el = document.getElementById('email-list');
  document.getElementById('sync-btn').classList.toggle('spinning', state.isSyncing);

  if (!state.currentAccountId) {
    el.innerHTML = `
      <div class="empty-state"><div class="es-icon">${icon('mail-open')}</div>
      <p>Add an account to start</p><small>Your mail stays local &amp; encrypted.</small></div>`;
    return;
  }
  if (state.emails.length === 0) {
    const searching = isSearching();
    el.innerHTML = `
      <div class="empty-state"><div class="es-icon">${icon(searching ? 'search' : 'inbox')}</div>
      <p>${searching ? 'No results found' : `Nothing in ${FOLDER_META[state.currentMailbox]?.title || state.currentMailbox}`}</p>
      <small>${searching ? 'Try a different search term.' : 'You’re all caught up!'}</small></div>`;
    return;
  }

  const trashBanner = state.currentMailbox === 'TRASH' && !isSearching() ? `
    <div class="trash-banner">
      <span>${icon('alert')}</span> Deleted messages stay here until you remove them permanently.
      <button class="trash-empty" data-empty-trash>Purge now</button>
    </div>` : '';

  const rows = state.emails.map(e => {
    const from = e.from_address || 'Unknown';
    const flagged = !!e.is_flagged;
    return `
    <div class="email-item ${e.is_read || e.mailbox_name === 'Sent' ? '' : 'unread'} ${state.currentEmailId === e.id ? 'selected' : ''} ${state.selection.has(e.id) ? 'checking selected' : ''}" data-id="${e.id}" role="listitem">
      <label class="row-check"><input type="checkbox" data-check="${e.id}" ${state.selection.has(e.id) ? 'checked' : ''} aria-label="Select email" /></label>
      <div class="avatar" style="background:${avatarColor(from)}">${escapeHtml(initials(from))}</div>
      <div class="email-mid">
        <div class="email-top-row">
          <span class="from">${escapeHtml(from)}</span>
          <span class="subject-line">${escapeHtml(e.subject || '(no subject)')}</span>
          ${e.has_attachments ? `<span class="att-ic" title="Has attachments">${icon('clip')}</span>` : ''}
        </div>
        ${labelChips}
        <div class="snippet">${escapeHtml(snippet(e.body_text || e.body_html))}</div>
      </div>
      <button class="row-flag ${flagged ? 'on' : ''}" data-flag="${e.id}" aria-label="${flagged ? 'Unstar' : 'Star'}" title="${flagged ? 'Unstar' : 'Star'}">${icon('star')}</button>
      <span class="date">${timeAgo(e.date_received)}</span>
    </div>`;
  }).join('');

  const loadMore = state.emails.length >= state.limit ? `
    <div class="load-more-wrap"><button class="load-more" data-load-more>Load older messages</button></div>` : '';

  el.innerHTML = trashBanner + rows + loadMore;
}

async function openEmail(id) {
  const email = state.emails.find(e => e.id === id);
  if (!email) return;

  // Drafts open in the composer, not the reader
  if (state.currentMailbox === 'Drafts' && !email.is_deleted) {
    openCompose({
      mode: 'draft',
      draftId: email.id,
      isLocalDraft: !!email.is_draft,
      to: email.to_address || '',
      cc: email.cc_address || '',
      bcc: email.bcc_address || '',
      subject: email.subject || '',
      body: email.body_text || '',
    });
    return;
  }

  state.currentEmailId = id;
  if (!email.is_read) {
    email.is_read = 1;
    api('PATCH', `/api/emails/${id}/read`, { is_read: true })
      .then(refreshUnread).catch(() => {});
  }
  renderList();
  renderDetail();

  // Attachments load async into the open reader
  try {
    const atts = await api('GET', `/api/emails/${id}/attachments`);
    state.attCache.set(id, atts);
    if (state.currentEmailId === id) renderAttachments(atts);
  } catch (_) { /* optional */ }
}

function renderAttachments(atts) {
  const block = document.getElementById('att-block');
  if (!block) return;
  if (!atts || !atts.length) { block.innerHTML = ''; return; }
  block.innerHTML = `
    <div class="attachments-block">
      <div class="attachments-title">${icon('clip')} ${atts.length} attachment${atts.length > 1 ? 's' : ''}</div>
      <div class="att-chips">
        ${atts.map(a => `
          <a class="att-chip" href="/api/emails/${a.email_id}/attachments/${a.id}" title="Download ${escapeHtml(a.filename || 'attachment')}">
            <span class="att-name">${escapeHtml(a.filename || 'attachment')}</span>
            <span class="att-size">${fmtSize(a.size)}</span>
            <span class="att-dl">${icon('download')}</span>
          </a>`).join('')}
      </div>
    </div>`;
}

// Safe HTML mail frame: sandboxed iframe, scripts disabled, remote images blocked until allowed
function buildSrcdoc(html, allowRemote) {
  let cleaned = String(html)
    // Remove script blocks entirely (including src/data URIs)
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<script\b[^>]*>.*?<\/script>/gi, '')
    // Remove all event handler attributes (onclick, onload, etc.)
    .replace(/\s+on\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    // Remove javascript: URLs
    .replace(/\b(href|src)\s*=\s*("[^"]*javascript:|'[^']*javascript:|[^\s>]*javascript:)/gi, '')
    // Remove iframe/object/embed (defense in depth even though sandbox helps)
    .replace(/<iframe\b[^>]*>.*?<\/iframe>/gi, '')
    .replace(/<object\b[^>]*>.*?<\/object>/gi, '')
    .replace(/<embed\b[^>]*\/?>/gi, '')
    // Remove form elements to prevent submission attempts
    .replace(/<form\b[^>]*>.*?<\/form>/gi, '');
  const csp = allowRemote
    ? "default-src 'none'; img-src https: http: data: blob:; style-src 'unsafe-inline'; font-src https: data:"
    : "default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:";
  return `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><base target="_blank">` +
    `<style>body{font-family:-apple-system,'Segoe UI',Roboto,sans-serif;font-size:14px;line-height:1.6;color:#1f2430;margin:0;padding:12px;}a{color:#4f46e5}img{cursor:zoom-in}</style>` +
    cleaned;
}

function renderDetail() {
  const el = document.getElementById('detail-content');
  const pane = document.getElementById('detail-pane');

  pane.classList.toggle('open', !!state.currentEmailId);
  // Full view only while an email is open; preference persists across emails/reloads
  pane.classList.toggle('full-mode', !!state.currentEmailId && localStorage.getItem(FULL_KEY) === '1');
  const isFull = isFullMode();
  if (!state.currentEmailId) {
    el.innerHTML = `
      <div class="empty-state"><div class="es-icon">${icon('mail-open')}</div>
      <p>Select an email</p><small>Choose a message from the list to read it here.</small></div>`;
    return;
  }

  const email = state.emails.find(e => e.id === state.currentEmailId);
  if (!email) {
    el.innerHTML = '<div class="empty-state"><div class="es-icon">…</div><p>Email not found</p></div>';
    return;
  }

  const from = email.from_address || 'Unknown';
  const flagged = !!email.is_flagged;
  const inTrash = state.currentMailbox === 'TRASH';
  const labels = email.labels ? email.labels.split(',').map(l => l.trim()).filter(Boolean) : [];

  const ccLine = email.cc_address ? `<div class="cc-line">cc ${escapeHtml(email.cc_address)}</div>` : '';
  const bccLine = email.bcc_address ? `<div class="cc-line">bcc ${escapeHtml(email.bcc_address)}</div>` : '';

  const actionsHtml = inTrash ? `
    <button id="act-restore">${icon('restore')} Restore</button>
    <button id="act-purge" class="danger">${icon('trash')} Delete forever</button>
  ` : `
    <button id="act-reply">${icon('reply')} Reply</button>
    <button id="act-forward">${icon('forward')} Forward</button>
    <button id="act-unread">${icon(email.is_read ? 'draft' : 'mail-open')} ${email.is_read ? 'Mark Unread' : 'Mark Read'}</button>
    <button id="act-delete" class="danger">${icon('trash')} Delete</button>
  `;

  const trashHint = inTrash ? `
    <div class="detail-hintbar">${icon('alert')} This message is in the Trash.</div>` : '';

  // Body rendering: HTML (sandboxed) or plain text
  const pref = state.htmlPref.get(email.id) || (email.body_html ? 'html' : 'text');
  let bodyHtml;
  if (pref === 'html' && email.body_html) {
    const allowRemote = state.remoteImages.has(email.id);
    bodyHtml = `
      <div class="html-toolbar">
        <button class="html-mode-btn active" data-body-mode="html">${icon('code')} Rich HTML</button>
        <button class="html-mode-btn" data-body-mode="text">${icon('draft')} Plain text</button>
        ${allowRemote
          ? ''
          : `<button class="html-mode-btn" data-load-images>${icon('image')} Load images</button>`}
        <span class="html-hint">${icon('image')} click an image to view</span>
      </div>
      <div class="html-frame-wrap">
        <iframe class="html-frame" sandbox="allow-same-origin" referrerpolicy="no-referrer"
          srcdoc="${escapeHtml(buildSrcdoc(email.body_html, allowRemote))}"
          onload="this.style.height=(this.contentDocument&&this.contentDocument.body?Math.max(this.contentDocument.body.scrollHeight+24,120):200)+'px'"></iframe>
      </div>`;
  } else {
    bodyHtml = (email.body_html ? `
      <div class="html-toolbar">
        <button class="html-mode-btn" data-body-mode="html">${icon('code')} Rich HTML</button>
        <button class="html-mode-btn active" data-body-mode="text">${icon('draft')} Plain text</button>
      </div>` : '') +
      `<div class="detail-body">${linkify(escapeHtml(email.body_text || '(no content)'))}</div>`;
  }

  el.innerHTML = `
    <div class="detail-topbar">
      <div class="back" id="back-btn" role="button" tabindex="0">${icon('chev-left')} Back</div>
      <div class="topbar-actions">
        <button class="icon-btn" id="act-expand" title="${isFull ? 'Exit full view' : 'Full view'}" aria-label="${isFull ? 'Exit full view' : 'Full view'}">${icon(isFull ? 'collapse' : 'expand')}</button>
        ${inTrash ? '' : `
          <button class="icon-btn ${flagged ? 'on' : ''}" id="act-star" title="${flagged ? 'Unstar' : 'Star'}" aria-label="${flagged ? 'Unstar' : 'Star'}">${icon('star')}</button>`}
        ${inTrash ? `
          <button class="icon-btn" id="act-restore-top" title="Restore" aria-label="Restore">${icon('restore')}</button>
          <button class="icon-btn danger-btn" id="act-purge-top" title="Delete forever" aria-label="Delete forever">${icon('trash')}</button>`
        : `<button class="icon-btn danger-btn" id="act-delete-top" title="Delete" aria-label="Delete">${icon('trash')}</button>`}
      </div>
    </div>
    ${trashHint}
    <div class="detail-card">
      <div class="detail-subject">${escapeHtml(email.subject || '(no subject)')}</div>
      <div class="detail-meta">
        <div class="avatar" style="background:${avatarColor(from)};width:44px;height:44px;">${escapeHtml(initials(from))}</div>
        <div>
          <div class="meta-name">${escapeHtml(from)}</div>
          ${email.to_address ? `<div class="meta-addr">to ${escapeHtml(email.to_address)}</div>` : ''}
          ${ccLine}${bccLine}
        </div>
        <span class="detail-date">${fullDate(email.date_received)}</span>
      </div>
      <div id="body-block">${bodyHtml}</div>
      <div id="att-block"></div>
    </div>
    <div class="detail-actions">${actionsHtml}</div>
  `;

  if (state.attCache.has(email.id)) renderAttachments(state.attCache.get(email.id));

  // Wire actions
  document.getElementById('back-btn')?.addEventListener('click', () => {
    state.currentEmailId = null;
    renderDetail(); renderList();
  });
  document.getElementById('act-expand')?.addEventListener('click', toggleFullMode);
  document.getElementById('act-star')?.addEventListener('click', () => toggleFlag(email.id));
  bindBodyModeButtons(email);
  bindFrameImages(email);

  if (inTrash) {
    document.getElementById('act-restore')?.addEventListener('click', () => restoreEmail(email));
    document.getElementById('act-restore-top')?.addEventListener('click', () => restoreEmail(email));
    document.getElementById('act-purge')?.addEventListener('click', () => deleteForever(email));
    document.getElementById('act-purge-top')?.addEventListener('click', () => deleteForever(email));
  } else {
    document.getElementById('act-reply')?.addEventListener('click', () => openReply(email));
    document.getElementById('act-forward')?.addEventListener('click', () => openForward(email));
    document.getElementById('act-delete')?.addEventListener('click', () => softDeleteCurrent(email));
    document.getElementById('act-delete-top')?.addEventListener('click', () => softDeleteCurrent(email));
    document.getElementById('act-unread')?.addEventListener('click', async () => {
      email.is_read = email.is_read ? 0 : 1;
      await api('PATCH', `/api/emails/${email.id}/read`, { is_read: !!email.is_read });
      renderList(); renderDetail(); refreshUnread();
    });
  }
}

function bindBodyModeButtons(email) {
  document.querySelectorAll('[data-body-mode]').forEach(btn => {
    btn.addEventListener('click', () => {
      state.htmlPref.set(email.id, btn.dataset.bodyMode);
      renderDetail();
    });
  });
  document.querySelector('[data-load-images]')?.addEventListener('click', () => {
    state.remoteImages.add(email.id);
    renderDetail();
  });
}

// Click-to-view images inside the sandboxed HTML frame. The frame is
// same-origin (allow-same-origin), so the parent can delegate clicks even
// though in-frame scripts are blocked. Clicks on linked images are prevented
// from navigating — viewing wins.
function bindFrameImages(email) {
  const frame = document.querySelector('.html-frame');
  if (!frame) return;
  const bind = () => {
    const doc = frame.contentDocument;
    if (!doc || !doc.body) return;
    doc.body.addEventListener('click', (e) => {
      const img = e.target && e.target.closest ? e.target.closest('img') : null;
      if (!img) return;
      e.preventDefault();
      e.stopPropagation();
      openLightbox(img.currentSrc || img.src, img.alt || email.subject || '');
    });
  };
  if (frame.contentDocument && frame.contentDocument.body) bind();
  frame.addEventListener('load', bind, { once: true });
}

// ── Actions ──
export async function toggleFlag(id) {
  const email = state.emails.find(e => e.id === id);
  if (!email) return;
  email.is_flagged = email.is_flagged ? 0 : 1;
  renderList();
  if (state.currentEmailId === id) renderDetail();
  try {
    await api('PATCH', `/api/emails/${id}/flag`, { is_flagged: !!email.is_flagged });
    refreshUnread();
  } catch (err) {
    email.is_flagged = email.is_flagged ? 0 : 1;
    renderList();
    toast('Could not update star: ' + err.message, 'error');
  }
}

async function softDeleteCurrent(email) {
  await api('PATCH', `/api/emails/${email.id}/delete`, { is_deleted: true });
  state.emails = state.emails.filter(e => e.id !== email.id);
  state.currentEmailId = null;
  render();
  refreshUnread();
  toast('Message moved to Trash', 'success', {
    action: { label: 'Undo', fn: async () => {
      await api('PATCH', `/api/emails/${email.id}/delete`, { is_deleted: false });
      await loadEmails({ silent: true });
      refreshUnread();
    } },
    ttl: 7000,
  });
}

async function restoreEmail(email) {
  await api('PATCH', `/api/emails/${email.id}/delete`, { is_deleted: false });
  state.emails = state.emails.filter(e => e.id !== email.id);
  state.currentEmailId = null;
  render(); refreshUnread();
  toast('Message restored');
}

async function deleteForever(email) {
  if (!confirm('Permanently delete this message? This cannot be undone.')) return;
  await api('DELETE', `/api/emails/${email.id}`);
  state.emails = state.emails.filter(e => e.id !== email.id);
  state.currentEmailId = null;
  render(); refreshUnread();
}

export async function purgeTrash() {
  if (!confirm('Permanently delete everything in Trash?')) return;
  const res = await api('DELETE', `/api/accounts/${state.currentAccountId}/trash`);
  await loadEmails();
  refreshUnread();
  toast(`Purged ${res.purged} message${res.purged === 1 ? '' : 's'}`);
}

function openReply(email) {
  const subject = email.subject && email.subject.startsWith('Re:') ? email.subject : `Re: ${email.subject || ''}`;
  const body = `\n\nOn ${fullDate(email.date_received)}, ${email.from_address} wrote:\n${(email.body_text || '').split('\n').map(l => '> ' + l).join('\n')}`;
  openCompose({ mode: 'reply', to: email.from_address, subject, body });
}

function openForward(email) {
  const subject = email.subject && /^Fwd:/i.test(email.subject) ? email.subject : `Fwd: ${email.subject || ''}`;
  const header = `\n\n---------- Forwarded message ----------\nFrom: ${email.from_address}\nDate: ${fullDate(email.date_received)}\nSubject: ${email.subject || ''}\nTo: ${email.to_address || ''}\n\n`;
  openCompose({ mode: 'forward', subject, body: header + (email.body_text || '') });
}

export { softDeleteCurrent, openReply, openForward };

export function getCurrentEmail() {
  return state.emails.find(e => e.id === state.currentEmailId) || null;
}

export function closeDetail() {
  state.currentEmailId = null;
  renderList();
  renderDetail();
}

// Keyboard navigation support
export function moveSelection(delta) {
  if (!state.emails.length) return;
  const idx = state.emails.findIndex(e => e.id === state.currentEmailId);
  const next = idx === -1 ? (delta > 0 ? 0 : state.emails.length - 1) : Math.min(state.emails.length - 1, Math.max(0, idx + delta));
  openEmail(state.emails[next].id);
  document.querySelector(`.email-item[data-id="${state.emails[next].id}"]`)?.scrollIntoView({ block: 'nearest' });
}

export async function syncAccount(silentToast = false) {
  if (!state.currentAccountId || state.isSyncing) return;
  state.isSyncing = true;
  renderList();
  try {
    await api('POST', `/api/sync/${state.currentAccountId}`);
    await loadEmails({ silent: true });
    refreshUnread();
    if (!silentToast) toast('Sync complete');
  } catch (err) {
    toast('Sync failed: ' + err.message, 'error');
  } finally {
    state.isSyncing = false;
    renderList();
  }
}

// ── Bulk selection ──
function updateBulkBar() {
  const bar = document.getElementById('bulk-bar');
  const n = state.selection.size;
  bar.classList.toggle('hidden', n === 0);
  document.getElementById('select-all').checked = n > 0 && n === state.emails.length;
  document.getElementById('bulk-count').textContent = `${n} selected`;
}

function bulkApply(kind) {
  const ids = [...state.selection];
  if (!ids.length) return;
  const ops = ids.map(id => {
    if (kind === 'star') return api('PATCH', `/api/emails/${id}/flag`, { is_flagged: true });
    if (kind === 'delete') return api('PATCH', `/api/emails/${id}/delete`, { is_deleted: true });
    return api('PATCH', `/api/emails/${id}/read`, { is_read: kind === 'read' });
  });
  Promise.allSettled(ops).then(async () => {
    state.selection.clear();
    await loadEmails({ silent: true });
    refreshUnread();
    toast(`${ids.length} message${ids.length > 1 ? 's' : ''} updated`);
  });
}

// ── Event delegation (bound once) ──
export function initMailEvents() {
  const list = document.getElementById('email-list');

  list.addEventListener('click', (e) => {
    const flagBtn = e.target.closest('[data-flag]');
    if (flagBtn) { toggleFlag(parseInt(flagBtn.dataset.flag)); return; }
    if (e.target.closest('[data-load-more]')) { loadEmails({ append: true }); return; }
    if (e.target.closest('[data-empty-trash]')) { purgeTrash(); return; }
    if (e.target.closest('input[type="checkbox"]')) return;
    const item = e.target.closest('.email-item');
    if (item) openEmail(parseInt(item.dataset.id));
  });

  list.addEventListener('change', (e) => {
    const cb = e.target.closest('input[data-check]');
    if (!cb) return;
    const id = parseInt(cb.dataset.check);
    if (cb.checked) state.selection.add(id); else state.selection.delete(id);
    cb.closest('.email-item').classList.toggle('checking', cb.checked);
    updateBulkBar();
  });

  document.getElementById('select-all').addEventListener('change', (e) => {
    if (e.target.checked) state.emails.forEach(em => state.selection.add(em.id));
    else state.selection.clear();
    renderList();
    updateBulkBar();
  });

  document.querySelectorAll('[data-bulk]').forEach(btn => {
    btn.addEventListener('click', () => {
      const kind = btn.dataset.bulk;
      if (kind === 'cancel') { state.selection.clear(); renderList(); updateBulkBar(); return; }
      bulkApply(kind);
    });
  });

  document.getElementById('account-list').addEventListener('click', (e) => {
    const keyBtn = e.target.closest('[data-key]');
    if (keyBtn) {
      e.stopPropagation();
      const acc = state.accounts.find(a => a.id === parseInt(keyBtn.dataset.key));
      window.dispatchEvent(new CustomEvent('lm:open-password-modal', { detail: { id: keyBtn.dataset.key, email: acc?.email } }));
      return;
    }
    const delBtn = e.target.closest('[data-del]');
    if (delBtn) {
      e.stopPropagation();
      const id = parseInt(delBtn.dataset.del);
      if (confirm('Remove account and all its emails?')) {
        api('DELETE', `/api/accounts/${id}`).then(loadAccounts);
      }
      return;
    }
    const accItem = e.target.closest('.account-item');
    if (accItem) {
      const id = parseInt(accItem.dataset.id);
      if (state.currentAccountId !== id) {
        state.currentAccountId = id;
        state.currentMailbox = 'INBOX';
        state.currentEmailId = null;
        state.selection.clear();
        state.attCache.clear();
        closeMobileNav();
        loadEmails().then(refreshUnread);
      }
    }
  });

  document.getElementById('folder-list').addEventListener('click', (e) => {
    const item = e.target.closest('.folder-item');
    if (!item) return;
    const f = item.dataset.folder;
    if (state.currentMailbox !== f) {
      state.currentMailbox = f;
      state.currentEmailId = null;
      state.selection.clear();
      closeMobileNav();
      document.getElementById('search-input').value = '';
      loadEmails();
    }
  });

  document.getElementById('sync-btn').addEventListener('click', () => syncAccount(false));

  // ── Detail pane: restore prefs, drag-resize, lightbox ──
  const pane = document.getElementById('detail-pane');
  if (localStorage.getItem(FULL_KEY) === '1') pane.classList.add('full-mode');
  const savedW = parseInt(localStorage.getItem(WIDTH_KEY), 10);
  if (savedW >= MIN_PANE_W) setPaneWidth(savedW);

  const handle = document.getElementById('detail-resize');
  let resizing = false;
  handle.addEventListener('pointerdown', (e) => {
    if (isFullMode() || window.innerWidth <= 960) return;
    resizing = true;
    document.body.classList.add('resizing');
    handle.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  handle.addEventListener('pointermove', (e) => {
    if (!resizing) return;
    setPaneWidth(window.innerWidth - e.clientX);
  });
  const endResize = (e) => {
    if (!resizing) return;
    resizing = false;
    document.body.classList.remove('resizing');
    try { handle.releasePointerCapture(e.pointerId); } catch (_) {}
    const w = parseInt(pane.style.width, 10);
    if (w) localStorage.setItem(WIDTH_KEY, String(w));
  };
  handle.addEventListener('pointerup', endResize);
  handle.addEventListener('pointercancel', endResize);
  handle.addEventListener('dblclick', () => {
    pane.style.width = '';
    localStorage.removeItem(WIDTH_KEY);
  });

  const lightboxEl = document.getElementById('lightbox');
  lightboxEl.addEventListener('click', (e) => {
    if (e.target.closest('.lb-figure')) return; // image handles its own click
    closeLightbox(); // backdrop or ✕ button
  });
  document.getElementById('lightbox-img').addEventListener('click', (e) => {
    e.target.classList.toggle('actual');
  });

  // Poll: accurate badges + quiet inbox refresh every 30s
  setInterval(() => {
    if (document.hidden || !state.currentAccountId) return;
    refreshUnread();
    if (state.currentMailbox === 'INBOX' && !isSearching() && !isOpen() && !state.isSyncing) {
      loadEmails({ silent: true });
    }
  }, 30000);
}
