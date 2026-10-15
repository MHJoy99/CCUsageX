/* Claude Pulse - desktop widget logic (hosted in Rainmeter via the WebView2 plugin, also opens in any browser).
 * Data: GET /api/limits (polled every 60 s) and GET /api/burn-hours (your measured heavy hours + the US busy-hours band,
 * both configured in config.json > widget). Times are shown in the viewer's own time zone.
 * Test params: ?now=2026-10-14T19:00:00+06:00  ?api=http://127.0.0.1:1 (dead port -> offline state)  ?mode=compact
 *              ?panel=settings  ?bg=forest (dark backdrop for browser tests)  ?s=40&w=75 (override session/weekly %)  ?nostore=1
 *              ?heavy=21:00-03:00 (force a heavy range, server tz = browser tz)  ?still=1 (no motion) */
(function (root) {
  'use strict';

  /* =====================================================================================
   * Schedule model. A window is { tz, days, start, end } with 24-hour "HH:MM" in its own timezone; days uses
   * 0=Sun ... 6=Sat (null = every day); end earlier than start wraps past midnight; daylight saving is automatic (Intl).
   * Status priority: HEAVY (your measured / manual hours) > US BUSY (informational) > OFF-PEAK.
   * The real schedule comes from the server; the built-in fallback below is used if it is old or offline.
   * ===================================================================================== */
  var CONFIG = {
    heavy: [],                                     // [window]  your heavy hours, from /api/burn-hours
    heavyRatio: null,                              // measured drain ratio of the heavy hours (1.3 = 30% faster), null = unknown
    heavyKind: 'none',                             // 'measured' | 'manual' | 'none'
    learn: null,                                   // { days, minDays } while the server is still learning
    official: { label: 'US busy hours', tz: 'America/Los_Angeles', days: [1, 2, 3, 4, 5], start: '05:00', end: '11:00' },
    officialOn: true,
    limitsUrl: '/api/limits',                      // CCUsageX endpoints (same origin as this page)
    burnUrl: '/api/burn-hours',
    pollMs: 60000,                                 // usage refresh
    scheduleMs: 600000,                            // heavy-hours refresh
    retryMs: 15000,                                // retry cadence while the usage server is offline
    amberAt: 70, redAt: 90,                        // ring colour thresholds (percent)
    staleMs: 15 * 60000,
    dashboardUrl: '/#view=live'
  };

  /* ============================ pure schedule logic (no DOM) ============================ */
  var dtfCache = {};
  var DOW = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  function dtf(tz) {
    return dtfCache[tz || ''] || (dtfCache[tz || ''] = new Intl.DateTimeFormat('en-US', {
      timeZone: tz || undefined, weekday: 'short', hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23'
    }));
  }
  function parts(ms, tz) {
    var o = {}, ps = dtf(tz).formatToParts(new Date(ms));
    for (var i = 0; i < ps.length; i++) o[ps[i].type] = ps[i].value;
    return { dow: DOW[o.weekday], h: (+o.hour) % 24, m: +o.minute, s: +o.second };
  }
  function toMin(hhmm) { var a = hhmm.split(':'); return (+a[0]) * 60 + (+a[1]); }
  function inWindow(ms, w) {
    if (!w) return false;
    if (Array.isArray(w)) { for (var i = 0; i < w.length; i++) if (inWindow(ms, w[i])) return true; return false; }
    var p = parts(ms, w.tz), mins = p.h * 60 + p.m, s = toMin(w.start), e = toMin(w.end);
    function ok(d) { return !w.days || w.days.indexOf(d) >= 0; }
    if (s < e) return ok(p.dow) && mins >= s && mins < e;
    return (mins >= s && ok(p.dow)) || (mins < e && ok((p.dow + 6) % 7));
  }
  /* 'heavy' (measured) beats 'usp' (US peak) beats 'off' */
  function stateAt(ms, cfg) {
    cfg = cfg || CONFIG;
    if (inWindow(ms, cfg.heavy)) return 'heavy';
    if (cfg.officialOn && inWindow(ms, cfg.official)) return 'usp';
    return 'off';
  }
  /* first minute (up to 10 days ahead) where the status differs from now */
  function nextChange(ms, cfg) {
    var cur = stateAt(ms, cfg), step = 600000, t = ms;
    for (var i = 0; i < 1440; i++) {
      t += step;
      if (stateAt(t, cfg) !== cur) {
        var lo = t - step, hi = t;
        while (hi - lo > 60000) {
          var mid = Math.floor((lo + hi) / 2 / 60000) * 60000;
          if (mid <= lo) mid = lo + 60000;
          if (mid >= hi) break;
          if (stateAt(mid, cfg) !== cur) hi = mid; else lo = mid;
        }
        return { at: hi, from: cur, to: stateAt(hi, cfg) };
      }
    }
    return null;
  }
  /* wall-clock time of an instant in a zone, written as if it were UTC (ms): the zone's own calendar day and clock */
  var wallDtfCache = {};
  function wallMs(ms, tz) {
    var key = tz || '', f = wallDtfCache[key];
    if (!f) f = wallDtfCache[key] = new Intl.DateTimeFormat('en-US', {
      timeZone: tz || undefined, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23'
    });
    var o = {}, ps = f.formatToParts(new Date(ms));
    for (var i = 0; i < ps.length; i++) o[ps[i].type] = +ps[i].value;
    return Date.UTC(o.year, o.month - 1, o.day, o.hour % 24, o.minute, o.second);
  }
  /* zone offset in ms at an instant: wall clock minus UTC */
  function offsetMs(ms, tz) { return wallMs(ms, tz) - Math.floor(ms / 1000) * 1000; }
  /* the instant of 00:00 on the zone's calendar day that holds ms. The offset is re-read at the candidate instant
   * (twice), so a daylight-saving day that is 23 or 25 hours long still starts at its real local midnight. */
  function dayStartMs(ms, tz) {
    var z = tz || undefined, w = new Date(wallMs(ms, z)), guess = Date.UTC(w.getUTCFullYear(), w.getUTCMonth(), w.getUTCDate()), t = guess;
    for (var i = 0; i < 2; i++) t = guess - offsetMs(t, z);
    return t;
  }
  /* merged [startMin, endMin] intervals (minutes since local midnight) of one window inside the display day */
  function bandsOf(dayStart, w, spanMin) {
    var out = [], cur = null, STEP = 5, n = spanMin / STEP;
    for (var i = 0; i < n; i++) {
      var on = inWindow(dayStart + i * STEP * 60000 + 1000, w);
      if (on && !cur) cur = [i * STEP, i * STEP];
      if (!on && cur) { cur[1] = i * STEP; out.push(cur); cur = null; }
    }
    if (cur) { cur[1] = n * STEP; out.push(cur); }
    return out;
  }
  /* windows that START inside the display day (so a 9 PM-3 AM window reads as one range) */
  function legendOf(dayStart, w) {
    var all = bandsOf(dayStart, w, 36 * 60), res = [];
    for (var i = 0; i < all.length; i++) {
      var b = all[i];
      if (b[0] >= 1440) continue;
      if (b[0] === 0 && inWindow(dayStart - 5 * 60000 + 1000, w)) continue; // began yesterday
      res.push(b);
    }
    return res;
  }
  var H12 = false;
  try { H12 = !!new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).resolvedOptions().hour12; } catch (e) { /* 24 h */ }
  function fmtMin(m, h12) {
    if (h12 === undefined) h12 = H12;
    m = ((m % 1440) + 1440) % 1440;
    var h = Math.floor(m / 60), mm = m % 60, mt = (mm < 10 ? '0' : '') + mm;
    if (!h12) return (h < 10 ? '0' : '') + h + ':' + mt;
    return (h % 12 || 12) + ':' + mt + ' ' + (h >= 12 ? 'PM' : 'AM');
  }
  /* server heavy ranges [{start,end,ratio}] (+ its time zone) -> windows */
  function heavyWindows(ranges, tz) {
    return (ranges || []).map(function (r) { return { tz: tz, days: null, start: r.start, end: r.end }; });
  }
  /* an IANA zone that Intl accepts (any other name throws inside parts() and would stop the widget) */
  function validZone(tz) {
    if (!tz || typeof tz !== 'string') return false;
    try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch (e) { return false; }
  }
  /* a payload that names a zone Intl rejects is ignored as a whole */
  function zonesOk(d) {
    var us = d.usPeak;
    if (us && typeof us === 'object' && us.timeZone && !validZone(us.timeZone)) return false;
    if (d.ok && d.ranges && d.ranges.length && d.timeZone && !validZone(d.timeZone)) return false;
    return true;
  }
  /* can every window of a schedule be evaluated? (a malformed "HH:MM" throws in toMin(), a bad zone in parts()) */
  function evaluates(cfg) {
    try { inWindow(0, cfg.heavy); inWindow(0, cfg.official); return true; } catch (e) { return false; }
  }
  /* the schedule a /api/burn-hours payload gives on top of cfg, or null when the payload must not be used */
  function scheduleFrom(cfg, d) {
    if (!d || typeof d !== 'object' || !zonesOk(d)) return null;
    var next = applySchedule(cfg, d);
    return evaluates(next) ? next : null;
  }
  /* what the widget should show as hours: apply a /api/burn-hours payload to a config (pure, returns a new cfg) */
  function applySchedule(cfg, d) {
    var o = {}, k;
    for (k in cfg) o[k] = cfg[k];
    if (!d || typeof d !== 'object' || !zonesOk(d)) return o;
    var us = d.usPeak;
    if (us && typeof us === 'object') {
      o.officialOn = us.enabled !== false;
      o.official = { label: us.label || 'US busy hours', tz: us.timeZone || 'America/Los_Angeles', days: Array.isArray(us.days) ? us.days : null, start: us.start || '05:00', end: us.end || '11:00' };
    }
    o.heavy = []; o.heavyRatio = null; o.heavyKind = 'none'; o.learn = null;
    if (d.ok && d.ranges && d.ranges.length) {
      o.heavy = heavyWindows(d.ranges, d.timeZone);
      o.heavyKind = d.mode === 'manual' ? 'manual' : 'measured';
      var best = null;
      d.ranges.forEach(function (r) { if (typeof r.ratio === 'number' && (!best || r.ratio > best)) best = r.ratio; });
      o.heavyRatio = best;
    } else if (!d.ok && d.reason === 'need more data') o.learn = { days: d.days || 0, minDays: d.minDays || 3 };
    return o;
  }
  /* the one-line caption under the status chip */
  function captionFor(st, cfg) {
    if (st === 'heavy') {
      if (cfg.heavyKind === 'measured' && typeof cfg.heavyRatio === 'number' && cfg.heavyRatio > 1)
        return 'Your weekly limit drained ~' + Math.round((cfg.heavyRatio - 1) * 100) + '% faster at these hours';
      return cfg.heavyKind === 'manual' ? 'Your heavy hours (set by you)' : 'Your heavy hours';
    }
    if (st === 'usp') return cfg.official.label || 'US busy hours';
    if (cfg.learn) return 'Learning your heavy hours (' + cfg.learn.days + ' of ' + cfg.learn.minDays + ' days)';
    return 'Normal burn rate';
  }
  function fmtDur(ms) {
    var m = Math.max(0, Math.round(ms / 60000));
    if (m < 1) return '<1m';
    var d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
    if (d >= 1) return d + 'd ' + h + 'h';
    if (h >= 1) return h + 'h ' + (mm < 10 ? '0' : '') + mm + 'm';
    return mm + 'm';
  }
  var core = { CONFIG: CONFIG, stateAt: stateAt, nextChange: nextChange, inWindow: inWindow, bandsOf: bandsOf,
    legendOf: legendOf, dayStartMs: dayStartMs, fmtMin: fmtMin, fmtDur: fmtDur, parts: parts, applySchedule: applySchedule,
    captionFor: captionFor, heavyWindows: heavyWindows };
  if (typeof module !== 'undefined' && module.exports) module.exports = core;
  root.PulseCore = core;
  if (typeof document === 'undefined') return;

  /* ================================== DOM / app ================================== */
  var Q = new URLSearchParams(location.search);
  /* ?api= test hook: only an http(s) base is honoured (kept without a trailing slash); anything else means this page's own origin */
  var apiBase = (function () {
    var raw = Q.get('api');
    if (!raw) return '';
    try { var u = new URL(raw); if (u.protocol === 'http:' || u.protocol === 'https:') return u.href.replace(/\/+$/, ''); } catch (e) { /* not a URL */ }
    return '';
  })();
  var $ = function (id) { return document.getElementById(id); };
  var REDUCED = false;
  try { REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { /* ignore */ }
  (Q.get('off') || '').split(',').forEach(function (k) { if (k) document.documentElement.classList.add('no-' + k); }); // ?off=breathe,ping (perf experiments)
  if (Q.get('z')) document.documentElement.classList.add('z' + Q.get('z'));
  if (Q.get('still')) { REDUCED = true; document.documentElement.classList.add('still'); } // ?still=1: no motion (for screenshots in an occluded window)

  /* clock: ?now= shifts the clock but keeps it ticking */
  var clockShift = 0;
  if (Q.get('now')) { var t0 = Date.parse(Q.get('now')); if (!isNaN(t0)) clockShift = t0 - Date.now(); }
  function now() { return Date.now() + clockShift; }

  /* settings (localStorage, wrapped) */
  var KEY = 'mhjoy.claudepulse.v1';
  var DEFAULTS = { mode: 'expanded', show: { peak: true, usp: true, session: true, weekly: true, models: true, pace: true } };
  function loadSettings() {
    var s = JSON.parse(JSON.stringify(DEFAULTS));
    if (Q.get('nostore')) return s;
    try {
      var raw = localStorage.getItem(KEY);
      if (raw) {
        var o = JSON.parse(raw);
        if (o.mode === 'compact' || o.mode === 'expanded') s.mode = o.mode;
        if (o.show) for (var k in s.show) if (typeof o.show[k] === 'boolean') s.show[k] = o.show[k];
      }
    } catch (e) { /* storage unavailable */ }
    return s;
  }
  function saveSettings() { if (Q.get('nostore')) return; try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { /* ignore */ } }
  var S = loadSettings();
  if (Q.get('mode') === 'compact' || Q.get('mode') === 'expanded') S.mode = Q.get('mode');

  var card = $('card'), usage = null, online = null, lastOkAt = 0;

  /* ---------- formatting in the viewer's own time zone and clock style (12 h only if the locale uses it) ---------- */
  var fmtTimeDtf = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
  var fmtWdDtf = new Intl.DateTimeFormat(undefined, { weekday: 'short' });
  function fmtT(ms) { return fmtTimeDtf.format(ms).replace(/[  ]/g, ' '); }
  function fmtWd(ms) { return fmtWdDtf.format(ms); }
  function sameDay(a, b) { return dayStartMs(a) === dayStartMs(b); }
  function fmtAt(ms) { return (sameDay(ms, now()) ? '' : fmtWd(ms) + ' ') + fmtT(ms); }

  /* ---------- tiny helpers ---------- */
  function swapText(el, txt, html) {
    var cur = html ? el.innerHTML : el.textContent;
    if (cur === txt) return;
    if (REDUCED || !el.isConnected) { if (html) el.innerHTML = txt; else el.textContent = txt; return; }
    el.classList.add('swap');
    setTimeout(function () { if (html) el.innerHTML = txt; else el.textContent = txt; el.classList.remove('swap'); }, 200);
  }
  function sev(p) { return p >= CONFIG.redAt ? 'high' : p >= CONFIG.amberAt ? 'warn' : 'ok'; }

  /* ---------- rAF tween (rings + count-up; stops itself when idle) ---------- */
  var tweens = [], raf = 0;
  function spring(t) { return t >= 1 ? 1 : 1 - Math.exp(-8 * t) * Math.cos(6.5 * t); } // gentle spring, ~3% overshoot
  function tick(ts) {
    raf = 0;
    for (var i = tweens.length - 1; i >= 0; i--) {
      var tw = tweens[i];
      if (tw.t0 === null) tw.t0 = ts;
      var k = Math.min(1, (ts - tw.t0) / tw.dur);
      tw.fn(tw.from + (tw.to - tw.from) * spring(k));
      if (k >= 1) { tw.fn(tw.to); tweens.splice(i, 1); }
    }
    if (tweens.length) raf = requestAnimationFrame(tick);
  }
  function tween(key, from, to, dur, fn) {
    for (var i = 0; i < tweens.length; i++) if (tweens[i].key === key) tweens.splice(i, 1);
    if (REDUCED || from === to) { fn(to); return; }
    tweens.push({ key: key, from: from, to: to, dur: dur, fn: fn, t0: null });
    if (!raf) raf = requestAnimationFrame(tick);
  }

  /* ================================ PEAK CLOCK ================================ */
  var C_OUT = 2 * Math.PI * 42, C_IN = 2 * Math.PI * 32;
  var dayCache = { key: 0 };
  var lastState = null, lastAng = null;

  function arcEl(cls, r, sw, a, b, circ) {
    var cap = sw / 2, f = a / 1440, g = b / 1440, len = (g - f) * circ - sw;
    if (len <= 0.5) return '';
    var rot = f * 360 - 90 + (cap / circ) * 360;
    return '<circle class="arc ' + cls + '" cx="60" cy="60" r="' + r + '" fill="none" stroke-width="' + sw + '" stroke-linecap="round" ' +
      'stroke-dasharray="' + len.toFixed(2) + ' ' + circ.toFixed(2) + '" transform="rotate(' + rot.toFixed(2) + ' 60 60)"/>';
  }
  function ensureDay(ms) {
    var ds = dayStartMs(ms);
    if (dayCache.key === ds) return;
    dayCache.key = ds;
    var usOn = CONFIG.officialOn && S.show.usp;
    var meas = bandsOf(ds, CONFIG.heavy, 1440), off = usOn ? bandsOf(ds, CONFIG.official, 1440) : [], html = '', i;
    for (i = 0; i < off.length; i++) html += arcEl('ofc', 32, 5, off[i][0], off[i][1], C_IN);
    for (i = 0; i < meas.length; i++) html += arcEl('hv', 42, 7, meas[i][0], meas[i][1], C_OUT);
    var ticks = '';
    for (i = 0; i < 24; i++) {
      var a = i / 24 * 2 * Math.PI, big = i % 6 === 0, r1 = big ? 47.5 : 48.5, r2 = big ? 52 : 50;
      ticks += '<line class="tick" x1="' + (60 + r1 * Math.sin(a)).toFixed(2) + '" y1="' + (60 - r1 * Math.cos(a)).toFixed(2) +
        '" x2="' + (60 + r2 * Math.sin(a)).toFixed(2) + '" y2="' + (60 - r2 * Math.cos(a)).toFixed(2) + '"/>';
    }
    $('arcs').innerHTML = html;
    document.querySelector('.ticks').innerHTML = ticks;
    var TL = H12 ? ['12A', '6A', '12P', '6P'] : ['00', '06', '12', '18'], tx = document.querySelectorAll('#clockSvg text');
    for (i = 0; i < 4 && i < tx.length; i++) tx[i].textContent = TL[i];
    function lg(list) {
      if (!list.length) return 'none today';
      return list.map(function (b) { return fmtMin(b[0]) + ' – ' + fmtMin(b[1]); }).join(', ');
    }
    var learn = CONFIG.learn;
    $('lgMeasured').textContent = learn ? 'learning ' + learn.days + ' of ' + learn.minDays + ' days' : CONFIG.heavyKind === 'none' ? 'none' : lg(legendOf(ds, CONFIG.heavy));
    $('lgMeasuredL').textContent = CONFIG.heavyKind === 'manual' ? 'Your heavy hours' : learn ? 'Your heavy hours' : 'Your heavy hours (measured)';
    $('lgOfficial').textContent = lg(legendOf(ds, CONFIG.official));
    $('lgOfficialL').textContent = CONFIG.official.label;
    $('lgUs').hidden = !usOn;
  }

  var CHIP = { heavy: 'HEAVY', usp: 'US BUSY', off: 'OFF-PEAK' };
  function effCfg() { var o = {}, k; for (k in CONFIG) o[k] = CONFIG[k]; o.officialOn = CONFIG.officialOn && S.show.usp; return o; }
  function scheduleChanged() { dayCache.key = 0; lastState = null; lastCap = null; renderPeak(false); }
  var lastCap = null;
  function renderPeak(first) {
    var ms = now(), eff = effCfg(), st = stateAt(ms, eff), nc = nextChange(ms, eff);
    ensureDay(ms);
    // hand angle
    var ds = dayCache.key, frac = (ms - ds) / 86400000, ang = frac * 360;
    var hand = $('hand');
    if (lastAng !== null && ang < lastAng - 180) { hand.classList.add('jump'); }
    hand.style.setProperty('--ang', ang.toFixed(2) + 'deg');
    if (first) { hand.classList.add('jump'); requestAnimationFrame(function () { requestAnimationFrame(function () { hand.classList.remove('jump'); }); }); }
    else if (hand.classList.contains('jump') && lastAng !== null && ang < lastAng - 180) setTimeout(function () { hand.classList.remove('jump'); }, 60);
    lastAng = ang;
    // center clock
    var t = fmtT(ms).split(' ');
    $('clockNow').textContent = t[0];
    $('clockAp').textContent = t[1] || '';
    // state
    if (st !== lastState) {
      card.dataset.state = st;
      swapText($('chipText'), CHIP[st]);
      lastState = st;
    }
    var cap = captionFor(st, eff);
    if (cap !== lastCap) { swapText($('cap'), cap); lastCap = cap; }
    // countdown
    var lab = '', val = '--', sub = '';
    if (nc) {
      lab = nc.to === 'heavy' ? 'Heavy hours start in' : st === 'heavy' ? 'Heavy hours end in' : nc.to === 'usp' ? 'US busy hours start in' : 'Off-peak in';
      var d = fmtDur(nc.at - ms);
      val = d.replace(/(\d+)([dhm])/g, '$1<small>$2</small>');
      sub = 'at ' + fmtAt(nc.at);
    }
    swapText($('cdLabel'), lab);
    swapText($('cdSub'), sub);
    var cv = $('cdValue');
    if (cv.innerHTML !== val) { if (first) cv.innerHTML = val; else swapText(cv, val, true); }
  }

  /* ================================ USAGE ================================ */
  var shown = { sess: 0, week: 0 };
  function setTile(key, ids, win, firstTime) {
    var el = $('sec-' + key);
    if (!win || typeof win.usedPct !== 'number') {
      $(ids.num).textContent = '--'; $(ids.r1).textContent = 'No data yet'; $(ids.r2).innerHTML = '&nbsp;'; $(ids.cv).textContent = '--';
      $(ids.rc).textContent = ''; $(ids.da).textContent = ''; $(ids.db).textContent = '';
      return;
    }
    var p = Math.max(0, Math.min(100, win.usedPct)), C = 2 * Math.PI * 42;
    el.dataset.sev = sev(p);
    var arc = $(ids.arc), bar = $(ids.bar), from = shown[ids.k];
    arc.setAttribute('stroke-dasharray', C.toFixed(2));
    tween('t-' + ids.k, firstTime ? 0 : from, p, 1500, function (v) {
      var vv = Math.max(0, v);
      arc.setAttribute('stroke-dashoffset', (C * (1 - vv / 100)).toFixed(2));
      bar.style.transform = 'scaleX(' + Math.min(1, vv / 100).toFixed(4) + ')';
      var r = Math.round(vv);
      $(ids.num).textContent = r;
      $(ids.cv).textContent = r + '%';
    });
    shown[ids.k] = p;
    var rs = win.resetsAt, ms = now();
    var left = rs ? fmtDur(rs - ms) : '';
    if (rs && rs < ms) { $(ids.r1).textContent = 'Resetting'; $(ids.r2).innerHTML = '&nbsp;'; $(ids.rc).textContent = 'Resetting'; }
    else if (rs) {
      if (ids.k === 'sess') {
        $(ids.r1).textContent = 'Resets in ' + left; $(ids.r2).textContent = 'at ' + fmtAt(rs);
      } else {
        $(ids.r1).textContent = 'Resets ' + fmtAt(rs); $(ids.r2).textContent = 'in ' + left;
      }
      $(ids.rc).textContent = 'Resets ' + fmtAt(rs) + '  ·  in ' + left;
    }
    // hover detail
    var a = [], b = [];
    if (rs) a.push('Opened ' + fmtAt(win.startedAt || (rs - win.windowMs)));
    if (typeof win.burnPerHour === 'number') b.push(win.burnPerHour.toFixed(1) + '%/h now');
    if (typeof win.projectedPctAtReset === 'number' && win.burnPerHour > 0) b.push('~' + Math.round(win.projectedPctAtReset) + '% at reset');
    $(ids.da).textContent = a[0] || '';
    $(ids.db).textContent = b.length ? b.join('  ·  ') : (a[0] || '');
  }
  var SESS = { k: 'sess', arc: 'sessArc', bar: 'sessBar', num: 'sessNum', cv: 'sessCv', r1: 'sessR1', r2: 'sessR2', rc: 'sessRc', da: 'sessDA', db: 'sessDB' };
  var WEEK = { k: 'week', arc: 'weekArc', bar: 'weekBar', num: 'weekNum', cv: 'weekCv', r1: 'weekR1', r2: 'weekR2', rc: 'weekRc', da: 'weekDA', db: 'weekDB' };
  var modelShown = {};

  function renderModels(list, firstTime) {
    var el = $('sec-models');
    if (!list || !list.length) { el.dataset.empty = '1'; el.innerHTML = ''; return; }
    el.dataset.empty = '0';
    var html = '<div class="m-cap">Per-model weekly</div>';
    list.forEach(function (m, i) {
      html += '<div class="m-row" data-sev="' + sev(m.usedPct || 0) + '"><b>' + esc(m.label || m.key) + '</b><div class="bar"><i id="mb' + i + '"></i></div><em id="mp' + i + '">0%</em></div>';
    });
    el.innerHTML = html;
    list.forEach(function (m, i) {
      var p = Math.max(0, Math.min(100, m.usedPct || 0)), from = firstTime ? 0 : (modelShown[m.key] || 0);
      tween('m' + i, from, p, 1300, function (v) {
        var b = $('mb' + i), e = $('mp' + i); if (!b) return;
        b.style.transform = 'scaleX(' + Math.min(1, Math.max(0, v) / 100).toFixed(4) + ')'; e.textContent = Math.round(Math.max(0, v)) + '%';
      });
      modelShown[m.key] = p;
    });
  }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  /* pace: only from the server's own burn estimate; omitted when it cannot be stated honestly */
  function renderPace(w) {
    var el = $('sec-pace'), ms = now(), a = '', b = '', sv = 'ok';
    if (w && typeof w.burnPerHour === 'number' && w.burnPerHour > 0.05 && w.resetsAt > ms) {
      if (w.willExceed && w.projectedHitAt && w.projectedHitAt > ms && w.projectedHitAt < w.resetsAt) {
        sv = 'high';
        a = 'At this pace weekly hits 100% in ' + fmtDur(w.projectedHitAt - ms);
        b = fmtAt(w.projectedHitAt) + '  ·  ' + fmtDur(w.resetsAt - w.projectedHitAt) + ' before it resets (estimate)';
      } else if (typeof w.projectedPctAtReset === 'number') {
        sv = w.projectedPctAtReset >= 90 ? 'warn' : 'ok';
        a = 'On pace for about ' + Math.round(w.projectedPctAtReset) + '% by the reset';
        b = w.burnPerHour.toFixed(1) + '% per hour lately (estimate)';
      }
    }
    el.dataset.empty = a ? '0' : '1';
    el.dataset.sev = sv;
    el.style.setProperty('--sev', 'var(--' + sv + ')');
    $('paceA').textContent = a; $('paceB').textContent = b;
  }

  var firstUsage = true;
  function renderUsage() {
    if (!usage) return;
    var w = usage.windows || {};
    var s5 = w.five_hour, s7 = w.seven_day;
    if (Q.get('s') && s5) s5 = Object.assign({}, s5, { usedPct: +Q.get('s') });
    if (Q.get('w') && s7) s7 = Object.assign({}, s7, { usedPct: +Q.get('w') });
    setTile('session', SESS, s5, firstUsage);
    setTile('weekly', WEEK, s7, firstUsage);
    renderModels(w.scoped, firstUsage);
    renderPace(s7);
    firstUsage = false;
    applyVisibility();
  }

  /* ---------- fetching ---------- */
  var pollTimer = 0;
  function fetchLimits() {
    clearTimeout(pollTimer);
    var base = apiBase;
    var ctl = ('AbortController' in window) ? new AbortController() : null;
    var to = setTimeout(function () { if (ctl) ctl.abort(); }, 8000);
    fetch(base + CONFIG.limitsUrl, { cache: 'no-store', signal: ctl ? ctl.signal : undefined })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (d) {
        clearTimeout(to);
        if (d && d.error) throw new Error(d.error);
        var wasOff = online === false;
        usage = d; online = true; lastOkAt = Date.now();
        if (wasOff) firstUsage = true;
        renderUsage(); renderFooter();
        pollTimer = setTimeout(fetchLimits, CONFIG.pollMs);
      })
      .catch(function () {
        clearTimeout(to);
        online = false;
        applyVisibility(); renderFooter();
        pollTimer = setTimeout(fetchLimits, CONFIG.retryMs);
      });
  }
  /* heavy hours + US busy band from the server; the last good answer is cached so an offline/old server keeps the schedule */
  var SKEY = 'ccusagex.pulse.schedule.v1', schedTimer = 0;
  function useSchedule(d, persist) {
    var next = scheduleFrom(CONFIG, d);
    if (!next) return false; // bad zone or malformed times: keep the current schedule and store nothing
    CONFIG = next; core.CONFIG = CONFIG;
    if (persist && !Q.get('nostore')) { try { localStorage.setItem(SKEY, JSON.stringify(d)); } catch (e) { /* ignore */ } }
    scheduleChanged();
    return true;
  }
  function fetchSchedule() {
    clearTimeout(schedTimer);
    var ctl = ('AbortController' in window) ? new AbortController() : null;
    var to = setTimeout(function () { if (ctl) ctl.abort(); }, 8000);
    var delay = CONFIG.retryMs * 4; // retry sooner unless a valid payload arrives
    fetch(apiBase + CONFIG.burnUrl, { cache: 'no-store', signal: ctl ? ctl.signal : undefined })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (d) {
        if (!d || typeof d !== 'object' || d.error) throw new Error('bad');
        if (Q.get('heavy')) { var m = /^(\d\d:\d\d)-(\d\d:\d\d)$/.exec(Q.get('heavy')); if (m) d = Object.assign({}, d, { ok: true, mode: 'measured', timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, ranges: [{ start: m[1], end: m[2], ratio: 1.3 }] }); }
        if (useSchedule(d, true)) delay = CONFIG.scheduleMs;
      })
      .catch(function () { /* old server (404), offline or a bad payload: keep the cached/built-in schedule */ })
      .finally(function () { clearTimeout(to); schedTimer = setTimeout(fetchSchedule, delay); });
  }
  function loadCachedSchedule() {
    if (Q.get('nostore')) return;
    var raw = null;
    try { raw = localStorage.getItem(SKEY); } catch (e) { return; }
    if (!raw) return;
    var next = null;
    try { next = scheduleFrom(CONFIG, JSON.parse(raw)); } catch (e) { next = null; }
    if (next) { CONFIG = next; core.CONFIG = CONFIG; return; }
    try { localStorage.removeItem(SKEY); } catch (e) { /* ignore */ } // unusable cached schedule: discard it
  }
  function renderFooter() {
    var el = $('updated');
    if (online === false) { el.textContent = 'Offline'; el.className = 'stale'; return; }
    if (!usage) { el.textContent = ''; return; }
    var upd = usage.updatedAt || lastOkAt, age = Date.now() - upd;
    if (usage.available === false) { el.textContent = 'Waiting for usage data'; el.className = 'stale'; return; }
    if (age > CONFIG.staleMs) { el.textContent = 'Data ' + fmtDur(age) + ' old'; el.className = 'stale'; }
    else { el.textContent = 'Updated ' + fmtT(upd); el.className = ''; }
  }

  /* ---------- visibility, mode, settings ---------- */
  function applyVisibility() {
    var sh = S.show, off = online === false, nodata = !usage && online !== false;
    card.classList.toggle('mode-compact', S.mode === 'compact');
    card.classList.toggle('mode-expanded', S.mode !== 'compact');
    $('sec-peak').hidden = !sh.peak;
    $('sec-offline').hidden = !off || !(sh.session || sh.weekly || sh.models || sh.pace);
    var showU = !off && !!usage;
    $('usage').hidden = off;
    if (nodata) showU = false;
    $('sec-session').hidden = !sh.session;
    $('sec-weekly').hidden = !sh.weekly;
    var bothOne = (sh.session ? 1 : 0) + (sh.weekly ? 1 : 0);
    $('tiles').hidden = bothOne === 0;
    $('tiles').classList.toggle('one', bothOne === 1);
    $('sec-models').hidden = !(sh.models && showU) || $('sec-models').dataset.empty === '1';
    $('sec-pace').hidden = !(sh.pace && showU) || $('sec-pace').dataset.empty !== '0' || S.mode === 'compact';
    var any = sh.peak || sh.session || sh.weekly || sh.models || sh.pace;
    $('sec-empty').hidden = any;
    // re-trigger the entry animation for sections that just appeared
    ['sec-peak', 'sec-session', 'sec-weekly', 'sec-models', 'sec-pace', 'sec-offline'].forEach(function (id) {
      var e = $(id), vis = !e.hidden;
      if (vis && e._wasHidden) { e.style.animation = 'none'; void e.offsetWidth; e.style.animation = ''; }
      e._wasHidden = !vis;
    });
    reportSize();
  }
  function syncSettingsUI() {
    var ins = document.querySelectorAll('#view-settings input[data-sec]');
    for (var i = 0; i < ins.length; i++) ins[i].checked = !!S.show[ins[i].dataset.sec];
    var bs = document.querySelectorAll('.seg button');
    for (var j = 0; j < bs.length; j++) bs[j].classList.toggle('on', bs[j].dataset.mode === S.mode);
  }
  var inSettings = false;
  function showView(settings) {
    if (settings === inSettings) return;
    inSettings = settings;
    var from = settings ? $('view-main') : $('view-settings'), to = settings ? $('view-settings') : $('view-main');
    from.classList.add('out');
    setTimeout(function () {
      from.hidden = true; from.classList.remove('out');
      to.hidden = false; to.classList.add('out'); void to.offsetWidth; to.classList.remove('out');
      if (settings) syncSettingsUI();
      reportSize();
    }, REDUCED ? 0 : 200);
  }
  $('gear').addEventListener('click', function () { showView(!inSettings); });
  $('done').addEventListener('click', function () { showView(false); });
  document.querySelector('#view-settings').addEventListener('change', function (e) {
    var k = e.target && e.target.dataset && e.target.dataset.sec;
    if (!k) return;
    S.show[k] = e.target.checked; saveSettings(); applyVisibility(); if (k === 'usp') scheduleChanged();
  });
  document.querySelector('.seg').addEventListener('click', function (e) {
    var m = e.target && e.target.dataset && e.target.dataset.mode;
    if (!m) return;
    S.mode = m; saveSettings(); syncSettingsUI(); applyVisibility();
  });
  function dashUrl() { return (apiBase || location.origin) + CONFIG.dashboardUrl; }
  $('open').addEventListener('click', function () {
    if (typeof RainmeterAPI !== 'undefined') { try { RainmeterAPI.Bang('["' + dashUrl() + '"]'); return; } catch (e) { /* fall through */ } }
    window.open(dashUrl(), '_blank');
  });
  $('brand').addEventListener('click', function () { $('open').click(); });

  /* ---------- hover tilt: rAF only while the pointer moves over the card ---------- */
  var tiltRaf = 0, tx = 0, ty = 0, tiltOn = false;
  function applyTilt() {
    tiltRaf = 0;
    card.style.setProperty('--rx', tx.toFixed(2) + 'deg');
    card.style.setProperty('--ry', ty.toFixed(2) + 'deg');
  }
  card.addEventListener('pointermove', function (e) {
    if (REDUCED) return;
    var r = card.getBoundingClientRect();
    ty = ((e.clientX - r.left) / r.width - .5) * 5;
    tx = -((e.clientY - r.top) / r.height - .5) * 5;
    if (!tiltOn) { tiltOn = true; card.classList.add('tilting'); }
    if (!tiltRaf) tiltRaf = requestAnimationFrame(applyTilt);
  });
  card.addEventListener('pointerleave', function () {
    tiltOn = false; card.classList.remove('tilting'); tx = ty = 0;
    if (!tiltRaf) tiltRaf = requestAnimationFrame(applyTilt);
  });

  /* ---------- tell Rainmeter how tall the page is (skin window is resized to fit) ---------- */
  var lastH = 0, sizeTimer = 0;
  function reportSize() {
    clearTimeout(sizeTimer);
    sizeTimer = setTimeout(function () {
      var h = Math.ceil($('stage').getBoundingClientRect().height);
      if (!h || h === lastH) return;
      lastH = h;
      document.title = 'Claude Pulse';
      if (typeof RainmeterAPI !== 'undefined') {
        try { RainmeterAPI.Bang('[!SetVariable H ' + h + '][!UpdateMeasure WebView2][!UpdateMeter *][!Redraw]'); } catch (e) { /* ignore */ }
      }
    }, 80);
  }
  if ('ResizeObserver' in window) new ResizeObserver(reportSize).observe($('stage'));

  /* ---------- boot ---------- */
  if (Q.get('bg') === 'forest') document.body.classList.add('bg-forest');
  // one ping on the now-marker per minute, only while visible (each animated burst costs GPU time in Rainmeter's WebView2)
  setInterval(function () {
    if (document.hidden || REDUCED) return;
    var h = $('hand'); h.classList.add('pinging');
    setTimeout(function () { h.classList.remove('pinging'); }, 2300);
  }, 60000);
  loadCachedSchedule();
  applyVisibility();
  try { renderPeak(true); } catch (e) { /* a schedule that cannot render must not stop the fetches below (the 15 s tick retries) */ }
  fetchLimits();
  fetchSchedule();
  // idle cost: nothing animates continuously; a 15 s tick moves the hand, and while the window is hidden/minimised no work is done
  setInterval(function () { if (document.hidden) return; renderPeak(false); if (usage) { renderFooter(); } }, 15000);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) { renderPeak(false); renderFooter(); } });
  if (Q.get('panel') === 'settings') { inSettings = false; showView(true); }
  // refresh reset countdown texts once a minute without refetching
  setInterval(function () { if (!document.hidden && usage && online) renderUsage(); }, 60000); // rings keep their value (tween no-op)
})(typeof window !== 'undefined' ? window : globalThis);
