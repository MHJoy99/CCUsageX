/* CCUsageX — Live view (real-time mission control).
 * Transport: EventSource('/api/stream') with reconnect, falling back to polling /api/live/state every second.
 * Everything on screen is driven by real events; animation only interpolates between real values
 * (counters tween, bars slide with the clock, the "generating" timer is real elapsed time since the last event).
 * Loaded before app.js; app.js calls window.CCULive.setActive(true|false) when the Live view is shown / hidden.
 * No timers or animation frames survive deactivation. Honors prefers-reduced-motion (data stays live, motion drops). */
(function () {
  'use strict';

  /* ================================================================== helpers */
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ESC[c]; }); }
  function num(v) { v = Number(v); return isFinite(v) ? v : 0; }
  function pad2(n) { return n < 10 ? '0' + n : '' + n; }
  function trunc(s, n) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function scale(n, units) {
    var v = Math.abs(n), i = 0;
    while (v >= 1000 && i < units.length - 1) { v /= 1000; i++; }
    var s = i === 0 ? String(Math.round(v)) : (v < 10 ? v.toFixed(2) : v < 100 ? v.toFixed(1) : v.toFixed(0));
    if (i > 0 && parseFloat(s) >= 1000 && i < units.length - 1) { v /= 1000; i++; s = v.toFixed(2); }
    return (n < 0 ? '-' : '') + s + units[i];
  }
  function fmtTok(n) { return scale(num(n), ['', 'K', 'M', 'B', 'T']); }
  function fmtInt(n) { return Math.round(num(n)).toLocaleString('en-US'); }
  function fmtCost(c, d) {
    c = num(c);
    if (c === 0) return '$0';
    if (c < 0.0001) return '<$0.0001';
    if (c < 1) return '$' + c.toFixed(d == null ? 4 : d);
    return '$' + c.toLocaleString('en-US', { minimumFractionDigits: d == null ? 2 : d, maximumFractionDigits: d == null ? 2 : d });
  }
  function fmtSecs(ms) {            // live timers: 12.4 s, 1m 05s
    ms = Math.max(0, num(ms));
    if (ms < 60000) return (ms / 1000).toFixed(1) + ' s';
    var s = Math.floor(ms / 1000), m = Math.floor(s / 60);
    if (m < 60) return m + 'm ' + pad2(s % 60) + 's';
    return Math.floor(m / 60) + 'h ' + pad2(m % 60) + 'm';
  }
  function fmtDur(ms) {
    ms = num(ms);
    if (ms < 1000) return Math.round(ms) + ' ms';
    if (ms < 60000) return (ms / 1000).toFixed(1) + ' s';
    return fmtSecs(ms);
  }
  function ago(ms) {
    var s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    return Math.floor(s / 86400) + 'd ago';
  }
  function hms(ts) { var d = new Date(ts); return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds()); }
  function hm(ts) { var d = new Date(ts); return pad2(d.getHours()) + ':' + pad2(d.getMinutes()); }
  function baseName(p) { var parts = String(p || '').split(/[\\/]+/).filter(Boolean); return parts[parts.length - 1] || ''; }
  function modelShort(m) { return String(m || '').replace(/^claude-/, ''); }
  function easeOutBack(x) { var c1 = 1.70158, c3 = c1 + 1; x = clamp(x, 0, 1); return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2); }
  function easeOut(x) { x = clamp(x, 0, 1); return 1 - Math.pow(1 - x, 3); }

  var REDUCED = false, mqReduce = null;
  try {
    mqReduce = window.matchMedia('(prefers-reduced-motion: reduce)');
    REDUCED = mqReduce.matches;
  } catch (e) { /* ignore */ }

  var FONT = '"Segoe UI Variable Text","Segoe UI",system-ui,-apple-system,Roboto,Helvetica,Arial,sans-serif';
  var MONO = '"Cascadia Mono",Consolas,"Courier New",monospace';

  /* ================================================================== icons (24x24 strokes; shared by DOM + canvas) */
  var ICON = {
    bash: 'M4 6l6 6-6 6M12 18h8',
    read: 'M6 3h8l4 4v14H6zM14 3v4h4M9 12h6M9 16h6',
    edit: 'M4 20l1-4L16 5l3 3L8 19zM14 7l3 3',
    write: 'M6 3h8l4 4v14H6zM14 3v4h4M12 11v6M9 14h6',
    search: 'M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13zM15.5 15.5L21 21',
    folder: 'M3 7h6l2 2h10v10H3z',
    web: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3c3.2 3.2 3.2 14.8 0 18M12 3c-3.2 3.2-3.2 14.8 0 18',
    branch: 'M6 3v12M6 15a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9c0 5-12 2-12 6',
    plug: 'M9 3v6M15 3v6M7 9h10v4a5 5 0 0 1-10 0zM12 18v3',
    gear: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1',
    user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21c0-4 4-6 8-6s8 2 8 6',
    sparkle: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16v4M17 18h4',
    bubble: 'M4 5h16v11H10l-5 4v-4H4z',
    bolt: 'M13 2L4 14h7l-1 8 9-12h-7z',
    check: 'M5 13l4 4 10-10',
    cross: 'M6 6l12 12M18 6L6 18',
    flag: 'M5 21V4M5 4h12l-2 4 2 4H5',
    tag: 'M4 4h8l8 8-8 8-8-8zM8 8h.01',
    todo: 'M5 6l2 2 3-3M5 14l2 2 3-3M13 7h7M13 15h7'
  };
  var PATH2D = {};
  function iconSvg(name) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="' + (ICON[name] || ICON.gear) + '"/></svg>';
  }
  function drawIcon(ctx, name, x, y, size, color, lw) {
    var p = PATH2D[name] || (PATH2D[name] = new Path2D(ICON[name] || ICON.gear));
    ctx.save();
    ctx.translate(x - size / 2, y - size / 2);
    ctx.scale(size / 24, size / 24);
    ctx.strokeStyle = color; ctx.lineWidth = lw || 2.2; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.stroke(p);
    ctx.restore();
  }
  function toolIconName(t) {
    t = String(t || '');
    if (/^mcp__/i.test(t)) return 'plug';
    switch (t) {
      case 'Bash': case 'BashOutput': case 'KillShell': case 'PowerShell': return 'bash';
      case 'Read': case 'NotebookRead': return 'read';
      case 'Edit': case 'MultiEdit': case 'NotebookEdit': return 'edit';
      case 'Write': return 'write';
      case 'Grep': return 'search';
      case 'Glob': case 'LS': return 'folder';
      case 'WebSearch': case 'WebFetch': return 'web';
      case 'Agent': case 'Task': return 'branch';
      case 'TodoWrite': return 'todo';
      default: return 'gear';
    }
  }

  /* ================================================================== palette (read from CSS tokens; re-read on theme change) */
  var PAL = null;
  var rgbaCache = {};
  function readPal() {
    var cs = getComputedStyle(document.documentElement);
    function v(n) { return (cs.getPropertyValue(n) || '').trim(); }
    PAL = {
      text: v('--text-primary') || '#0b0b10', text2: v('--text-secondary') || '#4d4e58', muted: v('--text-muted') || '#85868f',
      grid: v('--grid') || '#ececf0', axis: v('--axis') || '#b4b5be', border: v('--border') || '#e3e3e8',
      surface: v('--surface-1') || '#fff', surface2: v('--surface-2') || '#f5f5f7', surface3: v('--surface-3') || '#ebebef',
      accent: v('--accent') || '#5b3fd0', good: v('--good') || '#0ca30c', warn: v('--warning') || '#fab219', crit: v('--critical') || '#d03b3b',
      page: v('--page') || '#fff', ink: v('--ink') || '#0b0b10', s: [],
      dark: document.documentElement.getAttribute('data-theme') === 'dark'
    };
    for (var i = 1; i <= 8; i++) PAL.s.push(v('--series-' + i) || '#888');
    rgbaCache = {};
  }
  function rgb(c) {
    var m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c);
    if (m) {
      var h = m[1].length === 3 ? m[1].replace(/./g, '$&$&') : m[1];
      return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
    }
    m = /rgba?\(([^)]+)\)/.exec(c);
    if (m) { var p = m[1].split(','); return [num(p[0]), num(p[1]), num(p[2])]; }
    return [128, 128, 128];
  }
  function rgba(c, a) {
    var k = c + '|' + a.toFixed(3), r = rgbaCache[k];
    if (r) return r;
    var q = rgb(c);
    return (rgbaCache[k] = 'rgba(' + q[0] + ',' + q[1] + ',' + q[2] + ',' + a.toFixed(3) + ')');
  }
  function lum(c) { var q = rgb(c); return (0.299 * q[0] + 0.587 * q[1] + 0.114 * q[2]) / 255; }
  var extraModels = {};
  function modelCol(m) {
    m = String(m || '');
    if (/opus/i.test(m)) return PAL.s[0];
    if (/sonnet/i.test(m)) return PAL.s[1];
    if (/haiku/i.test(m)) return PAL.s[2];
    if (/fable/i.test(m)) return PAL.s[3];
    if (!m) return PAL.axis;
    if (!(m in extraModels)) extraModels[m] = 4 + (Object.keys(extraModels).length % 4);
    return PAL.s[extraModels[m]];
  }
  function modelCssVar(m) {
    m = String(m || '');
    var i = /opus/i.test(m) ? 1 : /sonnet/i.test(m) ? 2 : /haiku/i.test(m) ? 3 : /fable/i.test(m) ? 4 : 0;
    if (!i && m) { modelCol(m); i = extraModels[m] + 1; }
    return i ? 'var(--series-' + i + ')' : 'var(--axis)';
  }
  function toolCol(t) {
    t = String(t || '');
    if (/^mcp__/i.test(t)) return PAL.axis;
    switch (t) {
      case 'Bash': case 'BashOutput': case 'PowerShell': return PAL.s[0];
      case 'Read': return PAL.s[2];
      case 'Edit': case 'MultiEdit': case 'NotebookEdit': return PAL.s[1];
      case 'Write': return PAL.s[3];
      case 'Grep': return PAL.s[6];
      case 'Glob': case 'LS': return PAL.s[4];
      case 'WebSearch': case 'WebFetch': return PAL.s[5];
      case 'Agent': case 'Task': return PAL.accent;
      default: return PAL.dark ? '#7f86b2' : '#8a8fa8';
    }
  }

  /* ================================================================== tweening */
  function mkTw(v, tau) { return { c: v, t: v, tau: tau || 0.35 }; }
  function stepTw(tw, dt) {
    if (REDUCED) { tw.c = tw.t; return false; }
    var d = tw.t - tw.c;
    if (d === 0) return false;
    tw.c += d * (1 - Math.exp(-dt / tw.tau));
    if (Math.abs(tw.t - tw.c) < Math.max(1e-9, Math.abs(tw.t) * 1e-6)) tw.c = tw.t;
    return true;
  }
  function setTw(tw, v, snap) { tw.t = v; if (snap || REDUCED) tw.c = v; }

  /* ================================================================== model */
  var TL_WIN = 300000, LANE_WIN = 60000, ECG_WIN = 40000, BUCKET = 5000;
  var M = {
    sessions: {}, selected: null, follow: true, skew: 0, haveState: false, conn: 'connecting', maxId: 0,
    today: { requests: 0, cost: 0, tokens: 0, output: 0 }, rate: { tokensPerMin: 0, costPerMin: 0, requestsPerMin: 0 },
    tw: {}, seen: {}, seenN: 0, lastMsg: 0
  };
  function resetTweens() {
    M.tw = { cost: mkTw(0, 0.55), tokens: mkTw(0, 0.55), requests: mkTw(0, 0.45), tpm: mkTw(0, 0.9), cpm: mkTw(0, 0.9), rpm: mkTw(0, 0.9) };
  }
  resetTweens();
  function serverNow() { return Date.now() + M.skew; }

  function newSession(id) {
    return {
      id: id, title: '', project: '', model: '', entrypoint: '', startedTs: 0, lastTs: 0,
      phase: 'idle', phaseSince: 0, currentTool: null, promptText: '', promptTs: 0, promptId: null,
      context: { tokens: 0, limit: 1000000 }, agents: {}, order: [],
      turn: { requests: 0, cost: 0, tokens: 0, output: 0, startedTs: 0 },
      feed: [], reqs: [], reqIdx: {}, tools: [], toolIdx: {}, toolEv: {}, phaseLog: [], impulses: [], fx: [],
      tw: { ctx: mkTw(0, 0.7), req: mkTw(0, 0.4), cost: mkTw(0, 0.5), out: mkTw(0, 0.5) }, first: true, ver: 0, firstSeen: Date.now()
    };
  }
  function getSession(id) { return M.sessions[id] || (M.sessions[id] = newSession(id)); }
  function agentOf(s, key, create) {
    var a = s.agents[key];
    if (!a && create) {
      a = s.agents[key] = {
        key: key, agentId: key === 'main' ? null : key, agentType: key === 'main' ? 'main' : '', desc: '', model: '',
        phase: 'idle', phaseSince: 0, currentTool: null, requests: 0, cost: 0, lastTs: 0,
        born: Date.now(), doneAt: 0, x: 0, y: 0, tx: 0, ty: 0, placed: false, pulse: 0, ph: 0
      };
      s.order.push(key);
    }
    return a;
  }
  function setPhase(s, p, since) {
    if (s.phase !== p) {
      s.phaseLog.push({ ts: since || serverNow(), p: p });
      if (s.phaseLog.length > 300) s.phaseLog.splice(0, 100);
      s.phase = p;
    }
    s.phaseSince = since || s.phaseSince || serverNow();
  }
  function normPhase(key, p) {
    if (p === 'generating' || p === 'tool') return p;
    if (key === 'main') return p === 'waiting_user' ? p : 'idle';
    return 'done';
  }
  function setAgentPhase(a, p, since) {
    p = normPhase(a.key, p);
    if (p === 'done' && a.phase !== 'done') a.doneAt = Date.now() - Math.max(0, serverNow() - (a.lastTs || serverNow()));
    if (p !== 'done') a.doneAt = 0;
    a.phase = p;
    if (since) a.phaseSince = since;
  }

  function markSeen(id) {
    M.seen[id] = 1;
    if (++M.seenN > 4000) {
      var keep = {}, n = 0;
      Object.keys(M.seen).forEach(function (k) { if (num(k) > M.maxId - 2000) { keep[k] = 1; n++; } });
      M.seen = keep; M.seenN = n;
    }
  }
  function fresh(ev) { return !document.hidden && serverNow() - num(ev.ts) < 6000; }

  /* ---- apply one transcript event to the local model (counters only when the stream is the source of truth) */
  function ingest(ev, o) {
    if (!ev || ev.id == null || !ev.sessionId) return false;
    if (M.seen[ev.id]) return false;
    markSeen(ev.id);
    if (num(ev.id) > M.maxId) M.maxId = num(ev.id);
    var s = getSession(ev.sessionId), now = Date.now(), ts = num(ev.ts) || serverNow();
    var animate = !!(o && o.animate) && fresh(ev);
    if (ev.project && !s.project) s.project = ev.project;
    s.lastTs = Math.max(s.lastTs, ts);
    var key = ev.sidechain && ev.agentId ? ev.agentId : 'main';
    var a = agentOf(s, key, true);
    if (key !== 'main') {
      if (ev.agentType) a.agentType = ev.agentType;
      if (!a.seenSpawn) { a.seenSpawn = true; a.born = animate ? now : now - 5000; a.placed = !animate; }
    }
    if (ev.model) { a.model = ev.model; if (key === 'main') s.model = ev.model; }
    a.lastTs = Math.max(a.lastTs, ts);
    if (ev.promptId) s.promptId = ev.promptId;
    var uid;
    switch (ev.kind) {
      case 'prompt':
        s.promptText = ev.text || ''; s.promptTs = ts;
        if (!o || o.counters) s.turn = { requests: 0, cost: 0, tokens: 0, output: 0, startedTs: ts };
        s.currentTool = null;
        setPhase(s, 'generating', ts);
        var m0 = agentOf(s, 'main', true); m0.phase = 'generating'; m0.phaseSince = ts; m0.currentTool = null;
        addImpulse(s, ts, 0.9);
        break;
      case 'thinking': addImpulse(s, ts, 0.16); break;
      case 'text': addImpulse(s, ts, 0.24); break;
      case 'tool_use':
        uid = ev.toolUseId || ('e' + ev.id);
        var bar = { id: uid, key: key, tool: ev.tool || 'tool', summary: ev.summary || '', start: ts, end: 0, isError: false, running: true, dur: 0 };
        s.tools.push(bar); s.toolIdx[uid] = bar; s.toolEv[uid] = ev;
        a.phase = 'tool'; a.phaseSince = ts; a.currentTool = { tool: bar.tool, summary: bar.summary, since: ts };
        if (key === 'main') { setPhase(s, 'tool', ts); s.currentTool = a.currentTool; }
        addImpulse(s, ts, 0.38);
        if (s.tools.length > 400) pruneTools(s);
        break;
      case 'tool_result':
        uid = ev.toolUseId;
        var b = uid && s.toolIdx[uid];
        if (!b) {
          b = { id: uid || ('e' + ev.id), key: key, tool: ev.tool || 'tool', summary: '', start: ts - num(ev.durationMs), end: 0, isError: false, running: true, dur: 0 };
          s.tools.push(b); s.toolIdx[b.id] = b;
        }
        b.running = false; b.end = ts; b.isError = !!ev.isError; b.dur = num(ev.durationMs) || Math.max(0, ts - b.start);
        if (s.toolEv[b.id]) { s.toolEv[b.id].res = { isError: b.isError, dur: b.dur }; feedTouchTool(s, b.id); } else { ev.res = { isError: b.isError, dur: b.dur }; }
        if (animate) fxAdd(s, { type: 'dock', key: key, color: b.isError ? 'crit' : 'tool', tool: b.tool, ok: !b.isError, dur: 900 });
        a.currentTool = runningTool(s, key);
        a.phase = a.currentTool ? 'tool' : 'generating'; a.phaseSince = ts;
        if (key === 'main') { s.currentTool = a.currentTool; setPhase(s, a.phase, ts); }
        addImpulse(s, ts, b.isError ? -0.5 : -0.3);
        break;
      case 'request':
        onRequest(s, a, ev, ts, o, animate);
        break;
      case 'subagent_start':
        a.agentType = ev.agentType || a.agentType; a.desc = ev.desc || a.desc;
        a.phase = 'generating'; a.phaseSince = ts; a.doneAt = 0;
        if (animate) { a.born = now; a.placed = false; fxAdd(s, { type: 'packet', from: 'main', to: key, color: 'accent', dur: 800 }); }
        addImpulse(s, ts, 0.5);
        break;
      case 'subagent_end':
        a.phase = 'done'; a.doneAt = animate ? now : now - Math.max(0, serverNow() - ts); a.currentTool = null;
        closeTools(s, key, ts);
        if (animate) fxAdd(s, { type: 'packet', from: key, to: 'main', color: 'good', dur: 800 });
        addImpulse(s, ts, 0.45);
        break;
      case 'turn_end':
        setPhase(s, 'waiting_user', ts); s.currentTool = null;
        var m1 = agentOf(s, 'main', true); m1.phase = 'waiting_user'; m1.phaseSince = ts; m1.currentTool = null;
        closeTools(s, 'main', ts, true);
        addImpulse(s, ts, 0.6);
        break;
      case 'title': if (ev.title) s.title = ev.title; break;
      default: break;
    }
    feedAdd(s, ev, animate);
    s.ver++;
    return true;
  }
  function runningTool(s, key) {
    for (var i = s.tools.length - 1; i >= 0; i--) { var b = s.tools[i]; if (b.running && b.key === key) return { tool: b.tool, summary: b.summary, since: b.start }; }
    return null;
  }
  function closeTools(s, key, ts, onlyStale) {
    s.tools.forEach(function (b) { if (b.running && b.key === key) { b.running = false; b.end = ts; b.dur = Math.max(0, ts - b.start); b.stale = true; if (s.toolEv[b.id] && !s.toolEv[b.id].res) { s.toolEv[b.id].res = { isError: false, dur: b.dur, stale: true }; feedTouchTool(s, b.id); } } });
  }
  function pruneTools(s) {
    var cut = Date.now() - 600000;
    s.tools = s.tools.filter(function (b) { return b.running || (b.end || b.start) > cut - M.skew; });
    var idx = {}; s.tools.forEach(function (b) { idx[b.id] = b; }); s.toolIdx = idx;
  }
  function addImpulse(s, ts, amp) {
    s.impulses.push({ ts: ts, amp: amp });
    if (s.impulses.length > 400) s.impulses.splice(0, 150);
  }
  function onRequest(s, a, ev, ts, o, animate) {
    var out = num(ev.output), inp = num(ev.input), cr = num(ev.cacheRead), cw = num(ev.cacheWrite), cost = num(ev.cost);
    var prev = ev.key ? s.reqIdx[ev.key] : null;
    var rec = { ts: ts, key: ev.key, ak: a.key, model: ev.model || a.model, out: out, inp: inp, cr: cr, cw: cw, cost: cost, lat: num(ev.latencyMs), born: animate ? Date.now() : 0 };
    var dCost = cost, dTok = inp + out + cr + cw, dOut = out, dReq = 1;
    if (prev) { dCost = cost - prev.cost; dTok = (inp + out + cr + cw) - (prev.inp + prev.out + prev.cr + prev.cw); dOut = out - prev.out; dReq = 0; rec.born = prev.born; Object.keys(rec).forEach(function (k) { prev[k] = rec[k]; }); }
    else { s.reqs.push(rec); if (ev.key) s.reqIdx[ev.key] = rec; if (s.reqs.length > 600) { s.reqs.splice(0, 200); s.reqIdx = {}; s.reqs.forEach(function (r) { if (r.key) s.reqIdx[r.key] = r; }); } }
    if (!o || o.counters) {
      a.requests += dReq; a.cost += dCost;
      s.turn.requests += dReq; s.turn.cost += dCost; s.turn.tokens += dTok; s.turn.output += dOut;
      M.today.requests += dReq; M.today.cost += dCost; M.today.tokens += dTok; M.today.output += dOut;
      syncCounterTargets(false);
      if (animate && (dCost || dTok)) deltaChip(dCost, dTok);
    }
    if (a.key === 'main' && !ev.sidechain) { var ctx = inp + cr + cw; if (ctx > 0) s.context.tokens = ctx; }
    if (animate) {
      a.pulse = 1;
      fxAdd(s, { type: 'float', key: a.key, text: '↑' + fmtTok(out), sub: fmtCost(cost, 3), dur: 1900 });
    }
    addImpulse(s, ts, 0.55 + 0.4 * Math.min(1, out / 2000));
    if (ev.stopReason === 'end_turn' && a.key !== 'main') a.lastEnd = ts;
  }
  function syncCounterTargets(snap) {
    setTw(M.tw.cost, M.today.cost, snap); setTw(M.tw.tokens, M.today.tokens, snap); setTw(M.tw.requests, M.today.requests, snap);
    setTw(M.tw.tpm, num(M.rate.tokensPerMin), snap); setTw(M.tw.cpm, num(M.rate.costPerMin), snap); setTw(M.tw.rpm, num(M.rate.requestsPerMin), snap);
  }
  function fxAdd(s, f) {
    f.t0 = Date.now();
    s.fx.push(f);
    if (s.fx.length > 80) s.fx.splice(0, 30);
  }

  /* ---- merge a /api/live/state payload (authoritative for scalars; recent[] feeds the event pipeline) */
  function mergeSession(ss, opts) {
    if (!ss || !ss.sessionId) return;
    var s = getSession(ss.sessionId), isNew = s.first;
    s.first = false;
    if (ss.title) s.title = ss.title;
    if (ss.project) s.project = ss.project;
    if (ss.model) s.model = ss.model;
    if (ss.entrypoint) s.entrypoint = ss.entrypoint;
    if (ss.startedTs) s.startedTs = ss.startedTs;
    if (ss.lastTs) s.lastTs = Math.max(s.lastTs, ss.lastTs);
    // events first (stream mode: already seen -> no-ops; poll mode: they animate in)
    var rec = (ss.recent || []).slice().sort(function (x, y) { return num(x.id) - num(y.id) || num(x.ts) - num(y.ts); });
    rec.forEach(function (ev) { ingest(ev, { counters: false, animate: opts.animate }); });
    // scalars from the server win
    if (ss.phase) setPhase(s, ss.phase, ss.phaseSince);
    s.currentTool = ss.currentTool || null;
    if (ss.promptText != null && ss.promptText !== '') { s.promptText = ss.promptText; if (ss.promptTs) s.promptTs = ss.promptTs; }
    if (ss.context) s.context = { tokens: num(ss.context.tokens), limit: num(ss.context.limit) || 1000000 };
    if (ss.turn) s.turn = { requests: num(ss.turn.requests), cost: num(ss.turn.cost), tokens: num(ss.turn.tokens), output: num(ss.turn.output), startedTs: num(ss.turn.startedTs) };
    var seenKeys = {};
    (ss.agents || []).forEach(function (ag) {
      var key = ag.agentId || 'main';
      seenKeys[key] = 1;
      var a = agentOf(s, key, true);
      if (ag.agentType) a.agentType = ag.agentType;
      if (ag.desc) a.desc = ag.desc;
      if (ag.model) a.model = ag.model;
      a.requests = num(ag.requests); a.cost = num(ag.cost);
      a.lastTs = Math.max(a.lastTs, num(ag.lastTs));
      var ph = ag.phase || a.phase;
      if (!(key !== 'main' && a.phase === 'done' && (ph === 'generating' || ph === 'tool') && Date.now() - a.doneAt < 1500)) setAgentPhase(a, ph, ag.phaseSince);
      a.currentTool = ag.currentTool || null;
      if (ag.endedTs && a.phase === 'done') a.doneAt = num(ag.endedTs) - M.skew;
      if (key !== 'main' && !a.seenSpawn) { a.seenSpawn = true; a.born = Date.now() - 5000; a.placed = true; }
    });
    var main = agentOf(s, 'main', true);
    if (!seenKeys.main) { main.phase = normPhase('main', s.phase); main.currentTool = s.currentTool; main.phaseSince = s.phaseSince; }
    if (!main.model) main.model = s.model;
    // a tool we never saw start (page opened mid-call) still shows as a live, growing bar
    Object.keys(s.agents).forEach(function (k) {
      var a = s.agents[k];
      if (a.currentTool && a.phase === 'tool' && !runningTool(s, k)) {
        var uid = 'cur:' + k + ':' + a.currentTool.since;
        if (!s.toolIdx[uid]) { var bar = { id: uid, key: k, tool: a.currentTool.tool, summary: a.currentTool.summary || '', start: a.currentTool.since, end: 0, isError: false, running: true, dur: 0 }; s.tools.push(bar); s.toolIdx[uid] = bar; }
      }
      if (a.phase !== 'tool') closeTools(s, k, serverNow());
    });
    if (isNew) { s.tw.ctx.c = 0; }
    s.ver++;
  }
  function applyState(p, opts) {
    opts = opts || {};
    if (!p || typeof p !== 'object') return;
    if (p.now) M.skew = num(p.now) - Date.now();
    var first = !M.haveState;
    (p.sessions || []).forEach(function (ss) { mergeSession(ss, opts); });
    if (p.today) M.today = { requests: num(p.today.requests), cost: num(p.today.cost), tokens: num(p.today.tokens), output: num(p.today.output) };
    if (p.rate) M.rate = { tokensPerMin: num(p.rate.tokensPerMin), costPerMin: num(p.rate.costPerMin), requestsPerMin: num(p.rate.requestsPerMin) };
    syncCounterTargets(first);
    // drop sessions the server no longer lists (inactive > 30 min)
    var ids = {};
    (p.sessions || []).forEach(function (ss) { ids[ss.sessionId] = 1; });
    Object.keys(M.sessions).forEach(function (id) { if (!ids[id] && serverNow() - M.sessions[id].lastTs > 31 * 60000) delete M.sessions[id]; });
    M.haveState = true;
    pickSelected();
    UI.dirty = true;
  }
  function pickSelected() {
    var ids = Object.keys(M.sessions);
    if (!ids.length) { M.selected = null; return; }
    var cur = M.sessions[M.selected];
    if (cur && !M.follow) return;
    var best = null;
    ids.forEach(function (id) { var s = M.sessions[id]; if (!best || s.lastTs > best.lastTs) best = s; });
    if (!cur) { selectSession(best.id, true); return; }
    if (best.id !== cur.id && (serverNow() - cur.lastTs > 6000 || best.lastTs > cur.lastTs + 4000)) selectSession(best.id, true);
  }
  function sel() { return M.sessions[M.selected] || null; }

  /* ================================================================== DOM */
  var root = null, built = false, active = false, UI = { dirty: true, chipSig: '' };
  var EL = {}, CV = {};

  function build() {
    root = $('#live-view');
    root.innerHTML =
      '<div class="wrap lv">' +
      '<div class="lv-top"><div class="lv-title"><h2>Live</h2><p>What Claude Code is doing right now, straight from its transcript logs as they are written. Numbers are real; motion only interpolates between them.</p></div>' +
      '<div class="lv-conn" id="lv-conn" data-s="connecting" role="status" aria-live="polite"><i></i><span>Connecting…</span></div></div>' +

      '<section class="lv-hero" id="lv-hero" data-phase="idle" aria-live="off">' +
      '<span class="lv-blob b1"></span><span class="lv-blob b2"></span>' +
      '<div class="lv-hero-l">' +
      '<div class="lv-tag"><span class="lv-pulse"></span><span id="lv-tag-t">IDLE</span><span class="lv-tag-s" id="lv-tag-s"></span></div>' +
      '<div class="lv-status"><span class="lv-st-t" id="lv-st-t">Idle</span><span class="lv-st-timer" id="lv-st-timer"></span></div>' +
      '<div class="lv-st-sub" id="lv-st-sub"><span id="lv-sub-model"></span><code id="lv-sub-code" hidden></code><span id="lv-sub-turn"></span></div>' +
      '<div class="lv-ecg-wrap"><span class="lv-ecg-cap">EVENT PULSE · LAST 40 S</span><span class="lv-ecg-cap r">NOW</span><canvas class="lv-ecg" id="lv-ecg" aria-hidden="true"></canvas></div>' +
      '</div>' +
      '<div class="lv-metrics">' +
      '<div class="lv-m-row">TODAY</div>' +
      metric('cost', 'API-equivalent cost') + metric('tokens', 'Tokens') + metric('requests', 'Requests') +
      '<div class="lv-m-row">RIGHT NOW · LAST 5 MIN</div>' +
      metric('tpm', 'Tokens / min') + metric('cpm', 'Cost / min') + metric('rpm', 'Requests / min') +
      '</div></section>' +

      '<div class="lv-chips" id="lv-chips" role="group" aria-label="Sessions"></div>' +

      '<div class="lv-empty" id="lv-empty">' +
      '<div class="lv-radar"><i></i><i></i><i></i><b>' + iconSvg('bolt') + '</b></div>' +
      '<h3 id="lv-empty-h">Waiting for Claude Code…</h3>' +
      '<p id="lv-empty-p">Start a session and it appears here instantly: every prompt, tool call, subagent and request, as it happens.</p>' +
      '<div class="cmd">$ claude</div></div>' +

      '<div class="lv-body" id="lv-body" hidden>' +
      '<div class="lv-grid1">' +
      '<article class="lv-card lv-tl"><div class="lv-ch"><div><h3>Streaming activity</h3><p class="cap">Output tokens per 5 s, last 5 minutes. Bars slide left with the clock; ticks below are tool calls.</p></div><div class="lv-legend" id="lv-tl-legend"></div></div><div class="lv-cv" id="lv-tl-cv"><canvas id="lv-tl"></canvas></div></article>' +
      '<article class="lv-card lv-turn"><div class="lv-turn-top"><span class="lv-big">Current turn</span><span class="lv-ph" id="lv-turn-ph" data-ph="idle">Idle</span></div>' +
      '<div class="lv-prompt muted" id="lv-prompt">No prompt yet</div>' +
      '<div class="lv-stats"><div class="lv-stat"><div class="l">Requests</div><div class="v" id="lv-ts-req">0</div></div><div class="lv-stat"><div class="l">Cost</div><div class="v" id="lv-ts-cost">$0</div></div><div class="lv-stat"><div class="l">Output</div><div class="v" id="lv-ts-out">0</div></div><div class="lv-stat"><div class="l">Elapsed</div><div class="v" id="lv-ts-el">0 s</div></div></div>' +
      '<div class="lv-ctx"><div class="lv-ring"><svg viewBox="0 0 112 112"><circle class="tr" cx="56" cy="56" r="47"/><circle class="pg" id="lv-ring-pg" cx="56" cy="56" r="47" stroke-dasharray="0 296"/></svg><div class="lv-ring-c"><div><b id="lv-ring-pct">0%</b><span>CONTEXT</span></div></div></div>' +
      '<div class="lv-ctx-t"><h4 id="lv-ctx-h">0 of 1M tokens</h4><p>Tokens in the main agent\'s last request: input + cache read + cache write.</p><div class="lv-ctx-bar"><b id="lv-ctx-bar" style="width:0"></b></div></div></div>' +
      '</article></div>' +

      '<div class="lv-grid2">' +
      '<article class="lv-card lv-tree"><div class="lv-ch"><div><h3>Agents</h3><p class="cap">The main agent and its subagents. Packets fly on spawn and return; rings show the phase.</p></div><div class="lv-legend" id="lv-tree-legend"></div></div><div class="lv-cv" id="lv-tree-cv"><canvas id="lv-tree"></canvas><div class="lv-nodes" id="lv-nodes"></div></div></article>' +
      '<article class="lv-card lv-lanes"><div class="lv-ch"><div><h3>Tool calls</h3><p class="cap">One lane per agent, last minute. Running calls grow in real time.</p></div><div class="lv-legend" id="lv-lane-legend"></div></div><div class="lv-cv" id="lv-lanes-cv"><canvas id="lv-lanes"></canvas></div></article>' +
      '</div>' +

      '<article class="lv-card lv-feed"><div class="lv-feed-h"><span class="dots"><i></i><i></i><i></i></span><h3>events — newest first</h3><span class="sp"></span><span class="n" id="lv-feed-n"></span><button type="button" class="lv-pause" id="lv-pause" aria-pressed="false" title="Freeze the list while you read">pause</button></div>' +
      '<div class="lv-feed-list" id="lv-feed" role="log" aria-live="off"></div></article>' +
      '</div></div>';

    EL.conn = $('#lv-conn'); EL.hero = $('#lv-hero'); EL.tagT = $('#lv-tag-t'); EL.tagS = $('#lv-tag-s');
    EL.stT = $('#lv-st-t'); EL.stTimer = $('#lv-st-timer'); EL.subModel = $('#lv-sub-model'); EL.subCode = $('#lv-sub-code'); EL.subTurn = $('#lv-sub-turn');
    EL.chips = $('#lv-chips'); EL.empty = $('#lv-empty'); EL.body = $('#lv-body');
    EL.feed = $('#lv-feed'); EL.feedN = $('#lv-feed-n'); EL.pause = $('#lv-pause');
    EL.turnPh = $('#lv-turn-ph'); EL.prompt = $('#lv-prompt');
    EL.tsReq = $('#lv-ts-req'); EL.tsCost = $('#lv-ts-cost'); EL.tsOut = $('#lv-ts-out'); EL.tsEl = $('#lv-ts-el');
    EL.ringPg = $('#lv-ring-pg'); EL.ringPct = $('#lv-ring-pct'); EL.ctxH = $('#lv-ctx-h'); EL.ctxBar = $('#lv-ctx-bar');
    EL.nodes = $('#lv-nodes'); EL.tlLegend = $('#lv-tl-legend'); EL.treeLegend = $('#lv-tree-legend'); EL.laneLegend = $('#lv-lane-legend');
    EL.emptyH = $('#lv-empty-h'); EL.emptyP = $('#lv-empty-p');
    ['cost', 'tokens', 'requests', 'tpm', 'cpm', 'rpm'].forEach(function (k) { EL['m_' + k] = $('#lv-m-' + k); EL['mv_' + k] = $('#lv-mv-' + k); EL['ms_' + k] = $('#lv-ms-' + k); });
    ['ecg', 'tl', 'tree', 'lanes'].forEach(function (k) { CV[k] = mkCv($('#lv-' + k)); });
    CV.tl.host = $('#lv-tl-cv'); CV.tree.host = $('#lv-tree-cv'); CV.lanes.host = $('#lv-lanes-cv'); CV.ecg.host = CV.ecg.el;

    EL.chips.addEventListener('click', function (e) {
      var f = e.target.closest('.lv-follow');
      if (f) { M.follow = !M.follow; if (M.follow) pickSelected(); UI.chipSig = ''; UI.dirty = true; return; }
      var b = e.target.closest('.lv-chip');
      if (b) { M.follow = false; selectSession(b.getAttribute('data-id')); }
    });
    EL.pause.addEventListener('click', function () {
      var on = EL.pause.getAttribute('aria-pressed') !== 'true';
      EL.pause.setAttribute('aria-pressed', String(on));
      EL.pause.textContent = on ? 'paused' : 'pause';
      EL.feed.setAttribute('data-paused', on ? '1' : '');
      if (!on) feedRebuild();
    });
    EL.feed.addEventListener('keydown', function (e) {
      if ((e.key === 'Enter' || e.key === ' ') && e.target.getAttribute && e.target.getAttribute('role') === 'button') { e.preventDefault(); e.target.click(); }
    });
    EL.prompt.addEventListener('keydown', function (e) { if (e.key === 'Enter' && e.target.hasAttribute('data-prompt')) e.target.click(); });
    wireHover(CV.tl, tlHover); wireHover(CV.tree, treeHover); wireHover(CV.lanes, lanesHover);
    built = true;
  }
  function metric(k, label) {
    return '<div class="lv-m" id="lv-m-' + k + '"><div class="lv-m-l">' + label + '</div><div class="lv-m-v" id="lv-mv-' + k + '">—</div><div class="lv-m-s" id="lv-ms-' + k + '">&nbsp;</div></div>';
  }
  function setText(el, t) { if (el && el._t !== t) { el._t = t; el.textContent = t; } }
  function setHtml(el, h) { if (el && el._h !== h) { el._h = h; el.innerHTML = h; } }
  function setAttr(el, k, v) { if (el && el['_a' + k] !== v) { el['_a' + k] = v; if (v == null) el.removeAttribute(k); else el.setAttribute(k, v); } }

  /* ---- canvases */
  function mkCv(canvas) { return { el: canvas, ctx: canvas.getContext('2d'), w: 0, h: 0, dpr: 1, dirty: true, hits: [], mx: -1, my: -1 }; }
  function fitCv(c) {
    var host = c.host && c.host.getBoundingClientRect ? c.host : c.el;
    var r = host.getBoundingClientRect();
    var w = Math.max(10, Math.round(r.width)), h = Math.max(10, Math.round(r.height));
    var d = Math.min(2, window.devicePixelRatio || 1);
    if (w !== c.w || h !== c.h || d !== c.dpr) { c.w = w; c.h = h; c.dpr = d; c.el.width = Math.round(w * d); c.el.height = Math.round(h * d); }
    c.dirty = false;
  }
  var RO = null;
  function observeSizes() {
    if (RO || !('ResizeObserver' in window)) return;
    RO = new ResizeObserver(function () { Object.keys(CV).forEach(function (k) { CV[k].dirty = true; }); if (REDUCED) kick(); });
    Object.keys(CV).forEach(function (k) { RO.observe(CV[k].host || CV[k].el); });
  }
  function prep(c) {
    if (c.dirty) fitCv(c);
    c.ctx.setTransform(c.dpr, 0, 0, c.dpr, 0, 0);
    c.ctx.clearRect(0, 0, c.w, c.h);
    return c.ctx;
  }
  function rr(ctx, x, y, w, h, r) {
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.arcTo(x + w, y, x + w, y + r, r);
    ctx.lineTo(x + w, y + h - r); ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
    ctx.lineTo(x + r, y + h); ctx.arcTo(x, y + h, x, y + h - r, r);
    ctx.lineTo(x, y + r); ctx.arcTo(x, y, x + r, y, r); ctx.closePath();
  }

  /* ---- tooltip */
  var tip = null;
  function tipEl() {
    if (!tip) { tip = document.createElement('div'); tip.className = 'lv-tip'; tip.setAttribute('role', 'tooltip'); document.body.appendChild(tip); }
    return tip;
  }
  function tipShow(html, cx, cy) {
    var t = tipEl();
    if (t._h !== html) { t._h = html; t.innerHTML = html; }
    var w = t.offsetWidth, h = t.offsetHeight;
    var x = cx + 14, y = cy + 16;
    if (x + w > window.innerWidth - 8) x = cx - w - 14;
    if (y + h > window.innerHeight - 8) y = cy - h - 12;
    t.style.left = Math.max(6, x) + 'px'; t.style.top = Math.max(6, y) + 'px';
    t.classList.add('show');
  }
  function tipHide() { if (tip) tip.classList.remove('show'); }
  function wireHover(c, fn) {
    var host = c.host || c.el;
    host.addEventListener('mousemove', function (e) {
      var r = c.el.getBoundingClientRect();
      c.mx = e.clientX - r.left; c.my = e.clientY - r.top;
      var h = fn(c, c.mx, c.my);
      if (h) { tipShow(h, e.clientX, e.clientY); host.style.cursor = 'default'; } else tipHide();
    });
    host.addEventListener('mouseleave', function () { c.mx = c.my = -1; tipHide(); });
  }

  /* ================================================================== feed (terminal) */
  var FEED = { rows: {}, count: 0, burstT: 0, burstN: 0 };
  function agentLabel(s, key) {
    if (key === 'main') return 'main';
    var a = s.agents[key];
    return (a && a.agentType) || 'subagent';
  }
  function rowParts(s, ev) {
    var key = ev.sidechain && ev.agentId ? ev.agentId : 'main';
    var who = '<span class="who' + (key === 'main' ? '' : ' sub') + '" title="' + esc(key === 'main' ? 'main agent' : agentLabel(s, key)) + '">' + esc(trunc(agentLabel(s, key), 12)) + '</span>';
    var ic, cls = '', b = '', e = '', attrs = '', wrap = false;
    switch (ev.kind) {
      case 'prompt':
        ic = 'user'; cls = 'k-prompt'; wrap = true; who = '<span class="who">you</span>';
        b = '<span class="k">prompt</span>' + esc(ev.text); if (ev.promptId) attrs = ' data-prompt="' + esc(ev.promptId) + '"';
        break;
      case 'thinking': ic = 'sparkle'; cls = 'k-thinking'; b = 'thinking…'; break;
      case 'text': ic = 'bubble'; cls = 'k-text'; wrap = true; b = '<span class="k">text</span>' + esc(ev.text); break;
      case 'tool_use':
      case 'tool_result': {
        var res = ev.res, tool = ev.tool || (ev.kind === 'tool_result' ? 'result' : 'tool');
        ic = toolIconName(tool); cls = 'k-tool' + (res && res.isError || ev.isError ? ' err' : '');
        b = '<span class="k">' + esc(tool) + '</span>' + (ev.summary ? '<span class="cmd">' + esc(ev.summary) + '</span>' : '<span class="dim">tool result</span>');
        if (ev.kind === 'tool_result') res = { isError: ev.isError, dur: ev.durationMs };
        if (res) e = (res.isError ? '<span class="bad">✗ failed</span>' : '<span class="ok">✓</span>') + ' ' + esc(fmtDur(res.dur)); else e = '<span class="run" data-run="' + esc(ev.toolUseId || ev.id) + '">0.0 s</span>';
        break;
      }
      case 'request':
        ic = 'bolt'; cls = 'k-request';
        b = '<span class="k">request</span><span class="dim">' + esc(modelShort(ev.model)) + '</span> ↓' + esc(fmtTok(num(ev.input) + num(ev.cacheRead) + num(ev.cacheWrite))) + ' <span style="color:#ffd479">↑' + esc(fmtTok(ev.output)) + '</span>' + (num(ev.thinking) ? ' <span class="dim">think ' + esc(fmtTok(ev.thinking)) + '</span>' : '') + (ev.stopReason ? ' <span class="dim">· ' + esc(ev.stopReason) + '</span>' : '');
        e = '<span class="cost">' + esc(fmtCost(ev.cost, 4)) + '</span>' + (num(ev.latencyMs) ? ' · ' + esc(fmtDur(ev.latencyMs)) : '');
        if (ev.key) attrs = ' data-req="' + esc(ev.key) + '"';
        break;
      case 'subagent_start': ic = 'branch'; cls = 'k-sub'; wrap = true; b = '<span class="k">spawn</span>' + esc(ev.agentType || 'subagent') + (ev.desc ? ' <span class="dim">— ' + esc(ev.desc) + '</span>' : ''); break;
      case 'subagent_end': ic = 'check'; cls = 'k-sub'; b = '<span class="k">done</span>' + esc(ev.agentType || 'subagent') + ' finished'; break;
      case 'turn_end': ic = 'flag'; cls = 'k-turn'; b = ev.reason === 'interrupted' ? 'turn interrupted — waiting for you' : 'turn complete — waiting for you'; who = '<span class="who">main</span>'; break;
      case 'title': ic = 'tag'; cls = 'k-title'; b = '<span class="dim">session title</span> ' + esc(ev.title); break;
      default: ic = 'gear'; b = esc(ev.kind);
    }
    return { cls: cls, attrs: attrs, ic: ic, who: who, b: b, e: e, wrap: wrap };
  }
  function rowEl(s, ev, animate) {
    var p = rowParts(s, ev), el = document.createElement('div');
    el.className = 'lv-ev ' + p.cls + (animate ? '' : ' still');
    el.setAttribute('data-eid', ev.id);
    if (p.attrs) { el.setAttribute('role', 'button'); el.tabIndex = 0; var m = /data-(req|prompt)="([^"]*)"/.exec(p.attrs); if (m) el.setAttribute('data-' + m[1], m[2].replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')); }
    el.innerHTML = '<div class="lv-ev-in"><span class="t">' + hms(ev.ts) + '</span><span class="ic">' + iconSvg(p.ic) + '</span>' + p.who + '<span class="b">' + (p.wrap ? '<span class="clamp">' + p.b + '</span>' : p.b) + '</span><span class="e">' + p.e + '</span></div>';
    return el;
  }
  function feedAdd(s, ev, animate) {
    if (ev.kind === 'tool_result' && s.toolEv[ev.toolUseId]) return;     // merged into its tool_use row
    // keep newest first
    var f = s.feed, i = 0;
    if (f.length && (f[0].ts > ev.ts || (f[0].ts === ev.ts && f[0].id > ev.id))) { while (i < f.length && (f[i].ts > ev.ts || (f[i].ts === ev.ts && f[i].id > ev.id))) i++; }
    f.splice(i, 0, ev);
    if (f.length > 160) f.length = 160;
    if (!built || s.id !== M.selected || !active) return;
    if (EL.feed.getAttribute('data-paused')) return;
    var el = rowEl(s, ev, animate && !REDUCED);
    if (animate && !REDUCED) {            // blocks of one assistant message land together: stagger them so the eye can follow
      var nowT = Date.now();
      if (nowT - FEED.burstT > 450) FEED.burstN = 0;
      FEED.burstT = nowT;
      el.style.setProperty('--ad', Math.min(FEED.burstN, 8) * 110 + 'ms');
      FEED.burstN++;
    }
    FEED.rows[ev.id] = el;
    var ref = EL.feed.children[i];
    if (EL.feed.querySelector('.lv-feed-empty')) EL.feed.innerHTML = '';
    EL.feed.insertBefore(el, i === 0 ? EL.feed.firstChild : (EL.feed.children[i] || null));
    while (EL.feed.children.length > 140) { var last = EL.feed.lastChild; var id = last.getAttribute('data-eid'); delete FEED.rows[id]; EL.feed.removeChild(last); }
    UI.feedN = true;
  }
  function feedTouchTool(s, uid) {
    if (!built || s.id !== M.selected) return;
    var ev = s.toolEv[uid], el = ev && FEED.rows[ev.id];
    if (!el || EL.feed.getAttribute('data-paused')) return;
    var p = rowParts(s, ev);
    el.className = 'lv-ev ' + p.cls + ' still upd';
    el.querySelector('.e').innerHTML = p.e;
    var inner = el.querySelector('.lv-ev-in');
    inner.classList.remove('flash'); void inner.offsetWidth;
    el.classList.remove('upd'); void el.offsetWidth; el.classList.add('upd');
    if (el._hlT) clearTimeout(el._hlT);
  }
  function feedRebuild() {
    var s = sel();
    FEED.rows = {};
    EL.feed.innerHTML = '';
    if (!s || !s.feed.length) { EL.feed.innerHTML = '<div class="lv-feed-empty">waiting for events</div>'; EL.feedN.textContent = ''; return; }
    var frag = document.createDocumentFragment();
    s.feed.slice(0, 120).forEach(function (ev) { var el = rowEl(s, ev, false); FEED.rows[ev.id] = el; frag.appendChild(el); });
    EL.feed.appendChild(frag);
    UI.feedN = true;
  }
  function updateRunningRows(now) {
    var nodes = EL.feed.querySelectorAll('.run[data-run]');
    var s = sel();
    for (var i = 0; i < nodes.length; i++) {
      var uid = nodes[i].getAttribute('data-run'), b = s && s.toolIdx[uid];
      if (b && b.running) setText(nodes[i], fmtSecs(serverNow() - b.start));
    }
  }

  /* ================================================================== session selection + chips */
  function selectSession(id, auto) {
    if (!M.sessions[id]) return;
    var changed = M.selected !== id;
    M.selected = id;
    UI.chipSig = ''; UI.dirty = true; UI.promptSig = '';
    if (changed && built) { feedRebuild(); Object.keys(CV).forEach(function (k) { CV[k].dirty = true; }); }
  }
  function phaseLabel(p) { return p === 'generating' ? 'generating' : p === 'tool' ? 'running a tool' : p === 'waiting_user' ? 'waiting for you' : 'idle'; }
  function effPhase(s, now) {
    if (!s) return 'idle';
    if (s.phase === 'idle') return 'idle';
    if (now - s.lastTs > 600000) return 'idle';
    return s.phase;
  }
  function renderChips(now) {
    var ids = Object.keys(M.sessions).sort(function (a, b) { var x = M.sessions[a], y = M.sessions[b]; return (x.startedTs || x.firstSeen) - (y.startedTs || y.firstSeen) || (a < b ? -1 : 1); });
    var sig = ids.map(function (id) { var s = M.sessions[id]; return id + ':' + effPhase(s, now) + ':' + (s.title || s.project) + ':' + (id === M.selected ? 1 : 0); }).join('|') + (M.follow ? 'f' : 'n');
    if (sig === UI.chipSig) return;
    UI.chipSig = sig;
    var h = ids.map(function (id) {
      var s = M.sessions[id], ph = effPhase(s, now);
      var label = s.title || baseName(s.project) || id.slice(0, 8);
      return '<button type="button" class="lv-chip" data-id="' + esc(id) + '" data-ph="' + ph + '" aria-pressed="' + (id === M.selected) + '" title="' + esc((s.project || id) + ' · ' + phaseLabel(ph)) + '"><span class="ph"></span><b>' + esc(trunc(label, 34)) + '</b>' + (s.title && s.project ? '<small>' + esc(baseName(s.project)) + '</small>' : '') + '</button>';
    }).join('');
    if (ids.length > 1) h += '<button type="button" class="lv-follow" aria-pressed="' + M.follow + '" title="Switch to whichever session is most recently active">' + (M.follow ? '● following latest' : '○ follow latest') + '</button>';
    EL.chips.innerHTML = h;
  }

  /* ================================================================== status + hero */
  function mainAgent(s) { return s && s.agents.main; }
  function runningBars(s, key) { return s.tools.filter(function (b) { return b.running && (key == null || b.key === key); }); }
  function statusOf(s, now) {
    var sn = serverNow();
    if (!s) return { ph: 'idle', title: 'Idle', timer: '', since: 0 };
    var ph = effPhase(s, sn);
    if (ph === 'idle') return { ph: 'idle', title: 'Idle', timer: '', since: 0, note: s.lastTs ? 'last activity ' + ago(sn - s.lastTs) : '' };
    if (ph === 'waiting_user') return { ph: ph, title: 'Waiting for you', timer: fmtSecs(sn - s.phaseSince), since: s.phaseSince };
    var ma = mainAgent(s);
    if (ph === 'tool') {
      var bars = runningBars(s, 'main');
      var ct = s.currentTool || (bars[0] && { tool: bars[0].tool, summary: bars[0].summary, since: bars[0].start }) || { tool: 'tool', summary: '', since: s.phaseSince };
      var names = [], seen = {};
      bars.forEach(function (b) { if (!seen[b.tool]) { seen[b.tool] = 1; names.push(b.tool); } });
      if (!names.length) names.push(ct.tool);
      var t = 'Running ' + names.slice(0, 2).join(' + ') + (names.length > 2 ? ' +' + (names.length - 2) : '');
      var subs = Object.keys(s.agents).filter(function (k) { var a = s.agents[k]; return k !== 'main' && (a.phase === 'generating' || a.phase === 'tool'); }).length;
      var since = bars.length ? Math.min.apply(null, bars.map(function (b) { return b.start; })) : ct.since;
      return { ph: ph, title: t, timer: fmtSecs(sn - since), since: since, code: ct.summary, tool: ct.tool, subs: subs };
    }
    var since2 = Math.max(s.phaseSince || 0, ma ? ma.lastTs : 0);
    return { ph: 'generating', title: 'Claude is generating', dots: true, timer: fmtSecs(sn - since2), since: since2 };
  }
  var HERO_PH = '';
  function renderHero(now, dt) {
    var s = sel(), st = statusOf(s, now);
    if (HERO_PH !== st.ph) { HERO_PH = st.ph; EL.hero.setAttribute('data-phase', st.ph); }
    setText(EL.tagT, st.ph === 'idle' ? 'IDLE' : st.ph === 'waiting_user' ? 'YOUR TURN' : 'LIVE');
    var tagS = s ? [baseName(s.project), s.entrypoint].filter(Boolean).join(' · ') : '';
    setText(EL.tagS, tagS);
    var dots = st.dots ? (REDUCED ? '…' : ['', '.', '..', '...'][Math.floor(now / 380) % 4]) : '';
    if (st.dots) setHtml(EL.stT, esc(st.title) + '<span class="lv-dots">' + (REDUCED ? '…' : dots) + '</span>'); else setHtml(EL.stT, esc(st.title));
    setText(EL.stTimer, st.timer);
    var ma = mainAgent(s);
    var mdl = (ma && ma.model) || (s && s.model) || '';
    setHtml(EL.subModel, mdl ? '<span class="lv-mchip"><i style="background:' + modelCssVar(mdl) + '"></i>' + esc(modelShort(mdl)) + '</span>' : '');
    if (st.code) { EL.subCode.hidden = false; setText(EL.subCode, trunc(st.code, 140)); } else if (st.note) { EL.subCode.hidden = true; } else EL.subCode.hidden = true;
    var turn = '';
    if (s) {
      var sn = serverNow();
      if (st.ph === 'generating' || st.ph === 'tool') turn = 'turn ' + fmtSecs(sn - (s.turn.startedTs || s.promptTs || sn)) + ' · ' + s.turn.requests + ' request' + (s.turn.requests === 1 ? '' : 's') + (st.subs ? ' · ' + st.subs + ' subagent' + (st.subs === 1 ? '' : 's') + ' working' : '');
      else if (st.ph === 'waiting_user') turn = 'last turn ' + fmtDur(Math.max(0, s.lastTs - (s.turn.startedTs || s.promptTs || s.lastTs))) + ' · ' + s.turn.requests + ' requests · ' + fmtCost(s.turn.cost, 3);
      else turn = st.note || '';
    }
    setText(EL.subTurn, turn);
    // counters
    var changed = {};
    ['cost', 'tokens', 'requests', 'tpm', 'cpm', 'rpm'].forEach(function (k) { stepTw(M.tw[k], dt); });
    setText(EL.mv_cost, fmtCost(M.tw.cost.c, 3));
    setText(EL.mv_tokens, fmtInt(M.tw.tokens.c));
    setText(EL.mv_requests, fmtInt(M.tw.requests.c));
    setText(EL.mv_tpm, fmtTok(M.tw.tpm.c));
    setText(EL.mv_cpm, fmtCost(M.tw.cpm.c, 3));
    setText(EL.mv_rpm, M.tw.rpm.c < 10 ? M.tw.rpm.c.toFixed(1) : fmtInt(M.tw.rpm.c));
    setText(EL.ms_cost, 'at API list prices');
    setText(EL.ms_tokens, fmtInt(M.today.output) + ' output');
    setText(EL.ms_requests, 'since midnight');
    setText(EL.ms_tpm, 'rolling average');
    setText(EL.ms_cpm, 'rolling average');
    setText(EL.ms_rpm, 'rolling average');
  }
  var deltaT = 0;
  function deltaChip(dCost, dTok) {
    if (!built || !active || REDUCED || document.hidden) return;
    var now = Date.now();
    if (now - deltaT < 120) return; deltaT = now;
    [['cost', dCost > 0 ? '+' + fmtCost(dCost, 3) : ''], ['tokens', dTok > 0 ? '+' + fmtInt(dTok) : '']].forEach(function (p) {
      var host = EL['m_' + p[0]];
      if (!host || !p[1]) return;
      var d = document.createElement('span'); d.className = 'lv-delta'; d.textContent = p[1];
      host.appendChild(d);
      d.addEventListener('animationend', function () { d.remove(); });
      host.classList.remove('flash'); void host.offsetWidth; host.classList.add('flash');
    });
  }

  /* ---- ECG-style event pulse (impulses are real events; baseline hum reflects the real phase history) */
  function phaseAt(s, ts) {
    var log = s.phaseLog, p = 'idle';
    for (var i = log.length - 1; i >= 0; i--) { if (log[i].ts <= ts) { p = log[i].p; break; } }
    return p;
  }
  function drawEcg(now) {
    var c = CV.ecg, ctx = prep(c), W = c.w, H = c.h, s = sel();
    var sn = serverNow(), mid = H * 0.64, amp = H * 0.46;
    // baseline
    ctx.strokeStyle = 'rgba(255,255,255,0.10)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(0, mid + 0.5); ctx.lineTo(W, mid + 0.5); ctx.stroke();
    // minute-ish grid every 10 s
    for (var g = 1; g < 4; g++) { var gx = W - (g * 10000 / ECG_WIN) * W; ctx.strokeStyle = 'rgba(255,255,255,0.05)'; ctx.beginPath(); ctx.moveTo(gx + 0.5, 4); ctx.lineTo(gx + 0.5, H - 2); ctx.stroke(); }
    var pts = [], step = 2, n = Math.ceil(W / step);
    var imps = s ? s.impulses : [];
    var j0 = 0;
    for (var i = 0; i <= n; i++) {
      var x = Math.min(W, i * step), ts = sn - (1 - x / W) * ECG_WIN, y = 0;
      if (s) {
        var ph = phaseAt(s, ts);
        if (ph === 'generating') y += 0.085 * (Math.sin(ts / 83) + 0.7 * Math.sin(ts / 37 + 1.3) + 0.5 * Math.sin(ts / 19 + 0.4));
        else if (ph === 'tool') y += 0.07 * Math.sin(ts / 60) * (0.6 + 0.4 * Math.sin(ts / 700));
        else if (ph === 'waiting_user') y += 0.012 * Math.sin(ts / 420);
        for (var k = imps.length - 1; k >= 0; k--) {
          var d = ts - imps[k].ts;
          if (d < 0) continue;
          if (d > 1600) break;
          y += imps[k].amp * Math.exp(-d / 110) * Math.sin(d / 24);
        }
      }
      pts.push(x, mid - clamp(y, -0.95, 0.95) * amp);
    }
    var grad = ctx.createLinearGradient(0, 0, W, 0);
    grad.addColorStop(0, 'rgba(220,210,255,0)'); grad.addColorStop(0.55, 'rgba(220,210,255,0.55)'); grad.addColorStop(1, 'rgba(255,255,255,0.98)');
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(160,130,255,0.28)'; ctx.lineWidth = 6; ctx.beginPath();
    for (i = 0; i < pts.length; i += 2) { if (i === 0) ctx.moveTo(pts[i], pts[i + 1]); else ctx.lineTo(pts[i], pts[i + 1]); }
    ctx.save(); ctx.filter = 'none'; ctx.globalCompositeOperation = 'lighter'; ctx.stroke(); ctx.restore();
    ctx.strokeStyle = grad; ctx.lineWidth = 2; ctx.beginPath();
    for (i = 0; i < pts.length; i += 2) { if (i === 0) ctx.moveTo(pts[i], pts[i + 1]); else ctx.lineTo(pts[i], pts[i + 1]); }
    ctx.stroke();
    // head
    var hx = W - 2, hy = pts[pts.length - 1], pulse = REDUCED ? 0.5 : 0.5 + 0.5 * Math.sin(now / 260);
    var rg = ctx.createRadialGradient(hx, hy, 0, hx, hy, 12 + 4 * pulse);
    rg.addColorStop(0, 'rgba(255,255,255,0.9)'); rg.addColorStop(0.35, 'rgba(190,170,255,0.45)'); rg.addColorStop(1, 'rgba(190,170,255,0)');
    ctx.fillStyle = rg; ctx.beginPath(); ctx.arc(hx, hy, 16, 0, 7); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(hx, hy, 2.6, 0, 7); ctx.fill();
  }

  /* ================================================================== streaming activity timeline */
  var TLS = { yMax: mkTw(1000, 0.5) };
  function niceMax(v) {
    var steps = [500, 1000, 1500, 2000, 3000, 4000, 6000, 8000, 12000, 16000, 24000, 32000, 48000, 64000, 100000, 160000, 250000, 400000, 1e6];
    for (var i = 0; i < steps.length; i++) if (v <= steps[i]) return steps[i];
    return Math.ceil(v / 1e6) * 1e6;
  }
  function tlGeom(c) { var L = 44, R = c.w - 16, T = 12, B = c.h - 40; return { L: L, R: R, T: T, B: B, pw: R - L, ph: B - T }; }
  function tlBuckets(s, now) {
    var bk = {}, lo = now - TL_WIN - BUCKET;
    for (var i = s.reqs.length - 1; i >= 0; i--) {
      var r = s.reqs[i];
      if (r.ts < lo) { if (r.ts < lo - 600000) break; continue; }
      var id = Math.floor(r.ts / BUCKET), b = bk[id] || (bk[id] = { id: id, m: {}, tot: 0, born: 0, n: 0 });
      b.m[r.model || ''] = (b.m[r.model || ''] || 0) + r.out; b.tot += r.out; b.n++; if (r.born > b.born) b.born = r.born;
    }
    return bk;
  }
  function drawTimeline(now, dt) {
    var c = CV.tl, ctx = prep(c), W = c.w, H = c.h, g = tlGeom(c), s = sel(), sn = serverNow();
    var X = function (t) { return g.R - (sn - t) / TL_WIN * g.pw; };
    c.hits = [];
    var bk = s ? tlBuckets(s, sn) : {}, ids = Object.keys(bk), maxTot = 0, nReq = 0, sumOut = 0;
    ids.forEach(function (k) { var b = bk[k]; if ((b.id + 1) * BUCKET > sn - TL_WIN) { maxTot = Math.max(maxTot, b.tot); nReq += b.n; sumOut += b.tot; } });
    setTw(TLS.yMax, niceMax(Math.max(400, maxTot * 1.12))); stepTw(TLS.yMax, dt);
    var yMax = Math.max(1, TLS.yMax.c);
    // grid
    ctx.font = '11px ' + FONT; ctx.textBaseline = 'middle';
    ctx.lineWidth = 1;
    for (var gi = 0; gi <= 2; gi++) {
      var gy = Math.round(g.B - gi / 2 * g.ph) + 0.5;
      ctx.strokeStyle = gi === 0 ? PAL.axis : PAL.grid; ctx.beginPath(); ctx.moveTo(g.L, gy); ctx.lineTo(g.R, gy); ctx.stroke();
      ctx.fillStyle = PAL.muted; ctx.textAlign = 'right'; ctx.fillText(gi === 0 ? '0' : fmtTok(yMax * gi / 2), g.L - 8, gy);
    }
    // sliding minute lines (absolute wall clock)
    ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    var m0 = Math.ceil((sn - TL_WIN) / 60000) * 60000;
    for (var tm = m0; tm <= sn; tm += 60000) {
      var mx = X(tm);
      if (mx < g.L + 4) continue;
      ctx.strokeStyle = PAL.grid; ctx.beginPath(); ctx.moveTo(Math.round(mx) + 0.5, g.T); ctx.lineTo(Math.round(mx) + 0.5, g.B + 4); ctx.stroke();
      if (g.R - mx > 34) { ctx.fillStyle = PAL.muted; ctx.fillText(hm(tm - M.skew), mx, H - 8); }
    }
    ctx.fillStyle = PAL.muted; ctx.textAlign = 'right'; ctx.fillText('now', g.R + 8, H - 8);
    // clip plot
    ctx.save(); ctx.beginPath(); ctx.rect(g.L, 0, g.pw + 12, H); ctx.clip();
    // in-flight band (honest: no number, just "waiting on the model")
    if (s) {
      var ph = effPhase(s, sn), ma = mainAgent(s);
      if (ph === 'generating' || ph === 'tool') {
        var lastEv = Math.max(s.phaseSince || 0, ma ? ma.lastTs : 0), x0 = Math.max(g.L, X(lastEv));
        var gr = ctx.createLinearGradient(x0, 0, g.R, 0);
        var col = ph === 'tool' ? PAL.s[3] : PAL.accent;
        gr.addColorStop(0, rgba(col, 0)); gr.addColorStop(1, rgba(col, 0.2));
        ctx.fillStyle = gr; ctx.fillRect(x0, g.T, g.R - x0, g.ph);
        // moving hatch along the baseline
        ctx.strokeStyle = rgba(col, 0.75); ctx.lineWidth = 2; ctx.setLineDash([6, 6]); ctx.lineDashOffset = REDUCED ? 0 : -now / 40;
        ctx.beginPath(); ctx.moveTo(x0, g.B - 1); ctx.lineTo(g.R, g.B - 1); ctx.stroke(); ctx.setLineDash([]);
      }
    }
    // bars
    var models = {};
    ids.forEach(function (k) { Object.keys(bk[k].m).forEach(function (m) { models[m] = 1; }); });
    var mkeys = Object.keys(models).sort();
    var bw = g.pw * BUCKET / TL_WIN;
    ids.sort(function (a, b) { return a - b; }).forEach(function (k) {
      var b = bk[k], xs = X(b.id * BUCKET), xe = Math.min(g.R, X((b.id + 1) * BUCKET));
      if (xe < g.L - 2 || xe - xs < 0.2) return;
      var w = Math.max(2, xe - xs - (xe - xs > 4 ? 1.2 : 0)), y = g.B, age = b.born ? Date.now() - b.born : 1e9, glow = REDUCED ? 0 : clamp(1 - age / 1500, 0, 1);
      var totH = Math.max(4, b.tot / yMax * g.ph);
      if (glow > 0) {
        var gg = ctx.createLinearGradient(0, g.T, 0, g.B);
        var gm = modelCol(mkeys[0]);
        gg.addColorStop(0, rgba(gm, 0)); gg.addColorStop(1, rgba(gm, 0.28 * glow));
        ctx.fillStyle = gg; ctx.fillRect(xs - 5, g.T, w + 10, g.ph);
      }
      var acc = 0;
      mkeys.forEach(function (m, mi) {
        var v = b.m[m] || 0;
        if (!v) return;
        var h = Math.max(2.5, v / b.tot * totH - (mkeys.length > 1 ? 1.5 : 0));
        var top = y - acc - h;
        ctx.fillStyle = modelCol(m);
        if (glow > 0) { ctx.shadowColor = rgba(modelCol(m), 0.9); ctx.shadowBlur = 14 * glow; }
        rr(ctx, xs, top, w, h, acc + h >= totH - 0.5 ? Math.min(4, w / 2) : 1); ctx.fill();
        ctx.shadowBlur = 0;
        acc += h + 1.5;
      });
      c.hits.push({ x: xs, w: Math.max(w, 6), y: g.T, h: g.ph, b: b });
    });
    // tool ticks
    if (s) {
      for (var ti = s.tools.length - 1; ti >= 0; ti--) {
        var tb = s.tools[ti];
        if (tb.start < sn - TL_WIN) { if (tb.start < sn - TL_WIN - 600000) break; continue; }
        var tx = X(tb.start);
        ctx.fillStyle = tb.isError ? PAL.crit : toolCol(tb.tool);
        rr(ctx, tx - 1, g.B + 8, 2.4, tb.running ? 12 : 9, 1.2); ctx.fill();
      }
    }
    ctx.restore();
    // now cursor
    var pulse = REDUCED ? 0.5 : 0.5 + 0.5 * Math.sin(now / 300);
    ctx.strokeStyle = rgba(PAL.accent, 0.55); ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(g.R + 0.5, g.T - 4); ctx.lineTo(g.R + 0.5, g.B + 22); ctx.stroke();
    ctx.fillStyle = rgba(PAL.accent, 0.18 + 0.12 * pulse); ctx.beginPath(); ctx.arc(g.R + 0.5, g.B, 7 + 3 * pulse, 0, 7); ctx.fill();
    ctx.fillStyle = PAL.accent; ctx.beginPath(); ctx.arc(g.R + 0.5, g.B, 3.2, 0, 7); ctx.fill();
    if (!ids.length) { ctx.fillStyle = PAL.muted; ctx.textAlign = 'center'; ctx.font = '13px ' + FONT; ctx.fillText(s ? 'No completed requests in the last 5 minutes' : 'Nothing yet', (g.L + g.R) / 2, (g.T + g.B) / 2); }
    // summary
    UI.tlSummary = nReq + ' request' + (nReq === 1 ? '' : 's') + ' · ' + fmtTok(sumOut) + ' output tokens in view';
    var mk = mkeys.length ? mkeys : (s && s.model ? [s.model] : []);
    var lg = mk.map(function (m) { return '<span><i style="background:' + modelCssVar(m) + '"></i>' + esc(modelShort(m)) + '</span>'; }).join('') + '<span style="color:var(--text-muted)">' + esc(UI.tlSummary) + '</span>';
    setHtml(EL.tlLegend, lg);
  }
  function tlHover(c, mx, my) {
    for (var i = 0; i < c.hits.length; i++) {
      var h = c.hits[i];
      if (mx >= h.x - 1 && mx <= h.x + h.w + 1) {
        var b = h.b, t0 = b.id * BUCKET - M.skew;
        var rows = Object.keys(b.m).map(function (m) { return '<div><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:' + modelCssVar(m) + ';margin-right:6px"></span>' + esc(modelShort(m)) + ' · <b>' + fmtInt(b.m[m]) + '</b> output</div>'; }).join('');
        return '<b>' + hms(t0) + '</b> <span class="dim">· ' + b.n + ' request' + (b.n === 1 ? '' : 's') + '</span>' + rows;
      }
    }
    return '';
  }

  /* ================================================================== agent constellation */
  var TREE = { hover: null };
  function agentVisible(a, now) { return !(a.phase === 'done' && a.doneAt && now - a.doneAt > 50000); }
  function visibleAgents(s, now) {
    var keys = s.order.filter(function (k) { return s.agents[k] && agentVisible(s.agents[k], now); });
    var main = keys.indexOf('main'); if (main > 0) { keys.splice(main, 1); keys.unshift('main'); }
    return keys;
  }
  function layoutTree(s, keys, c) {
    var W = c.w, H = c.h, subs = keys.filter(function (k) { return k !== 'main'; }), n = subs.length;
    var narrow = W < 520;
    var mainX = n === 0 ? W * 0.5 : (narrow ? Math.max(46, W * 0.15) : Math.max(70, W * 0.17)), mainY = H * 0.5 - (n === 0 ? 14 : 0);
    var cols = n <= 5 ? 1 : n <= 10 ? 2 : 3;
    var rows = Math.max(1, Math.ceil(n / cols));
    var x0 = narrow ? W * 0.5 : W * 0.40, colW = cols === 1 ? 0 : (W - x0 - 150) / (cols - 1 || 1);
    var pos = { main: { x: mainX, y: mainY } };
    subs.forEach(function (k, i) {
      var col = Math.floor(i / rows), row = i % rows;
      var y = H * (0.5 + (rows === 1 ? 0 : ((row + 0.5) / rows - 0.5) * 0.82));
      pos[k] = { x: x0 + col * Math.min(colW, 200), y: y, compact: cols > 1 || n > 4 };
    });
    return pos;
  }
  function bez(p0, p1, c1, c2, t) { var u = 1 - t; return u * u * u * p0 + 3 * u * u * t * c1 + 3 * u * t * t * c2 + t * t * t * p1; }
  function edgePoint(a, b, t) {
    var dx = (b.x - a.x) * 0.55;
    return { x: bez(a.x, b.x, a.x + dx, b.x - dx, t), y: bez(a.y, b.y, a.y, b.y, t) };
  }
  function drawTree(now, dt) {
    var c = CV.tree, ctx = prep(c), W = c.w, H = c.h, s = sel(), sn = serverNow();
    c.hits = [];
    // faint dotted field
    ctx.fillStyle = rgba(PAL.axis, 0.28);
    for (var gx = 14; gx < W; gx += 26) for (var gy = 14; gy < H; gy += 26) ctx.fillRect(gx, gy, 1.4, 1.4);
    if (!s) { drawTreeEmpty(ctx, W, H); setHtml(EL.nodes, ''); return; }
    var keys = visibleAgents(s, now), pos = layoutTree(s, keys, c);
    var mainP = pos.main;
    keys.forEach(function (k) {
      var a = s.agents[k], p = pos[k];
      if (!a.placed && !a.xInit) { a.x = a.key === 'main' ? p.x : mainP.x; a.y = a.key === 'main' ? p.y : mainP.y; a.xInit = true; }
      a.tx = p.x; a.ty = p.y;
      var f = REDUCED ? 1 : 1 - Math.exp(-dt / 0.28);
      a.x += (a.tx - a.x) * f; a.y += (a.ty - a.y) * f;
      if (a.placed && !a.xInit) { a.x = a.tx; a.y = a.ty; a.xInit = true; }
      a.pulse = Math.max(0, a.pulse - dt / 1.0);
    });
    var sub = keys.filter(function (k) { return k !== 'main'; });
    var ma = s.agents.main, mx = ma.x, my = ma.y;
    // ambient halo behind main
    var mph = ma.phase, mcol = modelCol(ma.model || s.model);
    // edges
    sub.forEach(function (k) {
      var a = s.agents[k], spawnP = REDUCED ? 1 : clamp((now - a.born) / 750, 0, 1), alive = a.phase !== 'done';
      var A = { x: mx, y: my }, B = { x: a.x, y: a.y };
      var col = modelCol(a.model), dx = (B.x - A.x) * 0.55;
      ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(A.x, A.y);
      var steps = 28, last = Math.max(1, Math.floor(steps * easeOut(spawnP)));
      for (var i = 1; i <= last; i++) { var q = edgePoint(A, B, i / steps); ctx.lineTo(q.x, q.y); }
      ctx.strokeStyle = alive ? rgba(col, 0.55) : rgba(PAL.axis, 0.4);
      ctx.lineWidth = alive ? 2 : 1.4;
      if (alive && !REDUCED) { ctx.setLineDash([2, 7]); ctx.lineDashOffset = -now / 55; } else ctx.setLineDash([]);
      ctx.stroke(); ctx.setLineDash([]);
    });
    // effects: packets, docks, floaters
    var live = [];
    s.fx.forEach(function (f) {
      var age = Date.now() - f.t0;
      if (age > f.dur) return;
      live.push(f);
      var p = age / f.dur;
      if (f.type === 'packet') {
        var from = s.agents[f.from], to = s.agents[f.to];
        if (!from || !to) return;
        var A = f.from === 'main' ? { x: from.x, y: from.y } : { x: from.x, y: from.y }, B = { x: to.x, y: to.y };
        var base = f.from === 'main' ? A : B, other = f.from === 'main' ? B : A;
        var t = easeOut(p); if (f.from !== 'main') t = 1 - t;      // sub -> main travels back along the same edge
        var q = edgePoint({ x: mx, y: my }, { x: f.from === 'main' ? to.x : from.x, y: f.from === 'main' ? to.y : from.y }, t);
        var colr = f.color === 'good' ? PAL.good : PAL.accent;
        for (var tr = 0; tr < 5; tr++) {
          var tt = clamp(f.from === 'main' ? t - tr * 0.035 : t + tr * 0.035, 0, 1), qq = edgePoint({ x: mx, y: my }, { x: f.from === 'main' ? to.x : from.x, y: f.from === 'main' ? to.y : from.y }, tt);
          ctx.fillStyle = rgba(colr, (1 - tr / 5) * 0.55 * (1 - p * 0.4)); ctx.beginPath(); ctx.arc(qq.x, qq.y, 5 - tr * 0.7, 0, 7); ctx.fill();
        }
        ctx.fillStyle = colr; ctx.shadowColor = colr; ctx.shadowBlur = 12; ctx.beginPath(); ctx.arc(q.x, q.y, 4.2, 0, 7); ctx.fill(); ctx.shadowBlur = 0;
      } else if (f.type === 'dock') {
        var ag = s.agents[f.key]; if (!ag) return;
        var col2 = f.ok ? PAL.good : PAL.crit, R0 = (f.key === 'main' ? 28 : 20);
        var rad = R0 + 6 + p * 22;
        ctx.strokeStyle = rgba(col2, (1 - p) * 0.9); ctx.lineWidth = 2.5 * (1 - p) + 0.5; ctx.beginPath(); ctx.arc(ag.x, ag.y, rad, 0, 7); ctx.stroke();
        if (p < 0.5) { var tp = easeOut(p / 0.5); var ang = f.ang == null ? (f.ang = Math.random() * 6.28) : f.ang; var oR = R0 + 22; ctx.fillStyle = rgba(toolCol(f.tool), 1 - tp); ctx.beginPath(); ctx.arc(ag.x + Math.cos(ang) * oR * (1 - tp), ag.y + Math.sin(ang) * oR * (1 - tp), 5 * (1 - tp * 0.5), 0, 7); ctx.fill(); }
        drawIcon(ctx, f.ok ? 'check' : 'cross', ag.x + R0 * 0.78, ag.y - R0 * 0.78, 12, rgba(col2, 1 - p), 3);
      }
    });
    s.fx = live;
    // satellites for running tool calls
    keys.forEach(function (k) {
      var a = s.agents[k], bars = runningBars(s, k);
      bars.slice(0, 5).forEach(function (b, i) {
        var R0 = (k === 'main' ? 28 : 20) + 17 + (i % 2) * 11, ang = (REDUCED ? 0 : now / 1000) * (1.5 + i * 0.22) + i * 2.1 + b.start % 6.28;
        var sx = a.x + Math.cos(ang) * R0, sy = a.y + Math.sin(ang) * R0, col = toolCol(b.tool);
        ctx.strokeStyle = rgba(col, 0.22); ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(a.x, a.y, R0, 0, 7); ctx.stroke();
        var grow = easeOutBack((sn - b.start) / 350 + 0.2);
        ctx.fillStyle = col; ctx.shadowColor = col; ctx.shadowBlur = 8; ctx.beginPath(); ctx.arc(sx, sy, 7.5 * Math.min(1, grow), 0, 7); ctx.fill(); ctx.shadowBlur = 0;
        drawIcon(ctx, toolIconName(b.tool), sx, sy, 10, lum(col) > 0.62 ? '#14121f' : '#fff', 2.6);
        c.hits.push({ cx: sx, cy: sy, r: 10, bar: b });
      });
    });
    // nodes
    keys.forEach(function (k) { drawNode(ctx, s, s.agents[k], now, sn); });
    // empty hint
    if (!sub.length) {
      ctx.fillStyle = PAL.muted; ctx.font = '12.5px ' + FONT; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.textAlign = 'center'; ctx.fillText('No subagents right now', W / 2, H - 30);
      ctx.fillStyle = rgba(PAL.muted, 0.7); ctx.font = '11.5px ' + FONT;
      ctx.fillText('They branch out from the main agent the moment Claude spawns one.', W / 2, H - 13);
    }
    // float labels (real request numbers)
    s.fx.forEach(function (f) {
      if (f.type !== 'float') return;
      var ag = s.agents[f.key]; if (!ag) return;
      var p = (Date.now() - f.t0) / f.dur, R0 = f.key === 'main' ? 28 : 20;
      var a = p < 0.15 ? p / 0.15 : 1 - (p - 0.15) / 0.85;
      ctx.globalAlpha = clamp(a, 0, 1);
      ctx.fillStyle = PAL.ink; ctx.font = '600 12px ' + FONT; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
      var fy = ag.y - R0 - 14 - easeOut(p) * 30;
      ctx.fillText(f.text, ag.x, fy);
      ctx.fillStyle = PAL.muted; ctx.font = '11px ' + FONT; ctx.fillText(f.sub, ag.x, fy + 13);
      ctx.globalAlpha = 1;
    });
    renderNodeLabels(s, keys, pos, c, now);
    // legend
    var lg = '<span><i style="background:' + PAL.accent + ';border-radius:50%"></i>generating</span><span><i style="background:' + PAL.s[3] + '"></i>running a tool</span><span><i style="background:#19c37d;border-radius:50%"></i>waiting</span>';
    setHtml(EL.treeLegend, lg);
  }
  function drawTreeEmpty(ctx, W, H) {
    ctx.fillStyle = PAL.muted; ctx.font = '13px ' + FONT; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('No session selected', W / 2, H / 2);
  }
  function nodeRadius(a) { return a.key === 'main' ? 28 : 20; }
  function drawNode(ctx, s, a, now, sn) {
    var R = nodeRadius(a), x = a.x, y = a.y, col = modelCol(a.model || (a.key === 'main' ? s.model : '')), ph = a.phase;
    var spawnP = a.key === 'main' ? 1 : (REDUCED ? 1 : clamp((now - a.born) / 750, 0, 1));
    var sc = a.key === 'main' ? 1 : easeOutBack(spawnP);
    var fade = ph === 'done' ? (REDUCED ? 0.5 : 0.5 - 0.1 * clamp((now - a.doneAt) / 40000, 0, 1) + 0.5 * (1 - clamp((now - a.doneAt) / 700, 0, 1))) : 1;
    ctx.save(); ctx.globalAlpha = clamp(fade, 0, 1) * clamp(spawnP * 3, 0, 1);
    ctx.translate(x, y); ctx.scale(Math.max(0.01, sc), Math.max(0.01, sc));
    var t = REDUCED ? 0 : now / 1000;
    // phase aura
    if (ph === 'generating') {
      var br = 0.5 + 0.5 * Math.sin(t * 2 * Math.PI / 2.4);
      var rad = R + 10 + 11 * br, g = ctx.createRadialGradient(0, 0, R * 0.6, 0, 0, rad);
      g.addColorStop(0, rgba(col, 0.42 + 0.16 * br)); g.addColorStop(1, rgba(col, 0));
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, rad, 0, 7); ctx.fill();
    } else if (ph === 'tool') {
      var cur = a.currentTool && a.currentTool.tool, tc = cur ? toolCol(cur) : PAL.s[3];
      ctx.lineWidth = 3; ctx.lineCap = 'round'; ctx.strokeStyle = tc; ctx.setLineDash([R * 0.75, R * 0.5]); ctx.lineDashOffset = -t * 46;
      ctx.beginPath(); ctx.arc(0, 0, R + 6, 0, 7); ctx.stroke(); ctx.setLineDash([]);
      ctx.strokeStyle = rgba(tc, 0.3); ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(0, 0, R + 11, 0, 7); ctx.stroke();
    } else if (ph === 'waiting_user') {
      var cb = 0.5 + 0.5 * Math.sin(t * 2 * Math.PI / 5.5);
      ctx.strokeStyle = rgba('#19c37d', 0.18 + 0.2 * cb); ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(0, 0, R + 7 + 2 * cb, 0, 7); ctx.stroke();
    }
    // request pulse ring
    if (a.pulse > 0) {
      var pr = R + 4 + (1 - a.pulse) * 34;
      ctx.strokeStyle = rgba(col, a.pulse * 0.7); ctx.lineWidth = 2.5 * a.pulse + 0.4; ctx.beginPath(); ctx.arc(0, 0, pr, 0, 7); ctx.stroke();
    }
    // body
    ctx.shadowColor = PAL.dark ? 'rgba(0,0,0,0.5)' : 'rgba(20,20,60,0.18)'; ctx.shadowBlur = 10; ctx.shadowOffsetY = 3;
    ctx.fillStyle = PAL.surface; ctx.beginPath(); ctx.arc(0, 0, R, 0, 7); ctx.fill();
    ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
    var bg = ctx.createRadialGradient(-R * 0.3, -R * 0.4, 0, 0, 0, R);
    bg.addColorStop(0, rgba(col, 0.28)); bg.addColorStop(1, rgba(col, 0.06));
    ctx.fillStyle = bg; ctx.beginPath(); ctx.arc(0, 0, R, 0, 7); ctx.fill();
    ctx.strokeStyle = ph === 'done' ? rgba(PAL.axis, 0.9) : col; ctx.lineWidth = a.key === 'main' ? 3 : 2.4; ctx.beginPath(); ctx.arc(0, 0, R, 0, 7); ctx.stroke();
    // glyph
    var gcol = PAL.text, icon;
    if (ph === 'tool') { icon = toolIconName(a.currentTool && a.currentTool.tool); gcol = toolCol(a.currentTool && a.currentTool.tool); if (lum(gcol) > 0.7 && !PAL.dark) gcol = PAL.text; }
    else if (ph === 'generating') { icon = 'sparkle'; gcol = col; }
    else if (ph === 'waiting_user') { icon = 'user'; gcol = '#19c37d'; }
    else if (ph === 'done') { icon = 'check'; gcol = PAL.muted; }
    else { icon = a.key === 'main' ? 'bolt' : 'branch'; gcol = PAL.muted; }
    drawIcon(ctx, icon, 0, 0, a.key === 'main' ? 22 : 16, gcol, 2.2);
    ctx.restore();
    var c = CV.tree; c.hits.push({ cx: x, cy: y, r: R + 6, agent: a });
  }
  var NL = {};
  function renderNodeLabels(s, keys, pos, c, now) {
    var seen = {};
    keys.forEach(function (k) {
      var a = s.agents[k], p = pos[k], R = nodeRadius(a);
      seen[k] = 1;
      var el = NL[s.id + ':' + k];
      if (!el) {
        el = NL[s.id + ':' + k] = document.createElement('div'); el.className = 'lv-nl';
        el.innerHTML = '<div class="a"></div><div class="d"></div><div class="m"></div><span class="st"></span>';
        el._a = el.children[0]; el._d = el.children[1]; el._m = el.children[2]; el._s = el.children[3];
        EL.nodes.appendChild(el);
      }
      el._live = true;
      var narrow = c.w < 520, isMain = k === 'main', mdl = a.model || (isMain ? s.model : '');
      setText(el._a, isMain ? 'Main agent' : (a.agentType || 'Subagent'));
      var d = isMain ? '' : a.desc;
      setText(el._d, d); el._d.style.display = d && !(p.compact && false) ? '' : 'none';
      setHtml(el._m, (mdl ? '<span class="lv-mchip"><i style="background:' + modelCssVar(mdl) + '"></i>' + esc(modelShort(mdl)) + '</span>' : '') + '<span class="cost">' + esc(fmtCost(a.cost, 3)) + '</span><span>· ' + a.requests + ' req</span>');
      var st, cls = 'st';
      if (a.phase === 'generating') st = '● generating ' + fmtSecs(sinceAgent(a));
      else if (a.phase === 'tool') { st = '⚙ ' + esc(a.currentTool ? a.currentTool.tool : 'tool') + ' ' + fmtSecs(serverNow() - (a.currentTool ? a.currentTool.since : a.phaseSince)); cls = 'st tool'; }
      else if (a.phase === 'waiting_user') { st = 'waiting for you'; cls = 'st calm'; }
      else if (a.phase === 'done') { st = '✓ finished'; cls = 'st calm'; }
      else { st = 'idle'; cls = 'st calm'; }
      setText(el._s, st); setAttr(el._s, 'class', cls);
      var w, left, top;
      if (isMain) { w = narrow ? 112 : 170; left = clamp(a.x - w / 2, 4, c.w - w - 4); top = a.y + R + 18; el.style.textAlign = 'center'; el._m.style.justifyContent = 'center'; }
      else { left = a.x + R + 16; top = a.y - 24; w = Math.min(250, c.w - left - 8); el.style.textAlign = 'left'; el._m.style.justifyContent = ''; }
      if (w < 60) el.style.display = 'none'; else el.style.display = '';
      el.style.width = Math.max(60, w) + 'px';
      var op = a.phase === 'done' ? 0.55 : 1, sp = isMain ? 1 : clamp((now - a.born) / 900, 0, 1);
      el.style.opacity = String(op * clamp((sp - 0.3) / 0.7, 0, 1));
      el.style.transform = 'translate(' + Math.round(left) + 'px,' + Math.round(top) + 'px)';
    });
    Object.keys(NL).forEach(function (id) {
      var parts = id.split(':'), k = parts.slice(1).join(':');
      if (parts[0] !== s.id || !seen[k]) { NL[id].remove(); delete NL[id]; }
    });
  }
  function sinceAgent(a) { return serverNow() - Math.max(a.phaseSince || 0, a.lastTs || 0); }
  function treeHover(c, mx, my) {
    for (var i = c.hits.length - 1; i >= 0; i--) {
      var h = c.hits[i], dx = mx - h.cx, dy = my - h.cy;
      if (dx * dx + dy * dy > h.r * h.r) continue;
      if (h.bar) return barTip(h.bar);
      var a = h.agent, s = sel();
      return '<b>' + esc(a.key === 'main' ? 'Main agent' : (a.agentType || 'Subagent')) + '</b> <span class="dim">· ' + esc(modelShort(a.model)) + '</span>' + (a.desc ? '<div>' + esc(a.desc) + '</div>' : '') +
        '<div class="dim">' + a.requests + ' requests · ' + esc(fmtCost(a.cost, 4)) + ' · ' + esc(phaseLabel(a.phase === 'done' ? 'idle' : a.phase)) + (a.phase === 'done' ? ' (finished)' : '') + '</div>' +
        (a.currentTool ? '<code>' + esc(a.currentTool.tool + ' ' + trunc(a.currentTool.summary, 120)) + '</code>' : '');
    }
    return '';
  }

  /* ================================================================== tool swimlanes */
  function barTip(b) {
    var st = b.running ? '<span style="color:#7fd8ff">running · ' + esc(fmtSecs(serverNow() - b.start)) + '</span>' : (b.isError ? '<span style="color:#ff9a9a">✗ failed · ' + esc(fmtDur(b.dur)) + '</span>' : '<span style="color:#7be0b0">✓ ' + esc(fmtDur(b.dur)) + '</span>');
    return '<b>' + esc(b.tool) + '</b> <span class="dim">· ' + hms(b.start - M.skew) + '</span><div>' + st + '</div>' + (b.summary ? '<code>' + esc(trunc(b.summary, 220)) + '</code>' : '');
  }
  function laneAgents(s, sn) {
    var lo = sn - LANE_WIN, out = [];
    s.order.forEach(function (k) {
      var a = s.agents[k]; if (!a) return;
      var bars = s.tools.filter(function (b) { return b.key === k && (b.running || b.end >= lo); });
      var active = a.phase === 'generating' || a.phase === 'tool';
      if (k === 'main' || bars.length || (active && agentVisible(a, Date.now()))) out.push({ a: a, bars: bars });
    });
    return out;
  }
  function drawLanes(now, dt) {
    var c = CV.lanes, ctx = prep(c), W = c.w, H = c.h, s = sel(), sn = serverNow();
    c.hits = [];
    var gut = Math.min(150, Math.max(92, W * 0.22)), L = gut, R = W - 14, T = 4, B = H - 26, pw = R - L;
    var X = function (t) { return R - (sn - t) / LANE_WIN * pw; };
    var lanes = s ? laneAgents(s, sn) : [];
    // axis (relative: static ticks while the bars slide)
    ctx.font = '11px ' + FONT; ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'center';
    [0, 15, 30, 45, 60].forEach(function (sec) {
      var x = R - sec / (LANE_WIN / 1000) * pw;
      ctx.strokeStyle = PAL.grid; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, T); ctx.lineTo(Math.round(x) + 0.5, B + 3); ctx.stroke();
      if (sec < 60) { ctx.fillStyle = PAL.muted; ctx.fillText(sec === 0 ? 'now' : '−' + sec + ' s', x, H - 8); }
    });
    if (!lanes.length) { ctx.fillStyle = PAL.muted; ctx.textAlign = 'center'; ctx.font = '13px ' + FONT; ctx.fillText('No tool calls in the last minute', (L + R) / 2, (T + B) / 2); setHtml(EL.laneLegend, ''); return; }
    var laneH = Math.min(64, (B - T) / lanes.length), usedTools = {};
    lanes.forEach(function (ln, li) {
      var y0 = T + li * laneH, a = ln.a;
      // stripe
      if (li % 2 === 0) { ctx.fillStyle = rgba(PAL.surface2, PAL.dark ? 0.5 : 0.9); rr(ctx, 0, y0 + 1, W, laneH - 2, 8); ctx.fill(); }
      // label
      var col = modelCol(a.model || (a.key === 'main' ? s.model : '')), active = a.phase === 'generating' || a.phase === 'tool';
      ctx.fillStyle = active ? col : rgba(PAL.axis, 0.9); ctx.beginPath(); ctx.arc(14, y0 + laneH / 2, active && !REDUCED ? 3.6 + 1.2 * Math.sin(now / 220) : 3.6, 0, 7); ctx.fill();
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillStyle = PAL.text; ctx.font = '600 12px ' + FONT;
      ctx.fillText(trunc(a.key === 'main' ? 'Main agent' : (a.agentType || 'Subagent'), Math.floor((gut - 34) / 6.6)), 26, y0 + laneH / 2 - (a.key === 'main' || !a.desc ? 0 : 7));
      if (a.key !== 'main' && a.desc) { ctx.fillStyle = PAL.muted; ctx.font = '11px ' + FONT; ctx.fillText(trunc(a.desc, Math.floor((gut - 34) / 5.8)), 26, y0 + laneH / 2 + 8); }
      // bars with row packing
      var rowsEnd = [];
      var sorted = ln.bars.slice().sort(function (p, q) { return p.start - q.start; });
      sorted.forEach(function (b) {
        var r = 0; while (rowsEnd[r] != null && rowsEnd[r] > b.start + 40) r++;
        rowsEnd[r] = b.running ? Infinity : b.end; b._row = r;
      });
      var nRows = Math.min(3, Math.max(1, rowsEnd.length)), barH = Math.min(24, (laneH - 12) / nRows - 2);
      ctx.save(); ctx.beginPath(); ctx.rect(L, y0, pw + 8, laneH); ctx.clip();
      sorted.forEach(function (b) {
        var xs = X(b.start), xe = b.running ? R : X(b.end || b.start);
        if (xe < L) return;
        var rowI = Math.min(2, b._row), by = y0 + (laneH - (nRows * (barH + 2) - 2)) / 2 + rowI * (barH + 2);
        var bx = Math.max(L - 4, xs), bw = Math.max(b.running ? 6 : 5, xe - xs), col2 = toolCol(b.tool);
        usedTools[b.tool] = col2;
        var born = Date.now() - 0, grow = 1;
        ctx.fillStyle = rgba(col2, b.running ? 0.95 : 0.82);
        rr(ctx, bx, by, bw, barH, 5); ctx.fill();
        if (b.running) {
          ctx.save(); rr(ctx, bx, by, bw, barH, 5); ctx.clip();
          ctx.strokeStyle = 'rgba(255,255,255,0.28)'; ctx.lineWidth = 5;
          var off = REDUCED ? 0 : (now / 22) % 20;
          for (var sx = bx - 20 + off; sx < bx + bw + 20; sx += 20) { ctx.beginPath(); ctx.moveTo(sx, by + barH + 2); ctx.lineTo(sx + barH + 4, by - 2); ctx.stroke(); }
          ctx.restore();
          var gl = ctx.createLinearGradient(R - 36, 0, R + 8, 0); gl.addColorStop(0, rgba(col2, 0)); gl.addColorStop(1, rgba(col2, 0.5));
          if (xe >= R - 1) { ctx.fillStyle = gl; ctx.fillRect(R - 36, by - 2, 44, barH + 4); }
        }
        if (b.isError) { ctx.strokeStyle = PAL.crit; ctx.lineWidth = 2; rr(ctx, bx + 1, by + 1, bw - 2, barH - 2, 4); ctx.stroke(); }
        // label
        var tcol = lum(col2) > 0.62 ? '#14121f' : '#ffffff', labelX = Math.max(bx, L) + 7;
        if (bw > 40) {
          ctx.fillStyle = tcol; ctx.font = '600 11px ' + FONT; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
          var txt = b.tool + (b.running && bw > 92 ? '  ' + (((sn - b.start) / 1000).toFixed(1)) + 's' : '');
          ctx.save(); ctx.beginPath(); ctx.rect(bx + 2, by, bw - 4, barH); ctx.clip();
          ctx.fillText(txt, labelX, by + barH / 2 + 0.5);
          if (!b.running && bw > 96) { ctx.textAlign = 'right'; ctx.font = '11px ' + FONT; ctx.fillStyle = rgba(tcol, 0.85); ctx.fillText((b.isError ? '✗ ' : '') + fmtDur(b.dur), bx + bw - 7, by + barH / 2 + 0.5); }
          ctx.restore();
        } else if (b.isError) { drawIcon(ctx, 'cross', bx + bw / 2, by + barH / 2, 10, '#fff', 3); }
        c.hits.push({ x: bx, y: by, w: bw, h: barH, bar: b, rect: true });
      });
      // request ticks on the lane's top edge
      s.reqs.forEach(function (rq) {
        if (rq.ak !== a.key || rq.ts < sn - LANE_WIN || rq.ts > sn + 100) return;
        var rx = X(rq.ts);
        if (rx < L) return;
        ctx.fillStyle = modelCol(rq.model); ctx.beginPath(); ctx.moveTo(rx, y0 + 3); ctx.lineTo(rx + 3.5, y0 + 7.5); ctx.lineTo(rx, y0 + 12); ctx.lineTo(rx - 3.5, y0 + 7.5); ctx.closePath();
        ctx.globalAlpha = 0.9; ctx.fill(); ctx.globalAlpha = 1;
      });
      ctx.restore();
    });
    // now line
    ctx.strokeStyle = rgba(PAL.accent, 0.6); ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(R + 0.5, T); ctx.lineTo(R + 0.5, B + 3); ctx.stroke();
    var lg = Object.keys(usedTools).slice(0, 8).map(function (t) { return '<span><i style="background:' + usedTools[t] + '"></i>' + esc(t) + '</span>'; }).join('') + '<span><i style="background:transparent;border:2px solid var(--critical)"></i>failed</span>';
    setHtml(EL.laneLegend, lg);
  }
  function lanesHover(c, mx, my) {
    for (var i = c.hits.length - 1; i >= 0; i--) { var h = c.hits[i]; if (mx >= h.x && mx <= h.x + h.w && my >= h.y - 2 && my <= h.y + h.h + 2) return barTip(h.bar); }
    return '';
  }

  /* ================================================================== turn card + context gauge */
  var lastPromptSig = '';
  function renderTurn(now, dt) {
    var s = sel(), sn = serverNow();
    if (!s) return;
    var ph = effPhase(s, sn);
    setText(EL.turnPh, ph === 'generating' ? 'Generating' : ph === 'tool' ? 'Running tool' : ph === 'waiting_user' ? 'Waiting for you' : 'Idle');
    setAttr(EL.turnPh, 'data-ph', ph);
    var sig = s.id + '|' + s.promptText + '|' + s.promptId;
    if (sig !== lastPromptSig) {
      var swap = lastPromptSig && lastPromptSig.split('|')[0] === s.id || lastPromptSig !== '';
      lastPromptSig = sig;
      EL.prompt.textContent = s.promptText || 'No prompt captured yet';
      EL.prompt.classList.toggle('muted', !s.promptText);
      if (s.promptId && s.promptText) { EL.prompt.setAttribute('data-prompt', s.promptId); EL.prompt.setAttribute('role', 'button'); EL.prompt.tabIndex = 0; EL.prompt.title = 'Open the prompt and all its requests'; }
      else { EL.prompt.removeAttribute('data-prompt'); EL.prompt.removeAttribute('role'); EL.prompt.removeAttribute('tabindex'); EL.prompt.title = ''; }
      if (!REDUCED) { EL.prompt.classList.remove('swap'); void EL.prompt.offsetWidth; EL.prompt.classList.add('swap'); }
    }
    var tw = s.tw, snapTurn = s._turnStart !== s.turn.startedTs || s.turn.requests < tw.req.t;
    s._turnStart = s.turn.startedTs;
    setTw(tw.req, s.turn.requests, snapTurn); setTw(tw.cost, s.turn.cost, snapTurn); setTw(tw.out, s.turn.output, snapTurn);
    var lim = s.context.limit || 1000000, frac = clamp(s.context.tokens / lim, 0, 1);
    setTw(tw.ctx, frac);
    ['req', 'cost', 'out', 'ctx'].forEach(function (k) { stepTw(tw[k], dt); });
    setText(EL.tsReq, fmtInt(tw.req.c));
    setText(EL.tsCost, fmtCost(tw.cost.c, 3));
    setText(EL.tsOut, fmtInt(tw.out.c));
    var started = s.turn.startedTs || s.promptTs;
    var el = started ? ((ph === 'generating' || ph === 'tool') ? sn - started : Math.max(0, s.lastTs - started)) : 0;
    setText(EL.tsEl, started ? fmtSecs(el) : '—');
    var f = tw.ctx.c, C = 2 * Math.PI * 47;
    EL.ringPg.setAttribute('stroke-dasharray', (C * f).toFixed(2) + ' ' + C.toFixed(2));
    var col = f > 0.85 ? PAL.crit : f > 0.6 ? PAL.warn : PAL.accent;
    EL.ringPg.style.stroke = col; EL.ctxBar.style.background = col;
    EL.ctxBar.style.width = (f * 100).toFixed(2) + '%';
    setText(EL.ringPct, (f * 100 < 10 ? (f * 100).toFixed(1) : Math.round(f * 100)) + '%');
    setText(EL.ctxH, fmtTok(s.context.tokens) + ' of ' + fmtTok(lim) + ' tokens');
  }

  function renderEmpty() {
    var has = Object.keys(M.sessions).length > 0;
    EL.body.hidden = !has;
    EL.empty.hidden = has;
    EL.chips.hidden = !has;
    if (!has) {
      var off = M.conn === 'offline';
      setText(EL.emptyH, !M.haveState ? (off ? 'Can’t reach the server' : 'Connecting…') : 'Waiting for Claude Code…');
      setText(EL.emptyP, off ? 'The live stream is unreachable. Retrying automatically.' : 'Start a session and it appears here instantly: every prompt, tool call, subagent and request, as it happens.');
    }
  }

  /* ================================================================== frame loop */
  var LP = { raf: 0, to: 0, last: 0, text: 0 };
  function renderFrame(dt) {
    var now = Date.now();
    renderEmpty();
    renderChips(now);
    renderHero(now, dt);
    var s = sel();
    if (EL.body.hidden) { drawEcg(now); return; }
    renderTurn(now, dt);
    updateRunningRows(now);
    if (UI.feedN) { UI.feedN = false; setText(EL.feedN, s ? s.feed.length + ' events' : ''); }
    drawEcg(now);
    drawTimeline(now, dt);
    drawTree(now, dt);
    drawLanes(now, dt);
  }
  function loop(ts) {
    LP.raf = 0;
    if (!active || document.hidden) return;
    var t = ts || performance.now();
    var dt = LP.last ? Math.min(0.12, (t - LP.last) / 1000) : 0.016;
    LP.last = t;
    try { renderFrame(dt); } catch (e) { if (window.console) console.error('live render', e); }
    schedule();
  }
  function schedule() {
    if (!active || document.hidden || LP.raf || LP.to) return;
    if (REDUCED) LP.to = setTimeout(function () { LP.to = 0; loop(performance.now()); }, 1000);
    else LP.raf = requestAnimationFrame(loop);
  }
  function stopLoop() {
    if (LP.raf) cancelAnimationFrame(LP.raf);
    if (LP.to) clearTimeout(LP.to);
    LP.raf = LP.to = 0; LP.last = 0;
  }
  var kickT = 0;
  function kick() {
    if (!active || document.hidden || kickT) return;
    kickT = requestAnimationFrame(function () { kickT = 0; try { renderFrame(0.016); } catch (e) { /* ignore */ } });
  }

  /* ================================================================== transport */
  var TR = { es: null, pollT: 0, resyncT: 0, retryT: 0, retries: 0, fails: 0, mode: '' };
  function setConn(m) {
    if (M.conn === m && EL.conn && EL.conn.getAttribute('data-s') === m) return;
    M.conn = m;
    if (!EL.conn) return;
    var labels = { stream: 'Live stream', poll: 'Polling every 1 s', connecting: 'Connecting…', retry: 'Reconnecting…', offline: 'Server unreachable' };
    EL.conn.setAttribute('data-s', m);
    EL.conn.lastChild.textContent = labels[m] || m;
    var btn = $('#view-live-btn');
    if (btn) btn.setAttribute('data-state', m === 'offline' ? 'error' : 'active');
  }
  function parse(d) { try { return JSON.parse(d); } catch (e) { return null; } }
  function onSnapshot(p) {
    if (!p) return;
    var mx = 0;
    (p.sessions || []).forEach(function (ss) { (ss.recent || []).forEach(function (ev) { mx = Math.max(mx, num(ev.id)); }); });
    if (mx && mx < M.maxId - 5) { M.seen = {}; M.seenN = 0; M.maxId = 0; Object.keys(M.sessions).forEach(function (id) { M.sessions[id].feed = []; M.sessions[id].toolEv = {}; M.sessions[id].reqIdx = {}; }); if (built) feedRebuild(); }
    applyState(p, { animate: false, snapshot: true });
    if (built && active && sel() && !FEED.rows[(sel().feed[0] || {}).id]) feedRebuild();
  }
  function onStateMsg(p, poll) {
    applyState(p, { animate: !!poll });
    if (REDUCED) kick();
  }
  function connect() {
    if (!active) return;
    closeStream();
    if (!('EventSource' in window)) { startPolling(); return; }
    setConn(TR.mode === 'poll' ? 'poll' : 'connecting');
    var es;
    try { es = new EventSource('/api/stream'); } catch (e) { startPolling(); return; }
    TR.es = es;
    es.onopen = function () { TR.retries = 0; TR.fails = 0; stopPolling(); setConn('stream'); startResync(); };
    es.addEventListener('snapshot', function (e) { var p = parse(e.data); if (p) { onSnapshot(p); setConn('stream'); stopPolling(); } });
    es.addEventListener('state', function (e) { var p = parse(e.data); if (p) onStateMsg(p, false); });
    es.addEventListener('ev', function (e) {
      var ev = parse(e.data);
      if (!ev) return;
      if (ingest(ev, { counters: true, animate: true })) { pickSelected(); UI.dirty = true; if (REDUCED) kick(); }
    });
    es.onerror = function () {
      TR.retries++;
      setConn('retry');
      if (TR.retries >= 2 || es.readyState === 2) startPolling();
      if (es.readyState === 2) {            // browser gave up (HTTP error / wrong type): retry ourselves with backoff
        closeStream();
        clearTimeout(TR.retryT);
        TR.retryT = setTimeout(connect, Math.min(10000, 1000 * Math.pow(2, Math.min(4, TR.retries))));
      }
    };
  }
  function closeStream() { if (TR.es) { try { TR.es.close(); } catch (e) { /* ignore */ } TR.es = null; } clearInterval(TR.resyncT); TR.resyncT = 0; }
  function pollOnce() {
    return fetch('/api/live/state', { cache: 'no-store' }).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }).then(function (p) {
      TR.fails = 0;
      if (!active) return;
      applyState(p, { animate: TR.mode === 'poll' });
      if (TR.mode === 'poll') setConn('poll');
      if (REDUCED) kick();
    }).catch(function () { TR.fails++; if (TR.fails >= 3 && !TR.es || TR.fails >= 3) setConn('offline'); });
  }
  function startPolling() {
    if (TR.pollT || !active) return;
    TR.mode = 'poll';
    if (!TR.es || TR.es.readyState !== 1) setConn('poll');
    pollOnce();
    TR.pollT = setInterval(pollOnce, 1000);
  }
  function stopPolling() { if (TR.pollT) { clearInterval(TR.pollT); TR.pollT = 0; } TR.mode = 'stream'; }
  function startResync() {              // cheap re-sync so decaying rates stay honest even when no event arrives
    clearInterval(TR.resyncT);
    TR.resyncT = setInterval(function () { if (!document.hidden && active) { fetch('/api/live/state', { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (p) { if (p && active) onStateMsg(p, false); }).catch(function () { /* ignore */ }); } }, 5000);
  }
  function disconnect() {
    closeStream(); stopPolling(); clearTimeout(TR.retryT); TR.retryT = 0; TR.retries = 0; TR.fails = 0; TR.mode = '';
  }

  /* ================================================================== activation */
  var MO = null, onVis = null, onMq = null;
  function setActive(on) {
    on = !!on;
    if (on === active) return;
    active = on;
    if (on) {
      if (!built) build();
      readPal();
      Object.keys(CV).forEach(function (k) { CV[k].dirty = true; });
      observeSizes();
      if (!MO && 'MutationObserver' in window) {
        MO = new MutationObserver(function () { readPal(); UI.dirty = true; if (REDUCED) kick(); });
        MO.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
      }
      onVis = function () { if (!document.hidden && active) { LP.last = 0; Object.keys(CV).forEach(function (k) { CV[k].dirty = true; }); schedule(); } };
      document.addEventListener('visibilitychange', onVis);
      if (mqReduce && mqReduce.addEventListener) { onMq = function () { REDUCED = mqReduce.matches; stopLoop(); schedule(); }; mqReduce.addEventListener('change', onMq); }
      UI.chipSig = ''; lastPromptSig = '';
      feedRebuild();
      connect();
      schedule();
    } else {
      stopLoop(); disconnect();
      if (kickT) { cancelAnimationFrame(kickT); kickT = 0; }
      if (RO) { RO.disconnect(); RO = null; }
      if (MO) { MO.disconnect(); MO = null; }
      if (onVis) { document.removeEventListener('visibilitychange', onVis); onVis = null; }
      if (onMq && mqReduce) { mqReduce.removeEventListener('change', onMq); onMq = null; }
      tipHide();
      var btn = $('#view-live-btn'); if (btn) btn.setAttribute('data-state', 'idle');
    }
  }

  window.CCULive = {
    setActive: setActive,
    status: function () {
      var s = sel(), st = statusOf(s, Date.now());
      return { state: M.conn === 'offline' ? 'error' : (st.ph === 'generating' || st.ph === 'tool' ? 'active' : 'idle'), text: st.ph === 'generating' ? 'Live · Claude is generating' : st.ph === 'tool' ? 'Live · running ' + (st.tool || 'a tool') : st.ph === 'waiting_user' ? 'Live · waiting for you' : (M.conn === 'offline' ? 'Live · server unreachable' : 'Live · idle') };
    },
    // read-only snapshot for debugging / tests
    debug: function () { return { active: active, conn: M.conn, sessions: Object.keys(M.sessions).length, selected: M.selected, raf: !!(LP.raf || LP.to), poll: !!TR.pollT, es: !!TR.es }; }
  };
})();
