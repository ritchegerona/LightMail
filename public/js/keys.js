import { state, moveSelection, getCurrentEmail, toggleFlag, softDeleteCurrent, openReply, openForward, closeDetail, closeLightbox } from './mail.js';
import { requestClose, isOpen, isMinimized, restore, openCompose } from './compose.js';

function typingTarget(e) {
  const t = e.target;
  return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
}

function modalOpen() {
  return [...document.querySelectorAll('.modal')].some(m => !m.classList.contains('hidden'));
}

export function initKeys() {
  window.addEventListener('keydown', (e) => {
    // Esc cascades: compose → detail → modals (modals bound separately below)
    if (e.key === 'Escape') {
      const lb = document.getElementById('lightbox');
      if (lb && !lb.classList.contains('hidden')) { closeLightbox(); return; }
      if (isOpen() && !isMinimized()) { e.preventDefault(); requestClose(); return; }
      if (isOpen() && isMinimized()) { restore(); return; }
      if (!typingTarget(e)) {
        const pane = document.getElementById('detail-pane');
        if (pane.classList.contains('open')) closeDetail();
      }
      return;
    }

    if (typingTarget(e) || modalOpen() || (isOpen() && !isMinimized())) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    switch (e.key) {
      case 'j': case 'J':
        e.preventDefault(); moveSelection(1); break;
      case 'k': case 'K':
        e.preventDefault(); moveSelection(-1); break;
      case 'Enter': {
        // Enter on a focused row opens it (accessibility); otherwise opens current selection
        const focused = e.target.closest?.('.email-item');
        if (focused) { e.preventDefault(); focused.click(); }
        break;
      }
      case 'c': case 'C': {
        if (!state.currentAccountId) break;
        e.preventDefault();
        openCompose({ mode: 'new' });
        break;
      }
      case 'r': case 'R': {
        const email = getCurrentEmail();
        if (email) { e.preventDefault(); openReply(email); }
        break;
      }
      case 'f': case 'F': {
        const email = getCurrentEmail();
        if (email) { e.preventDefault(); openForward(email); }
        break;
      }
      case 's': case 'S': {
        const target = state.selection.size
          ? [...state.selection]
          : (getCurrentEmail() ? [getCurrentEmail().id] : []);
        if (target.length) { e.preventDefault(); target.forEach(id => toggleFlag(id)); }
        break;
      }
      case 'e': case 'E': {
        const email = getCurrentEmail();
        if (email) { e.preventDefault(); softDeleteCurrent(email); }
        break;
      }
      case '/':
        e.preventDefault();
        document.getElementById('search-input').focus();
        break;
      case '?':
        e.preventDefault();
        document.getElementById('shortcuts-modal').classList.remove('hidden');
        break;
    }
  });

  // Modal close on Esc + backdrop + close buttons
  document.querySelectorAll('.modal').forEach(m => {
    m.addEventListener('click', (ev) => {
      if (ev.target === m) m.classList.add('hidden');
      if (ev.target.closest('.close')) m.classList.add('hidden');
    });
    m.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') m.classList.add('hidden');
    });
  });
}
