// Same-origin module worker. Every request carries an id; the main thread ignores
// replies whose id is no longer current, and cancels by terminating this worker.
// Row data never leaves the browser: this worker has no network code.
import { importFile } from '../io/import.js';
import { applyRecipe } from '../core/recipe.js';
import { findDuplicates } from '../core/duplicates.js';
import { compareLists } from '../core/compare.js';

const OPS = {
  import: importFile,
  recipe: ({ dataset, recipe }, progress) => applyRecipe(dataset, recipe, progress),
  dups: ({ rows, keyCols, opts }) => findDuplicates(rows, keyCols, opts),
  compare: ({ base, upd, mapping }) => compareLists(base, upd, mapping),
};

self.onmessage = (ev) => {
  const { id, op, payload } = ev.data;
  let last = 0;
  const progress = (p) => {
    const now = Date.now();
    if (now - last > 100) {
      last = now;
      self.postMessage({ id, progress: p });
    }
  };
  try {
    const fn = OPS[op];
    if (!fn) throw new Error('Unknown operation.');
    const result = fn(payload, progress);
    self.postMessage({ id, result });
  } catch (err) {
    self.postMessage({ id, error: { code: err.code || 'error', message: err.message || String(err) } });
  }
};
