// Inline SVG icon helper — all icons live as <symbol> defs in index.html
export function icon(name, cls = '') {
  return `<svg class="ic ${cls}" aria-hidden="true"><use href="#i-${name}"></use></svg>`;
}

// Replace static [data-icon] placeholders in the initial HTML
export function hydrateIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach(el => {
    el.innerHTML = icon(el.dataset.icon);
  });
}
