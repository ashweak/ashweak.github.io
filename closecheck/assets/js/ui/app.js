// Bootstrap, routing, and shared UI state. All data changes go through data/service.js.
import { openRepo, MemoryRepo, dbName } from '../data/repo.js';
import { Workspace, APP_VERSION } from '../data/service.js';
import { UserError, ConflictError } from '../domain/errors.js';
import { todayIn, formatInstant } from '../domain/dates.js';
import { h, clear, icon, btn, notice } from './dom.js';
import { overview, importView, salesView, receiptsView } from './views-main.js';
import { reviewView, cashView, reportsView, settingsView } from './views-close.js';

const ROUTES = [
  ['overview', 'Overview', 'home', overview], ['import', 'Import', 'upload', importView], ['sales', 'Sales', 'tag', salesView], ['receipts', 'Receipts', 'inbox', receiptsView],
  ['review', 'Review', 'flag', reviewView], ['cash', 'Cash Close', 'cash', cashView], ['reports', 'Reports', 'file', reportsView], ['settings', 'Settings & Data', 'gear', settingsView],
];
const WS_KEY = 'closecheck.workspace';
const pref = { get() { try { return localStorage.getItem(WS_KEY); } catch { return null; } }, set(v) { try { localStorage.setItem(WS_KEY, v); } catch { /* preference only */ } } };

const $ = (id) => document.getElementById(id);
let releaseLock = null;
function acquireLock(name) {
  if (!navigator.locks) return Promise.resolve(true); // revision check in the repository still prevents lost updates
  return new Promise((resolve) => {
    navigator.locks.request(name, { ifAvailable: true }, (lock) => {
      if (!lock) { resolve(false); return undefined; }
      resolve(true);
      return new Promise((release) => { releaseLock = release; });
    }).catch(() => resolve(true));
  });
}

