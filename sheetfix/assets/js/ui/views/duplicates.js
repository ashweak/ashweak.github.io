// Find duplicates: exact key matching by default; blank keys never group; conflicting
// groups must be reviewed before any keep-first/keep-last policy applies to them.
import { h, clear, fmt, plural, notice, checkbox, button, announce, confirmDialog } from '../dom.js';
import { run } from '../worker-client.js';
import { resolveDuplicates } from '../../core/duplicates.js';
import { keyText } from '../../core/compare.js';
import { state, mainDataset, workingView, changed } from '../state.js';
import { importer } from '../importer.js';
import { dataTable } from '../table.js';
import { fileBar } from './common.js';

const PAGE = 10;

function dupState() {
  if (!state.dups) {
    state.dups = { keyCols: [], trim: false, caseInsensitive: false, result: null, revision: 0, stale: false, draft: emptyDraft(), confirmed: null, history: [], page: 0, filter: 'all' };
  }
  return state.dups;
}
const emptyDraft = () => ({ decisions: {}, policy: 'none', reviewed: [] });

export function renderDuplicates(root, rerender, go) {
  root.append(h('h1', { text: 'Find duplicates' }));
  if (!mainDataset()) {
    root.append(
      h('p', { class: 'lead', text: 'Choose the columns that identify a record. Groups sharing a key are shown for review; nothing is removed automatically.' }),
      importer('main', rerender, { samples: [{ file: 'products_messy.csv', label: 'messy product list' }] })
    );
    return;
  }
  const d = dupState();
  const view = workingView();
  root.append(fileBar(() => go('clean')), keyPanel(d, view, rerender));
  if (!d.result) return;
  if (d.stale) {
    root.append(notice('warn', 'The working copy changed after this review (cleaning rules were applied or undone). Run the search again before using these results.', ' ', button('Run again', () => find(d, rerender), 'small primary')));
    return;
  }
  root.append(resultPanel(d, view, rerender));
}

function keyPanel(d, view, rerender) {
  const panel = h('section', { class: 'panel', 'aria-label': 'Key columns' });
  const list = h('div', { class: 'col-list inline' });
  view.labels.forEach((l, i) => {
    list.append(checkbox(l, d.keyCols.includes(i), (v) => {
      d.keyCols = v ? [...d.keyCols, i].sort((a, b) => a - b) : d.keyCols.filter((x) => x !== i);
      btn.disabled = !d.keyCols.length;
    }));
  });
  const btn = button(d.result ? 'Search again' : 'Find duplicates', () => find(d, rerender), 'primary', { disabled: !d.keyCols.length });
  panel.append(
    h('h2', { text: '1. Choose key columns' }),
    h('p', { class: 'hint', text: 'Rows are duplicates when every chosen key field is equal. Rows with any blank key field are listed separately and never grouped.' }),
    list,
    h('fieldset', { class: 'inline-options' },
      h('legend', { text: 'Matching (exact by default)' }),
      checkbox('Ignore spaces at the edges when matching', d.trim, (v) => (d.trim = v)),
      checkbox('Ignore upper/lower case when matching', d.caseInsensitive, (v) => (d.caseInsensitive = v)),
      h('p', { class: 'hint', text: 'These options affect matching only. Values in your file are not rewritten.' })
    ),
    h('div', { class: 'actions' }, btn)
  );
  return panel;
}

async function find(d, rerender) {
  if (d.confirmed && !(await confirmDialog('Search again?', 'Your confirmed duplicate decisions will be cleared.', 'Search again'))) return;
  const view = workingView();
  try {
    const result = await run('dups', { rows: view.rows, keyCols: d.keyCols, opts: { trim: d.trim, caseInsensitive: d.caseInsensitive } }, { label: 'Finding duplicates…' });
    Object.assign(d, { result, revision: view.revision, stale: false, draft: emptyDraft(), confirmed: null, history: [], page: 0, filter: 'all' });
    announce(`${plural(result.groups.length, 'duplicate group')} found.`);
  } catch (err) {
    if (err.code !== 'cancelled') announce(err.message);
  }
  rerender();
}

