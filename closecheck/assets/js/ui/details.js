// Shared record dialogs: sale and receipt details, entry forms, period picker.
import { UserError, ConfirmError } from '../domain/errors.js';
import { toDecimal, formatPHP } from '../domain/money.js';
import { isDateString } from '../domain/dates.js';
import { idx, live, saleBalances, receiptAvailability } from '../domain/calc.js';
import { suggestSales } from '../domain/matching.js';
import { h, btn, chip, money, dl, table, notice, openDialog, formDialog, confirmDialog } from './dom.js';

export const METHOD = (a) => (a.method === 'MANUAL' ? 'Manually allocated' : 'Matched from imported records');
const SALE_STATUS = { SETTLED: ['Settled', 'ok'], PARTIAL: ['Partly paid', 'warn'], UNPAID: ['Unpaid', 'warn'], REFUND_DUE: ['Refund due', 'warn'] };
export const saleChip = (s, b) => (s.voidedAt ? chip('Voided') : chip(...SALE_STATUS[b.status]));
export function receiptChip(r, a) {
  if (r.voidedAt) return chip('Voided');
  if (r.unsupported) return chip('Combined settlement', 'warn');
  return a.available === 0 ? chip('Fully allocated', 'ok') : a.allocated === 0 ? chip('Unapplied', 'warn') : chip('Partly allocated', 'warn');
}

/** Re-run an action with confirm=true after the user agrees to its side effects. */
export async function withConfirm(fn) {
  try { return await fn(false); }
  catch (e) {
    if (!(e instanceof ConfirmError)) throw e;
    if (!(await confirmDialog({ title: 'Please confirm', message: e.message, confirmLabel: 'Yes, continue', danger: true }))) throw new UserError('Cancelled. Nothing was changed.');
    return fn(true);
  }
}

export function periodBar(ctx, { label = 'Period' } = {}) {
  const from = h('input', { type: 'date', value: ctx.period.from, 'aria-label': 'From date' });
  const to = h('input', { type: 'date', value: ctx.period.to, 'aria-label': 'To date' });
  const apply = () => {
    if (!isDateString(from.value) || !isDateString(to.value)) { ctx.toast('Choose valid dates.', 'error'); return; }
    if (from.value > to.value) { ctx.toast('The start date is after the end date.', 'error'); return; }
    ctx.period = { from: from.value, to: to.value }; ctx.refresh();
  };
  from.addEventListener('change', apply); to.addEventListener('change', apply);
  return h('div', { class: 'toolbar', role: 'group', 'aria-label': label }, h('span', { class: 'field-label' }, label), from, h('span', {}, 'to'), to,
    btn('Today', () => { const t = ctx.today(); ctx.period = { from: t, to: t }; ctx.refresh(); }, { kind: 'small' }));
}

const history = (ctx, ids) => {
  const rows = ctx.ws.state.events.filter((e) => ids.has(e.entityId)).sort((a, b) => (a.at < b.at ? 1 : -1));
  return table('History', [{ label: 'When', cell: (e) => ctx.when(e.at) }, { label: 'By (local label)', cell: (e) => e.actor }, { label: 'Action', cell: (e) => `${e.entityType} ${e.action}` }, { label: 'Reason', cell: (e) => e.reason || '—' }], rows, { empty: 'No history yet.', limit: 20 });
};
const provenance = (ctx, rec) => {
  if (rec.source !== 'import') return 'Entered manually in this app';
  const b = ctx.ws.state.batches.find((x) => x.id === rec.batchId);
  return `Imported from ${b ? b.filename : 'a removed file'}, row ${rec.rowNumber}. Original values: ${Object.entries(rec.original || {}).filter(([, v]) => v !== '').map(([k, v]) => `${k}=${v}`).join(' · ')}`;
};
const reasonDialog = (ctx, title, intro, run, okMsg, after) => formDialog({ title, intro, danger: true, submitLabel: title, fields: [{ name: 'reason', label: 'Reason', type: 'textarea', required: true }], onSubmit: async (v) => { await withConfirm((confirm) => run(v.reason, confirm)); after(okMsg); } });

