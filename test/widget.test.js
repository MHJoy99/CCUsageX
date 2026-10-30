'use strict';
// Run with: node --test test/widget.test.js
// Claude Pulse widget: /api/burn-hours (measured heavy hours) and the widget's schedule/status logic. Synthetic data only.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { performance } = require('perf_hooks');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ccu-widget-'));
process.env.CLAUDE_CONFIG_DIR = path.join(TMP, 'claude');
process.env.CCU_DATA_DIR = path.join(TMP, 'data');
process.env.CCU_START_DATE = '2026-01-01';
// the widget block is re-read from a temp copy, never from the repo's config.json
const WIDGET_FILE = path.join(TMP, 'config.json');
process.env.CCU_WIDGET_CONFIG = WIDGET_FILE;
fs.copyFileSync(path.join(__dirname, '..', 'config.json'), WIDGET_FILE);
delete process.env.CCU_LIMITS_PROBE;
process.env.CCU_SWITCHER_DIR = path.join(TMP, 'switcher'); // never the real ~/.claude-accounts
fs.mkdirSync(path.join(TMP, 'claude', 'projects'), { recursive: true });
fs.mkdirSync(path.join(TMP, 'data', 'limits'), { recursive: true });
const srv = require('../server.js');
const pulse = require('../public/widget.js');

const MIN = 60e3, HOUR = 3600e3;
const BASE = Date.UTC(2026, 9, 1); // Thu 1 Oct 2026 00:00 UTC; the tests use tz "UTC" so hours are exact

// Account A (reset 1000): 08:00-12:00 at 0.01 %/$ and 21:00-01:00 at 0.02 %/$ every day, a point every 30 minutes, $30 per interval.
// Account B (reset 2000): one point a day at 10:10 (inside A's morning) plus a 5h row with the same t.
function fixture(days) {
  const hist = [], reqs = [];
  let pA = 0;
  const seg = (d, h0, h1, rate) => {
    const t0 = BASE + d * 24 * HOUR + h0 * HOUR, t1 = BASE + d * 24 * HOUR + h1 * HOUR;
    for (let t = t0; t <= t1; t += 30 * MIN) {
      if (t > t0) pA += 30 * rate;
      hist.push({ t, w: '7d', p: pA, r: 1000 }, { t, w: '5h', p: pA % 100, r: 5000 });
      if (t < t1) for (let k = 0; k < 6; k++) reqs.push({ ts: t + k * 5 * MIN, cost: { total: 5 } });
    }
  };
  for (let d = 0; d < days; d++) {
    seg(d, 8, 12, 0.01);
    seg(d, 21, 25, 0.02);
    const tb = BASE + d * 24 * HOUR + 10 * HOUR + 10 * MIN;
    hist.push({ t: tb, w: '7d', p: 40 + d, r: 2000 }, { t: tb, w: '5h', p: 10, r: 6000 });
  }
  reqs.sort((a, b) => a.ts - b.ts);
  return { hist, reqs };
}

// writes the widget block of the temp config (starting from the repo's config.json) and moves its mtime forward,
// so two edits inside one clock tick still count as two changes
let widgetBump = 0;
function setWidget(mutate) {
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
  mutate(cfg.widget);
  fs.writeFileSync(WIDGET_FILE, JSON.stringify(cfg, null, 2));
  const when = Date.now() / 1000 + ++widgetBump;
  fs.utimesSync(WIDGET_FILE, when, when);
}

test('burn-hours: finds the known heavy window, wrapping past midnight', () => {
  const { hist, reqs } = fixture(5);
  const o = srv.computeBurnHours(hist, reqs, { mode: 'auto', minDays: 3, threshold: 1.15 }, 'UTC');
  assert.equal(o.ok, true);
  assert.equal(o.mode, 'auto');
  assert.equal(o.timeZone, 'UTC');
  assert.ok(o.days >= 5);
  assert.deepEqual(o.ranges.map((r) => [r.start, r.end]), [['21:00', '01:00']]);
  assert.ok(o.ranges[0].ratio > 1.2 && o.ranges[0].ratio < 1.5, 'ratio ' + o.ranges[0].ratio);
  assert.equal(o.hours.length, 24);
  assert.ok(o.baselinePctPer100 > 1 && o.baselinePctPer100 < 2, 'baseline ' + o.baselinePctPer100);
  // an hour with no data of its own is never flagged, however its neighbours look
  assert.equal(o.hours[20].n, 0);
  assert.ok(!o.ranges.some((r) => r.start === '20:00'));
});

