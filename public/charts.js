/* Charts — tiny dependency-free inline-SVG chart kit for the Claude Code usage dashboard.
 * Plain script (no modules). Defines window.Charts:
 *   Charts.donut(container, items, opts)
 *   Charts.stackedBars(container, points, series, opts)
 *   Charts.hbars(container, items, opts)
 *   Charts.sparkline(container, values, opts)
 *   Charts.seriesColor(index)
 * Consumes only the contract's CSS tokens. Safe to call every few seconds: unchanged data+size is a no-op,
 * one ResizeObserver per container (the old one is disconnected), one shared tooltip element.
 */
(function () {
  'use strict';

  var NS = 'http://www.w3.org/2000/svg';
  var EMPTY_TEXT = 'No data in this range';
  var BAR_MAX = 24;      // max bar thickness (px)
  var GAP = 2;           // surface gap between touching marks (px)
  var RADIUS = 4;        // rounded data-end
  var STATE = new WeakMap();   // container -> {ro, lastSig, lastW}
  var lastPtr = { x: -1, y: -1 };
  var UID = 0;

  /* ------------------------------------------------------------------ helpers */

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function num(n) { n = Number(n); return isFinite(n) ? n : 0; }
  function r1(n) { return Math.round(n * 100) / 100; }
  function safeColor(c, fallback) {
    c = String(c == null ? '' : c).trim();
    return /^[#\w(),.%\s-]+$/.test(c) && c.length < 80 ? c : (fallback || 'var(--series-1)');
  }
  function defFormat(n) { return Number(n).toLocaleString(); }
  function fmtWith(f) {
    var fn = typeof f === 'function' ? f : defFormat;
    return function (n) { try { return String(fn(n)); } catch (e) { return String(n); } };
  }
  function pct(p) { return p < 0.1 ? '<0.1%' : p.toFixed(1) + '%'; }
  function prefersReducedMotion() {
    try { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); }
    catch (e) { return false; }
  }

  function seriesColor(i) {
    i = Math.floor(Number(i));
    if (!isFinite(i)) i = 1;
    if (i < 1) i = 1;
    if (i > 8) i = 8;       // fixed order, never cycled: clamp (callers fold >8 into "Other")
    return 'var(--series-' + i + ')';
  }

  // text measurement (canvas, cached per font)
  var measureCtx = null;
  function measure(text, font) {
    text = String(text);
    try {
      if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
      if (measureCtx.font !== font) measureCtx.font = font;
      return measureCtx.measureText(text).width;
    } catch (e) {
      return text.length * 6.4;
    }
  }
  function fontFamily(container) {
    try { return getComputedStyle(container).fontFamily || 'sans-serif'; } catch (e) { return 'sans-serif'; }
  }
  function truncate(text, maxW, font) {
    text = String(text);
    if (maxW <= 8) return '';
    if (measure(text, font) <= maxW) return text;
    var lo = 0, hi = text.length;
    while (lo < hi) {
      var mid = (lo + hi + 1) >> 1;
      if (measure(text.slice(0, mid) + '…', font) <= maxW) lo = mid; else hi = mid - 1;
    }
    return lo > 0 ? text.slice(0, lo) + '…' : '…';
  }

  function widthOf(container) {
    var w = container.clientWidth;
    if (!w) { try { w = Math.round(container.getBoundingClientRect().width); } catch (e) { w = 0; } }
    return w;
  }

  // nice y ticks: step is 1, 2 or 5 x 10^n
  function niceTicks(max, target) {
    if (!(max > 0)) return { max: 1, ticks: [0, 1] };
    var raw = max / (target || 4);
    var p = Math.pow(10, Math.floor(Math.log10(raw)));
    var f = raw / p;
    var nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
    var step = nf * p;
    var n = Math.ceil(max / step - 1e-9);
    var ticks = [];
    for (var i = 0; i <= n; i++) ticks.push(+(i * step).toPrecision(12));
    return { max: ticks[ticks.length - 1], ticks: ticks };
  }

  /* ------------------------------------------------------------------ css */

  function injectCss() {
    if (document.getElementById('charts-css')) return;
    var st = document.createElement('style');
    st.id = 'charts-css';
    st.textContent = [
      '.charts-root{position:relative;width:100%;font-family:inherit;color:var(--text-secondary)}',
      '.charts-grow{transform-box:view-box}',
      '.charts-pop{transform-box:fill-box;transform-origin:center}',
      '.charts-dot{transform-box:fill-box;transform-origin:center;transition:transform .12s;stroke:var(--surface-1);stroke-width:2}',
      '.charts-pt{outline:none;pointer-events:none}',
      '.charts-pt.charts-hot .charts-dot{transform:scale(1.4)}',
      '.charts-pt:focus-visible .charts-dot{stroke:var(--accent)}',
      '.charts-plane{fill:transparent;pointer-events:all}',
      '.charts-xlab2{font-size:11px;fill:var(--text-secondary)}',
      '.charts-plab{font-size:11px;fill:var(--text-secondary);paint-order:stroke;stroke:var(--surface-1);stroke-width:3px;stroke-linejoin:round;pointer-events:none}',
      '.charts-qlab{font-size:11px;font-weight:600;fill:var(--text-secondary);pointer-events:none}',
      '.charts-axlab{font-size:11px;fill:var(--text-secondary)}',
      '.charts-front{fill:none;stroke:var(--text-muted);stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round;stroke-dasharray:.1 5;pointer-events:none}',
      '.charts-root svg{display:block;max-width:100%;overflow:visible;font-family:inherit}',
      '.charts-root svg text{font-family:inherit;font-variant-numeric:tabular-nums}',
      '.charts-tick{font-size:11px;fill:var(--text-muted)}',
      '.charts-xlab{font-size:11px;fill:var(--text-muted)}',
      '.charts-peak{font-size:11px;font-weight:600;fill:var(--text-primary)}',
      '.charts-name{font-size:12px;fill:var(--text-primary)}',
      '.charts-sub{font-size:11px;fill:var(--text-muted)}',
      '.charts-val{font-size:12px;font-weight:600;fill:var(--text-primary)}',
      '.charts-cv{font-weight:600;fill:var(--text-primary)}',
      '.charts-cl{font-size:11px;fill:var(--text-secondary)}',
      '.charts-grid{stroke:var(--grid);stroke-width:1;fill:none;shape-rendering:crispEdges}',
      '.charts-axis{stroke:var(--axis);stroke-width:1;fill:none;shape-rendering:crispEdges}',
      '.charts-hl{fill:var(--surface-2);opacity:0;pointer-events:none;transition:opacity .08s}',
      '.charts-hit{fill:transparent;pointer-events:all;outline:none;cursor:default}',
      '.charts-hit:focus-visible{stroke:var(--accent);stroke-width:2}',
      '.charts-col:hover .charts-hl,.charts-col:focus-within .charts-hl,.charts-row:hover .charts-hl,.charts-row:focus-within .charts-hl{opacity:1}',
      '.charts-col:hover .charts-seg,.charts-col:focus-within .charts-seg,.charts-row:hover .charts-bar,.charts-row:focus-within .charts-bar{filter:brightness(1.12)}',
      '.charts-vis{pointer-events:none;transform-origin:50% 50%;transition:transform .12s,opacity .12s,filter .12s}',
      '@media (prefers-reduced-motion:reduce){.charts-vis,.charts-hl,.charts-dot{transition:none}}',
      '.charts-slice:hover .charts-vis,.charts-slice:focus-within .charts-vis,.charts-slice.charts-hot .charts-vis{transform:scale(1.035);filter:brightness(1.12)}',
      '.charts-donut-wrap.charts-has-hot .charts-slice:not(.charts-hot) .charts-vis{opacity:.5}',
      /* legend */
      '.charts-legend{display:flex;flex-wrap:wrap;gap:4px 16px;margin:0 0 8px;padding:0;list-style:none;font-size:12px;color:var(--text-secondary)}',
      '.charts-legend li{display:inline-flex;align-items:center;gap:6px;min-width:0}',
      '.charts-sw{flex:none;width:10px;height:10px;border-radius:3px}',
      /* donut */
      '.charts-donut-wrap{display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:12px 24px}',
      '.charts-donut-wrap.charts-side{flex-wrap:nowrap;justify-content:flex-start}',
      '.charts-dlegend{flex:1 1 140px;min-width:0;margin:0;padding:0;list-style:none;font-size:12px}',
      '.charts-dlegend li{display:flex;align-items:center;gap:8px;padding:3px 6px;margin:0 -6px;border-radius:6px;min-width:0}',
      '.charts-dlegend li:hover,.charts-dlegend li.charts-hot{background:var(--surface-2)}',
      '.charts-dlegend .n{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text-primary)}',
      '.charts-dlegend .v{flex:none;color:var(--text-primary);font-weight:600;font-variant-numeric:tabular-nums}',
      '.charts-dlegend .p{flex:none;width:48px;text-align:right;color:var(--text-muted);font-variant-numeric:tabular-nums}',
      /* empty */
      '.charts-empty{display:flex;align-items:center;justify-content:center;text-align:center;color:var(--text-muted);font-size:13px;padding:12px}',
      /* tooltip */
      '#charts-tooltip{position:fixed;left:0;top:0;z-index:2147483000;pointer-events:none;display:none;',
      'min-width:128px;max-width:300px;padding:8px 10px;border-radius:8px;font-size:12px;line-height:1.35;',
      'background:var(--surface-2);color:var(--text-primary);border:1px solid var(--border);',
      'box-shadow:0 6px 24px rgba(0,0,0,.28);font-family:inherit}',
      '#charts-tooltip .t-h{color:var(--text-secondary);font-size:11px;margin-bottom:5px;overflow-wrap:anywhere}',
      '#charts-tooltip .t-r{display:flex;align-items:center;gap:8px;padding:1.5px 0}',
      '#charts-tooltip .t-k{flex:none;width:10px;height:3px;border-radius:2px}',
      '#charts-tooltip .t-n{flex:1 1 auto;color:var(--text-secondary);min-width:0;overflow-wrap:anywhere}',
      '#charts-tooltip .t-v{flex:none;margin-left:12px;color:var(--text-primary);font-weight:600;font-variant-numeric:tabular-nums;text-align:right}',
      '#charts-tooltip .t-tot{margin-top:5px;padding-top:5px;border-top:1px solid var(--grid)}',
      '#charts-tooltip .t-tot .t-n{color:var(--text-primary)}',
      '#charts-tooltip .t-s{color:var(--text-muted);font-size:11px;margin-top:2px;overflow-wrap:anywhere}'
    ].join('');
    document.head.appendChild(st);
  }

  /* ------------------------------------------------------------------ tooltip */

  var tipEl = null;
  var tipOwner = null;

  function getTip() {
    if (tipEl && tipEl.isConnected) return tipEl;
    tipEl = document.getElementById('charts-tooltip');
    if (!tipEl) {
      tipEl = document.createElement('div');
      tipEl.id = 'charts-tooltip';
      tipEl.setAttribute('role', 'tooltip');
      document.body.appendChild(tipEl);
    }
    return tipEl;
  }
  function tipHide(owner) {
    if (owner && tipOwner !== owner) return;
    if (tipEl) tipEl.style.display = 'none';
    tipOwner = null;
  }
  function tipShow(owner, node, x, y, anchor) {
    var t = getTip();
    t.textContent = '';
    t.appendChild(node);
    t.style.display = 'block';
    tipOwner = owner;
    var w = t.offsetWidth, h = t.offsetHeight;
    var vw = document.documentElement.clientWidth || window.innerWidth;
    var vh = document.documentElement.clientHeight || window.innerHeight;
    var px, py;
    if (anchor) {
      px = anchor.left + anchor.width / 2 - w / 2;
      py = anchor.top - h - 8;
      if (py < 4) py = anchor.bottom + 8;
    } else {
      px = x + 14; py = y + 16;
      if (px + w > vw - 4) px = x - 14 - w;
      if (py + h > vh - 4) py = y - 12 - h;
    }
    px = Math.max(4, Math.min(px, vw - w - 4));
    py = Math.max(4, Math.min(py, vh - h - 4));
    t.style.left = Math.round(px) + 'px';
    t.style.top = Math.round(py) + 'px';
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function tipRow(color, name, value, extraCls) {
    var r = el('div', 't-r' + (extraCls ? ' ' + extraCls : ''));
    if (color) {
      var k = el('span', 't-k');
      k.style.background = safeColor(color);
      r.appendChild(k);
    }
    r.appendChild(el('span', 't-n', name));
    r.appendChild(el('span', 't-v', value));
    return r;
  }

  // Delegated interaction: any element with data-i inside root is a hit target.
  function wire(root, container, tipFor, wopts) {
    var noPointer = !!(wopts && wopts.noPointer);
    function show(hit, x, y, viaFocus) {
      var i = +hit.getAttribute('data-i');
      var node = tipFor(i);
      if (!node) { tipHide(container); return; }
      tipShow(container, node, x, y, viaFocus ? hit.getBoundingClientRect() : null);
    }
    function hitOf(e) { return e.target && e.target.closest ? e.target.closest('[data-i]') : null; }
    function move(e) {
      lastPtr.x = e.clientX; lastPtr.y = e.clientY;
      var h = hitOf(e);
      if (h && root.contains(h)) show(h, e.clientX, e.clientY, false); else tipHide(container);
    }
    if (!noPointer) {
      root.addEventListener('pointermove', move);
      root.addEventListener('pointerdown', move);
      root.addEventListener('pointerleave', function () { tipHide(container); });
    }
    root.addEventListener('focusin', function (e) {
      var h = hitOf(e);
      if (!h) return;
      var kb = true;
      try { kb = e.target.matches(':focus-visible'); } catch (err) { /* old engines: show anyway */ }
      if (kb) show(h, 0, 0, true);
    });
    root.addEventListener('focusout', function () { tipHide(container); });
    root.addEventListener('keydown', function (e) { if (e.key === 'Escape') tipHide(container); });
    root._showAt = show;
  }

  document.addEventListener('pointermove', function (e) { lastPtr.x = e.clientX; lastPtr.y = e.clientY; }, true);
  window.addEventListener('scroll', function () { tipHide(); }, true);

  /* ------------------------------------------------------------------ mount / lifecycle */

  /* ------------------------------------------------------------------ animation engine */

  var EASE = 'cubic-bezier(.22,1,.36,1)';
  // Animations never run for reduced-motion users, hidden documents or headless browsers (screenshots must show the
  // final state); Charts.animations === 'force' overrides the headless check (used by the animation tests).
  function animationsOn() {
    var flag = window.Charts && window.Charts.animations;
    if (flag === false || prefersReducedMotion() || document.hidden || typeof Element.prototype.animate !== 'function') return false;
    if (flag !== 'force' && /Headless/i.test(navigator.userAgent || '')) return false;
    return true;
  }
  function themeSig() {
    var t = '';
    try {
      t = document.documentElement.getAttribute('data-theme') ||
        (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'd' : 'l');
    } catch (e) { /* ignore */ }
    return t;
  }
  function attrNum(e, k, d) { var v = parseFloat(e.getAttribute(k)); return isFinite(v) ? v : d; }

  // first-render animations; every animation is created paused and starts when the chart scrolls into view
  function runAnims(root) {
    var list = [];
    function add(e, kf, o) {
      try { var a = e.animate(kf, o); a.pause(); list.push(a); } catch (err) { /* ignore */ }
    }
    var grows = root.querySelectorAll('.charts-grow');
    var stag = grows.length > 1 ? Math.min(25, 600 / (grows.length - 1)) : 0;
    grows.forEach(function (g, i) {
      var ax = g.getAttribute('data-axis') || 'y';
      g.style.transformOrigin = attrNum(g, 'data-ox', 0) + 'px ' + attrNum(g, 'data-oy', 0) + 'px';
      add(g, [{ transform: ax === 'x' ? 'scaleX(0)' : 'scaleY(0)' }, { transform: 'none' }],
        { duration: 600, delay: i * stag, easing: EASE, fill: 'backwards' });
    });
    root.querySelectorAll('.charts-fade').forEach(function (f) {
      var b = f.getAttribute('data-bi');
      var d = b != null ? (+b) * stag + 420 : attrNum(f, 'data-d', 500);
      add(f, [{ opacity: 0 }, { opacity: 1 }], { duration: 350, delay: d, easing: 'ease-out', fill: 'backwards' });
    });
    var pops = root.querySelectorAll('.charts-pop');
    var ps = pops.length > 1 ? Math.min(18, 500 / (pops.length - 1)) : 0;
    pops.forEach(function (p, i) {
      add(p, [{ opacity: 0, transform: 'scale(.3)' }, { opacity: 1, transform: 'none' }],
        { duration: 450, delay: i * ps, easing: EASE, fill: 'backwards' });
    });
    root.querySelectorAll('.charts-draw').forEach(function (d) {
      add(d, [{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }], { duration: 900, easing: 'ease-out', fill: 'backwards' });
    });
    root.querySelectorAll('.charts-clip').forEach(function (d) {
      add(d, [{ clipPath: 'inset(0 100% 0 0)' }, { clipPath: 'inset(0 0 0 0)' }], { duration: 900, delay: 250, easing: 'ease-out', fill: 'backwards' });
    });
    root.querySelectorAll('.charts-sweep').forEach(function (d) {
      var c = attrNum(d, 'data-c', 1000);
      add(d, [{ strokeDashoffset: c }, { strokeDashoffset: 0 }], { duration: 850, easing: EASE, fill: 'backwards' });
    });
    return list;
  }

  function harvest(cont) {
    var m = {};
    cont.querySelectorAll('[data-tk]').forEach(function (e) {
      m[e.getAttribute('data-tk')] = { ph: attrNum(e, 'data-ph', 0), cx: attrNum(e, 'data-cx', 0), cy: attrNum(e, 'data-cy', 0) };
    });
    return m;
  }

  // later re-renders: smoothly tween changed bars / moved points
  function tweenAnims(root, prev) {
    function go(e, kf, dur) {
      try { e.animate(kf, { duration: dur || 300, easing: 'cubic-bezier(.33,1,.68,1)', fill: 'backwards' }); } catch (err) { /* ignore */ }
    }
    root.querySelectorAll('.charts-grow[data-tk]').forEach(function (g) {
      var ph = attrNum(g, 'data-ph', 0), p = prev[g.getAttribute('data-tk')];
      var ax = g.getAttribute('data-axis') || 'y';
      g.style.transformOrigin = attrNum(g, 'data-ox', 0) + 'px ' + attrNum(g, 'data-oy', 0) + 'px';
      var s = p ? (ph > 0.5 ? p.ph / ph : 1) : 0;
      if (Math.abs(s - 1) < 0.004 || !isFinite(s)) return;
      go(g, [{ transform: ax === 'x' ? 'scaleX(' + s + ')' : 'scaleY(' + s + ')' }, { transform: 'none' }]);
    });
    root.querySelectorAll('.charts-pop[data-tk]').forEach(function (g) {
      var p = prev[g.getAttribute('data-tk')];
      if (!p) { go(g, [{ opacity: 0, transform: 'scale(.3)' }, { opacity: 1, transform: 'none' }], 350); return; }
      var dx = p.cx - attrNum(g, 'data-cx', 0), dy = p.cy - attrNum(g, 'data-cy', 0);
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;
      go(g, [{ transform: 'translate(' + dx + 'px,' + dy + 'px)' }, { transform: 'none' }], 400);
    });
  }

  // run(container, width, first) draws everything; dataSig identifies data+options (not size).
  function mount(container, dataSig, run) {
    if (!container || !container.appendChild) return;
    injectCss();
    var prev = STATE.get(container);
    if (prev && prev.ro) { try { prev.ro.disconnect(); } catch (e) { /* ignore */ } }
    var st = {
      ro: null, lastSig: prev ? prev.lastSig : null, lastW: prev ? prev.lastW : -1,
      anim: prev ? prev.anim : { played: false, io: null, list: [] }
    };
    STATE.set(container, st);

    function draw() {
      var w = widthOf(container);
      var sig = dataSig + '|' + w + '|' + themeSig();
      var has = container.firstChild && container.firstChild.classList &&
        (container.firstChild.classList.contains('charts-root') || container.firstChild.classList.contains('charts-empty'));
      if (st.lastSig === sig && has) return;
      st.lastSig = sig; st.lastW = w;

      // remember keyboard focus / pointer tooltip so a periodic refresh does not disturb them
      var focusIdx = null;
      var ae = document.activeElement;
      if (ae && ae !== document.body && container.contains(ae) && ae.getAttribute && ae.hasAttribute('data-i')) {
        focusIdx = ae.getAttribute('data-i');
      }
      var hadTip = tipOwner === container;
      if (hadTip) tipHide(container);
      var prevMap = has ? harvest(container) : null;
      var A = st.anim;
      var can = animationsOn();
      A.list.forEach(function (a) { try { a.cancel(); } catch (e) { /* ignore */ } });
      A.list = [];
      if (A.io) { A.io.disconnect(); A.io = null; }

      container.textContent = '';
      var root = run(container, w || 320, can && !A.played);

      if (root) {
        if (!can) {
          A.played = true;
        } else if (!A.played) {
          A.list = runAnims(root);
          var play = function () {
            A.played = true;
            A.list.forEach(function (a) { try { a.play(); } catch (e) { /* ignore */ } });
            A.list = [];
            if (A.io) { A.io.disconnect(); A.io = null; }
          };
          if (!A.list.length) A.played = true;
          else if (typeof IntersectionObserver === 'function') {
            A.io = new IntersectionObserver(function (es) {
              for (var k = 0; k < es.length; k++) if (es[k].isIntersecting) { play(); return; }
            }, { threshold: 0, rootMargin: '0px 0px -40px 0px' });
            A.io.observe(container);
            // some embedders deliver IntersectionObserver callbacks late: also check once by hand
            setTimeout(function () {
              if (A.played || !container.isConnected) return;
              var r = container.getBoundingClientRect(), vh = window.innerHeight || document.documentElement.clientHeight;
              if (r.bottom > 0 && r.top < vh - 40) play();
            }, 250);
          } else play();
        } else if (prevMap) {
          tweenAnims(root, prevMap);
        }
      }

      if (root && focusIdx != null) {
        var f = root.querySelector('[data-i="' + focusIdx + '"]');
        if (f && f.focus) { try { f.focus({ preventScroll: true }); } catch (e) { f.focus(); } }
      } else if (root && hadTip && lastPtr.x >= 0) {
        if (root._restore) root._restore(lastPtr.x, lastPtr.y);
        else if (root._showAt) {
          var under = document.elementFromPoint(lastPtr.x, lastPtr.y);
          var hit = under && under.closest ? under.closest('[data-i]') : null;
          if (hit && root.contains(hit)) root._showAt(hit, lastPtr.x, lastPtr.y, false);
        }
      }
    }

    draw();
    if (typeof ResizeObserver !== 'undefined') {
      st.ro = new ResizeObserver(function () {
        if (Math.abs(widthOf(container) - st.lastW) >= 1) draw();
      });
      st.ro.observe(container);
    }
  }

  function showEmpty(container, h) {
    container.textContent = '';
    var d = el('div', 'charts-empty', EMPTY_TEXT);
    d.style.minHeight = (h || 120) + 'px';
    d.setAttribute('role', 'img');
    d.setAttribute('aria-label', EMPTY_TEXT);
    container.appendChild(d);
    return null;
  }

  function sigOf(kind, data, opts, extra) {
    var o = opts || {};
    var f = [];
    ['format', 'xFormat'].forEach(function (k) {
      if (typeof o[k] === 'function') {
        try { f.push(String(o[k](1234567)) + '~' + String(o[k](0.5)) + '~' + String(o[k](1760000000000))); } catch (e) { f.push('x'); }
      }
    });
    var plain = {};
    Object.keys(o).forEach(function (k) { if (typeof o[k] !== 'function') plain[k] = o[k]; });
    try { return kind + JSON.stringify([data, extra, plain]) + f.join('|'); }
    catch (e) { return kind + Math.random(); }
  }

  /* ------------------------------------------------------------------ rounded-end paths */

  // rect whose top corners are rounded (bar grows up from baseline)
  function pathTopRounded(x, y, w, h, r) {
    r = Math.max(0, Math.min(r, h, w / 2));
    if (r <= 0) return 'M' + x + ' ' + y + 'h' + w + 'v' + h + 'h' + (-w) + 'Z';
    return 'M' + x + ' ' + (y + h) + 'V' + (y + r) + 'A' + r + ' ' + r + ' 0 0 1 ' + (x + r) + ' ' + y +
      'H' + (x + w - r) + 'A' + r + ' ' + r + ' 0 0 1 ' + (x + w) + ' ' + (y + r) + 'V' + (y + h) + 'Z';
  }
  // rect whose right corners are rounded (bar grows right from baseline)
  function pathRightRounded(x, y, w, h, r) {
    r = Math.max(0, Math.min(r, w, h / 2));
    if (r <= 0) return 'M' + x + ' ' + y + 'h' + w + 'v' + h + 'h' + (-w) + 'Z';
    return 'M' + x + ' ' + y + 'H' + (x + w - r) + 'A' + r + ' ' + r + ' 0 0 1 ' + (x + w) + ' ' + (y + r) +
      'V' + (y + h - r) + 'A' + r + ' ' + r + ' 0 0 1 ' + (x + w - r) + ' ' + (y + h) + 'H' + x + 'Z';
  }

  /* ------------------------------------------------------------------ stackedBars */

  function stackedBars(container, points, series, opts) {
    opts = opts || {};
    points = Array.isArray(points) ? points : [];
    series = (Array.isArray(series) ? series : []).filter(function (s) { return s && s.key != null; });
    var H = Math.max(120, num(opts.height) || 260);
    var fmt = fmtWith(opts.format);
    var xfmt = typeof opts.xFormat === 'function' ? opts.xFormat : function (t) { return String(t); };
    var sig = sigOf('sb', points, opts, series) + '|' + H;

    mount(container, sig, function (cont, W) {
      var n = points.length;
      var totals = points.map(function (p) {
        var t = 0;
        series.forEach(function (s) { t += Math.max(0, num(p && p[s.key])); });
        return t;
      });
      var maxTotal = 0;
      totals.forEach(function (t) { if (t > maxTotal) maxTotal = t; });
      if (!n || !series.length || !(maxTotal > 0)) return showEmpty(cont, H);

      var fam = fontFamily(cont);
      var font = '11px ' + fam;
      var root = el('div', 'charts-root');

      // legend (>= 2 series)
      if (series.length >= 2) {
        var lg = el('ul', 'charts-legend');
        series.forEach(function (s) {
          var li = el('li');
          var sw = el('span', 'charts-sw');
          sw.style.background = safeColor(s.color);
          li.appendChild(sw);
          li.appendChild(el('span', null, s.name != null ? s.name : s.key));
          lg.appendChild(li);
        });
        root.appendChild(lg);
      }

      var yt = niceTicks(maxTotal, 4);
      var tickLabels = yt.ticks.map(function (v) { return fmt(v); });
      var tw = 0;
      tickLabels.forEach(function (l) { tw = Math.max(tw, measure(l, font)); });
      var padL = Math.ceil(tw) + 10, padR = 8, padT = 18, padB = 24;
      var plotW = Math.max(40, W - padL - padR);
      var plotH = Math.max(40, H - padT - padB);
      var base = padT + plotH;
      function Y(v) { return padT + plotH * (1 - v / yt.max); }

      var slot = plotW / n;
      var bw = Math.min(BAR_MAX, slot - GAP);
      if (bw < 1) bw = Math.max(0.5, slot - 0.5);

      var out = [];
      out.push('<svg xmlns="' + NS + '" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="');
      var peakIdx = totals.indexOf(maxTotal);
      out.push(esc('Stacked bar chart, ' + n + (n === 1 ? ' bucket' : ' buckets') + '; series: ' +
        series.map(function (s) { return s.name != null ? s.name : s.key; }).join(', ') +
        '. Peak total ' + fmt(maxTotal) + ' at ' + xfmt(points[peakIdx].t) + '.'));
      out.push('">');

      // gridlines + y ticks (one y axis)
      yt.ticks.forEach(function (v, i) {
        var y = Math.round(Y(v)) + 0.5;
        out.push('<line class="' + (i === 0 ? 'charts-axis' : 'charts-grid') + '" x1="' + padL + '" x2="' + (padL + plotW) + '" y1="' + y + '" y2="' + y + '"/>');
        out.push('<text class="charts-tick" x="' + (padL - 8) + '" y="' + (y + 3.5) + '" text-anchor="end">' + esc(tickLabels[i]) + '</text>');
      });

      // x labels, thinned so they never collide
      var labels = points.map(function (p) { return String(xfmt(p && p.t)); });
      var lw = 0;
      labels.forEach(function (l) { lw = Math.max(lw, measure(l, font)); });
      var fit = Math.max(1, Math.floor((plotW + 12) / (lw + 12)));
      var step = Math.max(1, Math.ceil(n / fit));
      for (var i = n - 1; i >= 0; i -= step) {
        var cx = padL + slot * (i + 0.5);
        var half = measure(labels[i], font) / 2;
        var lx = Math.max(padL + half - 2, Math.min(cx, padL + plotW - half + 2));
        out.push('<text class="charts-xlab" x="' + r1(lx) + '" y="' + (base + 16) + '" text-anchor="middle">' + esc(labels[i]) + '</text>');
      }

      // columns
      for (var c = 0; c < n; c++) {
        var p = points[c] || {};
        var x0 = padL + slot * c;
        var bx = r1(x0 + (slot - bw) / 2);
        var aria = labels[c] + ': ' + series.map(function (s) {
          return (s.name != null ? s.name : s.key) + ' ' + fmt(Math.max(0, num(p[s.key])));
        }).join(', ') + '; total ' + fmt(totals[c]);
        out.push('<g class="charts-col">');
        out.push('<rect class="charts-hl" x="' + r1(x0) + '" y="' + padT + '" width="' + r1(slot) + '" height="' + plotH + '" rx="4"/>');

        // segments (bottom -> top)
        var segs = [], cum = 0;
        series.forEach(function (s) {
          var v = Math.max(0, num(p[s.key]));
          if (v <= 0) return;
          var yb = Y(cum), yt2 = Y(cum + v);
          cum += v;
          segs.push({ s: s, top: yt2, bottom: yb });
        });
        // drop segments too thin to see (their value lives in tooltip), apply 2px surface gap
        var drawn = [];
        segs.forEach(function (sg) {
          var bottom = drawn.length ? sg.bottom - GAP : sg.bottom;
          var h = bottom - sg.top;
          var minH = drawn.length ? 0.75 : 0.75;
          if (h >= minH) drawn.push({ s: sg.s, top: sg.top, h: h });
        });
        if (drawn.length) {
          out.push('<g class="charts-grow" data-tk="' + esc(p.t) + '" data-ph="' + r1(base - Y(totals[c])) + '" data-oy="' + base + '">');
        }
        drawn.forEach(function (d, k) {
          var isTop = k === drawn.length - 1;
          var color = safeColor(d.s.color);
          if (isTop) {
            out.push('<path class="charts-seg" d="' + pathTopRounded(bx, r1(d.top), r1(bw), r1(d.h), RADIUS) + '" style="fill:' + esc(color) + '"/>');
          } else {
            out.push('<rect class="charts-seg" x="' + bx + '" y="' + r1(d.top) + '" width="' + r1(bw) + '" height="' + r1(d.h) + '" style="fill:' + esc(color) + '"/>');
          }
        });
        if (drawn.length) out.push('</g>');

        // selective direct label: the peak only
        if (c === peakIdx) {
          var pl = fmt(maxTotal);
          var ph = measure(pl, '600 11px ' + fam) / 2;
          var px = Math.max(padL + ph, Math.min(padL + slot * (c + 0.5), padL + plotW - ph));
          out.push('<text class="charts-peak charts-fade" data-d="450" x="' + r1(px) + '" y="' + r1(Y(maxTotal) - 6) + '" text-anchor="middle">' + esc(pl) + '</text>');
        }

        out.push('<rect class="charts-hit" data-i="' + c + '" tabindex="0" role="img" aria-label="' + esc(aria) + '" x="' + r1(x0) + '" y="' + (padT - 6) + '" width="' + r1(slot) + '" height="' + (plotH + padB + 6) + '"/>');
        out.push('</g>');
      }
      out.push('</svg>');

      var holder = document.createElement('div');
      holder.innerHTML = out.join('');
      root.appendChild(holder.firstChild);
      cont.appendChild(root);

      wire(root, cont, function (i) {
        var p = points[i] || {};
        var f = el('div');
        f.appendChild(el('div', 't-h', labels[i]));
        series.slice().reverse().forEach(function (s) {   // same order as the visual stack
          f.appendChild(tipRow(s.color, s.name != null ? s.name : String(s.key), fmt(Math.max(0, num(p[s.key])))));
        });
        if (series.length > 1) f.appendChild(tipRow(null, 'Total', fmt(totals[i]), 't-tot'));
        return f;
      });
      return root;
    });
  }

  /* ------------------------------------------------------------------ donut */

  function arcPath(cx, cy, r0, r1_, a0, a1) {
    // angles in radians, clockwise from 12 o'clock
    function pt(r, a) { return [cx + r * Math.sin(a), cy - r * Math.cos(a)]; }
    var large = a1 - a0 > Math.PI ? 1 : 0;
    var p1 = pt(r1_, a0), p2 = pt(r1_, a1), p3 = pt(r0, a1), p4 = pt(r0, a0);
    return 'M' + r1(p1[0]) + ' ' + r1(p1[1]) +
      'A' + r1_ + ' ' + r1_ + ' 0 ' + large + ' 1 ' + r1(p2[0]) + ' ' + r1(p2[1]) +
      'L' + r1(p3[0]) + ' ' + r1(p3[1]) +
      'A' + r0 + ' ' + r0 + ' 0 ' + large + ' 0 ' + r1(p4[0]) + ' ' + r1(p4[1]) + 'Z';
  }
  function ringPath(cx, cy, r0, r1_) {
    return 'M' + (cx - r1_) + ' ' + cy + 'A' + r1_ + ' ' + r1_ + ' 0 1 1 ' + (cx + r1_) + ' ' + cy +
      'A' + r1_ + ' ' + r1_ + ' 0 1 1 ' + (cx - r1_) + ' ' + cy + 'Z' +
      'M' + (cx - r0) + ' ' + cy + 'A' + r0 + ' ' + r0 + ' 0 1 0 ' + (cx + r0) + ' ' + cy +
      'A' + r0 + ' ' + r0 + ' 0 1 0 ' + (cx - r0) + ' ' + cy + 'Z';
  }

  function donut(container, items, opts) {
    opts = opts || {};
    items = (Array.isArray(items) ? items : []).filter(function (it) { return it && num(it.value) > 0; });
    var fmt = fmtWith(opts.format);
    var sig = sigOf('dn', items, opts);

    mount(container, sig, function (cont, W, first) {
      var total = 0;
      items.forEach(function (it) { total += num(it.value); });
      if (!items.length || !(total > 0)) return showEmpty(cont, 160);

      var fam = fontFamily(cont);
      var root = el('div', 'charts-root charts-donut-wrap');
      var side = W >= 400;
      if (side) root.classList.add('charts-side');
      var size = Math.round(side ? Math.min(200, W * 0.44) : Math.min(200, Math.max(120, W)));
      var cx = size / 2, cy = size / 2;
      var outer = size / 2 - 4;
      var thick = Math.max(14, Math.min(24, size * 0.12));
      var inner = outer - thick;

      // display angles: tiny slices get a minimum visible size so they stay hoverable
      var MIN = 0.012;
      var shares = items.map(function (it) { return Math.max(num(it.value) / total, MIN); });
      var ssum = shares.reduce(function (a, b) { return a + b; }, 0);
      var out = [];
      out.push('<svg xmlns="' + NS + '" width="' + size + '" height="' + size + '" viewBox="0 0 ' + size + ' ' + size + '" role="img" aria-label="');
      out.push(esc('Donut chart of ' + items.length + ' items, total ' + fmt(total) + '. ' +
        items.map(function (it) { return it.name + ' ' + fmt(num(it.value)) + ' (' + pct(num(it.value) / total * 100) + ')'; }).join('; ')));
      out.push('">');

      if (first) {   // slices sweep in clockwise on first render (mask revealed by animating dashoffset)
        var sweepId = 'chm' + (++UID);
        var mr = (inner + outer) / 2, mc = 2 * Math.PI * mr;
        out.push('<defs><mask id="' + sweepId + '" maskUnits="userSpaceOnUse" x="0" y="0" width="' + size + '" height="' + size + '">' +
          '<circle class="charts-sweep" data-c="' + r1(mc) + '" cx="' + cx + '" cy="' + cy + '" r="' + r1(mr) + '" fill="none" stroke="#fff" stroke-width="' + (thick + 16) +
          '" stroke-dasharray="' + r1(mc) + '" transform="rotate(-90 ' + cx + ' ' + cy + ')"/></mask></defs>');
        out.push('<g mask="url(#' + sweepId + ')">');
      }
      var a = 0;
      items.forEach(function (it, i) {
        var span = shares[i] / ssum * Math.PI * 2;
        var color = safeColor(it.color, seriesColor(i + 1));
        var d, hitD;
        if (items.length === 1) {
          d = ringPath(cx, cy, inner, outer);
          hitD = ringPath(cx, cy, inner - 4, outer + 4);
        } else {
          d = arcPath(cx, cy, inner, outer, a, a + span);
          hitD = arcPath(cx, cy, inner - 4, outer + 4, a, a + span);
        }
        var aria = it.name + ': ' + fmt(num(it.value)) + ', ' + pct(num(it.value) / total * 100);
        out.push('<g class="charts-slice" data-s="' + i + '">');
        // the 2px surface ring between slices is a surface-coloured stroke on the visible slice
        out.push('<path class="charts-vis" d="' + d + '" fill-rule="evenodd" style="fill:' + esc(color) + ';stroke:' + (items.length > 1 ? 'var(--surface-1)' : 'none') + ';stroke-width:2;stroke-linejoin:round"/>');
        out.push('<path class="charts-hit" data-i="' + i + '" tabindex="0" role="img" aria-label="' + esc(aria) + '" d="' + hitD + '" fill-rule="evenodd"/>');
        out.push('</g>');
        a += span;
      });
      if (first) out.push('</g>');

      // center label/value
      var cv = opts.centerValue != null ? String(opts.centerValue) : fmt(total);
      var cl = opts.centerLabel != null ? String(opts.centerLabel) : 'Total';
      var avail = inner * 2 - 16;
      var fs = 22;
      while (fs > 11 && measure(cv, '600 ' + fs + 'px ' + fam) > avail) fs--;
      var clTxt = truncate(cl, avail, '11px ' + fam);
      out.push('<text class="charts-cv" x="' + cx + '" y="' + (cl ? cy + fs * 0.25 - 2 : cy + fs * 0.35) + '" text-anchor="middle" style="font-size:' + fs + 'px">' + esc(cv) + '</text>');
      if (cl) out.push('<text class="charts-cl" x="' + cx + '" y="' + (cy + fs * 0.25 + 14) + '" text-anchor="middle">' + esc(clTxt) + '</text>');
      out.push('</svg>');

      var holder = document.createElement('div');
      holder.innerHTML = out.join('');
      var svg = holder.firstChild;
      root.appendChild(svg);

      // legend with value and share (hover highlights the slice)
      if (opts.legend !== false) {
        var ul = el('ul', 'charts-dlegend');
        items.forEach(function (it, i) {
          var li = el('li');
          li.setAttribute('data-l', i);
          var sw = el('span', 'charts-sw');
          sw.style.background = safeColor(it.color, seriesColor(i + 1));
          li.appendChild(sw);
          var nm = el('span', 'n', it.name);
          nm.title = String(it.name);
          li.appendChild(nm);
          li.appendChild(el('span', 'v', fmt(num(it.value))));
          li.appendChild(el('span', 'p', pct(num(it.value) / total * 100)));
          ul.appendChild(li);
        });
        root.appendChild(ul);
        var slices = svg.querySelectorAll('.charts-slice');
        function hot(i, on) {
          root.classList.toggle('charts-has-hot', on);
          if (slices[i]) slices[i].classList.toggle('charts-hot', on);
        }
        ul.addEventListener('pointerover', function (e) {
          var li = e.target.closest && e.target.closest('li[data-l]');
          if (li) hot(+li.getAttribute('data-l'), true);
        });
        ul.addEventListener('pointerout', function (e) {
          var li = e.target.closest && e.target.closest('li[data-l]');
          if (li) hot(+li.getAttribute('data-l'), false);
        });
      }
      cont.appendChild(root);

      wire(root, cont, function (i) {
        var it = items[i];
        var f = el('div');
        f.appendChild(el('div', 't-h', it.name));
        f.appendChild(tipRow(safeColor(it.color, seriesColor(i + 1)), pct(num(it.value) / total * 100), fmt(num(it.value))));
        return f;
      });
      return root;
    });
  }

  /* ------------------------------------------------------------------ hbars */

  function hbars(container, items, opts) {
    opts = opts || {};
    items = (Array.isArray(items) ? items : []).filter(function (it) { return it && it.name != null; });
    var fmt = fmtWith(opts.format);
    var sig = sigOf('hb', items, opts);

    mount(container, sig, function (cont, W) {
      var n = items.length;
      var maxV = 0, total = 0;
      items.forEach(function (it) { var v = Math.max(0, num(it.value)); if (v > maxV) maxV = v; total += v; });
      if (!n || !(maxV > 0)) return showEmpty(cont, 120);

      var scaleMax = num(opts.max) > 0 ? num(opts.max) : maxV;
      var fam = fontFamily(cont);
      var fName = '12px ' + fam, fVal = '600 12px ' + fam, fSub = '11px ' + fam;
      var hasSub = items.some(function (it) { return it.sub != null && it.sub !== ''; });
      var rowH = hasSub ? 44 : 32;
      var H = n * rowH + 2;

      var valTxt = items.map(function (it) { return fmt(Math.max(0, num(it.value))); });
      var valW = 0;
      valTxt.forEach(function (t) { valW = Math.max(valW, measure(t, fVal)); });
      valW = Math.ceil(valW);
      var nameW = 0;
      items.forEach(function (it) {
        nameW = Math.max(nameW, measure(it.name, fName), it.sub ? measure(it.sub, fSub) : 0);
      });
      nameW = Math.ceil(Math.min(nameW, W * 0.4));
      nameW = Math.max(nameW, Math.min(72, W * 0.3));
      var x0 = nameW + 14;
      var barMax = W - x0 - valW - 10 - 4;
      if (barMax < 40) { nameW = Math.max(40, nameW - (40 - barMax)); x0 = nameW + 14; barMax = Math.max(20, W - x0 - valW - 14); }

      var root = el('div', 'charts-root');
      var out = [];
      out.push('<svg xmlns="' + NS + '" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="');
      out.push(esc('Horizontal bar chart, ' + n + ' items. ' + items.slice(0, 12).map(function (it, i) { return it.name + ' ' + valTxt[i]; }).join('; ') + (n > 12 ? '; and more' : '')));
      out.push('">');

      var bh = 10;
      items.forEach(function (it, i) {
        var v = Math.max(0, num(it.value));
        var top = 1 + i * rowH;
        var cy = top + rowH / 2;
        var bw = v > 0 ? Math.max(2, Math.min(barMax, v / scaleMax * barMax)) : 0;
        var color = safeColor(it.color, 'var(--series-1)');
        var sub = it.sub != null && it.sub !== '' ? String(it.sub) : '';
        var aria = it.name + ': ' + valTxt[i] + (sub ? ', ' + sub : '');
        out.push('<g class="charts-row">');
        out.push('<rect class="charts-hl" x="-6" y="' + (top + 1) + '" width="' + (W + 12) + '" height="' + (rowH - 2) + '" rx="6"/>');
        if (sub) {
          out.push('<text class="charts-name" x="0" y="' + (cy - 3) + '">' + esc(truncate(it.name, nameW, fName)) + '</text>');
          out.push('<text class="charts-sub" x="0" y="' + (cy + 12) + '">' + esc(truncate(sub, nameW, fSub)) + '</text>');
        } else {
          out.push('<text class="charts-name" x="0" y="' + (cy + 4) + '">' + esc(truncate(it.name, nameW, fName)) + '</text>');
        }
        if (bw > 0) {
          out.push('<g class="charts-grow" data-axis="x" data-tk="' + esc(it.name) + '" data-ph="' + r1(bw) + '" data-ox="' + x0 + '" data-oy="0">' +
            '<path class="charts-bar" d="' + pathRightRounded(x0, r1(cy - bh / 2), r1(bw), bh, RADIUS) + '" style="fill:' + esc(color) + '"/></g>');
        }
        out.push('<text class="charts-val charts-fade" data-bi="' + i + '" x="' + r1(x0 + bw + 8) + '" y="' + (cy + 4) + '">' + esc(valTxt[i]) + '</text>');
        out.push('<rect class="charts-hit" data-i="' + i + '" tabindex="0" role="img" aria-label="' + esc(aria) + '" x="-6" y="' + top + '" width="' + (W + 12) + '" height="' + rowH + '"/>');
        out.push('</g>');
      });
      // single vertical baseline all bars grow from
      out.push('<line class="charts-axis" x1="' + (x0 - 0.5) + '" x2="' + (x0 - 0.5) + '" y1="1" y2="' + (H - 1) + '"/>');
      out.push('</svg>');

      var holder = document.createElement('div');
      holder.innerHTML = out.join('');
      root.appendChild(holder.firstChild);
      cont.appendChild(root);

      wire(root, cont, function (i) {
        var it = items[i];
        var v = Math.max(0, num(it.value));
        var f = el('div');
        f.appendChild(el('div', 't-h', it.name));
        f.appendChild(tipRow(safeColor(it.color, 'var(--series-1)'), total > 0 ? pct(v / total * 100) + ' of total' : 'Value', valTxt[i]));
        if (it.sub != null && it.sub !== '') f.appendChild(el('div', 't-s', String(it.sub)));
        return f;
      });
      return root;
    });
  }

  /* ------------------------------------------------------------------ sparkline */

  function sparkline(container, values, opts) {
    opts = opts || {};
    values = (Array.isArray(values) ? values : []).map(num);
    var fmt = fmtWith(opts.format);
    var H = Math.max(16, num(opts.height) || (container && container.clientHeight) || 32);
    var sig = sigOf('sp', values, opts) + '|' + H;

    mount(container, sig, function (cont, W, first) {
      var n = values.length;
      var root = el('div', 'charts-root');
      var color = safeColor(opts.color, 'var(--accent)');
      var padX = 5, padY = 5;
      var pw = Math.max(10, W - padX * 2), ph = Math.max(6, H - padY * 2);
      var out = [];
      out.push('<svg xmlns="' + NS + '" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="');
      if (n) {
        var mn = Math.min.apply(null, values), mx = Math.max.apply(null, values);
        out.push(esc('Trend, ' + n + ' points, latest ' + fmt(values[n - 1]) + ', min ' + fmt(mn) + ', max ' + fmt(mx)));
      } else out.push('No trend data');
      out.push('">');

      if (!n) {
        out.push('<line class="charts-grid" x1="' + padX + '" x2="' + (W - padX) + '" y1="' + (H / 2) + '" y2="' + (H / 2) + '"/>');
        out.push('</svg>');
        var h0 = document.createElement('div'); h0.innerHTML = out.join('');
        root.appendChild(h0.firstChild); cont.appendChild(root);
        return root;
      }

      var lo = Math.min.apply(null, values), hi = Math.max.apply(null, values);
      var span = hi - lo;
      function X(i) { return n === 1 ? padX + pw : padX + pw * i / (n - 1); }
      function Yv(v) { return span > 0 ? padY + ph * (1 - (v - lo) / span) : padY + ph / 2; }
      var pts = values.map(function (v, i) { return [r1(X(i)), r1(Yv(v))]; });
      var line = pts.map(function (p, i) { return (i ? 'L' : 'M') + p[0] + ' ' + p[1]; }).join('');
      if (n > 1) {
        out.push('<g class="charts-fade" data-d="500"><path d="' + line + 'L' + pts[n - 1][0] + ' ' + (H - padY + 2) + 'L' + pts[0][0] + ' ' + (H - padY + 2) + 'Z" style="fill:' + esc(color) + ';opacity:.1;stroke:none"/></g>');
        out.push('<path class="charts-draw" pathLength="1" d="' + line + '" style="fill:none;stroke:' + esc(color) + ';stroke-width:2;stroke-linecap:round;stroke-linejoin:round' + (first ? ';stroke-dasharray:1' : '') + '"/>');
      }
      // end dot with 2px surface ring
      var lp = pts[n - 1];
      out.push('<circle class="charts-fade" data-d="800" cx="' + lp[0] + '" cy="' + lp[1] + '" r="4" style="fill:' + esc(color) + ';stroke:var(--surface-1);stroke-width:2"/>');
      // hover marker (moved by script) + nearest-point hit layer
      out.push('<circle class="charts-spk-dot" cx="-10" cy="-10" r="4" style="fill:' + esc(color) + ';stroke:var(--surface-1);stroke-width:2;pointer-events:none;display:none"/>');
      out.push('<rect class="charts-hit" x="0" y="0" width="' + W + '" height="' + H + '" tabindex="0" data-i="' + (n - 1) + '" aria-label="' + esc('Latest ' + fmt(values[n - 1])) + '"/>');
      out.push('</svg>');

      var holder = document.createElement('div');
      holder.innerHTML = out.join('');
      var svg = holder.firstChild;
      root.appendChild(svg);
      cont.appendChild(root);
      var dot = svg.querySelector('.charts-spk-dot');
      var labels = Array.isArray(opts.labels) ? opts.labels : null;

      function tipFor(i) {
        var f = el('div');
        if (labels && labels[i] != null) f.appendChild(el('div', 't-h', String(labels[i])));
        f.appendChild(tipRow(color, labels ? 'Value' : '#' + (i + 1) + ' of ' + n, fmt(values[i])));
        return f;
      }
      var hit = svg.querySelector('.charts-hit');
      function nearest(clientX) {
        var rc = svg.getBoundingClientRect();
        var x = (clientX - rc.left) * (W / (rc.width || W));
        var i = n === 1 ? 0 : Math.round((x - padX) / pw * (n - 1));
        return Math.max(0, Math.min(n - 1, i));
      }
      function showAt(i, cx, cy, anchor) {
        dot.setAttribute('cx', pts[i][0]); dot.setAttribute('cy', pts[i][1]); dot.style.display = '';
        tipShow(cont, tipFor(i), cx, cy, anchor);
      }
      function leave() { dot.style.display = 'none'; tipHide(cont); }
      function mv(e) { lastPtr.x = e.clientX; lastPtr.y = e.clientY; showAt(nearest(e.clientX), e.clientX, e.clientY, null); }
      hit.addEventListener('pointermove', mv);
      hit.addEventListener('pointerdown', mv);
      hit.addEventListener('pointerleave', leave);
      hit.addEventListener('blur', leave);
      hit.addEventListener('focus', function () {
        var kb = true;
        try { kb = hit.matches(':focus-visible'); } catch (e) { /* ignore */ }
        if (kb) showAt(n - 1, 0, 0, svg.getBoundingClientRect());
      });
      hit.addEventListener('keydown', function (e) { if (e.key === 'Escape') leave(); });
      return root;
    });
  }

  /* ------------------------------------------------------------------ shared helpers for ranked charts */

  // resolve any CSS colour (incl. var(--x)) to a relative luminance, to pick white or ink text on a fill
  function inkOn(cont, color) {
    var probe = document.createElement('span');
    probe.style.cssText = 'position:absolute;visibility:hidden;color:' + safeColor(color);
    cont.appendChild(probe);
    var c = '';
    try { c = getComputedStyle(probe).color; } catch (e) { /* ignore */ }
    cont.removeChild(probe);
    var m = /rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)/.exec(c);
    if (!m) return '#fff';
    function ch(v) { v = v / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }
    var L = 0.2126 * ch(+m[1]) + 0.7152 * ch(+m[2]) + 0.0722 * ch(+m[3]);
    return L <= 0.2 ? '#fff' : '#17171a';
  }

  // greedy label placement along x: higher priority first, drop anything that would touch a placed label
  function placeX(labels) {
    var placed = [];
    labels.sort(function (a, b) { return b.prio - a.prio; });
    labels.forEach(function (l) {
      var x0 = l.cx - l.w / 2 - 4, x1 = l.cx + l.w / 2 + 4;
      for (var i = 0; i < placed.length; i++) {
        if (x0 < placed[i].x1 && placed[i].x0 < x1) return;
      }
      placed.push({ x0: x0, x1: x1 });
      l.keep = true;
    });
    return labels.filter(function (l) { return l.keep; });
  }

  /* ------------------------------------------------------------------ columns / stackedColumns */

  // cfg: {bars:[{name, sub, segs:[{key,name,color,value}], total, tip(f)}], series, H, fmt, mode:'inside'|'total', maxBar, what}
  function columnChart(cont, W, cfg) {
    var bars = cfg.bars, n = bars.length, fmt = cfg.fmt;
    var maxTotal = 0;
    bars.forEach(function (b) { if (b.total > maxTotal) maxTotal = b.total; });
    if (!n || !(maxTotal > 0)) return showEmpty(cont, cfg.H);

    var fam = fontFamily(cont), font = '11px ' + fam, bfont = '600 11px ' + fam;
    var root = el('div', 'charts-root');
    if (cfg.series && cfg.series.length >= 2) {
      var lg = el('ul', 'charts-legend');
      cfg.series.forEach(function (s) {
        var li = el('li');
        var sw = el('span', 'charts-sw');
        sw.style.background = safeColor(s.color);
        li.appendChild(sw);
        li.appendChild(el('span', null, s.name != null ? s.name : s.key));
        lg.appendChild(li);
      });
      root.appendChild(lg);
    }

    var yt = niceTicks(maxTotal, 4);
    var tickLabels = yt.ticks.map(function (v) { return fmt(v); });
    var tw = 0;
    tickLabels.forEach(function (l) { tw = Math.max(tw, measure(l, font)); });
    var padL0 = Math.ceil(tw) + 10, padR = 10, padT = cfg.mode === 'inside' ? 16 : 22;
    var LMAX = 118;
    var labW = bars.map(function (b) { return Math.min(measure(b.name, font), LMAX); });
    var maxLab = Math.max.apply(null, labW);
    var slot0 = (W - padL0 - padR) / n;
    var rotate = !(n <= 8 && maxLab <= slot0 - 8);
    var band = rotate ? Math.ceil(maxLab * 0.7071) + 16 : 26;
    var padL = padL0;
    if (rotate) {
      var ext = labW[0] * 0.7071 + 4 - slot0 / 2 - padL0;
      if (ext > 0) padL = padL0 + Math.ceil(ext);
    }
    var plotW = Math.max(40, W - padL - padR);
    var plotH = Math.max(80, cfg.H - padT - band);
    var H = padT + plotH + band;
    var base = padT + plotH;
    function Y(v) { return padT + plotH * (1 - v / yt.max); }
    var slot = plotW / n;
    var bw = Math.min(cfg.maxBar || 60, slot - Math.max(GAP, slot * 0.28));
    if (bw < 1) bw = Math.max(0.5, slot - 0.5);

    // value labels
    var labels = [];
    if (cfg.mode === 'total') {
      bars.forEach(function (b, i) {
        if (b.total > 0) labels.push({ i: i, text: fmt(b.total), prio: b.total, cx: padL + slot * (i + 0.5), w: measure(fmt(b.total), bfont), inside: false });
      });
    } else {
      var order = bars.map(function (b, i) { return i; }).sort(function (a, b) { return bars[b].total - bars[a].total; });
      var wanted = n <= 15 ? order : order.slice(0, 3);
      wanted.forEach(function (i) {
        var b = bars[i];
        if (!(b.total > 0)) return;
        var t = fmt(b.total), w = measure(t, bfont);
        var barH = base - Y(b.total);
        labels.push({ i: i, text: t, prio: b.total, cx: padL + slot * (i + 0.5), w: w, inside: bw >= w + 8 && barH >= 24 });
      });
    }
    var inside = labels.filter(function (l) { return l.inside; });
    var above = placeX(labels.filter(function (l) { return !l.inside; }));
    var labelOf = {};
    inside.concat(above).forEach(function (l) { labelOf[l.i] = l; });

    var out = [];
    out.push('<svg xmlns="' + NS + '" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="');
    var top3 = bars.slice(0, 3).map(function (b) { return b.name + ' ' + fmt(b.total); }).join('; ');
    out.push(esc((cfg.what || 'Column chart') + ', ' + n + (n === 1 ? ' bar' : ' bars') + '. ' + top3 + (n > 3 ? '; and more' : '') + '.'));
    out.push('">');

    yt.ticks.forEach(function (v, i) {
      var y = Math.round(Y(v)) + 0.5;
      out.push('<line class="' + (i === 0 ? 'charts-axis' : 'charts-grid') + '" x1="' + padL + '" x2="' + (padL + plotW) + '" y1="' + y + '" y2="' + y + '"/>');
      out.push('<text class="charts-tick" x="' + (padL - 8) + '" y="' + (y + 3.5) + '" text-anchor="end">' + esc(tickLabels[i]) + '</text>');
    });

    bars.forEach(function (b, c) {
      var x0 = padL + slot * c;
      var bx = r1(x0 + (slot - bw) / 2);
      var cx = padL + slot * (c + 0.5);
      var aria = b.name + ': ' + (b.segs.length > 1
        ? b.segs.map(function (s) { return s.name + ' ' + fmt(s.value); }).join(', ') + '; total ' + fmt(b.total)
        : fmt(b.total)) + (b.sub ? ', ' + b.sub : '');
      out.push('<g class="charts-col">');
      out.push('<rect class="charts-hl" x="' + r1(x0) + '" y="' + padT + '" width="' + r1(slot) + '" height="' + plotH + '" rx="4"/>');

      var cum = 0, drawn = [];
      b.segs.forEach(function (s) {
        if (!(s.value > 0)) return;
        var yb = Y(cum), yt2 = Y(cum + s.value);
        cum += s.value;
        var bottom = drawn.length ? yb - GAP : yb;
        var h = bottom - yt2;
        if (h >= 0.75) drawn.push({ s: s, top: yt2, h: h });
      });
      if (drawn.length) {
        out.push('<g class="charts-grow" data-tk="' + esc(b.name) + '" data-ph="' + r1(base - Y(b.total)) + '" data-oy="' + base + '">');
        drawn.forEach(function (d, k) {
          var color = esc(safeColor(d.s.color));
          if (k === drawn.length - 1) {
            out.push('<path class="charts-seg" d="' + pathTopRounded(bx, r1(d.top), r1(bw), r1(d.h), RADIUS) + '" style="fill:' + color + '"/>');
          } else {
            out.push('<rect class="charts-seg" x="' + bx + '" y="' + r1(d.top) + '" width="' + r1(bw) + '" height="' + r1(d.h) + '" style="fill:' + color + '"/>');
          }
        });
        out.push('</g>');
      }

      var l = labelOf[c];
      if (l) {
        if (l.inside) {
          out.push('<text class="charts-peak charts-fade" data-bi="' + c + '" x="' + r1(cx) + '" y="' + r1(Y(bars[c].total) + 15) + '" text-anchor="middle" style="fill:' + esc(inkOn(cont, b.segs[0].color)) + '">' + esc(l.text) + '</text>');
        } else {
          var lx = Math.max(padL + l.w / 2, Math.min(cx, padL + plotW - l.w / 2 + 4));
          out.push('<text class="charts-peak charts-fade" data-bi="' + c + '" x="' + r1(lx) + '" y="' + r1(Y(bars[c].total) - 6) + '" text-anchor="middle">' + esc(l.text) + '</text>');
        }
      }

      // name label under the bar: rotated -45deg and ellipsised (horizontal only when every name fits)
      if (rotate) {
        var t = truncate(b.name, LMAX, font), lx2 = r1(cx + 4), ly2 = base + 12;
        out.push('<text class="charts-xlab2" x="' + lx2 + '" y="' + ly2 + '" text-anchor="end" transform="rotate(-45 ' + lx2 + ' ' + ly2 + ')">' + esc(t) + '</text>');
      } else {
        out.push('<text class="charts-xlab2" x="' + r1(cx) + '" y="' + (base + 16) + '" text-anchor="middle">' + esc(truncate(b.name, slot - 6, font)) + '</text>');
      }

      out.push('<rect class="charts-hit" data-i="' + c + '" tabindex="0" role="img" aria-label="' + esc(aria) + '" x="' + r1(x0) + '" y="' + (padT - 6) + '" width="' + r1(slot) + '" height="' + (plotH + band + 6) + '"/>');
      out.push('</g>');
    });
    out.push('</svg>');

    var holder = document.createElement('div');
    holder.innerHTML = out.join('');
    root.appendChild(holder.firstChild);
    cont.appendChild(root);
    wire(root, cont, function (i) {
      var f = el('div');
      bars[i].tip(f);
      return f;
    });
    return root;
  }

  function columns(container, items, opts) {
    opts = opts || {};
    items = (Array.isArray(items) ? items : []).filter(function (it) { return it && it.name != null; });
    var H = Math.max(160, num(opts.height) || 300);
    var fmt = fmtWith(opts.format);
    var sort = opts.sort === 'asc' || opts.sort === 'none' ? opts.sort : 'desc';
    var sig = sigOf('co', items, opts) + '|' + H;
    mount(container, sig, function (cont, W) {
      var arr = items.map(function (it, i) { return { it: it, v: Math.max(0, num(it.value)), i: i }; });
      if (sort !== 'none') arr.sort(function (a, b) { return sort === 'asc' ? a.v - b.v || a.i - b.i : b.v - a.v || a.i - b.i; });
      arr = arr.slice(0, Math.max(1, num(opts.maxItems) || 100));
      var bars = arr.map(function (a) {
        var color = safeColor(a.it.color, 'var(--series-1)');
        var name = String(a.it.name);
        return {
          name: name, sub: a.it.sub, total: a.v, segs: [{ key: 'v', name: name, color: color, value: a.v }],
          tip: function (f) {
            f.appendChild(el('div', 't-h', name));
            f.appendChild(tipRow(color, opts.valueName || 'Value', fmt(a.v)));
            if (a.it.sub != null && a.it.sub !== '') f.appendChild(el('div', 't-s', String(a.it.sub)));
          }
        };
      });
      return columnChart(cont, W, { bars: bars, series: null, H: H, fmt: fmt, mode: 'inside', what: 'Ranked column chart' });
    });
  }

  function stackedColumns(container, items, series, opts) {
    opts = opts || {};
    items = (Array.isArray(items) ? items : []).filter(function (it) { return it && it.name != null; });
    series = (Array.isArray(series) ? series : []).filter(function (s) { return s && s.key != null; });
    var H = Math.max(160, num(opts.height) || 300);
    var fmt = fmtWith(opts.format);
    var sort = opts.sort === 'asc' || opts.sort === 'none' ? opts.sort : 'desc';
    var maxItems = Math.max(1, Math.floor(num(opts.maxItems)) || 25);
    var sig = sigOf('sc', items, opts, series) + '|' + H;
    mount(container, sig, function (cont, W) {
      var arr = items.map(function (it, i) {
        var t = 0;
        series.forEach(function (s) { t += Math.max(0, num(it.parts && it.parts[s.key])); });
        return { it: it, t: t, i: i };
      });
      if (sort !== 'none') arr.sort(function (a, b) { return sort === 'asc' ? a.t - b.t || a.i - b.i : b.t - a.t || a.i - b.i; });
      arr = arr.slice(0, maxItems);
      var bars = arr.map(function (a) {
        var name = String(a.it.name);
        var segs = series.map(function (s) {
          return { key: s.key, name: s.name != null ? String(s.name) : String(s.key), color: s.color, value: Math.max(0, num(a.it.parts && a.it.parts[s.key])) };
        });
        return {
          name: name, sub: a.it.sub, total: a.t, segs: segs,
          tip: function (f) {
            f.appendChild(el('div', 't-h', name));
            segs.slice().reverse().forEach(function (s) { f.appendChild(tipRow(s.color, s.name, fmt(s.value))); });
            f.appendChild(tipRow(null, 'Total', fmt(a.t), 't-tot'));
            if (a.it.sub != null && a.it.sub !== '') f.appendChild(el('div', 't-s', String(a.it.sub)));
          }
        };
      });
      return columnChart(cont, W, { bars: bars, series: series, H: H, fmt: fmt, mode: 'total', what: 'Stacked column chart' });
    });
  }

  /* ------------------------------------------------------------------ scatter */

  function linearAxis(vals, target) {
    var mn = Math.min.apply(null, vals), mx = Math.max.apply(null, vals);
    var lo0 = (mn >= 0 && mn <= mx * 0.5) ? 0 : mn;
    var hi0 = mx;
    if (hi0 <= lo0) hi0 = lo0 + 1;
    var raw = (hi0 - lo0) / (target || 5);
    var p = Math.pow(10, Math.floor(Math.log10(raw)));
    var f = raw / p, nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
    var step = nf * p;
    var lo = Math.floor(lo0 / step + 1e-9) * step, hi = Math.ceil(hi0 / step - 1e-9) * step;
    var ticks = [];
    for (var v = lo; v <= hi + step * 1e-6; v += step) ticks.push(+v.toPrecision(12));
    return { lo: lo, hi: hi, ticks: ticks, log: false };
  }
  function logAxis(vals) {
    var mn = Math.min.apply(null, vals), mx = Math.max.apply(null, vals);
    var d0 = Math.floor(Math.log10(mn * 0.9)), d1 = Math.ceil(Math.log10(mx * 1.1));
    var sets = [[1, 2, 5], [1], [1]], ticks = [], stride = 1;
    for (var s = 0; s < sets.length; s++) {
      ticks = [];
      stride = s === 2 ? 2 : 1;
      for (var d = d0; d <= d1; d += stride) {
        for (var k = 0; k < sets[s].length; k++) ticks.push(+(sets[s][k] * Math.pow(10, d)).toPrecision(12));
      }
      if (ticks.length <= 16) break;
    }
    var lo = ticks[0], hi = ticks[ticks.length - 1];
    ticks.forEach(function (t) { if (t <= mn * 0.9) lo = t; });
    for (var q = ticks.length - 1; q >= 0; q--) { if (ticks[q] >= mx * 1.1) hi = ticks[q]; }
    if (!(hi > lo)) { lo = Math.pow(10, d0); hi = Math.pow(10, d1 + 1); }
    ticks = ticks.filter(function (t) { return t >= lo * 0.9999 && t <= hi * 1.0001; });
    return { lo: lo, hi: hi, ticks: ticks, log: true };
  }

  function scatter(container, points, opts) {
    opts = opts || {};
    var xlog = !!opts.xLog, ylog = !!opts.yLog;
    var pts = [];
    (Array.isArray(points) ? points : []).forEach(function (p, i) {
      if (!p) return;
      var x = Number(p.x), y = Number(p.y);
      if (!isFinite(x) || !isFinite(y) || (xlog && x <= 0) || (ylog && y <= 0)) return;
      pts.push({ id: p.id != null ? p.id : 'p' + i, name: p.name != null ? String(p.name) : '', x: x, y: y,
        color: safeColor(p.color, 'var(--series-1)'), r: isFinite(Number(p.r)) ? Math.max(4, Math.min(16, Number(p.r))) : 5.5,
        sub: p.sub, src: p });
    });
    var H = Math.max(200, num(opts.height) || 380);
    var xf = fmtWith(opts.xFormat || opts.format), yf = fmtWith(opts.yFormat || opts.format);
    var sig = sigOf('sx', points, opts) + '|' + H;

    mount(container, sig, function (cont, W) {
      if (!pts.length) return showEmpty(cont, H);
      var fam = fontFamily(cont), font = '11px ' + fam;
      var xs = pts.map(function (p) { return p.x; }), ys = pts.map(function (p) { return p.y; });
      var ax = xlog ? logAxis(xs) : linearAxis(xs, 6);
      var ay = ylog ? logAxis(ys) : linearAxis(ys, 5);
      var yLabs = ay.ticks.map(function (v) { return yf(v); });
      var xLabs = ax.ticks.map(function (v) { return xf(v); });
      var ytw = 0;
      yLabs.forEach(function (l) { ytw = Math.max(ytw, measure(l, font)); });
      var padL = Math.ceil(ytw) + 12 + (opts.yLabel ? 18 : 0), padR = 16, padT = 12;
      var padB = 24 + (opts.xLabel ? 20 : 0);
      var plotW = Math.max(60, W - padL - padR), plotH = Math.max(80, H - padT - padB);
      var base = padT + plotH, right = padL + plotW, INS = 12;

      function frac(a, v) {
        return a.log ? (Math.log(v) - Math.log(a.lo)) / (Math.log(a.hi) - Math.log(a.lo)) : (v - a.lo) / (a.hi - a.lo);
      }
      function X(v) { return padL + INS + frac(ax, v) * (plotW - 2 * INS); }
      function Y(v) { return base - INS - frac(ay, v) * (plotH - 2 * INS); }
      pts.forEach(function (p) { p.px = X(p.x); p.py = Y(p.y); });

      // Pareto frontier: lowest x for highest y
      var frontier = [], inFront = {};
      if (opts.frontier) {
        var sorted = pts.slice().sort(function (a, b) { return a.x - b.x || b.y - a.y; });
        var best = -Infinity;
        sorted.forEach(function (p) { if (p.y > best) { frontier.push(p); inFront[p.id] = true; best = p.y; } });
      }

      var root = el('div', 'charts-root');
      var out = [];
      out.push('<svg xmlns="' + NS + '" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="');
      out.push(esc('Scatter plot of ' + pts.length + ' points' + (opts.xLabel ? ', x: ' + opts.xLabel : '') + (opts.yLabel ? ', y: ' + opts.yLabel : '') +
        (xlog ? ' (log x axis)' : '') + (ylog ? ' (log y axis)' : '') + '.'));
      out.push('">');

      // quadrant shading: x <= qx and y >= qy
      var qbox = null;
      var q = opts.quadrant;
      if (q && isFinite(Number(q.x)) && isFinite(Number(q.y))) {
        var qx = Math.max(padL, Math.min(right, X(Number(q.x)))), qy = Math.max(padT, Math.min(base, Y(Number(q.y))));
        if (qx > padL + 1 && qy > padT + 1) {
          out.push('<g class="charts-fade" data-d="150"><rect x="' + padL + '" y="' + padT + '" width="' + r1(qx - padL) + '" height="' + r1(qy - padT) + '" style="fill:var(--good);opacity:.1"/></g>');
          if (q.label) {
            var ql = String(q.label), qw = measure(ql, '600 11px ' + fam);
            if (qw + 16 < qx - padL) {
              out.push('<text class="charts-qlab" x="' + (padL + 8) + '" y="' + (padT + 16) + '">' + esc(ql) + '</text>');
              qbox = { x0: padL + 6, y0: padT + 4, x1: padL + 10 + qw, y1: padT + 20 };
            }
          }
        }
      }

      // grid + axes
      ay.ticks.forEach(function (v, i) {
        var y = Math.round(Y(v)) + 0.5;
        out.push('<line class="charts-grid" x1="' + padL + '" x2="' + right + '" y1="' + y + '" y2="' + y + '"/>');
        out.push('<text class="charts-tick" x="' + (padL - 8) + '" y="' + (y + 3.5) + '" text-anchor="end">' + esc(yLabs[i]) + '</text>');
      });
      var xPlaced = [];
      // decade ticks (mantissa 1) get priority when thinning
      var xOrder = ax.ticks.map(function (v, i) { return i; }).sort(function (a, b) {
        function isOne(t) { var m = t / Math.pow(10, Math.floor(Math.log10(t))); return Math.abs(m - 1) < 1e-6 ? 0 : 1; }
        return (ax.log ? isOne(ax.ticks[a]) - isOne(ax.ticks[b]) : 0) || a - b;
      });
      var showX = {};
      xOrder.forEach(function (i) {
        var w = measure(xLabs[i], font), cx = X(ax.ticks[i]);
        var x0 = cx - w / 2 - 6, x1 = cx + w / 2 + 6, ok = true;
        for (var k = 0; k < xPlaced.length; k++) if (x0 < xPlaced[k][1] && xPlaced[k][0] < x1) { ok = false; break; }
        if (ok) { xPlaced.push([x0, x1]); showX[i] = true; }
      });
      ax.ticks.forEach(function (v, i) {
        var x = Math.round(X(v)) + 0.5;
        out.push('<line class="charts-grid" x1="' + x + '" x2="' + x + '" y1="' + padT + '" y2="' + base + '"/>');
        if (showX[i]) out.push('<text class="charts-tick" x="' + x + '" y="' + (base + 16) + '" text-anchor="middle">' + esc(xLabs[i]) + '</text>');
      });
      out.push('<line class="charts-axis" x1="' + padL + '" x2="' + right + '" y1="' + (base + 0.5) + '" y2="' + (base + 0.5) + '"/>');
      out.push('<line class="charts-axis" x1="' + (padL + 0.5) + '" x2="' + (padL + 0.5) + '" y1="' + padT + '" y2="' + base + '"/>');
      if (opts.xLabel) out.push('<text class="charts-axlab" x="' + r1(padL + plotW / 2) + '" y="' + (H - 4) + '" text-anchor="middle">' + esc(opts.xLabel) + '</text>');
      if (opts.yLabel) out.push('<text class="charts-axlab" transform="rotate(-90 12 ' + r1(padT + plotH / 2) + ')" x="12" y="' + r1(padT + plotH / 2 + 4) + '" text-anchor="middle">' + esc(opts.yLabel) + '</text>');

      // frontier (dotted)
      if (frontier.length >= 2) {
        out.push('<path class="charts-front charts-clip" d="' + frontier.map(function (p, i) { return (i ? 'L' : 'M') + r1(p.px) + ' ' + r1(p.py); }).join('') + '"/>');
      }

      // points (large first so small ones stay on top)
      pts.slice().sort(function (a, b) { return b.r - a.r; }).forEach(function (p) {
        var aria = p.name + ': ' + (opts.xLabel || 'x') + ' ' + xf(p.x) + ', ' + (opts.yLabel || 'y') + ' ' + yf(p.y);
        out.push('<g class="charts-pt charts-pop" data-i="' + pts.indexOf(p) + '" data-tk="' + esc(p.id) + '" data-cx="' + r1(p.px) + '" data-cy="' + r1(p.py) + '" tabindex="0" role="img" aria-label="' + esc(aria) + '">' +
          '<circle class="charts-dot" cx="' + r1(p.px) + '" cy="' + r1(p.py) + '" r="' + p.r + '" style="fill:' + esc(p.color) + '"/></g>');
      });

      // labels with simple collision avoidance
      var mode = opts.labels === undefined ? 'auto' : opts.labels;
      if (mode && mode !== 'none') {
        var boxes = qbox ? [qbox] : [];
        var dotBoxes = pts.map(function (p) { return { x0: p.px - p.r - 2, y0: p.py - p.r - 2, x1: p.px + p.r + 2, y1: p.py + p.r + 2 }; });
        function hit(a, b) { return a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1; }
        var order = pts.map(function (p, i) { return i; }).sort(function (a, b) {
          var fa = inFront[pts[a].id] ? 0 : 1, fb = inFront[pts[b].id] ? 0 : 1;
          return fa - fb || pts[b].r - pts[a].r || pts[b].y - pts[a].y;
        });
        order.forEach(function (i) {
          var p = pts[i];
          if (!p.name) return;
          var must = !!inFront[p.id];
          var h = 12, g = p.r + 4, t = '', chosen = null, fallback = null, fbScore = Infinity, fbT = '';
          // frontier labels may shrink (ellipsis) to find a free spot; others are simply dropped
          var widths = must ? [150, 96, 60] : [150];
          for (var wi = 0; wi < widths.length && !chosen; wi++) {
            t = truncate(p.name, widths[wi], font);
            var w = measure(t, font);
            var cands = [
              { x0: p.px + g, y0: p.py - h / 2 - 1, a: 'start', tx: p.px + g, ty: p.py + 4 },
              { x0: p.px - g - w, y0: p.py - h / 2 - 1, a: 'end', tx: p.px - g, ty: p.py + 4 },
              { x0: p.px - w / 2, y0: p.py - g - h - 1, a: 'middle', tx: p.px, ty: p.py - g - 3 },
              { x0: p.px - w / 2, y0: p.py + g, a: 'middle', tx: p.px, ty: p.py + g + h - 2 },
              { x0: p.px + g - 2, y0: p.py - g - h + 2, a: 'start', tx: p.px + g - 2, ty: p.py - g + 1 },
              { x0: p.px + g - 2, y0: p.py + g - 2, a: 'start', tx: p.px + g - 2, ty: p.py + g + h - 4 },
              { x0: p.px - g + 2 - w, y0: p.py - g - h + 2, a: 'end', tx: p.px - g + 2, ty: p.py - g + 1 },
              { x0: p.px - g + 2 - w, y0: p.py + g - 2, a: 'end', tx: p.px - g + 2, ty: p.py + g + h - 4 }
            ];
            for (var k = 0; k < cands.length && !chosen; k++) {
              var c = cands[k]; c.x1 = c.x0 + w; c.y1 = c.y0 + h;
              if (c.x0 < padL + 2 || c.x1 > W - 2 || c.y0 < padT || c.y1 > base) continue;
              var lb = 0, db = 0;
              for (var b = 0; b < boxes.length; b++) if (hit(c, boxes[b])) lb++;
              for (var d = 0; d < dotBoxes.length; d++) if (d !== i && hit(c, dotBoxes[d])) db++;
              if (!lb && !db) chosen = c;
              else if (lb * 10 + db < fbScore) { fbScore = lb * 10 + db; fallback = c; fbT = t; }
            }
          }
          // frontier points are always labelled: take the least-bad spot when nothing is free
          if (!chosen && must && fallback) { chosen = fallback; t = fbT; }
          if (!chosen) return;
          boxes.push(chosen);
          out.push('<text class="charts-plab charts-fade" data-d="650" x="' + r1(chosen.tx) + '" y="' + r1(chosen.ty) + '" text-anchor="' + chosen.a + '">' + esc(t) + '</text>');
        });
      }

      out.push('<rect class="charts-plane" x="' + padL + '" y="' + padT + '" width="' + plotW + '" height="' + plotH + '"/>');
      out.push('</svg>');

      var holder = document.createElement('div');
      holder.innerHTML = out.join('');
      var svg = holder.firstChild;
      root.appendChild(svg);
      cont.appendChild(root);

      var gs = {};
      svg.querySelectorAll('.charts-pt').forEach(function (g) { gs[g.getAttribute('data-i')] = g; });
      var plane = svg.querySelector('.charts-plane');
      var hot = null;
      function tipFor(i) {
        var p = pts[i], f = el('div');
        f.appendChild(el('div', 't-h', p.name || String(p.id)));
        f.appendChild(tipRow(p.color, opts.xLabel || 'x', xf(p.x)));
        f.appendChild(tipRow(null, opts.yLabel || 'y', yf(p.y)));
        if (p.sub != null && p.sub !== '') f.appendChild(el('div', 't-s', String(p.sub)));
        return f;
      }
      function setHot(i) {
        if (hot === i) return;
        if (hot != null && gs[hot]) gs[hot].classList.remove('charts-hot');
        hot = i;
        if (i != null && gs[i]) gs[i].classList.add('charts-hot');
      }
      // nearest-point hit layer: the pointer only has to be close, not dead-center
      function nearestAt(cx, cy) {
        var rc = svg.getBoundingClientRect();
        var s = W / (rc.width || W);
        var mx = (cx - rc.left) * s, my = (cy - rc.top) * s, bi = -1, bd = Infinity;
        pts.forEach(function (p, i) {
          var d = Math.sqrt((p.px - mx) * (p.px - mx) + (p.py - my) * (p.py - my));
          if (d < bd) { bd = d; bi = i; }
        });
        return bi >= 0 && bd <= Math.max(22, pts[bi].r + 12) ? bi : -1;
      }
      function at(cx, cy) {
        var i = nearestAt(cx, cy);
        if (i < 0) { setHot(null); tipHide(cont); plane.style.cursor = ''; return; }
        setHot(i);
        plane.style.cursor = typeof opts.onClick === 'function' ? 'pointer' : '';
        tipShow(cont, tipFor(i), cx, cy, null);
      }
      plane.addEventListener('pointermove', function (e) { lastPtr.x = e.clientX; lastPtr.y = e.clientY; at(e.clientX, e.clientY); });
      plane.addEventListener('pointerdown', function (e) { lastPtr.x = e.clientX; lastPtr.y = e.clientY; at(e.clientX, e.clientY); });
      plane.addEventListener('pointerleave', function () { setHot(null); tipHide(cont); });
      plane.addEventListener('click', function (e) {
        var i = nearestAt(e.clientX, e.clientY);
        if (i >= 0 && typeof opts.onClick === 'function') opts.onClick(pts[i].src);
      });
      svg.addEventListener('keydown', function (e) {
        if ((e.key === 'Enter' || e.key === ' ') && typeof opts.onClick === 'function') {
          var g = e.target.closest && e.target.closest('[data-i]');
          if (g) { e.preventDefault(); opts.onClick(pts[+g.getAttribute('data-i')].src); }
        }
      });
      root._restore = function (cx, cy) { at(cx, cy); };
      wire(root, cont, tipFor, { noPointer: true });
      svg.addEventListener('focusin', function (e) { var g = e.target.closest && e.target.closest('[data-i]'); if (g) setHot(+g.getAttribute('data-i')); });
      svg.addEventListener('focusout', function () { setHot(null); });
      return root;
    });
  }

  /* ------------------------------------------------------------------ countUp / reveal */

  function countUp(node, value, format, opts) {
    if (!node) return;
    opts = opts || {};
    var f = typeof format === 'function' ? format : function (n) { return Math.round(n).toLocaleString(); };
    value = Number(value);
    if (!isFinite(value)) value = 0;
    var st = node._cu;
    if (st && st.target === value) return;
    if (st && st.raf) cancelAnimationFrame(st.raf);
    var from = st ? st.shown : 0;
    st = node._cu = { target: value, shown: from, raf: 0 };
    function paint(v) { st.shown = v; try { node.textContent = f(v); } catch (e) { node.textContent = String(v); } }
    if (!animationsOn() || from === value || typeof requestAnimationFrame !== 'function') { paint(value); return; }
    var dur = num(opts.duration) > 0 ? num(opts.duration) : 700, t0 = null;
    paint(from);
    function tick(now) {
      if (t0 == null) t0 = now;
      var t = Math.min(1, (now - t0) / dur);
      paint(from + (value - from) * (1 - Math.pow(1 - t, 3)));
      if (t < 1) st.raf = requestAnimationFrame(tick); else { st.raf = 0; paint(value); }
    }
    st.raf = requestAnimationFrame(tick);
  }

  function reveal(root) {
    if (!root || !root.querySelectorAll || !animationsOn()) return;
    var els = [].filter.call(root.querySelectorAll('[data-reveal]'), function (e) { return !e._rv; });
    if (!els.length) return;
    var anims = [];
    els.forEach(function (e) {
      e._rv = true;
      try {
        var a = e.animate([{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }],
          { duration: 400, easing: EASE, fill: 'backwards' });
        a.pause();
        e._rva = a; anims.push(a);
      } catch (err) { /* ignore */ }
    });
    if (typeof IntersectionObserver !== 'function') { anims.forEach(function (a) { a.play(); }); return; }
    var io = new IntersectionObserver(function (es) {
      var vis = es.filter(function (x) { return x.isIntersecting; });
      vis.forEach(function (x, i) {
        var a = x.target._rva;
        if (a) { try { a.effect.updateTiming({ delay: i * 60 }); a.play(); } catch (err) { /* ignore */ } }
        io.unobserve(x.target);
      });
    }, { threshold: 0, rootMargin: '0px 0px -30px 0px' });
    els.forEach(function (e) { io.observe(e); });
  }

  /* ------------------------------------------------------------------ export */

  window.Charts = {
    donut: donut,
    stackedBars: stackedBars,
    hbars: hbars,
    sparkline: sparkline,
    columns: columns,
    stackedColumns: stackedColumns,
    scatter: scatter,
    countUp: countUp,
    reveal: reveal,
    seriesColor: seriesColor,
    animations: true   // set false to disable all animation (reduced-motion is always honoured)
  };
})();
