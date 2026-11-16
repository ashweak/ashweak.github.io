// Compare two lists: explicit key/field mapping, exact by default, ambiguous keys excluded
// from one-to-one matching and shown for review. Source files are never modified.
import { h, clear, fmt, plural, notice, checkbox, select, button, announce } from '../dom.js';
import { run } from '../worker-client.js';
import { keyText } from '../../core/compare.js';
import { NUMBER_FORMATS } from '../../core/validate.js';
import { state, compareSide, changed } from '../state.js';
import { importer } from '../importer.js';
import { dataTable } from '../table.js';

function cmpState() {
  if (!state.compare) state.compare = { baseFrom: 'file', updFrom: 'file', mapping: null, result: null, acknowledged: false, tab: 'changed', stale: false, mappingFor: '' };
  return state.compare;
}

const SAMPLES = {
  baseline: [{ file: 'products_baseline.csv', label: 'baseline product list' }],
  updated: [{ file: 'products_updated.csv', label: 'updated product list' }],
};

export function renderCompare(root, rerender) {
  const c = cmpState();
  root.append(
    h('h1', { text: 'Compare two lists' }),
    h('p', { class: 'lead', text: 'Choose a Baseline file and an Updated file, map the key and the fields to compare, then review Added, Removed and Changed records. Neither file is modified.' })
  );
  root.append(h('div', { class: 'two-col' }, sidePanel('baseline', 'Baseline', c, rerender), sidePanel('updated', 'Updated', c, rerender)));
  const A = compareSide('baseline');
  const B = compareSide('updated');
  if (!A || !B) return;
  const sig = `${A.name}|${A.columns.length}|${B.name}|${B.columns.length}`;
  if (!c.mapping || c.mappingFor !== sig) {
    c.mapping = suggestMapping(A, B);
    c.mappingFor = sig;
    c.result = null;
  }
  root.append(mappingPanel(c, A, B, rerender));
  if (c.stale && !c.result) root.append(notice('warn', 'The working copy changed after the last comparison. Compare again to refresh results.'));
  if (c.result) root.append(resultsPanel(c, A, B, rerender));
}

function sidePanel(slot, title, c, rerender) {
  const fromKey = slot === 'baseline' ? 'baseFrom' : 'updFrom';
  const main = state.files.main;
  const panel = h('section', { class: 'panel side', 'aria-label': title });
  panel.append(h('h2', null, h('span', { class: `side-tag ${slot}`, text: title })));
  if (c[fromKey] === 'main' && main) {
    panel.append(h('p', null, h('strong', { text: `${main.name} (working copy)` })), button('Use a separate file instead', () => { c[fromKey] = 'file'; c.result = null; rerender(); }, 'small ghost'));
    return panel;
  }
  const f = state.files[slot];
  if (f) {
    panel.append(
      h('p', null, h('strong', { text: f.name }), h('span', { class: 'muted', text: ` · ${plural(f.dataset.rows.length, 'row')} · ${plural(f.dataset.columns.length, 'column')}` })),
      button('Replace file', () => { state.files[slot] = null; c.result = null; changed(); }, 'small ghost')
    );
    return panel;
  }
  panel.append(importer(slot, rerender, { samples: SAMPLES[slot], commitLabel: `Use as ${title}` }));
  if (main) panel.append(button(`Use the working copy of ${main.name}`, () => { c[fromKey] = 'main'; c.result = null; rerender(); }, 'small ghost'));
  return panel;
}

const norm = (s) => s.trim().toLowerCase();

function suggestMapping(A, B) {
  const bByName = new Map();
  B.columns.forEach((col, i) => {
    const n = norm(col.header);
    if (n && !bByName.has(n)) bByName.set(n, i);
  });
  const fields = A.columns.map((col, i) => {
    const b = bByName.has(norm(col.header)) ? bByName.get(norm(col.header)) : -1;
    return { a: i, b, label: A.labels[i], on: b >= 0, trim: false, caseInsensitive: false, numeric: '' };
  });
  const firstMatch = fields.find((f) => f.b >= 0);
  const keys = [{ a: firstMatch ? firstMatch.a : -1, b: firstMatch ? firstMatch.b : -1 }];
  return { keys, fields, keyTrim: false, keyCaseInsensitive: false };
}