test('burn-hours: work near another account is skipped, never mixed', () => {
  const { hist, reqs } = fixture(5);
  const o = srv.computeBurnHours(hist, reqs, {}, 'UTC');
  // B's 10:10 point (15 min guard) cuts A's morning: 09:30-10:30 is never counted, the rest is, $30 per half hour
  assert.equal(o.hours[9].cost, 150);  // only 09:00-09:30, five days
  assert.equal(o.hours[10].cost, 150); // only 10:30-11:00
  assert.equal(o.hours[11].cost, 300);
  assert.equal(o.hours[10].pctPer100, 1); // A's morning rate (0.01 %/$), nothing of B mixed in
});

test('burn-hours: not enough days -> ok:false, need more data', () => {
  const { hist, reqs } = fixture(1);
  const o = srv.computeBurnHours(hist, reqs, { mode: 'auto', minDays: 3 }, 'UTC');
  assert.equal(o.ok, false);
  assert.equal(o.reason, 'need more data');
  assert.equal(o.days, 2); // the 21:00-01:00 run touches a second calendar day
  assert.equal(o.minDays, 3);
  assert.deepEqual(o.ranges, []);
  assert.equal(srv.computeBurnHours([], [], {}, 'UTC').ok, false);
});

test('burn-hours: manual returns the configured range, off returns none', () => {
  const m = srv.computeBurnHours([], [], { mode: 'manual', manual: { start: '21:00', end: '03:00' } }, 'UTC');
  assert.equal(m.ok, true);
  assert.equal(m.mode, 'manual');
  assert.deepEqual(m.ranges, [{ start: '21:00', end: '03:00', ratio: null }]);
  assert.equal(srv.computeBurnHours([], [], { mode: 'manual', manual: { start: 'x' } }, 'UTC').ok, false);
  const f = fixture(5);
  const off = srv.computeBurnHours(f.hist, f.reqs, { mode: 'off' }, 'UTC');
  assert.equal(off.ok, true);
  assert.deepEqual(off.ranges, []);
});

test('burn-hours: flat usage has no heavy window, and 30k requests stay cheap', () => {
  const hist = [], reqs = [];
  let p = 0;
  for (let d = 0; d < 5; d++) for (let h = 0; h < 24; h++) for (let k = 0; k < 2; k++) {
    const t = BASE + d * 24 * HOUR + h * HOUR + k * 30 * MIN;
    if (hist.length) p += 0.3;
    hist.push({ t, w: '7d', p, r: 1 });
  }
  for (let i = 0; i < 30000; i++) reqs.push({ ts: BASE + i * 14 * 1000, cost: { total: 0.05 } });
  const t0 = performance.now();
  const o = srv.computeBurnHours(hist, reqs, {}, 'UTC');
  const ms = performance.now() - t0;
  assert.equal(o.ok, true);
  assert.deepEqual(o.ranges, []);
  assert.ok(ms < 50, 'took ' + ms.toFixed(1) + ' ms');
});

