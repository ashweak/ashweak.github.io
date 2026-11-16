// Builds the tables behind each downloadable output. Returns { header, rows, note }.
import { outputColumns } from '../core/dataset.js';
import { RULE_ORDER } from '../core/recipe.js';
import { keyText } from '../core/compare.js';
import { state, mainDataset, committedRecipe, workingView, duplicateResolution, labels as labelsOf } from './state.js';

const ruleName = (id) => (RULE_ORDER.find((r) => r.id === id) || { label: id }).label;

function dataHeader() {
  const ds = mainDataset();
  const recipe = committedRecipe();
  const cols = outputColumns(ds.columns, recipe.headerEdits);
  const hadHeader = state.files.main.settings.hasHeader;
  const edited = recipe.headerEdits.names;
  return {
    cols,
    names: cols.map((c) => (hadHeader || Object.prototype.hasOwnProperty.call(edited, c.id) ? c.header : `Column ${c.index + 1}`)),
  };
}

const project = (cols, cells) => cols.map((c) => cells[c.index] ?? '');

export function availableOutputs() {
  const out = [];
  if (mainDataset()) {
    const res = duplicateResolution();
    out.push({ id: 'cleaned', label: 'Cleaned file', suffix: 'cleaned', data: true, desc: 'The working copy with applied cleaning rules (all rows).' });
    out.push({ id: 'deduped', label: 'Duplicate result (retained rows)', suffix: 'deduplicated', data: true, disabled: !res, desc: res ? 'Cleaned rows minus confirmed duplicate exclusions, in original order.' : 'Confirm duplicate decisions first.' });
    out.push({ id: 'excluded', label: 'Excluded records', suffix: 'excluded', desc: 'Rows removed during import, by cleaning, or by duplicate review, with the reason.' });
    out.push({ id: 'changelog', label: 'Change log', suffix: 'change_log', desc: 'Every cell change and row exclusion with old and new text. May contain sensitive data.' });
    out.push({ id: 'issues', label: 'Issue report', suffix: 'issues', desc: 'Structural import decisions and flagged values from validation checks.' });
  }
  const cr = state.compare && state.compare.result && state.compare.acknowledged ? state.compare.result : null;
  if (cr) {
    out.push({ id: 'cmp-summary', label: 'Comparison summary', suffix: 'comparison_summary', desc: 'Settings, mapping and counts, including exclusions.', compare: true });
    out.push({ id: 'cmp-results', label: 'Comparison results by record', suffix: 'comparison_results', desc: 'One row per record with its status (Added, Removed, Changed, Unchanged, Excluded).', compare: true });
    out.push({ id: 'cmp-fields', label: 'Field-level changes', suffix: 'field_changes', desc: 'Every changed field with Baseline and Updated values.', compare: true });
  }
  return out;
}

