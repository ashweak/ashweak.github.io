// Application layer: every user action validates, builds one atomic change set, commits it,
// and only then updates in-memory state. Nothing here touches the DOM.
import { UserError, ConfirmError } from '../domain/errors.js';
import { parseAmount, isCentavos, sum } from '../domain/money.js';
import { isDateString, isValidTimeZone, dateInZone } from '../domain/dates.js';
import { normalizeSale, normalizeReceipt, receiptKey, ACCOUNT_TYPES } from '../domain/validate.js';
import { idx, live, saleBalances, receiptAvailability, activeAllocations, reportTotals, cashCloseId, cashDays } from '../domain/calc.js';
import { runMatching } from '../domain/matching.js';
import { deriveIssues, issuesInRange, ISSUE_STATES } from '../domain/issues.js';
import { STORES, SCHEMA_VERSION } from './repo.js';
import { buildPreview, sha256Hex } from './importer.js';
import { buildBackup } from './backup.js';
import { SAMPLE_ACCOUNTS, sampleCsv } from './sample.js';

export const APP_VERSION = '1.0.0';
export const DEFAULT_SETTINGS = Object.freeze({ businessName: '', currency: 'PHP', timezone: 'Asia/Manila', schemaVersion: SCHEMA_VERSION, matchWindowDays: 7, actorLabel: 'Owner', lastBackupAt: null, introDismissed: false });
const FINANCIAL = ['accounts', 'sales', 'receipts', 'allocations', 'credits', 'refunds', 'cashMovements', 'cashCloses'];

function applyPuts(state, puts, settings) {
  const next = { ...state };
  for (const [store, records] of Object.entries(puts)) {
    if (!records.length) continue;
    const map = new Map(state[store].map((r) => [r.id, r]));
    for (const r of records) map.set(r.id, r);
    next[store] = [...map.values()];
  }
  if (settings) next.settings = settings;
  return next;
}
const need = (cond, msg) => { if (!cond) throw new UserError(msg); };
const reasonOf = (v) => { const s = String(v ?? '').trim(); need(s !== '', 'Enter a reason. It is kept in the history.'); need(s.length <= 500, 'Reason is too long (500 characters max).'); return s; };
function money(v, label, { allowZero = false } = {}) {
  if (typeof v === 'number') { need(isCentavos(v) && (allowZero || v > 0), `${label} is not a valid amount`); return v; }
  const p = parseAmount(v, 'plain');
  need(p.ok, `${label}: ${p.error}`); need(allowZero || p.value > 0, `${label} must be greater than zero`);
  return p.value;
}
const dateOf = (v, label) => { need(isDateString(v), `${label} must be a valid date`); return v; };

export class Workspace {
  constructor(repo, { now = () => new Date().toISOString(), newId = () => globalThis.crypto.randomUUID() } = {}) {
    this.repo = repo; this.now = now; this.newId = newId; this.state = null;
  }

  async load() {
    const d = await this.repo.loadAll();
    const fresh = !d.settings;
    this.state = { ...d, settings: { ...DEFAULT_SETTINGS, ...(d.settings || {}) } };
    if (fresh) await this._commit({ puts: { accounts: [{ id: 'CASH', label: 'Cash drawer', type: 'CASH', active: true }] }, settings: this.state.settings }, []);
    return this.state;
  }

  async _commit({ puts = {}, settings }, events) {
    const at = this.now(); const actor = this.state.settings.actorLabel || 'Owner';
    puts = { ...puts };
    if (events.length) puts.events = events.map((e) => ({ id: this.newId(), at, actor, ...e }));
    let next = applyPuts(this.state, puts, settings);
    if (FINANCIAL.some((s) => puts[s]?.length)) {
      const stale = [];
      for (const s of next.snapshots) {
        if (s.status === 'SUPERSEDED' || puts.snapshots?.some((p) => p.id === s.id)) continue;
        if (JSON.stringify(reportTotals(next, s.range, s.cutoff)) !== JSON.stringify(s.totals)) stale.push({ ...s, status: 'SUPERSEDED', supersededAt: at, supersededReason: 'Underlying records changed after this report was saved' });
      }
      if (stale.length) { puts.snapshots = [...(puts.snapshots || []), ...stale]; next = applyPuts(next, { snapshots: stale }); }
    }
    const rev = await this.repo.commit({ puts, settings }, this.state.rev); // throws => state is untouched
    next.rev = rev; this.state = next;
  }

