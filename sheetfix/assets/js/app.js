// SheetFix shell: hash navigation, layout, session warnings. All processing is local.
import { h, clear, button, icon, confirmDialog, announce } from './ui/dom.js';
import { subscribe, hasWork, clearSession } from './ui/state.js';
import { renderHome, renderHelp } from './ui/views/info.js';
import { renderClean } from './ui/views/clean.js';
import { renderDuplicates } from './ui/views/duplicates.js';
import { renderCompare } from './ui/views/compare.js';
import { renderExport } from './ui/views/export.js';
import { APP_VERSION } from './core/limits.js';

const ROUTES = {
  home: { label: 'Home', icon: 'home', render: renderHome },
  clean: { label: 'Clean a file', icon: 'clean', render: renderClean },
  duplicates: { label: 'Find duplicates', icon: 'dup', render: renderDuplicates },
  compare: { label: 'Compare two lists', icon: 'compare', render: renderCompare },
  export: { label: 'Export', icon: 'export', render: renderExport },
  help: { label: 'Help & About', icon: 'help', render: renderHelp },
};

const main = document.getElementById('main');
const nav = document.getElementById('nav');
let currentRoute = null;

function route() {
  const r = (location.hash.replace(/^#\/?/, '') || 'home').split('?')[0];
  return ROUTES[r] ? r : 'home';
}

export function go(r) {
  if (location.hash !== '#/' + r) location.hash = '#/' + r;
  else render();
}

function renderNav() {
  clear(nav);
  const r = route();
  const ul = h('ul');
  for (const [id, info] of Object.entries(ROUTES)) {
    ul.append(
      h('li', null,
        h('a', { href: `#/${id}`, class: id === r ? 'active' : '', 'aria-current': id === r ? 'page' : false, onclick: () => document.body.classList.remove('nav-open') }, icon(info.icon), h('span', { text: info.label }))
      )
    );
  }
  nav.append(
    ul,
    h('div', { class: 'nav-foot' },
      hasWork()
        ? button('Clear session', async () => {
            if (await confirmDialog('Clear session?', 'All loaded files, decisions and results in this tab will be released. Downloaded files are not affected.', 'Clear session', true)) {
              clearSession();
              announce('Session cleared.');
              go('home');
            }
          }, 'small ghost')
        : null,
      h('p', { class: 'muted small', text: `v${APP_VERSION} · local processing` })
    )
  );
}

function render() {
  const r = route();
  const sameRoute = r === currentRoute;
  const y = window.scrollY;
  const focusId = sameRoute && document.activeElement && document.activeElement.id;
  clear(main);
  ROUTES[r].render(main, render, go);
  renderNav();
  document.title = `${ROUTES[r].label} · SheetFix`;
  if (sameRoute) {
    window.scrollTo(0, y);
    if (focusId) {
      const el = document.getElementById(focusId);
      if (el) el.focus();
    }
  } else {
    window.scrollTo(0, 0);
    main.focus({ preventScroll: true });
  }
  currentRoute = r;
}

subscribe(render);
window.addEventListener('hashchange', render);
// Best-effort warning; browsers may not always show it.
window.addEventListener('beforeunload', (e) => {
  if (hasWork()) {
    e.preventDefault();
    e.returnValue = '';
  }
});
document.getElementById('menu-toggle').addEventListener('click', (e) => {
  const open = document.body.classList.toggle('nav-open');
  e.currentTarget.setAttribute('aria-expanded', String(open));
});
render();
