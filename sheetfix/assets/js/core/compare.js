// Two-file comparison on explicitly mapped keys and fields.
// Missing and duplicate keys on either side are excluded from one-to-one matching;
// a key that is duplicated on one side also excludes its rows on the other side,
// so no row is ever reported as Added/Removed when a match is merely ambiguous.
import { keyNormalizer, encodeKey } from './duplicates.js';
import { canonicalDecimal, numberFormat } from './validate.js';

/**
 * base/upd: { columns:[{index}], rows:[{id, record, cells}] }
 * mapping: {
 *   keys: [{ a, b }]            column indices (Baseline, Updated)
 *   fields: [{ a, b, label, trim, caseInsensitive, numeric }]  numeric: number-format id or ''
 *   keyTrim, keyCaseInsensitive  optional key matching normalization (exact by default)
 * }
 */
export function validateMapping(base, upd, mapping) {
  const errors = [];
  const aw = base.columns.length;
  const bw = upd.columns.length;
  if (!mapping.keys || !mapping.keys.length) errors.push('Map at least one key column.');
  for (const k of mapping.keys || []) {
    if (!(k.a >= 0 && k.a < aw)) errors.push('A Baseline key column is missing.');
    if (!(k.b >= 0 && k.b < bw)) errors.push('An Updated key column is missing.');
  }
  for (const f of mapping.fields || []) {
    if (!(f.a >= 0 && f.a < aw)) errors.push(`Baseline column for "${f.label}" is missing.`);
    if (!(f.b >= 0 && f.b < bw)) errors.push(`Updated column for "${f.label}" is missing.`);
  }
  return errors;
}

function fieldEqual(av, bv, f) {
  if (av === bv) return true;
  let x = av;
  let y = bv;
  if (f.trim) {
    x = x.replace(/^[ \t]+|[ \t]+$/g, '');
    y = y.replace(/^[ \t]+|[ \t]+$/g, '');
  }
  if (f.caseInsensitive) {
    x = x.toLowerCase();
    y = y.toLowerCase();
  }
  if (x === y) return true;
  if (f.numeric) {
    const fmt = numberFormat(f.numeric);
    const cx = canonicalDecimal(x, fmt);
    const cy = canonicalDecimal(y, fmt);
    if (cx !== null && cy !== null && cx === cy) return true; // blank is never a number, so blank != 0
  }
  return false;
}

function indexSide(rows, keyCols, norm) {
  const byKey = new Map();
  const missing = [];
  for (const row of rows) {
    const key = encodeKey(row.cells, keyCols, norm);
    if (key === null) {
      missing.push(row);
      continue;
    }
    const list = byKey.get(key);
    if (list) list.push(row);
    else byKey.set(key, [row]);
  }
  return { byKey, missing };
}

export function compareLists(base, upd, mapping) {
  const errors = validateMapping(base, upd, mapping);
  if (errors.length) {
    const e = new Error(errors.join(' '));
    e.code = 'mapping';
    throw e;
  }
  const norm = keyNormalizer({ trim: mapping.keyTrim, caseInsensitive: mapping.keyCaseInsensitive });
  const A = indexSide(base.rows, mapping.keys.map((k) => k.a), norm);
  const B = indexSide(upd.rows, mapping.keys.map((k) => k.b), norm);
  const fields = mapping.fields || [];

  const excludedBase = [];
  const excludedUpd = [];
  for (const row of A.missing) excludedBase.push({ row, reason: 'missing-key' });
  for (const row of B.missing) excludedUpd.push({ row, reason: 'missing-key' });

  const badKeys = new Set();
  for (const [k, list] of A.byKey) if (list.length > 1) badKeys.add(k);
  for (const [k, list] of B.byKey) if (list.length > 1) badKeys.add(k);

  // Excluded rows keep source order.
  const reasonFor = (k, mine, other) =>
    mine.get(k).length > 1 ? 'duplicate-key' : 'duplicate-key-other-side';
  const exA = new Map();
  const exB = new Map();
  for (const k of badKeys) {
    if (A.byKey.has(k)) for (const row of A.byKey.get(k)) exA.set(row.id, reasonFor(k, A.byKey, B.byKey));
    if (B.byKey.has(k)) for (const row of B.byKey.get(k)) exB.set(row.id, reasonFor(k, B.byKey, A.byKey));
  }
  for (const row of base.rows) if (exA.has(row.id)) excludedBase.push({ row, reason: exA.get(row.id) });
  for (const row of upd.rows) if (exB.has(row.id)) excludedUpd.push({ row, reason: exB.get(row.id) });
  excludedBase.sort((x, y) => x.row.record - y.row.record);
  excludedUpd.sort((x, y) => x.row.record - y.row.record);

  const added = [];
  const changed = [];
  const unchanged = [];
  const removed = [];
  const fieldChanges = [];
  const fieldChangeCounts = fields.map(() => 0);

  for (const row of upd.rows) {
    const key = encodeKey(row.cells, mapping.keys.map((k) => k.b), norm);
    if (key === null || badKeys.has(key)) continue;
    const match = A.byKey.get(key);
    if (!match) {
      added.push({ key, upd: row });
      continue;
    }
    const brow = match[0];
    const diffs = [];
    fields.forEach((f, fi) => {
      const av = brow.cells[f.a];
      const bv = row.cells[f.b];
      if (!fieldEqual(av, bv, f)) {
        diffs.push({ field: fi, old: av, new: bv });
        fieldChangeCounts[fi]++;
      }
    });
    const pair = { key, base: brow, upd: row, diffs };
    if (diffs.length) {
      changed.push(pair);
      for (const d of diffs) fieldChanges.push({ key, baseRecord: brow.record, updRecord: row.record, field: d.field, old: d.old, new: d.new });
    } else unchanged.push(pair);
  }
  for (const row of base.rows) {
    const key = encodeKey(row.cells, mapping.keys.map((k) => k.a), norm);
    if (key === null || badKeys.has(key)) continue;
    if (!B.byKey.has(key)) removed.push({ key, base: row });
  }

  const counts = {
    baseline: base.rows.length,
    updated: upd.rows.length,
    added: added.length,
    removed: removed.length,
    changed: changed.length,
    unchanged: unchanged.length,
    excludedBaseline: excludedBase.length,
    excludedUpdated: excludedUpd.length,
    fieldChanges: fieldChanges.length,
  };
  counts.baselineBalanced = counts.baseline === counts.removed + counts.changed + counts.unchanged + counts.excludedBaseline;
  counts.updatedBalanced = counts.updated === counts.added + counts.changed + counts.unchanged + counts.excludedUpdated;

  return { added, removed, changed, unchanged, excludedBase, excludedUpd, fieldChanges, fieldChangeCounts, counts };
}

/** Human-readable key text from an encoded key. */
export function keyText(key) {
  try {
    return JSON.parse(key).join(' | ');
  } catch {
    return key;
  }
}
