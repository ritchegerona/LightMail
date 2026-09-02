const KEY = 'lm-theme'; // 'system' | 'light' | 'dark'
const mq = window.matchMedia('(prefers-color-scheme: dark)');
let current = 'system';

function resolve(t) {
  return t === 'system' ? (mq.matches ? 'dark' : 'light') : t;
}

function apply(t) {
  current = t;
  localStorage.setItem(KEY, t);
  const resolved = resolve(t);
  document.documentElement.dataset.theme = resolved;

  const btn = document.querySelector('[data-theme-icon]');
  if (btn) {
    btn.innerHTML =
      t === 'light'
        ? `<svg class="ic" viewBox="0 0 24 24"><use href="#i-sun"></use></svg>`
        : t === 'dark'
          ? `<svg class="ic" viewBox="0 0 24 24"><use href="#i-moon"></use></svg>`
          : `<svg class="ic" viewBox="0 0 24 24"><use href="#i-auto"></use></svg>`;
  }
  const themeBtn = document.getElementById('theme-btn');
  if (themeBtn) themeBtn.title = `Theme: ${t}`;
}

export function initTheme() {
  apply(localStorage.getItem(KEY) || 'system');
  mq.addEventListener('change', () => { if (current === 'system') apply('system'); });
  document.getElementById('theme-btn')?.addEventListener('click', cycleTheme);
}

export function cycleTheme() {
  const order = ['system', 'light', 'dark'];
  apply(order[(order.indexOf(current) + 1) % order.length]);
}
