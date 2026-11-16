// Pure balance and report calculations. All amounts are integer centavos.
import { add } from './money.js';
import { addDays } from './dates.js';

const cache = new WeakMap();
/** Memoize a derived value per immutable state object. */
export function memo(state, key, fn) {
  let m = cache.get(state);
  if (!m) { m = new Map(); cache.set(state, m); }
  if (!m.has(key)) m.set(key, fn());
  return m.get(key);
}
export const live = (x) => !!x && !x.voidedAt;
export function idx(state) {
  return memo(state, 'idx', () => ({
    salesById: new Map(state.sales.map((s) => [s.id, s])),
    receiptsById: new Map(state.receipts.map((r) => [r.id, r])),
    accountsById: new Map(state.accounts.map((a) => [a.id, a])),
    saleBySource: new Map(state.sales.filter(live).map((s) => [s.sourceId, s])),
  }));
}
const bump = (map, k, v) => map.set(k, add(map.get(k) || 0, v));

/** Allocations that count: not reversed, both sides live, receipt dated on/before the cutoff. */
export function activeAllocations(state, cutoff = null) {
  return memo(state, `alloc:${cutoff}`, () => {
    const { salesById, receiptsById } = idx(state);
    return state.allocations.filter((a) => {
      if (a.reversedAt) return false;
      const r = receiptsById.get(a.receiptId);
      return live(r) && live(salesById.get(a.saleId)) && (!cutoff || r.date <= cutoff);
    });
  });
}

/** Map saleId -> balance figures for every live sale, as of an optional cutoff date. */
export function saleBalances(state, cutoff = null) {
  return memo(state, `bal:${cutoff}`, () => {
    const allocated = new Map(); const credited = new Map(); const refunded = new Map();
    for (const a of activeAllocations(state, cutoff)) bump(allocated, a.saleId, a.amount);
    for (const c of state.credits) if (!c.reversedAt && (!cutoff || c.date <= cutoff)) bump(credited, c.saleId, c.amount);
    for (const r of state.refunds) if (!r.reversedAt && (!cutoff || r.date <= cutoff)) bump(refunded, r.saleId, r.amount);
    const out = new Map();
    for (const s of state.sales) {
      if (!live(s)) continue;
      const credit = credited.get(s.id) || 0; const alloc = allocated.get(s.id) || 0; const refund = refunded.get(s.id) || 0;
      const netDue = s.totalDue - credit; const netAllocated = alloc - refund;
      const diff = netDue - netAllocated;
      const outstanding = Math.max(diff, 0); const liability = Math.max(-diff, 0);
      const status = liability > 0 ? 'REFUND_DUE' : outstanding === 0 ? 'SETTLED' : netAllocated <= 0 ? 'UNPAID' : 'PARTIAL';
      out.set(s.id, { originalDue: s.totalDue, credit, allocated: alloc, refunded: refund, netDue, netAllocated, outstanding, liability, status });
    }
    return out;
  });
}

/** Map receiptId -> { allocated, available } for every live receipt. */
export function receiptAvailability(state) {
  return memo(state, 'avail', () => {
    const allocated = new Map();
    for (const a of activeAllocations(state)) bump(allocated, a.receiptId, a.amount);
    const out = new Map();
    for (const r of state.receipts) {
      if (!live(r)) continue;
      const al = allocated.get(r.id) || 0;
      out.set(r.id, { allocated: al, available: r.gross - al });
    }
    return out;
  });
}

const inRange = (d, from, to) => d >= from && d <= to;

