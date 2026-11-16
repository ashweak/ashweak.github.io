// Import step: choose a file (or a synthetic sample), confirm encoding/delimiter/header
// settings, inspect structure, and resolve blocking problems before the file is used.
import { h, clear, fmt, plural, notice, field, checkbox, select, button, download, announce, confirmDialog } from './dom.js';
import { run } from './worker-client.js';
import { LIMITS, DELIMITERS } from '../core/limits.js';
import { displayLabels } from '../core/dataset.js';
import { writeCsv, safeFilename } from '../core/csv-write.js';
import { dataTable } from './table.js';
import { state, commitFile } from './state.js';

const pending = {}; // slot -> { name, size, bytes, settings, result, error }

const DELIM_NAME = { ',': 'comma', ';': 'semicolon', '\t': 'tab' };

function defaultSettings() {
  return { delimiter: 'auto', hasHeader: true, skipBlankLines: true, padShort: false, expandWide: false, removed: [] };
}

async function reparse(slot, rerender) {
  const p = pending[slot];
  p.error = null;
  try {
    p.result = await run('import', { bytes: p.bytes.slice(0), settings: p.settings }, { label: `Reading ${p.name}…` });
  } catch (err) {
    if (err.code === 'cancelled') {
      delete pending[slot];
    } else {
      p.result = null;
      p.error = err.message;
    }
  }
  rerender();
}

function otherSlotBytes(slot) {
  if (slot === 'baseline') return state.files.updated ? state.files.updated.size : 0;
  if (slot === 'updated') return state.files.baseline ? state.files.baseline.size : 0;
  return 0;
}

async function acceptBytes(slot, name, bytes, rerender) {
  if (bytes.byteLength > LIMITS.fileBytes) {
    pending[slot] = { name, size: bytes.byteLength, error: `“${name}” is ${(bytes.byteLength / 1048576).toFixed(1)} MiB. The limit is ${LIMITS.fileBytes / 1048576} MiB per file. Split the file and try again.` };
    rerender();
    return;
  }
  if (bytes.byteLength + otherSlotBytes(slot) > LIMITS.totalBytes) {
    pending[slot] = { name, size: bytes.byteLength, error: `Together the two comparison files exceed ${LIMITS.totalBytes / 1048576} MiB. Use smaller files.` };
    rerender();
    return;
  }
  pending[slot] = { name, size: bytes.byteLength, bytes, settings: defaultSettings(), result: null, error: null };
  await reparse(slot, rerender);
}

export async function loadSample(slot, file, rerender) {
  const res = await fetch(`samples/${file}`);
  const bytes = await res.arrayBuffer();
  await acceptBytes(slot, file, bytes, rerender);
}

export function hasPending(slot) {
  return !!pending[slot];
}

/**
 * Render the import panel for a slot. opts: { title, samples: [{file,label}], onCommitted, compact }
 */
