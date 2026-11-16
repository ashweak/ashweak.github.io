// Review, Cash Close, Reports, Settings & Data screens.
import { formatPHP, toDecimal } from '../domain/money.js';
import { isDateString, addDays } from '../domain/dates.js';
import { idx, live, cashDay } from '../domain/calc.js';
import { ISSUE_TYPES, issuesInRange } from '../domain/issues.js';
import { validateBackup } from '../data/backup.js';
import { salesCsv, receiptsCsv, allocationsCsv, issuesCsv } from '../data/exports.js';
import { STORES } from '../data/repo.js';
import { ACCOUNT_TYPES } from '../domain/validate.js';
import { h, btn, chip, money, field, select, section, table, notice, dl, downloadFile, openDialog, formDialog, confirmDialog } from './dom.js';
import { periodBar, openSale, openReceipt } from './details.js';

const head = (title, lead) => [h('h1', { tabindex: '-1' }, title), lead ? h('p', { class: 'lead' }, lead) : null];
const max = (a, b) => (a > b ? a : b);
const STATE_LABEL = { OPEN: 'Open', IN_REVIEW: 'In review', ACKNOWLEDGED_WITH_NOTE: 'Acknowledged with note', RESOLVED_BY_CORRECTION: 'Resolved by correction' };
const REPORT_STATUS = { DRAFT: ['Draft (not saved)', 'neutral'], SAVED_WITH_OPEN_ITEMS: ['Saved with open items', 'warn'], SAVED_NO_OPEN_ITEMS: ['Saved, no open items', 'ok'], SUPERSEDED: ['Superseded', 'neutral'] };

