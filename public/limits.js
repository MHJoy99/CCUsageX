/* CCUsageX - Plan limits (5-hour session + 7-day weekly window).
 * Data: GET /api/limits (+ SSE `event: limits` and `limits` inside /api/live/state, relayed by live.js via CCULimits.push()).
 * Source of truth is Claude Code's status line (same numbers as /usage); contract in .team/LIMITS.md.
 * Renders into every `[data-limits]` host (cards: "overview" / "live") and the header pill `[data-limits-pill]`.
 * Degrades gracefully: a missing endpoint (404) is shown as "not set up". Reduced-motion safe, no layout shift. */
(function () {
  'use strict';

  var HOUR = 3600000, DAY = 86400000;
  var WINDOWS = [
    { key: 'five_hour', short: '5h', title: 'Session', sub: '5-hour', ms: 5 * HOUR },
    { key: 'seven_day', short: '7d', title: 'Weekly', sub: '7-day', ms: 7 * DAY }
  ];
  var STALE_MS = 15 * 60000;
  var TIP = 'Reported by Claude Code\u2019s status line \u2014 the same numbers as /usage. Claude Code doesn\u2019t expose separate Opus/Sonnet limits.';
  var SETUP_CMD = 'npm run statusline:install';
  var SETUP_JSON = '{\n  "statusLine": {\n    "type": "command",\n    "command": "node \\"/path/to/CCUsageX/scripts/statusline.js\\"",\n    "padding": 0,\n    "refreshInterval": 30\n  }\n}';

  var REDUCED = false, mqReduce = null;
  try { mqReduce = window.matchMedia('(prefers-reduced-motion: reduce)'); REDUCED = mqReduce.matches; } catch (e) { /* ignore */ }
  if (mqReduce && mqReduce.addEventListener) mqReduce.addEventListener('change', function () { REDUCED = mqReduce.matches; });

  /* ------------------------------------------------------------------ model */
  var M = {
    phase: 'loading',        // loading | ok | setup | waiting | nosub | error
    reason: '', stale: false, updatedAt: 0, fetchedAt: 0,
    win: { five_hour: null, seven_day: null }, reset: {}, spend: null, version: 0, sessions: 0
  };
  var TW = {};               // per-window tween {cur, from, to, t0, dur, has}
  WINDOWS.forEach(function (w) { TW[w.key] = { cur: 0, from: 0, to: 0, t0: 0, dur: 0, has: false }; });
  var HOSTS = [];            // {el, kind:'card'|'pill', sig, r:{}}
  var skew = 0;              // server clock - client clock (ms), when the server tells us its time
  function now() { return Date.now() + skew; }

  function num(v) { v = Number(v); return isFinite(v) ? v : 0; }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  function statusOf(p) { return p >= 100 ? 'limit' : p >= 90 ? 'high' : p >= 70 ? 'watch' : 'ok'; }
  var ST_LABEL = { ok: 'Healthy', watch: 'Watch', high: 'High', limit: 'Limit reached' };
  var ST_SHORT = { ok: 'OK', watch: 'Watch', high: 'High', limit: 'Limit' };
  var ST_RANK = { ok: 0, watch: 1, high: 2, limit: 3 };

  function normalizeWindow(w, def) {
    if (!w || typeof w !== 'object') return null;
    var used = num(w.usedPct != null ? w.usedPct : w.used_percentage);
    var resets = num(w.resetsAt != null ? w.resetsAt : w.resets_at);
    if (resets && resets < 1e11) resets *= 1000;             // tolerate epoch seconds
    if (!resets) return null;
    var hist = Array.isArray(w.history) ? w.history.map(function (h) { return { t: num(h.t), p: num(h.p) }; }).filter(function (h) { return h.t > 0; }) : [];
    hist.sort(function (a, b) { return a.t - b.t; });
    return {
      used: clamp(used, 0, 100), resetsAt: resets, windowMs: num(w.windowMs) || def.ms,
      burn: w.burnPerHour == null ? null : num(w.burnPerHour),
      proj: w.projectedPctAtReset == null ? null : num(w.projectedPctAtReset),
      hitAt: w.projectedHitAt ? num(w.projectedHitAt) : null,
      history: hist
    };
  }

  function ingest(p) {
    if (!p || typeof p !== 'object') return;
    if (p.now) skew = num(p.now) - Date.now();
    M.fetchedAt = Date.now();
    var sig = dataSig(p);
    if (sig === M.sig) return;                          // identical payload (live-state polling): nothing to redraw
    M.sig = sig;
    M.version++;
    M.sessions = num(p.sessions);
    M.updatedAt = num(p.updatedAt) || 0;
    M.reason = p.reason || '';
    var ws = p.windows || {};
    var any = false;
    WINDOWS.forEach(function (d) {
      var w = normalizeWindow(ws[d.key], d);
      M.win[d.key] = w;
      if (w) any = true;
    });
    var sl = ws.spend_limit;
    M.spend = sl && typeof sl === 'object' ? {
      used: clamp(num(sl.usedPct != null ? sl.usedPct : sl.used_percentage), 0, 100),
      usd: (sl.usedUsd != null ? sl.usedUsd : sl.used_usd) == null ? null : num(sl.usedUsd != null ? sl.usedUsd : sl.used_usd),
      limit: (sl.limitUsd != null ? sl.limitUsd : sl.limit_usd) == null ? null : num(sl.limitUsd != null ? sl.limitUsd : sl.limit_usd),
      period: sl.period || ''
    } : null;
    M.reset = p.reset && typeof p.reset === 'object' ? p.reset : {};
    if (any || M.spend || Object.keys(M.reset).length) {
      M.phase = 'ok';
      M.stale = M.reason === 'stale' || (M.updatedAt > 0 && now() - M.updatedAt > STALE_MS);
    } else if (p.available === false && M.reason === 'not-subscriber') { M.phase = 'nosub'; M.stale = false; }
    else if (p.available && M.updatedAt) { M.phase = 'nosub'; M.stale = false; }
    else if (p.installed) { M.phase = 'waiting'; M.stale = false; }
    else { M.phase = 'setup'; M.stale = false; }
    WINDOWS.forEach(function (d) { retarget(d.key); });
    paintAll(true);
    kick();
  }

  function dataSig(p) {
    var ws = p.windows || {};
    return JSON.stringify([p.available, p.reason, p.installed, p.stale, p.updatedAt, p.sessions, p.reset || null, Object.keys(ws).map(function (k) {
      var w = ws[k] || {}, h = w.history || [];
      return [k, w.usedPct, w.resetsAt, w.burnPerHour, w.projectedPctAtReset, w.projectedHitAt, w.usedUsd, h.length, h.length ? h[h.length - 1].t : 0];
    })]);
  }

  function retarget(key) {
    var w = M.win[key], t = TW[key];
    var to = w && w.resetsAt > now() ? w.used : 0;
    if (!t.has) { t.has = true; t.cur = REDUCED ? to : 0; }
    t.from = t.cur; t.to = to; t.t0 = performance.now();
    t.dur = REDUCED ? 0 : (Math.abs(to - t.cur) < 0.6 ? 0 : clamp(450 + Math.abs(to - t.cur) * 14, 450, 1300));
    if (!t.dur) t.cur = to;
  }

  /* ------------------------------------------------------------------ formatting */
  var DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  function clock(ms) {
    var d = new Date(ms), h = d.getHours(), m = d.getMinutes();
    return (h % 12 || 12) + ':' + (m < 10 ? '0' : '') + m + '\u202f' + (h < 12 ? 'am' : 'pm');
  }
  function sameDay(a, b) { var x = new Date(a), y = new Date(b); return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate(); }
  function when(ms) {
    var n = now();
    if (sameDay(ms, n)) return clock(ms);
    if (sameDay(ms, n + DAY)) return 'tomorrow ' + clock(ms);
    return DOW[new Date(ms).getDay()] + ' ' + clock(ms);
  }
  function dur(ms, withSec) {
    var s = Math.max(0, Math.floor(ms / 1000));
    var d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60), sec = s % 60;
    if (d > 0) return d + 'd ' + h + 'h ' + (m < 10 ? '0' : '') + m + 'm';
    if (h > 0) return h + 'h ' + (m < 10 ? '0' : '') + m + 'm' + (withSec ? ' <i>' + (sec < 10 ? '0' : '') + sec + 's</i>' : '');
    if (m > 0) return m + 'm ' + (sec < 10 ? '0' : '') + sec + 's';
    return sec + 's';
  }
  function durPlain(ms) { return dur(ms, false).replace(/<[^>]+>/g, ''); }
  function ago(ms) {
    var s = Math.max(0, Math.round(ms / 1000));
    if (s < 5) return 'just now';
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.floor(s / 60) + ' min ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ' + Math.floor(s % 3600 / 60) + 'm ago';
    return Math.floor(s / 86400) + 'd ago';
  }
  function pctText(v, used) {
    if (used > 0 && v < 0.5) return '<1';
    return String(v >= 99.5 && used < 100 ? 99 : Math.round(v));
  }
  function rate(v) { return (v < 10 ? v.toFixed(1) : String(Math.round(v))) + '%/h'; }

  /* ------------------------------------------------------------------ icons (distinct shapes: never colour alone) */
  var IC = {
    ok: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="6.2"/><path d="M5.2 8.3l2 2 3.6-4"/></svg>',
    watch: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="6.2"/><path d="M8 4.8v3.6"/><circle cx="8" cy="11.1" r=".6" fill="currentColor"/></svg>',
    high: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2.2l6.2 11H1.8z"/><path d="M8 6.6v3.2"/><circle cx="8" cy="11.8" r=".6" fill="currentColor"/></svg>',
    limit: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5.2 1.9h5.6l3.3 3.3v5.6l-3.3 3.3H5.2L1.9 10.8V5.2z"/><path d="M5.8 5.8l4.4 4.4M10.2 5.8l-4.4 4.4"/></svg>',
    info: '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><circle cx="8" cy="8" r="6.4"/><path d="M8 7.2v4"/><circle cx="8" cy="4.9" r=".55" fill="currentColor"/></svg>',
    clock: '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><circle cx="8" cy="8" r="6.2"/><path d="M8 4.6V8l2.3 1.5"/></svg>',
    up: '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 11.5L11.5 4M5.5 4H11.5V10"/></svg>',
    flat: '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 8h10M9.5 4.5L13 8l-3.5 3.5"/></svg>',
    down: '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 4.5L11.5 12M5.5 12H11.5V6"/></svg>',
    trend: '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12l4-4 3 2.5L14 4.5M10.5 4.5H14V8"/></svg>',
    copy: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5.2" y="5.2" width="8.3" height="8.3" rx="1.6"/><path d="M10.8 5.2V3.6a1.4 1.4 0 0 0-1.4-1.4H3.6a1.4 1.4 0 0 0-1.4 1.4v5.8a1.4 1.4 0 0 0 1.4 1.4h1.6"/></svg>',
    gauge: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.9 18.4a9 9 0 1 1 14.2 0"/><path d="M12 13.5l3.6-4.6"/><circle cx="12" cy="14" r="1.1" fill="currentColor"/></svg>'
  };

  /* ------------------------------------------------------------------ ring geometry (270 degree gauge, gap at the bottom) */
  var R = 56, CIRC = 2 * Math.PI * R, ARC = CIRC * 0.75;
  function ringSvg(opt) {
    opt = opt || {};
    return '<svg class="lim-svg" viewBox="0 0 140 140" aria-hidden="true">' +
      '<circle class="trk" cx="70" cy="70" r="' + R + '" transform="rotate(135 70 70)" stroke-dasharray="' + ARC.toFixed(2) + ' ' + CIRC.toFixed(2) + '"/>' +
      (opt.plain ? '' : '<circle class="ghost" cx="70" cy="70" r="' + R + '" transform="rotate(135 70 70)" stroke-dasharray="0 ' + CIRC.toFixed(2) + '"/>' +
        '<circle class="val" cx="70" cy="70" r="' + R + '" transform="rotate(135 70 70)" stroke-dasharray="0 ' + CIRC.toFixed(2) + '"/>' +
        '<g class="mark"><line class="mo" x1="' + (70 + R - 9) + '" y1="70" x2="' + (70 + R + 9) + '" y2="70"/><line class="mi" x1="' + (70 + R - 9) + '" y1="70" x2="' + (70 + R + 9) + '" y2="70"/></g>') +
      '</svg>';
  }

  /* ------------------------------------------------------------------ builders */
  function tipHtml() {
    return '<span class="lim-info"><button type="button" class="lim-info-b" aria-label="About these numbers. ' + esc(TIP) + '">' + IC.info + '</button>' +
      '<span class="lim-tip" role="tooltip">' + esc(TIP) + '</span></span>';
  }
  function winLabel(d) { return d.title + ' <i>\u00b7 ' + d.sub + '</i>'; }

  function panelLive(d, st) {
    return '<div class="lim-p" data-k="' + d.key + '" data-kind="live" data-st="' + st + '">' +
      '<div class="lim-ring" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" aria-label="' + d.title + ' ' + d.sub + ' window used">' + ringSvg() +
      '<div class="lim-ring-c"><div class="lim-pct"><b data-pct>0</b><sup>%</sup></div><small>used</small></div></div>' +
      '<div class="lim-main">' +
      '<div class="lim-head"><h4>' + winLabel(d) + '</h4><span class="lim-chip" data-st="' + st + '">' + IC[st] + ST_LABEL[st] + '</span></div>' +
      '<div class="lim-reset"><span class="lim-in">resets in <b data-rin></b></span><span class="lim-at" data-rat></span></div>' +
      '</div>' +
      '<div class="lim-extra"><div class="lim-pace" data-pace></div><div class="lim-proj" data-proj></div><div class="lim-spark" data-spark></div></div>' +
      '</div>';
  }
  function panelIdle(d, kind) {
    var msg = kind === 'reset'
      ? ['Window reset', 'A new window starts with your next message to Claude.']
      : ['Not reported yet', 'Claude Code sends this after the first reply of a session.'];
    return '<div class="lim-p" data-k="' + d.key + '" data-kind="' + kind + '" data-st="idle">' +
      '<div class="lim-ring">' + ringSvg({ plain: true }) + '<div class="lim-ring-c"><div class="lim-pct"><b>' + (kind === 'reset' ? '0' : '\u2014') + '</b>' + (kind === 'reset' ? '<sup>%</sup>' : '') + '</div><small>' + (kind === 'reset' ? 'used' : 'no data') + '</small></div></div>' +
      '<div class="lim-main"><div class="lim-head"><h4>' + winLabel(d) + '</h4><span class="lim-chip" data-st="idle">' + IC.clock + (kind === 'reset' ? 'Reset' : 'Waiting') + '</span></div>' +
      '<div class="lim-reset"><span class="lim-in lim-quiet">' + msg[0] + '</span></div></div>' +
      '<div class="lim-extra"><div class="lim-proj lim-quiet">' + msg[1] + '</div></div></div>';
  }
  function panelSkel(d) {
    return '<div class="lim-p" data-k="' + d.key + '" data-kind="skel" data-st="idle" aria-hidden="true">' +
      '<div class="lim-ring">' + ringSvg({ plain: true }) + '<div class="lim-ring-c"><div class="lim-pct"><b>\u2014</b></div></div></div>' +
      '<div class="lim-main"><div class="lim-head"><h4>' + winLabel(d) + '</h4></div><div class="lim-sk" style="width:62%"></div></div>' +
      '<div class="lim-extra"><div class="lim-sk" style="width:80%"></div><div class="lim-sk" style="width:58%"></div><div class="lim-sk tall"></div></div></div>';
  }

  function ghostRings() {
    return '<div class="lim-ghosts" aria-hidden="true">' + WINDOWS.map(function (d) {
      return '<div class="lim-gh"><div class="lim-ring">' + ringSvg({ plain: true }) + '<div class="lim-ring-c"><div class="lim-pct"><b>\u2014</b></div><small>' + d.short + '</small></div></div></div>';
    }).join('') + '</div>';
  }
  function copyRow(text, label, block) {
    return '<div class="lim-cmd' + (block ? ' block' : '') + '">' + (block ? '<pre><code>' + esc(text) + '</code></pre>' : '<code>' + esc(text) + '</code>') +
      '<button type="button" class="lim-copy" data-copy-text="' + esc(text) + '" aria-label="Copy ' + esc(label) + '">' + IC.copy + '<span>Copy</span></button></div>';
  }
  function setupBody() {
    return '<div class="lim-note">' +
      '<div class="lim-note-ic">' + IC.gauge + '</div>' +
      '<div class="lim-note-t"><h4>Show your plan limits here</h4>' +
      '<p>Claude Code reports your 5-hour and weekly usage to its status line. One command connects CCUsageX to it. It stays on this machine: no login, nothing is sent anywhere.</p>' +
      copyRow(SETUP_CMD, 'setup command', false) +
      '<details class="lim-det"><summary>Or add it to settings.json by hand</summary>' +
      '<p class="lim-sm">In <code>~/.claude/settings.json</code>, with the path to your CCUsageX folder:</p>' + copyRow(SETUP_JSON, 'settings.json snippet', true) + '</details>' +
      '<p class="lim-hint">' + IC.clock + 'Already set up? Numbers appear after Claude\u2019s next reply.</p>' +
      '<p class="lim-hint lim-hint2">Limits are reported by Claude Code\u2019s status line. The VS Code panel doesn’t run status lines, so send a message in <code>claude</code> in a terminal.</p></div>' +
      '</div>' + ghostRings();
  }
  function waitingBody() {
    return '<div class="lim-note">' +
      '<div class="lim-note-ic">' + IC.gauge + '</div>' +
      '<div class="lim-note-t"><h4>Connected — waiting for the first report</h4>' +
      '<p>CCUsageX is set up in Claude Code’s status line. Your 5-hour and weekly usage appear here after Claude’s next reply in the terminal app. The VS Code panel doesn’t run status lines, so it can’t report them.</p>' +
      '<p class="lim-hint">' + IC.clock + 'Run <code>claude</code> in a terminal and send any message.</p></div>' +
      '</div>' + ghostRings();
  }
  function nosubBody() {
    return '<div class="lim-note">' +
      '<div class="lim-note-ic">' + IC.gauge + '</div>' +
      '<div class="lim-note-t"><h4>No plan limits reported yet</h4>' +
      '<p>CCUsageX is receiving Claude Code\u2019s status line, but it hasn\u2019t sent any plan limits. Claude Code only reports 5-hour and weekly limits for <b>Claude Pro and Max</b> subscriptions, and only after the first reply of a session. With an API key there is no plan limit to show; costs on this page stay API-equivalent.</p>' +
      '<p class="lim-hint">' + IC.clock + 'On Pro or Max? Send a message in Claude Code and this fills in.</p></div></div>' + ghostRings();
  }
  function errorBody() {
    return '<div class="lim-note"><div class="lim-note-ic">' + IC.gauge + '</div><div class="lim-note-t"><h4>Can\u2019t load plan limits</h4><p>The CCUsageX server didn\u2019t answer. Retrying automatically.</p></div></div>' + ghostRings();
  }

  function footHtml() {
    return '<div class="lim-foot"><span class="lim-key"><i class="k-mark"></i>Marker = how much of the window has elapsed</span>' +
      '<span class="lim-key"><i class="k-ghost"></i>Faint arc = projected use at the current pace</span>' +
      '<span class="lim-src">Reported by Claude Code\u2019s status line \u00b7 same as /usage</span></div>';
  }

  function cardSig() {
    if (M.phase !== 'ok') return M.phase;
    var n = now();
    return 'ok|' + (M.spend ? 's' : '') + '|' + WINDOWS.map(function (d) {
      var w = M.win[d.key];
      return !w ? (M.reset[d.key] ? 'reset' : 'missing') : w.resetsAt <= n ? 'reset' : 'live:' + statusOf(w.used);
    }).join('|');
  }
  function worstStatus() {
    var worst = 'ok';
    WINDOWS.forEach(function (d) { var w = M.win[d.key]; if (w && w.resetsAt > now()) { var s = statusOf(w.used); if (ST_RANK[s] > ST_RANK[worst]) worst = s; } });
    return worst;
  }

  function buildCard(host, sig) {
    var inner;
    if (M.phase === 'loading') inner = '<div class="lim-grid">' + WINDOWS.map(panelSkel).join('') + '</div>';
    else if (M.phase === 'setup') inner = setupBody();
    else if (M.phase === 'waiting') inner = waitingBody();
    else if (M.phase === 'nosub') inner = nosubBody();
    else if (M.phase === 'error') inner = errorBody();
    else {
      var n = now();
      inner = '<div class="lim-grid">' + WINDOWS.map(function (d) {
        var w = M.win[d.key];
        if (!w) return panelIdle(d, M.reset[d.key] ? 'reset' : 'missing');
        if (w.resetsAt <= n) return panelIdle(d, 'reset');
        return panelLive(d, statusOf(w.used));
      }).join('') + '</div>' + (M.spend ? spendHtml() : '');
    }
    host.el.innerHTML =
      '<div class="lim-top"><div class="lim-title"><h3><span class="sq"></span>Plan limits</h3>' + tipHtml() + '</div>' +
      '<div class="lim-meta" data-meta></div></div>' +
      '<div class="lim-body">' + inner + '</div>' + (M.phase === 'ok' || M.phase === 'loading' ? footHtml() : '');
    host.el.setAttribute('data-phase', M.phase);
    host.sig = sig;
    host.r = { meta: host.el.querySelector('[data-meta]'), panels: {}, spend: host.el.querySelector('[data-spend]') };
    WINDOWS.forEach(function (d) {
      var p = host.el.querySelector('.lim-p[data-k="' + d.key + '"]');
      if (!p) return;
      host.r.panels[d.key] = {
        el: p, kind: p.getAttribute('data-kind'), pct: p.querySelector('[data-pct]'), val: p.querySelector('.val'), ghost: p.querySelector('.ghost'),
        mark: p.querySelector('.mark'), ring: p.querySelector('.lim-ring'), rin: p.querySelector('[data-rin]'), rat: p.querySelector('[data-rat]'),
        pace: p.querySelector('[data-pace]'), proj: p.querySelector('[data-proj]'), spark: p.querySelector('[data-spark]'), sparkV: -1, txt: {}
      };
    });
  }
  function spendHtml() {
    var s = M.spend, st = statusOf(s.used);
    var amt = s.usd != null && s.limit != null ? '$' + s.usd.toFixed(2) + ' of $' + s.limit.toFixed(2) : Math.round(s.used) + '% used';
    return '<div class="lim-spend" data-spend data-st="' + st + '"><span class="lim-spend-l">Spend limit' + (s.period ? ' <i>\u00b7 ' + esc(s.period) + '</i>' : '') + '</span>' +
      '<span class="lim-bar"><b style="width:' + clamp(s.used, 0, 100) + '%"></b></span><span class="lim-spend-v">' + esc(amt) + ' <span class="lim-chip sm" data-st="' + st + '">' + IC[st] + ST_SHORT[st] + '</span></span></div>';
  }

  function buildPill(host, sig) {
    var h;
    if (M.phase === 'loading') h = '<span class="lim-pi lim-pi-skel"><i class="mr"></i><b>Limits</b><span class="v">\u2026</span></span>';
    else if (M.phase === 'ok') {
      h = WINDOWS.map(function (d) {
        var w = M.win[d.key], live = w && w.resetsAt > now();
        var st = live ? statusOf(w.used) : 'idle';
        var alarm = live && (st === 'high' || st === 'limit');
        var zero = !live && (M.reset[d.key] || (w && w.resetsAt <= now()));
        return '<span class="lim-pi" data-k="' + d.key + '" data-st="' + st + '">' + (alarm ? '<span class="ic">' + IC[st] + '</span>' : '<svg class="mr" viewBox="0 0 20 20" aria-hidden="true"><circle class="t" cx="10" cy="10" r="7"/><circle class="v" cx="10" cy="10" r="7" transform="rotate(-90 10 10)" stroke-dasharray="0 44"/></svg>') +
          '<b>' + d.short + '</b><span class="n" data-v>' + (live ? '' : zero ? '0%' : '\u2014') + '</span></span>';
      }).join('') + (M.stale ? '<span class="lim-pi lim-pi-stale" title="Last update is old">' + IC.clock + '</span>' : '');
    } else {
      var lab = M.phase === 'setup' ? 'Set up plan limits' : M.phase === 'waiting' ? 'Limits: waiting for first report' : M.phase === 'nosub' ? 'Limits: Pro/Max only' : 'Limits unavailable';
      h = '<span class="lim-pi lim-pi-off"><svg class="mr" viewBox="0 0 20 20" aria-hidden="true"><circle class="t" cx="10" cy="10" r="7"/></svg><b>' + lab + '</b></span>';
    }
    host.el.innerHTML = h;
    host.sig = sig;
    host.r = { pi: {} };
    WINDOWS.forEach(function (d) {
      var p = host.el.querySelector('.lim-pi[data-k="' + d.key + '"]');
      if (p) host.r.pi[d.key] = { el: p, v: p.querySelector('[data-v]'), txt: '' };
    });
  }
  function pillSig() {
    if (M.phase !== 'ok') return M.phase;
    var n = now();
    return 'ok|' + WINDOWS.map(function (d) { var w = M.win[d.key]; return !w || w.resetsAt <= n ? '-' : statusOf(w.used); }).join('|') + (M.stale ? '|stale' : '');
  }

  /* ------------------------------------------------------------------ paint (cheap, diffed) */
  function setText(obj, key, el, v, html) {
    if (!el || obj.txt[key] === v) return;
    obj.txt[key] = v;
    if (html) el.innerHTML = v; else el.textContent = v;
  }
  function setAttr(el, k, v) { if (el && el.getAttribute(k) !== v) el.setAttribute(k, v); }

  function paintPanel(host, d, tick) {
    var P = host.r.panels[d.key];
    if (!P || P.kind !== 'live') return;
    var w = M.win[d.key], t = TW[d.key], n = now();
    if (!w) return;
    var cur = t.cur, used = w.used;
    var elapsed = clamp(1 - (w.resetsAt - n) / w.windowMs, 0, 1);
    setText(P, 'pct', P.pct, pctText(cur, used));
    setAttr(P.ring, 'aria-valuenow', String(Math.round(used)));
    var vl = ARC * cur / 100;
    P.val.setAttribute('stroke-dasharray', vl.toFixed(2) + ' ' + CIRC.toFixed(2));
    P.val.style.opacity = vl < 0.8 ? '0' : '1';
    var proj = w.proj != null ? clamp(w.proj, 0, 100) : null;
    if (proj != null && proj > used + 0.5 && used < 100) {
      P.ghost.setAttribute('stroke-dasharray', Math.max(0, ARC * (proj - cur) / 100).toFixed(2) + ' ' + CIRC.toFixed(2));
      P.ghost.setAttribute('stroke-dashoffset', (-ARC * cur / 100).toFixed(2));
      P.ghost.style.opacity = '1';
    } else P.ghost.style.opacity = '0';
    P.mark.style.transform = 'rotate(' + (135 + 270 * elapsed).toFixed(2) + 'deg)';
    if (tick || !P.txt.rat) {
      setText(P, 'rin', P.rin, dur(w.resetsAt - n, w.windowMs <= 6 * HOUR), true);
      setText(P, 'rat', P.rat, '(' + when(w.resetsAt) + ')');
      var diff = used - elapsed * 100, pace, ic, cls;
      if (diff > 5) { pace = 'Ahead of pace'; ic = IC.up; cls = 'ahead'; }
      else if (diff < -5) { pace = 'Under pace'; ic = IC.down; cls = 'under'; }
      else { pace = 'On pace'; ic = IC.flat; cls = 'on'; }
      var paceHtml = '<span class="lim-pace-t" data-p="' + cls + '">' + ic + pace + '</span><span class="lim-pace-d">' + Math.round(used) + '% used \u00b7 ' + Math.round(elapsed * 100) + '% of the window gone</span>';
      setText(P, 'pace', P.pace, paceHtml, true);
    }
    if (P.sparkV !== M.version || tick === 'spark') { P.sparkV = M.version; P.spark.innerHTML = sparkHtml(w, !P.drawn); P.drawn = true; }
    var projHtml, burnTxt = w.burn != null && w.burn > 0.05 ? ' <span class="lim-quiet">(+' + rate(w.burn) + ')</span>' : '';
    if (used >= 100) projHtml = '<span class="lim-proj-t" data-p="limit">' + IC.limit + '<span>Limit reached \u2014 usage returns ' + esc(when(w.resetsAt)) + '</span></span>';
    else if (w.hitAt && w.hitAt < w.resetsAt && w.hitAt > n - 60000) projHtml = '<span class="lim-proj-t" data-p="hit">' + IC.trend + '<span>At this pace you\u2019ll hit the limit around <b>' + esc(when(w.hitAt)) + '</b>, before the reset' + burnTxt + '</span></span>';
    else if (proj != null && w.burn != null) projHtml = '<span class="lim-proj-t" data-p="proj">' + IC.trend + '<span>At this pace: <b>~' + Math.round(proj) + '%</b> by reset' + burnTxt + '</span></span>';
    else projHtml = '<span class="lim-proj-t lim-quiet" data-p="none">' + IC.trend + '<span>Projection appears after a few minutes of activity</span></span>';
    setText(P, 'proj', P.proj, projHtml, true);
  }

  function sparkHtml(w, animate) {
    var W = 300, H = 52, start = w.resetsAt - w.windowMs, n = now();
    var pts = w.history.filter(function (h) { return h.t >= start - 60000 && h.t <= n + 60000; }).map(function (h) { return { t: Math.max(h.t, start), p: clamp(h.p, 0, 100) }; });
    var cur = { t: Math.min(M.updatedAt && M.updatedAt >= start ? M.updatedAt : n, n), p: w.used };
    if (!pts.length || pts[pts.length - 1].t < cur.t - 1000) pts.push(cur);
    function X(t) { return clamp((t - start) / w.windowMs, 0, 1) * W; }
    function Y(p) { return H - 3 - (p / 100) * (H - 8); }
    var last = pts[pts.length - 1], lx = X(last.t), ly = Y(last.p);
    var line = '', area = '';
    if (pts.length > 1) {
      line = pts.map(function (q, i) { return (i ? 'L' : 'M') + X(q.t).toFixed(1) + ' ' + Y(q.p).toFixed(1); }).join('');
      area = line + 'L' + lx.toFixed(1) + ' ' + (H - 1) + 'L' + X(pts[0].t).toFixed(1) + ' ' + (H - 1) + 'Z';
    }
    var proj = w.proj != null && w.burn != null && w.used < 100 ? '<path class="pj" d="M' + lx.toFixed(1) + ' ' + ly.toFixed(1) + 'L' + W + ' ' + Y(clamp(w.proj, 0, 100)).toFixed(1) + '"/>' : '';
    var nowX = X(n);
    var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" role="img" aria-label="Usage so far in this window: ' + Math.round(w.used) + '%">' +
      '<path class="g70" d="M0 ' + Y(70).toFixed(1) + 'H' + W + '"/><path class="g100" d="M0 ' + Y(100).toFixed(1) + 'H' + W + '"/>' +
      '<path class="nw" d="M' + nowX.toFixed(1) + ' 2V' + (H - 1) + '"/>' +
      (area ? '<path class="ar" d="' + area + '"/><path class="ln' + (animate ? ' draw' : '') + '" pathLength="1" d="' + line + '"/>' : '') + proj + '</svg>';
    var dotCls = 'lim-dot' + (pts.length < 2 ? ' solo' : '');
    return '<div class="lim-spark-c">' + svg + '<i class="' + dotCls + '" style="left:' + (lx / W * 100).toFixed(2) + '%;top:' + ly.toFixed(1) + 'px"></i></div>' +
      '<div class="lim-spark-ax"><span>' + esc(when(start)) + '</span>' + (pts.length < 2 ? '<span class="mid">History fills in as you work</span>' : '<span class="mid">usage this window</span>') + '<span>' + esc(when(w.resetsAt)) + '</span></div>';
  }

  function metaText() {
    if (M.phase === 'loading') return '';
    if (M.phase !== 'ok') return '';
    var age = M.updatedAt ? now() - M.updatedAt : 0;
    if (!M.updatedAt) return '';
    return (M.stale ? '<span class="lim-chip sm" data-st="stale">' + IC.clock + 'Stale</span>' : '<span class="lim-live-dot" aria-hidden="true"></span>') +
      '<span class="lim-upd"' + (M.stale ? ' title="Plan limits come from Claude Code\u2019s status line, which runs in the terminal app, not the VS Code panel."' : '') + '>' +
      (M.stale ? 'Last update ' + ago(age) + ' \u2014 send a message in terminal <code>claude</code> to refresh' : 'Updated ' + ago(age)) + '</span>';
  }

  function paintPill(host) {
    WINDOWS.forEach(function (d) {
      var P = host.r.pi[d.key], w = M.win[d.key], t = TW[d.key];
      if (!P || !w || w.resetsAt <= now()) return;
      var txt = pctText(t.cur, w.used) + '%';
      if (P.txt !== txt) { P.txt = txt; P.v.textContent = txt; }
      var arc = P.el.querySelector('circle.v');
      if (arc) arc.setAttribute('stroke-dasharray', (44 * t.cur / 100).toFixed(2) + ' 44');
    });
  }

  function paintHost(host, tick) {
    if (host.kind === 'pill') {
      var ps = pillSig();
      if (ps !== host.sig) buildPill(host, ps);
      paintPill(host);
      var stale = M.phase === 'ok' && M.stale;
      setAttr(host.el, 'data-stale', stale ? '1' : '0');
      setAttr(host.el, 'data-worst', M.phase === 'ok' ? worstStatus() : 'idle');
      var lbl = pillLabel();
      setAttr(host.el, 'aria-label', lbl); setAttr(host.el, 'title', lbl + ' \u2014 ' + TIP);
      return;
    }
    var sig = cardSig();
    if (sig !== host.sig) { buildCard(host, sig); tick = true; }
    setAttr(host.el, 'data-worst', M.phase === 'ok' ? worstStatus() : 'idle');
    setAttr(host.el, 'data-stale', M.phase === 'ok' && M.stale ? '1' : '0');
    if (M.phase === 'ok') {
      WINDOWS.forEach(function (d) { paintPanel(host, d, tick); });
      var mt = metaText();
      if (host.r.meta && host.r.metaTxt !== mt) { host.r.metaTxt = mt; host.r.meta.innerHTML = mt; }
    }
  }
  function pillLabel() {
    if (M.phase === 'loading') return 'Plan limits loading';
    if (M.phase === 'setup') return 'Plan limits are not set up. Open the Plan limits card for the setup command.';
    if (M.phase === 'waiting') return 'Plan limits are connected; numbers appear after Claude’s next reply';
    if (M.phase === 'nosub') return 'Plan limits are only reported for Claude Pro and Max plans';
    if (M.phase === 'error') return 'Plan limits unavailable';
    return 'Plan limits: ' + WINDOWS.map(function (d) {
      var w = M.win[d.key];
      return w && w.resetsAt > now() ? d.sub + ' window ' + Math.round(w.used) + ' percent used, ' + ST_LABEL[statusOf(w.used)] : d.sub + ' window not reported';
    }).join('; ');
  }

  function paintAll(force) {
    HOSTS.forEach(function (h) { if (h.el.isConnected) paintHost(h, force ? 'spark' : false); });
  }

  /* ------------------------------------------------------------------ animation + clock */
  var raf = 0;
  function ease(x) { return 1 - Math.pow(1 - x, 3); }
  function frame(ts) {
    raf = 0;
    var busy = false;
    WINDOWS.forEach(function (d) {
      var t = TW[d.key];
      if (t.dur && t.cur !== t.to) {
        var k = clamp((ts - t.t0) / t.dur, 0, 1);
        t.cur = t.from + (t.to - t.from) * ease(k);
        if (k >= 1) { t.cur = t.to; t.dur = 0; } else busy = true;
      }
    });
    paintAll(false);
    if (busy) raf = requestAnimationFrame(frame);
  }
  function kick() { if (!raf) raf = requestAnimationFrame(frame); }

  var ticks = 0;
  setInterval(function () {
    if (document.hidden) return;
    ticks++;
    var expired = false;
    WINDOWS.forEach(function (d) { var w = M.win[d.key]; if (w && w.resetsAt <= now() && TW[d.key].to !== 0) { expired = true; retarget(d.key); } });
    if (M.phase === 'ok' && M.updatedAt) M.stale = M.reason === 'stale' || now() - M.updatedAt > STALE_MS;
    HOSTS.forEach(function (h) { if (h.el.isConnected) paintHost(h, ticks % 30 === 0 ? 'spark' : true); });
    if (expired) kick();
  }, 1000);

  /* ------------------------------------------------------------------ transport */
  var pollT = 0, inflight = false, fails = 0, missing = false;
  function load() {
    if (inflight) return;
    inflight = true;
    fetch('/api/limits', { cache: 'no-store' }).then(function (r) {
      if (r.status === 404) { missing = true; return null; }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      missing = false;
      return r.json();
    }).then(function (p) {
      fails = 0;
      if (p === null) ingest({ available: false, reason: 'no-data', windows: {} });
      else ingest(p);
    }).catch(function () {
      fails++;
      if (M.phase === 'loading' && fails >= 2) { M.phase = 'error'; paintAll(true); }
    }).then(function () { inflight = false; schedule(); });
  }
  function schedule() {
    clearTimeout(pollT);
    var every = missing ? 60000 : (fails ? 8000 : 20000);
    pollT = setTimeout(function () { if (document.hidden) schedule(); else load(); }, every);
  }
  document.addEventListener('visibilitychange', function () { if (!document.hidden && Date.now() - M.fetchedAt > 8000) load(); });

  /* ------------------------------------------------------------------ hosts */
  var tipOpen = null;
  function scan() {
    var cards = document.querySelectorAll('[data-limits]'), pills = document.querySelectorAll('[data-limits-pill]');
    function reg(el, kind) {
      if (HOSTS.some(function (h) { return h.el === el; })) return;
      var h = { el: el, kind: kind, sig: '', r: {} };
      HOSTS.push(h);
      if (kind === 'card') { el.classList.add('lim'); el.setAttribute('aria-label', 'Plan limits'); el.setAttribute('role', 'group'); }
      paintHost(h, true);
    }
    Array.prototype.forEach.call(cards, function (el) { reg(el, 'card'); });
    Array.prototype.forEach.call(pills, function (el) { reg(el, 'pill'); });
    HOSTS = HOSTS.filter(function (h) { return h.el.isConnected; });
  }

  document.addEventListener('click', function (e) {
    var t = e.target;
    var cp = t.closest && t.closest('.lim-copy');
    if (cp) {
      var text = cp.getAttribute('data-copy-text') || '', span = cp.querySelector('span');
      var done = function (ok) {
        span.textContent = ok ? 'Copied' : 'Press Ctrl+C'; cp.setAttribute('data-done', ok ? '1' : '0');
        setTimeout(function () { span.textContent = 'Copy'; cp.removeAttribute('data-done'); }, 1800);
      };
      var fallback = function () {
        try {
          var ta = document.createElement('textarea'); ta.value = text; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;left:-9999px;top:0';
          document.body.appendChild(ta); ta.select(); var ok = document.execCommand('copy'); ta.remove(); done(ok);
        } catch (x) { done(false); }
      };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(function () { done(true); }, fallback); else fallback();
      return;
    }
    var ib = t.closest && t.closest('.lim-info-b');
    if (ib) {
      var box = ib.parentNode, open = box.getAttribute('data-open') === '1';
      if (tipOpen && tipOpen !== box) tipOpen.removeAttribute('data-open');
      if (open) { box.removeAttribute('data-open'); tipOpen = null; } else { box.setAttribute('data-open', '1'); tipOpen = box; }
      return;
    }
    if (tipOpen) { tipOpen.removeAttribute('data-open'); tipOpen = null; }
    var pill = t.closest && t.closest('[data-limits-pill]');
    if (pill) {
      var live = document.body.getAttribute('data-view') === 'live';
      var target = document.querySelector('[data-limits="' + (live ? 'live' : 'overview') + '"]');
      if (target) target.scrollIntoView({ behavior: REDUCED ? 'auto' : 'smooth', block: 'center' });
    }
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && tipOpen) { tipOpen.removeAttribute('data-open'); tipOpen = null; } });

  /* ------------------------------------------------------------------ public API */
  window.CCULimits = {
    push: function (p) { if (p && typeof p === 'object') { missing = false; ingest(p); schedule(); } },
    scan: scan,
    state: function () { return { phase: M.phase, stale: M.stale, windows: M.win, hosts: HOSTS.length }; }
  };

  function init() { scan(); load(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