export function saleForm(ctx, existing, after = (m) => ctx.done(m)) {
  const accounts = ctx.ws.state.accounts.filter((a) => a.active || a.id === existing?.expectedAccount);
  formDialog({
    title: existing ? `Edit sale ${existing.sourceId}` : 'Add sale',
    intro: existing ? 'Changing the amount or date reverses allocations that relied on the old values.' : 'Enter the actual amount due after discounts.',
    fields: [
      { name: 'sale_id', label: 'Sale ID', required: true, value: existing?.sourceId },
      { name: 'sale_date', label: 'Sale date', type: 'date', required: true, value: existing?.date || ctx.period.to },
      { name: 'total_due', label: 'Total due (PHP)', money: true, required: true, value: existing ? toDecimal(existing.totalDue) : '' },
      { name: 'expected_account', label: 'Expected payment account', type: 'select', options: [['', 'Not specified / split'], ...accounts.map((a) => [a.id, `${a.id} — ${a.label}`])], value: existing?.expectedAccount || '' },
      { name: 'expected_reference', label: 'Expected reference', value: existing?.expectedReference },
      { name: 'customer_label', label: 'Customer label', value: existing?.customerLabel, help: 'Use a code or alias. Avoid unnecessary personal information.' },
      { name: 'due_date', label: 'Due date', type: 'date', value: existing?.dueDate },
      { name: 'claimed_payment_status', label: 'Status claimed in your records', type: 'select', options: [['', 'Not stated'], ['PAID', 'PAID'], ['PARTIAL', 'PARTIAL'], ['UNPAID', 'UNPAID']], value: existing?.claimedStatus || '' },
      { name: 'notes', label: 'Notes', type: 'textarea', value: existing?.notes },
    ],
    onSubmit: async (v) => {
      if (existing) await withConfirm((confirm) => ctx.ws.editSale(existing.id, v, { confirm, reason: 'Edited in app' })); else await ctx.ws.addSale(v);
      after(existing ? 'Sale updated.' : 'Sale saved.');
    },
  });
}
export function receiptForm(ctx, existing, after = (m) => ctx.done(m)) {
  const accounts = ctx.ws.state.accounts.filter((a) => a.active || a.id === existing?.accountId);
  formDialog({
    title: existing ? `Edit receipt ${existing.sourceId}` : 'Add receipt',
    intro: 'Enter one completed customer payment. Combined or net settlements covering many orders are not supported.',
    fields: [
      { name: 'receipt_id', label: 'Receipt / transaction ID', required: true, value: existing?.sourceId },
      existing ? { name: 'received_at', label: 'Received at (date or timestamp)', required: true, value: existing.receivedAt } : { name: 'received_at', label: 'Date received', type: 'date', required: true, value: ctx.period.to },
      { name: 'amount', label: 'Gross amount paid by customer (PHP)', money: true, required: true, value: existing ? toDecimal(existing.gross) : '' },
      { name: 'account_id', label: 'Account', type: 'select', required: true, options: accounts.map((a) => [a.id, `${a.id} — ${a.label}`]), value: existing?.accountId || accounts[0]?.id },
      { name: 'reference', label: 'Reference', value: existing?.reference },
      { name: 'sale_id', label: 'Sale ID it pays (if known)', value: existing?.saleSourceId, list: ctx.ws.state.sales.filter(live).slice(-200).map((s) => s.sourceId) },
      { name: 'fee', label: 'Transaction fee (PHP)', money: true, value: existing && existing.fee ? toDecimal(existing.fee) : '', help: 'Leave blank for none. Cash receipts cannot have a fee.' },
      { name: 'notes', label: 'Notes', type: 'textarea', value: existing?.notes },
    ],
    onSubmit: async (v) => {
      if (existing) await withConfirm((confirm) => ctx.ws.editReceipt(existing.id, v, { confirm, reason: 'Edited in app' })); else await ctx.ws.addReceipt(v);
      after(existing ? 'Receipt updated.' : 'Receipt saved.');
    },
  });
}

