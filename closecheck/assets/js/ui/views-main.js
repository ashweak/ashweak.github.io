// Overview, Import, Sales, Receipts screens.
import { formatPHP } from '../domain/money.js';
import { parseCsv } from '../domain/csv.js';
import { DATE_FORMATS } from '../domain/dates.js';
import { live, saleBalances, receiptAvailability, salesCohort, receiptActivity, cashDays } from '../domain/calc.js';
import { issuesInRange } from '../domain/issues.js';
import { MAX_FILE_BYTES, MAX_ROWS, decodeUtf8, suggestMapping, fieldsFor } from '../data/importer.js';
import { SALES_TEMPLATE, RECEIPTS_TEMPLATE } from '../data/sample.js';
import { h, btn, chip, money, field, select, section, table, notice, downloadFile, openDialog, formDialog } from './dom.js';
import { periodBar, openSale, openReceipt, saleForm, receiptForm, saleChip, receiptChip, withConfirm } from './details.js';

const head = (title, lead) => [h('h1', { tabindex: '-1' }, title), lead ? h('p', { class: 'lead' }, lead) : null];
const max = (a, b) => (a > b ? a : b);
const tile = (label, value, sub, route, tone = '') => h('a', { class: `tile ${tone}`, href: `#/${route}` }, h('span', { class: 'tile-label' }, label), h('span', { class: 'tile-value' }, value), h('span', { class: 'tile-sub' }, sub));

