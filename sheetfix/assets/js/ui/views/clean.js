// Clean a file: rules start off, are scoped to chosen columns, run in a displayed order,
// and are previewed before being applied atomically. Undo/redo/reset never touch the source.
import { h, clear, fmt, plural, notice, field, checkbox, select, button, announce, confirmDialog } from '../dom.js';
import { run } from '../worker-client.js';
import { RULE_ORDER, recipeIsEmpty } from '../../core/recipe.js';
import { DATE_FORMATS, NUMBER_FORMATS } from '../../core/validate.js';
import { displayLabels } from '../../core/dataset.js';
import { state, mainDataset, committedRecipe, commitRecipe, invalidateReviews, labels as labelsOf, changed } from '../state.js';
import { importer } from '../importer.js';
import { dataTable } from '../table.js';
import { fileBar } from './common.js';

const RULE_HELP = {
  trim: 'Removes ordinary spaces and tabs at the start and end of each value. Text inside is kept.',
  collapse: 'Replaces runs of spaces inside a value with one space. Avoid on identifier columns.',
  case: 'Converts letters to upper or lower case. Names and codes may be case-sensitive — check the preview.',
  replace: 'Replaces a value only when the whole field matches. No partial or pattern matching.',
  dateOut: 'Rewrites valid dates from the source format to the output format. Invalid values stay unchanged and are flagged.',
  required: 'Flags blank cells in the chosen columns. Nothing is filled in.',
  numeric: 'Flags values that are not numbers in the chosen format. Values are not converted.',
  dateCheck: 'Flags values that are not real calendar dates in the chosen format.',
  removeEmpty: 'Removes records whose every field is empty. Removed records can be downloaded separately.',
};

let showImporter = false;
let previewTimer = null;

export function renderClean(root, rerender) {
  const ds = mainDataset();
  if (!ds || showImporter) {
    root.append(
      h('h1', { text: 'Clean a file' }),
      h('p', { class: 'lead', text: 'Choose a CSV file, review the fixes, and download a clean copy. Nothing changes until you apply it.' }),
      showImporter && ds ? button('Back to current file', () => { showImporter = false; rerender(); }, 'ghost small') : null,
      importer('main', rerender, {
        samples: [{ file: 'products_messy.csv', label: 'messy product list' }],
        confirmReplace: () => !!ds,
        onCommitted: () => { showImporter = false; },
      })
    );
    return;
  }

  const c = state.clean;
  const labels = labelsOf(ds);
  root.append(
    h('h1', { text: 'Clean a file' }),
    fileBar(() => { showImporter = true; rerender(); }),
    historyBar(rerender),
    h('div', { class: 'clean-layout' }, rulesPanel(ds, labels, c.draft, rerender), h('div', { class: 'preview-pane', id: 'clean-preview' }))
  );
  drawPreview(ds, labels, rerender);
  schedulePreview(ds, labels, rerender, 0);
}

function historyBar(rerender) {
  const c = state.clean;
  const committedEmpty = recipeIsEmpty(committedRecipe());
  const undo = async () => {
    c.pointer--;
    await recompute(rerender);
  };
  const redo = async () => {
    c.pointer++;
    await recompute(rerender);
  };
  const reset = async () => {
    if (!(await confirmDialog('Reset to original?', 'This removes all applied cleaning rules and returns to the file exactly as imported. You can redo afterwards.', 'Reset'))) return;
    const c2 = state.clean;
    commitRecipe(c2.history[0], null);
    c2.draft = structuredClone(c2.history[0]);
    announce('Reset to the original file.');
    rerender();
  };
  return h('div', { class: 'history-bar', role: 'toolbar', 'aria-label': 'History' },
    h('span', { class: 'muted', text: committedEmpty ? 'No rules applied — the working copy matches the import.' : `Applied recipe revision ${c.revision}.` }),
    button('Undo', undo, 'small', { disabled: c.pointer === 0 }),
    button('Redo', redo, 'small', { disabled: c.pointer >= c.history.length - 1 }),
    button('Reset to original', reset, 'small', { disabled: committedEmpty })
  );
}