export function buildOutput(id) {
  if (id === 'cleaned' || id === 'deduped') {
    const { cols, names } = dataHeader();
    const rows = id === 'cleaned' ? workingView().rows : duplicateResolution().retained;
    return { header: names, rows: rows.map((r) => project(cols, r.cells)), dataRows: rows.length };
  }
  if (id === 'excluded') {
    const ds = mainDataset();
    const { cols, names } = dataHeader();
    const items = [];
    for (const l of ds.log) if (l.action === 'removed-record') items.push([String(l.record), 'Removed during import (structural problem)', ...l.content]);
    const view = state.clean && state.clean.view;
    if (view) for (const e of view.excluded) items.push([String(e.record), 'Fully empty record (cleaning rule)', ...project(cols, e.cells)]);
    const res = duplicateResolution();
    if (res) for (const e of res.excluded) items.push([String(e.row.record), `Duplicate of key ${keyText(e.groupKey)} (${e.reason.replace(/-/g, ' ')})`, ...project(cols, e.row.cells)]);
    items.sort((a, b) => Number(a[0]) - Number(b[0]));
    return { header: ['Source record', 'Reason', ...names], rows: items, dataRows: items.length };
  }
  if (id === 'changelog') {
    const ds = mainDataset();
    const labels = labelsOf(ds);
    const rows = [];
    for (const l of ds.log) rows.push(['Import', l.action.replace(/-/g, ' '), String(l.record), String(l.line), '', '', '', l.detail]);
    const view = state.clean && state.clean.view;
    if (view) {
      for (const ch of view.changes) rows.push(['Clean', ruleName(ch.rule), String(ch.record), '', labels[ch.col], ch.old, ch.new, `Column ${ch.col + 1}`]);
      for (const e of view.excluded) rows.push(['Clean', 'Remove fully empty records', String(e.record), String(e.line), '', '', '', 'Record removed']);
    }
    const recipe = committedRecipe();
    for (const [id, name] of Object.entries(recipe.headerEdits.names)) rows.push(['Clean', 'Header editing', '', '', labels[Number(id.slice(1))], ds.columns[Number(id.slice(1))].header, name, 'Header renamed']);
    if (recipe.headerEdits.order.length) rows.push(['Clean', 'Header editing', '', '', '', '', '', 'Output columns reordered']);
    const res = duplicateResolution();
    if (res) for (const e of res.excluded) rows.push(['Duplicates', e.reason.replace(/-/g, ' '), String(e.row.record), '', '', '', '', `Excluded; key ${keyText(e.groupKey)}`]);
    return { header: ['Stage', 'Rule', 'Source record', 'Line', 'Column', 'Old value', 'New value', 'Reason'], rows, dataRows: rows.length };
  }
  if (id === 'issues') {
    const ds = mainDataset();
    const labels = labelsOf(ds);
    const rows = [];
    for (const l of ds.log) rows.push(['Import decision', String(l.record), String(l.line), '', '', l.detail]);
    const view = state.clean && state.clean.view;
    if (view) for (const i of view.issues) rows.push([ruleName(i.rule), String(i.record), '', labels[i.col], i.value, i.message]);
    return { header: ['Type', 'Source record', 'Line', 'Column', 'Value', 'Message'], rows, dataRows: rows.length };
  }
  const r = state.compare.result;
  const A = r.names;
  if (id === 'cmp-summary') {
    const k = r.counts;
    const m = r.mapping;
    const rows = [
      ['Baseline file', A.baseline],
      ['Updated file', A.updated],
      ['Key mapping', m.keys.map((x) => `Baseline column ${x.a + 1} = Updated column ${x.b + 1}`).join(' + ')],
      ['Key matching', m.keyTrim || m.keyCaseInsensitive ? [m.keyTrim && 'edge spaces ignored', m.keyCaseInsensitive && 'case ignored'].filter(Boolean).join(', ') : 'exact'],
      ...m.fields.map((f) => [`Compared field: ${f.label}`, `Baseline column ${f.a + 1} vs Updated column ${f.b + 1}; ${[f.trim && 'edge spaces ignored', f.caseInsensitive && 'case ignored', f.numeric && `numeric equivalence (${f.numeric})`].filter(Boolean).join(', ') || 'exact'}`]),
      ['Baseline records', String(k.baseline)],
      ['Updated records', String(k.updated)],
      ['Added', String(k.added)],
      ['Removed', String(k.removed)],
      ['Changed', String(k.changed)],
      ['Unchanged in selected fields', String(k.unchanged)],
      ['Excluded from Baseline', String(k.excludedBaseline)],
      ['Excluded from Updated', String(k.excludedUpdated)],
      ['Field-level changes', String(k.fieldChanges)],
      ...m.fields.map((f, i) => [`Changes in ${f.label}`, String(r.fieldChangeCounts[i])]),
      ['Baseline count check', k.baselineBalanced ? 'balanced' : 'NOT balanced'],
      ['Updated count check', k.updatedBalanced ? 'balanced' : 'NOT balanced'],
    ];
    return { header: ['Item', 'Value'], rows, dataRows: rows.length };
  }
  if (id === 'cmp-results') {
    const rows = [];
    for (const x of r.added) rows.push(['Added', keyText(x.key), '', String(x.upd.record), '0', '']);
    for (const x of r.changed) rows.push(['Changed', keyText(x.key), String(x.base.record), String(x.upd.record), String(x.diffs.length), x.diffs.map((d) => r.mapping.fields[d.field].label).join('; ')]);
    for (const x of r.unchanged) rows.push(['Unchanged', keyText(x.key), String(x.base.record), String(x.upd.record), '0', '']);
    for (const x of r.removed) rows.push(['Removed', keyText(x.key), String(x.base.record), '', '0', '']);
    for (const x of r.excludedBase) rows.push(['Excluded (Baseline)', '', String(x.row.record), '', '', x.reason.replace(/-/g, ' ')]);
    for (const x of r.excludedUpd) rows.push(['Excluded (Updated)', '', '', String(x.row.record), '', x.reason.replace(/-/g, ' ')]);
    return { header: ['Status', 'Key', 'Baseline record', 'Updated record', 'Changed fields', 'Detail'], rows, dataRows: rows.length };
  }
  if (id === 'cmp-fields') {
    const rows = r.fieldChanges.map((x) => [keyText(x.key), String(x.baseRecord), String(x.updRecord), r.mapping.fields[x.field].label, x.old, x.new]);
    return { header: ['Key', 'Baseline record', 'Updated record', 'Field', 'Baseline value', 'Updated value'], rows, dataRows: rows.length };
  }
  throw new Error('Unknown output');
}

export function outputBaseName(o) {
  if (o.compare) return state.compare.result.names.updated.replace(/ \(working copy\)$/, '');
  return state.files.main.name;
}
