// Runs computations in a same-origin module worker with progress and cancellation.
// Cancelling terminates the worker, so no partial result is ever applied. Each job
// gets a fresh id; replies for an id that is no longer current are ignored.
import { h, clear, announce } from './dom.js';

let worker = null;
let current = null; // { id, resolve, reject, onProgress, timer }
let seq = 0;

function getWorker() {
  if (!worker) {
    worker = new Worker(new URL('../workers/compute.js', import.meta.url), { type: 'module' });
    worker.onmessage = (ev) => {
      const msg = ev.data;
      if (!current || msg.id !== current.id) return; // stale reply
      if ('progress' in msg) {
        current.onProgress && current.onProgress(msg.progress);
        setBusyProgress(msg.progress);
        return;
      }
      const job = current;
      finish();
      if (msg.error) job.reject(Object.assign(new Error(msg.error.message), { code: msg.error.code }));
      else job.resolve(msg.result);
    };
    worker.onerror = (e) => {
      e.preventDefault();
      if (!current) return;
      const job = current;
      finish();
      terminate();
      job.reject(Object.assign(new Error('The background worker failed to run. Reload the page and try again.'), { code: 'worker' }));
    };
  }
  return worker;
}

function terminate() {
  if (worker) worker.terminate();
  worker = null;
}

function finish() {
  if (current && current.timer) clearTimeout(current.timer);
  current = null;
  hideBusy();
}

/** Cancel the running job (if any). The previous committed state stays intact. */
export function cancel() {
  if (!current) return;
  const job = current;
  finish();
  terminate();
  job.reject(Object.assign(new Error('Cancelled.'), { code: 'cancelled' }));
  announce('Operation cancelled.');
}

/** Run one operation. Starting a new job cancels a running one. */
export function run(op, payload, { label = 'Working…', onProgress, transfer = [] } = {}) {
  if (current) cancel();
  const id = ++seq;
  return new Promise((resolve, reject) => {
    current = { id, resolve, reject, onProgress, timer: setTimeout(() => showBusy(label), 150) };
    getWorker().postMessage({ id, op, payload }, transfer);
  });
}

export const isBusy = () => !!current;

// ----- Busy indicator (non-modal; navigation stays available) -----
function busyEl() {
  return document.getElementById('busy');
}
function showBusy(label) {
  const el = busyEl();
  if (!el) return;
  clear(el);
  el.append(
    h('span', { class: 'spinner', 'aria-hidden': 'true' }),
    h('span', { text: label }),
    h('progress', { max: 1, id: 'busy-progress', 'aria-label': 'Progress' }),
    h('button', { type: 'button', class: 'btn small', onclick: cancel, text: 'Cancel' })
  );
  el.hidden = false;
}
function setBusyProgress(p) {
  const bar = document.getElementById('busy-progress');
  if (bar) bar.value = p;
}
function hideBusy() {
  const el = busyEl();
  if (el) {
    el.hidden = true;
    clear(el);
  }
}
