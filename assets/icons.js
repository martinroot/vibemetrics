const paths = {
  download: '<path d="M12 3v12m-4-4 4 4 4-4M5 16v4h14v-4"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5m-18 4 9 5 9-5"/>',
  grid: '<rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><rect x="14" y="14" width="6" height="6" rx="1"/>',
  box: '<path d="m4 7 8-4 8 4v10l-8 4-8-4V7Zm0 0 8 4 8-4m-8 4v10"/>',
  pulse: '<path d="M3 12h5l2-6 4 12 2-6h5"/>',
  route: '<circle cx="6" cy="17" r="2"/><circle cx="18" cy="7" r="2"/><path d="M8 17h8a3 3 0 0 0 0-6H8a2 2 0 0 1 0-4h8"/>',
  file: '<path d="M7 3h7l4 4v14H6V3h1Zm6 0v5h5M9 12h6m-6 4h6"/>',
  database: '<ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v12c0 4 16 4 16 0V6M4 12c0 4 16 4 16 0"/>',
  target: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r="1"/>',
  users: '<circle cx="9" cy="8" r="3"/><path d="M3 19v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2m1-14a3 3 0 0 1 0 6m1 3a4 4 0 0 1 4 4v1"/>',
  link: '<path d="m10 14 4-4m-5 7-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m0 8a4 4 0 0 0 6 0l4-4a4 4 0 0 0-6-6l-1 1" transform="translate(1 1) scale(.9)"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  terminal: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m7 9 3 3-3 3m6 0h4"/>',
};

export function icon(name) {
  return '<span data-icon="' + name + '"></span>';
}

export function mountIcons(root) {
  root.querySelectorAll('[data-icon]:empty').forEach(element => {
    element.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round">' + (paths[element.dataset.icon] || '') + '</svg>';
  });
}
