// Turns parsed records into a dataset with stable row/column IDs and reports
// structural problems. Nothing is repaired unless the caller passes an explicit decision.
import { QUOTE_ERROR_TEXT } from './csv-parse.js';

/**
 * opts: { hasHeader, skipBlankLines, removed:Set<recordNo>, padShort, expandWide }
 * Returns { empty, columns, rows, issues, log, blocking, expectedWidth, headerRecord, counts }.
 */
export function buildDataset(parsed, opts = {}) {
  const hasHeader = opts.hasHeader !== false;
  const removed = opts.removed || new Set();
  const log = [];
  const issues = [];
  const usable = [];

  for (const rec of parsed.records) {
    if (removed.has(rec.record)) {
      log.push({ action: 'removed-record', record: rec.record, line: rec.line, detail: 'Record removed by user during import.', content: rec.fields });
      continue;
    }
    if (rec.blank && opts.skipBlankLines) {
      log.push({ action: 'skipped-blank-line', record: rec.record, line: rec.line, detail: 'Blank line skipped.', content: [] });
      continue;
    }
    usable.push(rec);
  }

  if (!usable.length) {
    return { empty: true, columns: [], rows: [], issues, log, blocking: 0, expectedWidth: 0, headerRecord: null, counts: { dataRecords: 0 } };
  }

  const headerRec = hasHeader ? usable[0] : null;
  const dataRecs = hasHeader ? usable.slice(1) : usable;

  let baseWidth;
  if (headerRec) baseWidth = headerRec.fields.length;
  else {
    const freq = new Map();
    for (const r of dataRecs) freq.set(r.fields.length, (freq.get(r.fields.length) || 0) + 1);
    baseWidth = dataRecs[0].fields.length;
    let top = 0;
    for (const [w, c] of freq) if (c > top) [baseWidth, top] = [w, c];
  }
  let width = baseWidth;
  if (opts.expandWide) for (const r of usable) if (!r.errors && r.fields.length > width) width = r.fields.length;

  const quoteIssue = (rec) => ({
    type: 'malformed-quote',
    record: rec.record,
    line: rec.line,
    fieldCount: rec.fields.length,
    expected: width,
    detail: [...new Set(rec.errors.map((e) => QUOTE_ERROR_TEXT[e.code] || e.code))].join(' '),
  });

  if (headerRec && headerRec.errors) issues.push({ ...quoteIssue(headerRec), header: true });

  const columns = [];
  for (let i = 0; i < width; i++) {
    const header = headerRec && i < headerRec.fields.length ? headerRec.fields[i] : '';
    columns.push({ id: 'c' + i, index: i, header, added: i >= baseWidth });
  }
  if (width > baseWidth) {
    log.push({ action: 'expanded-columns', record: headerRec ? headerRec.record : 0, line: headerRec ? headerRec.line : 0, detail: `Columns expanded from ${baseWidth} to ${width} by user decision; other records gained empty trailing fields.`, content: [] });
  }

  const rows = [];
  for (const rec of dataRecs) {
    if (rec.errors) {
      issues.push(quoteIssue(rec));
      continue;
    }
    const len = rec.fields.length;
    let cells = rec.fields;
    if (len > width) {
      issues.push({ type: 'wide', record: rec.record, line: rec.line, fieldCount: len, expected: width, detail: `Has ${len} fields; expected ${width}.` });
      continue;
    }
    if (len < width) {
      if (len >= baseWidth && width > baseWidth) {
        cells = cells.concat(new Array(width - len).fill('')); // part of explicit column expansion
      } else if (opts.padShort) {
        cells = cells.concat(new Array(width - len).fill(''));
        log.push({ action: 'padded-record', record: rec.record, line: rec.line, detail: `Padded from ${len} to ${width} fields with empty trailing fields.`, content: rec.fields });
      } else {
        issues.push({ type: 'short', record: rec.record, line: rec.line, fieldCount: len, expected: width, detail: rec.blank ? 'Blank line kept as a record.' : `Has ${len} fields; expected ${width}.` });
        continue;
      }
    }
    rows.push({ id: 'r' + rec.record, record: rec.record, line: rec.line, cells });
  }

  return {
    empty: false,
    columns,
    rows,
    issues,
    log,
    blocking: issues.length,
    expectedWidth: width,
    headerRecord: headerRec ? headerRec.record : null,
    counts: { dataRecords: rows.length },
  };
}

/** Display labels: blank headers become "Column N"; duplicates get "(column N)". Export headers are untouched. */
export function displayLabels(headers) {
  const base = headers.map((h, i) => (h.trim() === '' ? `Column ${i + 1}` : h));
  const seen = new Map();
  for (const b of base) seen.set(b, (seen.get(b) || 0) + 1);
  return base.map((b, i) => (seen.get(b) > 1 ? `${b} (column ${i + 1})` : b));
}

/** Column order and names after optional header edits. Returns [{ id, index, header }]. */
export function outputColumns(columns, headerEdits) {
  const byId = new Map(columns.map((c) => [c.id, c]));
  const order = headerEdits && headerEdits.order && headerEdits.order.length === columns.length && headerEdits.order.every((id) => byId.has(id))
    ? headerEdits.order
    : columns.map((c) => c.id);
  const names = (headerEdits && headerEdits.names) || {};
  return order.map((id) => {
    const c = byId.get(id);
    return { id, index: c.index, header: Object.prototype.hasOwnProperty.call(names, id) ? names[id] : c.header };
  });
}
