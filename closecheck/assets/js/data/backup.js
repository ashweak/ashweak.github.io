// Versioned full-workspace JSON backup with validation before any restore.
import { STORES, SCHEMA_VERSION } from './repo.js';
import { sha256Hex } from './importer.js';
import { isCentavos } from '../domain/money.js';
import { isDateString, isValidTimeZone } from '../domain/dates.js';

export const BACKUP_FORMAT = 'closecheck-backup';
const canonical = (data) => JSON.stringify(STORES.map((s) => data[s] || []));
const digest = (data, settings) => sha256Hex(new TextEncoder().encode(canonical(data) + JSON.stringify(settings)));

export async function buildBackup(state, { appVersion, now }) {
  const data = Object.fromEntries(STORES.map((s) => [s, state[s]]));
  return {
    format: BACKUP_FORMAT, schemaVersion: SCHEMA_VERSION, appVersion, exportedAt: now,
    counts: Object.fromEntries(STORES.map((s) => [s, data[s].length])),
    settings: state.settings, data,
    // Detects accidental corruption only. It is not a signature and does not prove authenticity.
    integrity: { algorithm: 'SHA-256', value: await digest(data, state.settings) },
  };
}

/** Upgrade older backup schemas step by step. Index n upgrades schema n -> n+1. */
const BACKUP_MIGRATIONS = [];

/** Returns { ok, errors, data, settings, summary }. Never touches storage. */
export async function validateBackup(obj) {
  const errors = [];
  const fail = (m) => ({ ok: false, errors: [m] });
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return fail('This file is not a CloseCheck backup.');
  if (obj.format !== BACKUP_FORMAT) return fail('This file is not a CloseCheck backup.');
  if (!Number.isInteger(obj.schemaVersion) || obj.schemaVersion < 1) return fail('The backup has no valid schema version.');
  if (obj.schemaVersion > SCHEMA_VERSION) return fail(`This backup was made by a newer CloseCheck (schema ${obj.schemaVersion}); this app supports schema ${SCHEMA_VERSION}. Update the app, then restore.`);
  if (!obj.data || typeof obj.data !== 'object' || !obj.settings || typeof obj.settings !== 'object') return fail('The backup is incomplete.');
  for (const s of STORES) if (!Array.isArray(obj.data[s])) return fail(`The backup is missing the "${s}" section.`);
  if (obj.integrity?.value && (await digest(obj.data, obj.settings)) !== obj.integrity.value) return fail('The backup content does not match its checksum; the file is damaged or was edited.');
  let { data, settings } = obj;
  for (let v = obj.schemaVersion; v < SCHEMA_VERSION; v++) ({ data, settings } = BACKUP_MIGRATIONS[v - 1]({ data, settings }));

  for (const s of STORES) {
    if (obj.counts && obj.counts[s] !== obj.data[s].length) errors.push(`Section "${s}" has ${obj.data[s].length} records but the backup header says ${obj.counts[s]}.`);
    const ids = new Set();
    for (const r of data[s]) {
      if (!r || typeof r !== 'object' || typeof r.id !== 'string' || r.id === '') { errors.push(`Section "${s}" has a record without a valid id.`); break; }
      if (ids.has(r.id)) { errors.push(`Section "${s}" has duplicate id ${r.id}.`); break; }
      ids.add(r.id);
    }
  }
  if (settings.currency !== 'PHP') errors.push('Only PHP workspaces are supported.');
  if (!isValidTimeZone(settings.timezone)) errors.push('The backup has an invalid time zone.');
  if (errors.length) return { ok: false, errors };

  const money = (section, r, keys) => { for (const k of keys) if (!isCentavos(r[k])) errors.push(`${section} ${r.id}: "${k}" is not a valid amount.`); };
  const date = (section, r, k) => { if (!isDateString(r[k])) errors.push(`${section} ${r.id}: "${k}" is not a valid date.`); };
  const accounts = new Set(data.accounts.map((a) => a.id));
  const sales = new Map(data.sales.map((s) => [s.id, s])); const receipts = new Map(data.receipts.map((r) => [r.id, r]));
  for (const s of data.sales) { money('Sale', s, ['totalDue']); date('Sale', s, 'date'); if (!(s.totalDue > 0)) errors.push(`Sale ${s.id}: total due must be positive.`); }
  for (const r of data.receipts) {
    money('Receipt', r, ['gross', 'fee', 'net']); date('Receipt', r, 'date');
    if (r.net !== r.gross - r.fee) errors.push(`Receipt ${r.id}: net does not equal gross minus fee.`);
    if (!accounts.has(r.accountId)) errors.push(`Receipt ${r.id}: unknown account.`);
  }
  const perReceipt = new Map(); const perSale = new Map(); const credit = new Map(); const refund = new Map();
  const bump = (m, k, v) => m.set(k, (m.get(k) || 0) + v);
  for (const a of data.allocations) {
    money('Allocation', a, ['amount']);
    if (!receipts.has(a.receiptId) || !sales.has(a.saleId)) { errors.push(`Allocation ${a.id}: refers to a missing sale or receipt.`); continue; }
    if (!a.reversedAt && !receipts.get(a.receiptId).voidedAt && !sales.get(a.saleId).voidedAt) { bump(perReceipt, a.receiptId, a.amount); bump(perSale, a.saleId, a.amount); }
  }
  for (const c of data.credits) { money('Credit', c, ['amount']); date('Credit', c, 'date'); if (!sales.has(c.saleId)) errors.push(`Credit ${c.id}: missing sale.`); else if (!c.reversedAt) bump(credit, c.saleId, c.amount); }
  for (const r of data.refunds) { money('Refund', r, ['amount']); date('Refund', r, 'date'); if (!sales.has(r.saleId)) errors.push(`Refund ${r.id}: missing sale.`); else if (!r.reversedAt) bump(refund, r.saleId, r.amount); if (!accounts.has(r.accountId)) errors.push(`Refund ${r.id}: unknown account.`); }
  for (const m of data.cashMovements) { money('Cash movement', m, ['amount']); date('Cash movement', m, 'date'); if (!accounts.has(m.accountId)) errors.push(`Cash movement ${m.id}: unknown account.`); }
  for (const c of data.cashCloses) { date('Cash close', c, 'date'); for (const k of ['opening', 'counted']) if (c[k] !== null && !isCentavos(c[k])) errors.push(`Cash close ${c.id}: "${k}" is not a valid amount.`); }
  for (const [id, v] of perReceipt) if (v > receipts.get(id).gross) errors.push(`Receipt ${id}: allocations exceed its gross amount.`);
  for (const [id, s] of sales) {
    if ((credit.get(id) || 0) > s.totalDue) errors.push(`Sale ${id}: credits exceed the amount due.`);
    if ((refund.get(id) || 0) > (perSale.get(id) || 0)) errors.push(`Sale ${id}: refunds exceed allocated receipts.`);
  }
  if (errors.length) return { ok: false, errors: errors.slice(0, 20) };
  return {
    ok: true, errors: [], data, settings,
    summary: { exportedAt: obj.exportedAt, appVersion: obj.appVersion, schemaVersion: obj.schemaVersion, businessName: settings.businessName, counts: Object.fromEntries(STORES.map((s) => [s, data[s].length])) },
  };
}
