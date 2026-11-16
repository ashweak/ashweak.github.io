// Cleaning recipe. A recipe is always applied to the immutable source dataset, so
// re-applying it can never compound a change. Rules run in one fixed, displayed order.
import { parseDate, formatDate, canonicalDecimal, numberFormat, DATE_FORMATS } from './validate.js';

export const RECIPE_VERSION = 1;

export const RULE_ORDER = Object.freeze([
  { id: 'trim', label: 'Trim surrounding spaces' },
  { id: 'collapse', label: 'Collapse repeated spaces' },
  { id: 'case', label: 'Uppercase / lowercase' },
  { id: 'replace', label: 'Exact value replacement' },
  { id: 'dateOut', label: 'Date output formatting' },
  { id: 'required', label: 'Missing-value check' },
  { id: 'numeric', label: 'Numeric-format check' },
  { id: 'dateCheck', label: 'Date-format check' },
  { id: 'removeEmpty', label: 'Remove fully empty records' },
]);

/** Every rule starts off, with no columns preselected. */
export function defaultRecipe() {
  return {
    version: RECIPE_VERSION,
    trim: { on: false, cols: [] },
    collapse: { on: false, cols: [] },
    case: { on: false, cols: [], mode: 'upper' },
    replace: { on: false, cols: [], pairs: [], caseSensitive: true, ignoreEdgeSpaces: false },
    dateOut: { on: false, cols: [], source: DATE_FORMATS[0], output: DATE_FORMATS[0] },
    required: { on: false, cols: [] },
    numeric: { on: false, cols: [], format: 'dot' },
    dateCheck: { on: false, cols: [], source: DATE_FORMATS[0] },
    removeEmpty: { on: false, whitespaceIsEmpty: false },
    headerEdits: { names: {}, order: [] },
  };
}

export function recipeIsEmpty(r) {
  return (
    !RULE_ORDER.some((rule) => r[rule.id].on) &&
    Object.keys(r.headerEdits.names).length === 0 &&
    r.headerEdits.order.length === 0
  );
}

const trimEdges = (s) => s.replace(/^[ \t]+|[ \t]+$/g, '');

/**
 * dataset: { columns:[{id,index}], rows:[{id,record,line,cells}] }
 * Returns { rows, excluded, changes, issues, counts }.
 * Source rows are never mutated; unchanged rows share their source cell arrays.
 */
export function applyRecipe(dataset, recipe, onProgress) {
  const colIndex = new Map(dataset.columns.map((c) => [c.id, c.index]));
  const mask = (rule) => {
    const set = new Set();
    if (rule.on) for (const id of rule.cols) if (colIndex.has(id)) set.add(colIndex.get(id));
    return set;
  };
  const m = {
    trim: mask(recipe.trim),
    collapse: mask(recipe.collapse),
    case: mask(recipe.case),
    replace: mask(recipe.replace),
    dateOut: mask(recipe.dateOut),
    required: mask(recipe.required),
    numeric: mask(recipe.numeric),
    dateCheck: mask(recipe.dateCheck),
  };
  const transformCols = new Set([...m.trim, ...m.collapse, ...m.case, ...m.replace, ...m.dateOut]);
  const checkCols = new Set([...m.required, ...m.numeric, ...m.dateCheck, ...m.dateOut]);

  const rp = recipe.replace;
  const normFind = (s) => {
    let v = rp.ignoreEdgeSpaces ? s.trim() : s;
    if (!rp.caseSensitive) v = v.toLowerCase();
    return v;
  };
  const replaceMap = new Map();
  if (rp.on) for (const p of rp.pairs) if (!replaceMap.has(normFind(p.find))) replaceMap.set(normFind(p.find), p.replace);
  const numFmt = numberFormat(recipe.numeric.format);

  const rows = [];
  const excluded = [];
  const changes = [];
  const issues = [];
  let changedCells = 0;
  let affectedRows = 0;
  const total = dataset.rows.length;

  for (let r = 0; r < total; r++) {
    const src = dataset.rows[r];
    let cells = src.cells;
    let rowChanged = false;
    for (const ci of transformCols) {
      const original = src.cells[ci];
      let v = original;
      const step = (rule, next) => {
        if (next !== v) {
          changes.push({ rowId: src.id, record: src.record, col: ci, rule, old: v, new: next });
          v = next;
        }
      };
      if (m.trim.has(ci)) step('trim', trimEdges(v));
      if (m.collapse.has(ci)) step('collapse', v.replace(/ {2,}/g, ' '));
      if (m.case.has(ci)) step('case', recipe.case.mode === 'lower' ? v.toLowerCase() : v.toUpperCase());
      if (m.replace.has(ci) && replaceMap.size) {
        const key = normFind(v);
        if (replaceMap.has(key)) step('replace', replaceMap.get(key));
      }
      if (m.dateOut.has(ci) && v !== '') {
        const d = parseDate(v, recipe.dateOut.source);
        if (d) step('dateOut', formatDate(d, recipe.dateOut.output));
      }
      if (v !== original) {
        if (cells === src.cells) cells = src.cells.slice();
        cells[ci] = v;
        changedCells++;
        rowChanged = true;
      }
    }
    if (rowChanged) affectedRows++;

    if (recipe.removeEmpty.on) {
      const isEmpty = recipe.removeEmpty.whitespaceIsEmpty ? cells.every((c) => /^\s*$/.test(c)) : cells.every((c) => c === '');
      if (isEmpty) {
        excluded.push({ rowId: src.id, record: src.record, line: src.line, cells, reason: 'empty-record' });
        continue;
      }
    }

    for (const ci of checkCols) {
      const v = cells[ci];
      const add = (rule, message) => issues.push({ rowId: src.id, record: src.record, col: ci, rule, value: v, message });
      if (v === '') {
        if (m.required.has(ci)) add('required', 'Required value is blank.');
        continue;
      }
      if (m.numeric.has(ci) && canonicalDecimal(v, numFmt) === null) add('numeric', `Not a number in the format ${numFmt.label.split(' (')[0]}.`);
      if (m.dateCheck.has(ci) && !parseDate(v, recipe.dateCheck.source)) add('dateCheck', `Not a valid ${recipe.dateCheck.source} date.`);
      if (m.dateOut.has(ci) && !parseDate(src.cells[ci] === v ? v : v, recipe.dateOut.output) && !parseDate(v, recipe.dateOut.source)) {
        add('dateOut', `Not a valid ${recipe.dateOut.source} date; left unchanged.`);
      }
    }

    rows.push(cells === src.cells ? src : { id: src.id, record: src.record, line: src.line, cells });
    if (onProgress && r % 2000 === 0) onProgress(r / total);
  }

  return {
    rows,
    excluded,
    changes,
    issues,
    counts: { changedCells, affectedRows, excludedRows: excluded.length, issues: issues.length, issueRows: new Set(issues.map((i) => i.rowId)).size },
  };
}