/** Recompute the committed view after undo/redo; failure leaves the prior view intact. */
async function recompute(rerender) {
  const c = state.clean;
  const recipe = c.history[c.pointer];
  try {
    c.view = recipeIsEmpty(recipe) ? null : await run('recipe', { dataset: mainDataset(), recipe }, { label: 'Re-applying recipe…' });
    c.revision++;
    c.draft = structuredClone(recipe);
    c.preview = null;
    invalidateReviews();
    announce('History step restored.');
  } catch (err) {
    if (err.code !== 'cancelled') announce(err.message);
  }
  rerender();
}

function colPicker(rule, labels, onChange) {
  const sel = new Set(rule.cols);
  const summary = h('summary', { text: `Columns (${sel.size} selected)` });
  const list = h('div', { class: 'col-list' });
  labels.forEach((l, i) => {
    const id = 'c' + i;
    list.append(checkbox(l, sel.has(id), (v) => {
      if (v) sel.add(id);
      else sel.delete(id);
      rule.cols = [...sel];
      summary.textContent = `Columns (${sel.size} selected)`;
      onChange();
    }));
  });
  return h('details', { class: 'col-picker', open: rule.on && !rule.cols.length }, summary, list);
}

function rulesPanel(ds, labels, draft, rerender) {
  const onChange = () => schedulePreview(ds, labels, rerender);
  const panel = h('section', { class: 'panel rules', 'aria-label': 'Cleaning rules' });
  panel.append(h('h2', { text: 'Rules' }), h('p', { class: 'hint', text: 'All rules start off. They run in this order:' }));
  const ol = h('ol', { class: 'rule-list' });
  for (const rule of RULE_ORDER) {
    const cfg = draft[rule.id];
    const body = h('div', { class: 'rule-body', hidden: !cfg.on });
    body.append(h('p', { class: 'hint', text: RULE_HELP[rule.id] }));
    const picker = rule.id !== 'removeEmpty' ? colPicker(cfg, labels, onChange) : null;
    body.append(picker);
    if (rule.id === 'case') {
      body.append(field('Convert to', select([{ value: 'upper', label: 'UPPERCASE' }, { value: 'lower', label: 'lowercase' }], cfg.mode, (v) => { cfg.mode = v; onChange(); })));
    }
    if (rule.id === 'replace') body.append(replaceEditor(cfg, onChange));
    if (rule.id === 'dateOut') {
      body.append(
        field('Source format', select(DATE_FORMATS.map((f) => ({ value: f, label: f })), cfg.source, (v) => { cfg.source = v; onChange(); })),
        field('Output format', select(DATE_FORMATS.map((f) => ({ value: f, label: f })), cfg.output, (v) => { cfg.output = v; onChange(); }))
      );
    }
    if (rule.id === 'dateCheck') {
      body.append(field('Expected format', select(DATE_FORMATS.map((f) => ({ value: f, label: f })), cfg.source, (v) => { cfg.source = v; onChange(); }), 'Ambiguous dates such as 01/02/2026 are judged only by the format you choose.'));
    }
    if (rule.id === 'numeric') {
      body.append(field('Number format', select(NUMBER_FORMATS.map((f) => ({ value: f.id, label: f.label })), cfg.format, (v) => { cfg.format = v; onChange(); })));
    }
    if (rule.id === 'removeEmpty') {
      body.append(checkbox('Treat whitespace-only fields as empty', cfg.whitespaceIsEmpty, (v) => { cfg.whitespaceIsEmpty = v; onChange(); }));
    }
    ol.append(
      h('li', { class: 'rule' },
        checkbox(rule.label, cfg.on, (v) => {
          cfg.on = v;
          body.hidden = !v;
          if (v && picker && !cfg.cols.length) picker.open = true;
          onChange();
        }),
        body
      )
    );
  }
  panel.append(ol, headerEditor(ds, draft, onChange, rerender));
  return panel;
}

