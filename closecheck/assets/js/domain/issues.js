// Derives the review queue from current data. Issues are never stored; only their review state is.
import { idx, live, saleBalances, receiptAvailability, cashDay } from './calc.js';
import { runMatching, REVIEW_TEXT } from './matching.js';
import { formatPHP } from './money.js';

export const ISSUE_TYPES = {
  INVALID_INPUT: 'Invalid input rows',
  DUPLICATE_SOURCE: 'Conflicting duplicate',
  REPEATED_REFERENCE: 'Repeated reference',
  AMBIGUOUS_MATCH: 'Needs match review',
  UNMATCHED_RECEIPT: 'Unapplied receipt',
  PARTIAL_PAYMENT: 'Partial payment',
  UNPAID: 'Unpaid sale',
  PAID_CLAIM_UNSUPPORTED: 'Paid claim without support',
  CASH_VARIANCE: 'Cash variance',
  REFUND_DUE: 'Refund due',
  UNSUPPORTED_SETTLEMENT: 'Unsupported settlement',
  INCOMPLETE_COVERAGE: 'Incomplete check',
};
export const ISSUE_STATES = ['OPEN', 'IN_REVIEW', 'ACKNOWLEDGED_WITH_NOTE'];
const SOFT = new Set(['AMOUNT_DIFFERS', 'MULTIPLE_RECEIPTS']);