test('widget status: heavy > US busy > off-peak, DST included', () => {
  const sched = pulse.applySchedule(pulse.CONFIG, {
    ok: true, mode: 'auto', timeZone: 'Asia/Dhaka', ranges: [{ start: '21:00', end: '03:00', ratio: 1.3 }],
    usPeak: { enabled: true, days: [1, 2, 3, 4, 5], start: '05:00', end: '11:00', timeZone: 'America/Los_Angeles', label: 'US busy hours' },
  });
  const at = (iso) => pulse.stateAt(Date.parse(iso), sched);
  assert.equal(at('2026-10-14T22:00:00+06:00'), 'heavy');
  assert.equal(at('2026-10-15T02:59:00+06:00'), 'heavy'); // wraps past midnight
  assert.equal(at('2026-10-15T03:00:00+06:00'), 'off');
  assert.equal(at('2026-10-14T12:00:00+06:00'), 'off');
  // summer time: Wed 14 Oct 05:00-11:00 PDT = 18:00-00:00 in Dhaka
  assert.equal(at('2026-10-14T17:59:00+06:00'), 'off');
  assert.equal(at('2026-10-14T18:00:00+06:00'), 'usp');
  assert.equal(at('2026-10-14T20:59:00+06:00'), 'usp');
  assert.equal(at('2026-10-14T21:00:00+06:00'), 'heavy'); // heavy wins where both apply
  // US clocks go back on Sun 1 Nov: Mon 2 Nov 05:00-11:00 PST = 19:00 Mon - 01:00 Tue in Dhaka (no heavy hours here, so the band shows)
  const us = pulse.applySchedule(sched, { ok: true, mode: 'auto', timeZone: 'Asia/Dhaka', ranges: [], usPeak: { enabled: true, days: [1, 2, 3, 4, 5], start: '05:00', end: '11:00', timeZone: 'America/Los_Angeles' } });
  const atUs = (iso) => pulse.stateAt(Date.parse(iso), us);
  assert.equal(atUs('2026-10-26T17:59:00+06:00'), 'off');  // Mon 26 Oct, still PDT: starts 18:00
  assert.equal(atUs('2026-10-26T18:00:00+06:00'), 'usp');
  assert.equal(atUs('2026-11-02T18:59:00+06:00'), 'off');
  assert.equal(atUs('2026-11-02T19:00:00+06:00'), 'usp');
  assert.equal(atUs('2026-11-03T00:59:00+06:00'), 'usp');
  assert.equal(atUs('2026-11-03T01:00:00+06:00'), 'off');
  // weekends are not busy: Sat 17 Oct 05:00 PDT = 18:00 in Dhaka
  assert.equal(at('2026-10-17T18:30:00+06:00'), 'off');
  // the settings toggle and the server flag turn the band off
  assert.equal(pulse.stateAt(Date.parse('2026-10-14T19:00:00+06:00'), { ...sched, officialOn: false }), 'off');
  const noUs = pulse.applySchedule(sched, { ok: true, mode: 'auto', timeZone: 'Asia/Dhaka', ranges: [], usPeak: { enabled: false } });
  assert.equal(pulse.stateAt(Date.parse('2026-10-14T19:00:00+06:00'), noUs), 'off');
});

test('widget status: next change, captions, old server fallback', () => {
  const sched = pulse.applySchedule(pulse.CONFIG, { ok: true, mode: 'auto', timeZone: 'Asia/Dhaka', ranges: [{ start: '21:00', end: '03:00', ratio: 1.3 }], usPeak: { enabled: false } });
  const nc = pulse.nextChange(Date.parse('2026-10-14T19:00:00+06:00'), sched);
  assert.equal(nc.to, 'heavy');
  assert.equal(nc.at, Date.parse('2026-10-14T21:00:00+06:00'));
  assert.equal(pulse.captionFor('heavy', sched), 'Your weekly limit drained ~30% faster at these hours');
  assert.equal(pulse.captionFor('off', sched), 'Normal burn rate');
  const man = pulse.applySchedule(pulse.CONFIG, { ok: true, mode: 'manual', timeZone: 'UTC', ranges: [{ start: '21:00', end: '03:00', ratio: null }] });
  assert.equal(pulse.captionFor('heavy', man), 'Your heavy hours (set by you)');
  const learn = pulse.applySchedule(pulse.CONFIG, { ok: false, reason: 'need more data', days: 1, minDays: 3 });
  assert.equal(pulse.captionFor('off', learn), 'Learning your heavy hours (1 of 3 days)');
  const old = pulse.applySchedule(pulse.CONFIG, null); // old or offline server: built-in US busy band, no heavy hours
  assert.equal(old.official.start, '05:00');
  assert.equal(old.heavy.length, 0);
});

test('widget times: 24-hour or 12-hour by locale', () => {
  assert.equal(pulse.fmtMin(21 * 60, false), '21:00');
  assert.equal(pulse.fmtMin(21 * 60 + 5, true), '9:05 PM');
  assert.equal(pulse.fmtMin(0, true), '12:00 AM');
});

test('GET /api/burn-hours and the widget files', async () => {
  const server = await srv.start(0);
  const port = server.address().port;
  const get = (p) => new Promise((resolve, reject) => http.get({ port, path: p, host: '127.0.0.1' }, (res) => {
    let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, body: b }));
  }).on('error', reject));
  try {
    const r = await get('/api/burn-hours');
    assert.equal(r.status, 200);
    const j = JSON.parse(r.body);
    assert.equal(j.ok, false);
    assert.equal(j.reason, 'need more data');
    assert.equal(j.usPeak.timeZone, 'America/Los_Angeles');
    assert.deepEqual(j.usPeak.days, [1, 2, 3, 4, 5]);
    assert.equal((await get('/widget.html')).status, 200);
    assert.equal((await get('/widget.js')).status, 200);
  } finally { server.close(); }
});

