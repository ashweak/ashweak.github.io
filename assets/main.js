/* Lance Agua portfolio — shared page behaviour */
(function () {
  var ICONS = {
    menu: 'M1 2h6v1H1zM1 4h6v1H1zM1 6h6v1H1z',
    close: 'M1 2h1v1H1zM6 2h1v1H6zM2 3h1v1H2zM5 3h1v1H5zM3 4h2v1H3zM2 5h1v1H2zM5 5h1v1H5zM1 6h1v1H1zM6 6h1v1H6z',
    sun: 'M3 0h2v1H3zM3 7h2v1H3zM0 3h1v2H0zM7 3h1v2H7zM1 1h1v1H1zM6 1h1v1H6zM1 6h1v1H1zM6 6h1v1H6zM2 2h4v4H2z',
    moon: 'M3 1h3v1H3zM2 2h2v1H2zM1 3h2v2H1zM2 5h2v1H2zM3 6h3v1H3zM5 5h2v1H5z'
  };
  var root = document.querySelector('.tk');
  var $$ = function (sel, el) { return Array.prototype.slice.call((el || document).querySelectorAll(sel)); };

  /* ---------- theme ---------- */
  function store(key, val) { try { localStorage.setItem(key, val); } catch (e) {} }
  function read(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
  function applyTheme(t) {
    root.classList.toggle('light', t === 'light');
    $$('[data-action="toggleTheme"]').forEach(function (btn) {
      var label = t === 'light' ? 'Dark mode' : 'Light mode';
      btn.setAttribute('aria-label', label);
      var p = btn.querySelector('path');
      if (p) p.setAttribute('d', t === 'light' ? ICONS.moon : ICONS.sun);
      var last = btn.lastChild;
      if (last && last.nodeType === 3) last.nodeValue = label;
    });
  }
  applyTheme(read('la-theme') === 'light' ? 'light' : 'dark');
  window.addEventListener('storage', function (e) {
    if (e.key === 'la-theme') applyTheme(e.newValue === 'light' ? 'light' : 'dark');
  });

  /* ---------- mobile menu ---------- */
  var side = document.querySelector('.side');
  function setMenu(open) {
    if (!side) return;
    side.classList.toggle('open', open);
    $$('[data-action="toggleMenu"]').forEach(function (btn) {
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      btn.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
      var p = btn.querySelector('path');
      if (p) p.setAttribute('d', open ? ICONS.close : ICONS.menu);
    });
  }

  /* ---------- certificate viewer ---------- */
  var modal = document.getElementById('cert-modal');
  function openCert(img, name) {
    if (!modal) return;
    var im = modal.querySelector('img');
    im.src = img; im.alt = name + ' e-certificate';
    var title = modal.querySelector('span');
    if (title) title.textContent = name;
    modal.setAttribute('aria-label', name + ' certificate');
    modal.hidden = false;
    document.body.style.overflow = 'hidden';
    var btn = modal.querySelector('button'); if (btn) btn.focus();
  }
  function closeCert() {
    if (!modal || modal.hidden) return;
    modal.hidden = true;
    document.body.style.overflow = '';
  }

  /* ---------- project filter ---------- */
  function filterProjects(f) {
    $$('[data-action="filter"]').forEach(function (b) {
      var on = b.getAttribute('data-f') === f;
      b.setAttribute('aria-selected', on ? 'true' : 'false');
      b.style.background = on ? 'var(--ce0e0e0)' : 'var(--c1a1a1a)';
      b.style.color = on ? 'var(--c0a0a0a)' : 'var(--ca3a3a3)';
    });
    $$('article[data-cat]').forEach(function (a) {
      a.hidden = !(f === 'all' || a.getAttribute('data-cat') === f);
    });
  }

  /* ---------- inquiry form ---------- */
  var form = document.getElementById('inquiry-form');
  var sent = document.getElementById('inquiry-sent');
  if (form) {
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var data = new FormData(form);
      if (/YOUR_FORM_ID/.test(form.action)) {
        var body = '';
        data.forEach(function (v, k) { if (k !== '_gotcha' && v) body += k.replace('_', ' ') + ': ' + v + '\n'; });
        location.href = 'mailto:lanceaagua@gmail.com?subject=' + encodeURIComponent('Collab inquiry') + '&body=' + encodeURIComponent(body);
        return;
      }
      var btn = form.querySelector('button[type="submit"]');
      if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
      fetch(form.action, { method: 'POST', body: data, headers: { Accept: 'application/json' } })
        .then(function (r) {
          if (!r.ok) throw new Error('send failed');
          form.reset(); form.hidden = true; if (sent) sent.hidden = false;
        })
        .catch(function () {
          alert('Sorry, the message could not be sent. Please email lanceaagua@gmail.com instead.');
        })
        .then(function () { if (btn) { btn.disabled = false; btn.textContent = 'Send inquiry →'; } });
    });
  }

  /* ---------- clicks ---------- */
  document.addEventListener('click', function (e) {
    var el = e.target.closest('[data-action]');
    if (!el) {
      if (side && side.classList.contains('open') && !e.target.closest('aside')) setMenu(false);
      return;
    }
    var a = el.getAttribute('data-action');
    if (a === 'toggleTheme') {
      var t = root.classList.contains('light') ? 'dark' : 'light';
      store('la-theme', t); applyTheme(t);
    } else if (a === 'toggleMenu') {
      setMenu(!side.classList.contains('open'));
    } else if (a === 'cert') {
      openCert(el.getAttribute('data-img'), el.getAttribute('data-name'));
    } else if (a === 'close') {
      closeCert();
    } else if (a === 'stop') {
      if (e.target.closest('[data-action="close"]') === null) e.stopPropagation();
      return;
    } else if (a === 'filter') {
      filterProjects(el.getAttribute('data-f'));
    } else if (a === 'reset') {
      if (form) form.hidden = false; if (sent) sent.hidden = true;
    }
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { closeCert(); setMenu(false); }
  });

  /* ---------- experience timeline glow ---------- */
  var lines = $$('.tl-line');
  if (lines.length) {
    var raf = null;
    var update = function () {
      raf = null;
      var target = window.innerHeight * 0.55;
      lines.forEach(function (el) {
        var r = el.getBoundingClientRect();
        var f = r.height ? Math.max(0, Math.min(1, (target - r.top) / r.height)) : 0;
        var fill = el.querySelector('.tl-fill');
        if (fill) fill.style.height = (f * 100) + '%';
      });
    };
    var onScroll = function () { if (!raf) raf = requestAnimationFrame(update); };
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    update();
  }
})();