  // ---- settings and accounts ----
  async saveSettings(patch) {
    const s = { ...this.state.settings };
    if ('businessName' in patch) { s.businessName = String(patch.businessName).trim(); need(s.businessName.length <= 100, 'Business name is too long'); }
    if ('timezone' in patch) { need(isValidTimeZone(patch.timezone), 'Enter a valid time zone such as Asia/Manila'); s.timezone = patch.timezone; }
    if ('matchWindowDays' in patch) { const n = Number(patch.matchWindowDays); need(Number.isInteger(n) && n >= 0 && n <= 60, 'Matching window must be a whole number of days from 0 to 60'); s.matchWindowDays = n; }
    if ('actorLabel' in patch) { s.actorLabel = String(patch.actorLabel).trim() || 'Owner'; need(s.actorLabel.length <= 40, 'Name label is too long'); }
    for (const k of ['lastBackupAt', 'introDismissed']) if (k in patch) s[k] = patch[k];
    await this._commit({ settings: s }, 'lastBackupAt' in patch || 'introDismissed' in patch ? [] : [{ entityType: 'settings', entityId: 'settings', action: 'UPDATE', old: this.state.settings, new: s, reason: '' }]);
  }
  async saveAccount({ id, label, type, active = true }) {
    id = String(id ?? '').trim(); label = String(label ?? '').trim();
    need(/^[A-Za-z0-9_-]{1,30}$/.test(id), 'Account ID must be 1–30 letters, digits, hyphens or underscores');
    need(label !== '' && label.length <= 60, 'Enter a label (60 characters max)');
    const old = this.state.accounts.find((a) => a.id === id);
    if (old) need(old.type === type, 'The account type cannot be changed after creation');
    else need(ACCOUNT_TYPES.includes(type), 'Choose an account type');
    const rec = { id, label, type, active: !!active };
    await this._commit({ puts: { accounts: [rec] } }, [{ entityType: 'account', entityId: id, action: old ? 'UPDATE' : 'CREATE', old: old || null, new: rec, reason: '' }]);
  }

  // ---- helpers ----
  _opts() { return { dateFormat: 'ISO', numberFormat: 'plain', accounts: idx(this.state).accountsById, timeZone: this.state.settings.timezone, assumeLocal: true }; }
  _sale(id) { const s = idx(this.state).salesById.get(id); need(live(s), 'That sale no longer exists'); return s; }
  _receipt(id) { const r = idx(this.state).receiptsById.get(id); need(live(r), 'That receipt no longer exists'); return r; }
  /** Reverse allocations; refuses when recorded refunds would exceed the payments left. */
  _reverse(allocs, reason, at) {
    if (!allocs.length) return [];
    const bal = saleBalances(this.state); const drop = new Map();
    for (const a of allocs) drop.set(a.saleId, (drop.get(a.saleId) || 0) + a.amount);
    for (const [saleId, amt] of drop) {
      const b = bal.get(saleId);
      if (b && b.refunded > b.allocated - amt) throw new UserError(`Sale ${this._sale(saleId).sourceId} has a refund recorded against this payment. Reverse the refund first.`);
    }
    return allocs.map((a) => ({ ...a, reversedAt: at, reversalReason: reason }));
  }
  _allocsOf(field, id) { return activeAllocations(this.state).filter((a) => a[field] === id); }
  _events(type, action, recs, reason) { return recs.map((r) => ({ entityType: type, entityId: r.id, action, old: null, new: r, reason })); }