test('burn-hours: a stretch with an unpriced request is skipped, not counted as $0', () => {
  const { hist, reqs } = fixture(5);
  const base = srv.computeBurnHours(hist, reqs, {}, 'UTC');
  assert.equal(base.hours[8].cost, 300);
  assert.equal(base.hours[9].cost, 150);
  // one request in day 0's 08:00-09:30 stretch has no price (unknown model)
  reqs.find((r) => r.ts === BASE + 8 * HOUR + 5 * MIN).cost = null;
  const o = srv.computeBurnHours(hist, reqs, {}, 'UTC');
  assert.equal(o.ok, true);
  assert.equal(o.hours[8].cost, 240);  // day 0's stretch is gone, its $60 at 08:00-09:00 is not in the total
  assert.equal(o.hours[9].cost, 120);  // nor its $30 at 09:00-09:30
  assert.equal(o.hours[11].cost, 300); // other stretches untouched
});

test('burn-hours: manual start/end must be HH:MM with hours < 24 and minutes < 60', () => {
  const manual = (start, end) => srv.computeBurnHours([], [], { mode: 'manual', manual: { start, end } }, 'UTC');
  for (const [s, e] of [['25:00', '03:00'], ['24:00', '03:00'], ['21:00', '03:60'], ['21:75', '03:00'], ['21', '03:00'], ['21:00', ''], ['', ''], ['x', 'y']]) {
    const o = manual(s, e);
    assert.equal(o.ok, false, `${s} - ${e}`);
    assert.equal(o.reason, 'invalid manual range', `${s} - ${e}`);
    assert.deepEqual(o.ranges, []);
  }
  assert.equal(srv.computeBurnHours([], [], { mode: 'manual' }, 'UTC').reason, 'invalid manual range');
  const edge = manual('23:59', '00:00');
  assert.equal(edge.ok, true);
  assert.deepEqual(edge.ranges, [{ start: '23:59', end: '00:00', ratio: null }]);
  assert.deepEqual(manual('9:05', '10:00').ranges, [{ start: '09:05', end: '10:00', ratio: null }]);
});

test('usPeak.timeZone: an unknown zone falls back to America/Los_Angeles with a warning', () => {
  setWidget((w) => { w.usPeak.timeZone = 'Mars/Olympus_Mons'; });
  let o = srv.burnHoursPayload();
  assert.equal(o.usPeak.timeZone, 'America/Los_Angeles');
  assert.equal(o.usPeak.label, 'US busy hours'); // the rest of the band is kept
  assert.match(o.warning, /Mars\/Olympus_Mons/);
  setWidget((w) => { w.usPeak.timeZone = 'Asia/Dhaka'; });
  o = srv.burnHoursPayload();
  assert.equal(o.usPeak.timeZone, 'Asia/Dhaka');
  assert.equal(o.warning, undefined);
});

test('config.json widget edits apply without a restart (mtime reload, memo invalidated)', async () => {
  const server = srv.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const burn = () => new Promise((resolve, reject) => http.get({ port, path: '/api/burn-hours', host: '127.0.0.1' }, (res) => {
    let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve(JSON.parse(b)));
  }).on('error', reject));
  const manualAt = (start, end) => setWidget((w) => { w.heavyHours.mode = 'manual'; w.heavyHours.manual = { start, end }; });
  try {
    manualAt('21:00', '03:00');
    assert.deepEqual((await burn()).ranges, [{ start: '21:00', end: '03:00', ratio: null }]);
    // same minute and same data: only the file's new mtime can make the response change
    manualAt('08:00', '10:30');
    assert.deepEqual((await burn()).ranges, [{ start: '08:00', end: '10:30', ratio: null }]);
    manualAt('08:00', '25:30');
    const bad = await burn();
    assert.equal(bad.ok, false);
    assert.equal(bad.reason, 'invalid manual range');
    setWidget((w) => { w.usPeak.timeZone = 'Europe/Paris'; });
    const paris = await burn();
    assert.equal(paris.usPeak.timeZone, 'Europe/Paris');
    assert.equal(paris.warning, undefined);
  } finally { server.close(); }
});

