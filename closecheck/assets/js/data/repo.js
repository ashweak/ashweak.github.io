// Storage behind a small repository interface: IndexedDB with an in-memory fallback.
// Every write is one transaction guarded by a revision counter (no lost updates across tabs).
import { ConflictError } from '../domain/errors.js';

export const SCHEMA_VERSION = 1;
export const STORES = ['accounts', 'batches', 'sales', 'receipts', 'allocations', 'credits', 'refunds', 'cashMovements', 'cashCloses', 'events', 'issueStates', 'snapshots'];
export const dbName = (workspace) => `closecheck-${workspace}`;

/** Ordered schema migrations. Index n upgrades a database from version n to n+1. */
const MIGRATIONS = [
  (db) => {
    db.createObjectStore('meta', { keyPath: 'key' });
    for (const s of STORES) db.createObjectStore(s, { keyPath: 'id' });
  },
];

const emptyData = () => Object.fromEntries(STORES.map((s) => [s, []]));
const clone = (v) => (typeof structuredClone === 'function' ? structuredClone(v) : JSON.parse(JSON.stringify(v)));

export class MemoryRepo {
  constructor() { this.kind = 'memory'; this.data = emptyData(); this.settings = null; this.rev = 0; }
  async open() { return this; }
  async loadAll() { return clone({ ...this.data, settings: this.settings, rev: this.rev }); }
  async commit({ puts = {}, settings }, expectedRev) {
    if (expectedRev !== this.rev) throw new ConflictError();
    for (const [store, records] of Object.entries(puts)) {
      const map = new Map(this.data[store].map((r) => [r.id, r]));
      for (const r of records) map.set(r.id, clone(r));
      this.data[store] = [...map.values()];
    }
    if (settings) this.settings = clone(settings);
    return ++this.rev;
  }
  async replaceAll(data, settings) {
    this.data = emptyData();
    for (const s of STORES) this.data[s] = clone(data[s] || []);
    this.settings = clone(settings);
    return ++this.rev;
  }
  async destroy() { this.data = emptyData(); this.settings = null; this.rev = 0; }
  close() {}
}

const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
function txDone(tx) {
  return new Promise((res, rej) => {
    tx.oncomplete = () => res();
    tx.onabort = () => rej(tx.error || new Error('The storage transaction was aborted'));
    tx.onerror = () => rej(tx.error || new Error('The storage transaction failed'));
  });
}

export class IdbRepo {
  constructor(workspace, idb = globalThis.indexedDB) { this.kind = 'indexeddb'; this.name = dbName(workspace); this.idb = idb; this.db = null; this.onVersionChange = null; }
  open() {
    return new Promise((resolve, reject) => {
      let request;
      try { request = this.idb.open(this.name, SCHEMA_VERSION); } catch (e) { reject(e); return; }
      request.onupgradeneeded = (ev) => {
        // A failure here aborts the upgrade transaction, leaving the old database untouched.
        for (let v = ev.oldVersion; v < SCHEMA_VERSION; v++) MIGRATIONS[v](request.result, request.transaction);
      };
      request.onblocked = () => reject(new Error('Another tab is using an older version of this app. Close other CloseCheck tabs and reload.'));
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        this.db = request.result;
        this.db.onversionchange = () => { this.db.close(); if (this.onVersionChange) this.onVersionChange(); };
        resolve(this);
      };
    });
  }
  async loadAll() {
    const tx = this.db.transaction(['meta', ...STORES], 'readonly');
    const out = {};
    const meta = req(tx.objectStore('meta').getAll());
    const lists = STORES.map((s) => req(tx.objectStore(s).getAll()));
    const [metaRows, ...rows] = await Promise.all([meta, ...lists]);
    STORES.forEach((s, i) => { out[s] = rows[i]; });
    const get = (k) => metaRows.find((m) => m.key === k)?.value;
    out.settings = get('settings') ?? null; out.rev = get('rev') ?? 0;
    return out;
  }
  /** Atomic write. Resolves only after the transaction has committed. */
  async commit({ puts = {}, settings }, expectedRev) {
    const names = ['meta', ...Object.keys(puts)];
    const tx = this.db.transaction(names, 'readwrite');
    const done = txDone(tx);
    const metaStore = tx.objectStore('meta');
    const revReq = metaStore.get('rev');
    let conflict = false; let failure = null;
    revReq.onsuccess = () => {
      try {
        const current = revReq.result?.value ?? 0;
        if (current !== expectedRev) { conflict = true; tx.abort(); return; }
        for (const [store, records] of Object.entries(puts)) { const os = tx.objectStore(store); for (const r of records) os.put(r); }
        if (settings) metaStore.put({ key: 'settings', value: settings });
        metaStore.put({ key: 'rev', value: expectedRev + 1 });
      } catch (e) { failure = e; try { tx.abort(); } catch { /* already aborting */ } }
    };
    try { await done; } catch (e) { if (conflict) throw new ConflictError(); throw failure || e; }
    return expectedRev + 1;
  }
  /** Replace the whole workspace in one transaction (restore). Old data survives any failure. */
  async replaceAll(data, settings) {
    const tx = this.db.transaction(['meta', ...STORES], 'readwrite');
    const done = txDone(tx);
    const metaStore = tx.objectStore('meta');
    const revReq = metaStore.get('rev');
    let next = 1; let failure = null;
    revReq.onsuccess = () => {
      try {
        next = (revReq.result?.value ?? 0) + 1;
        for (const s of STORES) { const os = tx.objectStore(s); os.clear(); for (const r of data[s] || []) os.put(r); }
        metaStore.put({ key: 'settings', value: settings });
        metaStore.put({ key: 'rev', value: next });
      } catch (e) { failure = e; try { tx.abort(); } catch { /* already aborting */ } }
    };
    try { await done; } catch (e) { throw failure || e; }
    return next;
  }
  close() { if (this.db) this.db.close(); this.db = null; }
  destroy() {
    this.close();
    return new Promise((res, rej) => {
      const r = this.idb.deleteDatabase(this.name);
      r.onsuccess = () => res(); r.onerror = () => rej(r.error);
      r.onblocked = () => rej(new Error('Close other CloseCheck tabs, then try deleting again.'));
    });
  }
}

/** Open IndexedDB; fall back to memory (with the reason) when storage is unavailable. */
export async function openRepo(workspace) {
  if (!globalThis.indexedDB) return { repo: await new MemoryRepo().open(), fallbackReason: 'This browser does not provide IndexedDB.' };
  try { return { repo: await new IdbRepo(workspace).open(), fallbackReason: null }; }
  catch (e) {
    if (e && e.name === 'VersionError') throw new Error('This device has data from a newer CloseCheck version. Reload to get the latest app; your data was not changed.');
    return { repo: await new MemoryRepo().open(), fallbackReason: `Browser storage could not be opened (${e?.message || e?.name || 'unknown error'}).` };
  }
}
