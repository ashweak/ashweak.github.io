// Conservative matching engine. Pure: returns proposed allocations, never mutates state.
import { addDays } from './dates.js';
import { idx, live, saleBalances, receiptAvailability } from './calc.js';

export const REVIEW_TEXT = {
  UNKNOWN_SALE: 'Names a sale ID that is not in the workspace',
  MULTIPLE_RECEIPTS: 'Several unallocated receipts name the same sale; allocate them manually',
  ACCOUNT_CONFLICT: 'Receipt account differs from the account the sale expects',
  MISSING_ACCOUNT: 'The sale with this reference has no expected account, so it cannot be matched automatically',
  REFERENCE_CONFLICT: 'Sale ID and reference point to different sales',
  EARLIER_DATE: 'Receipt is dated before the sale',
  OUTSIDE_WINDOW: 'Receipt is dated after the automatic matching window',
  PREVIOUSLY_REVERSED: 'This match was reversed before; it will not be re-created automatically',
  REPEATED_REFERENCE: 'The same reference appears on more than one receipt in this account',
  MULTIPLE_SALES: 'More than one sale expects this reference',
  SALE_SETTLED: 'The matching sale has no remaining balance',
  AMOUNT_DIFFERS: 'Receipt amount differs from the remaining balance of the sale; allocate manually',
};
const refKey = (accountId, reference) => `${accountId}\u0000${reference}`;

/**
 * @returns {{ allocations: Array, review: Map<string,{code:string, saleIds:string[]}> }}
 * allocations: { receiptId, saleId, amount, method, reason } (no id/timestamps; the caller adds them).
 */
export function runMatching(state, { windowDays = 7 } = {}) {
  const { saleBySource } = idx(state);
  const bal = saleBalances(state); const avail = receiptAvailability(state);
  const remaining = new Map(); for (const [id, b] of bal) remaining.set(id, b.outstanding);
  const blocked = new Set(state.allocations.filter((a) => a.reversedAt).map((a) => `${a.receiptId}|${a.saleId}`));
  const refCount = new Map(); const salesByRef = new Map(); const linkCount = new Map();
  const candidates = [];
  for (const r of state.receipts) {
    if (!live(r)) continue;
    if (r.reference) refCount.set(refKey(r.accountId, r.reference), (refCount.get(refKey(r.accountId, r.reference)) || 0) + 1);
    if (r.unsupported || avail.get(r.id).allocated !== 0) continue;
    candidates.push(r);
    if (r.saleSourceId) linkCount.set(r.saleSourceId, (linkCount.get(r.saleSourceId) || 0) + 1);
  }
  for (const s of state.sales) {
    if (!live(s) || !s.expectedReference) continue;
    if (!salesByRef.has(s.expectedReference)) salesByRef.set(s.expectedReference, []);
    salesByRef.get(s.expectedReference).push(s);
  }
  candidates.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.sourceId < b.sourceId ? -1 : 1));

  const allocations = []; const review = new Map();
  const flag = (r, code, sales = []) => review.set(r.id, { code, saleIds: sales.map((s) => s.id) });
  const allocate = (r, s, method, reason) => { allocations.push({ receiptId: r.id, saleId: s.id, amount: r.gross, method, reason }); remaining.set(s.id, 0); };
  const repeated = (r) => r.reference && refCount.get(refKey(r.accountId, r.reference)) > 1;

  // Rule 1: the receipt explicitly names exactly one existing sale.
  for (const r of candidates) {
    if (!r.saleSourceId) continue;
    const s = saleBySource.get(r.saleSourceId);
    if (!s) { flag(r, 'UNKNOWN_SALE'); continue; }
    const others = r.reference ? (salesByRef.get(r.reference) || []).filter((x) => x.id !== s.id) : [];
    if (linkCount.get(r.saleSourceId) > 1) flag(r, 'MULTIPLE_RECEIPTS', [s]);
    else if (s.expectedAccount && s.expectedAccount !== r.accountId) flag(r, 'ACCOUNT_CONFLICT', [s]);
    else if ((s.expectedReference && r.reference && s.expectedReference !== r.reference) || others.length) flag(r, 'REFERENCE_CONFLICT', [s, ...others]);
    else if (repeated(r)) flag(r, 'REPEATED_REFERENCE', [s]);
    else if (r.date < s.date) flag(r, 'EARLIER_DATE', [s]);
    else if (blocked.has(`${r.id}|${s.id}`)) flag(r, 'PREVIOUSLY_REVERSED', [s]);
    else if (remaining.get(s.id) === 0) flag(r, 'SALE_SETTLED', [s]);
    else if (remaining.get(s.id) !== r.gross) flag(r, 'AMOUNT_DIFFERS', [s]);
    else allocate(r, s, 'AUTO_SALE_ID', `Receipt names sale ${s.sourceId}; amount equals remaining balance`);
  }
  // Rule 2: exact expected reference, same explicit account, date window, exact remaining amount.
  for (const r of candidates) {
    if (r.saleSourceId || !r.reference) continue;
    const all = salesByRef.get(r.reference) || [];
    if (all.length === 0) continue;
    const same = all.filter((s) => s.expectedAccount === r.accountId);
    if (same.length === 0) { flag(r, all.some((s) => !s.expectedAccount) ? 'MISSING_ACCOUNT' : 'ACCOUNT_CONFLICT', all); continue; }
    if (same.length > 1) { flag(r, 'MULTIPLE_SALES', same); continue; }
    const s = same[0];
    if (repeated(r)) flag(r, 'REPEATED_REFERENCE', [s]);
    else if (r.date < s.date) flag(r, 'EARLIER_DATE', [s]);
    else if (r.date > addDays(s.date, windowDays)) flag(r, 'OUTSIDE_WINDOW', [s]);
    else if (blocked.has(`${r.id}|${s.id}`)) flag(r, 'PREVIOUSLY_REVERSED', [s]);
    else if (remaining.get(s.id) === 0) flag(r, 'SALE_SETTLED', [s]);
    else if (remaining.get(s.id) !== r.gross) flag(r, 'AMOUNT_DIFFERS', [s]);
    else allocate(r, s, 'AUTO_REFERENCE', `Reference ${r.reference} in account ${r.accountId}; amount equals remaining balance; within ${windowDays}-day window`);
  }
  return { allocations, review };
}

/** Rule 3: suggestions only. Never allocated automatically. */
export function suggestSales(state, receiptId, { windowDays = 7, limit = 20 } = {}) {
  const { receiptsById, saleBySource } = idx(state);
  const r = receiptsById.get(receiptId); if (!live(r)) return [];
  const bal = saleBalances(state); const available = receiptAvailability(state).get(r.id).available;
  const out = new Map();
  const push = (s, why) => { if (s && live(s) && bal.get(s.id).outstanding > 0 && !out.has(s.id)) out.set(s.id, { sale: s, why, outstanding: bal.get(s.id).outstanding }); };
  if (r.saleSourceId) push(saleBySource.get(r.saleSourceId), 'Named by the receipt');
  if (r.reference) for (const s of state.sales) if (s.expectedReference === r.reference) push(s, 'Same reference');
  for (const s of state.sales) {
    if (out.size >= limit) break;
    if (live(s) && bal.get(s.id).outstanding === available && s.date <= r.date && r.date <= addDays(s.date, windowDays)) push(s, 'Same amount, close date (suggestion only)');
  }
  return [...out.values()];
}