export function importer(slot, rerender, opts = {}) {
  const p = pending[slot];
  const box = h('section', { class: 'panel importer', 'aria-label': opts.title || 'Choose a CSV file' });
  if (opts.title) box.append(h('h2', { text: opts.title }));

  if (!p) {
    box.append(chooser(slot, rerender, opts));
    return box;
  }

  box.append(
    h('div', { class: 'file-line' },
      h('strong', { text: p.name }),
      h('span', { class: 'muted', text: ` · ${(p.size / 1024).toFixed(1)} KiB` }),
      button('Choose a different file', () => {
        delete pending[slot];
        rerender();
      }, 'small ghost')
    )
  );

  if (p.error) {
    box.append(notice('error', h('strong', { text: 'This file cannot be used. ' }), p.error));
    return box;
  }
  if (!p.result) {
    box.append(h('p', { class: 'muted', text: 'Reading file…' }));
    return box;
  }

  const r = p.result;
  const ds = r.dataset;
  const s = p.settings;
  const set = (k, v) => {
    s[k] = v;
    reparse(slot, rerender);
  };

  // Settings
  box.append(
    h('fieldset', { class: 'settings' },
      h('legend', { text: 'Read settings' }),
      h('div', { class: 'grid-3' },
        field('Encoding', h('input', { value: r.hadBom ? 'UTF-8 (with BOM)' : 'UTF-8', readonly: true }), 'Only UTF-8 is supported.'),
        field('Delimiter', select([{ value: 'auto', label: `Detect (suggested: ${DELIM_NAME[r.detected.delimiter]})` }, ...DELIMITERS], s.delimiter, (v) => set('delimiter', v)), 'Check the preview below; change it if columns look wrong.'),
        h('div', { class: 'field' },
          checkbox('First record contains headers', s.hasHeader, (v) => set('hasHeader', v)),
          checkbox('Skip fully blank lines', s.skipBlankLines, (v) => set('skipBlankLines', v))
        )
      )
    )
  );

  // Summary
  const st = r.stats;
  box.append(
    h('ul', { class: 'stats' },
      stat('Records read', fmt(r.totalRecords)),
      stat('Data rows', fmt(ds.rows.length)),
      stat('Columns', fmt(ds.columns.length)),
      stat('Delimiter', DELIM_NAME[r.delimiter]),
      stat('Blank lines', fmt(st.blankLines)),
      stat('Delimiter-only records', fmt(st.delimiterOnly)),
      stat('Problems', fmt(ds.blocking), ds.blocking ? 'bad' : 'ok')
    )
  );

  if (ds.empty) {
    box.append(notice('error', 'No records remain with these settings.'));
    return box;
  }
  if (!ds.rows.length && !ds.blocking) box.append(notice('info', 'This file has a header but no data records. It can be previewed and exported, but there is nothing to clean.'));

  // Structural problems
  if (ds.blocking) {
    const short = ds.issues.filter((i) => i.type === 'short').length;
    const wide = ds.issues.filter((i) => i.type === 'wide').length;
    const list = h('ul', { class: 'issue-list' });
    for (const iss of ds.issues.slice(0, 100)) {
      const removed = s.removed.includes(iss.record);
      list.append(
        h('li', null,
          h('span', { class: 'badge bad', text: issueLabel(iss.type) }),
          ` Record ${iss.record} (line ${iss.line}${iss.header ? ', header' : ''}): ${iss.detail} `,
          iss.header ? null : button(removed ? 'Keep record' : 'Remove record', () => {
            s.removed = removed ? s.removed.filter((x) => x !== iss.record) : [...s.removed, iss.record];
            reparse(slot, rerender);
          }, 'small')
        )
      );
    }
    box.append(
      notice('error',
        h('h3', { text: `${plural(ds.blocking, 'structural problem')} must be resolved before this file can be used` }),
        h('p', { text: 'Nothing is changed silently. Choose another delimiter or header setting, remove a record, or explicitly fix record widths:' }),
        h('div', { class: 'row-actions' },
          short ? checkbox(`Pad ${plural(short, 'short record')} with empty trailing fields`, s.padShort, (v) => set('padShort', v)) : null,
          wide ? checkbox(`Add columns for ${plural(wide, 'record')} with extra fields`, s.expandWide, (v) => set('expandWide', v)) : null
        ),
        list,
        ds.issues.length > 100 ? h('p', { text: `…and ${fmt(ds.issues.length - 100)} more. Download the issue report for the full list.` }) : null,
        button('Download issue report', () => downloadIssues(p), 'small')
      )
    );
  } else if (s.removed.length || s.padShort || s.expandWide) {
    box.append(notice('warn', `Import decisions recorded: ${s.removed.length} removed, ${ds.log.filter((l) => l.action === 'padded-record').length} padded${s.expandWide ? ', columns expanded' : ''}. They appear in the change log.`));
  }

  // Raw preview (first records) so delimiter/header choices can be checked.
  const raw = h('details', { class: 'raw' }, h('summary', { text: 'Raw record preview (first 30 records)' }));
  const rawList = h('ol', { class: 'raw-list' });
  for (const rec of r.sample) {
    rawList.append(
      h('li', { class: rec.bad ? 'bad' : '' },
        h('span', { class: 'muted', text: `#${rec.record} line ${rec.line}: ` }),
        rec.blank ? h('em', { text: '(blank line)' }) : rec.fields.map((f, i) => [i ? h('span', { class: 'sep', text: ' │ ' }) : null, h('code', { text: f })])
      )
    );
  }
  raw.append(rawList);
  box.append(raw);

  if (ds.rows.length) {
    const labels = displayLabels(ds.columns.map((c) => c.header));
    box.append(
      h('h3', { text: 'Parsed preview' }),
      dataTable({ caption: `Preview of ${p.name}`, labels, rows: ds.rows, cells: (row) => row.cells, meta: [{ label: 'Record', value: (row) => row.record }], pageSize: 10, detailsTitle: (row) => `Record ${row.record}` })
    );
  }

  const ok = !ds.blocking && !ds.empty;
  box.append(
    h('div', { class: 'actions' },
      button(opts.commitLabel || 'Use this file', async () => {
        if (opts.confirmReplace && opts.confirmReplace()) {
          const yes = await confirmDialog('Replace current work?', 'Using a new file clears the current cleaning, duplicate and export work for this tool. Download anything you need first.', 'Replace', true);
          if (!yes) return;
        }
        commitFile(slot, { name: p.name, size: p.size, bytes: p.bytes, settings: { ...s }, result: { hadBom: r.hadBom, delimiter: r.delimiter, stats: r.stats }, dataset: ds });
        delete pending[slot];
        announce(`${p.name} loaded with ${plural(ds.rows.length, 'data row')}.`);
        opts.onCommitted && opts.onCommitted();
      }, 'primary', { disabled: !ok })
    )
  );
  return box;
}