function resultPanel(d, view, rerender) {
  const res = d.result;
  const s = res.settings;
  const identical = res.groups.filter((g) => g.identical).length;
  const conflicting = res.groups.length - identical;
  const live = resolveDuplicates(view.rows, res, { decisions: d.draft.decisions, policy: d.draft.policy, reviewed: new Set(d.draft.reviewed) });
  const excludedIds = new Set(live.excluded.map((e) => e.row.id));
  const rowById = new Map(view.rows.map((r) => [r.id, r]));

  const panel = h('section', { class: 'panel', 'aria-label': 'Duplicate results' });
  panel.append(
    h('h2', { text: '2. Review groups' }),
    h('p', { class: 'settings-line' },
      `Key: ${s.keyCols.map((i) => view.labels[i]).join(' + ')} · `,
      `Matching: ${s.trim || s.caseInsensitive ? [s.trim && 'edge spaces ignored', s.caseInsensitive && 'case ignored'].filter(Boolean).join(', ') : 'exact (case and spaces significant)'}`
    ),
    h('ul', { class: 'stats' },
      stat('Unique keys', fmt(res.uniqueRows)),
      stat('Duplicate groups', fmt(res.groups.length)),
      stat('Fully identical groups', fmt(identical)),
      stat('Conflicting groups', fmt(conflicting), conflicting ? 'warn' : ''),
      stat('Rows in groups', fmt(res.duplicateRows)),
      stat('Missing key', fmt(res.missingKey.length), res.missingKey.length ? 'warn' : '')
    )
  );

  if (!res.groups.length) {
    panel.append(notice('ok', 'No duplicate keys found with these settings.'));
  } else {
    // Policy
    const policy = h('fieldset', { class: 'inline-options' }, h('legend', { text: 'Default decision for groups' }));
    for (const [value, label] of [['none', 'Decide each group myself'], ['first', 'Keep first in file order'], ['last', 'Keep last in file order']]) {
      policy.append(
        h('label', { class: 'check' },
          h('input', { type: 'radio', name: 'dup-policy', value, checked: d.draft.policy === value, onchange: () => { d.draft.policy = value; rerender(); } }),
          h('span', { text: label })
        )
      );
    }
    policy.append(h('p', { class: 'hint', text: '“First/last” means position in the file, not the newest date. It applies automatically only to fully identical groups; conflicting groups need your review first.' }));
    panel.append(policy);

    // Filter + group navigator
    const filters = [['all', 'All'], ['conflict', 'Conflicting'], ['identical', 'Identical'], ['unresolved', 'Undecided']];
    const unresolved = new Set(live.unresolved);
    const groups = res.groups.filter((g) => d.filter === 'all' || (d.filter === 'conflict' && !g.identical) || (d.filter === 'identical' && g.identical) || (d.filter === 'unresolved' && unresolved.has(g.key)));
    const pages = Math.max(1, Math.ceil(groups.length / PAGE));
    d.page = Math.min(d.page, pages - 1);
    panel.append(
      h('div', { class: 'tabs', role: 'group', 'aria-label': 'Show groups' },
        filters.map(([v, l]) => button(l, () => { d.filter = v; d.page = 0; rerender(); }, d.filter === v ? 'small primary' : 'small', { 'aria-pressed': d.filter === v ? 'true' : 'false' }))
      ),
      h('p', { class: 'table-status', text: `Groups ${groups.length ? d.page * PAGE + 1 : 0}–${Math.min(groups.length, (d.page + 1) * PAGE)} of ${fmt(groups.length)}` }),
      h('div', { class: 'pager' },
        button('Previous groups', () => { d.page--; rerender(); }, 'small', { disabled: d.page === 0 }),
        button('Next groups', () => { d.page++; rerender(); }, 'small', { disabled: d.page >= pages - 1 })
      )
    );
    for (const g of groups.slice(d.page * PAGE, (d.page + 1) * PAGE)) panel.append(groupCard(g, d, view, rowById, excludedIds, unresolved.has(g.key), rerender));
  }

  if (res.missingKey.length) {
    panel.append(
      h('details', { class: 'missing' },
        h('summary', { text: `${plural(res.missingKey.length, 'row')} with a missing key (kept, never grouped)` }),
        dataTable({ caption: 'Rows with missing key', labels: view.labels, rows: res.missingKey.map((id) => rowById.get(id)), meta: [{ label: 'Record', value: (r) => r.record }], cells: (r) => r.cells, pageSize: 10 })
      )
    );
  }

  // Confirmation
  const confirmedSig = d.confirmed ? JSON.stringify(d.confirmed) : null;
  const dirty = JSON.stringify(d.draft) !== confirmedSig;
  const confirm = async () => {
    const msg = h('div', null,
      h('p', { text: `${plural(live.counts.retained, 'row')} will be kept and ${plural(live.counts.excluded, 'row')} excluded from the working copy for export.` }),
      live.counts.unresolvedGroups ? h('p', { text: `${plural(live.counts.unresolvedGroups, 'group')} still undecided: all of their rows will be kept.` }) : null,
      h('p', { class: 'hint', text: 'Excluded rows can be downloaded separately. You can undo.' })
    );
    if (!(await confirmDialog('Confirm duplicate decisions', msg, 'Confirm'))) return;
    d.history.push(d.confirmed);
    d.confirmed = structuredClone(d.draft);
    announce('Duplicate decisions confirmed.');
    changed();
  };
  const undo = () => {
    d.confirmed = d.history.pop() || null;
    d.draft = d.confirmed ? structuredClone(d.confirmed) : emptyDraft();
    announce('Duplicate decisions restored.');
    changed();
  };
  panel.append(
    h('div', { class: 'sticky-summary', role: 'status' },
      h('span', null, h('strong', { text: `${fmt(live.counts.retained)} kept · ${fmt(live.counts.excluded)} excluded` }), live.counts.unresolvedGroups ? ` · ${plural(live.counts.unresolvedGroups, 'group')} undecided` : ''),
      d.confirmed && !dirty ? h('span', { class: 'badge ok', text: 'Confirmed' }) : button('Confirm decisions', confirm, 'primary', { disabled: !res.groups.length }),
      button('Undo', undo, 'small', { disabled: !d.confirmed }),
      dirty && d.confirmed ? button('Discard edits', () => { d.draft = structuredClone(d.confirmed); rerender(); }, 'small ghost') : null
    )
  );
  return panel;
}

