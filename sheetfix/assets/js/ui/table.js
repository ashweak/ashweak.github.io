// Paginated, filterable data table. The filter searches the complete in-memory
// dataset, not just the visible page, and shows filtered versus total counts.
import { h, clear, fmt, showDetails, announce } from './dom.js';

/**
 * opts: {
 *   caption, labels: string[], rows: any[], cells: (row) => string[],
 *   meta?: [{ label, value: (row) => string }]   leading columns (e.g. record number)
 *   cellClass?: (row, colIndex) => string,
 *   pageSize = 50, emptyText, detailsTitle?: (row) => string,
 * }
 */
export function dataTable(opts) {
  const pageSize = opts.pageSize || 50;
  const meta = opts.meta || [];
  let page = 0;
  let query = '';
  let filtered = opts.rows;

  const wrap = h('div', { class: 'table-block' });
  const status = h('p', { class: 'table-status', 'aria-live': 'polite' });
  const scroller = h('div', { class: 'table-scroll', tabindex: '0', role: 'region', 'aria-label': opts.caption || 'Data table' });
  const prev = h('button', { type: 'button', class: 'btn small', text: 'Previous', onclick: () => go(page - 1) });
  const next = h('button', { type: 'button', class: 'btn small', text: 'Next', onclick: () => go(page + 1) });
  const filterInput = h('input', { type: 'search', placeholder: 'Filter all rows…', 'aria-label': `Filter ${opts.caption || 'rows'}` });
  let t;
  filterInput.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(() => {
      query = filterInput.value.toLowerCase();
      filtered = query ? opts.rows.filter((r) => opts.cells(r).some((c) => c.toLowerCase().includes(query)) || meta.some((m) => String(m.value(r)).toLowerCase().includes(query))) : opts.rows;
      page = 0;
      draw();
    }, 200);
  });

  const toolbar = h('div', { class: 'table-toolbar' }, opts.rows.length > 5 ? filterInput : null, status, h('div', { class: 'pager' }, prev, next));
  wrap.append(toolbar, scroller);

  function go(p) {
    page = Math.max(0, Math.min(p, Math.max(0, Math.ceil(filtered.length / pageSize) - 1)));
    draw();
    announce(`Page ${page + 1}`);
  }

  function draw() {
    clear(scroller);
    const total = opts.rows.length;
    const start = page * pageSize;
    const slice = filtered.slice(start, start + pageSize);
    const shown = slice.length ? `${fmt(start + 1)}–${fmt(start + slice.length)} of ${fmt(filtered.length)}` : '0';
    status.textContent = query ? `Showing ${shown} matching rows (filtered from ${fmt(total)})` : `Showing ${shown} rows`;
    prev.disabled = page === 0;
    next.disabled = start + pageSize >= filtered.length;
    if (!slice.length) {
      scroller.append(h('p', { class: 'empty', text: query ? 'No rows match the filter.' : opts.emptyText || 'No rows.' }));
      return;
    }
    const table = h('table', { class: 'data' });
    if (opts.caption) table.append(h('caption', { class: 'sr-only', text: opts.caption }));
    const headRow = h('tr');
    for (const m of meta) headRow.append(h('th', { scope: 'col', class: 'meta', text: m.label }));
    for (const l of opts.labels) headRow.append(h('th', { scope: 'col', text: l }));
    if (opts.detailsTitle) headRow.append(h('th', { scope: 'col', class: 'meta' }, h('span', { class: 'sr-only', text: 'Details' })));
    table.append(h('thead', null, headRow));
    const body = h('tbody');
    for (const row of slice) {
      const tr = h('tr');
      for (const m of meta) tr.append(h('td', { class: 'meta', text: m.value(row) }));
      const cells = opts.cells(row);
      cells.forEach((c, i) => {
        const cls = opts.cellClass ? opts.cellClass(row, i) : '';
        tr.append(h('td', { class: cls + (c === '' ? ' blank' : '') }, c === '' ? '' : c.length > 120 ? c.slice(0, 120) + '…' : c));
      });
      if (opts.detailsTitle) {
        tr.append(
          h('td', { class: 'meta' },
            h('button', {
              type: 'button',
              class: 'btn small ghost',
              'aria-label': `Details for ${opts.detailsTitle(row)}`,
              text: 'View',
              onclick: () => showDetails(opts.detailsTitle(row), [...meta.map((m) => m.label), ...opts.labels], [...meta.map((m) => String(m.value(row))), ...cells]),
            })
          )
        );
      }
      body.append(tr);
    }
    table.append(body);
    scroller.append(table);
  }
  draw();
  return wrap;
}