/** Sales dated in the period, with payments effective through the cutoff. */
export function salesCohort(state, { from, to }, cutoff = to) {
  const bal = saleBalances(state, cutoff);
  const rows = state.sales.filter((s) => live(s) && inRange(s.date, from, to)).map((s) => ({ sale: s, ...bal.get(s.id) }));
  const t = { count: rows.length, originalDue: 0, credited: 0, netDue: 0, netAllocated: 0, outstanding: 0, liability: 0 };
  for (const r of rows) {
    t.originalDue = add(t.originalDue, r.originalDue); t.credited = add(t.credited, r.credit);
    t.netDue = add(t.netDue, r.netDue); t.netAllocated = add(t.netAllocated, r.netAllocated);
    t.outstanding = add(t.outstanding, r.outstanding); t.liability = add(t.liability, r.liability);
  }
  return { rows, totals: t };
}

/** Receipts received in the period; allocations may point to earlier sales. */
export function receiptActivity(state, { from, to }) {
  const avail = receiptAvailability(state);
  const rows = state.receipts.filter((r) => live(r) && inRange(r.date, from, to)).map((r) => ({ receipt: r, ...avail.get(r.id) }));
  const t = { count: rows.length, gross: 0, allocated: 0, unapplied: 0, fees: 0, net: 0 };
  for (const r of rows) {
    t.gross = add(t.gross, r.receipt.gross); t.allocated = add(t.allocated, r.allocated);
    t.unapplied = add(t.unapplied, r.available); t.fees = add(t.fees, r.receipt.fee); t.net = add(t.net, r.receipt.net);
  }
  return { rows, totals: t };
}

export const cashCloseId = (accountId, date) => `${accountId}|${date}`;

/** One cash account on one business date. Missing opening/count => INCOMPLETE, never zero variance. */
export function cashDay(state, accountId, date) {
  let receipts = 0; let paidIn = 0; let paidOut = 0; let refunds = 0; let activity = 0;
  for (const r of state.receipts) if (live(r) && r.accountId === accountId && r.date === date) { receipts = add(receipts, r.gross); activity++; }
  for (const m of state.cashMovements) {
    if (m.reversedAt || m.accountId !== accountId || m.date !== date) continue;
    if (m.kind === 'PAID_IN') paidIn = add(paidIn, m.amount); else paidOut = add(paidOut, m.amount);
    activity++;
  }
  for (const r of state.refunds) if (!r.reversedAt && r.accountId === accountId && r.date === date) { refunds = add(refunds, r.amount); activity++; }
  const close = state.cashCloses.find((c) => c.id === cashCloseId(accountId, date)) || null;
  const opening = close && Number.isSafeInteger(close.opening) ? close.opening : null;
  const counted = close && Number.isSafeInteger(close.counted) ? close.counted : null;
  const expected = opening === null ? null : opening + receipts + paidIn - refunds - paidOut;
  const variance = expected === null || counted === null ? null : counted - expected;
  const status = variance === null ? 'INCOMPLETE' : variance === 0 ? 'BALANCED' : 'VARIANCE';
  return { accountId, date, opening, receipts, paidIn, refunds, paidOut, expected, counted, variance, status, activity, hasClose: !!close };
}

/** Cash days in a period that have any activity or a saved close. */
export function cashDays(state, { from, to }) {
  const out = [];
  if (from > to) return out;
  const accounts = state.accounts.filter((a) => a.type === 'CASH').sort((a, b) => (a.id < b.id ? -1 : 1)); // stable order across reloads
  for (let d = from, n = 0; d <= to && n < 400; d = addDays(d, 1), n++) {
    for (const a of accounts) {
      const day = cashDay(state, a.id, d);
      if (day.activity > 0 || day.hasClose) out.push(day);
    }
  }
  return out;
}

/** The figures a saved report snapshot is checked against. */
export function reportTotals(state, range, cutoff) {
  return {
    sales: salesCohort(state, range, cutoff).totals,
    receipts: receiptActivity(state, range).totals,
    cash: cashDays(state, range).map(({ accountId, date, opening, receipts, paidIn, refunds, paidOut, expected, counted, variance, status }) =>
      ({ accountId, date, opening, receipts, paidIn, refunds, paidOut, expected, counted, variance, status })),
  };
}