// ---------------- Review ----------------
export function reviewView(ctx) {
  const st = ctx.ws.state; const today = ctx.today();
  const f = ctx.ui.review || (ctx.ui.review = { all: false, type: '', state: 'ACTIVE' });
  const states = new Map(st.issueStates.map((i) => [i.id, i]));
  const all = ctx.ws.issues(today); const scoped = f.all ? all : issuesInRange(all, ctx.period);
  const stateOf = (i) => states.get(i.key)?.state || 'OPEN';
  const list = scoped.filter((i) => (!f.type || i.type === f.type) && (f.state === 'ALL' || (f.state === 'ACTIVE' ? stateOf(i) !== 'ACKNOWLEDGED_WITH_NOTE' : stateOf(i) === f.state)))
    .sort((a, b) => (a.date === b.date ? (a.key < b.key ? -1 : 1) : a.date < b.date ? 1 : -1));
  const liveKeys = new Set(all.map((i) => i.key));
  const resolved = st.issueStates.filter((i) => !liveKeys.has(i.id));
  const openRecord = (i) => {
    if (i.entity.kind === 'sale') openSale(ctx, i.entity.id);
    else if (i.entity.kind === 'receipt') openReceipt(ctx, i.entity.id);
    else if (i.entity.kind === 'cash') { const [acc, date] = i.entity.id.split('|'); ctx.ui.cash = { accountId: acc, date }; ctx.go('cash'); }
    else ctx.go('import');
  };
  const card = (i) => {
    const cur = states.get(i.key); const sel = select(['OPEN', 'IN_REVIEW', 'ACKNOWLEDGED_WITH_NOTE'].map((s) => [s, STATE_LABEL[s]]), cur?.state || 'OPEN', { 'aria-label': 'Review state' });
    const note = h('textarea', { rows: '2', 'aria-label': 'Note', placeholder: 'Explanation or follow-up note', maxlength: '1000' }, cur?.note || '');
    return h('li', { class: 'issue' },
      h('div', { class: 'issue-head' }, chip(ISSUE_TYPES[i.type], i.type === 'CASH_VARIANCE' && i.amount < 0 ? 'bad' : 'warn'), h('span', { class: 'muted' }, i.date), cur ? chip(STATE_LABEL[cur.state]) : null),
      h('p', { class: 'issue-title' }, i.title), h('p', {}, i.detail), h('p', { class: 'help' }, h('strong', {}, 'Suggested action: '), i.action),
      h('div', { class: 'issue-form' }, sel, note, btn('Save review', () => ctx.act(() => ctx.ws.setIssueState(i.key, sel.value, note.value), 'Review saved. Amounts are unchanged.'), { kind: 'small' }),
        btn(i.entity.kind === 'cash' ? 'Open cash close' : i.entity.kind === 'batch' ? 'Open import history' : 'Open record', () => openRecord(i), { kind: 'small' })));
  };
  const events = st.events.slice().sort((a, b) => (a.at < b.at ? 1 : -1));
  return h('div', {}, head('Review', 'Items that need a look. A note explains an item; it never changes an amount.'),
    section('Matching',
      h('p', {}, 'Automatic matching only links a receipt to a sale when an exact sale ID or an exact reference in the same account identifies one sale and the amounts are equal. Everything else waits for you.'),
      h('div', { class: 'actions start' }, btn('Run matching', () => ctx.act(async () => { const n = await ctx.ws.runMatching(); ctx.toast(n ? `${n} receipt(s) matched from imported records.` : 'No new exact matches. Existing allocations were kept.'); }), { kind: 'primary' }),
        h('span', { class: 'help' }, `Reference window: sale date to ${st.settings.matchWindowDays} day(s) later. No amount tolerance.`))),
    f.all ? null : periodBar(ctx),
    h('div', { class: 'toolbar' },
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: f.all, onchange: (e) => { f.all = e.target.checked; ctx.refresh(); } }), h('span', {}, 'All dates')),
      field('Type', select([['', 'All types'], ...Object.entries(ISSUE_TYPES)], f.type, { onchange: (e) => { f.type = e.target.value; ctx.refresh(); } })),
      field('Show', select([['ACTIVE', 'Open and in review'], ['ACKNOWLEDGED_WITH_NOTE', 'Acknowledged with note'], ['ALL', 'All']], f.state, { onchange: (e) => { f.state = e.target.value; ctx.refresh(); } }))),
    h('p', { 'aria-live': 'polite' }, `${list.length} item(s) shown.`),
    list.length ? h('ul', { class: 'issues' }, list.slice(0, 200).map(card)) : h('p', { class: 'empty' }, 'Nothing to review with these filters. This only reflects the records you supplied.'),
    list.length > 200 ? h('p', { class: 'help' }, `Showing the first 200 of ${list.length}. Narrow the period or type.`) : null,
    resolved.length ? section('Resolved by correction', h('p', { class: 'help' }, 'These reviewed items no longer appear because the underlying records were corrected or completed.'),
      table('Resolved items', [{ label: 'Item', cell: (r) => r.id }, { label: 'Last state', cell: (r) => STATE_LABEL[r.state] }, { label: 'Note', cell: (r) => r.note || '—' }, { label: 'Updated', cell: (r) => ctx.when(r.updatedAt) }], resolved, { limit: 20 })) : null,
    section('Change history', h('p', { class: 'help' }, 'Kept in this browser for your own reference. It is not tamper-proof and the name is a label, not a verified identity.'),
      table('Change history', [{ label: 'When', cell: (e) => ctx.when(e.at) }, { label: 'By (local label)', cell: (e) => e.actor }, { label: 'What', cell: (e) => `${e.entityType} ${e.action}` }, { label: 'Reason', cell: (e) => e.reason || '—' }], events, { empty: 'No changes recorded yet.', limit: 25 })));
}

