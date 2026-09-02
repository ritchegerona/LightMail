import { hydrateIcons } from './icons.js';
import { initTheme } from './theme.js';
import { api } from './api.js';
import { toast } from './ui.js';
import {
  state, loadAccounts, loadEmails, closeDetail, renderList, refreshUnread, initMailEvents,
} from './mail.js';
import { initCompose, openCompose } from './compose.js';
import { initKeys } from './keys.js';

const el = id => document.getElementById(id);
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

hydrateIcons();
initTheme();

initCompose({
  getAccountId: () => state.currentAccountId,
  onSent: async () => {
    await loadEmails({ silent: true });
    window.dispatchEvent(new CustomEvent('lm:refresh-unread'));
  },
  onSaved: async () => {
    if (state.currentMailbox === 'Drafts') await loadEmails({ silent: true });
  },
});

// ── Static wiring ──
el('compose-btn').addEventListener('click', () => {
  if (!state.currentAccountId) { toast('Select an account first', 'error'); return; }
  openCompose({ mode: 'new' });
});

el('menu-btn').addEventListener('click', () => {
  const appEl = el('app');
  appEl.classList.toggle('sidebar-open');
  if (appEl.classList.contains('sidebar-open')) {
    const backdrop = document.createElement('div');
    backdrop.className = 'sidebar-backdrop';
    backdrop.addEventListener('click', () => {
      appEl.classList.remove('sidebar-open');
      backdrop.remove();
    });
    document.body.appendChild(backdrop);
  } else {
    document.querySelector('.sidebar-backdrop')?.remove();
  }
});

let searchSeq = 0;
const runSearch = debounce(async () => {
  const seq = ++searchSeq;
  try {
    await loadEmails({ silent: state.emails.length > 0 });
    if (seq !== searchSeq) return; // stale
  } catch (_) { /* handled upstream */ }
}, 250);
el('search-input').addEventListener('input', (e) => {
  // switching between searching and not changes folder context — reset pagination
  state.offset = 0;
  runSearch(e);
});

el('add-account-btn').addEventListener('click', () => {
  el('account-modal').classList.remove('hidden');
  setTimeout(() => el('acc-email').focus(), 60);
});

el('account-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const payload = {
    email: el('acc-email').value.trim(),
    password: el('acc-password').value,
    imap_host: el('acc-imap-host').value.trim(),
    imap_port: parseInt(el('acc-imap-port').value),
    smtp_host: el('acc-smtp-host').value.trim(),
    smtp_port: parseInt(el('acc-smtp-port').value),
  };
  try {
    const res = await api('POST', '/api/accounts', payload);
    if (res.success) {
      el('account-modal').classList.add('hidden');
      e.target.reset();
      toast(`Account added — syncing ${payload.email}…`);
      state.currentAccountId = res.id;
      state.currentMailbox = 'INBOX';
      await loadAccounts();
    }
  } catch (err) {
    if (err.status === 409) {
      toast(`"${err.response.email}" already exists — switching to it`);
      state.currentAccountId = err.response.id;
      state.currentMailbox = 'INBOX';
      el('account-modal').classList.add('hidden');
      await loadAccounts();
    } else {
      toast('Error adding account: ' + err.message, 'error');
    }
  }
});

window.addEventListener('lm:open-password-modal', (e) => {
  const { id, email } = e.detail;
  el('password-form').dataset.id = id;
  el('pw-account-email').textContent = email;
  el('pw-password').value = '';
  el('password-modal').classList.remove('hidden');
  setTimeout(() => el('pw-password').focus(), 60);
});

el('password-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = el('password-form').dataset.id;
  const password = el('pw-password').value;
  if (!id || !password) return;
  const btn = e.target.querySelector('button[type="submit"]');
  btn.disabled = true;
  btn.textContent = 'Saving…';
  try {
    await api('PATCH', `/api/accounts/${id}/password`, { password });
    el('password-modal').classList.add('hidden');
    toast('Password updated — syncing…');
    state.isSyncing = true;
    renderList();
    try {
      await api('POST', `/api/sync/${id}`);
      state.currentAccountId = parseInt(id);
      await loadAccounts();
      toast('Sync complete — your inbox should be filled now');
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      state.isSyncing = false;
      renderList();
    }
  } catch (err) {
    toast('Update failed: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save & Re-sync';
  }
});

el('shortcuts-btn').addEventListener('click', () => {
  el('shortcuts-modal').classList.remove('hidden');
});

window.addEventListener('lm:close-detail', () => closeDetail());
window.addEventListener('lm:refresh-unread', () => refreshUnread());

initKeys();
initMailEvents();
loadAccounts();

// Expose a tiny debug handle (useful in console; harmless in prod)
window.LightMail = { state };