export function overview(ctx) {
  const st = ctx.ws.state; const today = ctx.today(); const p = ctx.period; const cutoff = max(p.to, today);
  const sales = salesCohort(st, p, cutoff).totals; const rec = receiptActivity(st, p).totals;
  const issues = issuesInRange(ctx.ws.issues(today), p); const cash = cashDays(st, p); const cov = ctx.ws.coverage(p);
  const count = (s) => cash.filter((d) => d.status === s).length;
  let cashValue = 'No cash activity'; let cashSub = 'Nothing to check for this period'; let cashTone = '';
  if (cash.length === 1 && cash[0].status !== 'INCOMPLETE') { cashValue = formatPHP(cash[0].variance); cashSub = cash[0].variance === 0 ? 'Counted cash equals expected cash' : `Counted ${formatPHP(cash[0].counted)} vs expected ${formatPHP(cash[0].expected)}`; cashTone = cash[0].variance < 0 ? 'bad' : cash[0].variance > 0 ? 'warn' : 'good'; }
  else if (cash.length) { cashValue = count('INCOMPLETE') ? 'Cash check incomplete' : `${count('VARIANCE')} day(s) with variance`; cashSub = `${count('BALANCED')} balanced · ${count('VARIANCE')} with variance · ${count('INCOMPLETE')} incomplete`; cashTone = count('INCOMPLETE') || count('VARIANCE') ? 'warn' : 'good'; }
  const lastBackup = st.settings.lastBackupAt; const hasData = st.sales.length + st.receipts.length > 0;
  const intro = st.settings.introDismissed ? null : section('Before you close for the day, know which records match and which need checking',
    h('p', {}, 'CloseCheck compares the sales you recorded with the receipts you recorded, lists balances that are still open, and compares expected cash with counted cash.'),
    h('ul', {}, h('li', {}, h('strong', {}, 'What a match means: '), 'the records you supplied agree with each other. It does not prove either record is genuine or complete.'),
      h('li', {}, h('strong', {}, 'What it does not do: '), 'it does not connect to a bank or e-wallet, check screenshots, detect theft, or replace bookkeeping.'),
      h('li', {}, h('strong', {}, 'Where your data lives: '), 'only in this browser on this device. It is not uploaded. It can be lost if browser data is cleared, so export backups.')),
    h('div', { class: 'actions start' }, ctx.workspace === 'sample' ? null : btn('Try it with sample data', () => ctx.switchWorkspace('sample'), { kind: 'primary' }), btn(ctx.workspace === 'sample' ? 'Got it' : 'Start with my own records', () => ctx.act(() => ctx.ws.saveSettings({ introDismissed: true })))));
  return h('div', {}, head('Overview', `Business date today: ${today} (${st.settings.timezone}).`), intro, periodBar(ctx),
    hasData && (!lastBackup || ctx.when(lastBackup).slice(0, 10) < today) ? notice('info', lastBackup ? `Last backup export was started on ${ctx.when(lastBackup).slice(0, 10)}. ` : 'No backup has been exported yet. ', h('a', { href: '#/settings' }, 'Export a backup'), ' after important changes.') : null,
    h('div', { class: 'tiles' },
      tile('Coverage', `${cov.batches.length} import(s)`, `${cov.manualSales + cov.manualReceipts} manual entr${cov.manualSales + cov.manualReceipts === 1 ? 'y' : 'ies'}${cov.rowsNotImported ? ` · ${cov.rowsNotImported} row(s) not imported` : ''}${!cov.hasSales ? ' · no sales recorded' : ''}${!cov.hasReceipts ? ' · no receipts recorded' : ''}`, 'import', !cov.hasSales || !cov.hasReceipts ? 'warn' : ''),
      tile('Recorded sales', formatPHP(sales.netDue), `${sales.count} sale(s), net of ${formatPHP(sales.credited)} credits`, 'sales'),
      tile('Allocated receipts', formatPHP(rec.allocated), `of ${formatPHP(rec.gross)} received in ${rec.count} receipt(s)`, 'receipts'),
      tile('Unpaid balances', formatPHP(sales.outstanding), `on sales in this period, as of ${cutoff}`, 'sales', sales.outstanding ? 'warn' : 'good'),
      tile('Unapplied receipts', formatPHP(rec.unapplied), 'received but not applied to any sale', 'receipts', rec.unapplied ? 'warn' : 'good'),
      tile('Open issues', String(issues.length), issues.length ? 'need review for this period' : 'nothing flagged for this period', 'review', issues.length ? 'warn' : 'good'),
      tile('Cash variance', cashValue, cashSub, 'cash', cashTone),
      sales.liability ? tile('Refunds due', formatPHP(sales.liability), 'credited but not yet refunded', 'review', 'warn') : null),
    section('Daily steps', h('ol', { class: 'steps' },
      h('li', {}, h('a', { href: '#/cash' }, 'Enter opening cash'), ' if you reconcile cash.'), h('li', {}, h('a', { href: '#/import' }, 'Import or enter'), ' today’s sales and receipts.'),
      h('li', {}, h('a', { href: '#/review' }, 'Run matching and review'), ' anything flagged.'), h('li', {}, h('a', { href: '#/cash' }, 'Enter cash movements and counted cash'), '.'),
      h('li', {}, h('a', { href: '#/reports' }, 'Save the report'), ', even if items remain open.'), h('li', {}, h('a', { href: '#/settings' }, 'Export a backup'), '.'))));
}