export function openSale(ctx, id) {
  const st = ctx.ws.state; const { salesById, receiptsById } = idx(st);
  const s = salesById.get(id); if (!s) return;
  const b = saleBalances(st).get(id) || null; const ro = !!s.voidedAt;
  openDialog(`Sale ${s.sourceId}`, (close) => {
    const again = (msg) => { close(); ctx.done(msg); openSale(ctx, id); };
    const allocs = st.allocations.filter((a) => a.saleId === id);
    const credits = st.credits.filter((c) => c.saleId === id); const refunds = st.refunds.filter((r) => r.saleId === id);
    const rev = (x) => (x.reversedAt ? chip('Reversed') : null);
    return [
      h('p', {}, saleChip(s, b), ' ', s.claimedStatus ? chip(`Source says ${s.claimedStatus}`) : null),
      s.voidedAt ? notice('warn', `Voided: ${s.voidReason}`) : null,
      dl([['Sale date', s.date], ['Original due', money(s.totalDue)], b && ['Credits', money(b.credit)], b && ['Net amount due', money(b.netDue)], b && ['Allocated receipts', money(b.allocated)], b && ['Refunds paid out', money(b.refunded)], b && ['Net allocated payment', money(b.netAllocated)], b && ['Outstanding', money(b.outstanding)], b && b.liability > 0 && ['Refund / overpayment liability', money(b.liability)],
        ['Expected account', s.expectedAccount], ['Expected reference', s.expectedReference], ['Customer label', s.customerLabel], ['Due date', s.dueDate], ['Notes', s.notes], ['Source', provenance(ctx, s)]]),
      ro ? null : h('div', { class: 'actions start' },
        btn('Add credit', () => formDialog({ title: 'Add credit adjustment', intro: 'A credit reduces the amount owed (return, discount, correction). It does not record money going out; use a refund for that.', fields: [{ name: 'amount', label: 'Credit amount (PHP)', money: true, required: true }, { name: 'date', label: 'Date', type: 'date', required: true, value: ctx.today() }, { name: 'reason', label: 'Reason', type: 'textarea', required: true }, { name: 'evidence', label: 'Evidence reference (optional)', help: 'For example a return slip number.' }], onSubmit: async (v) => { await ctx.ws.addCredit(id, v); again('Credit recorded.'); } })),
        btn('Record refund', () => formDialog({ title: 'Record refund paid out', intro: 'Records money returned to the customer. Cash refunds reduce expected cash on that date.', fields: [{ name: 'amount', label: 'Refund amount (PHP)', money: true, required: true }, { name: 'accountId', label: 'Paid from account', type: 'select', required: true, options: st.accounts.map((a) => [a.id, `${a.id} — ${a.label}`]) }, { name: 'date', label: 'Date paid', type: 'date', required: true, value: ctx.today() }, { name: 'reason', label: 'Reason', type: 'textarea', required: true }], onSubmit: async (v) => { await ctx.ws.addRefund(id, v); again('Refund recorded.'); } })),
        btn('Edit', () => saleForm(ctx, s, again)),
        btn('Void sale', () => reasonDialog(ctx, 'Void sale', 'The sale stays in history but is excluded from all totals.', (reason, confirm) => ctx.ws.voidSale(id, reason, { confirm }), 'Sale voided.', again), { kind: 'danger' })),
      h('h3', {}, 'Allocations'),
      table('Allocations for this sale', [
        { label: 'Receipt', cell: (a) => { const r = receiptsById.get(a.receiptId); return r ? btn(r.sourceId, () => { close(); openReceipt(ctx, r.id); }, { kind: 'link' }) : '—'; } },
        { label: 'Account', cell: (a) => receiptsById.get(a.receiptId)?.accountId }, { label: 'Received', cell: (a) => receiptsById.get(a.receiptId)?.date },
        { label: 'Amount', num: true, cell: (a) => money(a.amount) }, { label: 'How', cell: (a) => [METHOD(a), ' ', rev(a)] }, { label: 'Why', cell: (a) => (a.reversedAt ? `Reversed: ${a.reversalReason}` : a.reason) },
        { label: '', cell: (a) => (a.reversedAt || ro ? null : btn('Reverse', () => reasonDialog(ctx, 'Reverse allocation', 'The allocation stays in history, marked reversed. Balances are recalculated.', (reason) => ctx.ws.reverseAllocation(a.id, reason), 'Allocation reversed.', again), { kind: 'small' })) },
      ], allocs, { empty: 'No receipts are allocated to this sale.' }),
      credits.length + refunds.length ? [h('h3', {}, 'Credits and refunds'), table('Credits and refunds', [
        { label: 'Type', cell: (x) => [x.accountId ? `Refund from ${x.accountId}` : 'Credit', ' ', rev(x)] }, { label: 'Date', cell: (x) => x.date }, { label: 'Amount', num: true, cell: (x) => money(x.amount) }, { label: 'Reason', cell: (x) => x.reason },
        { label: '', cell: (x) => (x.reversedAt || ro ? null : btn('Reverse', () => reasonDialog(ctx, 'Reverse entry', 'The entry stays in history, marked reversed.', (reason) => ctx.ws.reverseEntry(x.accountId ? 'refunds' : 'credits', x.id, reason), 'Entry reversed.', again), { kind: 'small' })) },
      ], [...credits, ...refunds])] : null,
      h('h3', {}, 'History'), history(ctx, new Set([id, ...allocs.map((a) => a.id), ...credits.map((c) => c.id), ...refunds.map((r) => r.id)])),
    ];
  }, { wide: true });
}