function mappingPanel(c, A, B, rerender) {
  const m = c.mapping;
  const invalidate = () => {
    if (c.result) {
      c.result = null;
      rerender();
    }
  };
  const aOpts = [{ value: '-1', label: '— choose —' }, ...A.labels.map((l, i) => ({ value: String(i), label: l }))];
  const bOpts = [{ value: '-1', label: '— not mapped —' }, ...B.labels.map((l, i) => ({ value: String(i), label: l }))];
  const panel = h('section', { class: 'panel', 'aria-label': 'Column mapping' });
  panel.append(h('h2', { text: 'Map columns' }), h('p', { class: 'hint', text: 'Columns are matched by meaning, not position. Suggestions come from identical header names — check them before comparing.' }));

  const keys = h('div', { class: 'map-list' });
  m.keys.forEach((k, i) => {
    keys.append(
      h('div', { class: 'map-row' },
        h('span', { class: 'side-tag baseline', text: 'Baseline' }),
        select(aOpts, String(k.a), (v) => { k.a = Number(v); invalidate(); }, { 'aria-label': `Baseline key column ${i + 1}` }),
        h('span', { 'aria-hidden': 'true', text: '=' }),
        h('span', { class: 'side-tag updated', text: 'Updated' }),
        select(bOpts, String(k.b), (v) => { k.b = Number(v); invalidate(); }, { 'aria-label': `Updated key column ${i + 1}` }),
        m.keys.length > 1 ? button('Remove', () => { m.keys.splice(i, 1); rerender(); }, 'small ghost', { 'aria-label': `Remove key column ${i + 1}` }) : null
      )
    );
  });
  panel.append(
    h('h3', { text: 'Key (identifies the same record in both files)' }),
    keys,
    button('Add key column', () => { m.keys.push({ a: -1, b: -1 }); rerender(); }, 'small'),
    h('div', { class: 'inline-options' },
      checkbox('Ignore spaces at the edges of keys', m.keyTrim, (v) => { m.keyTrim = v; invalidate(); }),
      checkbox('Ignore upper/lower case in keys', m.keyCaseInsensitive, (v) => { m.keyCaseInsensitive = v; invalidate(); })
    )
  );

  const keyA = new Set(m.keys.map((k) => k.a));
  const tbl = h('table', { class: 'data map-table' });
  tbl.append(h('thead', null, h('tr', null, ['Compare', 'Baseline column', 'Updated column', 'Ignore edge spaces', 'Ignore case', 'Numbers equal if'].map((t) => h('th', { scope: 'col', text: t })))));
  const tb = h('tbody');
  m.fields.forEach((f) => {
    if (keyA.has(f.a)) return;
    tb.append(
      h('tr', null,
        h('td', null, h('input', { type: 'checkbox', checked: f.on, 'aria-label': `Compare ${f.label}`, onchange: (e) => { f.on = e.target.checked; invalidate(); } })),
        h('td', { text: f.label }),
        h('td', null, select(bOpts, String(f.b), (v) => { f.b = Number(v); f.on = f.b >= 0; rerender(); }, { 'aria-label': `Updated column for ${f.label}` })),
        h('td', null, h('input', { type: 'checkbox', checked: f.trim, 'aria-label': `Ignore edge spaces for ${f.label}`, onchange: (e) => { f.trim = e.target.checked; invalidate(); } })),
        h('td', null, h('input', { type: 'checkbox', checked: f.caseInsensitive, 'aria-label': `Ignore case for ${f.label}`, onchange: (e) => { f.caseInsensitive = e.target.checked; invalidate(); } })),
        h('td', null, select([{ value: '', label: 'Exact text only' }, ...NUMBER_FORMATS.map((n) => ({ value: n.id, label: `Equal as ${n.label.split(' (')[0]}` }))], f.numeric, (v) => { f.numeric = v; invalidate(); }, { 'aria-label': `Number equivalence for ${f.label}` }))
      )
    );
  });
  tbl.append(tb);
  panel.append(h('h3', { text: 'Fields to compare' }), h('div', { class: 'table-scroll' }, tbl), h('p', { class: 'hint', text: 'By default 10.00 and 10 are different text. Choose a number format to treat them as equal. Blank is never equal to zero.' }));

  const problems = [];
  if (m.keys.some((k) => k.a < 0 || k.b < 0)) problems.push('Choose both columns for every key.');
  if (m.fields.some((f) => f.on && f.b < 0)) problems.push('Every compared field needs an Updated column.');
  panel.append(
    problems.length ? notice('warn', problems.join(' ')) : null,
    h('div', { class: 'actions' }, button(c.result ? 'Compare again' : 'Compare', () => doCompare(c, A, B, rerender), 'primary', { disabled: problems.length > 0 }))
  );
  return panel;
}