// ---------------- Import ----------------
export function importView(ctx) {
  const st = ctx.ws.state;
  const imp = ctx.ui.imp || (ctx.ui.imp = { kind: 'sales', file: null, mapping: null, preview: null, done: null, error: null });
  const reset = () => { imp.file = null; imp.mapping = null; imp.preview = null; imp.error = null; };
  const fileInput = h('input', { type: 'file', accept: '.csv,text/csv', id: 'import-file', onchange: async (e) => {
    const file = e.target.files[0]; if (!file) return;
    reset(); imp.done = null;
    try {
      if (file.size > MAX_FILE_BYTES) throw new Error(`This file is ${(file.size / 1048576).toFixed(1)} MB. The supported limit is 5 MB; split it into smaller files.`);
      if (file.size === 0) throw new Error('This file is empty.');
      const bytes = new Uint8Array(await file.arrayBuffer()); const text = decodeUtf8(bytes);
      imp.file = { name: file.name, bytes, text }; imp.mapping = suggestMapping(imp.kind, parseCsv(text).headers);
    } catch (err) { imp.error = err.message; }
    ctx.refresh();
  } });
  const kindPicker = h('fieldset', { class: 'inline' }, h('legend', {}, 'What are you importing?'),
    ['sales', 'receipts'].map((k) => h('label', { class: 'check' }, h('input', { type: 'radio', name: 'kind', value: k, checked: imp.kind === k, onchange: () => { imp.kind = k; reset(); ctx.refresh(); } }), h('span', {}, k === 'sales' ? 'Sales list' : 'Receipt records (cash, e-wallet, bank)'))));

  let mappingCard = null;
  if (imp.file && imp.mapping && !imp.preview) {
    const m = imp.mapping; const headers = parseCsv(imp.file.text, m.delimiter).headers; const opts = [['', '— not in file —'], ...headers.map((x) => [x, x])];
    const set = (key) => (e) => { m[key] = e.target.type === 'checkbox' ? e.target.checked : e.target.value; };
    mappingCard = section(`Step 2 · Match columns for ${imp.file.name}`,
      h('p', { class: 'help' }, 'Confirm what each column means. CloseCheck never guesses date or number formats.'),
      h('div', { class: 'grid' }, fieldsFor(imp.kind).map((f) => field(`${f.label}${f.required ? ' (required)' : ''}`, select(opts, m.columns[f.name], { onchange: (e) => { m.columns[f.name] = e.target.value; } })))),
      h('div', { class: 'grid' },
        field('Date format', select([['ISO', 'YYYY-MM-DD (ISO)'], ['MDY', 'MM/DD/YYYY (month first)'], ['DMY', 'DD/MM/YYYY (day first)']].filter(([v]) => DATE_FORMATS.includes(v)), m.dateFormat, { onchange: set('dateFormat') })),
        field('Number format', select([['plain', '1000.50'], ['comma', '1,000.50'], ['dot', '1.000,50']], m.numberFormat, { onchange: set('numberFormat') })),
        field('Column separator', select([[',', 'Comma'], [';', 'Semicolon'], ['\t', 'Tab']], m.delimiter, { onchange: (e) => { m.delimiter = e.target.value; imp.mapping = { ...suggestMapping(imp.kind, parseCsv(imp.file.text, m.delimiter).headers), delimiter: m.delimiter }; ctx.refresh(); } })),
        imp.kind === 'receipts' ? field('Account for all rows', select([['', '— use the account column —'], ...st.accounts.filter((a) => a.active).map((a) => [a.id, `${a.id} — ${a.label}`])], m.fixedAccount, { onchange: set('fixedAccount') }), 'Only used when no account column is mapped.') : null,
        imp.kind === 'receipts' ? field('Transaction status column', select(opts, m.statusColumn, { onchange: set('statusColumn') }), 'Optional. Rows that are not completed are excluded.') : null,
        imp.kind === 'receipts' ? field('Status values that mean completed', h('input', { type: 'text', value: m.completedValues, placeholder: 'e.g. SUCCESS, COMPLETED', onchange: set('completedValues') })) : null),
      imp.kind === 'receipts' ? h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: m.assumeLocal, onchange: set('assumeLocal') }), h('span', {}, `I confirm that times without a time zone are in the business time zone (${st.settings.timezone}).`)) : null,
      imp.kind === 'receipts' ? h('p', { class: 'help' }, 'By importing, you confirm these rows are completed transactions, not pending or failed ones.') : null,
      h('div', { class: 'actions start' }, btn('Preview import', async () => { try { imp.preview = await ctx.ws.previewImport(imp.kind, imp.file.bytes, imp.file.text, m, imp.file.name); } catch (e) { imp.error = e.message; } ctx.refresh(); }, { kind: 'primary' }), btn('Discard file', () => { reset(); ctx.refresh(); })));
  }

  let previewCard = null;
  if (imp.preview) {
    const p = imp.preview; const c = p.counts; const problems = p.rows.filter((r) => r.status !== 'valid'); const good = p.rows.filter((r) => r.status === 'valid');
    const show = (o) => Object.entries(o).filter(([, v]) => v !== '').map(([k, v]) => `${k}=${v}`).join(' · ');
    previewCard = section(`Step 3 · Preview of ${p.filename}`,
      notice('info', h('strong', {}, 'Nothing has been saved yet. '), 'Review the counts, then confirm.'),
      p.fatal.length ? [notice('error', h('strong', {}, 'This file cannot be imported: '), h('ul', {}, p.fatal.map((x) => h('li', {}, x)))), h('div', { class: 'actions start' }, btn('Back to column matching', () => { imp.preview = null; ctx.refresh(); }), btn('Discard file', () => { reset(); ctx.refresh(); }))] : [
        h('ul', { class: 'counts' }, h('li', {}, h('strong', {}, String(c.total)), ' data rows read'), h('li', {}, h('strong', {}, String(c.valid)), ' will be imported'), h('li', {}, h('strong', {}, String(c.invalid)), ' need a correction (not imported)'), h('li', {}, h('strong', {}, String(c.identical)), ' already present (skipped)'), h('li', {}, h('strong', {}, String(c.conflict)), ' conflict with an existing ID (quarantined)'), h('li', {}, h('strong', {}, String(c.excluded)), ' excluded by status')),
        p.coverage ? h('p', {}, `Dates covered by importable rows: ${p.coverage.from} to ${p.coverage.to}.`) : null,
        problems.length ? [h('h3', {}, 'Rows that will not be imported'), table('Rows that will not be imported', [{ label: 'Row', cell: (r) => r.rowNumber }, { label: 'Result', cell: (r) => chip(r.status === 'invalid' ? 'Needs correction' : r.status === 'identical' ? 'Skipped' : r.status === 'conflict' ? 'Quarantined' : 'Excluded', r.status === 'identical' ? 'neutral' : 'warn') }, { label: 'Why', cell: (r) => r.errors.join('; ') }, { label: 'Values read', cell: (r) => show(r.original) }], problems, { limit: 50 })] : null,
        good.length ? [h('h3', {}, 'First rows that will be imported'), table('Sample of rows to import', [{ label: 'Row', cell: (r) => r.rowNumber }, { label: 'ID', cell: (r) => r.record.sourceId }, { label: 'Date', cell: (r) => r.record.date }, { label: 'Amount', num: true, cell: (r) => money(p.kind === 'sales' ? r.record.totalDue : r.record.gross) }, { label: 'Account', cell: (r) => (p.kind === 'sales' ? r.record.expectedAccount : r.record.accountId) || '—' }], good.slice(0, 10))] : null,
        h('div', { class: 'actions start' },
          btn(c.valid ? `Import ${c.valid} row(s)` : 'Record this import attempt', () => ctx.act(async () => { imp.done = await ctx.ws.commitImport(p); reset(); try { navigator.storage?.persist?.(); } catch { /* optional */ } }, 'Import saved.'), { kind: 'primary', disabled: c.valid + c.invalid + c.conflict + c.excluded === 0 }),
          btn('Back to column matching', () => { imp.preview = null; ctx.refresh(); }), btn('Discard file', () => { reset(); ctx.refresh(); }))]);
  }

  const batches = st.batches.slice().sort((a, b) => (a.importedAt < b.importedAt ? 1 : -1));
  const rowLog = (b) => openDialog(`Rows not imported from ${b.filename}`, () => table('Row log', [{ label: 'Row', cell: (r) => r.row }, { label: 'Result', cell: (r) => r.status }, { label: 'Why', cell: (r) => r.errors.join('; ') }, { label: 'Values read', cell: (r) => Object.entries(r.original).filter(([, v]) => v !== '').map(([k, v]) => `${k}=${v}`).join(' · ') }], b.rowLog, { empty: 'Every row in this file was imported.' }), { wide: true });
  return h('div', {}, head('Import', 'Bring in a sales list or receipt records as CSV, or enter records by hand on the Sales and Receipts screens.'),
    imp.error ? notice('error', imp.error) : null,
    imp.done ? notice('ok', `Saved ${imp.done.counts.valid} row(s) from ${imp.done.filename}. `, btn('Run matching now', () => ctx.act(async () => { const n = await ctx.ws.runMatching(); imp.done = null; ctx.toast(`${n} receipt(s) matched from imported records.`); ctx.go('review'); }), { kind: 'small' })) : null,
    section('Step 1 · Choose a file', kindPicker,
      h('p', { class: 'help' }, `UTF-8 CSV only, up to 5 MB and ${MAX_ROWS.toLocaleString('en-US')} rows. The file is read in this browser and is not uploaded. Use synthetic or your own data only.`),
      h('div', { class: 'actions start' }, field('CSV file', fileInput),
        btn('Download sales template', () => downloadFile('closecheck_sales_template.csv', SALES_TEMPLATE, 'text/csv')), btn('Download receipts template', () => downloadFile('closecheck_receipts_template.csv', RECEIPTS_TEMPLATE, 'text/csv')))),
    mappingCard, previewCard,
    section('Import history', table('Import history', [
      { label: 'File', cell: (b) => [b.filename, ' ', b.removedAt ? chip('Removed') : null] }, { label: 'Type', cell: (b) => b.kind }, { label: 'Imported', cell: (b) => ctx.when(b.importedAt) },
      { label: 'Dates covered', cell: (b) => (b.coverage ? `${b.coverage.from} to ${b.coverage.to}` : '—') }, { label: 'Imported', num: true, cell: (b) => b.counts.valid }, { label: 'Not imported', num: true, cell: (b) => b.counts.total - b.counts.valid },
      { label: '', cell: (b) => [btn('Row log', () => rowLog(b), { kind: 'small' }), ' ', b.removedAt ? null : btn('Remove', () => formDialog({ title: `Remove import ${b.filename}`, intro: 'Its rows are voided (kept in history, excluded from totals). Allocations that used them are reversed.', danger: true, submitLabel: 'Remove import', fields: [{ name: 'reason', label: 'Reason', type: 'textarea', required: true }], onSubmit: async (v) => { await withConfirm((confirm) => ctx.ws.removeBatch(b.id, v.reason, { confirm })); ctx.done('Import removed.'); } }), { kind: 'small' })] },
    ], batches, { empty: 'No files imported yet.' })));
}

