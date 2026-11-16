// Tiny DOM helpers. Text is always inserted as text nodes; innerHTML is never used.
import { formatPHP } from '../domain/money.js';

const PROPS = new Set(['value', 'checked', 'disabled', 'selected', 'required', 'hidden', 'open', 'readOnly', 'htmlFor', 'colSpan', 'multiple']);
function append(el, child) {
  if (child === null || child === undefined || child === false) return;
  if (Array.isArray(child)) { for (const c of child) append(el, c); return; }
  el.append(child instanceof Node ? child : document.createTextNode(String(child)));
}
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (PROPS.has(k)) el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, children);
  return el;
}
export const clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); return el; };

const ICONS = {
  home: 'M3 11l9-8 9 8M5 10v10h14V10', upload: 'M12 16V4M7 9l5-5 5 5M4 20h16', tag: 'M3 12V3h9l9 9-9 9-9-9zM7.5 7.5h.01',
  inbox: 'M3 13l3-9h12l3 9v7H3v-7zM3 13h5l1 3h6l1-3h5', flag: 'M5 21V4M5 4h13l-3 4 3 4H5', cash: 'M3 7h18v10H3zM12 15a3 3 0 100-6 3 3 0 000 6z',
  file: 'M6 3h9l4 4v14H6zM14 3v5h5M9 13h6M9 17h6', gear: 'M4 6h10M18 6h2M4 12h2M10 12h10M4 18h8M16 18h4M16 4v4M8 10v4M14 16v4',
  menu: 'M4 6h16M4 12h16M4 18h16', warn: 'M12 3l10 18H2L12 3zM12 10v5M12 18h.01', check: 'M4 12l5 5L20 6', info: 'M12 21a9 9 0 100-18 9 9 0 000 18zM12 11v6M12 7.5h.01',
};
export function icon(name) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('class', 'icon'); svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('focusable', 'false');
  const path = document.createElementNS(NS, 'path'); path.setAttribute('d', ICONS[name] || ICONS.info);
  svg.append(path); return svg;
}

export const money = (c, cls = '') => h('span', { class: `num ${cls}` }, formatPHP(c));
export const chip = (text, tone = 'neutral') => h('span', { class: `chip chip-${tone}` }, text);
export const btn = (label, onclick, { kind = '', iconName, type = 'button', disabled } = {}) => h('button', { type, class: `btn ${kind}`, onclick, disabled }, iconName ? icon(iconName) : null, label);
export const field = (label, control, help) => h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), control, help ? h('span', { class: 'help' }, help) : null);
export const select = (options, value, attrs = {}) => h('select', attrs, options.map(([v, l]) => h('option', { value: v, selected: v === value }, l)));
export const section = (title, ...body) => h('section', { class: 'card' }, title ? h('h2', {}, title) : null, body);
export const dl = (pairs) => h('dl', { class: 'dl' }, pairs.filter(Boolean).map(([k, v]) => [h('dt', {}, k), h('dd', {}, v === '' || v === null || v === undefined ? '—' : v)]));
export const notice = (tone, ...body) => h('div', { class: `notice notice-${tone}`, role: tone === 'error' ? 'alert' : 'note' }, icon(tone === 'ok' ? 'check' : tone === 'info' ? 'info' : 'warn'), h('div', {}, body));

/** Accessible, horizontally scrollable table. cols: [{ label, cell(row), num }] */
export function table(caption, cols, rows, { empty = 'Nothing to show.', limit = 200 } = {}) {
  if (!rows.length) return h('p', { class: 'empty' }, empty);
  let shown = Math.min(limit, rows.length);
  const tbody = h('tbody');
  const fill = (from, to) => { for (const r of rows.slice(from, to)) tbody.append(h('tr', {}, cols.map((c) => h('td', { class: c.num ? 'num' : '', 'data-label': c.label }, c.cell(r))))); };
  fill(0, shown);
  const more = rows.length > shown ? btn(`Show more (${rows.length - shown} hidden)`, () => {
    const next = Math.min(shown + limit, rows.length); fill(shown, next); shown = next;
    if (shown >= rows.length) more.remove(); else more.textContent = `Show more (${rows.length - shown} hidden)`;
  }) : null;
  return h('div', {}, h('div', { class: 'table-wrap', role: 'region', 'aria-label': caption, tabindex: '0' },
    h('table', {}, h('caption', { class: 'sr-only' }, caption), h('thead', {}, h('tr', {}, cols.map((c) => h('th', { scope: 'col', class: c.num ? 'num' : '' }, c.label)))), tbody)), more);
}