export const ctx = {
  ws: null, workspace: 'main', readOnly: false, storageNote: null, conflict: false, ui: {}, period: null, version: APP_VERSION,
  today() { return todayIn(this.ws.state.settings.timezone); },
  when(iso) { return iso ? formatInstant(iso, this.ws.state.settings.timezone) : '—'; },
  route() { const r = location.hash.replace(/^#\/?/, '').split('?')[0]; return ROUTES.some((x) => x[0] === r) ? r : 'overview'; },
  go(route) { if (this.route() === route) this.refresh(); else location.hash = `#/${route}`; },
  toast(message, tone = 'ok') {
    const el = h('div', { class: `toast toast-${tone}` }, message);
    const region = $(tone === 'error' ? 'alerts' : 'status'); clear(region).append(el);
    setTimeout(() => { if (el.isConnected) el.remove(); }, tone === 'error' ? 12000 : 5000);
  },
  /** After a successful change: re-render and announce. */
  done(message) { this.refresh(); if (message) this.toast(message); },
  /** Run an action from a plain button; failures are shown, never swallowed. */
  async act(fn, message) {
    try { await fn(); this.done(message); }
    catch (e) {
      if (e instanceof ConflictError) { this.conflict = true; this.refresh(); }
      this.toast(e instanceof UserError || e instanceof ConflictError ? e.message : `Not saved: ${e?.message || 'storage error'}. Your previous data is unchanged.`, 'error');
      if (!(e instanceof UserError) && !(e instanceof ConflictError)) console.error(e);
    }
  },
  refresh() { render(); },
  async switchWorkspace(name) { pref.set(name); await boot(name); },
  async deleteLocalData() {
    this.ws.repo.close();
    for (const w of ['main', 'sample']) {
      await new Promise((res) => { if (!globalThis.indexedDB) { res(); return; } const r = indexedDB.deleteDatabase(dbName(w)); r.onsuccess = r.onerror = r.onblocked = () => res(); });
    }
    try { localStorage.removeItem(WS_KEY); } catch { /* nothing stored */ }
    this.ui = {}; await boot('main');
  },
};

function banners() {
  const out = [];
  if (ctx.conflict) out.push(notice('error', h('strong', {}, 'This workspace was changed in another tab. '), 'Nothing was overwritten. ', btn('Reload this tab', () => location.reload(), { kind: 'small' })));
  if (ctx.readOnly) out.push(notice('warn', h('strong', {}, 'Read-only: '), 'CloseCheck is open in another tab on this device. Close the other tab, then ', btn('try again', () => boot(ctx.workspace), { kind: 'small' })));
  if (ctx.storageNote) out.push(notice('error', h('strong', {}, 'Data is NOT being saved on this device. '), `${ctx.storageNote} You can keep working in this tab, but everything is lost when it closes. Export a backup before leaving. `, btn('Go to backup', () => ctx.go('settings'), { kind: 'small' })));
  if (ctx.workspace === 'sample') out.push(notice('info', h('strong', {}, 'Sample workspace. '), 'Everything here is synthetic practice data, kept separate from your real records. ', btn('Use my own workspace', () => ctx.switchWorkspace('main'), { kind: 'small' })));
  return out;
}

function render() {
  const route = ctx.route(); const def = ROUTES.find((r) => r[0] === route);
  clear($('nav-list')).append(...ROUTES.map(([id, label, ic]) => h('li', {}, h('a', { href: `#/${id}`, 'aria-current': id === route ? 'page' : null }, icon(ic), h('span', {}, label)))));
  $('workspace-name').textContent = ctx.ws.state.settings.businessName || (ctx.workspace === 'sample' ? 'Sample workspace' : 'My business');
  clear($('banners')).append(...banners());
  const view = clear($('view'));
  try { view.append(def[3](ctx)); }
  catch (e) { console.error(e); view.append(h('h1', { tabindex: '-1' }, def[1]), notice('error', 'This screen could not be displayed. Your data was not changed. Try reloading; if it persists, export a backup from Settings & Data.')); }
  document.title = `${def[1]} · CloseCheck`;
  $('nav').classList.remove('open'); $('menu-btn').setAttribute('aria-expanded', 'false');
}

async function boot(name) {
  if (releaseLock) { releaseLock(); releaseLock = null; }
  if (ctx.ws) ctx.ws.repo.close();
  ctx.workspace = name === 'sample' ? 'sample' : 'main'; ctx.conflict = false; ctx.ui = {};
  let repo; ctx.storageNote = null;
  try {
    const opened = await openRepo(ctx.workspace); repo = opened.repo; ctx.storageNote = opened.fallbackReason;
    repo.onVersionChange = () => { ctx.conflict = true; render(); };
  } catch (e) { fatal(e.message); return; }
  ctx.readOnly = repo.kind === 'indexeddb' ? !(await acquireLock(dbName(ctx.workspace))) : false;
  ctx.ws = new Workspace(repo);
  try { await ctx.ws.load(); }
  catch (e) {
    console.error(e);
    // Reading failed: fall back to memory without touching what is stored.
    ctx.storageNote = `Stored data could not be read (${e?.message || 'unknown error'}).`;
    ctx.ws = new Workspace(new MemoryRepo()); await ctx.ws.load();
  }
  if (ctx.readOnly) ctx.ws.repo.commit = async () => { throw new UserError('This tab is read-only because CloseCheck is open in another tab.'); };
  const t = ctx.today(); ctx.period = { from: t, to: t };
  if (ctx.workspace === 'sample' && !ctx.readOnly && ctx.ws.isEmpty()) { try { await ctx.ws.loadSample(t); ctx.period = { from: ctx.ws.state.sales.map((s) => s.date).sort()[0] || t, to: t }; } catch (e) { console.error(e); } }
  else if (ctx.workspace === 'sample') ctx.period = { from: ctx.ws.state.sales.map((s) => s.date).sort()[0] || t, to: t };
  render();
}
function fatal(message) {
  clear($('view')).append(h('h1', {}, 'CloseCheck could not start'), notice('error', message));
}

window.addEventListener('hashchange', () => { if (ctx.ws) { render(); $('view').querySelector('h1')?.focus(); } });
$('menu-btn').addEventListener('click', () => { const open = $('nav').classList.toggle('open'); $('menu-btn').setAttribute('aria-expanded', String(open)); });
$('version').textContent = `v${APP_VERSION}`;
boot(pref.get() === 'sample' ? 'sample' : 'main').catch((e) => { console.error(e); fatal(e?.message || 'Unexpected error'); });
