import { h, fmt, button, icon } from '../dom.js';
import { state, workingView } from '../state.js';

/** Summary of the working file with a replace action. */
export function fileBar(onReplace) {
  const f = state.files.main;
  const v = workingView();
  const imported = f.dataset.rows.length;
  return h('div', { class: 'file-bar' },
    icon('file'),
    h('div', null,
      h('strong', { text: f.name }),
      h('span', { class: 'muted', text: ` · ${fmt(v.rows.length)} working rows${v.rows.length !== imported ? ` (imported ${fmt(imported)})` : ''} · ${fmt(v.columns.length)} columns` })
    ),
    onReplace ? button('Replace file', onReplace, 'small ghost') : null
  );
}

export function needFile(go) {
  return h('div', { class: 'panel' },
    h('p', { text: 'Load a file in Clean a file first. Duplicate review and export work on that file’s working copy.' }),
    button('Go to Clean a file', () => go('clean'), 'primary')
  );
}
