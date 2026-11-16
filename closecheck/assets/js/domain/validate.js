// Normalizes raw text fields (from CSV rows or manual forms) into validated records.
import { parseAmount } from './money.js';
import { parseDate, parseTimestamp } from './dates.js';

export const SALE_FIELDS = [
  { name: 'sale_id', required: true, label: 'Sale ID' },
  { name: 'sale_date', required: true, label: 'Sale date' },
  { name: 'total_due', required: true, label: 'Total due' },
  { name: 'expected_account', label: 'Expected account' },
  { name: 'expected_reference', label: 'Expected reference' },
  { name: 'customer_label', label: 'Customer label' },
  { name: 'due_date', label: 'Due date' },
  { name: 'claimed_payment_status', label: 'Claimed payment status' },
  { name: 'notes', label: 'Notes' },
];
export const RECEIPT_FIELDS = [
  { name: 'receipt_id', required: true, label: 'Receipt ID' },
  { name: 'received_at', required: true, label: 'Received at' },
  { name: 'amount', required: true, label: 'Amount (gross)' },
  { name: 'account_id', required: true, label: 'Account ID' },
  { name: 'reference', label: 'Reference' },
  { name: 'sale_id', label: 'Sale ID' },
  { name: 'fee', label: 'Fee' },
  { name: 'net_amount', label: 'Net amount' },
  { name: 'notes', label: 'Notes' },
];
export const CLAIMED = ['PAID', 'PARTIAL', 'UNPAID'];
export const ACCOUNT_TYPES = ['CASH', 'EWALLET', 'BANK'];
const MAX_ID = 100; const MAX_TEXT = 1000;

const text = (v) => String(v ?? '').trim();
function idField(errors, label, v, required) {
  const s = text(v);
  if (s === '') { if (required) errors.push(`${label} is required`); return ''; }
  if (s.length > MAX_ID) errors.push(`${label} is longer than ${MAX_ID} characters`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(s)) errors.push(`${label} contains control characters`);
  return s;
}
function freeText(errors, label, v) {
  const s = text(v);
  if (s.length > MAX_TEXT) errors.push(`${label} is longer than ${MAX_TEXT} characters`);
  return s;
}

/** opts: { dateFormat, numberFormat, accounts: Map(id -> account) } */
export function normalizeSale(raw, opts) {
  const errors = [];
  const sourceId = idField(errors, 'Sale ID', raw.sale_id, true);
  let date = null;
  const d = parseDate(raw.sale_date, opts.dateFormat);
  if (d.ok) date = d.date; else errors.push(`Sale date: ${d.error}`);
  let totalDue = null;
  const a = parseAmount(raw.total_due, opts.numberFormat);
  if (!a.ok) errors.push(`Total due: ${a.error}`);
  else if (a.value === 0) errors.push('Total due must be greater than zero');
  else totalDue = a.value;
  const expectedAccount = idField(errors, 'Expected account', raw.expected_account, false);
  if (expectedAccount && !opts.accounts.has(expectedAccount)) errors.push(`Expected account "${expectedAccount}" is not a configured account`);
  const expectedReference = idField(errors, 'Expected reference', raw.expected_reference, false);
  const customerLabel = idField(errors, 'Customer label', raw.customer_label, false);
  let dueDate = '';
  if (text(raw.due_date) !== '') {
    const dd = parseDate(raw.due_date, opts.dateFormat);
    if (dd.ok) dueDate = dd.date; else errors.push(`Due date: ${dd.error}`);
  }
  const claimedStatus = text(raw.claimed_payment_status).toUpperCase();
  if (claimedStatus && !CLAIMED.includes(claimedStatus)) errors.push('Claimed payment status must be PAID, PARTIAL, UNPAID, or blank');
  const notes = freeText(errors, 'Notes', raw.notes);
  if (errors.length) return { ok: false, errors };
  return { ok: true, record: { sourceId, date, totalDue, expectedAccount, expectedReference, customerLabel, dueDate, claimedStatus, notes } };
}

/** opts: { dateFormat, numberFormat, accounts, timeZone, assumeLocal } */
export function normalizeReceipt(raw, opts) {
  const errors = []; let code = 'INVALID_INPUT';
  const sourceId = idField(errors, 'Receipt ID', raw.receipt_id, true);
  let date = null; let receivedAt = null;
  const t = parseTimestamp(raw.received_at, opts.dateFormat, { timeZone: opts.timeZone, assumeLocal: opts.assumeLocal });
  if (t.ok) { date = t.date; receivedAt = t.at; } else errors.push(`Received at: ${t.error}`);
  let gross = null;
  const a = parseAmount(raw.amount, opts.numberFormat);
  if (!a.ok) errors.push(`Amount: ${a.error}`);
  else if (a.value === 0) errors.push('Amount must be greater than zero');
  else gross = a.value;
  const accountId = idField(errors, 'Account ID', raw.account_id, true);
  const account = opts.accounts.get(accountId);
  if (accountId && !account) errors.push(`Account "${accountId}" is not a configured account`);
  else if (account && !account.active) errors.push(`Account "${accountId}" is inactive`);
  let fee = 0;
  if (text(raw.fee) !== '') {
    const f = parseAmount(raw.fee, opts.numberFormat);
    if (!f.ok) errors.push(`Fee: ${f.error}`); else fee = f.value;
  }
  if (gross !== null && fee > gross) errors.push('Fee is larger than the gross amount');
  if (account && account.type === 'CASH' && fee !== 0) errors.push('Cash receipts cannot have a fee');
  if (text(raw.net_amount) !== '') {
    const n = parseAmount(raw.net_amount, opts.numberFormat);
    if (!n.ok) errors.push(`Net amount: ${n.error}`);
    else if (gross !== null && fee <= gross && n.value !== gross - fee) {
      code = 'UNSUPPORTED_SETTLEMENT';
      errors.push('Net amount does not equal amount minus fee. Combined or net settlements are not supported; enter individual customer receipts');
    }
  }
  const reference = idField(errors, 'Reference', raw.reference, false);
  const saleSourceId = idField(errors, 'Sale ID', raw.sale_id, false);
  const notes = freeText(errors, 'Notes', raw.notes);
  if (errors.length) return { ok: false, errors, code };
  return { ok: true, record: { sourceId, date, receivedAt, gross, fee, net: gross - fee, accountId, reference, saleSourceId, notes } };
}

export const SALE_COMPARE = ['date', 'totalDue', 'expectedAccount', 'expectedReference', 'customerLabel', 'dueDate', 'claimedStatus', 'notes'];
export const RECEIPT_COMPARE = ['receivedAt', 'date', 'gross', 'fee', 'accountId', 'reference', 'saleSourceId', 'notes'];
export const sameValues = (a, b, keys) => keys.every((k) => a[k] === b[k]);
export const receiptKey = (r) => `${r.accountId}\u0000${r.sourceId}`;
