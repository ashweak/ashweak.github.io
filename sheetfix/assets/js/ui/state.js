// Session state, held in memory only. Nothing here is written to storage or sent anywhere.
// The imported dataset is immutable; the working view is always recomputed from it
// and the committed recipe. Review decisions are tied to the dataset revision.
import { defaultRecipe } from '../core/recipe.js';
import { resolveDuplicates } from '../core/duplicates.js';
import { displayLabels } from '../core/dataset.js';

export const state = {
  files: { main: null, baseline: null, updated: null },
  clean: null,
  dups: null,
  compare: null,
};

const listeners = new Set();
export const subscribe = (fn) => listeners.add(fn);
export function changed() {
  for (const fn of listeners) fn();
}

/** A file slot after the user commits it: { name, size, bytes, settings, result, dataset } */
export function commitFile(slot, file) {
  state.files[slot] = file;
  if (slot === 'main') {
    const recipe = defaultRecipe();
    state.clean = { history: [recipe], pointer: 0, revision: 1, draft: structuredClone(recipe), view: null, preview: null };
    state.dups = null;
    if (state.compare && (state.compare.baseFrom === 'main' || state.compare.updFrom === 'main')) state.compare = null;
  } else {
    state.compare = state.compare ? { ...state.compare, result: null, acknowledged: false } : null;
  }
  changed();
}

export function clearSession() {
  state.files = { main: null, baseline: null, updated: null };
  state.clean = null;
  state.dups = null;
  state.compare = null;
  changed();
}

export const hasWork = () => !!(state.files.main || state.files.baseline || state.files.updated);

export function mainDataset() {
  return state.files.main ? state.files.main.dataset : null;
}

export function committedRecipe() {
  return state.clean ? state.clean.history[state.clean.pointer] : null;
}

/** Working view: { columns, rows, labels, revision } (cleaned rows when a recipe is committed). */
export function workingView() {
  const ds = mainDataset();
  if (!ds) return null;
  const rows = state.clean && state.clean.view ? state.clean.view.rows : ds.rows;
  return { columns: ds.columns, rows, labels: labels(ds), revision: state.clean ? state.clean.revision : 1 };
}

export function labels(ds) {
  return displayLabels(ds.columns.map((c) => c.header));
}

/** Push a new committed recipe onto the history (drops redo branch). */
export function commitRecipe(recipe, view) {
  const c = state.clean;
  c.history = c.history.slice(0, c.pointer + 1);
  c.history.push(structuredClone(recipe));
  if (c.history.length > 50) c.history.splice(1, 1); // keep the original (index 0) for exact reset
  c.pointer = c.history.length - 1;
  c.revision++;
  c.view = view;
  c.preview = null;
  invalidateReviews();
}

export function invalidateReviews() {
  if (state.dups) state.dups.stale = true;
  if (state.compare && (state.compare.baseFrom === 'main' || state.compare.updFrom === 'main')) {
    state.compare.result = null;
    state.compare.stale = true;
  }
}

/** Confirmed duplicate resolution against the current working view, or null. */
export function duplicateResolution() {
  const d = state.dups;
  if (!d || !d.result || d.stale || !d.confirmed) return null;
  const view = workingView();
  return resolveDuplicates(view.rows, d.result, {
    decisions: d.confirmed.decisions,
    policy: d.confirmed.policy,
    reviewed: new Set(d.confirmed.reviewed),
  });
}

/** Resolve a compare side to a dataset-like object. */
export function compareSide(which) {
  const c = state.compare || {};
  const from = which === 'baseline' ? c.baseFrom : c.updFrom;
  if (from === 'main') {
    const v = workingView();
    return v ? { name: state.files.main.name + ' (working copy)', columns: v.columns, rows: v.rows, labels: v.labels } : null;
  }
  const f = state.files[which];
  if (!f) return null;
  return { name: f.name, columns: f.dataset.columns, rows: f.dataset.rows, labels: labels(f.dataset) };
}