// ---------------- Sales & Receipts ----------------
function filters(ctx, key, statuses) {
  const f = ctx.ui[key] || (ctx.ui[key] = { all: false, status: '', q: '' });
  const bar = h('div', { class: 'toolbar' },
    h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: f.all, onchange: (e) => { f.all = e.target.checked; ctx.refresh(); } }), h('span', {}, 'All dates')),
    field('Status', select(statuses, f.status, { onchange: (e) => { f.status = e.target.value; ctx.refresh(); } })),
    field('Find ID or reference', h('input', { type: 'search', value: f.q, onchange: (e) => { f.q = e.target.value.trim(); ctx.refresh(); } })));
  return { f, bar };
}
const byDateDesc = (a, b) => (a.date === b.date ? (a.sourceId < b.sourceId ? -1 : 1) : a.date < b.date ? 1 : -1);

export function salesView(ctx) {
  const st = ctx.ws.state; const bal = saleBalances(st); const p = ctx.period;
  const { f, bar } = filters(ctx, 'sales', [['', 'All'], ['OPEN', 'With outstanding balance'], ['SETTLED', 'Settled'], ['REFUND_DUE', 'Refund due'], ['VOIDED', 'Voided']]);
  const q = f.q.toLowerCase();
  const rows = st.sales.filter((s) => {
    if (!f.all && (s.date < p.from || s.date > p.to)) return false;
    if (q && !`${s.sourceId} ${s.expectedReference} ${s.customerLabel}`.toLowerCase().includes(q)) return false;
    if (f.status === 'VOIDED') return !!s.voidedAt;
    if (s.voidedAt) return false;
    const b = bal.get(s.id);
    return f.status === '' || (f.status === 'OPEN' ? b.outstanding > 0 : b.status === f.status);
  }).sort(byDateDesc);
  const z = { credit: 0, netAllocated: 0, outstanding: 0, status: 'UNPAID' };
  return h('div', {}, head('Sales', 'Recorded sales and what has been allocated to each.'), f.all ? null : periodBar(ctx), bar,
    h('div', { class: 'actions start' }, btn('Add sale', () => saleForm(ctx), { kind: 'primary' })),
    table('Sales', [
      { label: 'Sale ID', cell: (s) => btn(s.sourceId, () => openSale(ctx, s.id), { kind: 'link' }) }, { label: 'Date', cell: (s) => s.date }, { label: 'Customer', cell: (s) => s.customerLabel || '—' },
      { label: 'Due', num: true, cell: (s) => money(s.totalDue) }, { label: 'Credits', num: true, cell: (s) => money((bal.get(s.id) || z).credit) }, { label: 'Net paid', num: true, cell: (s) => money((bal.get(s.id) || z).netAllocated) },
      { label: 'Outstanding', num: true, cell: (s) => money((bal.get(s.id) || z).outstanding) }, { label: 'Status', cell: (s) => saleChip(s, bal.get(s.id) || z) },
    ], rows, { empty: f.all ? 'No sales match these filters.' : 'No sales in this period. Change the period, tick “All dates”, or add a sale.' }));
}