test.after(() => {
  try { if (srv.stopLive) srv.stopLive(); } catch { /* ignore */ }
  fs.rmSync(TMP, { recursive: true, force: true });
  setTimeout(() => process.exit(), 50).unref();
});

test('burn-hours: a snapshot flickering down and back up is not counted as new usage', () => {
  // one account at a flat 0.01 %/$ all day; from 21:00 every interval also gets a flicker (p-1 at +10 min, p at +20 min)
  const hist = [], reqs = [];
  let p = 0;
  for (let d = 0; d < 4; d++) {
    for (let h = 0; h < 24; h += 0.5) {
      const t = BASE + d * 24 * HOUR + h * HOUR;
      p += 30 * 0.01;
      hist.push({ t, w: '7d', p, r: 1000 });
      if (h >= 21) hist.push({ t: t + 10 * MIN, w: '7d', p: p - 1, r: 1000 }, { t: t + 20 * MIN, w: '7d', p, r: 1000 });
      for (let k = 0; k < 6; k++) reqs.push({ ts: t + k * 5 * MIN, cost: { total: 5 } });
    }
  }
  hist.push({ t: BASE + 4 * 24 * HOUR, w: '7d', p: p + 0.3, r: 1000 }); // closes the last half hour
  const o = srv.computeBurnHours(hist, reqs, { mode: 'auto', minDays: 3 }, 'UTC');
  assert.equal(o.ok, true);
  assert.deepEqual(o.ranges, []);
  assert.ok(Math.abs(o.hours[22].pctPer100 - o.hours[10].pctPer100) < 0.05, `night ${o.hours[22].pctPer100} vs day ${o.hours[10].pctPer100}`);
});

test('burn-hours: a stretch whose weekly % jumped with almost no local work is dropped', () => {
  const { hist, reqs } = fixture(5);
  // account C every afternoon: +10 points for $60 of local work (used somewhere else at the same time)
  for (let d = 0; d < 5; d++) {
    for (let k = 0; k <= 2; k++) hist.push({ t: BASE + d * 24 * HOUR + 15 * HOUR + k * 30 * MIN, w: '7d', p: d * 20 + k * 5, r: 3000 });
    for (let k = 0; k < 12; k++) reqs.push({ ts: BASE + d * 24 * HOUR + 15 * HOUR + k * 5 * MIN, cost: { total: 5 } });
  }
  reqs.sort((a, b) => a.ts - b.ts);
  const o = srv.computeBurnHours(hist, reqs, { mode: 'auto', minDays: 3 }, 'UTC');
  assert.equal(o.hours[15].cost, 0);
  assert.deepEqual(o.ranges.map((r) => r.start), ['21:00']);
});

// ---------------------------------------------------------------- plan value (synthetic, two accounts)
// Account A (reset RA) works 08:00-11:00 at 0.01 %/$ ($100 per 1%), account B (reset RB) works 15:00-18:00 at 0.02 %/$
// ($50 per 1%), days 0-5; on day 6 only A's morning so far. A point every 30 minutes, $30 of work per interval.
const RA = BASE / 1000 + 8 * 86400, RB = BASE / 1000 + 9.5 * 86400;
function planFixture() {
  const hist = [], reqs = [];
  const p = { [RA]: 0, [RB]: 0 };
  const seg = (d, h0, h1, r, rate) => {
    const t0 = BASE + d * 24 * HOUR + h0 * HOUR, t1 = BASE + d * 24 * HOUR + h1 * HOUR;
    for (let t = t0; t <= t1; t += 30 * MIN) {
      if (t > t0) p[r] += 30 * rate;
      hist.push({ t, w: '7d', p: p[r], r }, { t, w: '5h', p: p[r] % 100, r: r + 7 });
      if (t < t1) for (let k = 0; k < 6; k++) reqs.push({ ts: t + k * 5 * MIN, cost: { total: 5 } });
    }
  };
  for (let d = 0; d < 6; d++) { seg(d, 8, 11, RA, 0.01); seg(d, 15, 18, RB, 0.02); }
  seg(6, 8, 11, RA, 0.01);
  reqs.sort((a, b) => a.ts - b.ts);
  return { hist, reqs, now: BASE + 6 * 24 * HOUR + 12 * HOUR, pA: p[RA], pB: p[RB] };
}

