/* CCUsageX — UI (editorial redesign). Talks to the local server API (see docs/ARCHITECTURE.md); charts via window.Charts. */
(function () {
  'use strict';

  /* ================================================================== helpers */
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ESC[c]; }); }
  function num(v) { v = Number(v); return isFinite(v) ? v : 0; }
  function pad2(n) { return n < 10 ? '0' + n : '' + n; }
  var REDUCED = false;
  try { REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { /* ignore */ }

  function scale(n, units) {
    var v = Math.abs(n), i = 0;
    while (v >= 1000 && i < units.length - 1) { v /= 1000; i++; }
    var s = i === 0 ? String(Math.round(v)) : (v < 10 ? v.toFixed(2) : v < 100 ? v.toFixed(1) : v.toFixed(0));
    if (i > 0 && parseFloat(s) >= 1000 && i < units.length - 1) { v /= 1000; i++; s = v.toFixed(2); }
    return (n < 0 ? '-' : '') + s + units[i];
  }
  function fmtTok(n) { return n == null ? '—' : scale(num(n), ['', 'K', 'M', 'B', 'T']); }
  function fmtInt(n) { return n == null ? '—' : Math.round(num(n)).toLocaleString('en-US'); }
  function fmtCost(c) {
    if (c == null) return '—';
    c = num(c);
    if (c === 0) return '$0';
    if (c < 0.0001) return '<$0.0001';
    if (c < 1) return '$' + c.toFixed(4);
    return '$' + c.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function fmtDur(ms) {
    if (ms == null) return '—';
    ms = num(ms);
    if (ms < 1000) return Math.round(ms) + ' ms';
    if (ms < 60000) return (ms / 1000).toFixed(1) + ' s';
    var s = Math.round(ms / 1000), m = Math.floor(s / 60);
    if (m < 60) return m + 'm ' + pad2(s % 60) + 's';
    return Math.floor(m / 60) + 'h ' + pad2(m % 60) + 'm';
  }
  function fmtPct(x) { return (num(x) * 100).toFixed(1) + '%'; }
  function fmtRate(n) { n = num(n); return (n < 10 ? n.toFixed(1) : Math.round(n)) + ' tok/s'; }
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function fmtDate(ts) { var d = new Date(ts); return d.getDate() + ' ' + MON[d.getMonth()]; }
  function fmtTime(ts) {
    if (!ts) return '—';
    var d = new Date(ts);
    return d.getDate() + ' ' + MON[d.getMonth()] + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }
  function ago(ms) {
    var s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    return Math.floor(s / 86400) + 'd ago';
  }
  function trunc(s, n) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
  function firstLine(text) {
    var t = String(text == null ? '' : text).replace(/<\/?[a-z_][^>]*>/gi, ' ').replace(/\s+/g, ' ').trim();
    return t || '(no text)';
  }
  function median(a) { if (!a.length) return 0; var s = a.slice().sort(function (x, y) { return x - y; }); return s[Math.floor(s.length / 2)]; }
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } }
  function hasC(fn) { return !!(window.Charts && typeof window.Charts[fn] === 'function'); }

  /* ================================================================== colours */
  var FIXED_SLOT = { 'claude-opus-5-5': 1, 'claude-sonnet-5-5': 2, 'claude-haiku-5-5': 3, 'claude-fable-5-1': 4 };
  var extraSlots = {};
  try { extraSlots = JSON.parse(lsGet('ccu.modelSlots') || '{}') || {}; } catch (e) { extraSlots = {}; }
  function modelSlot(name) {
    if (FIXED_SLOT[name]) return FIXED_SLOT[name];
    if (extraSlots[name]) return extraSlots[name];
    var used = {};
    Object.keys(extraSlots).forEach(function (k) { used[extraSlots[k]] = 1; });
    for (var s = 5; s <= 8; s++) {
      if (!used[s]) { extraSlots[name] = s; lsSet('ccu.modelSlots', JSON.stringify(extraSlots)); return s; }
    }
    return 0;
  }
  function modelColor(name) { var s = modelSlot(name); return s ? 'var(--series-' + s + ')' : 'var(--axis)'; }
  function modelShort(m) { return String(m || '').replace(/^claude-/, ''); }
  function modelPill(m) { return '<span class="mdl" title="' + esc(m) + '"><i style="background:' + modelColor(m) + '"></i>' + esc(modelShort(m)) + '</span>'; }
  var EFFORT_SLOT = { low: 1, medium: 2, high: 3, xhigh: 4, max: 5 };
  function effortColor(e) { return EFFORT_SLOT[e] ? 'var(--series-' + EFFORT_SLOT[e] + ')' : 'var(--axis)'; }
  function effortBadge(e) {
    if (!e || e === '(none)') return '<span class="muted">—</span>';
    return '<span class="badge-dot"><i style="background:' + effortColor(e) + '"></i>' + esc(e) + '</span>';
  }
  function kindChip(r) {
    if (!r.sidechain) return '<span class="chip">Main</span>';
    return '<span class="chip accent" title="' + esc((r.agentType || 'subagent') + (r.agentDesc ? ' — ' + r.agentDesc : '')) + '">' + esc(r.agentType ? trunc(r.agentType, 16) : 'Subagent') + '</span>';
  }
  var projLabels = {};
  function buildProjLabels(list) {
    var by = {};
    (list || []).forEach(function (p) {
      var parts = String(p).split(/[\\/]+/).filter(Boolean);
      var b = parts[parts.length - 1] || p;
      (by[b] = by[b] || []).push({ p: p, parts: parts });
    });
    projLabels = {};
    Object.keys(by).forEach(function (b) {
      by[b].forEach(function (e) {
        projLabels[e.p] = by[b].length > 1 && e.parts.length > 1 ? e.parts.slice(-2).join('\\') : b;
      });
    });
    var cnt = {};
    Object.keys(projLabels).forEach(function (p) { cnt[projLabels[p]] = (cnt[projLabels[p]] || 0) + 1; });
    Object.keys(projLabels).forEach(function (p) { if (cnt[projLabels[p]] > 1) projLabels[p] = p; });
  }
  function projLabel(p) {
    if (p == null || p === '') return '—';
    if (projLabels[p]) return projLabels[p];
    var parts = String(p).split(/[\\/]+/).filter(Boolean);
    return parts[parts.length - 1] || p;
  }
  function toolLabel(t) {
    var m = /^mcp__(.+?)__(.+)$/.exec(t);
    return m ? m[1].replace(/^claude_ai_/, '') + ' › ' + m[2] : t;
  }

  /* ================================================================== state + URL hash */
  var SECTIONS = ['overview', 'cost', 'tokens', 'speed', 'models', 'prompts', 'tools', 'sessions', 'requests'];
  var DEF = {
    s: '', range: 'all', gran: 'auto', model: '', project: '', session: '', kind: '', q: '',
    rsort: 'time', rdir: 'desc', rsize: 20, rpage: 1, psort: 'time', pdir: 'desc', psize: 20, ppage: 1,
    ssort: 'last', sdir: 'desc', ssize: 20, spage: 1, metric: 'tokens', view: ''
  };
  var S = {};
  var ENUMS = {
    s: [''].concat(SECTIONS), range: ['today', '24h', '7d', '30d', 'all'], gran: ['auto', 'hour', 'day'],
    kind: ['', 'main', 'subagent'], rsort: ['time', 'cost', 'tokens', 'latency'], psort: ['time', 'cost', 'tokens'],
    rdir: ['asc', 'desc'], pdir: ['asc', 'desc'], sdir: ['asc', 'desc'], metric: ['requests', 'tokens', 'cost'],
    ssort: ['title', 'project', 'first', 'last', 'prompts', 'requests', 'tokens', 'cost'], view: ['', 'live']
  };
  var SIZES = [20, 50, 100];
  function readHash() {
    var p = new URLSearchParams(location.hash.replace(/^#/, ''));
    if (p.has('tab') && !p.has('s')) p.set('s', p.get('tab'));   // legacy links
    Object.keys(DEF).forEach(function (k) {
      var v = p.has(k) ? p.get(k) : DEF[k];
      if (typeof DEF[k] === 'number') {
        v = parseInt(v, 10);
        if (!(v > 0)) v = DEF[k];
        if (/size$/.test(k) && SIZES.indexOf(v) < 0) v = DEF[k];
      }
      if (ENUMS[k] && ENUMS[k].indexOf(v) < 0) v = DEF[k];
      S[k] = v;
    });
  }
  function hashString(over) {
    var p = new URLSearchParams();
    Object.keys(DEF).forEach(function (k) {
      var v = over && k in over ? over[k] : S[k];
      if (v !== DEF[k]) p.set(k, v);
    });
    return p.toString();
  }
  function writeHash() {
    var h = hashString(), cur = location.hash.replace(/^#/, '');
    if (h !== cur) {
      try { history.replaceState(null, '', location.pathname + location.search + (h ? '#' + h : '')); } catch (e) { /* ignore */ }
    }
  }
  function rangeBounds(r) {
    var now = Date.now();
    if (r === 'today') { var d = new Date(); d.setHours(0, 0, 0, 0); return { from: d.getTime() }; }
    if (r === '24h') return { from: now - 864e5 };
    if (r === '7d') return { from: now - 7 * 864e5 };
    if (r === '30d') return { from: now - 30 * 864e5 };
    return {};
  }
  function fparams(extra, noRange) {
    var p = new URLSearchParams();
    var b = noRange ? {} : rangeBounds(S.range);
    if (b.from) p.set('from', Math.round(b.from));
    if (S.model) p.set('model', S.model);
    if (S.project) p.set('project', S.project);
    if (S.session) p.set('session', S.session);
    if (S.kind) p.set('kind', S.kind);
    if (S.q) p.set('q', S.q);
    if (extra) Object.keys(extra).forEach(function (k) { p.set(k, extra[k]); });
    return p;
  }

  /* ================================================================== panel states */
  var ICON_EMPTY = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M8 14h4"/></svg>';
  var ICON_ERR = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v6M12 16.5v.5"/></svg>';
  function setLoading(el, rows) {
    var h = '<div class="skeleton" aria-busy="true" aria-label="Loading">';
    for (var i = 0; i < (rows || 5); i++) h += '<i></i>';
    el.innerHTML = h + '</div>';
    el.dataset.state = 'loading';
  }
  function setEmpty(el, msg) {
    el.innerHTML = '<div class="state">' + ICON_EMPTY + '<div>' + esc(msg || 'No data for the current filters') + '</div></div>';
    el.dataset.state = 'empty';
  }
  var retryFns = {}, retryN = 0;
  function setError(el, msg, retry) {
    var id = 'r' + (++retryN);
    retryFns[id] = retry;
    el.innerHTML = '<div class="state error" role="alert">' + ICON_ERR + '<div class="msg">' + esc(msg) + '</div>' +
      (retry ? '<button type="button" class="btn sm" data-retry="' + id + '">Retry</button>' : '') + '</div>';
    el.dataset.state = 'error';
  }
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('[data-retry]');
    if (b && retryFns[b.getAttribute('data-retry')]) retryFns[b.getAttribute('data-retry')]();
  });
  function ensureHost(body) {
    if (body.dataset.state === 'ready' && body._host && body._host.parentNode === body) return body._host;
    body.innerHTML = '';
    var h = document.createElement('div');
    h.className = 'cc-host';
    body.appendChild(h);
    body._host = h;
    body.dataset.state = 'ready';
    return h;
  }
  function chart(container, fn, args) {
    try {
      if (!hasC(fn)) throw new Error('Charts.' + fn + ' missing');
      window.Charts[fn].apply(window.Charts, [container].concat(args));
      return true;
    } catch (e) {
      if (window.console) console.warn('chart unavailable', fn, e);
      container.innerHTML = '<div class="chart-fallback">Chart unavailable</div>';
      return false;
    }
  }

  /* ================================================================== data layer */
  var D = {};          // datasets: s (summary), p (prompts by cost), pt (prompts by tokens), today
  var G = {};          // per-dataset state: {state:'loading'|'ready'|'error', msg}
  var ver = {};        // bumps whenever a dataset's payload changes
  var cache = {}, seq = {};
  var lastOk = 0, offline = false;
  var renderQueued = false;
  function sched() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(function () { renderQueued = false; renderAll(); });
  }
  async function getJson(url) {
    var r = await fetch(url, { cache: 'no-store' });
    var text = await r.text();
    if (!r.ok) {
      var msg = 'HTTP ' + r.status;
      try { var j = JSON.parse(text); if (j && j.error) msg += ' — ' + j.error; } catch (e) { /* ignore */ }
      throw new Error(msg);
    }
    return { text: text, data: JSON.parse(text) };
  }
  /* body: optional table container that shows loading/error. silent keeps what's on screen; unchanged payloads aren't re-rendered. */
  async function loadPanel(key, body, url, render, opts) {
    opts = opts || {};
    var my = (seq[key] = (seq[key] || 0) + 1);
    var had = G[key] && G[key].state === 'ready';
    if (!opts.silent || !had) { G[key] = { state: 'loading' }; if (body) setLoading(body, opts.rows); sched(); }
    try {
      var res = await getJson(url);
      if (my !== seq[key]) return null;
      lastOk = Date.now(); offline = false;
      var sig = url + '|' + res.text;
      var changed = !opts.silent || !!opts.force || !had || cache[key] !== sig;
      cache[key] = sig;
      G[key] = { state: 'ready' };
      if (changed) { ver[key] = (ver[key] || 0) + 1; render(res.data); }
      sched();
      return { data: res.data, changed: changed };
    } catch (e) {
      if (my !== seq[key]) return null;
      offline = true;
      if (!(opts.silent && had)) {
        G[key] = { state: 'error', msg: 'Could not load data: ' + (e.message || e) };
        if (body) setError(body, G[key].msg, function () { refresh(false); });
      }
      updateLive(); sched();
      return null;
    }
  }
  function groupState(needs) {
    var st = 'ready', msg = '';
    for (var i = 0; i < needs.length; i++) {
      var g = G[needs[i]];
      if (!g || g.state === 'loading') { if (st !== 'error') st = 'loading'; }
      else if (g.state === 'error') { st = 'error'; msg = g.msg; }
    }
    return { state: st, msg: msg };
  }
  var paintSig = {};
  /* Draws into body only when the datasets it needs (or extra) changed. draw(host) returns {empty} or a table spec. */
  function paint(key, body, needs, extra, draw, force) {
    var st = groupState(needs);
    var sig = needs.map(function (k) { return ver[k] || 0; }).join('.') + '|' + extra + '|' + st.state;
    if (!force && paintSig[key] === sig && body.dataset.state && body.dataset.state !== 'switch') return null;
    paintSig[key] = sig;
    if (st.state === 'loading') { setLoading(body, 5); return null; }
    if (st.state === 'error') { setError(body, st.msg, function () { refresh(false); }); return null; }
    var host = ensureHost(body);
    var r = draw(host) || {};
    if (r.empty) { setEmpty(body, r.empty); return { empty: true }; }
    return r;
  }

  /* ================================================================== count-up, reveal, scroll spy */
  function setNum(el, value, fmt) {
    value = num(value);
    var prev = el._v;
    if (prev === value) return;
    el._v = value;
    if (el._raf) cancelAnimationFrame(el._raf);
    if (REDUCED) { el.textContent = fmt(value); return; }
    var first = prev == null;
    if (first && hasC('countUp')) {
      try { window.Charts.countUp(el, value, fmt); return; } catch (e) { /* fall through */ }
    }
    var from = first ? 0 : num(prev), dur = first ? 1100 : 450, t0 = performance.now();
    function step(t) {
      var k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 3);
      el.textContent = fmt(from + (value - from) * e);
      if (k < 1) el._raf = requestAnimationFrame(step); else el.textContent = fmt(value);
    }
    el._raf = requestAnimationFrame(step);
  }
  var io = null;
  function observeReveal(root) {
    var els = $$('.rv:not(.shown)', root || document);
    if (!('IntersectionObserver' in window) || REDUCED) { els.forEach(function (e) { e.classList.add('shown'); }); return; }
    if (!io) {
      io = new IntersectionObserver(function (entries) {
        entries.forEach(function (en) {
          if (en.isIntersecting) { en.target.classList.add('shown'); io.unobserve(en.target); }
        });
      }, { threshold: 0.06, rootMargin: '0px 0px -4% 0px' });
    }
    els.forEach(function (e) { io.observe(e); });
  }
  var secEls = {}, spyQueued = false, spyTimer = null, scrolling = false;
  function spy() {
    spyQueued = false;
    if (S.view === 'live') return;
    var y = window.scrollY, hh = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--hh')) || 60;
    $('#topbar').classList.toggle('scrolled', y > 6);
    var line = hh + 120, cur = 'overview';
    SECTIONS.forEach(function (id) {
      var el = secEls[id] || (secEls[id] = document.getElementById(id));
      if (el && el.getBoundingClientRect().top <= line) cur = id;
    });
    if (window.innerHeight + y >= document.documentElement.scrollHeight - 4) cur = 'requests';
    $$('#index a').forEach(function (a) {
      var on = a.getAttribute('data-sec') === cur;
      a.classList.toggle('active', on);
      if (on) a.setAttribute('aria-current', 'location'); else a.removeAttribute('aria-current');
    });
    clearTimeout(spyTimer);
    spyTimer = setTimeout(function () { var s = cur === 'overview' ? '' : cur; if (S.s !== s && !scrolling) { S.s = s; writeHash(); } }, 250);
  }
  function goSection(id, instant) {
    if (S.view === 'live') setView('', true);
    var el = document.getElementById(id);
    if (!el) return;
    scrolling = true;
    el.scrollIntoView({ behavior: instant || REDUCED ? 'auto' : 'smooth', block: 'start' });
    S.s = id === 'overview' ? '' : id; writeHash();
    setTimeout(function () { scrolling = false; spy(); }, instant ? 50 : 800);
  }

  /* ================================================================== views (Dashboard | Live) */
  var shownView = null;
  function applyView() {
    var v = S.view === 'live' ? 'live' : '';
    if (v === shownView) return;
    var prev = shownView;
    shownView = v;
    document.body.setAttribute('data-view', v || 'dashboard');
    $('#live-view').hidden = v !== 'live';
    $('#dash').hidden = v === 'live';
    $$('#seg-view button').forEach(function (b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-view') === v)); });
    document.title = v === 'live' ? 'Live · CCUsageX' : (document.title.replace(/^Live · /, ''));
    if (window.CCULive && window.CCULive.setActive) window.CCULive.setActive(v === 'live');
    if (prev !== null) {
      window.scrollTo(0, 0);
      if (v !== 'live') { refresh(true); spy(); }
    }
  }
  function setView(v, keepScroll) {
    S.view = v === 'live' ? 'live' : '';
    writeHash();
    applyView();
    if (!keepScroll) window.scrollTo(0, 0);
  }

  /* ================================================================== partial-usage caveat */
  var statusInfo = null;
  function partialCount() {
    var s = D.s && D.s.totals && D.s.totals.partial;
    return num(s != null ? s : (statusInfo && statusInfo.partialRequests));
  }
  function partialText() {
    var n = partialCount();
    if (!n) return '';
    return fmtInt(n) + ' subagent request' + (n === 1 ? ' has' : 's have') + ' incomplete output counts in Claude Code\'s logs; output and thinking tokens (and their cost) may be under-counted.';
  }
  var COST_FOOT = 'API-equivalent at Anthropic list prices (config.json). You\'re on a subscription; this is not money charged.';
  function footHtml(extra) {
    var pt = partialText();
    return '<span>' + (extra || COST_FOOT) + '</span>' + (pt ? '<span><span class="info">ⓘ</span> ' + esc(pt) + '</span>' : '');
  }

  /* ================================================================== KPI strip + hero */
  var KP = [
    { id: 'requests', label: 'Requests', val: function (s) { return s.totals.requests; }, fmt: fmtInt, spark: 'requests',
      sub: function (s) { var k = (s.byKind || []).filter(function (x) { return x.name === 'Subagent'; })[0]; return k ? '<b>' + fmtInt(k.requests) + '</b> from subagents' : 'API calls to the model'; } },
    { id: 'prompts', label: 'Prompts', val: function (s) { return s.prompts; }, fmt: fmtInt,
      sub: function (s) { return s.prompts ? '<b>' + (s.totals.requests / s.prompts).toFixed(1) + '</b> requests per prompt' : 'messages you sent'; } },
    { id: 'tokens', label: 'Total tokens', val: function (s) { return s.totals.tokens; }, fmt: fmtTok, spark: 'tokens',
      sub: function (s) { var t = s.totals; return 'in <b>' + fmtTok(t.input) + '</b> · out <b>' + fmtTok(t.output) + '</b><br>cache write <b>' + fmtTok(t.cacheWrite) + '</b> · cache read <b>' + fmtTok(t.cacheRead) + '</b>'; } },
    { id: 'cost', label: 'API-equivalent cost', val: function (s) { return s.totals.cost; }, fmt: fmtCost, spark: 'cost',
      sub: function (s) { return 'Subscription — not billed per token' + (s.totals.unpriced ? '<br><span class="warn-note">' + fmtInt(s.totals.unpriced) + ' request(s) unpriced</span>' : ''); } },
    { id: 'hit', label: 'Cache hit rate', val: function (s) { return s.cacheHitRate; }, fmt: fmtPct, spark: 'hit',
      sub: function () { return 'cache reads ÷ all input-side tokens'; } },
    { id: 'resp', label: 'Response time (typical)', val: function (s) { return s.latency ? s.latency.p50 : 0; }, fmt: function (v) { return v ? fmtDur(v) : '—'; },
      sub: function (s) { var l = s.latency; return l ? 'Slowest 5% <b>' + fmtDur(l.p95) + '</b> · avg <b>' + fmtDur(l.avg) + '</b>' : 'no response-time data'; } },
    { id: 'thinking', label: 'Thinking tokens', val: function (s) { return s.totals.thinking; }, fmt: fmtTok, spark: 'thinking',
      sub: function (s) { return s.totals.output ? '<b>' + fmtPct(s.totals.thinking / s.totals.output) + '</b> of output tokens' : 'part of output'; } },
    { id: 'sessions', label: 'Sessions', val: function (s) { return s.sessions; }, fmt: fmtInt,
      sub: function (s) { return s.sessions ? '<b>' + (s.prompts / s.sessions).toFixed(1) + '</b> prompts per session' : 'Claude Code sessions'; } }
  ];
  function buildKpis() {
    $('#kpis').innerHTML = KP.map(function (k) {
      return '<div class="kpi loading" id="kpi-' + k.id + '"><div class="kpi-label">' + esc(k.label) + '</div><div class="kpi-value" data-v>&nbsp;</div><div class="kpi-sub" data-sub></div>' +
        (k.spark ? '<div class="kpi-spark" data-spark="' + k.spark + '" aria-hidden="true"></div>' : '') + '</div>';
    }).join('');
  }
  function renderKpis() {
    var s = D.s, st = groupState(['s']);
    var kp = $('#kpis');
    if (st.state === 'error' && !s) {
      if (kp.dataset.err !== '1') { kp.dataset.err = '1'; setError(kp, st.msg, function () { refresh(false); }); }
      return;
    }
    if (!s) return;
    if (kp.dataset.err === '1') { kp.dataset.err = ''; buildKpis(); }
    var pts = (s.trend && s.trend.points) || [];
    var series = {
      requests: pts.map(function (p) { return p.requests; }), tokens: pts.map(function (p) { return p.tokens; }),
      cost: pts.map(function (p) { return p.cost; }), thinking: pts.map(function (p) { return p.thinking; }),
      hit: pts.map(function (p) { var d = p.input + p.cacheRead + p.cacheWrite; return d ? p.cacheRead / d : 0; })
    };
    var fm = { requests: fmtInt, tokens: fmtTok, cost: fmtCost, thinking: fmtTok, hit: fmtPct };
    KP.forEach(function (k) {
      var el = $('#kpi-' + k.id);
      if (!el) return;
      el.classList.remove('loading');
      setNum($('[data-v]', el), k.val(s), k.fmt);
      var sub = k.sub(s), se = $('[data-sub]', el);
      if (se._h !== sub) { se._h = sub; se.innerHTML = sub; }
      var sp = $('[data-spark]', el);
      if (sp && pts.length >= 4) chart(sp, 'sparkline', [series[k.spark], { color: 'var(--accent)', format: fm[k.spark] }]);
    });
    var note = $('#strip-note'), pt = partialText();
    note.hidden = !pt;
    if (pt && note._h !== pt) { note._h = pt; note.innerHTML = '<span class="info">ⓘ</span><span>' + esc(pt) + '</span>'; }
    $('#hc-t').textContent = fmtCost(s.totals.cost) + ' API-equivalent';
    $('#cnt-prompts').textContent = fmtInt(s.prompts);
    $('#cnt-requests').textContent = fmtInt(s.totals.requests);
    $('#cnt-sessions').textContent = fmtInt(s.sessions);
    $('#cnt-tools').textContent = fmtInt((s.tools || []).length);
    var fp = $('#partial-note'); fp.hidden = !pt; fp.textContent = pt;
  }

  /* ================================================================== headline trio, feature cards, activity feed */
  function promptItems(rows, valueFn, subFn) {
    return rows.map(function (p) {
      return { id: p.id, name: trunc(firstLine(p.text), 22), full: firstLine(p.text), value: valueFn(p), color: modelColor((p.models && p.models[0]) || ''), sub: subFn(p) };
    }).filter(function (i) { return i.value > 0; });
  }
  function bindBarClick(host, items, onClick) {
    host._items = items; host._onClick = onClick;
    host.classList.toggle('clickable', !!onClick);
    if (host._bound) return;
    host._bound = true;
    function fire(e) {
      var h = e.target.closest && e.target.closest('[data-i]');
      if (!h || !host._onClick) return;
      var it = host._items[parseInt(h.getAttribute('data-i'), 10)];
      if (it) host._onClick(it);
    }
    host.addEventListener('click', fire);
    host.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { fire(e); } });
  }
  function drawColumns(host, items, o) {
    if (hasC('columns')) {
      items = items.slice().sort(function (a, b) { return b.value - a.value; });
      o = Object.assign({}, o, { sort: 'none' });
      var ok = chart(host, 'columns', [items, o]);
      if (ok) bindBarClick(host, items, o.onClick);
      return ok;
    }
    return chart(host, 'hbars', [items.slice(0, 12).map(function (i) { return { name: i.name, value: i.value, color: i.color, sub: i.sub }; }), { format: o.format }]);
  }
  function sumParts(i) { var t = 0; Object.keys(i.parts || {}).forEach(function (k) { t += num(i.parts[k]); }); return t; }
  function drawStacked(host, items, series, o) {
    if (hasC('stackedColumns')) {
      items = items.slice().sort(function (a, b) { return sumParts(b) - sumParts(a); });
      o = Object.assign({}, o, { sort: 'none' });
      var ok = chart(host, 'stackedColumns', [items, series, o]);
      if (ok) bindBarClick(host, items, o.onClick);
      return ok;
    }
    return chart(host, 'hbars', [items.slice(0, 16).map(function (i) { return { name: i.name, value: sumParts(i), color: 'var(--series-2)', sub: i.sub }; }), { format: o.format }]);
  }

  function renderTrio() {
    paint('t-cost', $('#t-cost-body'), ['p'], '', function (host) {
      var rows = ((D.p && D.p.rows) || []).slice(0, 12);
      var items = promptItems(rows, function (p) { return p.cost; }, function (p) { return fmtInt(p.requests) + ' req · ' + fmtTok(p.tokens) + ' tok'; });
      if (!items.length) return { empty: 'No priced prompts in this range' };
      drawColumns(host, items, { format: fmtCost, height: 210, onClick: function (it) { openPrompt(it.id); } });
    });
    paint('t-speed', $('#t-speed-body'), ['s'], '', function (host) {
      var items = ((D.s && D.s.byModel) || []).filter(function (m) { return num(m.speed) > 0; }).map(function (m) {
        return { id: m.name, name: modelShort(m.name), value: m.speed, color: modelColor(m.name), sub: fmtInt(m.requests) + ' requests' };
      }).sort(function (a, b) { return b.value - a.value; });
      if (!items.length) return { empty: 'No speed data yet' };
      drawColumns(host, items, { format: fmtRate, height: 210, onClick: function (it) { S.model = it.id; filtersChanged(); goSection('models'); } });
    });
    paint('t-tok', $('#t-tok-body'), ['pt'], '', function (host) {
      var rows = ((D.pt && D.pt.rows) || []).slice(0, 12);
      var items = promptItems(rows, function (p) { return p.tokens; }, function (p) { return fmtInt(p.requests) + ' req · ' + fmtCost(p.cost); });
      if (!items.length) return { empty: 'No prompts in this range' };
      drawColumns(host, items, { format: fmtTok, height: 210, onClick: function (it) { openPrompt(it.id); } });
    });
  }

  var ARROW = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M7 17L17 7M8 7h9v9"/></svg>';
  function renderFeatures() {
    // most expensive prompt today
    var fe = $('#f-expensive');
    var stT = groupState(['today']), sigE = (ver.today || 0) + '|' + stT.state + '|' + (ver.p || 0);
    if (fe._sig !== sigE) {
      fe._sig = sigE;
      var tp = D.today && D.today.rows && D.today.rows[0], label = 'TODAY';
      if (!tp && D.p && D.p.rows && D.p.rows[0]) { tp = D.p.rows[0]; label = 'IN RANGE'; }
      if (stT.state === 'loading') fe.innerHTML = '<div class="ftag">MOST EXPENSIVE PROMPT</div><div class="fbig">…</div>';
      else if (!tp) { fe.removeAttribute('data-prompt'); fe.innerHTML = '<div class="ftag">MOST EXPENSIVE PROMPT <span class="pill">TODAY</span></div><div class="ftitle">No prompts yet today</div><div class="ftext">Send a message in Claude Code and it will show up here within seconds.</div>'; }
      else {
        fe.setAttribute('data-prompt', tp.id);
        fe.innerHTML = '<div class="ftag">MOST EXPENSIVE PROMPT <span class="pill">' + label + '</span></div><div class="fbig" id="fe-big">' + fmtCost(tp.cost) + '</div>' +
          '<div class="ftext">' + esc(firstLine(tp.text)) + '</div>' +
          '<div class="fmeta"><span>' + fmtInt(tp.requests) + ' requests</span><span>' + fmtTok(tp.tokens) + ' tokens</span><span>' + esc((tp.models || []).map(modelShort).join(', ')) + '</span><span class="fgo">' + ARROW + '</span></div>';
        var big = $('#fe-big');
        if (big) { big._v = undefined; setNum(big, tp.cost, fmtCost); }
      }
    }
    // cache savings
    var fc = $('#f-cache'), stS = groupState(['s']), sigC = (ver.s || 0) + '|' + stS.state;
    if (fc._sig !== sigC) {
      fc._sig = sigC;
      if (stS.state === 'loading' || !D.s) fc.innerHTML = '<div class="ftag">CACHE SAVINGS</div><div class="fbig">…</div>';
      else {
        var would = 0, actual = 0, cr = 0;
        (D.s.byModel || []).forEach(function (m) {
          if (m.input > 0 && m.costParts && m.costParts.input > 0) {
            var pin = m.costParts.input / m.input;
            would += m.cacheRead * pin; actual += m.costParts.cacheRead; cr += m.cacheRead;
          }
        });
        var saved = Math.max(0, would - actual), pct = would ? saved / would : 0;
        if (!would) fc.innerHTML = '<div class="ftag">CACHE SAVINGS</div><div class="ftitle">Not enough data yet</div><div class="ftext">Cache savings appear once requests with cache reads are recorded.</div>';
        else {
          fc.innerHTML = '<div class="ftag">CACHE SAVINGS</div><div class="fbig"><span id="fc-big">' + fmtCost(saved) + '</span> <span style="font-size:20px;opacity:.8">saved</span></div>' +
            '<div class="ftext">Reading ' + fmtTok(cr) + ' tokens from cache would have cost <b>' + fmtCost(would) + '</b> at full input price. It cost <b>' + fmtCost(actual) + '</b>.</div>' +
            '<div class="fbar" role="img" aria-label="' + (pct * 100).toFixed(0) + '% saved"><b style="width:' + (REDUCED ? (pct * 100).toFixed(1) : 0) + '%"></b></div>' +
            '<div class="flegend"><span>' + (pct * 100).toFixed(1) + '% cheaper than uncached</span><span>hit rate ' + fmtPct(D.s.cacheHitRate) + '</span></div>';
          var big2 = $('#fc-big'); if (big2) setNum(big2, saved, fmtCost);
          var bar = $('.fbar b', fc);
          if (bar && !REDUCED) requestAnimationFrame(function () { requestAnimationFrame(function () { bar.style.width = (pct * 100).toFixed(1) + '%'; }); });
        }
      }
    }
    // activity feed
    var fl = $('#feed-list'), sigA = (ver.s || 0) + '|' + stS.state;
    if (fl._sig !== sigA) {
      fl._sig = sigA;
      if (stS.state === 'loading') setLoading(fl, 6);
      else if (stS.state === 'error') setError(fl, stS.msg, function () { refresh(false); });
      else {
        var act = (D.s && D.s.activity) || ((D.p && D.p.rows) || []).slice().sort(function (a, b) { return b.ts - a.ts; }).slice(0, 30);
        if (!act.length) setEmpty(fl, 'No prompts in this range');
        else {
          fl.dataset.state = 'ready';
          fl.innerHTML = act.map(function (a) {
            return '<button type="button" class="fi" data-prompt="' + esc(a.id) + '"><div class="when">' + esc(fmtTime(a.ts)) + ' · ' + ago(Date.now() - a.ts) + '</div><div class="what">' + esc(firstLine(a.text)) + '</div>' +
              '<div class="meta"><span><b>' + fmtInt(a.requests) + '</b> req</span><span><b>' + fmtCost(a.cost) + '</b></span>' + (a.durationMs ? '<span>' + fmtDur(a.durationMs) + '</span>' : '') + (a.models || []).map(modelPill).join('') + '</div></button>';
          }).join('');
        }
      }
    }
  }

  /* ================================================================== chart cards */
  var ICON_LINK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/></svg>';
  var ICON_TABLE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M3 15h18M10 4v16"/></svg>';
  var ICON_DL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M7 10l5 5 5-5M4 21h16"/></svg>';

  var CS = [
    { key: 'output', name: 'Output', color: 'var(--series-2)' },
    { key: 'thinking', name: 'Thinking', color: 'var(--series-7)' },
    { key: 'cacheWrite', name: 'Cache write', color: 'var(--series-4)' },
    { key: 'cacheRead', name: 'Cache read', color: 'var(--series-3)' },
    { key: 'input', name: 'Input', color: 'var(--series-1)' }
  ];
  var TS = [
    { key: 'input', name: 'Input', color: 'var(--series-1)' },
    { key: 'cacheWrite', name: 'Cache write', color: 'var(--series-4)' },
    { key: 'cacheRead', name: 'Cache read', color: 'var(--series-3)' },
    { key: 'output', name: 'Output', color: 'var(--series-2)' }
  ];
  var TS_PROMPT = [TS[3], TS[2], TS[1], TS[0]];
  function costParts(a) {
    var cp = a && a.costParts;
    if (!cp) return null;
    var th = Math.min(num(a.thinkingCost), num(cp.output));
    return { output: Math.max(0, num(cp.output) - th), thinking: th, cacheWrite: num(cp.cacheWrite), cacheRead: num(cp.cacheRead), input: num(cp.input) };
  }
  function xFormatFor(gran) {
    return function (t) {
      var d = new Date(t);
      return gran === 'day' ? fmtDate(t) : (d.getHours() === 0 ? fmtDate(t) + ' ' : '') + pad2(d.getHours()) + ':00';
    };
  }
  function metricVal(r, m) { return m === 'cost' ? num(r.cost) : m === 'tokens' ? num(r.tokens) : num(r.requests); }
  function metricFmt(m) { return m === 'cost' ? fmtCost : m === 'tokens' ? fmtTok : fmtInt; }
  function metricName(m) { return m === 'cost' ? 'API-equiv. cost' : m === 'tokens' ? 'Tokens' : 'Requests'; }
  function subOther(r, m) {
    var parts = [];
    if (m !== 'requests') parts.push(fmtInt(r.requests) + ' req');
    if (m !== 'tokens') parts.push(fmtTok(r.tokens) + ' tok');
    if (m !== 'cost') parts.push(fmtCost(r.cost));
    return parts.join(' · ');
  }
  function idx(n) { var a = []; for (var i = 1; i < n; i++) a.push(i); return a; }
  function tbl(cols, rows, numIdx) { return { table: { cols: cols, rows: rows, num: numIdx || [] } }; }
  function legendHtml(series) {
    return series.map(function (s) { return '<span><i class="sw" style="background:' + s.color + '"></i>' + esc(s.name) + '</span>'; }).join('');
  }

  function drawPromptStack(host, kind) {   // kind: 'cost' | 'tokens'
    var rows = ((D.p && D.p.rows) || []).slice().sort(function (a, b) { return kind === 'cost' ? b.cost - a.cost : b.tokens - a.tokens; }).slice(0, 24);
    if (!rows.length) return { empty: 'No prompts in this range' };
    var series = kind === 'cost' ? CS : TS_PROMPT;
    var f = kind === 'cost' ? fmtCost : fmtTok;
    var parts = rows.map(function (p) {
      return kind === 'cost' ? costParts(p) : { output: num(p.output), cacheWrite: num(p.cacheWrite), cacheRead: num(p.cacheRead), input: num(p.input) };
    });
    var click = function (it) { openPrompt(it.id); };
    if (parts.some(function (x) { return !x; })) {
      drawColumns(host, promptItems(rows, function (p) { return kind === 'cost' ? p.cost : p.tokens; }, function (p) { return fmtInt(p.requests) + ' req'; }), { format: f, height: 320, onClick: click });
    } else {
      var items = rows.map(function (p, i) {
        return { id: p.id, name: trunc(firstLine(p.text), 20), full: firstLine(p.text), parts: parts[i], sub: fmtInt(p.requests) + ' req · ' + (kind === 'cost' ? fmtTok(p.tokens) + ' tok' : fmtCost(p.cost)) };
      });
      drawStacked(host, items, series, { format: f, height: 320, maxItems: 24, onClick: click });
    }
    var cols = ['Prompt'].concat(series.map(function (s) { return s.name; })).concat([kind === 'cost' ? 'Total cost' : 'Total tokens']);
    return tbl(cols, rows.map(function (p, i) {
      var px = parts[i] || {};
      return [trunc(firstLine(p.text), 80)].concat(series.map(function (s) { return f(px[s.key] || 0); })).concat([f(kind === 'cost' ? p.cost : p.tokens)]);
    }), idx(cols.length));
  }
  function drawTrendStack(host, kind) {
    var s = D.s, pts = (s.trend && s.trend.points) || [], gran = (s.trend && s.trend.gran) || 'hour';
    if (!s.totals.requests) return { empty: 'No requests in this range' };
    var opts = { xFormat: xFormatFor(gran), height: 320 }, series, data, f;
    if (kind === 'cost') {
      f = fmtCost;
      if (pts.length && pts[0].costParts) {
        series = CS;
        data = pts.map(function (p) { var c = costParts(p); return { t: p.t, output: c.output, thinking: c.thinking, cacheWrite: c.cacheWrite, cacheRead: c.cacheRead, input: c.input }; });
      } else { series = [{ key: 'cost', name: 'API-equivalent cost', color: 'var(--accent)' }]; data = pts; }
    } else if (kind === 'tokens') { f = fmtTok; series = TS; data = pts; }
    else {
      f = fmtPct; series = [{ key: 'hit', name: 'Cache hit rate', color: 'var(--series-3)' }];
      data = pts.map(function (p) { var d = p.input + p.cacheRead + p.cacheWrite; return { t: p.t, hit: d ? p.cacheRead / d : 0 }; });
    }
    opts.format = f;
    chart(host, 'stackedBars', [data, series, opts]);
    var cols = ['Time'].concat(series.map(function (x) { return x.name; }));
    return tbl(cols, data.map(function (p) { return [gran === 'day' ? fmtDate(p.t) : fmtTime(p.t).slice(0, -3)].concat(series.map(function (x) { return f(p[x.key] || 0); })); }), idx(cols.length));
  }
  function modelFilterClick(it) { S.model = it.id; filtersChanged(); }

  function drawDist(host) {
    var rows = ((D.s && D.s.byModel) || []).slice().sort(function (a, b) { return metricVal(b, S.metric) - metricVal(a, S.metric); });
    if (!rows.length) return { empty: 'No model usage in this range' };
    var m = S.metric, f = metricFmt(m);
    var total = rows.reduce(function (a, r) { return a + metricVal(r, m); }, 0);
    var items = [], other = 0;
    rows.forEach(function (r) {
      if (modelSlot(r.name)) items.push({ name: modelShort(r.name), value: metricVal(r, m), color: modelColor(r.name) });
      else other += metricVal(r, m);
    });
    if (other > 0) items.push({ name: 'Other', value: other, color: 'var(--axis)' });
    if (!host._dist) {
      host.innerHTML = '<div class="dist"><div class="donut-box"></div><div style="overflow:auto"><table class="t mini"><thead><tr><th>Model</th><th class="num">Requests</th><th class="num">Tokens</th><th class="num">API-equiv. cost</th><th class="num">Share</th></tr></thead><tbody></tbody></table></div></div>';
      host._dist = true;
    }
    $('tbody', host).innerHTML = rows.map(function (r) {
      var share = total ? metricVal(r, m) / total : 0;
      return '<tr><td>' + modelPill(r.name) + '</td><td class="num">' + fmtInt(r.requests) + '</td><td class="num">' + fmtTok(r.tokens) + '</td><td class="num cost">' + fmtCost(r.cost) + (r.unpriced ? ' <span class="warn-note" title="Some requests have no price for this model">*</span>' : '') + '</td><td class="num">' + (share * 100).toFixed(1) + '%</td></tr>';
    }).join('');
    chart($('.donut-box', host), 'donut', [items, { format: f, legend: false, centerValue: f(total), centerLabel: metricName(m) }]);
    return tbl(['Model', 'Requests', 'Tokens', 'API-equivalent cost', 'Share'], rows.map(function (r) { return [modelShort(r.name), fmtInt(r.requests), fmtTok(r.tokens), fmtCost(r.cost), (total ? metricVal(r, m) / total * 100 : 0).toFixed(1) + '%']; }), [1, 2, 3, 4]);
  }
  function drawGroup(host, list, o) {
    var m = S.metric, f = metricFmt(m);
    if (!list || !list.length) return { empty: 'Nothing to show for this range' };
    var rows = list.slice().sort(function (a, b) { return metricVal(b, m) - metricVal(a, m); });
    var top = rows.slice(0, 12), rest = rows.slice(12);
    var items = top.map(function (r) {
      return { id: r.name, name: trunc(o.label ? o.label(r.name) : r.name, o.bars ? 40 : 18), value: metricVal(r, m), color: o.color ? o.color(r.name) : 'var(--series-1)', sub: subOther(r, m) };
    });
    if (rest.length) items.push({ name: 'Other (' + rest.length + ')', value: rest.reduce(function (a, r) { return a + metricVal(r, m); }, 0), color: 'var(--axis)' });
    items = items.filter(function (i) { return i.value > 0; });
    if (!items.length) return { empty: 'Nothing to show for this range' };
    if (o.bars) chart(host, 'hbars', [items, { format: f }]);
    else drawColumns(host, items, { format: f, height: 280 });
    return tbl([o.name, 'Requests', 'Tokens', 'API-equivalent cost'], rows.map(function (r) { return [o.label ? o.label(r.name) : r.name, fmtInt(r.requests), fmtTok(r.tokens), fmtCost(r.cost)]; }), [1, 2, 3]);
  }

  var NOLEG = function () { return []; };
  var CARD_DEFS = [
    {
      id: 'cost', mount: 'cards-cost', label: 'Cost',
      foot: function () { return footHtml(); },
      tabs: [
        { id: 'prompt', label: 'Cost per prompt', title: 'Cost per prompt, by token type', needs: ['p'], sub: 'API-equivalent USD for your costliest prompts, stacked by token type. Lower is better. Click a column to open the prompt.', legend: NOLEG, draw: function (host) { return drawPromptStack(host, 'cost'); } },
        { id: 'time', label: 'Cost over time', title: 'Cost over time, by token type', needs: ['s'], gran: true, sub: 'API-equivalent USD per time bucket, stacked by token type.', legend: NOLEG, draw: function (host) { return drawTrendStack(host, 'cost'); } },
        {
          id: 'model', label: 'Cost by model', title: 'Cost by model, by token type', needs: ['s'], sub: 'API-equivalent USD per model, stacked by token type. Click a column to filter to that model.', legend: NOLEG,
          draw: function (host) {
            var ms = ((D.s && D.s.byModel) || []).slice().sort(function (a, b) { return b.cost - a.cost; });
            if (!ms.length) return { empty: 'No model usage in this range' };
            if (ms.every(function (m) { return costParts(m); })) {
              var items = ms.map(function (m) { return { id: m.name, name: modelShort(m.name), parts: costParts(m), sub: fmtInt(m.requests) + ' req' }; });
              drawStacked(host, items, CS, { format: fmtCost, height: 320, onClick: modelFilterClick });
            } else drawColumns(host, ms.map(function (m) { return { id: m.name, name: modelShort(m.name), value: m.cost, color: modelColor(m.name), sub: fmtInt(m.requests) + ' req' }; }), { format: fmtCost, height: 320, onClick: modelFilterClick });
            return tbl(['Model', 'Output', 'Thinking', 'Cache write', 'Cache read', 'Input', 'Total'], ms.map(function (m) { var c = costParts(m) || {}; return [modelShort(m.name), fmtCost(c.output), fmtCost(c.thinking), fmtCost(c.cacheWrite), fmtCost(c.cacheRead), fmtCost(c.input), fmtCost(m.cost)]; }), [1, 2, 3, 4, 5, 6]);
          }
        }
      ]
    },
    {
      id: 'costscatter', mount: 'cards-cost', label: 'Cost scatter',
      foot: function () { return footHtml(); },
      tabs: [
        {
          id: 'prompts', label: 'Prompts: cost vs output tokens', title: 'Prompts: cost vs output tokens', needs: ['p'],
          sub: 'Each dot is one prompt. The shaded corner is the efficient one: cheap for a lot of output. The dotted line is the Pareto frontier. Click a dot to open the prompt.',
          legend: function () {
            var seen = {}, out = [];
            ((D.p && D.p.rows) || []).forEach(function (p) { var m = (p.models || [])[0]; if (m && !seen[m]) { seen[m] = 1; out.push({ name: modelShort(m), color: modelColor(m) }); } });
            return out.length > 1 ? out : [];
          },
          draw: function (host) {
            var rows = ((D.p && D.p.rows) || []).filter(function (p) { return p.cost > 0 && p.output > 0; });
            if (rows.length < 2) return { empty: 'Not enough prompts yet for a scatter (need at least 2)' };
            var pts = rows.map(function (p) { return { id: p.id, name: trunc(firstLine(p.text), 40), x: p.cost, y: p.output, color: modelColor((p.models || [])[0] || ''), r: 5 + Math.min(6, Math.sqrt(p.requests) / 2) }; });
            var qx = median(rows.map(function (p) { return p.cost; })), qy = median(rows.map(function (p) { return p.output; }));
            if (hasC('scatter')) chart(host, 'scatter', [pts, { xLabel: 'API-equivalent cost per prompt', yLabel: 'Output tokens', xFormat: fmtCost, yFormat: fmtTok, xLog: true, yLog: true, quadrant: { x: qx, y: qy, label: 'Cheap, high output' }, frontier: true, labels: 'auto', height: 380, onClick: function (pt) { openPrompt(pt.id); } }]);
            else host.innerHTML = '<div class="chart-fallback">Scatter chart unavailable</div>';
            return tbl(['Prompt', 'Cost', 'Output tokens', 'Requests', 'Model'], rows.map(function (p) { return [trunc(firstLine(p.text), 70), fmtCost(p.cost), fmtTok(p.output), fmtInt(p.requests), modelShort((p.models || [])[0] || '')]; }), [1, 2, 3]);
          }
        },
        {
          id: 'models', label: 'Models: speed vs cost per request', title: 'Models: speed vs cost per request', needs: ['s'],
          avail: function () { return D.s && (D.s.byModel || []).filter(function (m) { return m.speed > 0; }).length >= 2; },
          sub: 'Each dot is one model. Up and to the left is fast and cheap. Dot size is request count. Click a dot to filter to that model.',
          legend: function () { return ((D.s && D.s.byModel) || []).map(function (m) { return { name: modelShort(m.name), color: modelColor(m.name) }; }); },
          draw: function (host) {
            var ms = ((D.s && D.s.byModel) || []).filter(function (m) { return m.speed > 0 && m.costPerRequest > 0; });
            if (ms.length < 2) return { empty: 'Needs at least two models with speed data' };
            var pts = ms.map(function (m) { return { id: m.name, name: modelShort(m.name), x: m.costPerRequest, y: m.speed, color: modelColor(m.name), r: 6 + Math.min(10, Math.sqrt(m.requests) / 1.5) }; });
            if (hasC('scatter')) chart(host, 'scatter', [pts, { xLabel: 'API-equivalent cost per request', yLabel: 'Output tokens per second', xFormat: fmtCost, yFormat: fmtRate, quadrant: { x: median(ms.map(function (m) { return m.costPerRequest; })), y: median(ms.map(function (m) { return m.speed; })), label: 'Fast and cheap' }, frontier: true, labels: 'auto', height: 380, onClick: function (pt) { S.model = pt.id; filtersChanged(); } }]);
            else host.innerHTML = '<div class="chart-fallback">Scatter chart unavailable</div>';
            return tbl(['Model', 'Cost per request', 'Output tokens/s', 'Requests'], ms.map(function (m) { return [modelShort(m.name), fmtCost(m.costPerRequest), fmtRate(m.speed), fmtInt(m.requests)]; }), [1, 2, 3]);
          }
        }
      ]
    },
    {
      id: 'tokens', mount: 'cards-tokens', label: 'Tokens',
      foot: function () { return footHtml('Token counts come from Claude Code\'s own transcripts. Cache reads dominate because Claude re-reads the whole conversation on every request.'); },
      tabs: [
        { id: 'time', label: 'Tokens over time', title: 'Tokens over time', needs: ['s'], gran: true, sub: 'Tokens per time bucket, by type.', legend: NOLEG, draw: function (host) { return drawTrendStack(host, 'tokens'); } },
        { id: 'prompt', label: 'Tokens per prompt', title: 'Tokens per prompt, by type', needs: ['p'], sub: 'Total tokens for your heaviest prompts, by type. Lower is better. Click a column to open the prompt.', legend: NOLEG, draw: function (host) { return drawPromptStack(host, 'tokens'); } },
        { id: 'cache', label: 'Cache hit rate', title: 'Cache hit rate over time', needs: ['s'], gran: true, sub: 'Share of input-side tokens served from cache. Higher is better.', legend: NOLEG, draw: function (host) { return drawTrendStack(host, 'cache'); } }
      ]
    },
    {
      id: 'speed', mount: 'cards-speed', label: 'Speed',
      foot: function () { return footHtml('Response time = time from the previous event to the end of the model\'s reply (excludes tool run time). Speed is approximate: output tokens ÷ response time.'); },
      tabs: [
        {
          id: 'speed', label: 'Output speed', title: 'Output speed by model', needs: ['s'], sub: 'Median output tokens per second per request. Higher is better. Click a column to filter to that model.', legend: NOLEG,
          draw: function (host) {
            var ms = ((D.s && D.s.byModel) || []).filter(function (m) { return m.speed > 0; }).sort(function (a, b) { return b.speed - a.speed; });
            if (!ms.length) return { empty: 'No speed data in this range' };
            drawColumns(host, ms.map(function (m) { return { id: m.name, name: modelShort(m.name), value: m.speed, color: modelColor(m.name), sub: fmtInt(m.requests) + ' requests' }; }), { format: fmtRate, height: 300, onClick: modelFilterClick });
            return tbl(['Model', 'Output tokens/s', 'Requests'], ms.map(function (m) { return [modelShort(m.name), fmtRate(m.speed), fmtInt(m.requests)]; }), [1, 2]);
          }
        },
        {
          id: 'resp', label: 'Response time', title: 'Typical response time by model', needs: ['s'], sub: 'Median response time per request. Lower is better.', legend: NOLEG,
          draw: function (host) {
            var ms = ((D.s && D.s.byModel) || []).filter(function (m) { return m.latencyP50 > 0; }).sort(function (a, b) { return a.latencyP50 - b.latencyP50; });
            if (!ms.length) return { empty: 'No response-time data in this range' };
            drawColumns(host, ms.map(function (m) { return { id: m.name, name: modelShort(m.name), value: m.latencyP50, color: modelColor(m.name), sub: fmtInt(m.requests) + ' requests' }; }), { format: fmtDur, height: 300, onClick: modelFilterClick });
            var l = D.s.latency;
            return tbl(['Model', 'Typical response', 'Requests'], ms.map(function (m) { return [modelShort(m.name), fmtDur(m.latencyP50), fmtInt(m.requests)]; }).concat(l ? [['All models: typical / slowest 5%', fmtDur(l.p50) + ' / ' + fmtDur(l.p95), '']] : []), [1, 2]);
          }
        }
      ]
    },
    {
      id: 'models', mount: 'cards-models', label: 'Models',
      foot: function () { return footHtml(); },
      tabs: [
        { id: 'dist', label: 'Model distribution', title: 'Model distribution', needs: ['s'], metric: true, sub: 'Share of the selected metric per model.', legend: NOLEG, draw: drawDist },
        { id: 'effort', label: 'Effort levels', title: 'Effort levels', needs: ['s'], metric: true, sub: 'Which reasoning effort your requests ran at.', legend: NOLEG, draw: function (host) { return drawGroup(host, D.s.byEffort, { color: effortColor, name: 'Effort' }); } },
        { id: 'project', label: 'Projects', title: 'Projects', needs: ['s'], metric: true, sub: 'Where the work happened.', legend: NOLEG, draw: function (host) { return drawGroup(host, D.s.byProject, { label: projLabel, name: 'Project', bars: true }); } },
        { id: 'kind', label: 'Main vs Subagent', title: 'Main vs Subagent', needs: ['s'], metric: true, sub: 'Your own requests versus requests made by subagents Claude launched.', legend: NOLEG, draw: function (host) { return drawGroup(host, D.s.byKind, { color: function (n) { return n === 'Subagent' ? 'var(--series-7)' : 'var(--series-1)'; }, name: 'Type' }); } },
        { id: 'version', label: 'Claude Code versions', title: 'Claude Code versions', needs: ['s'], metric: true, sub: 'Which Claude Code version made the requests.', legend: NOLEG, draw: function (host) { return drawGroup(host, D.s.byVersion, { color: function () { return 'var(--series-7)'; }, name: 'Version' }); } }
      ]
    },
    {
      id: 'tools', mount: 'cards-tools', label: 'Tools',
      foot: function () { return '<span>A request that calls several tools counts once for each tool.</span>'; },
      tabs: [
        {
          id: 'tools', label: 'Tools used', title: 'Tools used', needs: ['s'], sub: 'Number of requests that called each tool.', legend: NOLEG,
          draw: function (host) {
            var t = (D.s && D.s.tools) || [];
            if (!t.length) return { empty: 'No tool calls in this range' };
            var top = t.slice(0, 18), rest = t.slice(18).reduce(function (a, x) { return a + x.count; }, 0);
            var items = top.map(function (x) { return { name: trunc(toolLabel(x.name), 36), value: x.count, color: 'var(--series-1)' }; });
            if (rest) items.push({ name: 'Other (' + (t.length - 18) + ')', value: rest, color: 'var(--axis)' });
            chart(host, 'hbars', [items, { format: fmtInt }]);
            return tbl(['Tool', 'Requests'], t.map(function (x) { return [toolLabel(x.name), fmtInt(x.count)]; }), [1]);
          }
        }
      ]
    }
  ];

  var CARDS = {};
  function buildCards() {
    CARD_DEFS.forEach(function (def) {
      var card = { def: def, tab: def.tabs[0].id, view: 'chart', tbl: null };
      CARDS[def.id] = card;
      var el = document.createElement('article');
      el.className = 'cc rv'; el.id = 'card-' + def.id; el.setAttribute('data-card', def.id);
      el.innerHTML =
        '<div class="cc-tabs" role="tablist" aria-label="' + esc(def.label) + ' views"></div>' +
        '<div class="cc-main"><div class="cc-head"><div class="cc-titles"><h3></h3><p class="cc-sub"></p></div><div class="cc-tools">' +
        '<span class="pill-group" data-cgran role="group" aria-label="Granularity" hidden><button type="button" data-v="auto" aria-pressed="true">Auto</button><button type="button" data-v="hour" aria-pressed="false">Hour</button><button type="button" data-v="day" aria-pressed="false">Day</button></span>' +
        '<span class="pill-group" data-cmetric role="group" aria-label="Metric" hidden><button type="button" data-v="tokens" aria-pressed="true">Tokens</button><button type="button" data-v="cost" aria-pressed="false">Cost</button><button type="button" data-v="requests" aria-pressed="false">Requests</button></span>' +
        '<button type="button" class="tool-btn" data-act="copy" title="Copy link to this section" aria-label="Copy link to this section">' + ICON_LINK + '</button>' +
        '<button type="button" class="tool-btn" data-act="table" aria-pressed="false" title="Table view" aria-label="Toggle table view">' + ICON_TABLE + '</button>' +
        '<button type="button" class="tool-btn" data-act="csv" title="Download this data as CSV" aria-label="Download table as CSV">' + ICON_DL + '</button>' +
        '</div></div><div class="cc-legend" hidden></div><div class="cc-body" role="tabpanel"><div class="cc-chart"></div><div class="cc-table" hidden></div></div></div>' +
        '<div class="cc-foot"></div>';
      $('#' + def.mount).appendChild(el);
      card.el = el; card.chartEl = $('.cc-chart', el); card.tableEl = $('.cc-table', el);
      card.chartEl.dataset.state = 'switch';
    });
  }
  function availTabs(card) { return card.def.tabs.filter(function (t) { return !t.avail || t.avail(); }); }
  function renderCard(card, force) {
    var def = card.def, tabs = availTabs(card);
    var tab = tabs.filter(function (t) { return t.id === card.tab; })[0] || tabs[0];
    if (!tab) return;
    if (card.tab !== tab.id) { card.tab = tab.id; card.chartEl.dataset.state = 'switch'; }
    var strip = $('.cc-tabs', card.el), tsig = tabs.map(function (t) { return t.id; }).join() + '|' + tab.id;
    if (strip._sig !== tsig) {
      strip._sig = tsig;
      strip.innerHTML = tabs.map(function (t) { return '<button type="button" class="cc-tab" role="tab" data-tab="' + t.id + '" aria-selected="' + (t.id === tab.id) + '" tabindex="' + (t.id === tab.id ? 0 : -1) + '">' + esc(t.label) + '</button>'; }).join('');
    }
    var h3 = $('h3', card.el); if (h3.textContent !== tab.title) h3.textContent = tab.title;
    var sub = $('.cc-sub', card.el); if (sub.textContent !== (tab.sub || '')) sub.textContent = tab.sub || '';
    $('[data-cgran]', card.el).hidden = !tab.gran;
    $('[data-cmetric]', card.el).hidden = !tab.metric;
    var foot = $('.cc-foot', card.el), fh = def.foot();
    if (foot._h !== fh) { foot._h = fh; foot.innerHTML = fh; }
    var extra = [tab.id, tab.metric ? S.metric : '', tab.gran ? S.gran : ''].join('|');
    var res = paint('card-' + def.id, card.chartEl, tab.needs, extra, function (host) {
      var lg = $('.cc-legend', card.el), series = tab.legend ? tab.legend() : [];
      lg.hidden = !series.length; lg.innerHTML = legendHtml(series);
      return tab.draw(host);
    }, force);
    if (res === null) { if (groupState(tab.needs).state !== 'ready') $('.cc-legend', card.el).hidden = true; }
    else { card.tbl = res.table || null; if (res.empty) $('.cc-legend', card.el).hidden = true; }
    var tv = card.view === 'table';
    card.chartEl.hidden = tv; card.tableEl.hidden = !tv;
    var tb = $('[data-act="table"]', card.el); tb.setAttribute('aria-pressed', String(tv));
    if (tv && (res !== null || card.tableEl._for !== paintSig['card-' + def.id] || force)) {
      card.tableEl._for = paintSig['card-' + def.id];
      card.tableEl.innerHTML = card.tbl ? tableSpecHtml(card.tbl) : '<div class="state">' + ICON_EMPTY + '<div>No table data</div></div>';
    }
    $('[data-act="csv"]', card.el).disabled = !card.tbl;
  }
  function tableSpecHtml(t) {
    return '<table class="t"><thead><tr>' + t.cols.map(function (c, i) { return '<th' + (t.num.indexOf(i) >= 0 ? ' class="num"' : '') + '>' + esc(c) + '</th>'; }).join('') + '</tr></thead><tbody>' +
      t.rows.map(function (r) { return '<tr>' + r.map(function (c, i) { return '<td' + (t.num.indexOf(i) >= 0 ? ' class="num"' : '') + '>' + esc(c) + '</td>'; }).join('') + '</tr>'; }).join('') + '</tbody></table>';
  }
  function csvCell(v) { var s = String(v == null ? '' : v); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
  function downloadCsv(card) {
    if (!card.tbl) return;
    var lines = [card.tbl.cols.map(csvCell).join(',')].concat(card.tbl.rows.map(function (r) { return r.map(csvCell).join(','); }));
    var blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = 'claude-code-usage-' + card.def.id + '-' + card.tab + '.csv';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
  }
  var toastT = null;
  function toast(msg) {
    var t = $('#toast');
    if (!t) { t = document.createElement('div'); t.id = 'toast'; t.setAttribute('role', 'status'); document.body.appendChild(t); }
    t.textContent = msg; t.classList.add('show');
    clearTimeout(toastT); toastT = setTimeout(function () { t.classList.remove('show'); }, 1800);
  }
  function copyLink(sec) {
    var url = location.origin + location.pathname + '#' + hashString({ s: sec === 'overview' ? '' : sec });
    function ok() { toast('Link copied'); }
    function fallback() {
      var ta = document.createElement('textarea'); ta.value = url; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); ok(); } catch (e) { toast(url); }
      ta.remove();
    }
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(url).then(ok, fallback); return; }
    } catch (e) { /* fall through */ }
    fallback();
  }
  function wireCards() {
    $('#sections').addEventListener('click', function (e) {
      var cardEl = e.target.closest('.cc'); if (!cardEl) return;
      var card = CARDS[cardEl.getAttribute('data-card')];
      var tb = e.target.closest('.cc-tab');
      if (tb) { card.tab = tb.getAttribute('data-tab'); card.chartEl.dataset.state = 'switch'; renderCard(card, true); return; }
      var act = e.target.closest('[data-act]');
      if (act) {
        var a = act.getAttribute('data-act');
        if (a === 'copy') copyLink(cardEl.closest('section').id);
        else if (a === 'table') { card.view = card.view === 'table' ? 'chart' : 'table'; renderCard(card, true); }
        else if (a === 'csv') downloadCsv(card);
        return;
      }
      var g = e.target.closest('[data-cgran] button');
      if (g) { S.gran = g.getAttribute('data-v'); filtersChanged(); return; }
      var m = e.target.closest('[data-cmetric] button');
      if (m) { S.metric = m.getAttribute('data-v'); writeHash(); syncUi(); renderCards(); }
    });
    $('#sections').addEventListener('keydown', function (e) {
      var tb = e.target.closest && e.target.closest('.cc-tab'); if (!tb) return;
      var tabs = $$('.cc-tab', tb.parentNode), i = tabs.indexOf(tb), n = null;
      if (e.key === 'ArrowRight') n = tabs[(i + 1) % tabs.length]; else if (e.key === 'ArrowLeft') n = tabs[(i - 1 + tabs.length) % tabs.length];
      if (n) { e.preventDefault(); var id = n.getAttribute('data-tab'), strip = tb.parentNode; n.click(); var again = $('.cc-tab[data-tab="' + id + '"]', strip); if (again) again.focus(); }
    });
  }
  function renderCards() { Object.keys(CARDS).forEach(function (id) { renderCard(CARDS[id]); }); }
  function renderAll() { renderKpis(); renderTrio(); renderFeatures(); renderCards(); }

  /* ================================================================== tables */
  function theadHtml(cols, sortKey, dir) {
    return '<thead><tr>' + cols.map(function (c) {
      var cls = c.num ? ' class="num"' : '';
      if (c.sort) {
        var active = c.sort === sortKey;
        return '<th' + cls + (active ? ' aria-sort="' + (dir === 'asc' ? 'ascending' : 'descending') + '"' : '') + '><button type="button" class="sort" data-sort="' + c.sort + '" title="Sort by ' + esc(c.label) + '">' + esc(c.label) + (active ? ' <span class="arr">' + (dir === 'asc' ? '▲' : '▼') + '</span>' : '') + '</button></th>';
      }
      return '<th' + cls + (c.title ? ' title="' + esc(c.title) + '"' : '') + '>' + esc(c.label) + '</th>';
    }).join('') + '</tr></thead>';
  }
  function tbodyHtml(cols, rows, rowAttr) {
    return '<tbody>' + rows.map(function (r) {
      return '<tr class="clickable" tabindex="0" ' + rowAttr(r) + '>' + cols.map(function (c) {
        var cls = [c.num ? 'num' : '', c.cls || ''].join(' ').trim();
        return '<td' + (cls ? ' class="' + cls + '"' : '') + (c.tip ? ' title="' + esc(c.tip(r)) + '"' : '') + '>' + c.render(r) + '</td>';
      }).join('') + '</tr>';
    }).join('') + '</tbody>';
  }
  function pagerHtml(page, size, total) {
    var pages = Math.max(1, Math.ceil(total / size));
    var from = total ? (page - 1) * size + 1 : 0, to = Math.min(total, page * size);
    var nums = [], last = 0;
    for (var i = 1; i <= pages; i++) {
      if (i === 1 || i === pages || Math.abs(i - page) <= 1 || (page <= 3 && i <= 4) || (page >= pages - 2 && i >= pages - 3)) {
        if (last && i - last > 1) nums.push('<span class="gap">…</span>');
        nums.push('<button type="button" class="pg" data-page="' + i + '"' + (i === page ? ' aria-current="page"' : '') + ' aria-label="Page ' + i + '">' + i + '</button>');
        last = i;
      }
    }
    return '<span>Showing <b>' + fmtInt(from) + '</b> to <b>' + fmtInt(to) + '</b> of <b>' + fmtInt(total) + '</b> results</span>' +
      '<label>Per page <select class="sel" data-size aria-label="Rows per page">' + SIZES.map(function (n) { return '<option' + (n === size ? ' selected' : '') + '>' + n + '</option>'; }).join('') + '</select></label>' +
      '<span class="pages"><button type="button" class="pg" data-page="' + (page - 1) + '"' + (page <= 1 ? ' disabled' : '') + ' aria-label="Previous page">‹</button>' + nums.join('') +
      '<button type="button" class="pg" data-page="' + (page + 1) + '"' + (page >= pages ? ' disabled' : '') + ' aria-label="Next page">›</button></span>';
  }
  var PAGE_KEYS = { requests: ['rpage', 'rsize'], prompts: ['ppage', 'psize'], sessions: ['spage', 'ssize'] };
  function wirePager(name, reload) {
    var el = $('#' + name + '-pager');
    el.addEventListener('click', function (e) {
      var b = e.target.closest('[data-page]');
      if (!b || b.disabled) return;
      S[PAGE_KEYS[name][0]] = parseInt(b.getAttribute('data-page'), 10);
      writeHash(); reload(true, true);
    });
    el.addEventListener('change', function (e) {
      if (!e.target.matches('[data-size]')) return;
      S[PAGE_KEYS[name][1]] = parseInt(e.target.value, 10);
      S[PAGE_KEYS[name][0]] = 1;
      writeHash(); reload(true, true);
    });
  }
  function wireTable(name, onRow, onSort) {
    var wrap = $('#' + name + '-body');
    wrap.addEventListener('click', function (e) {
      var sb = e.target.closest('button.sort');
      if (sb) return onSort(sb.getAttribute('data-sort'));
      var tr = e.target.closest('tr.clickable');
      if (tr) onRow(tr);
    });
    wrap.addEventListener('keydown', function (e) {
      if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('tr.clickable')) { e.preventDefault(); onRow(e.target); }
    });
  }
  function showTable(name, html, d) {
    var wrap = $('#' + name + '-body'), pager = $('#' + name + '-pager');
    wrap.innerHTML = html; wrap.dataset.state = 'ready';
    pager.hidden = false; pager.innerHTML = pagerHtml(d.page, d.size, d.total);
    $('#' + name + '-count').textContent = fmtInt(d.total) + ' total';
  }
  function tableEmpty(name, msg) {
    setEmpty($('#' + name + '-body'), msg);
    $('#' + name + '-pager').hidden = true; $('#' + name + '-count').textContent = '';
  }
  function tableFail(name) { $('#' + name + '-pager').hidden = true; }
  var PARTIAL_TIP = 'Output and thinking tokens may be under-counted: Claude Code logged only the stream-start usage for this request.';

  var RCOLS = [
    { id: 'time', label: 'Time', sort: 'time', render: function (r) { return fmtTime(r.ts); } },
    { id: 'model', label: 'Model', render: function (r) { return modelPill(r.model); } },
    { id: 'effort', label: 'Effort', render: function (r) { return effortBadge(r.effort) + (r.speed && r.speed !== 'standard' ? ' <span class="chip">' + esc(r.speed) + '</span>' : ''); } },
    { id: 'type', label: 'Type', render: kindChip },
    { id: 'project', label: 'Project', cls: 'ellipsis', render: function (r) { return esc(projLabel(r.project)); }, tip: function (r) { return r.project || ''; } },
    { id: 'prompt', label: 'Prompt', cls: 'ellipsis', render: function (r) { return r.prompt ? esc(r.prompt) : '<span class="muted">—</span>'; }, tip: function (r) { return r.prompt || ''; } },
    { id: 'tokens', label: 'Tokens', sort: 'tokens', num: true, render: function (r) { return '<span class="tok-main">' + fmtTok(r.tokens) + '</span><span class="sub"><span class="in">↓' + fmtTok(r.input) + '</span> ↑' + fmtTok(r.output) + (r.usagePartial ? ' <span class="info" title="' + esc(PARTIAL_TIP) + '">ⓘ</span>' : '') + '</span>'; }, tip: function (r) { return 'input ' + fmtInt(r.input) + ' · output ' + fmtInt(r.output) + ' · total ' + fmtInt(r.tokens); } },
    { id: 'cache', label: 'Cache R / W', num: true, title: 'Cache read / cache write tokens', render: function (r) { return fmtTok(r.cacheRead) + '<span class="sub">W ' + fmtTok(r.cacheWrite) + '</span>'; }, tip: function (r) { return 'cache read ' + fmtInt(r.cacheRead) + ' · cache write ' + fmtInt(r.cacheWrite); } },
    { id: 'thinking', label: 'Thinking', num: true, render: function (r) { return r.thinking ? fmtTok(r.thinking) : '<span class="muted">—</span>'; } },
    { id: 'cost', label: 'Cost', sort: 'cost', num: true, title: 'API-equivalent cost', render: function (r) { return r.cost == null ? '<span class="muted" title="No price for this model">unpriced</span>' : '<span class="cost">' + fmtCost(r.cost) + '</span>'; } },
    { id: 'latency', label: 'Response time', sort: 'latency', num: true, title: 'Time from the previous event to the end of the reply (excludes tool run time)', render: function (r) { return fmtDur(r.latencyMs); } },
    { id: 'tools', label: 'Tools', cls: 'ellipsis', render: function (r) { return r.tools && r.tools.length ? '<span class="chips">' + r.tools.slice(0, 3).map(function (t) { return '<span class="chip">' + esc(trunc(toolLabel(t), 22)) + '</span>'; }).join('') + (r.tools.length > 3 ? '<span class="chip">+' + (r.tools.length - 3) + '</span>' : '') + '</span>' : '<span class="muted">—</span>'; }, tip: function (r) { return (r.tools || []).join(', '); } },
    { id: 'stop', label: 'Stop', render: function (r) { return r.stopReason ? '<span class="chip">' + esc(r.stopReason) + '</span>' : '<span class="muted">—</span>'; } }
  ];
  var hiddenCols = {};
  try { hiddenCols = JSON.parse(lsGet('ccu.hiddenCols') || '{}') || {}; } catch (e) { hiddenCols = {}; }
  if (lsGet('ccu.hiddenCols') == null) hiddenCols = { project: true };
  function renderRequests(d) {
    if (!d.rows.length) return tableEmpty('requests', 'No requests match the current filters');
    var cols = RCOLS.filter(function (c) { return !hiddenCols[c.id]; });
    if (!cols.length) cols = [RCOLS[0]];
    showTable('requests', '<table class="t">' + theadHtml(cols, S.rsort, S.rdir) + tbodyHtml(cols, d.rows, function (r) { return 'data-key="' + esc(r.key) + '"'; }) + '</table>', d);
  }
  var reqLast = null;
  function loadRequests(silent, force) {
    var body = $('#requests-body');
    return loadPanel('rq', body, '/api/requests?' + fparams({ sort: S.rsort, dir: S.rdir, page: S.rpage, size: S.rsize }), function (d) {
      reqLast = d;
      if (S.rpage > 1 && !d.rows.length && d.total) { S.rpage = 1; writeHash(); return loadRequests(true, true); }
      renderRequests(d);
      if (force) body.scrollTop = 0;
    }, { silent: silent, force: force }).then(function (r) { if (!r && G.rq && G.rq.state === 'error') tableFail('requests'); return r; });
  }
  function buildColPop() {
    $('#col-pop').innerHTML = RCOLS.map(function (c) {
      return '<label><input type="checkbox" data-col="' + c.id + '"' + (hiddenCols[c.id] ? '' : ' checked') + '> ' + esc(c.label) + '</label>';
    }).join('') + '<div class="pop-foot"><button type="button" class="btn sm" id="col-reset">Reset columns</button></div>';
  }
  function setupColPop() {
    var btn = $('#col-btn'), pop = $('#col-pop');
    buildColPop();
    function close() { pop.classList.add('hidden'); btn.setAttribute('aria-expanded', 'false'); }
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      var open = pop.classList.contains('hidden');
      pop.classList.toggle('hidden', !open);
      btn.setAttribute('aria-expanded', String(open));
      if (open) { var f = pop.querySelector('input'); if (f) f.focus(); }
    });
    pop.addEventListener('click', function (e) {
      e.stopPropagation();
      if (e.target.id === 'col-reset') {
        hiddenCols = { project: true }; lsSet('ccu.hiddenCols', JSON.stringify(hiddenCols));
        buildColPop(); if (reqLast) renderRequests(reqLast);
      }
    });
    pop.addEventListener('change', function (e) {
      var c = e.target.getAttribute('data-col');
      if (!c) return;
      if (e.target.checked) delete hiddenCols[c]; else hiddenCols[c] = true;
      if (Object.keys(hiddenCols).length >= RCOLS.length) { delete hiddenCols[c]; e.target.checked = true; }
      lsSet('ccu.hiddenCols', JSON.stringify(hiddenCols));
      if (reqLast) renderRequests(reqLast);
    });
    document.addEventListener('click', close);
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !pop.classList.contains('hidden')) { close(); btn.focus(); e.stopPropagation(); } }, true);
  }

  var PCOLS = [
    { id: 'time', label: 'Time', sort: 'time', render: function (r) { return fmtTime(r.ts); } },
    { id: 'text', label: 'Prompt', cls: 'wrap', render: function (r) { return '<div class="clamp2">' + esc(r.text || '(empty)') + '</div>' + (r.images ? '<span class="chip">' + r.images + ' image' + (r.images > 1 ? 's' : '') + '</span>' : ''); } },
    { id: 'models', label: 'Models', render: function (r) { return (r.models || []).map(modelPill).join('<br>') || '<span class="muted">—</span>'; } },
    { id: 'requests', label: 'Requests', num: true, render: function (r) { return fmtInt(r.requests); } },
    { id: 'sub', label: 'Subagent req.', num: true, render: function (r) { return r.subagentRequests ? fmtInt(r.subagentRequests) : '<span class="muted">0</span>'; } },
    { id: 'tokens', label: 'Tokens', sort: 'tokens', num: true, render: function (r) { return '<span class="tok-main">' + fmtTok(r.tokens) + '</span><span class="sub">↑' + fmtTok(r.output) + ' out</span>'; } },
    { id: 'cost', label: 'Cost', sort: 'cost', num: true, title: 'API-equivalent cost', render: function (r) { return '<span class="cost">' + fmtCost(r.cost) + '</span>'; } },
    { id: 'dur', label: 'Turn duration', num: true, title: 'Wall-clock time from your prompt to the last reply', render: function (r) { return r.durationMs ? fmtDur(r.durationMs) : '<span class="muted">—</span>'; } }
  ];
  function loadPrompts(silent, force) {
    var body = $('#prompts-body');
    return loadPanel('pp', body, '/api/prompts?' + fparams({ sort: S.psort, dir: S.pdir, page: S.ppage, size: S.psize }), function (d) {
      if (S.ppage > 1 && !d.rows.length && d.total) { S.ppage = 1; writeHash(); return loadPrompts(true, true); }
      if (!d.rows.length) return tableEmpty('prompts', 'No prompts match the current filters');
      showTable('prompts', '<table class="t">' + theadHtml(PCOLS, S.psort, S.pdir) + tbodyHtml(PCOLS, d.rows, function (r) { return 'data-id="' + esc(r.id) + '"'; }) + '</table>', d);
      if (force) body.scrollTop = 0;
    }, { silent: silent, force: force }).then(function (r) { if (!r && G.pp && G.pp.state === 'error') tableFail('prompts'); return r; });
  }

  var sessData = null;
  var SCOLS = [
    { id: 'title', label: 'Session', sort: 'title', cls: 'wrap', render: function (r) { return '<div class="clamp2">' + esc(r.title || r.id.slice(0, 8)) + '</div><span class="sub mono">' + esc(r.id.slice(0, 8)) + '</span>'; } },
    { id: 'project', label: 'Project', sort: 'project', cls: 'ellipsis', render: function (r) { return esc(projLabel(r.project)); }, tip: function (r) { return r.project || ''; } },
    { id: 'first', label: 'Start', sort: 'first', render: function (r) { return fmtTime(r.first); } },
    { id: 'last', label: 'Last activity', sort: 'last', render: function (r) { return fmtTime(r.last) + '<span class="sub">' + ago(Date.now() - r.last) + '</span>'; } },
    { id: 'prompts', label: 'Prompts', sort: 'prompts', num: true, render: function (r) { return fmtInt(r.prompts); } },
    { id: 'requests', label: 'Requests', sort: 'requests', num: true, render: function (r) { return fmtInt(r.requests); } },
    { id: 'tokens', label: 'Tokens', sort: 'tokens', num: true, render: function (r) { return '<span class="tok-main">' + fmtTok(r.tokens) + '</span>'; } },
    { id: 'cost', label: 'Cost', sort: 'cost', num: true, title: 'API-equivalent cost', render: function (r) { return '<span class="cost">' + fmtCost(r.cost) + '</span>'; } }
  ];
  function renderSessions() {
    var list = sessData || [];
    if (!list.length) return tableEmpty('sessions', 'No sessions match the current filters');
    var k = S.ssort, dir = S.sdir === 'asc' ? 1 : -1;
    var sorted = list.slice().sort(function (a, b) {
      var x = a[k], y = b[k];
      if (k === 'title') { x = (a.title || '').toLowerCase(); y = (b.title || '').toLowerCase(); }
      if (k === 'project') { x = projLabel(a.project).toLowerCase(); y = projLabel(b.project).toLowerCase(); }
      return (x < y ? -1 : x > y ? 1 : 0) * dir;
    });
    var pages = Math.max(1, Math.ceil(sorted.length / S.ssize));
    if (S.spage > pages) S.spage = pages;
    var rows = sorted.slice((S.spage - 1) * S.ssize, S.spage * S.ssize);
    showTable('sessions', '<table class="t">' + theadHtml(SCOLS, S.ssort, S.sdir) + tbodyHtml(SCOLS, rows, function (r) { return 'data-id="' + esc(r.id) + '"'; }) + '</table>', { page: S.spage, size: S.ssize, total: sorted.length });
  }
  function loadSessions(silent, force) {
    var body = $('#sessions-body');
    return loadPanel('sess', body, '/api/sessions?' + fparams(), function (d) {
      sessData = d; renderSessions();
      if (force) body.scrollTop = 0;
    }, { silent: silent, force: force }).then(function (r) { if (!r && G.sess && G.sess.state === 'error') tableFail('sessions'); return r; });
  }

  /* ================================================================== drawer */
  var drawer = $('#drawer'), dBody = $('#drawer-body'), dBack = $('#drawer-back'), dTitle = $('#drawer-title');
  var dStack = [], dOpen = false, dPrevFocus = null, dToken = 0;
  function focusables() {
    return $$('button:not([disabled]), a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])', drawer).filter(function (e) { return e.offsetParent !== null || e === document.activeElement; });
  }
  function openDrawer() {
    if (dOpen) return;
    dOpen = true; dPrevFocus = document.activeElement;
    drawer.setAttribute('aria-hidden', 'false'); drawer.classList.add('open');
    $('#drawer-backdrop').classList.add('open');
    setTimeout(function () { $('#drawer-close').focus(); }, 30);
  }
  function closeDrawer() {
    if (!dOpen) return;
    dOpen = false; dStack = []; dToken++;
    drawer.classList.remove('open'); drawer.setAttribute('aria-hidden', 'true');
    $('#drawer-backdrop').classList.remove('open');
    if (dPrevFocus && document.contains(dPrevFocus) && dPrevFocus.focus) dPrevFocus.focus();
  }
  document.addEventListener('keydown', function (e) {
    if (!dOpen) return;
    if (e.key === 'Escape') { e.preventDefault(); closeDrawer(); return; }
    if (e.key === 'Tab') {
      var f = focusables();
      if (!f.length) { e.preventDefault(); return; }
      var first = f[0], last = f[f.length - 1];
      if (!drawer.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
      else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });
  $('#drawer-close').addEventListener('click', closeDrawer);
  $('#drawer-backdrop').addEventListener('click', closeDrawer);
  dBack.addEventListener('click', function () {
    dStack.pop();
    var prev = dStack.pop();
    if (prev) { if (prev.type === 'prompt') openPrompt(prev.id); else openRequest(prev.id); } else closeDrawer();
  });
  function setDrawerHead(title) { dTitle.textContent = title; dBack.classList.toggle('hidden', dStack.length < 2); }
  function stat(l, v, title) { return '<div class="stat"' + (title ? ' title="' + esc(title) + '"' : '') + '><div class="l">' + esc(l) + '</div><div class="v">' + v + '</div></div>'; }

  async function openPrompt(id) {
    var tok = ++dToken;
    openDrawer();
    dStack = dStack.filter(function (v) { return !(v.type === 'prompt' && v.id === id); });
    dStack.push({ type: 'prompt', id: id });
    setDrawerHead('Prompt');
    setLoading(dBody, 8);
    try {
      var res = await getJson('/api/prompt?id=' + encodeURIComponent(id));
      if (tok !== dToken) return;
      var d = res.data, p = d.prompt, t = d.totals, reqs = d.requests || [];
      var ts = p ? p.ts : (reqs[0] && reqs[0].ts);
      var lastTs = reqs.length ? reqs[reqs.length - 1].ts : ts;
      var subs = reqs.filter(function (r) { return r.sidechain; }).length;
      var partial = reqs.filter(function (r) { return r.usagePartial; }).length;
      setDrawerHead('Prompt · ' + fmtTime(ts));
      var h = '<div class="d-sec"><dl class="kv"><dt>Time</dt><dd>' + esc(fmtTime(ts)) + '</dd>' +
        '<dt>Session</dt><dd>' + esc(d.sessionTitle || (p && p.sessionId) || '—') + (p && p.sessionId ? ' <span class="muted mono">' + esc(p.sessionId.slice(0, 8)) + '</span>' : '') + '</dd>' +
        '<dt>Project</dt><dd title="' + esc(p ? p.project : '') + '">' + esc(p ? (p.project || '—') : '—') + '</dd>' +
        (p && p.origin ? '<dt>Origin</dt><dd>' + esc(p.origin) + '</dd>' : '') +
        (p && p.images ? '<dt>Images</dt><dd>' + esc(p.images) + '</dd>' : '') + '</dl></div>';
      h += '<div class="d-sec"><h3>Totals · API-equivalent, not billed</h3><div class="stat-grid">' +
        stat('Requests', fmtInt(t.requests)) + stat('Subagent requests', fmtInt(subs)) + stat('Total tokens', fmtTok(t.tokens), fmtInt(t.tokens)) + stat('API-equiv. cost', fmtCost(t.cost)) +
        stat('Input', fmtTok(t.input), fmtInt(t.input)) + stat('Output', fmtTok(t.output), fmtInt(t.output)) + stat('Cache write', fmtTok(t.cacheWrite), fmtInt(t.cacheWrite)) + stat('Cache read', fmtTok(t.cacheRead), fmtInt(t.cacheRead)) +
        stat('Thinking', fmtTok(t.thinking), fmtInt(t.thinking)) + stat('Turn duration', fmtDur(Math.max(0, lastTs - ts)), 'Wall-clock time from your prompt to the last reply') + '</div>' +
        (t.unpriced ? '<p class="warn-note" style="margin-top:6px">' + fmtInt(t.unpriced) + ' request(s) have no price for their model and are counted as $0.</p>' : '') +
        (partial ? '<p class="muted" style="margin-top:8px;font-size:12px"><span class="info">ⓘ</span> ' + fmtInt(partial) + ' request' + (partial === 1 ? '' : 's') + ' in this prompt ha' + (partial === 1 ? 's' : 've') + ' incomplete output counts in Claude Code\'s logs; output and thinking may be under-counted.</p>' : '') + '</div>';
      h += '<div class="d-sec"><h3>Prompt</h3>' + (p ? '<div class="pre">' + esc(p.text) + '</div>' : '<p class="muted">Prompt text was not captured.</p>') + '</div>';
      if (p && p.queued && p.queued.length) {
        h += '<div class="d-sec"><h3>Follow-up messages sent while it ran (' + p.queued.length + ')</h3>' + p.queued.map(function (q) { return '<div class="pre" style="margin-bottom:6px;max-height:140px">' + esc(q) + '</div>'; }).join('') + '</div>';
      }
      h += '<div class="d-sec"><h3>Requests (' + reqs.length + ')</h3>' + (reqs.length ? reqs.map(function (r, i) {
        return '<button type="button" class="req-item" data-req="' + esc(r.key) + '"><span class="n">' + (i + 1) + '</span><div style="min-width:0"><div class="t1">' + modelPill(r.model) + kindChip(r) + effortBadge(r.effort) +
          '<span class="muted">' + esc(fmtTime(r.ts)) + (ts ? ' · +' + fmtDur(Math.max(0, r.ts - ts)) : '') + '</span></div>' +
          '<div class="t2">↓' + fmtTok(r.input) + ' ↑' + fmtTok(r.output) + (r.usagePartial ? ' ⓘ' : '') + ' · cache R ' + fmtTok(r.cacheRead) + ' W ' + fmtTok(r.cacheWrite) + (r.thinking ? ' · think ' + fmtTok(r.thinking) : '') + ' · ' + fmtDur(r.latencyMs) + (r.tools && r.tools.length ? ' · ' + esc(trunc(r.tools.map(toolLabel).join(', '), 70)) : '') + (r.stopReason ? ' · ' + esc(r.stopReason) : '') + '</div></div>' +
          '<div class="r"><div class="cost">' + (r.cost == null ? 'unpriced' : fmtCost(r.cost)) + '</div><div class="muted" style="font-size:11.5px">' + fmtTok(r.tokens) + ' tok</div></div></button>';
      }).join('') : '<p class="muted">No requests recorded for this prompt.</p>') + '</div>';
      dBody.innerHTML = h; dBody.dataset.state = 'ready'; dBody.scrollTop = 0;
    } catch (e) {
      if (tok !== dToken) return;
      setError(dBody, 'Could not load prompt: ' + (e.message || e), function () { openPrompt(id); });
    }
  }
  async function openRequest(key) {
    var tok = ++dToken;
    openDrawer();
    dStack = dStack.filter(function (v) { return !(v.type === 'request' && v.id === key); });
    dStack.push({ type: 'request', id: key });
    setDrawerHead('Request');
    setLoading(dBody, 8);
    try {
      var res = await getJson('/api/request?key=' + encodeURIComponent(key));
      if (tok !== dToken) return;
      var r = res.data, c = r.cost;
      setDrawerHead('Request · ' + modelShort(r.model));
      var w5 = num(r.cacheWrite5m), w1 = num(r.cacheWrite1h), cw = c ? num(c.cacheWrite) : 0, wt = w5 * 1.25 + w1 * 2;
      var cw5 = c && wt ? cw * (w5 * 1.25) / wt : 0, cw1 = c && wt ? cw * (w1 * 2) / wt : 0;
      var rows = [
        { n: 'Input', tok: r.input, cost: c && c.input, col: 'var(--series-1)' },
        { n: 'Cache write (5 min)', tok: w5, cost: c && cw5, col: 'var(--series-4)' },
        { n: 'Cache write (1 h)', tok: w1, cost: c && cw1, col: 'var(--series-4)' },
        { n: 'Cache read', tok: r.cacheRead, cost: c && c.cacheRead, col: 'var(--series-3)' },
        { n: 'Output', tok: r.output, cost: c && c.output, col: 'var(--series-2)', note: r.thinking ? 'incl. ' + fmtInt(r.thinking) + ' thinking' : '' }
      ];
      var tot = c ? num(c.total) : 0;
      var bar = c && tot > 0 ? '<div class="stack-bar" aria-hidden="true">' + rows.filter(function (x) { return num(x.cost) > 0; }).map(function (x) { return '<b style="width:' + (num(x.cost) / tot * 100).toFixed(2) + '%;background:' + x.col + '" title="' + esc(x.n) + '"></b>'; }).join('') + '</div>' : '';
      var tb = '<table class="t mini"><thead><tr><th></th><th>Category</th><th class="num">Tokens</th><th class="num">API-equiv. cost</th><th class="num">Share</th></tr></thead><tbody>' + rows.map(function (x) {
        return '<tr><td><span class="sw" style="background:' + x.col + '"></span></td><td>' + esc(x.n) + (x.note ? ' <span class="muted">(' + esc(x.note) + ')</span>' : '') + '</td><td class="num">' + fmtInt(x.tok) + '</td><td class="num">' + (c ? fmtCost(x.cost) : '—') + '</td><td class="num">' + (c && tot ? (num(x.cost) / tot * 100).toFixed(1) + '%' : '—') + '</td></tr>';
      }).join('') + '<tr><td></td><td><b>Total</b></td><td class="num"><b>' + fmtInt(r.tokens) + '</b></td><td class="num cost">' + (c ? fmtCost(tot) : 'unpriced') + '</td><td></td></tr></tbody></table>';
      var kv = [
        ['Time', fmtTime(r.ts)], ['Model', r.model], ['Requested model', r.requestedModel && r.requestedModel !== r.model ? r.requestedModel + '  (served by ' + r.model + ')' : (r.requestedModel || '—')],
        ['Effort', r.effort || '—'], ['Speed', r.speed || '—'], ['Service tier', r.serviceTier || '—'],
        ['Type', r.sidechain ? 'Subagent' + (r.agentType ? ': ' + r.agentType : '') + (r.agentDesc ? ' — ' + r.agentDesc : '') : 'Main'],
        ['Claude Code version', r.version || '—'], ['Entrypoint', r.entrypoint || '—'], ['Git branch', r.gitBranch || '—'],
        ['Response time', r.latencyMs == null ? '—' : fmtDur(r.latencyMs) + ' (' + fmtInt(r.latencyMs) + ' ms)'], ['Stop reason', r.stopReason || '—'],
        ['Project', r.project || '—'], ['Session', ((r.sessionTitle || '') + (r.sessionId ? '  ' + r.sessionId.slice(0, 8) : '')) || '—'], ['Request key', r.key]
      ];
      if (r.sys) kv.push(['Trigger', r.sys]);
      if (r.webSearch) kv.push(['Web searches', r.webSearch]);
      if (r.webFetch) kv.push(['Web fetches', r.webFetch]);
      var h = '<div class="d-sec"><h3>Token &amp; cost breakdown · API-equivalent, not billed</h3>' + bar + tb +
        (r.usagePartial ? '<p class="muted" style="margin-top:8px;font-size:12px"><span class="info">ⓘ</span> Claude Code logged only the stream-start usage for this request, so output and thinking tokens (and their cost) may be under-counted.</p>' : '') + '</div>';
      h += '<div class="d-sec"><h3>Details</h3><dl class="kv">' + kv.map(function (p) { return '<dt>' + esc(p[0]) + '</dt><dd' + (p[0] === 'Request key' || p[0] === 'Project' ? ' class="mono" style="font-size:12px"' : '') + '>' + esc(p[1]) + '</dd>'; }).join('') + '</dl></div>';
      h += '<div class="d-sec"><h3>Tools (' + (r.tools ? r.tools.length : 0) + ')</h3>' + (r.tools && r.tools.length ? '<div class="chips" style="flex-wrap:wrap">' + r.tools.map(function (t) { return '<span class="chip" title="' + esc(t) + '">' + esc(toolLabel(t)) + '</span>'; }).join('') + '</div>' : '<p class="muted">No tool calls in this request.</p>') + '</div>';
      h += '<div class="d-sec"><h3>Response preview</h3>' + (r.response ? '<div class="pre">' + esc(r.response) + '</div>' : '<p class="muted">No text in the response (tool call or thinking only).</p>') + '</div>';
      h += '<div class="d-sec"><h3>Prompt' + (r.promptId ? ' · <button type="button" class="link-btn" data-prompt="' + esc(r.promptId) + '" style="text-transform:none;letter-spacing:0">open prompt &amp; all its requests</button>' : '') + '</h3>' + (r.promptText ? '<div class="pre">' + esc(r.promptText) + '</div>' : '<p class="muted">Prompt text was not captured.</p>') + '</div>';
      dBody.innerHTML = h; dBody.dataset.state = 'ready'; dBody.scrollTop = 0;
    } catch (e) {
      if (tok !== dToken) return;
      setError(dBody, 'Could not load request: ' + (e.message || e), function () { openRequest(key); });
    }
  }
  document.addEventListener('click', function (e) {
    var p = e.target.closest && e.target.closest('[data-prompt]');
    if (p) { e.preventDefault(); return openPrompt(p.getAttribute('data-prompt')); }
    var r = e.target.closest && e.target.closest('[data-req]');
    if (r) { e.preventDefault(); return openRequest(r.getAttribute('data-req')); }
    var g = e.target.closest && e.target.closest('[data-goto]');
    if (g) goSection(g.getAttribute('data-goto'));
  });

  /* ================================================================== live indicator */
  var liveMode = null, liveInfo = { active: false, lastTs: 0, known: false };
  async function pollLive() {
    try {
      var live = null;
      if (liveMode !== 'derived') {
        try {
          var r = await fetch('/api/live', { cache: 'no-store' });
          if (r.ok) { live = await r.json(); liveMode = 'api'; } else liveMode = 'derived';
        } catch (e) { /* network error */ }
      }
      try { statusInfo = (await getJson('/api/status')).data; } catch (e) { /* ignore */ }
      if (live && typeof live === 'object') {
        liveInfo = { active: !!live.active, lastTs: live.lastTs || (live.recent && live.recent[0] && live.recent[0].ts) || 0, known: true };
      } else {
        var lr = (await getJson('/api/requests?sort=time&size=5')).data;
        var ts = lr.rows && lr.rows[0] ? lr.rows[0].ts : 0;
        liveInfo = { active: !!ts && Date.now() - ts < 120000, lastTs: ts, known: true };
      }
      lastOk = Date.now(); offline = false;
    } catch (e) { offline = true; }
    updateLive();
    if (statusInfo && statusInfo.startDate) {
      var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(statusInfo.startDate);
      if (m) $('#subtitle').textContent = 'Every prompt, token and API-equivalent dollar since ' + parseInt(m[3], 10) + ' ' + MON[parseInt(m[2], 10) - 1] + ' ' + m[1] + ' · this machine';
    }
    if (statusInfo) {
      $('#pricing-note').textContent = COST_FOOT + ' ' + fmtInt(statusInfo.requests) + ' requests and ' + fmtInt(statusInfo.prompts) + ' prompts indexed from ' + fmtInt(statusInfo.filesTracked) + ' transcript files.';
      sched();
    }
  }
  function updateLive() {
    var el = $('#live'), st = $('#live-state'), up = $('#live-updated'), hero = $('#hero-live');
    var state, txt, tag, t, d;
    var updated = lastOk ? 'updated ' + ago(Date.now() - lastOk) : 'updated —';
    if (offline) { state = 'error'; txt = 'Server unreachable'; tag = 'OFFLINE'; t = 'Server unreachable'; d = 'Retrying every 10 s'; }
    else if (statusInfo && statusInfo.lastError) { state = 'error'; txt = 'Scan error'; tag = 'ERROR'; t = 'Transcript scan error'; d = String(statusInfo.lastError); }
    else if (!liveInfo.known) { state = 'idle'; txt = 'Connecting…'; tag = 'LIVE'; t = 'Connecting…'; d = 'Auto-refreshing every 10 s'; }
    else if (liveInfo.active) { state = 'active'; txt = 'Live · active now'; tag = 'LIVE'; t = 'Claude Code is active right now'; d = 'Last request ' + ago(Date.now() - liveInfo.lastTs) + ' · ' + updated; }
    else { state = 'idle'; txt = liveInfo.lastTs ? 'Idle · last request ' + ago(Date.now() - liveInfo.lastTs) : 'Idle · no requests yet'; tag = 'IDLE'; t = liveInfo.lastTs ? 'Last request ' + ago(Date.now() - liveInfo.lastTs) : 'No requests yet'; d = 'Auto-refreshing every 10 s · ' + updated; }
    if (S.view === 'live' && window.CCULive && window.CCULive.status) { var ls = window.CCULive.status(); state = ls.state; txt = ls.text; }
    el.setAttribute('data-state', state); hero.setAttribute('data-state', state);
    if (S.view !== 'live') $('#view-live-btn').setAttribute('data-state', state === 'error' ? 'error' : state);
    if (st.textContent !== txt) st.textContent = txt;
    up.textContent = '· ' + updated;
    $('#hl-tag-t').textContent = tag; $('#hl-t').textContent = t; $('#hl-d').textContent = d;
  }

  /* ================================================================== options + filters */
  var optSig = '';
  function fillSelect(sel, items, allLabel, cur) {
    var list = items.slice();
    if (cur && !list.some(function (i) { return i.v === cur; })) list.unshift({ v: cur, t: cur });
    sel.innerHTML = '<option value="">' + esc(allLabel) + '</option>' + list.map(function (i) { return '<option value="' + esc(i.v) + '"' + (i.v === cur ? ' selected' : '') + '>' + esc(i.t) + '</option>'; }).join('');
    sel.value = cur || '';
  }
  async function loadOptions() {
    try {
      var res = await getJson('/api/options');
      var sig = res.text + '|' + S.model + S.project + S.session;
      if (sig === optSig) return;
      optSig = sig;
      var o = res.data;
      buildProjLabels(o.projects);
      (o.models || []).forEach(modelSlot);
      fillSelect($('#f-model'), (o.models || []).map(function (m) { return { v: m, t: m }; }), 'All models', S.model);
      fillSelect($('#f-project'), (o.projects || []).map(function (p) { return { v: p, t: projLabel(p) }; }), 'All projects', S.project);
      fillSelect($('#f-session'), (o.sessions || []).map(function (s) { return { v: s.id, t: trunc(s.title || s.id, 46) }; }), 'All sessions', S.session);
      paintSig = {}; sched();
    } catch (e) { /* non-fatal */ }
  }
  function syncUi() {
    $$('#seg-range button').forEach(function (b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-v') === S.range)); });
    $$('[data-cgran] button').forEach(function (b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-v') === S.gran)); });
    $$('[data-cmetric] button').forEach(function (b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-v') === S.metric)); });
    $('#f-kind').value = S.kind;
    if ($('#f-q') !== document.activeElement) $('#f-q').value = S.q;
    ['model', 'project', 'session'].forEach(function (k) {
      var sel = $('#f-' + k);
      if (S[k] && !$$('option', sel).some(function (o) { return o.value === S[k]; })) { var o = document.createElement('option'); o.value = S[k]; o.textContent = S[k]; sel.appendChild(o); }
      sel.value = S[k];
    });
    $('#export-btn').setAttribute('href', '/api/export.csv?' + fparams().toString());
  }
  function filtersChanged() {
    S.rpage = 1; S.ppage = 1; S.spage = 1;
    writeHash(); syncUi();
    cache = {}; paintSig = {};
    refresh(false);
  }

  /* ================================================================== refresh orchestration */
  var refreshing = false, refreshAgain = null;
  function midnight() { var d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); }
  async function refresh(silent, force) {
    if (refreshing) { refreshAgain = { silent: silent && (refreshAgain ? refreshAgain.silent : true), force: force }; return; }
    refreshing = true;
    var spin = $('#refresh-btn'); spin.classList.add('spin');
    var t0 = Date.now();
    try {
      await Promise.all([
        loadPanel('s', null, '/api/summary?' + fparams(S.gran !== 'auto' ? { gran: S.gran } : null).toString(), function (d) { D.s = d; }, { silent: silent, force: force }),
        loadPanel('p', null, '/api/prompts?' + fparams({ sort: 'cost', size: 200 }).toString(), function (d) { D.p = d; }, { silent: silent, force: force }),
        loadPanel('pt', null, '/api/prompts?' + fparams({ sort: 'tokens', size: 12 }).toString(), function (d) { D.pt = d; }, { silent: silent, force: force }),
        loadPanel('today', null, '/api/prompts?' + fparams({ sort: 'cost', size: 1, from: midnight() }, true).toString(), function (d) { D.today = d; }, { silent: silent, force: force }),
        loadSessions(silent, force), loadPrompts(silent, force), loadRequests(silent, force),
        pollLive(), loadOptions()
      ]);
    } finally {
      refreshing = false;
      setTimeout(function () { spin.classList.remove('spin'); }, Math.max(0, 500 - (Date.now() - t0)));
      updateLive(); syncUi(); sched();
      if (refreshAgain) { var a = refreshAgain; refreshAgain = null; refresh(a.silent, a.force); }
    }
  }

  /* ================================================================== wiring */
  function init() {
    readHash();
    applyView();
    buildKpis();
    buildCards();
    wireCards();
    setupColPop();

    $('#seg-range').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-v]');
      if (!b) return;
      S.range = b.getAttribute('data-v');
      filtersChanged();
    });
    [['model', 'f-model'], ['project', 'f-project'], ['session', 'f-session'], ['kind', 'f-kind']].forEach(function (p) {
      $('#' + p[1]).addEventListener('change', function (e) { S[p[0]] = e.target.value; filtersChanged(); });
    });
    var qt = null;
    $('#f-q').addEventListener('input', function (e) {
      clearTimeout(qt);
      var v = e.target.value;
      qt = setTimeout(function () { S.q = v.trim(); filtersChanged(); }, 320);
    });
    $('#f-q').addEventListener('keydown', function (e) { if (e.key === 'Escape') { e.target.value = ''; S.q = ''; filtersChanged(); e.target.blur(); } });
    $('#reset-btn').addEventListener('click', function () {
      ['range', 'gran', 'model', 'project', 'session', 'kind', 'q'].forEach(function (k) { S[k] = DEF[k]; });
      $('#f-q').value = '';
      filtersChanged();
    });
    $('#refresh-btn').addEventListener('click', function () { refresh(true, true); });
    $('#theme-btn').addEventListener('click', function () {
      var t = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
      document.documentElement.setAttribute('data-theme', t);
      lsSet('ccu.theme', t);
    });
    $('#brand').addEventListener('click', function (e) { e.preventDefault(); if (S.view === 'live') setView(''); goSection('overview'); });
    $('#seg-view').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-view]');
      if (b) setView(b.getAttribute('data-view'));
    });
    $$('#index a').forEach(function (a) { a.addEventListener('click', function (e) { e.preventDefault(); goSection(a.getAttribute('data-sec')); }); });
    $$('[data-copy]').forEach(function (b) { b.addEventListener('click', function () { copyLink(b.getAttribute('data-copy')); }); });

    wireTable('requests', function (tr) { openRequest(tr.getAttribute('data-key')); }, function (k) {
      if (S.rsort === k) S.rdir = S.rdir === 'asc' ? 'desc' : 'asc'; else { S.rsort = k; S.rdir = 'desc'; }
      S.rpage = 1; writeHash(); loadRequests(true, true);
    });
    wireTable('prompts', function (tr) { openPrompt(tr.getAttribute('data-id')); }, function (k) {
      if (S.psort === k) S.pdir = S.pdir === 'asc' ? 'desc' : 'asc'; else { S.psort = k; S.pdir = 'desc'; }
      S.ppage = 1; writeHash(); loadPrompts(true, true);
    });
    wireTable('sessions', function (tr) { S.session = tr.getAttribute('data-id'); filtersChanged(); goSection('prompts'); }, function (k) {
      if (S.ssort === k) S.sdir = S.sdir === 'asc' ? 'desc' : 'asc'; else { S.ssort = k; S.sdir = (k === 'title' || k === 'project') ? 'asc' : 'desc'; }
      S.spage = 1; writeHash(); renderSessions();
    });
    wirePager('requests', function (s, f) { return loadRequests(s, f); });
    wirePager('prompts', function (s, f) { return loadPrompts(s, f); });
    wirePager('sessions', function () { renderSessions(); $('#sessions-body').scrollTop = 0; });

    document.addEventListener('keydown', function (e) {
      if (e.key === '/' && !e.ctrlKey && !e.metaKey && !/^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName) && !dOpen) {
        e.preventDefault(); $('#f-q').focus(); $('#f-q').select();
      }
    });
    window.addEventListener('hashchange', function () {
      var before = JSON.stringify(S), prevView = S.view;
      readHash();
      if (S.view !== prevView) applyView();
      var so = JSON.parse(before); so.view = S.view;
      if (JSON.stringify(S) === JSON.stringify(so)) return;
      syncUi(); cache = {}; paintSig = {};
      refresh(false);
      if (S.s && S.view !== 'live') goSection(S.s, true);
    });
    window.addEventListener('scroll', function () { if (!spyQueued) { spyQueued = true; requestAnimationFrame(spy); } }, { passive: true });
    window.addEventListener('resize', function () { if (!spyQueued) { spyQueued = true; requestAnimationFrame(spy); } });
    if ('ResizeObserver' in window) {
      new ResizeObserver(function () { document.documentElement.style.setProperty('--hh', $('#topbar').offsetHeight + 'px'); }).observe($('#topbar'));
    }
    document.documentElement.style.setProperty('--hh', $('#topbar').offsetHeight + 'px');

    observeReveal();
    syncUi();
    refresh(false).then(function () {
      observeReveal();
      if (S.s && S.view !== 'live') setTimeout(function () { goSection(S.s, true); }, 80);
      spy();
    });
    setInterval(function () { if (document.hidden) return; if (S.view === 'live') pollLive(); else refresh(true); }, 10000);
    setInterval(updateLive, 1000);
    document.addEventListener('visibilitychange', function () { if (!document.hidden && Date.now() - lastOk > 9000) refresh(true); });
  }

  init();
})();