function chooser(slot, rerender, opts) {
  const input = h('input', { type: 'file', accept: '.csv,.tsv,.txt,text/csv,text/tab-separated-values', class: 'sr-only', id: `file-${slot}` });
  input.addEventListener('change', async () => {
    const f = input.files[0];
    if (f) await acceptBytes(slot, f.name, await f.arrayBuffer(), rerender);
  });
  const zone = h('div', { class: 'dropzone' },
    h('p', { class: 'dz-title', text: 'Drop a CSV file here' }),
    h('p', { class: 'muted', text: 'or' }),
    h('label', { for: `file-${slot}`, class: 'btn primary', text: 'Choose file' }),
    input,
    h('p', { class: 'hint', text: `UTF-8 CSV (comma, semicolon or tab). Up to ${LIMITS.fileBytes / 1048576} MiB, ${fmt(LIMITS.records)} records, ${LIMITS.columns} columns. The file stays on this device.` })
  );
  zone.addEventListener('dragover', (e) => {
    e.preventDefault();
    zone.classList.add('over');
  });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', async (e) => {
    e.preventDefault();
    zone.classList.remove('over');
    const f = e.dataTransfer.files[0];
    if (f) await acceptBytes(slot, f.name, await f.arrayBuffer(), rerender);
  });
  const samples = (opts.samples || []).map((sm) => button(`Load sample: ${sm.label}`, () => loadSample(slot, sm.file, rerender), 'ghost small'));
  return h('div', null, zone, samples.length ? h('div', { class: 'samples' }, h('span', { class: 'muted', text: 'Synthetic sample data: ' }), samples) : null);
}

function stat(label, value, kind = '') {
  return h('li', { class: kind }, h('span', { class: 'stat-label', text: label }), h('span', { class: 'stat-value', text: value }));
}

function issueLabel(type) {
  return { short: 'Too few fields', wide: 'Too many fields', 'malformed-quote': 'Quote problem' }[type] || type;
}

function downloadIssues(p) {
  const ds = p.result.dataset;
  const rows = ds.issues.map((i) => [issueLabel(i.type), String(i.record), String(i.line), String(i.fieldCount), String(i.expected), i.detail]);
  const { text } = writeCsv(['Problem', 'Source record', 'Line', 'Fields', 'Expected fields', 'Detail'], rows, { safe: true });
  download(text, safeFilename(p.name, 'import_issues'));
}