test('plan value: pooled $ per 1%, per-account rates, and every $ goes to the account active at that time', () => {
  const f = planFixture();
  const sw = { profiles: [
    { id: 'aaaaaaaaaaaa', label: 'Alpha', pct: 1, resetsAt: RA * 1000, fetchedAt: f.now - 2 * 24 * HOUR },
    { id: 'bbbbbbbbbbbb', label: 'Beta', pct: f.pB, resetsAt: RB * 1000, fetchedAt: f.now - HOUR },
  ], activeId: 'aaaaaaaaaaaa', activeAt: BASE, weekLimit: 96 };
  const o = srv.computePlanValue(f.hist, f.reqs, sw, f.now, 'UTC', null);
  assert.equal(o.ok, true);
  assert.equal(o.reason, 'measured');
  // pooled: (7 x 1.8 + 6 x 3.6) % over 13 x $180 -> $68.42 per 1%
  assert.ok(Math.abs(o.plan.perPct - 68.42) < 0.05, 'perPct ' + o.plan.perPct);
  assert.equal(o.plan.perWeek, Math.round(o.plan.perPct * 100));
  assert.equal(o.plan.perDay, Math.round(o.plan.perPct * 100 / 7));
  assert.equal(o.plan.thin, true); // two accounts burning at rates 2x apart: wide scatter, so a range is shown
  assert.ok(o.plan.range.lo < o.plan.perWeek && o.plan.range.hi > o.plan.perWeek);
  // today = day 6 (A's morning only), yesterday = A + B, split by the account active at each request
  assert.equal(o.today.cost, 180);
  assert.deepEqual(o.today.split.map((x) => [x.label, x.cost]), [['Alpha', 180]]);
  assert.equal(o.yesterday.cost, 360);
  assert.deepEqual(o.yesterday.split.map((x) => [x.label, x.cost]).sort(), [['Alpha', 180], ['Beta', 180]]);
  assert.equal(o.today.planDays, Math.round(180 / (o.plan.perPct * 100 / 7) * 100) / 100);
  // accounts: own rates, live % (status line newer than the switcher for A), spare $ and the active one
  const [a, b] = o.accounts.list;
  assert.equal(a.label, 'Alpha'); assert.equal(a.active, true); assert.equal(a.source, 'statusline');
  assert.ok(Math.abs(a.pct - f.pA) < 0.1); assert.ok(Math.abs(a.perPct - 100) < 0.5, 'A ' + a.perPct); assert.equal(a.ownRate, true);
  assert.equal(b.label, 'Beta'); assert.equal(b.active, false);
  assert.ok(Math.abs(b.perPct - 50) < 0.5, 'B ' + b.perPct);
  assert.equal(a.spare, Math.round((100 - a.pct) * a.perPct));
  assert.equal(o.accounts.spare, a.spare + b.spare);
  assert.equal(o.accounts.weekLimit, 96);
  assert.ok(Number.isInteger(a.resetsAt) && Number.isInteger(a.updatedAt));
  assert.ok(o.runway && o.runway.accounts === 2);
  assert.equal(o.pace.last24h, 360); // yesterday 15:00-18:00 (B) and this morning (A)
});

test('plan value: without the switcher there is no account list; with too little data it falls back to the last value', () => {
  const f = planFixture();
  const o = srv.computePlanValue(f.hist, f.reqs, null, f.now, 'UTC', null);
  assert.equal(o.accounts, null);
  assert.equal(o.runway.accounts, 1); // only the active account counts
  const none = srv.computePlanValue([], [], null, f.now, 'UTC', null);
  assert.equal(none.ok, false); assert.equal(none.reason, 'need more data'); assert.equal(none.plan, null);
  const last = srv.computePlanValue([], [], null, f.now, 'UTC', { perPct: 12.5, chunks: 20, at: f.now - 3 * 24 * HOUR });
  assert.equal(last.ok, true); assert.equal(last.reason, 'last measured');
  assert.equal(last.plan.stale, true); assert.equal(last.plan.perWeek, 1250); assert.equal(last.plan.measuredAt, f.now - 3 * 24 * HOUR);
  assert.equal(last.plan.range, null);
});