export function openReceipt(ctx, id) {
  const st = ctx.ws.state; const { salesById, receiptsById, saleBySource } = idx(st);
  const r = receiptsById.get(id); if (!r) return;
  const a = receiptAvailability(st).get(id) || { allocated: 0, available: 0 }; const ro = !!r.voidedAt;
  openDialog(`Receipt ${r.sourceId}`, (close) => {
    const again = (msg) => { close(); ctx.done(msg); openReceipt(ctx, id); };
    const allocs = st.allocations.filter((x) => x.receiptId === id);
    const sug = ro ? [] : suggestSales(st, id, { windowDays: st.settings.matchWindowDays });
    const allocate = () => formDialog({
      title: 'Allocate receipt to a sale',
      intro: sug.length ? `Possible sales: ${sug.map((x) => `${x.sale.sourceId} (${formatPHP(x.outstanding)} outstanding; ${x.why})`).join('; ')}. Check the evidence before allocating.` : 'No sale is suggested. Type the sale ID this payment belongs to.',
      submitLabel: 'Allocate',
      fields: [{ name: 'saleId', label: 'Sale ID', required: true, value: sug[0]?.sale.sourceId || r.saleSourceId, list: sug.map((x) => x.sale.sourceId) }, { name: 'amount', label: `Amount to allocate (PHP), up to ${formatPHP(a.available)}`, money: true, required: true, value: toDecimal(sug[0] ? Math.min(a.available, sug[0].outstanding) : a.available) }, { name: 'reason', label: 'Note (optional)', type: 'textarea' }],
      onSubmit: async (v) => { const s = saleBySource.get(v.saleId.trim()); if (!s) throw new UserError(`No sale with ID "${v.saleId.trim()}" exists.`); await ctx.ws.allocate(id, s.id, v.amount, v.reason); again('Receipt allocated manually.'); },
    });
    return [
      h('p', {}, receiptChip(r, a)),
      r.voidedAt ? notice('warn', `Voided: ${r.voidReason}`) : null,
      dl([['Account', r.accountId], ['Received at', r.receivedAt], ['Business date', r.date], ['Gross amount', money(r.gross)], ['Fee', money(r.fee)], ['Net amount', money(r.net)], ['Allocated', money(a.allocated)], ['Unapplied', money(a.available)], ['Reference', r.reference], ['Names sale ID', r.saleSourceId], ['Notes', r.notes], ['Source', provenance(ctx, r)]]),
      ro ? null : h('div', { class: 'actions start' },
        btn('Allocate to a sale', allocate, { kind: 'primary', disabled: a.available === 0 }),
        btn('Edit', () => receiptForm(ctx, r, again)),
        btn(r.unsupported ? 'Unmark combined settlement' : 'Mark as combined settlement', () => reasonDialog(ctx, r.unsupported ? 'Unmark combined settlement' : 'Mark as combined settlement', 'Combined settlements are excluded from automatic matching and shown as unsupported.', (reason) => ctx.ws.setReceiptUnsupported(id, !r.unsupported, reason), 'Receipt updated.', again)),
        btn('Void receipt', () => reasonDialog(ctx, 'Void receipt', 'Use this for a true duplicate or an entry made in error. It stays in history but leaves all totals.', (reason, confirm) => ctx.ws.voidReceipt(id, reason, { confirm }), 'Receipt voided.', again), { kind: 'danger' })),
      h('h3', {}, 'Allocations'),
      table('Allocations of this receipt', [
        { label: 'Sale', cell: (x) => { const s = salesById.get(x.saleId); return s ? btn(s.sourceId, () => { close(); openSale(ctx, s.id); }, { kind: 'link' }) : '—'; } },
        { label: 'Sale date', cell: (x) => salesById.get(x.saleId)?.date }, { label: 'Amount', num: true, cell: (x) => money(x.amount) },
        { label: 'How', cell: (x) => [METHOD(x), ' ', x.reversedAt ? chip('Reversed') : null] }, { label: 'Why', cell: (x) => (x.reversedAt ? `Reversed: ${x.reversalReason}` : x.reason) },
        { label: '', cell: (x) => (x.reversedAt || ro ? null : btn('Reverse', () => reasonDialog(ctx, 'Reverse allocation', 'The allocation stays in history, marked reversed. Balances are recalculated.', (reason) => ctx.ws.reverseAllocation(x.id, reason), 'Allocation reversed.', again), { kind: 'small' })) },
      ], allocs, { empty: 'This receipt is not allocated to any sale.' }),
      h('h3', {}, 'History'), history(ctx, new Set([id, ...allocs.map((x) => x.id)])),
    ];
  }, { wide: true });
}