  // ---- sales ----
  async addSale(raw) {
    const n = normalizeSale(raw, this._opts()); need(n.ok, n.errors?.join('. '));
    need(!idx(this.state).saleBySource.has(n.record.sourceId), `Sale ID ${n.record.sourceId} already exists`);
    const rec = { id: this.newId(), ...n.record, batchId: null, rowNumber: null, source: 'manual', original: { ...raw }, createdAt: this.now(), revision: 1 };
    await this._commit({ puts: { sales: [rec] } }, this._events('sale', 'CREATE', [rec], 'Manual entry'));
    return rec;
  }
  async editSale(id, raw, { confirm = false, reason = '' } = {}) {
    const old = this._sale(id);
    const n = normalizeSale(raw, this._opts()); need(n.ok, n.errors?.join('. '));
    const other = idx(this.state).saleBySource.get(n.record.sourceId);
    need(!other || other.id === id, `Sale ID ${n.record.sourceId} already exists`);
    const b = saleBalances(this.state).get(id);
    need(n.record.totalDue >= b.credit, 'Total due cannot be lower than the credits already recorded. Reverse the credit first.');
    const hard = n.record.totalDue !== old.totalDue || n.record.date !== old.date;
    const soft = n.record.expectedAccount !== old.expectedAccount || n.record.expectedReference !== old.expectedReference || n.record.sourceId !== old.sourceId;
    const hit = this._allocsOf('saleId', id).filter((a) => hard || (soft && a.method !== 'MANUAL'));
    if (hit.length && !confirm) throw new ConfirmError(`This edit changes values that ${hit.length} allocation(s) relied on. They will be reversed and the sale returns to review.`);
    const at = this.now();
    const reversed = this._reverse(hit, `Sale ${old.sourceId} was edited`, at);
    const rec = { ...old, ...n.record, updatedAt: at, revision: old.revision + 1 };
    await this._commit({ puts: { sales: [rec], allocations: reversed } }, [{ entityType: 'sale', entityId: id, action: 'UPDATE', old, new: rec, reason }, ...this._events('allocation', 'REVERSE', reversed, `Sale ${old.sourceId} was edited`)]);
  }
  async voidSale(id, reason, { confirm = false } = {}) {
    const old = this._sale(id); reason = reasonOf(reason);
    const b = saleBalances(this.state).get(id);
    need(b.refunded === 0, 'This sale has refunds recorded. Reverse the refund first.');
    const hit = this._allocsOf('saleId', id);
    const credits = this.state.credits.filter((c) => c.saleId === id && !c.reversedAt);
    if ((hit.length || credits.length) && !confirm) throw new ConfirmError(`Voiding this sale reverses ${hit.length} allocation(s) and ${credits.length} credit(s). The receipts become unapplied.`);
    const at = this.now(); const why = `Sale ${old.sourceId} voided: ${reason}`;
    const reversed = this._reverse(hit, why, at);
    const rc = credits.map((c) => ({ ...c, reversedAt: at, reversalReason: why }));
    const rec = { ...old, voidedAt: at, voidReason: reason, revision: old.revision + 1 };
    await this._commit({ puts: { sales: [rec], allocations: reversed, credits: rc } }, [{ entityType: 'sale', entityId: id, action: 'VOID', old, new: rec, reason }, ...this._events('allocation', 'REVERSE', reversed, why)]);
  }