function groupCard(g, d, view, rowById, excludedIds, isUnresolved, rerender) {
  const reviewed = d.draft.reviewed.includes(g.key);
  const card = h('article', { class: `group ${g.identical ? '' : 'conflict'}`, 'aria-label': `Group ${keyText(g.key)}` });
  card.append(
    h('header', null,
      h('span', { class: `badge ${g.identical ? 'ok' : 'warn'}`, text: g.identical ? 'Identical' : 'Conflicting' }),
      h('strong', { text: ` Key: ${g.keyValues.join(' | ')} ` }),
      h('span', { class: 'muted', text: `· ${g.rowIds.length} rows${g.identical ? '' : ` · differs in ${g.conflictCols.map((c) => view.labels[c]).join(', ')}`}` }),
      isUnresolved ? h('span', { class: 'badge', text: 'Undecided' }) : null
    )
  );
  const table = h('table', { class: 'data group-table' });
  const head = h('tr', null, h('th', { scope: 'col', class: 'meta', text: 'Keep' }), h('th', { scope: 'col', class: 'meta', text: 'Record' }), view.labels.map((l) => h('th', { scope: 'col', text: l })));
  table.append(h('thead', null, head));
  const body = h('tbody');
  g.rowIds.forEach((id) => {
    const row = rowById.get(id);
    const kept = !excludedIds.has(id);
    const toggle = h('input', {
      type: 'checkbox',
      checked: kept,
      'aria-label': `Keep record ${row.record}`,
      onchange: (e) => {
        const keep = new Set(g.rowIds.filter((x) => !excludedIds.has(x)));
        if (e.target.checked) keep.add(id);
        else keep.delete(id);
        if (!keep.size) {
          e.target.checked = true;
          announce('At least one row in a group must be kept.');
          return;
        }
        d.draft.decisions[g.key] = [...keep];
        if (!g.identical && !reviewed) d.draft.reviewed.push(g.key);
        rerender();
      },
    });
    body.append(
      h('tr', { class: kept ? '' : 'excluded' },
        h('td', { class: 'meta' }, toggle),
        h('td', { class: 'meta', text: row.record }),
        row.cells.map((c, ci) => h('td', { class: (g.conflictCols.includes(ci) ? 'conflict-cell' : '') + (c === '' ? ' blank' : '') }, c))
      )
    );
  });
  table.append(body);
  card.append(h('div', { class: 'table-scroll' }, table));
  if (!g.identical) {
    card.append(
      checkbox('I have reviewed this group (allows the default decision to apply)', reviewed, (v) => {
        d.draft.reviewed = v ? [...d.draft.reviewed, g.key] : d.draft.reviewed.filter((k) => k !== g.key);
        rerender();
      })
    );
  }
  if (d.draft.decisions[g.key]) card.append(button('Clear my choice for this group', () => { delete d.draft.decisions[g.key]; rerender(); }, 'small ghost'));
  return card;
}

function stat(label, value, kind = '') {
  return h('li', { class: kind }, h('span', { class: 'stat-label', text: label }), h('span', { class: 'stat-value', text: value }));
}