test('plan value: runway drains the active account, then the soonest reset, and each reset refills', () => {
  const now = BASE;
  const acc = (pct, resetH, active) => ({ pct, resetsAt: now + resetH * HOUR, perPct: 10, active });
  // $60 left on A (90% -> 96%), $960 on B, $10/h, no reset inside the run: 6 h + 96 h
  const r1 = srv.pvRunway([acc(90, 150, true), acc(0, 150, false)], 10, now, 96);
  assert.equal(r1.outlasts, false);
  assert.equal(r1.until, now + 102 * HOUR);
  assert.equal(r1.dryUntil, now + 150 * HOUR);
  // A resets at 50 h while B is running: B lasts to 102 h, then A again, past the 7-day horizon
  const r2 = srv.pvRunway([acc(90, 50, true), acc(0, 150, false)], 10, now, 96);
  assert.equal(r2.outlasts, true); assert.equal(r2.until, null);
  assert.deepEqual(r2.fills, [now + 6 * HOUR, now + 102 * HOUR]); // when each account first reaches the cap
  assert.deepEqual(r1.fills, [now + 6 * HOUR, now + 102 * HOUR]);
  assert.equal(srv.pvRunway([acc(10, 50, true)], 0, now, 96), null);
});

test('plan value: forecast from the usual day, the safe $/day, and when each account fills', () => {
  const f = planFixture();
  const sw = { profiles: [
    { id: 'aaaaaaaaaaaa', label: 'Alpha', pct: 1, resetsAt: RA * 1000, fetchedAt: f.now - 2 * 24 * HOUR },
    { id: 'bbbbbbbbbbbb', label: 'Beta', pct: f.pB, resetsAt: RB * 1000, fetchedAt: f.now - HOUR },
  ], activeId: 'aaaaaaaaaaaa', activeAt: BASE, weekLimit: 96 };
  const o = srv.computePlanValue(f.hist, f.reqs, sw, f.now, 'UTC', null);
  assert.equal(o.pace.days, 6); // days 0-5 are full local days; day 6 is today
  assert.equal(o.pace.usualDay, 360); assert.equal(o.pace.heavyDay, 360);
  assert.equal(o.runway.perHour, 15); // the runway runs at the usual pace, not the last 24 h
  assert.ok(['enough', 'tight', 'short'].includes(o.forecast.verdict));
  assert.equal(o.forecast.usualDay, 360);
  const ok = (perDay) => { const r = srv.pvRunway(o.accounts.list, perDay / 24, f.now, 96); return !r || r.outlasts; };
  assert.equal(ok(o.forecast.safeDay), true); assert.equal(ok(o.forecast.safeDay + 1), false);
  assert.equal(o.forecast.verdict === 'short', !ok(360));
  for (const a of o.accounts.list) assert.ok(a.fullAt === null || Number.isInteger(a.fullAt));
  assert.ok(Array.isArray(o.tips) && Array.isArray(o.effort));
});

test('plan value: tips from the logs (effort per prompt with helpers, Opus helpers on Sonnet 5.5, fast mode)', () => {
  const t0 = BASE, reqs = [];
  for (let i = 0; i < 30; i++) {
    reqs.push({ ts: t0 + i * MIN, promptId: 'x' + i, effort: 'xhigh', model: 'claude-opus-5-5', cost: { total: 4 } });
    reqs.push({ ts: t0 + i * MIN + 1, promptId: 'h' + i, effort: 'high', model: 'claude-opus-5-5', cost: { total: 2 } });
  }
  // a helper of a high prompt: counts toward that prompt's cost, and on Sonnet 5.5 ($2/M input) would cost $2 instead of $4
  reqs.push({ ts: t0 + 2 * HOUR, promptId: 'h0', sidechain: true, model: 'claude-opus-5-5', input: 1e6, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, cost: { total: 4 } });
  const o = srv.pvTips(reqs, t0, t0 + 24 * HOUR, 1, 'enough');
  assert.deepEqual(o.effort.map((e) => [e.effort, e.prompts, e.perPrompt]), [['high', 30, 2.13], ['xhigh', 30, 4]]);
  assert.deepEqual(o.tips.map((t) => [t.kind, t.savePerDay]), [['effort', 28], ['helpers', 2]]); // 120 x (1 - 2.13/4) / 2
  assert.match(o.tips[0].text, /^xhigh prompts cost \$4 vs \$2\.13 on high/);
  // same cost per prompt: no saving, one plain note that the higher effort is fine
  const same = reqs.slice(0, 60).map((q) => ({ ...q, cost: { total: 3 } }));
  const s = srv.pvTips(same, t0, t0 + 24 * HOUR, 1, 'enough');
  assert.deepEqual(s.tips.map((t) => [t.kind, t.savePerDay]), [['effort', 0]]);
  // fast mode: half of a 2x request is the surcharge
  const fast = [{ ts: t0, promptId: 'f', effort: 'high', model: 'claude-opus-5-5', speed: 'fast', cost: { total: 20 } }];
  assert.deepEqual(srv.pvTips(fast, t0, t0 + HOUR, 1, 'enough').tips.map((t) => [t.kind, t.savePerDay]), [['fast', 10]]);
  assert.deepEqual(srv.pvTips([], t0, t0 + HOUR, 0, 'enough'), { effort: [], tips: [] });
});