export function deriveIssues(state, { today, windowDays = 7 } = {}) {
  return memo2(state, `${today}|${windowDays}`, () => {
    const out = []; const { salesById } = idx(state);
    const push = (key, type, date, title, detail, amount, entity, action) => out.push({ key, type, date, title, detail, amount, entity, action });

    for (const b of state.batches) {
      if (b.removedAt) continue;
      const log = b.rowLog || []; const date = b.importedOn || b.importedAt.slice(0, 10);
      const count = (st, code) => log.filter((x) => x.status === st && (!code || x.code === code)).length;
      const unsupported = count('invalid', 'UNSUPPORTED_SETTLEMENT'); const invalid = count('invalid') - unsupported; const conflict = count('conflict');
      const ent = { kind: 'batch', id: b.id };
      if (invalid) push(`invalid:${b.id}`, 'INVALID_INPUT', date, `${invalid} row(s) in ${b.filename} were not imported`, 'These rows failed validation and are not part of any total.', null, ent, 'Open the row log, correct the source file, and import the corrected rows.');
      if (unsupported) push(`unsupported:${b.id}`, 'UNSUPPORTED_SETTLEMENT', date, `${unsupported} row(s) in ${b.filename} look like combined or net settlements`, 'Net amount did not equal amount minus fee. These rows were not imported and are not treated as underpayments.', null, ent, 'Enter the individual customer receipts behind the settlement.');
      if (conflict) push(`conflict:${b.id}`, 'DUPLICATE_SOURCE', date, `${conflict} row(s) in ${b.filename} reuse an existing ID with different values`, 'Conflicting rows were quarantined and not imported.', null, ent, 'Compare the row log with the existing record and correct whichever is wrong.');
    }

    const avail = receiptAvailability(state); const { review } = runMatching(state, { windowDays });
    const byRef = new Map();
    for (const r of state.receipts) {
      if (!live(r)) continue;
      if (r.reference) { const k = `${r.accountId}\u0000${r.reference}`; if (!byRef.has(k)) byRef.set(k, []); byRef.get(k).push(r); }
      const a = avail.get(r.id); const ent = { kind: 'receipt', id: r.id };
      if (r.unsupported) { push(`unsupported:${r.id}`, 'UNSUPPORTED_SETTLEMENT', r.date, `Receipt ${r.sourceId} is marked as a combined settlement`, 'It is excluded from automatic matching.', r.gross, ent, 'Replace it with individual customer receipts, or allocate it manually.'); continue; }
      if (a.available <= 0) continue;
      const rv = review.get(r.id);
      if (rv && !SOFT.has(rv.code)) push(`ambiguous:${r.id}`, 'AMBIGUOUS_MATCH', r.date, `Receipt ${r.sourceId} was not matched automatically`, REVIEW_TEXT[rv.code], a.available, ent, 'Open the receipt, check the evidence, then allocate manually or correct the source record.');
      else push(`unapplied:${r.id}`, 'UNMATCHED_RECEIPT', r.date, `Receipt ${r.sourceId} has ${formatPHP(a.available)} not applied to any sale`, rv ? REVIEW_TEXT[rv.code] : (a.allocated > 0 ? 'Part of this receipt is allocated; the rest is unapplied.' : 'No sale ID or matching reference identifies a sale.'), a.available, ent, 'Open the receipt and allocate it to the right sale(s), or leave it unapplied with a note.');
    }
    for (const [, list] of byRef) {
      if (list.length < 2) continue;
      const r = list[0];
      push(`ref:${r.accountId}:${r.reference}`, 'REPEATED_REFERENCE', list.map((x) => x.date).sort()[0], `Reference ${r.reference} appears on ${list.length} receipts in ${r.accountId}`, `Receipts: ${list.map((x) => x.sourceId).join(', ')}. This may be a duplicate or two genuine payments.`, null, { kind: 'receipt', id: r.id }, 'Check the source statement. Void a true duplicate; otherwise allocate each receipt manually.');
    }

    const bal = saleBalances(state);
    for (const [id, b] of bal) {
      const s = salesById.get(id); const ent = { kind: 'sale', id };
      const overdue = s.dueDate && today && s.dueDate < today ? ` Overdue since ${s.dueDate}.` : '';
      if (b.liability > 0) push(`refund:${id}`, 'REFUND_DUE', s.date, `Sale ${s.sourceId} is overpaid by ${formatPHP(b.liability)}`, 'Net payments exceed the net amount due after credits.', b.liability, ent, 'Record the refund when the money is returned, or correct the credit.');
      if (b.outstanding <= 0) continue;
      if (s.claimedStatus === 'PAID') push(`claim:${id}`, 'PAID_CLAIM_UNSUPPORTED', s.date, `Sale ${s.sourceId} is marked PAID in the source but ${formatPHP(b.outstanding)} has no matching receipt`, `The imported status is a claim only.${overdue}`, b.outstanding, ent, 'Find the receipt record and import or enter it, then allocate.');
      else if (b.status === 'PARTIAL') push(`partial:${id}`, 'PARTIAL_PAYMENT', s.date, `Sale ${s.sourceId} is partly paid; ${formatPHP(b.outstanding)} outstanding`, `Net allocated ${formatPHP(b.netAllocated)} of ${formatPHP(b.netDue)}.${overdue}`, b.outstanding, ent, 'Follow up the balance, or record a credit if the amount due changed.');
      else push(`unpaid:${id}`, 'UNPAID', s.date, `Sale ${s.sourceId} has no recorded payment; ${formatPHP(b.outstanding)} outstanding`, `No receipt is allocated to this sale.${overdue}`, b.outstanding, ent, 'Normal for credit sales. Follow up, or allocate the receipt once recorded.');
    }

    const seen = new Set();
    const cashAccounts = state.accounts.filter((a) => a.type === 'CASH');
    const dates = new Set([...state.cashCloses.map((c) => c.date)]);
    for (const a of cashAccounts) {
      for (const r of state.receipts) if (live(r) && r.accountId === a.id) dates.add(r.date);
      for (const m of state.cashMovements) if (!m.reversedAt && m.accountId === a.id) dates.add(m.date);
      for (const r of state.refunds) if (!r.reversedAt && r.accountId === a.id) dates.add(r.date);
      for (const d of dates) {
        const k = `${a.id}|${d}`; if (seen.has(k)) continue; seen.add(k);
        const day = cashDay(state, a.id, d); const ent = { kind: 'cash', id: k };
        if (day.status === 'VARIANCE') push(`cashvar:${k}`, 'CASH_VARIANCE', d, `Cash ${a.id} on ${d}: counted cash is ${day.variance < 0 ? 'short' : 'over'} by ${formatPHP(Math.abs(day.variance))}`, `Expected ${formatPHP(day.expected)}, counted ${formatPHP(day.counted)}.`, day.variance, ent, 'Recount, then check for unrecorded cash sales, payouts, or change errors.');
        else if (day.status === 'INCOMPLETE' && (day.activity > 0 || day.hasClose)) push(`cashinc:${k}`, 'INCOMPLETE_COVERAGE', d, `Cash check incomplete for ${a.id} on ${d}`, `${day.opening === null ? 'Opening cash' : 'Counted cash'} has not been entered, so no variance is calculated.`, null, ent, 'Enter opening and counted cash on the Cash Close screen.');
      }
    }
    return out;
  });
}

const store = new WeakMap();
function memo2(state, key, fn) {
  let m = store.get(state); if (!m) { m = new Map(); store.set(state, m); }
  if (!m.has(key)) m.set(key, fn());
  return m.get(key);
}

/** Issues relevant to a report period (by the date of the record they concern). */
export const issuesInRange = (issues, { from, to }) => issues.filter((i) => i.date >= from && i.date <= to);