  // ---- receipts ----
  _receiptExists(rec, exceptId) { return this.state.receipts.some((r) => live(r) && r.id !== exceptId && receiptKey(r) === receiptKey(rec)); }
  async addReceipt(raw) {
    const n = normalizeReceipt(raw, this._opts()); need(n.ok, n.errors?.join('. '));
    need(!this._receiptExists(n.record), `Receipt ID ${n.record.sourceId} already exists in account ${n.record.accountId}`);
    const rec = { id: this.newId(), ...n.record, batchId: null, rowNumber: null, source: 'manual', original: { ...raw }, createdAt: this.now(), revision: 1 };
    await this._commit({ puts: { receipts: [rec] } }, this._events('receipt', 'CREATE', [rec], 'Manual entry'));
    return rec;
  }
  async editReceipt(id, raw, { confirm = false, reason = '' } = {}) {
    const old = this._receipt(id);
    const n = normalizeReceipt(raw, this._opts()); need(n.ok, n.errors?.join('. '));
    need(!this._receiptExists(n.record, id), `Receipt ID ${n.record.sourceId} already exists in account ${n.record.accountId}`);
    const hard = n.record.gross !== old.gross || n.record.date !== old.date || n.record.accountId !== old.accountId;
    const soft = n.record.reference !== old.reference || n.record.saleSourceId !== old.saleSourceId;
    const hit = this._allocsOf('receiptId', id).filter((a) => hard || (soft && a.method !== 'MANUAL'));
    if (hit.length && !confirm) throw new ConfirmError(`This edit changes values that ${hit.length} allocation(s) relied on. They will be reversed and the receipt returns to review.`);
    const at = this.now();
    const reversed = this._reverse(hit, `Receipt ${old.sourceId} was edited`, at);
    const rec = { ...old, ...n.record, updatedAt: at, revision: old.revision + 1 };
    await this._commit({ puts: { receipts: [rec], allocations: reversed } }, [{ entityType: 'receipt', entityId: id, action: 'UPDATE', old, new: rec, reason }, ...this._events('allocation', 'REVERSE', reversed, `Receipt ${old.sourceId} was edited`)]);
  }
  async voidReceipt(id, reason, { confirm = false } = {}) {
    const old = this._receipt(id); reason = reasonOf(reason);
    const hit = this._allocsOf('receiptId', id);
    if (hit.length && !confirm) throw new ConfirmError(`Voiding this receipt reverses ${hit.length} allocation(s). The sale balances will increase.`);
    const at = this.now(); const why = `Receipt ${old.sourceId} voided: ${reason}`;
    const reversed = this._reverse(hit, why, at);
    const rec = { ...old, voidedAt: at, voidReason: reason, revision: old.revision + 1 };
    await this._commit({ puts: { receipts: [rec], allocations: reversed } }, [{ entityType: 'receipt', entityId: id, action: 'VOID', old, new: rec, reason }, ...this._events('allocation', 'REVERSE', reversed, why)]);
  }
  async setReceiptUnsupported(id, flag, reason) {
    const old = this._receipt(id); reason = reasonOf(reason);
    const rec = { ...old, unsupported: !!flag, revision: old.revision + 1 };
    await this._commit({ puts: { receipts: [rec] } }, [{ entityType: 'receipt', entityId: id, action: flag ? 'MARK_UNSUPPORTED' : 'UNMARK_UNSUPPORTED', old, new: rec, reason }]);
  }

  // ---- matching and allocations ----
  async runMatching() {
    const { allocations } = runMatching(this.state, { windowDays: this.state.settings.matchWindowDays });
    if (!allocations.length) return 0;
    const at = this.now();
    const recs = allocations.map((a) => ({ id: this.newId(), ...a, createdAt: at, reversedAt: null, reversalReason: null }));
    await this._commit({ puts: { allocations: recs } }, this._events('allocation', 'AUTO_MATCH', recs, 'Matched from imported records'));
    return recs.length;
  }
  async allocate(receiptId, saleId, amount, reason = '') {
    const r = this._receipt(receiptId); const s = this._sale(saleId);
    const amt = money(amount, 'Amount');
    const available = receiptAvailability(this.state).get(r.id).available; const outstanding = saleBalances(this.state).get(s.id).outstanding;
    need(amt <= available, 'Amount is more than the unapplied amount left on this receipt');
    need(amt <= outstanding, 'Amount is more than the outstanding balance of this sale');
    const rec = { id: this.newId(), receiptId, saleId, amount: amt, method: 'MANUAL', reason: String(reason).trim() || 'Manually allocated', createdAt: this.now(), reversedAt: null, reversalReason: null };
    await this._commit({ puts: { allocations: [rec] } }, this._events('allocation', 'MANUAL_ALLOCATE', [rec], rec.reason));
    return rec;
  }
  async reverseAllocation(id, reason) {
    reason = reasonOf(reason);
    const a = this.state.allocations.find((x) => x.id === id); need(a && !a.reversedAt, 'That allocation is already reversed');
    const [rec] = this._reverse([a], reason, this.now());
    await this._commit({ puts: { allocations: [rec] } }, [{ entityType: 'allocation', entityId: id, action: 'REVERSE', old: a, new: rec, reason }]);
  }