async function doCompare(c, A, B, rerender) {
  const m = c.mapping;
  const mapping = {
    keys: m.keys.map((k) => ({ a: k.a, b: k.b })),
    fields: m.fields.filter((f) => f.on && !m.keys.some((k) => k.a === f.a)).map((f) => ({ a: f.a, b: f.b, label: f.label, trim: f.trim, caseInsensitive: f.caseInsensitive, numeric: f.numeric })),
    keyTrim: m.keyTrim,
    keyCaseInsensitive: m.keyCaseInsensitive,
  };
  try {
    const result = await run('compare', { base: { columns: A.columns, rows: A.rows }, upd: { columns: B.columns, rows: B.rows }, mapping }, { label: 'Comparing lists…' });
    result.mapping = mapping;
    result.names = { baseline: A.name, updated: B.name };
    c.result = result;
    c.stale = false;
    c.acknowledged = result.counts.excludedBaseline + result.counts.excludedUpdated === 0;
    c.tab = 'changed';
    announce(`Comparison complete: ${result.counts.added} added, ${result.counts.removed} removed, ${result.counts.changed} changed.`);
  } catch (err) {
    if (err.code !== 'cancelled') announce(err.message);
  }
  rerender();
}

const REASON = {
  'missing-key': 'Missing key',
  'duplicate-key': 'Key repeated in this file',
  'duplicate-key-other-side': 'Key repeated in the other file',
};

function resultsPanel(c, A, B, rerender) {
  const r = c.result;
  const k = r.counts;
  const panel = h('section', { class: 'panel', 'aria-label': 'Comparison results' });
  panel.append(h('h2', { text: 'Results' }), settingsLine(r, A, B));

  if (!c.acknowledged) {
    const reasons = (list) => {
      const m = new Map();
      for (const e of list) m.set(e.reason, (m.get(e.reason) || 0) + 1);
      return [...m].map(([rsn, n]) => `${REASON[rsn]}: ${fmt(n)}`).join(' · ');
    };
    panel.append(
      notice('warn',
        h('h3', { text: 'Some records cannot be matched one-to-one' }),
        h('p', { text: 'Records with a blank or repeated key are not matched automatically, because choosing one of them would be a guess.' }),
        h('ul', null,
          k.excludedBaseline ? h('li', { text: `Baseline: ${plural(k.excludedBaseline, 'record')} (${reasons(r.excludedBase)})` }) : null,
          k.excludedUpdated ? h('li', { text: `Updated: ${plural(k.excludedUpdated, 'record')} (${reasons(r.excludedUpd)})` }) : null
        ),
        h('p', { class: 'hint', text: 'You can fix these in Find duplicates (for the working copy) or in the source file, or exclude them from this comparison. Excluded records stay in the report.' }),
        button('Exclude these records and show results', () => { c.acknowledged = true; rerender(); }, 'primary')
      )
    );
    panel.append(excludedTables(r, A, B));
    return panel;
  }

  panel.append(
    h('ul', { class: 'stats' },
      stat('Added', k.added, 'ok'),
      stat('Removed', k.removed, k.removed ? 'bad' : ''),
      stat('Changed', k.changed, k.changed ? 'warn' : ''),
      stat('Unchanged in selected fields', k.unchanged),
      stat('Excluded (Baseline / Updated)', `${fmt(k.excludedBaseline)} / ${fmt(k.excludedUpdated)}`, k.excludedBaseline + k.excludedUpdated ? 'warn' : '')
    ),
    h('p', { class: `invariant ${k.baselineBalanced && k.updatedBalanced ? 'ok-text' : 'bad-text'}` },
      `Baseline ${fmt(k.baseline)} = Removed ${fmt(k.removed)} + Changed ${fmt(k.changed)} + Unchanged ${fmt(k.unchanged)} + Excluded ${fmt(k.excludedBaseline)} ${k.baselineBalanced ? '✓' : '✗'} · `,
      `Updated ${fmt(k.updated)} = Added ${fmt(k.added)} + Changed ${fmt(k.changed)} + Unchanged ${fmt(k.unchanged)} + Excluded ${fmt(k.excludedUpdated)} ${k.updatedBalanced ? '✓' : '✗'}`
    )
  );
  if (r.mapping.fields.length) {
    panel.append(h('p', { class: 'hint', text: `Field-level changes (${fmt(k.fieldChanges)}): ` + r.mapping.fields.map((f, i) => `${f.label} ${fmt(r.fieldChangeCounts[i])}`).join(' · ') }));
  } else {
    panel.append(notice('info', 'No fields were selected, so every matched record is “Unchanged in selected fields”.'));
  }

  const tabs = [['added', `Added (${fmt(k.added)})`], ['removed', `Removed (${fmt(k.removed)})`], ['changed', `Changed (${fmt(k.changed)})`], ['unchanged', `Unchanged (${fmt(k.unchanged)})`], ['excluded', `Excluded (${fmt(k.excludedBaseline + k.excludedUpdated)})`]];
  panel.append(h('div', { class: 'tabs', role: 'group', 'aria-label': 'Result status' }, tabs.map(([v, l]) => button(l, () => { c.tab = v; rerender(); }, c.tab === v ? 'small primary' : 'small', { 'aria-pressed': c.tab === v ? 'true' : 'false' }))));

  const body = h('div', { class: 'tab-body' });
  if (c.tab === 'added') body.append(h('p', { class: 'hint', text: 'Only in Updated. This does not say when the record was created.' }), dataTable({ caption: 'Added records', labels: B.labels, rows: r.added, meta: [{ label: 'Updated record', value: (x) => x.upd.record }], cells: (x) => x.upd.cells, detailsTitle: (x) => `Updated record ${x.upd.record}` }));
  if (c.tab === 'removed') body.append(h('p', { class: 'hint', text: 'Only in Baseline.' }), dataTable({ caption: 'Removed records', labels: A.labels, rows: r.removed, meta: [{ label: 'Baseline record', value: (x) => x.base.record }], cells: (x) => x.base.cells, detailsTitle: (x) => `Baseline record ${x.base.record}` }));
  if (c.tab === 'changed') {
    body.append(
      dataTable({
        caption: 'Field-level changes',
        labels: ['Key', 'Field', 'Baseline value', 'Updated value'],
        rows: r.fieldChanges,
        meta: [{ label: 'Baseline rec.', value: (x) => x.baseRecord }, { label: 'Updated rec.', value: (x) => x.updRecord }],
        cells: (x) => [keyText(x.key), r.mapping.fields[x.field].label, x.old, x.new],
        cellClass: (x, i) => (i === 2 ? 'old' : i === 3 ? 'new' : ''),
        emptyText: 'No changed records.',
      })
    );
  }
  if (c.tab === 'unchanged') body.append(dataTable({ caption: 'Unchanged records', labels: ['Key'], rows: r.unchanged, meta: [{ label: 'Baseline rec.', value: (x) => x.base.record }, { label: 'Updated rec.', value: (x) => x.upd.record }], cells: (x) => [keyText(x.key)], emptyText: 'No unchanged records.' }));
  if (c.tab === 'excluded') body.append(excludedTables(r, A, B));
  panel.append(body, h('p', { class: 'hint', text: 'Download these results from Export.' }));
  return panel;
}

