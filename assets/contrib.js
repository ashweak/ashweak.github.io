/* GitHub contributions calendar for the home page (Lance Agua portfolio) */
(function () {
  var root = document.querySelector('.ghc');
  if (!root) return;

  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  var DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var login = root.getAttribute('data-login');
  var cal = root.querySelector('.ghc-cal');
  var scroller = root.querySelector('.ghc-scroll');
  var totalEl = root.querySelector('.ghc-total');
  var picked = root.querySelector('.ghc-picked');
  var tip = root.querySelector('.ghc-tip');
  var cells = [];
  var selected = null;
  var current = null;

  function num(n) { return n.toLocaleString('en-US'); }
  function ordinal(d) {
    var s = (d % 100 >= 11 && d % 100 <= 13) ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[d % 10] || 'th');
    return d + s;
  }
  function parse(iso) { var p = iso.split('-'); return new Date(Date.UTC(+p[0], +p[1] - 1, +p[2])); }
  function countText(c) { return c === 0 ? 'No contributions' : num(c) + (c === 1 ? ' contribution' : ' contributions'); }
  function shortText(day) {
    var d = parse(day.date);
    return countText(day.count) + ' on ' + MONTHS[d.getUTCMonth()] + ' ' + ordinal(d.getUTCDate()) + '.';
  }
  function longText(day) {
    var d = parse(day.date);
    return countText(day.count) + ' on ' + DAYS[d.getUTCDay()] + ', ' + MONTHS[d.getUTCMonth()] + ' ' + d.getUTCDate() + ', ' + d.getUTCFullYear();
  }

  /* ---------- data ---------- */
  function normalise(data) {
    if (data && data.days) return { total: data.total, days: data.days };
    if (data && data.contributions) {
      return { total: data.total && data.total.lastYear, days: data.contributions };
    }
    throw new Error('unknown data');
  }
  function load() {
    return fetch(root.getAttribute('data-src'), { cache: 'no-cache' })
      .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then(normalise)
      .catch(function () {
        return fetch('https://github-contributions-api.jogruber.de/v4/' + encodeURIComponent(login) + '?y=last')
          .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
          .then(normalise);
      });
  }

  /* ---------- tooltip ---------- */
  function showTip(cell) {
    tip.textContent = shortText(cell._day);
    tip.hidden = false;
    var r = cell.getBoundingClientRect();
    var w = tip.offsetWidth, h = tip.offsetHeight;
    var left = Math.max(6, Math.min(window.innerWidth - w - 6, r.left + r.width / 2 - w / 2));
    var top = r.top - h - 8;
    var below = top < 6;
    if (below) top = r.bottom + 8;
    tip.style.left = left + 'px';
    tip.style.top = top + 'px';
    tip.style.setProperty('--arrow', (r.left + r.width / 2 - left) + 'px');
    tip.classList.toggle('below', below);
  }
  function hideTip() { tip.hidden = true; }

  /* ---------- selection ---------- */
  function setCurrent(cell) {
    if (current) current.tabIndex = -1;
    current = cell;
    cell.tabIndex = 0;
  }
  function select(cell, fromKey) {
    if (selected) selected.setAttribute('aria-pressed', 'false');
    if (selected === cell && !fromKey) {
      selected = null;
      picked.textContent = 'Click a day to see its contributions.';
      hideTip();
      return;
    }
    selected = cell;
    cell.setAttribute('aria-pressed', 'true');
    setCurrent(cell);
    picked.textContent = longText(cell._day);
    showTip(cell);
  }

  /* ---------- render ---------- */
  function render(data) {
    var days = data.days.slice().sort(function (a, b) { return a.date < b.date ? -1 : 1; });
    var total = data.total != null ? data.total : days.reduce(function (s, d) { return s + d.count; }, 0);
    totalEl.textContent = num(total) + (total === 1 ? ' contribution' : ' contributions') + ' in the last year';

    var offset = parse(days[0].date).getUTCDay();
    var weeks = Math.ceil((offset + days.length) / 7);
    cal.style.setProperty('--weeks', weeks);
    var frag = document.createDocumentFragment();

    // day labels, like GitHub: Mon, Wed, Fri
    [[1, 'Mon'], [3, 'Wed'], [5, 'Fri']].forEach(function (l) {
      var s = document.createElement('span');
      s.className = 'ghc-day';
      s.textContent = l[1];
      s.style.gridRow = (l[0] + 2);
      frag.appendChild(s);
    });

    // month labels at the first week of each month
    var labels = [];
    var lastMonth = -1;
    for (var w = 0; w < weeks; w++) {
      var i = Math.max(0, w * 7 - offset);
      var m = parse(days[i].date).getUTCMonth();
      if (m !== lastMonth) { labels.push({ w: w, m: m }); lastMonth = m; }
    }
    labels.forEach(function (l, k) {
      var next = labels[k + 1];
      if (next && next.w - l.w < 3) return; // too close to the next label
      var s = document.createElement('span');
      s.className = 'ghc-month';
      s.textContent = MONTHS[l.m].slice(0, 3);
      s.style.gridColumn = (l.w + 2) + ' / span 3';
      frag.appendChild(s);
    });

    days.forEach(function (day, idx) {
      var pos = idx + offset;
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'ghc-cell';
      b.tabIndex = -1;
      b.setAttribute('data-level', day.level);
      b.setAttribute('aria-pressed', 'false');
      b.setAttribute('aria-label', longText(day));
      b.style.gridRow = (pos % 7) + 2;
      b.style.gridColumn = Math.floor(pos / 7) + 2;
      b._day = day;
      b._idx = idx;
      cells.push(b);
      frag.appendChild(b);
    });
    cal.appendChild(frag);
    setCurrent(cells[cells.length - 1]);
    root.classList.add('ready');
    scroller.scrollLeft = scroller.scrollWidth; // newest days first on small screens
  }

  /* ---------- events ---------- */
  cal.addEventListener('mouseover', function (e) {
    var c = e.target.closest('.ghc-cell');
    if (c) showTip(c);
  });
  cal.addEventListener('mouseleave', function () {
    if (selected) showTip(selected); else hideTip();
  });
  cal.addEventListener('click', function (e) {
    var c = e.target.closest('.ghc-cell');
    if (c) select(c, false);
  });
  cal.addEventListener('focusin', function (e) {
    var c = e.target.closest('.ghc-cell');
    if (c) showTip(c);
  });
  cal.addEventListener('focusout', function (e) {
    if (!cal.contains(e.relatedTarget)) { if (selected) showTip(selected); else hideTip(); }
  });
  cal.addEventListener('keydown', function (e) {
    var c = e.target.closest('.ghc-cell');
    if (!c) return;
    var step = { ArrowUp: -1, ArrowDown: 1, ArrowLeft: -7, ArrowRight: 7 }[e.key];
    if (e.key === 'Home') step = -c._idx;
    if (e.key === 'End') step = cells.length - 1 - c._idx;
    if (step === undefined) { if (e.key === 'Escape' && selected) select(selected, false); return; }
    e.preventDefault();
    var next = cells[Math.max(0, Math.min(cells.length - 1, c._idx + step))];
    setCurrent(next);
    next.focus();
    select(next, true);
  });
  document.addEventListener('click', function (e) {
    if (selected && !root.contains(e.target)) select(selected, false);
  });
  function reposition() { if (!tip.hidden) { if (selected) showTip(selected); else hideTip(); } }
  window.addEventListener('scroll', reposition, { passive: true });
  window.addEventListener('resize', reposition);
  scroller.addEventListener('scroll', reposition, { passive: true });

  load().then(render).catch(function () {
    totalEl.innerHTML = 'Couldn’t load contributions right now. <a href="https://github.com/' + encodeURIComponent(login) + '" target="_blank" rel="noopener">See them on GitHub ↗</a>';
    root.classList.add('failed');
  });
})();
