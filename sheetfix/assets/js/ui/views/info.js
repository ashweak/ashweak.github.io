import { h, button, icon } from '../dom.js';
import { APP_VERSION, LIMITS } from '../../core/limits.js';
import { loadSample } from '../importer.js';

export function renderHome(root, rerender, go) {
  const card = (route, ic, title, text) =>
    h('article', { class: 'tool-card' },
      h('div', { class: 'tool-icon' }, icon(ic)),
      h('h2', { text: title }),
      h('p', { text }),
      button('Open', () => go(route), 'primary', { 'aria-label': `Open ${title}` })
    );
  root.append(
    h('section', { class: 'hero' },
      h('h1', { text: 'Choose your file, review the fixes, and download a clean copy.' }),
      h('p', { class: 'lead', text: 'SheetFix cleans CSV files, finds duplicate records, and compares two versions of a list — with every change shown before it happens.' }),
      h('p', { class: 'local-note' }, h('strong', { text: 'Your files stay on this device. ' }), 'Processing happens in your browser. Nothing is uploaded, saved, or tracked.')
    ),
    h('div', { class: 'tool-grid' },
      card('clean', 'clean', 'Clean a file', 'Trim spaces, fix case, replace exact values, check required fields, numbers and dates.'),
      card('duplicates', 'dup', 'Find duplicates', 'Group records by key columns, see conflicting values, and decide what to keep.'),
      card('compare', 'compare', 'Compare two lists', 'Map columns between a Baseline and an Updated file and see Added, Removed and Changed records.')
    ),
    h('section', { class: 'panel try' },
      h('h2', { text: 'Try it with sample data' }),
      h('p', { text: 'The samples are synthetic product lists with messy spaces, leading-zero codes, duplicates, a formula-like value and bad dates.' }),
      h('div', { class: 'actions' },
        button('Load messy sample and clean it', async () => {
          go('clean');
          await loadSample('main', 'products_messy.csv', rerender);
        }, 'primary'),
        button('Compare sample lists', async () => {
          go('compare');
          await loadSample('baseline', 'products_baseline.csv', rerender);
          await loadSample('updated', 'products_updated.csv', rerender);
        })
      )
    )
  );
}

export function renderHelp(root) {
  const sec = (title, ...children) => h('section', { class: 'panel help' }, h('h2', { text: title }), ...children);
  const ul = (...items) => h('ul', null, items.map((t) => h('li', { text: t })));
  root.append(
    h('h1', { text: 'Help & About' }),
    sec('What CSV can and cannot carry',
      h('p', { text: 'CSV stores rows of text values. It does not keep workbook styles, multiple sheets, charts, formulas as working logic, or Excel cell types. SheetFix never evaluates formulas.' })
    ),
    sec('Supported files and limits',
      ul(
        'UTF-8 text, with or without a BOM. If a file is rejected as not UTF-8, open it in your spreadsheet program and save as “CSV UTF-8”.',
        'Comma, semicolon or tab delimiters. The delimiter is suggested, and you confirm it with the preview.',
        `Up to ${LIMITS.fileBytes / 1048576} MiB per file (${LIMITS.totalBytes / 1048576} MiB for a two-file comparison), ${LIMITS.records.toLocaleString('en')} records, ${LIMITS.columns} columns and ${LIMITS.cellChars.toLocaleString('en')} characters per cell.`,
        'Every value is kept as text: 000123, +639171234567, 1E10 and 01/02/2026 stay exactly as written.',
        'Files with broken quotes or rows of the wrong width must be fixed or explicitly resolved before use. Nothing is truncated silently.'
      )
    ),
    sec('Keeping leading zeros in Excel',
      h('p', { text: 'Double-clicking a CSV lets Excel guess types, which can drop leading zeros, shorten long numbers, or change dates. Quoting and BOMs do not prevent this. Instead:' }),
      h('ol', null,
        h('li', { text: 'Open a blank workbook and choose Data → From Text/CSV.' }),
        h('li', { text: 'Pick the exported file, then choose Transform Data (or Edit).' }),
        h('li', { text: 'Select the code, phone and date columns and set their type to Text, then Close & Load.' })
      )
    ),
    sec('Export safety modes',
      ul(
        'Spreadsheet-safe (default): values starting with = + - @, tab or carriage return get a leading apostrophe so a spreadsheet does not run them as formulas. The count is shown before download.',
        'Exact text: every value is written unchanged, for importing into other systems. Do not open such files in a spreadsheet program if they came from an untrusted source.'
      )
    ),
    sec('Privacy',
      ul(
        'Files are read and processed in your browser. The app sends no file contents anywhere and has no accounts, analytics, ads, or tracking.',
        'Your work lives in this tab’s memory. Closing or reloading the tab loses it — download what you need. Clearing the session releases data references but cannot guarantee erasure from memory.',
        'The web host still sees ordinary page requests. Browser extensions and shared computers are outside SheetFix’s control.'
      )
    ),
    sec('Troubleshooting',
      ul(
        'Everything is in one column: change the delimiter in the read settings.',
        'The header looks like data: untick “First record contains headers”.',
        '“Quote problem”: a quoted value is not closed. Fix the source file or remove that record.',
        'Comparison shows exclusions: keys are blank or repeated. Fix them in Find duplicates or exclude them explicitly.'
      )
    ),
    sec('About',
      h('p', { text: `SheetFix ${APP_VERSION} · open source under the MIT license.` }),
      h('p', null, 'Source code: ', h('a', { href: 'https://github.com/ashweak/sheetfix', rel: 'noopener', text: 'github.com/ashweak/sheetfix' }), '. Please report bugs with synthetic example files, never real business data.')
    )
  );
}