function excludedTables(r, A, B) {
  const wrap = h('div');
  if (r.excludedBase.length) wrap.append(h('h3', { text: 'Excluded from Baseline' }), dataTable({ caption: 'Excluded Baseline records', labels: ['Reason', ...A.labels], rows: r.excludedBase, meta: [{ label: 'Record', value: (x) => x.row.record }], cells: (x) => [REASON[x.reason], ...x.row.cells], pageSize: 10 }));
  if (r.excludedUpd.length) wrap.append(h('h3', { text: 'Excluded from Updated' }), dataTable({ caption: 'Excluded Updated records', labels: ['Reason', ...B.labels], rows: r.excludedUpd, meta: [{ label: 'Record', value: (x) => x.row.record }], cells: (x) => [REASON[x.reason], ...x.row.cells], pageSize: 10 }));
  if (!wrap.childNodes.length) wrap.append(h('p', { class: 'muted', text: 'No excluded records.' }));
  return wrap;
}

function settingsLine(r, A, B) {
  const m = r.mapping;
  const keyDesc = m.keys.map((k) => `${A.labels[k.a]} = ${B.labels[k.b]}`).join(' + ');
  const keyNorm = m.keyTrim || m.keyCaseInsensitive ? [m.keyTrim && 'edge spaces ignored', m.keyCaseInsensitive && 'case ignored'].filter(Boolean).join(', ') : 'exact';
  return h('p', { class: 'settings-line', text: `Baseline: ${r.names.baseline} · Updated: ${r.names.updated} · Key: ${keyDesc} (${keyNorm}) · ${plural(m.fields.length, 'field')} compared` });
}

function stat(label, value, kind = '') {
  return h('li', { class: kind }, h('span', { class: 'stat-label', text: label }), h('span', { class: 'stat-value', text: typeof value === 'number' ? fmt(value) : value }));
}
