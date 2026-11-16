// CSV writer: UTF-8 (optional BOM), chosen delimiter, CRLF, standard quoting.
// Spreadsheet-safe mode prefixes an apostrophe to formula-like text; quoting alone
// does not stop spreadsheet programs from evaluating formulas.

// Leading characters spreadsheet programs may treat as a formula start, including
// full-width variants. Leading whitespace/control characters before them are also risky.
const FORMULA_START = /^[\u0000-  　]*[=+\-@＝＋－＠]/;
const CONTROL_START = /^[\t\r\n]/;

export function isFormulaLike(v) {
  return v !== '' && (FORMULA_START.test(v) || CONTROL_START.test(v));
}

const PLAIN_NUMBER = /^[+-]?\d+(?:[.,]\d+)?$/;

/**
 * Returns the protected value (with leading apostrophe) when `safe` and formula-like.
 * `allowPlainNumbers` leaves values such as -12.50 or +639171234567 unprotected:
 * they cannot run a formula, but a spreadsheet may reinterpret them as numbers.
 */
export function protectCell(v, safe, allowPlainNumbers = false) {
  if (!safe || !isFormulaLike(v)) return v;
  if (allowPlainNumbers && PLAIN_NUMBER.test(v)) return v;
  return "'" + v;
}

export function quoteField(v, delimiter) {
  if (v === '') return '';
  if (v.includes('"') || v.includes(delimiter) || v.includes('\n') || v.includes('\r')) {
    return '"' + v.replace(/"/g, '""') + '"';
  }
  return v;
}

/**
 * header: string[] | null; rows: string[][]
 * opts: { delimiter=',', bom=true, safe=true, allowPlainNumbers=false }
 * Returns { text, protectedCount, protectedCells:[{row, col, value}] (first 500) }.
 * `row` in protectedCells is 0-based within `rows` (header reported as -1).
 */
export function writeCsv(header, rows, opts = {}) {
  const delimiter = opts.delimiter ?? ',';
  const safe = opts.safe !== false;
  const bom = opts.bom !== false;
  const allowPlain = !!opts.allowPlainNumbers;
  const out = [];
  let protectedCount = 0;
  const protectedCells = [];
  const line = (cells, r) => {
    const parts = new Array(cells.length);
    for (let c = 0; c < cells.length; c++) {
      const v = cells[c] ?? '';
      const p = protectCell(v, safe, allowPlain);
      if (p !== v) {
        protectedCount++;
        if (protectedCells.length < 500) protectedCells.push({ row: r, col: c, value: v });
      }
      parts[c] = quoteField(p, delimiter);
    }
    // A single empty field must still produce a record that re-parses as one empty field.
    if (cells.length === 1 && parts[0] === '') return '""';
    return parts.join(delimiter);
  };
  if (header) out.push(line(header, -1));
  for (let r = 0; r < rows.length; r++) out.push(line(rows[r], r));
  const body = out.length ? out.join('\r\n') + '\r\n' : '';
  return { text: (bom ? '﻿' : '') + body, protectedCount, protectedCells };
}

/** "Products 2026.csv" + "cleaned" -> "Products_2026_cleaned.csv". Never reuses the original name. */
export function safeFilename(name, suffix) {
  let base = String(name || 'sheetfix').replace(/\.[^.]*$/, '');
  base = base.normalize('NFKC').replace(/[^\p{L}\p{N}._-]+/gu, '_').replace(/^[._]+|_+$/g, '');
  if (!base) base = 'sheetfix';
  if (base.length > 80) base = base.slice(0, 80);
  return `${base}_${suffix}.csv`;
}