export function downloadFile(name, content, mime) {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const a = h('a', { href: url, download: name }); document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// ---- dialogs (native <dialog>: focus trap, Escape, top layer) ----
export function openDialog(title, build, { wide = false, onClose } = {}) {
  const opener = document.activeElement;
  const id = `dlg-${Math.random().toString(36).slice(2)}`;
  const dialog = h('dialog', { class: `dialog${wide ? ' wide' : ''}`, 'aria-labelledby': id });
  const close = (result) => { if (dialog.open) dialog.close(); dialog.remove(); if (opener && opener.isConnected) opener.focus(); else document.querySelector('#view h1')?.focus(); if (onClose) onClose(result); };
  dialog.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
  dialog.append(h('div', { class: 'dialog-head' }, h('h2', { id }, title), h('button', { type: 'button', class: 'btn ghost', 'aria-label': 'Close dialog', onclick: () => close() }, '✕')), h('div', { class: 'dialog-body' }, build(close)));
  document.body.append(dialog); dialog.showModal();
  return { dialog, close };
}
export function confirmDialog({ title, message, confirmLabel = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    let done = false; const finish = (v, close) => { if (done) return; done = true; if (close) close(); resolve(v); };
    openDialog(title, (close) => [h('p', {}, message), h('div', { class: 'actions' }, btn('Cancel', () => finish(false, close)), btn(confirmLabel, () => finish(true, close), { kind: danger ? 'danger' : 'primary' }))], { onClose: () => finish(false) });
  });
}
/**
 * Form dialog. fields: [{ name, label, type: text|date|select|textarea|checkbox, value, options, required, help }]
 * onSubmit(values) may throw; the message is shown and all input is preserved.
 */
export function formDialog({ title, intro, fields, submitLabel = 'Save', danger = false, onSubmit }) {
  openDialog(title, (close) => {
    const error = h('div', { class: 'form-error', role: 'alert' });
    const controls = {};
    const rows = fields.map((f) => {
      let c;
      if (f.type === 'select') c = select(f.options, f.value ?? '', { name: f.name, required: f.required });
      else if (f.type === 'textarea') c = h('textarea', { name: f.name, rows: '3', required: f.required, maxlength: '1000' }, f.value ?? '');
      else if (f.type === 'checkbox') c = h('input', { type: 'checkbox', name: f.name, checked: !!f.value });
      else c = h('input', { type: f.type === 'date' ? 'date' : 'text', name: f.name, value: f.value ?? '', required: f.required, inputmode: f.money ? 'decimal' : null, placeholder: f.placeholder || (f.money ? '0.00' : null), list: f.list ? `${f.name}-list` : null, autocomplete: 'off', maxlength: f.type === 'date' ? null : '200' });
      controls[f.name] = c;
      const extra = f.list ? h('datalist', { id: `${f.name}-list` }, f.list.map((v) => h('option', { value: v }))) : null;
      return f.type === 'checkbox' ? h('label', { class: 'check' }, c, h('span', {}, f.label)) : [field(f.required ? `${f.label} (required)` : f.label, c, f.help), extra];
    });
    const submit = h('button', { type: 'submit', class: `btn ${danger ? 'danger' : 'primary'}` }, submitLabel);
    return h('form', { novalidate: true, onsubmit: async (e) => {
      e.preventDefault(); clear(error);
      const values = {}; for (const f of fields) values[f.name] = f.type === 'checkbox' ? controls[f.name].checked : controls[f.name].value;
      const missing = fields.find((f) => f.required && String(values[f.name]).trim() === '');
      if (missing) { error.textContent = `${missing.label} is required.`; controls[missing.name].focus(); return; }
      submit.disabled = true;
      try { await onSubmit(values); close(); } catch (err) { error.textContent = err?.message || 'Something went wrong. Nothing was saved.'; submit.disabled = false; }
    } }, intro ? h('p', { class: 'help' }, intro) : null, rows, error, h('div', { class: 'actions' }, btn('Cancel', () => close()), submit));
  });
}