// ---------------- Cash Close ----------------
export function cashView(ctx) {
  const st = ctx.ws.state; const accounts = st.accounts.filter((a) => a.type === 'CASH');
  if (!accounts.length) return h('div', {}, head('Cash Close'), notice('info', 'Add a cash account in Settings & Data to reconcile cash.'));
  const ui = ctx.ui.cash || (ctx.ui.cash = {});
  if (!accounts.some((a) => a.id === ui.accountId)) ui.accountId = (accounts.find((a) => a.active) || accounts[0]).id;
  if (!isDateString(ui.date)) ui.date = ctx.period.to;
  const day = cashDay(st, ui.accountId, ui.date);
  const prev = st.cashCloses.filter((c) => c.accountId === ui.accountId && c.date < ui.date && c.counted !== null).sort((a, b) => (a.date < b.date ? 1 : -1))[0];
  const opening = h('input', { type: 'text', inputmode: 'decimal', placeholder: 'Not entered', value: day.opening === null ? '' : toDecimal(day.opening) });
  const counted = h('input', { type: 'text', inputmode: 'decimal', placeholder: 'Not entered', value: day.counted === null ? '' : toDecimal(day.counted) });
  const save = () => ctx.act(() => ctx.ws.saveCashClose(ui.accountId, ui.date, { opening: opening.value, counted: counted.value }), 'Cash close saved.');
  const moves = st.cashMovements.filter((m) => m.accountId === ui.accountId && m.date === ui.date);
  const cashReceipts = st.receipts.filter((r) => live(r) && r.accountId === ui.accountId && r.date === ui.date);
  const result = day.status === 'INCOMPLETE' ? notice('warn', h('strong', {}, 'Cash check incomplete. '), `${day.opening === null ? 'Opening cash' : 'Counted cash'} has not been entered, so no variance is shown.`)
    : day.variance === 0 ? notice('ok', h('strong', {}, 'Counted cash equals expected cash. '), 'Variance ₱0.00.')
      : notice(day.variance < 0 ? 'error' : 'warn', h('strong', {}, `Cash is ${day.variance < 0 ? 'short' : 'over'} by ${formatPHP(Math.abs(day.variance))}. `), `Variance ${formatPHP(day.variance)} = counted ${formatPHP(day.counted)} − expected ${formatPHP(day.expected)}. This is separate from unpaid balances and is not an accusation; recount and check for unrecorded cash sales or payouts.`);
  return h('div', {}, head('Cash Close', 'Compare the cash you expect in the drawer with the cash you counted.'),
    h('div', { class: 'toolbar' },
      field('Cash account', select(accounts.map((a) => [a.id, `${a.id} — ${a.label}`]), ui.accountId, { onchange: (e) => { ui.accountId = e.target.value; ctx.refresh(); } })),
      field('Business date', h('input', { type: 'date', value: ui.date, onchange: (e) => { if (isDateString(e.target.value)) { ui.date = e.target.value; ctx.refresh(); } } })),
      btn('Previous day', () => { ui.date = addDays(ui.date, -1); ctx.refresh(); }, { kind: 'small' }), btn('Next day', () => { ui.date = addDays(ui.date, 1); ctx.refresh(); }, { kind: 'small' })),
    section(`Cash for ${ui.accountId} on ${ui.date}`,
      h('div', { class: 'grid' }, field('Opening cash (PHP)', opening, 'Leave blank if not counted. Blank is not treated as zero.'),
        prev && day.opening === null ? h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Previous count'), btn(`Use ${formatPHP(prev.counted)} counted on ${prev.date}`, async () => { if (await confirmDialog({ title: 'Use previous count as opening cash?', message: `Opening cash will be set to ${formatPHP(prev.counted)}, the amount counted on ${prev.date}. Confirm only if no cash was added or removed in between.`, confirmLabel: 'Use this amount' })) { opening.value = toDecimal(prev.counted); save(); } })) : null),
      h('table', { class: 'calc' }, h('caption', { class: 'sr-only' }, 'Expected cash calculation'), h('tbody', {},
        h('tr', {}, h('th', { scope: 'row' }, 'Opening cash'), h('td', { class: 'num' }, money(day.opening))),
        h('tr', {}, h('th', { scope: 'row' }, `+ Cash receipts recorded (${cashReceipts.length}), applied or not`), h('td', { class: 'num' }, money(day.receipts))),
        h('tr', {}, h('th', { scope: 'row' }, '+ Other cash paid in'), h('td', { class: 'num' }, money(day.paidIn))),
        h('tr', {}, h('th', { scope: 'row' }, '− Cash refunds'), h('td', { class: 'num' }, money(day.refunds))),
        h('tr', {}, h('th', { scope: 'row' }, '− Other cash paid out'), h('td', { class: 'num' }, money(day.paidOut))),
        h('tr', { class: 'total' }, h('th', { scope: 'row' }, '= Expected closing cash'), h('td', { class: 'num' }, day.expected === null ? 'Needs opening cash' : money(day.expected))))),
      h('div', { class: 'grid' }, field('Counted closing cash (PHP)', counted, 'Leave blank until you have counted.')),
      h('div', { class: 'actions start' }, btn('Save cash close', save, { kind: 'primary' })), result),
    section('Other cash movements (not sales)',
      h('div', { class: 'actions start' }, btn('Add cash movement', () => formDialog({ title: 'Add cash movement', intro: 'For cash that is not a customer payment: change fund added, supplier paid from the drawer, owner withdrawal.', fields: [{ name: 'kind', label: 'Direction', type: 'select', options: [['PAID_OUT', 'Paid out of the drawer'], ['PAID_IN', 'Paid into the drawer']] }, { name: 'amount', label: 'Amount (PHP)', money: true, required: true }, { name: 'reason', label: 'Reason', type: 'textarea', required: true }], onSubmit: async (v) => { await ctx.ws.addCashMovement({ ...v, date: ui.date, accountId: ui.accountId }); ctx.done('Cash movement saved.'); } }))),
      table('Cash movements', [{ label: 'Direction', cell: (m) => [m.kind === 'PAID_IN' ? 'Paid in' : 'Paid out', ' ', m.reversedAt ? chip('Reversed') : null] }, { label: 'Amount', num: true, cell: (m) => money(m.amount) }, { label: 'Reason', cell: (m) => m.reason },
        { label: '', cell: (m) => (m.reversedAt ? null : btn('Reverse', () => formDialog({ title: 'Reverse cash movement', danger: true, submitLabel: 'Reverse', fields: [{ name: 'reason', label: 'Reason', type: 'textarea', required: true }], onSubmit: async (v) => { await ctx.ws.reverseEntry('cashMovements', m.id, v.reason); ctx.done('Cash movement reversed.'); } }), { kind: 'small' })) }], moves, { empty: 'No other cash movements on this date.' })));
}

// ---------------- Reports ----------------
function reportBody(st, r) {
  const t = r.totals; const row = (label, v) => h('tr', {}, h('th', { scope: 'row' }, label), h('td', { class: 'num' }, typeof v === 'number' ? money(v) : v));
  const calc = (caption, rows) => h('table', { class: 'calc' }, h('caption', {}, caption), h('tbody', {}, rows));
  return [
    calc(`Sales dated ${r.range.from} to ${r.range.to}, payments effective through ${r.cutoff}`, [row('Sales recorded', String(t.sales.count)), row('Original amount due', t.sales.originalDue), row('Credits', t.sales.credited), row('Net amount due', t.sales.netDue), row('Net allocated payment', t.sales.netAllocated), row('Outstanding', t.sales.outstanding), row('Refund / overpayment liabilities', t.sales.liability)]),
    calc(`Receipts received ${r.range.from} to ${r.range.to} (may pay earlier sales)`, [row('Receipts recorded', String(t.receipts.count)), row('Gross received', t.receipts.gross), row('Allocated to sales', t.receipts.allocated), row('Unapplied', t.receipts.unapplied), row('Fees', t.receipts.fees), row('Net of fees', t.receipts.net)]),
    h('h3', {}, 'Cash'),
    table('Cash by day', [{ label: 'Account', cell: (c) => c.accountId }, { label: 'Date', cell: (c) => c.date }, { label: 'Opening', num: true, cell: (c) => money(c.opening) }, { label: 'Receipts', num: true, cell: (c) => money(c.receipts) }, { label: 'Paid in', num: true, cell: (c) => money(c.paidIn) }, { label: 'Refunds', num: true, cell: (c) => money(c.refunds) }, { label: 'Paid out', num: true, cell: (c) => money(c.paidOut) }, { label: 'Expected', num: true, cell: (c) => money(c.expected) }, { label: 'Counted', num: true, cell: (c) => money(c.counted) },
      { label: 'Variance', num: true, cell: (c) => (c.status === 'INCOMPLETE' ? 'Cash check incomplete' : money(c.variance)) }], t.cash, { empty: 'No cash activity or cash close in this period.' }),
    h('h3', {}, `Open items (${r.issues.length})`),
    table('Open items', [{ label: 'Type', cell: (i) => ISSUE_TYPES[i.type] }, { label: 'Item', cell: (i) => i.title }, { label: 'Amount', num: true, cell: (i) => (i.amount === null ? '—' : money(i.amount)) }, { label: 'Review', cell: (i) => STATE_LABEL[i.state] }, { label: 'Note', cell: (i) => i.note || '—' }], r.issues, { empty: 'No open items for this period in the records supplied.', limit: 500 }),
    h('h3', {}, 'Coverage: what this report is based on'),
    h('ul', {}, r.coverage.batches.map((b) => h('li', {}, `${b.kind} file ${b.filename}: ${b.counts.valid} row(s) imported, ${b.counts.total - b.counts.valid} not imported; dates ${b.from} to ${b.to}`)),
      h('li', {}, `${r.coverage.manualSales} sale(s) and ${r.coverage.manualReceipts} receipt(s) entered manually`),
      r.coverage.rowsNotImported ? h('li', {}, `${r.coverage.rowsNotImported} source row(s) were rejected, quarantined, or excluded and are not in any total`) : null,
      r.coverage.cashIncomplete ? h('li', {}, `${r.coverage.cashIncomplete} cash day(s) have an incomplete check`) : null,
      !r.coverage.hasSales ? h('li', {}, 'No sales are recorded for this period') : null, !r.coverage.hasReceipts ? h('li', {}, 'No receipts are recorded for this period') : null),
    h('p', { class: 'help' }, 'This report organizes the records supplied to CloseCheck. It cannot detect sales or receipts that were never recorded, and it is not a bank verification, audit, or certification.'),
  ];
}
export function reportsView(ctx) {
  const st = ctx.ws.state; const today = ctx.today(); const p = ctx.period;
  const ui = ctx.ui.reports || (ctx.ui.reports = { cutoff: null, viewing: null });
  const cutoff = isDateString(ui.cutoff) && ui.cutoff >= p.to ? ui.cutoff : max(p.to, today);
  const snaps = st.snapshots.slice().sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  const viewing = ui.viewing ? st.snapshots.find((s) => s.id === ui.viewing) : null;
  const report = viewing || { ...ctx.ws.buildReport(p, cutoff, today), status: 'DRAFT' };
  const stamp = `${report.range.from}_${report.range.to}`;
  const range = report.range;
  const exports = viewing ? null : h('div', { class: 'actions start no-print' },
    btn('Export sales CSV', () => confirmExport(() => downloadFile(`closecheck_sales_${stamp}.csv`, salesCsv(st, range, cutoff), 'text/csv'))),
    btn('Export receipts CSV', () => confirmExport(() => downloadFile(`closecheck_receipts_${stamp}.csv`, receiptsCsv(st, range), 'text/csv'))),
    btn('Export allocations CSV', () => confirmExport(() => downloadFile(`closecheck_allocations_${stamp}.csv`, allocationsCsv(st, range), 'text/csv'))),
    btn('Export open items CSV', () => confirmExport(() => downloadFile(`closecheck_open_items_${stamp}.csv`, issuesCsv(report.issues.map((i) => ({ ...i, date: '' }))), 'text/csv'))));
  return h('div', {}, head('Reports', 'A daily summary you can save, print, or export.'),
    viewing ? notice('info', h('strong', {}, `Viewing saved report version ${viewing.version}, saved ${ctx.when(viewing.createdAt)}. `), viewing.status === 'SUPERSEDED' ? `Superseded: ${viewing.supersededReason}. ` : '', btn('Back to current figures', () => { ui.viewing = null; ctx.refresh(); }, { kind: 'small' }))
      : [periodBar(ctx, { label: 'Report period' }), h('div', { class: 'toolbar no-print' }, field('Payments effective through (cutoff)', h('input', { type: 'date', value: cutoff, min: p.to, onchange: (e) => { ui.cutoff = e.target.value; ctx.refresh(); } }), 'Receipts dated after the cutoff are left out of the balances.'))],
    h('section', { class: 'card report' },
      h('h2', {}, `${viewing ? viewing.businessName || 'Business' : st.settings.businessName || 'Business'} — daily reconciliation report`),
      h('p', {}, chip(...REPORT_STATUS[report.status]), ` Period ${range.from} to ${range.to} · cutoff ${report.cutoff} · ${viewing ? `saved ${ctx.when(viewing.createdAt)}, version ${viewing.version}` : `current figures as of ${today}`}`),
      reportBody(st, report)),
    h('div', { class: 'actions start no-print' },
      viewing ? null : btn('Save report snapshot', () => ctx.act(async () => { const s = await ctx.ws.saveSnapshot(p, cutoff, today); ctx.toast(s.status === 'SAVED_WITH_OPEN_ITEMS' ? `Report saved with ${s.issues.length} open item(s).` : 'Report saved with no open items.'); }), { kind: 'primary' }),
      btn('Print or save as PDF', () => window.print())),
    exports,
    h('div', { class: 'no-print' }, section('Saved reports', h('p', { class: 'help' }, 'Saved reports are never rewritten. If records change later, the old report is marked superseded and you save a new version.'),
      table('Saved reports', [{ label: 'Period', cell: (s) => `${s.range.from} to ${s.range.to}` }, { label: 'Version', num: true, cell: (s) => s.version }, { label: 'Cutoff', cell: (s) => s.cutoff }, { label: 'Saved', cell: (s) => ctx.when(s.createdAt) }, { label: 'Status', cell: (s) => chip(...REPORT_STATUS[s.status]) }, { label: 'Open items', num: true, cell: (s) => s.issues.length },
        { label: '', cell: (s) => btn('View', () => { ui.viewing = s.id; ctx.refresh(); window.scrollTo(0, 0); }, { kind: 'small' }) }], snaps, { empty: 'No reports saved yet.', limit: 30 }))));
}
async function confirmExport(run) {
  if (await confirmDialog({ title: 'Export contains business data', message: 'The downloaded file is not encrypted and contains your business records. Store it somewhere only you can access.', confirmLabel: 'Download' })) run();
}

// ---------------- Settings & Data ----------------
export function settingsView(ctx) {
  const st = ctx.ws.state; const s = st.settings;
  const ui = ctx.ui.settings || (ctx.ui.settings = { restore: null, error: null, storage: null });
  if (!ui.storage) { ui.storage = 'checking'; Promise.all([navigator.storage?.persisted?.() ?? null, navigator.storage?.estimate?.() ?? null]).then(([persisted, est]) => { ui.storage = { persisted, usage: est?.usage ?? null }; if (ctx.route() === 'settings') ctx.refresh(); }).catch(() => { ui.storage = { persisted: null, usage: null }; }); }
  const name = h('input', { type: 'text', value: s.businessName, maxlength: '100' }); const tz = h('input', { type: 'text', value: s.timezone });
  const win = h('input', { type: 'number', min: '0', max: '60', step: '1', value: String(s.matchWindowDays) }); const actor = h('input', { type: 'text', value: s.actorLabel, maxlength: '40' });
  const accountForm = (a) => formDialog({ title: a ? `Edit account ${a.id}` : 'Add account', fields: [
    a ? null : { name: 'id', label: 'Account ID', required: true, help: 'Short code used in your CSV files, e.g. GCASH or BDO. Cannot be changed later.' },
    { name: 'label', label: 'Label', required: true, value: a?.label }, a ? null : { name: 'type', label: 'Type', type: 'select', options: ACCOUNT_TYPES.map((t) => [t, t === 'CASH' ? 'Cash' : t === 'EWALLET' ? 'E-wallet' : 'Bank']) },
    { name: 'active', label: 'Active (accepts new receipts)', type: 'checkbox', value: a ? a.active : true }].filter(Boolean),
  onSubmit: async (v) => { await ctx.ws.saveAccount({ id: a ? a.id : v.id, type: a ? a.type : v.type, label: v.label, active: v.active }); ctx.done('Account saved.'); } });
  const doBackup = async () => {
    if (!(await confirmDialog({ title: 'Backup contains business data', message: 'The backup file is not encrypted. Anyone who opens it can read your records. Keep it somewhere only you can access.', confirmLabel: 'Download backup' }))) return;
    await ctx.act(async () => { const b = await ctx.ws.backup(); downloadFile(`closecheck_backup_${ctx.workspace}_${ctx.today()}.json`, JSON.stringify(b), 'application/json'); await ctx.ws.saveSettings({ lastBackupAt: b.exportedAt }); try { navigator.storage?.persist?.(); } catch { /* optional */ } }, 'Backup download started. Check that the file was actually saved.');
  };
  const onRestoreFile = async (e) => {
    const file = e.target.files[0]; if (!file) return; ui.restore = null; ui.error = null;
    try {
      if (file.size > 100 * 1024 * 1024) throw new Error('This file is too large to be a CloseCheck backup.');
      let parsed; try { parsed = JSON.parse(await file.text()); } catch { throw new Error('This file is not valid JSON, so it is not a CloseCheck backup.'); }
      const v = await validateBackup(parsed);
      if (!v.ok) throw new Error(v.errors.join(' '));
      ui.restore = { v, name: file.name };
    } catch (err) { ui.error = err.message; }
    ctx.refresh();
  };
  const sumCounts = (c) => `${c.sales} sale(s), ${c.receipts} receipt(s), ${c.allocations} allocation(s), ${c.snapshots} saved report(s)`;
  const current = Object.fromEntries(STORES.map((k) => [k, st[k].length]));
  const doRestore = async () => {
    if (!(await confirmDialog({ title: 'Replace this workspace?', message: `Everything now in this workspace (${sumCounts(current)}) will be replaced by the backup (${sumCounts(ui.restore.v.summary.counts)}). This cannot be undone. Export a backup of the current workspace first if you may need it.`, confirmLabel: 'Replace workspace', danger: true }))) return;
    await ctx.act(async () => { await ctx.ws.restore(ui.restore.v); ui.restore = null; }, 'Workspace restored from backup.');
  };
  const doDelete = async () => {
    if (!(await confirmDialog({ title: 'Delete all CloseCheck data in this browser?', message: 'This deletes your workspace and the sample workspace from this browser. It cannot be undone and cannot delete files you already downloaded. Export a backup first if you may need the data.', confirmLabel: 'Delete everything', danger: true }))) return;
    try { await ctx.deleteLocalData(); ctx.toast('Local data deleted.'); } catch (e) { ctx.toast(`Could not delete: ${e.message}`, 'error'); }
  };
  const storage = ui.storage && ui.storage !== 'checking' ? ui.storage : null;
  return h('div', {}, head('Settings & Data'),
    section('Business', h('div', { class: 'grid' }, field('Business display name', name), field('Currency', h('input', { type: 'text', value: 'PHP (Philippine peso)', disabled: true })), field('Business time zone', tz, 'IANA name, e.g. Asia/Manila. Decides which business date a timestamp belongs to.'), field('Reference matching window (days)', win, 'A receipt may match by reference from the sale date up to this many days later.'), field('Your name label for the history', actor, 'A plain label. It is not a login and does not verify identity.')),
      h('div', { class: 'actions start' }, btn('Save settings', () => ctx.act(() => ctx.ws.saveSettings({ businessName: name.value, timezone: tz.value.trim(), matchWindowDays: win.value, actorLabel: actor.value }), 'Settings saved.'), { kind: 'primary' }))),
    section('Payment accounts', table('Accounts', [{ label: 'ID', cell: (a) => a.id }, { label: 'Label', cell: (a) => a.label }, { label: 'Type', cell: (a) => a.type }, { label: 'Status', cell: (a) => chip(a.active ? 'Active' : 'Inactive', a.active ? 'ok' : 'neutral') }, { label: '', cell: (a) => btn('Edit', () => accountForm(a), { kind: 'small' }) }], st.accounts.slice().sort((a, b) => (a.id < b.id ? -1 : 1))),
      h('div', { class: 'actions start' }, btn('Add account', () => accountForm(null)))),
    section('Backup',
      h('p', {}, 'Your records exist only in this browser profile. They can disappear if browser data is cleared, the browser evicts storage, you use private browsing, or the device is lost. Safari may remove data for sites not visited for seven days. A backup file is the only copy you control.'),
      dl([['Last backup export started', s.lastBackupAt ? ctx.when(s.lastBackupAt) : 'Never'], ['Storage in use', ctx.storageNote ? 'Memory only: NOT saved on this device' : 'IndexedDB in this browser'], storage && ['Protected from automatic eviction', storage.persisted === null ? 'Unknown in this browser' : storage.persisted ? 'Yes' : 'No (best effort)'], storage && storage.usage !== null && ['Approximate space used by this site', `${(storage.usage / 1048576).toFixed(2)} MB`]]),
      h('div', { class: 'actions start' }, btn('Export full backup (JSON)', doBackup, { kind: 'primary' }),
        storage && storage.persisted === false && navigator.storage?.persist ? btn('Ask browser to keep data', async () => { const ok = await navigator.storage.persist(); ui.storage = null; ctx.toast(ok ? 'The browser agreed to keep this data unless you clear it.' : 'The browser did not grant persistent storage. Keep exporting backups.', ok ? 'ok' : 'error'); ctx.refresh(); }) : null),
      h('p', { class: 'help' }, 'A reminder or a started download is not proof that the file was kept. Open your downloads folder and check.')),
    section('Restore from backup',
      h('p', {}, 'Restoring replaces this whole workspace with the backup. Nothing is merged. The file is checked before anything changes.'),
      field('Backup file (.json)', h('input', { type: 'file', accept: '.json,application/json', onchange: onRestoreFile })),
      ui.error ? notice('error', h('strong', {}, 'Backup rejected. Your workspace was not changed. '), ui.error) : null,
      ui.restore ? [notice('ok', `${ui.restore.name} passed validation.`), dl([['Business', ui.restore.v.summary.businessName || '—'], ['Exported', ctx.when(ui.restore.v.summary.exportedAt)], ['App / schema version', `${ui.restore.v.summary.appVersion} / ${ui.restore.v.summary.schemaVersion}`], ['Backup contains', sumCounts(ui.restore.v.summary.counts)], ['This workspace now contains', sumCounts(current)]]),
        h('div', { class: 'actions start' }, btn('Replace workspace with this backup', doRestore, { kind: 'danger' }), btn('Cancel', () => { ui.restore = null; ctx.refresh(); }))] : null),
    section('Workspaces', h('p', {}, ctx.workspace === 'sample' ? 'You are in the sample workspace (synthetic data).' : 'You are in your own workspace.'),
      h('div', { class: 'actions start' }, ctx.workspace === 'sample' ? btn('Switch to my own workspace', () => ctx.switchWorkspace('main'), { kind: 'primary' }) : btn('Open the sample workspace', () => ctx.switchWorkspace('sample')),
        ctx.workspace === 'sample' ? btn('Reset sample data', async () => { if (await confirmDialog({ title: 'Reset sample data?', message: 'The sample workspace is cleared and loaded again with fresh synthetic data.', confirmLabel: 'Reset' })) { try { await ctx.ws.repo.replaceAll(Object.fromEntries(STORES.map((k) => [k, []])), null); await ctx.switchWorkspace('sample'); ctx.toast('Sample data reset.'); } catch (e) { ctx.toast(`Could not reset: ${e.message}`, 'error'); } } }) : null)),
    section('Privacy and limits', h('ul', {},
      h('li', {}, 'Files you choose are read by this page in your browser. The app sends no analytics and makes no network requests with your data; its security policy blocks outgoing connections from app code.'),
      h('li', {}, 'Loading the page itself is a normal web request to the host (GitHub Pages), which may log your IP address like any website.'),
      h('li', {}, 'Data is not encrypted in the browser. Anyone who can use this browser profile can read it. There is deliberately no password screen, because it would not protect the data.'),
      h('li', {}, 'Other pages published on the same web address (same origin) could technically read this data. Use a site address that hosts only CloseCheck.'),
      h('li', {}, 'CloseCheck does not ask for bank credentials or card numbers. Do not put them in notes.')),
      h('p', { class: 'help' }, `CloseCheck v${ctx.version} · open source under the MIT License · provided without warranty.`)),
    section('Delete local data', h('p', {}, 'Removes all CloseCheck data stored by this browser for this site.'), h('div', { class: 'actions start' }, btn('Delete all local data', doDelete, { kind: 'danger' }))));
}
