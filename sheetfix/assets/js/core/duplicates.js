// Duplicate detection on an ordered key tuple. Keys are encoded with JSON.stringify
// of the string array, which is collision-safe (no separator can occur in the data).
// Matching normalization (trim / case-insensitive) affects matching only; output
// values are never rewritten. Blank keys never group together.

export function keyNormalizer(opts = {}) {
  const trim = !!opts.trim;
  const ci = !!opts.caseInsensitive;
  return (v) => {
    let s = trim ? v.replace(/^[ \t]+|[ \t]+$/g, '') : v;
    if (ci) s = s.toLowerCase();
    return s;
  };
}

/** Returns the encoded key, or null when any key field is blank (after the chosen normalization). */
export function encodeKey(cells, keyCols, norm) {
  const parts = new Array(keyCols.length);
  for (let k = 0; k < keyCols.length; k++) {
    const v = norm(cells[keyCols[k]] ?? '');
    if (v === '') return null;
    parts[k] = v;
  }
  return JSON.stringify(parts);
}

/**
 * rows: [{ id, record, cells }] in source order. keyCols: column indices.
 * Returns { groups, missingKey, uniqueRows, duplicateRows, settings }.
 * Group: { key, keyValues, rowIds, records, identical, conflictCols }.
 */
export function findDuplicates(rows, keyCols, opts = {}) {
  if (!keyCols.length) throw new Error('Choose at least one key column.');
  const norm = keyNormalizer(opts);
  const map = new Map();
  const missingKey = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const key = encodeKey(row.cells, keyCols, norm);
    if (key === null) {
      missingKey.push(row.id);
      continue;
    }
    const list = map.get(key);
    if (list) list.push(i);
    else map.set(key, [i]);
  }
  const groups = [];
  let uniqueRows = 0;
  let duplicateRows = 0;
  for (const [key, idxs] of map) {
    if (idxs.length === 1) {
      uniqueRows++;
      continue;
    }
    duplicateRows += idxs.length;
    const first = rows[idxs[0]].cells;
    const conflictCols = [];
    for (let c = 0; c < first.length; c++) {
      for (let j = 1; j < idxs.length; j++) {
        if (rows[idxs[j]].cells[c] !== first[c]) {
          conflictCols.push(c);
          break;
        }
      }
    }
    groups.push({
      key,
      keyValues: keyCols.map((c) => first[c]),
      rowIds: idxs.map((i) => rows[i].id),
      records: idxs.map((i) => rows[i].record),
      identical: conflictCols.length === 0,
      conflictCols,
    });
  }
  // Groups ordered by the position of their first member (Map preserves insertion order already).
  return {
    groups,
    missingKey,
    uniqueRows,
    duplicateRows,
    settings: { keyCols: keyCols.slice(), trim: !!opts.trim, caseInsensitive: !!opts.caseInsensitive },
  };
}

/**
 * Decide survivors.
 * decisions: { [groupKey]: rowId[] } explicit keep lists (at least one row).
 * policy: 'none' | 'first' | 'last' — source record order, never timestamps.
 * reviewed: Set of conflict group keys the user has reviewed (policy may apply to them).
 * Returns { retained: rows, excluded: [{row, groupKey, reason}], unresolved: groupKeys, counts }.
 * Export order follows original order among retained rows.
 */
export function resolveDuplicates(rows, result, { decisions = {}, policy = 'none', reviewed = new Set() } = {}) {
  const drop = new Map(); // rowId -> {groupKey, reason}
  const unresolved = [];
  for (const g of result.groups) {
    let keep = null;
    let reason = '';
    const explicit = decisions[g.key];
    if (explicit && explicit.length) {
      keep = new Set(explicit.filter((id) => g.rowIds.includes(id)));
      reason = 'excluded-by-review';
    }
    if ((!keep || !keep.size) && policy !== 'none' && (g.identical || reviewed.has(g.key))) {
      keep = new Set([policy === 'last' ? g.rowIds[g.rowIds.length - 1] : g.rowIds[0]]);
      reason = policy === 'last' ? 'keep-last-policy' : 'keep-first-policy';
    }
    if (!keep || !keep.size) {
      unresolved.push(g.key); // all members kept until the user decides
      continue;
    }
    for (const id of g.rowIds) if (!keep.has(id)) drop.set(id, { groupKey: g.key, reason, identical: g.identical });
  }
  const retained = [];
  const excluded = [];
  for (const row of rows) {
    const d = drop.get(row.id);
    if (d) excluded.push({ row, ...d });
    else retained.push(row);
  }
  return {
    retained,
    excluded,
    unresolved,
    counts: { retained: retained.length, excluded: excluded.length, unresolvedGroups: unresolved.length },
  };
}