  // ---- credits, refunds, cash ----
  async addCredit(saleId, { amount, reason, evidence = '', date }) {
    const s = this._sale(saleId); const amt = money(amount, 'Credit amount'); reason = reasonOf(reason); dateOf(date, 'Date');
    const b = saleBalances(this.state).get(s.id);
    need(b.credit + amt <= s.totalDue, 'Total credits cannot exceed the original amount due');
    const rec = { id: this.newId(), saleId, amount: amt, reason, evidence: String(evidence).trim().slice(0, 500), date, createdAt: this.now(), reversedAt: null, revision: 1 };
    await this._commit({ puts: { credits: [rec] } }, this._events('credit', 'CREATE', [rec], reason));
  }
  async addRefund(saleId, { accountId, amount, date, reason }) {
    const s = this._sale(saleId); const amt = money(amount, 'Refund amount'); reason = reasonOf(reason); dateOf(date, 'Date');
    need(idx(this.state).accountsById.has(accountId), 'Choose the account the refund was paid from');
    const b = saleBalances(this.state).get(s.id);
    need(b.refunded + amt <= b.allocated, 'Total refunds cannot exceed the receipts allocated to this sale');
    const rec = { id: this.newId(), saleId, accountId, amount: amt, date, reason, createdAt: this.now(), reversedAt: null };
    await this._commit({ puts: { refunds: [rec] } }, this._events('refund', 'CREATE', [rec], reason));
  }
  async reverseEntry(store, id, reason) {
    need(['credits', 'refunds', 'cashMovements'].includes(store), 'Unsupported reversal');
    reason = reasonOf(reason);
    const old = this.state[store].find((x) => x.id === id); need(old && !old.reversedAt, 'That entry is already reversed');
    const rec = { ...old, reversedAt: this.now(), reversalReason: reason };
    await this._commit({ puts: { [store]: [rec] } }, [{ entityType: store, entityId: id, action: 'REVERSE', old, new: rec, reason }]);
  }
  async addCashMovement({ date, accountId, kind, amount, reason }) {
    dateOf(date, 'Date'); const amt = money(amount, 'Amount'); reason = reasonOf(reason);
    need(idx(this.state).accountsById.get(accountId)?.type === 'CASH', 'Choose a cash account');
    need(kind === 'PAID_IN' || kind === 'PAID_OUT', 'Choose paid-in or paid-out');
    const rec = { id: this.newId(), date, accountId, kind, amount: amt, reason, createdAt: this.now(), reversedAt: null };
    await this._commit({ puts: { cashMovements: [rec] } }, this._events('cashMovement', 'CREATE', [rec], reason));
  }
  /** opening/counted: text, centavos, or blank/null for "not entered" (never treated as zero). */
  async saveCashClose(accountId, date, { opening, counted }) {
    dateOf(date, 'Date'); need(idx(this.state).accountsById.get(accountId)?.type === 'CASH', 'Choose a cash account');
    const val = (v, label) => (v === null || v === undefined || String(v).trim() === '' ? null : money(v, label, { allowZero: true }));
    const id = cashCloseId(accountId, date); const old = this.state.cashCloses.find((c) => c.id === id) || null;
    const rec = { id, accountId, date, opening: val(opening, 'Opening cash'), counted: val(counted, 'Counted cash'), updatedAt: this.now(), revision: (old?.revision || 0) + 1 };
    await this._commit({ puts: { cashCloses: [rec] } }, [{ entityType: 'cashClose', entityId: id, action: old ? 'UPDATE' : 'CREATE', old, new: rec, reason: '' }]);
  }

  // ---- review ----
  issues(today) { return deriveIssues(this.state, { today, windowDays: this.state.settings.matchWindowDays }); }
  async setIssueState(key, state, note = '') {
    need(ISSUE_STATES.includes(state), 'Unknown review state'); note = String(note).trim();
    need(note.length <= 1000, 'Note is too long');
    need(state !== 'ACKNOWLEDGED_WITH_NOTE' || note !== '', 'Add a note explaining why this is acknowledged');
    const old = this.state.issueStates.find((i) => i.id === key) || null;
    const rec = { id: key, state, note, updatedAt: this.now() };
    await this._commit({ puts: { issueStates: [rec] } }, [{ entityType: 'issue', entityId: key, action: 'REVIEW', old, new: rec, reason: note }]);
  }

