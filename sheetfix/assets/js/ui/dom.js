// DOM helpers. All user data is inserted as text nodes (never innerHTML).

// Views build content with optional parts (`cond ? node : null`). Native append() would
// render null/false as the text "null"/"false", so skip empty values and flatten arrays.
// Strings still become text nodes, exactly as with the native method.
for (const proto of [Element.prototype, DocumentFragment.prototype]) {
  const native = proto.append;
  proto.append = function (...nodes) {
    return native.apply(this, nodes.flat(Infinity).filter((n) => n !== null && n !== undefined && n !== false));
  };
}

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === false || v === null || v === undefined) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'value') el.value = v;
      else if (k === 'checked' || k === 'disabled' || k === 'selected' || k === 'multiple') el[k] = !!v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else if (c instanceof Node) el.appendChild(c);
    else el.appendChild(document.createTextNode(String(c)));
  }
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

export const fmt = (n) => Number(n).toLocaleString('en');
export const plural = (n, one, many = one + 's') => `${fmt(n)} ${n === 1 ? one : many}`;

let liveRegion;
export function announce(msg) {
  liveRegion ||= document.getElementById('live');
  if (!liveRegion) return;
  liveRegion.textContent = '';
  setTimeout(() => (liveRegion.textContent = msg), 30);
}

/** Download text as a file. The object URL is revoked shortly after the click. */
export function download(text, filename) {
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename, hidden: true });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  announce(`Downloaded ${filename}`);
}

/** Modal dialog using native <dialog> (keyboard operable, Escape closes). */
export function openDialog(title, body, buttons = [{ label: 'Close', value: false }]) {
  return new Promise((resolve) => {
    const id = 'dlg-' + Math.random().toString(36).slice(2);
    const dlg = h('dialog', { class: 'dialog', 'aria-labelledby': id });
    const footer = h('div', { class: 'dialog-actions' });
    for (const b of buttons) {
      footer.appendChild(
        h('button', {
          type: 'button',
          class: 'btn ' + (b.kind || (b.value ? 'primary' : '')),
          onclick: () => {
            dlg.close();
            resolve(b.value);
          },
          text: b.label,
        })
      );
    }
    dlg.append(h('h2', { id, text: title }), h('div', { class: 'dialog-body' }, body), footer);
    dlg.addEventListener('cancel', () => resolve(false));
    dlg.addEventListener('close', () => setTimeout(() => dlg.remove(), 0));
    document.body.appendChild(dlg);
    dlg.showModal();
    const primary = footer.querySelector('.primary') || footer.querySelector('button');
    primary && primary.focus();
  });
}

export function confirmDialog(title, message, okLabel = 'Continue', danger = false) {
  return openDialog(title, typeof message === 'string' ? h('p', { text: message }) : message, [
    { label: 'Cancel', value: false },
    { label: okLabel, value: true, kind: danger ? 'danger' : 'primary' },
  ]);
}

/** Record details view: label/value pairs, accessible alternative to wide tables. */
export function showDetails(title, labels, cells, extra) {
  const dl = h('dl', { class: 'details' });
  labels.forEach((label, i) => {
    dl.append(h('dt', { text: label }), h('dd', { class: cells[i] === '' ? 'muted' : '', text: cells[i] === '' ? '(blank)' : cells[i] }));
  });
  return openDialog(title, [extra || null, dl]);
}

export function notice(kind, ...children) {
  const role = kind === 'error' ? 'alert' : 'status';
  return h('div', { class: `notice ${kind}`, role }, ...children);
}

export function field(label, control, hint) {
  const id = control.id || (control.id = 'f-' + Math.random().toString(36).slice(2));
  return h('div', { class: 'field' }, h('label', { for: id, text: label }), control, hint ? h('p', { class: 'hint', text: hint }) : null);
}

export function checkbox(label, checked, onchange, attrs = {}) {
  const input = h('input', { type: 'checkbox', checked, onchange: (e) => onchange(e.target.checked), ...attrs });
  return h('label', { class: 'check' }, input, h('span', { text: label }));
}

export function select(options, value, onchange, attrs = {}) {
  const s = h('select', { ...attrs, onchange: (e) => onchange(e.target.value) });
  for (const o of options) s.appendChild(h('option', { value: o.value, selected: o.value === value, text: o.label }));
  return s;
}

export function button(label, onclick, kind = '', attrs = {}) {
  return h('button', { type: 'button', class: 'btn ' + kind, onclick, ...attrs }, label);
}

export function icon(name) {
  // Small inline SVG icons; decorative (labels always accompany them).
  const paths = {
    clean: 'M4 20h16M6 16l8-8 4 4-8 8H6v-4zM14 8l2-2 4 4-2 2',
    dup: 'M8 8h11v11H8zM5 16V5h11',
    compare: 'M7 4v16M17 4v16M4 8h6M14 16h6',
    export: 'M12 4v11m0 0l-4-4m4 4l4-4M5 20h14',
    help: 'M12 18h.01M9.1 9a3 3 0 115.8 1c-.6 1.3-2.9 1.9-2.9 4',
    home: 'M4 11l8-7 8 7v9h-5v-6H9v6H4z',
    file: 'M6 3h8l4 4v14H6zM14 3v4h4',
    menu: 'M4 6h16M4 12h16M4 18h16',
  };
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'icon');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', paths[name] || '');
  svg.appendChild(p);
  return svg;
}
