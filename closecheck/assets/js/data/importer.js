// CSV import: mapping, validation, duplicate detection, and a preview that commits nothing.
import { parseCsv } from '../domain/csv.js';
import { live } from '../domain/calc.js';
import { SALE_FIELDS, RECEIPT_FIELDS, normalizeSale, normalizeReceipt, sameValues, SALE_COMPARE, RECEIPT_COMPARE, receiptKey } from '../domain/validate.js';

export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_ROWS = 10000;
export const fieldsFor = (kind) => (kind === 'sales' ? SALE_FIELDS : RECEIPT_FIELDS);

export async function sha256Hex(bytes) {
  const buf = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
/** Strict UTF-8 decode (BOM allowed). Throws on invalid bytes instead of guessing an encoding. */
export function decodeUtf8(bytes) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new Error('The file is not valid UTF-8 text. Re-export it as "CSV UTF-8".'); }
}

export function suggestMapping(kind, headers) {
  const columns = {};
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const f of fieldsFor(kind)) columns[f.name] = headers.find((h) => norm(h) === norm(f.name)) || '';
  return { columns, dateFormat: 'ISO', numberFormat: 'plain', delimiter: ',', assumeLocal: false, fixedAccount: '', statusColumn: '', completedValues: '' };
}

/**
 * Build an import preview. Row statuses: valid | invalid | identical | conflict | excluded.
 * counts.total always equals the sum of the five statuses.
 */
export function buildPreview(kind, text, mapping, state, { filename, hash }) {
  const parsed = parseCsv(text, mapping.delimiter || ',');
  const fatal = [...parsed.errors];
  const fields = fieldsFor(kind);
  const col = {};
  for (const f of fields) {
    const header = mapping.columns[f.name] || '';
    if (header && !parsed.headers.includes(header)) fatal.push(`Mapped column "${header}" is not in the file`);
    col[f.name] = header ? parsed.headers.indexOf(header) : -1;
    const fixed = kind === 'receipts' && f.name === 'account_id' && mapping.fixedAccount;
    if (f.required && col[f.name] < 0 && !fixed) fatal.push(`Choose a column for "${f.label}"`);
  }
  const used = Object.values(mapping.columns).filter(Boolean);
  if (new Set(used).size !== used.length) fatal.push('The same column is mapped to more than one field');
  const statusIdx = mapping.statusColumn ? parsed.headers.indexOf(mapping.statusColumn) : -1;
  const completed = new Set(String(mapping.completedValues || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
  if (mapping.statusColumn && completed.size === 0) fatal.push('List the status values that mean a completed transaction');
  if (parsed.records.length > MAX_ROWS) fatal.push(`The file has ${parsed.records.length} data rows; the supported limit is ${MAX_ROWS}. Split it into smaller files.`);
  const dup = state.batches.find((b) => !b.removedAt && b.hash === hash && b.kind === kind);
  if (dup) fatal.push(`This exact file was already imported on ${dup.importedOn || dup.importedAt.slice(0, 10)} (${dup.filename}). Nothing was imported again.`);
  const base = { kind, filename, hash, mapping, headers: parsed.headers, rev: state.rev };
  if (fatal.length) return { ...base, fatal, rows: [], counts: { total: parsed.records.length, valid: 0, invalid: 0, identical: 0, conflict: 0, excluded: 0 }, coverage: null };

  const accounts = new Map(state.accounts.map((a) => [a.id, a]));
  const opts = { dateFormat: mapping.dateFormat, numberFormat: mapping.numberFormat, accounts, timeZone: state.settings.timezone, assumeLocal: !!mapping.assumeLocal };
  const existing = new Map();
  if (kind === 'sales') for (const s of state.sales) if (live(s)) existing.set(s.sourceId, s);
  if (kind === 'receipts') for (const r of state.receipts) if (live(r)) existing.set(receiptKey(r), r);
  const compare = kind === 'sales' ? SALE_COMPARE : RECEIPT_COMPARE;
  const keyOf = (rec) => (kind === 'sales' ? rec.sourceId : receiptKey(rec));
  const inFile = new Map();
  const rows = [];
  for (const { rowNumber, cells } of parsed.records) {
    const original = {};
    for (const f of fields) if (col[f.name] >= 0) original[f.name] = cells[col[f.name]] ?? '';
    if (kind === 'receipts' && col.account_id < 0) original.account_id = mapping.fixedAccount;
    const row = { rowNumber, original, status: 'valid', errors: [], record: null };
    rows.push(row);
    if (cells.length !== parsed.headers.length) { row.status = 'invalid'; row.code = 'INVALID_INPUT'; row.errors = [`Row has ${cells.length} columns but the header has ${parsed.headers.length}`]; continue; }
    if (statusIdx >= 0 && !completed.has(String(cells[statusIdx] ?? '').trim().toLowerCase())) { row.status = 'excluded'; row.errors = [`Status "${cells[statusIdx]}" is not a completed transaction`]; continue; }
    const n = kind === 'sales' ? normalizeSale(original, opts) : normalizeReceipt(original, opts);
    if (!n.ok) { row.status = 'invalid'; row.code = n.code || 'INVALID_INPUT'; row.errors = n.errors; continue; }
    row.record = n.record;
    const key = keyOf(n.record);
    const prior = existing.get(key);
    if (prior) {
      if (sameValues(prior, n.record, compare)) { row.status = 'identical'; row.errors = ['Already in the workspace with identical values; skipped']; }
      else { row.status = 'conflict'; row.errors = ['This ID already exists with different values; quarantined for correction']; }
      continue;
    }
    const first = inFile.get(key);
    if (first) {
      if (first.status === 'conflict' || !sameValues(first.record, n.record, compare)) {
        row.status = 'conflict'; row.errors = [`Same ID as row ${first.rowNumber} with different values; quarantined`];
        if (first.status === 'valid') { first.status = 'conflict'; first.errors = [`Same ID as row ${rowNumber} with different values; quarantined`]; }
      } else { row.status = 'identical'; row.errors = [`Repeats row ${first.rowNumber} exactly; skipped`]; }
      continue;
    }
    inFile.set(key, row);
  }
  const counts = { total: rows.length, valid: 0, invalid: 0, identical: 0, conflict: 0, excluded: 0 };
  let from = null; let to = null;
  for (const r of rows) {
    counts[r.status]++;
    if (r.status === 'valid') { const d = r.record.date; if (!from || d < from) from = d; if (!to || d > to) to = d; }
  }
  return { ...base, fatal: [], rows, counts, coverage: from ? { from, to } : null };
}