function replaceEditor(cfg, onChange) {
  const wrap = h('div', { class: 'pairs' });
  const draw = () => {
    clear(wrap);
    cfg.pairs.forEach((p, i) => {
      wrap.append(
        h('div', { class: 'pair' },
          h('input', { 'aria-label': `Find value ${i + 1}`, placeholder: 'Whole value', value: p.find, oninput: (e) => { p.find = e.target.value; onChange(); } }),
          h('span', { 'aria-hidden': 'true', text: '→' }),
          h('input', { 'aria-label': `Replacement ${i + 1}`, placeholder: 'Replace with', value: p.replace, oninput: (e) => { p.replace = e.target.value; onChange(); } }),
          button('Remove', () => { cfg.pairs.splice(i, 1); draw(); onChange(); }, 'small ghost', { 'aria-label': `Remove replacement ${i + 1}` })
        )
      );
    });
    wrap.append(
      button('Add replacement', () => { cfg.pairs.push({ find: '', replace: '' }); draw(); onChange(); }, 'small'),
      checkbox('Match case exactly', cfg.caseSensitive, (v) => { cfg.caseSensitive = v; onChange(); }),
      checkbox('Ignore spaces at the edges when matching', cfg.ignoreEdgeSpaces, (v) => { cfg.ignoreEdgeSpaces = v; onChange(); })
    );
  };
  draw();
  return wrap;
}

function headerEditor(ds, draft, onChange) {
  const he = draft.headerEdits;
  const det = h('details', { class: 'header-edit', open: Object.keys(he.names).length > 0 || he.order.length > 0 }, h('summary', { text: 'Header editing (rename / reorder output columns)' }));
  const list = h('ol', { class: 'header-list' });
  const warn = h('p', { class: 'hint warn-text', 'aria-live': 'polite' });
  const order = () => (he.order.length === ds.columns.length ? he.order : ds.columns.map((c) => c.id));
  const nameOf = (id) => (Object.prototype.hasOwnProperty.call(he.names, id) ? he.names[id] : ds.columns.find((c) => c.id === id).header);
  const checkDup = () => {
    const names = order().map(nameOf);
    const dups = names.filter((n, i) => names.indexOf(n) !== i);
    warn.textContent = dups.length ? `Duplicate header names: ${[...new Set(dups)].map((d) => d || '(blank)').join(', ')}. They will be exported as written.` : '';
  };
  const draw = () => {
    clear(list);
    const ord = order();
    ord.forEach((id, i) => {
      const col = ds.columns.find((c) => c.id === id);
      const move = (d) => {
        const o = ord.slice();
        [o[i], o[i + d]] = [o[i + d], o[i]];
        he.order = o;
        draw();
        onChange();
      };
      list.append(
        h('li', null,
          h('input', {
            'aria-label': `Header for column ${col.index + 1}`,
            value: nameOf(id),
            oninput: (e) => {
              if (e.target.value === col.header) delete he.names[id];
              else he.names[id] = e.target.value;
              checkDup();
              onChange();
            },
          }),
          button('↑', () => move(-1), 'small ghost', { disabled: i === 0, 'aria-label': `Move column ${col.index + 1} up` }),
          button('↓', () => move(1), 'small ghost', { disabled: i === ord.length - 1, 'aria-label': `Move column ${col.index + 1} down` })
        )
      );
    });
    checkDup();
  };
  draw();
  det.append(h('p', { class: 'hint', text: 'Changes affect exported files only. Matching and comparison use the original column positions.' }), list, warn, button('Restore original headers', () => { he.names = {}; he.order = []; draw(); onChange(); }, 'small ghost'));
  return det;
}

function schedulePreview(ds, labels, rerender, delay = 350) {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(async () => {
    const c = state.clean;
    if (!c) return;
    const snapshot = structuredClone(c.draft);
    const sig = JSON.stringify(snapshot);
    if (c.preview && c.preview.sig === sig) return drawPreview(ds, labels, rerender);
    if (recipeIsEmpty(snapshot)) {
      c.preview = { sig, recipe: snapshot, result: null };
      return drawPreview(ds, labels, rerender);
    }
    try {
      const result = await run('recipe', { dataset: ds, recipe: snapshot }, { label: 'Previewing rules…' });
      if (state.clean !== c || JSON.stringify(c.draft) !== sig) return; // outdated
      c.preview = { sig, recipe: snapshot, result };
    } catch (err) {
      if (err.code === 'cancelled') return;
      c.preview = { sig, recipe: snapshot, error: err.message };
    }
    drawPreview(ds, labels, rerender);
  }, delay);
}

