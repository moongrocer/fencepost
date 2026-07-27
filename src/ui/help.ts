import { el } from './dom';

const KEYS: Array<[string, string]> = [
  ['TAB', 'Toggle output mode (clean projector feed)'],
  ['F', 'Fullscreen (auto-enters calibrate mode)'],
  ['H', 'Hide / show floating palette (calibrate mode)'],
  ['Arrows', 'Nudge selection 4 px'],
  ['Shift+Arrows', 'Nudge selection 0.25 px (fine)'],
  ['1–7', 'Select test pattern (5 cycles white/gray/black)'],
  ['PgUp / PgDn', 'Cycle patterns and loaded stills'],
  ['B', 'Toggle bezier point overlay'],
  ['G', 'Toggle fence overlay'],
  ['W', 'Toggle mesh wireframe'],
  ['C', 'Toggle hard/smooth corner on selected post'],
  ['Delete', 'Remove selected fence post'],
  ['Ctrl+Z / Ctrl+Shift+Z', 'Undo / Redo'],
  ['Ctrl+S', 'Save project JSON'],
  ['Ctrl+E', 'Export MPCDI archive'],
  ['Shift+Click / Drag', 'Add to selection / rubber-band select'],
  ['?', 'This help'],
  ['Esc', 'Close help / clear selection'],
];

export function buildHelpOverlay(onClose: () => void): HTMLElement {
  const wrap = el('div', 'lw-help');
  const panel = el('div', 'lw-help-panel');
  panel.appendChild(el('h2', '', 'FENCEPOST — KEYBOARD MAP'));
  const table = el('table');
  for (const [k, desc] of KEYS) {
    const tr = el('tr');
    const td1 = el('td', 'key', k);
    const td2 = el('td', '', desc);
    tr.appendChild(td1);
    tr.appendChild(td2);
    table.appendChild(tr);
  }
  panel.appendChild(table);
  wrap.appendChild(panel);
  wrap.addEventListener('click', (e) => {
    if (e.target === wrap) onClose();
  });
  return wrap;
}
