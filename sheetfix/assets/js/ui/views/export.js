// Export: choose an output, check settings and safety mode, preview, download.
import { h, fmt, plural, notice, field, checkbox, select, button, download } from '../dom.js';
import { writeCsv, safeFilename } from '../../core/csv-write.js';
import { DELIMITERS, APP_VERSION } from '../../core/limits.js';
import { state } from '../state.js';
import { availableOutputs, buildOutput, outputBaseName } from '../outputs.js';

let opts = null;

export function renderExport(root, rerender, go) {
  root.append(h('h1', { text: 'Export' }));
  const outputs = availableOutputs();
  if (!outputs.length) {
    root.append(
      h('p', { class: 'lead', text: 'Nothing to export yet. Load a file in Clean a file or run a comparison first.' }),
      h('div', { class: 'actions' }, button('Clean a file', () => go('clean'), 'primary'), button('Compare two lists', () => go('compare')))
    );
    return;
  }
  const srcDelim = state.files.main ? state.files.main.result.delimiter : ',';
  if (!opts) opts = { id: 'cleaned', delimiter: srcDelim, bom: true, header: null, safe: true, allowPlainNumbers: false };
  if (!outputs.find((o) => o.id === opts.id && !o.disabled)) opts.id = outputs.find((o) => !o.disabled).id;
  const chosen = outputs.find((o) => o.id === opts.id);
  const includeHeader = opts.header === null ? (chosen.data ? state.files.main.settings.hasHeader : true) : opts.header;

  const list = h('fieldset', { class: 'output-list' }, h('legend', { text: '1. Choose an output' }));
  for (const o of outputs) {
    list.append(
      h('label', { class: `output ${o.disabled ? 'disabled' : ''}` },
        h('input', { type: 'radio', name: 'output', value: o.id, checked: o.id === opts.id, disabled: !!o.disabled, onchange: () => { opts.id = o.id; opts.header = null; rerender(); } }),
        h('span', null, h('strong', { text: o.label }), h('span', { class: 'hint block', text: o.desc }))
      )
    );
  }

  const settings = h('fieldset', { class: 'settings' },
    h('legend', { text: '2. Settings' }),
    h('div', { class: 'grid-3' },
      field('Delimiter', select(DELIMITERS, opts.delimiter, (v) => { opts.delimiter = v; rerender(); })),
      h('div', { class: 'field' },
        checkbox('Add UTF-8 BOM (helps spreadsheet programs detect UTF-8)', opts.bom, (v) => { opts.bom = v; rerender(); }),
        checkbox(chosen.data && !state.files.main.settings.hasHeader ? 'Include a header row (Column 1, Column 2, …)' : 'Include header row', includeHeader, (v) => { opts.header = v; rerender(); })
      ),
      h('div', { class: 'field' }, h('span', { class: 'label', text: 'Line endings' }), h('span', { text: 'CRLF (Windows/Excel standard)' }))
    ),
    h('div', { class: 'safety' },
      h('h3', { text: 'Spreadsheet safety' }),
      h('label', { class: 'check' },
        h('input', { type: 'radio', name: 'safety', checked: opts.safe, onchange: () => { opts.safe = true; rerender(); } }),
        h('span', null, h('strong', { text: 'Spreadsheet-safe (recommended)' }), h('span', { class: 'hint block', text: 'Text starting with = + - @, tab or carriage return gets a leading apostrophe so spreadsheet programs do not run it as a formula. This changes the exported text of those cells.' }))
      ),
      opts.safe ? h('div', { class: 'indent' }, checkbox('Leave plain numbers unprotected (e.g. -12.50, +639171234567)', opts.allowPlainNumbers, (v) => { opts.allowPlainNumbers = v; rerender(); })) : null,
      h('label', { class: 'check' },
        h('input', { type: 'radio', name: 'safety', checked: !opts.safe, onchange: () => { opts.safe = false; rerender(); } }),
        h('span', null, h('strong', { text: 'Exact text for system import' }), h('span', { class: 'hint block', text: 'Writes every value exactly. Use when importing into another system. Opening this file in a spreadsheet program may run formula-like text.' }))
      )
    )
  );

  const out = buildOutput(chosen.id);
  const header = includeHeader ? out.header : null;
  const result = writeCsv(header, out.rows, { delimiter: opts.delimiter, bom: opts.bom, safe: opts.safe, allowPlainNumbers: opts.allowPlainNumbers });
  const filename = safeFilename(outputBaseName(chosen), chosen.suffix);
  const previewText = result.text.replace(/^﻿/, '').split('\r\n').slice(0, 9).join('\n');

  const preview = h('section', { class: 'panel' },
    h('h2', { text: '3. Preview and download' }),
    h('ul', { class: 'stats' },
      h('li', null, h('span', { class: 'stat-label', text: 'File name' }), h('span', { class: 'stat-value small', text: filename })),
      h('li', null, h('span', { class: 'stat-label', text: 'Data rows' }), h('span', { class: 'stat-value', text: fmt(out.rows.length) })),
      h('li', { class: result.protectedCount ? 'warn' : '' }, h('span', { class: 'stat-label', text: 'Cells protected' }), h('span', { class: 'stat-value', text: fmt(result.protectedCount) }))
    ),
    result.protectedCount
      ? notice('warn', `${plural(result.protectedCount, 'cell')} start like a formula and received a leading apostrophe (first: ${result.protectedCells.slice(0, 3).map((c) => JSON.stringify(c.value)).join(', ')}).`)
      : null,
    !opts.safe ? notice('warn', 'Exact mode: formula-like text is written unchanged.') : null,
    h('pre', { class: 'csv-preview', tabindex: '0', 'aria-label': 'First lines of the output' }, previewText || '(empty)'),
    h('div', { class: 'actions' }, button(`Download ${filename}`, () => download(result.text, filename), 'primary', { disabled: !out.rows.length && !header })),
    h('p', { class: 'hint', text: 'Opening a CSV by double-clicking can still drop leading zeros or reformat long numbers and dates in Excel. Use Data → From Text/CSV and set those columns to Text. See Help.' }),
    h('p', { class: 'hint', text: `SheetFix ${APP_VERSION}. Your original file is never overwritten; downloads are new files.` })
  );

  root.append(h('div', { class: 'export-layout' }, h('div', { class: 'panel' }, list, settings), preview));
}