function drawPreview(ds, labels, rerender) {
  const pane = document.getElementById('clean-preview');
  if (!pane) return;
  clear(pane);
  const c = state.clean;
  const pv = c.preview;
  const committedSig = JSON.stringify(committedRecipe());
  const isCommitted = pv && pv.sig === committedSig;
  pane.append(h('h2', { text: 'Preview' }));
  if (!pv) {
    pane.append(h('p', { class: 'muted', text: 'Preparing preview…' }));
    return;
  }
  if (pv.error) {
    pane.append(notice('error', pv.error));
    return;
  }
  const res = pv.result;
  const counts = res ? res.counts : { changedCells: 0, affectedRows: 0, excludedRows: 0, issues: 0, issueRows: 0 };
  pane.append(
    h('ul', { class: 'stats' },
      h('li', null, h('span', { class: 'stat-label', text: 'Cells changed' }), h('span', { class: 'stat-value', text: fmt(counts.changedCells) })),
      h('li', null, h('span', { class: 'stat-label', text: 'Rows affected' }), h('span', { class: 'stat-value', text: fmt(counts.affectedRows) })),
      h('li', { class: counts.excludedRows ? 'warn' : '' }, h('span', { class: 'stat-label', text: 'Rows removed' }), h('span', { class: 'stat-value', text: fmt(counts.excludedRows) })),
      h('li', { class: counts.issues ? 'warn' : '' }, h('span', { class: 'stat-label', text: 'Values flagged' }), h('span', { class: 'stat-value', text: `${fmt(counts.issues)} in ${plural(counts.issueRows, 'row')}` }))
    )
  );

  const apply = async () => {
    if (counts.excludedRows && !(await confirmDialog('Apply rules?', `${plural(counts.changedCells, 'cell')} will change and ${plural(counts.excludedRows, 'empty record')} will be removed from the working copy. The original file is kept and you can undo.`, 'Apply'))) return;
    commitRecipe(pv.recipe, res);
    announce('Rules applied to the working copy.');
    rerender();
  };
  const discard = () => {
    c.draft = structuredClone(committedRecipe());
    c.preview = null;
    rerender();
  };
  pane.append(
    h('div', { class: 'actions' },
      isCommitted ? h('span', { class: 'badge ok', text: 'Applied' }) : button('Apply rules', apply, 'primary'),
      isCommitted ? null : button('Discard changes', discard, 'ghost'),
      state.dups && state.dups.result && !isCommitted ? h('span', { class: 'hint', text: 'Applying will require duplicate review to be run again.' }) : null
    )
  );
  if (!res) {
    pane.append(h('p', { class: 'muted', text: 'Turn on a rule and choose columns to see the changes it would make.' }));
    return;
  }
  const outLabels = displayLabels(ds.columns.map((x) => x.header));
  if (res.changes.length) {
    pane.append(
      h('h3', { text: 'Before / after' }),
      dataTable({
        caption: 'Changed values',
        labels: ['Column', 'Rule', 'Before', 'After'],
        rows: res.changes,
        meta: [{ label: 'Record', value: (ch) => ch.record }],
        cells: (ch) => [outLabels[ch.col], ruleName(ch.rule), visible(ch.old), visible(ch.new)],
        cellClass: (ch, i) => (i === 2 ? 'old' : i === 3 ? 'new' : ''),
        pageSize: 25,
      })
    );
  }
  if (res.excluded.length) {
    pane.append(h('h3', { text: 'Records to remove' }), dataTable({ caption: 'Removed records', labels, rows: res.excluded, meta: [{ label: 'Record', value: (x) => x.record }], cells: (x) => x.cells, pageSize: 10 }));
  }
  if (res.issues.length) {
    pane.append(
      h('h3', { text: 'Flagged values (not changed)' }),
      dataTable({ caption: 'Validation issues', labels: ['Column', 'Check', 'Value', 'Message'], rows: res.issues, meta: [{ label: 'Record', value: (x) => x.record }], cells: (x) => [outLabels[x.col], ruleName(x.rule), x.value, x.message], pageSize: 25 })
    );
  }
}

const ruleName = (id) => (RULE_ORDER.find((r) => r.id === id) || { label: id }).label;
/** Make edge whitespace visible in before/after cells. */
const visible = (s) => s.replace(/^ +| +$/g, (m) => '·'.repeat(m.length)).replace(/\t/g, '⇥');
