import { icon } from './icons.js';

export function escapeHtml(s = '') {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function linkify(escapedText) {
  return escapedText.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
}

export function initials(name = '?') {
  const clean = name.split('@')[0].replace(/[._\-\d]+/g, ' ').trim();
  const parts = clean.split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return parts.length === 1 ? parts[0].slice(0, 2) : parts[0][0] + parts[parts.length - 1][0];
}

export function avatarColor(seed = '') {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 360;
  return `linear-gradient(135deg, hsl(${h}, 62%, 55%), hsl(${(h + 40) % 360}, 62%, 45%))`;
}

export function timeAgo(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  const sameDay = d.toDateString() === new Date().toDateString();
  if (sameDay) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const days = Math.floor(mins / 1440);
  if (days < 7) return d.toLocaleDateString([], { weekday: 'short' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export function fullDate(ts) {
  return new Date(ts || Date.now()).toLocaleString([], {
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit'
  });
}

export function fmtSize(bytes) {
  if (!bytes && bytes !== 0) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(1) + ' MB';
}

// First ~140 chars of plain-ish text for list snippets
export function snippet(text = '', len = 140) {
  const clean = String(text)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&\w+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return clean.length > len ? clean.slice(0, len).trimEnd() + '…' : clean;
}

export function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

export function toast(message, type = 'success', opts = {}) {
  const container = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  const icName = type === 'success' ? 'check' : 'alert';
  el.innerHTML = `
    <span class="t-icon">${icon(icName)}</span>
    <span>${linkify(escapeHtml(message))}</span>
    ${opts.action ? `<button class="toast-action" type="button">${escapeHtml(opts.action.label)}</button>` : ''}
  `;
  if (opts.action) {
    el.querySelector('.toast-action').addEventListener('click', () => {
      opts.action.fn();
      dismiss();
    });
  }
  container.appendChild(el);

  let gone = false;
  const dismiss = () => {
    if (gone) return;
    gone = true;
    el.classList.add('leaving');
    el.addEventListener('animationend', () => el.remove(), { once: true });
  };
  setTimeout(dismiss, opts.ttl || 6000);
}