  // ---- imports ----
  async previewImport(kind, bytes, text, mapping, filename) {
    return buildPreview(kind, text, mapping, this.state, { filename, hash: await sha256Hex(bytes) });
  }
  async commitImport(preview) {
    need(preview.fatal.length === 0, 'Fix the import problems first');
    need(preview.rev === this.state.rev, 'The workspace changed since this preview. Preview the file again.');
    const c = preview.counts;
    need(c.valid + c.invalid + c.conflict + c.excluded > 0, 'Nothing new to import: every row is already in the workspace.');
    const at = this.now(); const batchId = this.newId();
    const store = preview.kind === 'sales' ? 'sales' : 'receipts';
    const recs = preview.rows.filter((r) => r.status === 'valid').map((r) => ({ id: this.newId(), ...r.record, batchId, rowNumber: r.rowNumber, source: 'import', original: r.original, createdAt: at, revision: 1 }));
    const batch = {
      id: batchId, kind: preview.kind, filename: String(preview.filename).slice(0, 200), hash: preview.hash, mapping: preview.mapping, counts: c, coverage: preview.coverage, importedAt: at, importedOn: dateInZone(new Date(at), this.state.settings.timezone), removedAt: null,
      rowLog: preview.rows.filter((r) => r.status !== 'valid').map((r) => ({ row: r.rowNumber, status: r.status, code: r.code || null, errors: r.errors, original: r.original })),
    };
    await this._commit({ puts: { batches: [batch], [store]: recs } }, [{ entityType: 'batch', entityId: batchId, action: 'IMPORT', old: null, new: { filename: batch.filename, kind: batch.kind, counts: c }, reason: '' }]);
    return batch;
  }
  async removeBatch(id, reason, { confirm = false } = {}) {
    reason = reasonOf(reason);
    const batch = this.state.batches.find((b) => b.id === id); need(batch && !batch.removedAt, 'That import is already removed');
    const store = batch.kind === 'sales' ? 'sales' : 'receipts'; const field = batch.kind === 'sales' ? 'saleId' : 'receiptId';
    const recs = this.state[store].filter((r) => r.batchId === id && live(r)); const ids = new Set(recs.map((r) => r.id));
    const hit = activeAllocations(this.state).filter((a) => ids.has(a[field]));
    const credits = batch.kind === 'sales' ? this.state.credits.filter((c) => ids.has(c.saleId) && !c.reversedAt) : [];
    if (batch.kind === 'sales') need(!this.state.refunds.some((r) => ids.has(r.saleId) && !r.reversedAt), 'Sales in this import have refunds recorded. Reverse those refunds first.');
    if ((hit.length || credits.length) && !confirm) throw new ConfirmError(`Removing this import voids ${recs.length} record(s) and reverses ${hit.length} allocation(s) and ${credits.length} credit(s).`);
    const at = this.now(); const why = `Import ${batch.filename} removed: ${reason}`;
    const reversed = this._reverse(hit, why, at);
    const voided = recs.map((r) => ({ ...r, voidedAt: at, voidReason: why, revision: r.revision + 1 }));
    const b = { ...batch, removedAt: at, removeReason: reason };
    await this._commit({ puts: { batches: [b], [store]: voided, allocations: reversed, credits: credits.map((c) => ({ ...c, reversedAt: at, reversalReason: why })) } },
      [{ entityType: 'batch', entityId: id, action: 'REMOVE', old: null, new: { filename: batch.filename, voided: voided.length, reversed: reversed.length }, reason }]);
  }