export function receiptsView(ctx) {
  const st = ctx.ws.state; const avail = receiptAvailability(st); const p = ctx.period;
  const { f, bar } = filters(ctx, 'receipts', [['', 'All'], ['UNAPPLIED', 'With unapplied amount'], ['ALLOCATED', 'Fully allocated'], ['VOIDED', 'Voided'], ...st.accounts.map((a) => [`ACC:${a.id}`, `Account ${a.id}`])]);
  const q = f.q.toLowerCase(); const z = { allocated: 0, available: 0 };
  const rows = st.receipts.filter((r) => {
    if (!f.all && (r.date < p.from || r.date > p.to)) return false;
    if (q && !`${r.sourceId} ${r.reference} ${r.saleSourceId}`.toLowerCase().includes(q)) return false;
    if (f.status === 'VOIDED') return !!r.voidedAt;
    if (!live(r)) return false;
    const a = avail.get(r.id);
    if (f.status.startsWith('ACC:')) return r.accountId === f.status.slice(4);
    return f.status === '' || (f.status === 'UNAPPLIED' ? a.available > 0 : a.available === 0);
  }).sort(byDateDesc);
  return h('div', {}, head('Receipts', 'Recorded payments received and how much of each is applied to sales.'), f.all ? null : periodBar(ctx), bar,
    h('div', { class: 'actions start' }, btn('Add receipt', () => receiptForm(ctx), { kind: 'primary' })),
    table('Receipts', [
      { label: 'Receipt ID', cell: (r) => btn(r.sourceId, () => openReceipt(ctx, r.id), { kind: 'link' }) }, { label: 'Account', cell: (r) => r.accountId }, { label: 'Date', cell: (r) => r.date },
      { label: 'Gross', num: true, cell: (r) => money(r.gross) }, { label: 'Fee', num: true, cell: (r) => money(r.fee) }, { label: 'Reference', cell: (r) => r.reference || '—' },
      { label: 'Unapplied', num: true, cell: (r) => money((avail.get(r.id) || z).available) }, { label: 'Status', cell: (r) => receiptChip(r, avail.get(r.id) || z) },
    ], rows, { empty: f.all ? 'No receipts match these filters.' : 'No receipts in this period. Change the period, tick “All dates”, or add a receipt.' }));
}