test('plan value: local day bounds (no DST, and a DST change day)', () => {
  assert.equal(srv.pvDayStart(Date.UTC(2026, 9, 30, 3), 'Asia/Dhaka'), Date.UTC(2026, 9, 29, 18));
  assert.equal(srv.pvDayStart(Date.UTC(2026, 9, 29, 17, 59), 'Asia/Dhaka'), Date.UTC(2026, 9, 28, 18));
  // US clocks go back on Sun 1 Nov 2026: local midnight was still PDT (UTC-7)
  assert.equal(srv.pvDayStart(Date.UTC(2026, 10, 1, 20), 'America/Los_Angeles'), Date.UTC(2026, 10, 1, 7));
  assert.equal(srv.pvDayStart(Date.UTC(2026, 9, 1, 0), 'UTC'), Date.UTC(2026, 9, 1));
});

test('plan value: the switcher folder is read for usage numbers and labels only', () => {
  const dir = process.env.CCU_SWITCHER_DIR;
  fs.mkdirSync(path.join(dir, 'profiles'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'profiles', 'aaaaaaaaaaaa.dat'), 'not json');
  const s = Math.floor(Date.now() / 1000);
  fs.writeFileSync(path.join(dir, 'usage.json'), JSON.stringify({
    aaaaaaaaaaaa: { week: { pct: 20, resetsAt: s + 3 * 86400 }, fetchedAt: s - 60 },
    bbbbbbbbbbbb: { week: { pct: 70, resetsAt: s + 86400 }, fetchedAt: s - 30 },
    'not-an-id': { week: { pct: 5, resetsAt: s + 86400 } },
  }));
  fs.writeFileSync(path.join(dir, 'autoswitch.json'), JSON.stringify({ enabled: true, weekLimit: 96, lastSwitchAt: s - 10, lastTo: 'bbbbbbbbbbbb' }));
  fs.writeFileSync(path.join(process.env.CCU_DATA_DIR, 'account-labels.json'), JSON.stringify({ bbbbbbbbbbbb: 'Main' }));
  try {
    const o = srv.planValuePayload();
    assert.equal(o.accounts.count, 2);
    assert.deepEqual(o.accounts.list.map((a) => [a.label, a.active, a.pct]), [['Main', true, 70], ['Account 2', false, 20]]);
    assert.equal(o.accounts.weekLimit, 96);
    assert.equal(o.accounts.list[0].spare, null); // nothing measured yet: no $ figure is invented
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(path.join(process.env.CCU_DATA_DIR, 'account-labels.json'), { force: true });
  }
});

test('GET /api/plan-value and the widget plan helpers', async () => {
  const server = await srv.start(0);
  const port = server.address().port;
  try {
    const r = await new Promise((resolve, reject) => http.get({ port, path: '/api/plan-value', host: '127.0.0.1' }, (res) => {
      let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, body: b }));
    }).on('error', reject));
    assert.equal(r.status, 200);
    const j = JSON.parse(r.body);
    assert.equal(typeof j.ok, 'boolean');
    assert.ok('plan' in j && 'today' in j && 'yesterday' in j && 'accounts' in j);
  } finally { server.close(); }
  assert.equal(pulse.money(1470.4), '$1,470');
  assert.equal(pulse.money(0), '$0');
  assert.equal(pulse.planDaysText(0.93), '93% of a plan-day');
  assert.equal(pulse.planDaysText(2.03), '2.0 plan-days');
  assert.equal(pulse.planDaysText(1.01), '1.0 plan-day');
  assert.equal(pulse.planScale(0.5, 0.9).top, 1.25);
  assert.ok(Math.abs(pulse.planScale(2, 1).tick - 1 / 2.16) < 1e-9);
});