  // ---- reports ----
  coverage(range) {
    const st = this.state; const overlaps = (c) => c && c.from <= range.to && c.to >= range.from;
    const inR = (r) => live(r) && r.date >= range.from && r.date <= range.to;
    const batches = st.batches.filter((b) => !b.removedAt && overlaps(b.coverage)).map((b) => ({ filename: b.filename, kind: b.kind, from: b.coverage.from, to: b.coverage.to, importedAt: b.importedAt, counts: b.counts })).sort((a, b) => (a.importedAt === b.importedAt ? (a.filename < b.filename ? -1 : 1) : a.importedAt < b.importedAt ? -1 : 1));
    return {
      batches,
      manualSales: st.sales.filter((s) => inR(s) && s.source === 'manual').length,
      manualReceipts: st.receipts.filter((r) => inR(r) && r.source === 'manual').length,
      rowsNotImported: sum(batches.map((b) => b.counts.invalid + b.counts.conflict + b.counts.excluded)),
      cashIncomplete: cashDays(st, range).filter((d) => d.status === 'INCOMPLETE').length,
      hasSales: st.sales.some(inR), hasReceipts: st.receipts.some(inR),
    };
  }
  buildReport(range, cutoff, today) {
    need(isDateString(range.from) && isDateString(range.to) && range.from <= range.to, 'Choose a valid report period');
    need(isDateString(cutoff) && cutoff >= range.to, 'The cutoff date cannot be earlier than the end of the period');
    const states = new Map(this.state.issueStates.map((i) => [i.id, i]));
    const issues = issuesInRange(this.issues(today), range).sort((a, b) => (a.date === b.date ? (a.key < b.key ? -1 : 1) : a.date < b.date ? -1 : 1)).map((i) => ({ key: i.key, type: i.type, title: i.title, amount: i.amount, state: states.get(i.key)?.state || 'OPEN', note: states.get(i.key)?.note || '' }));
    return { range: { from: range.from, to: range.to }, cutoff, totals: reportTotals(this.state, range, cutoff), issues, coverage: this.coverage(range), status: issues.length ? 'SAVED_WITH_OPEN_ITEMS' : 'SAVED_NO_OPEN_ITEMS' };
  }
  async saveSnapshot(range, cutoff, today) {
    const report = this.buildReport(range, cutoff, today); const at = this.now();
    const same = this.state.snapshots.filter((s) => s.range.from === range.from && s.range.to === range.to);
    const superseded = same.filter((s) => s.status !== 'SUPERSEDED').map((s) => ({ ...s, status: 'SUPERSEDED', supersededAt: at, supersededReason: 'Replaced by a newer version of this report' }));
    const snap = { id: this.newId(), version: same.length + 1, createdAt: at, ...report, businessName: this.state.settings.businessName, appVersion: APP_VERSION, schemaVersion: SCHEMA_VERSION, dataRev: this.state.rev };
    await this._commit({ puts: { snapshots: [...superseded, snap] } }, [{ entityType: 'snapshot', entityId: snap.id, action: 'SAVE_REPORT', old: null, new: { range: snap.range, cutoff, status: snap.status, version: snap.version }, reason: '' }]);
    return snap;
  }

  // ---- backup, restore, sample ----
  backup() { return buildBackup(this.state, { appVersion: APP_VERSION, now: this.now() }); }
  async restore(validated) {
    need(validated && validated.ok, 'The backup did not pass validation');
    await this.repo.replaceAll(validated.data, { ...DEFAULT_SETTINGS, ...validated.settings, schemaVersion: SCHEMA_VERSION });
    await this.load();
  }
  isEmpty() { return STORES.every((s) => s === 'accounts' || s === 'events' ? true : this.state[s].length === 0); }
  async loadSample(today) {
    need(this.isEmpty(), 'Sample data can only be loaded into an empty workspace');
    for (const a of SAMPLE_ACCOUNTS) await this.saveAccount(a);
    await this.saveSettings({ businessName: 'Sample Store (synthetic data)' });
    const csv = sampleCsv(today); const enc = new TextEncoder();
    for (const kind of ['sales', 'receipts']) {
      const mapping = { columns: {}, dateFormat: 'ISO', numberFormat: 'plain', delimiter: ',', assumeLocal: false, fixedAccount: '', statusColumn: '', completedValues: '' };
      const header = csv[kind].split('\r\n')[0].split(','); for (const h of header) mapping.columns[h] = h;
      const preview = await this.previewImport(kind, enc.encode(csv[kind]), csv[kind], mapping, `sample_${kind}.csv`);
      await this.commitImport(preview);
    }
    await this.runMatching();
    await this.saveCashClose('CASH', today, { opening: '1000.00', counted: '' });
  }
}
