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
delete process.env.CCU_LIMITS_PROBE;
fs.mkdirSync(path.join(TMP, 'claude', 'projects'), { recursive: true });
fs.mkdirSync(path.join(TMP, 'data', 'limits'), { recursive: true });
const srv = require('../server.js');
const pulse = require('../public/widget.js');

const MIN = 60e3, HOUR = 3600e3;
const BASE = Date.UTC(2026, 9, 1); // Thu 1 Oct 2026 00:00 UTC; the tests use tz "UTC" so hours are exact

// Account A (reset 1000): 08:00-12:00 at 0.1 %/$ and 21:00-01:00 at 0.2 %/$ every day, a point every 30 minutes, $3 per interval.
// Account B (reset 2000): one point a day at 10:10 (inside A's morning) plus a 5h row with the same t.
function fixture(days) {
  const hist = [], reqs = [];
  let pA = 0;
  const seg = (d, h0, h1, rate) => {
    const t0 = BASE + d * 24 * HOUR + h0 * HOUR, t1 = BASE + d * 24 * HOUR + h1 * HOUR;
    for (let t = t0; t <= t1; t += 30 * MIN) {
      if (t > t0) pA += 3 * rate;
      hist.push({ t, w: '7d', p: pA, r: 1000 }, { t, w: '5h', p: pA % 100, r: 5000 });
      if (t < t1) for (let k = 0; k < 6; k++) reqs.push({ ts: t + k * 5 * MIN, cost: { total: 0.5 } });
    }
  };
  for (let d = 0; d < days; d++) {
    seg(d, 8, 12, 0.1);
    seg(d, 21, 25, 0.2);
    const tb = BASE + d * 24 * HOUR + 10 * HOUR + 10 * MIN;
    hist.push({ t: tb, w: '7d', p: 40 + d, r: 2000 }, { t: tb, w: '5h', p: 10, r: 6000 });
  }
  reqs.sort((a, b) => a.ts - b.ts);
  return { hist, reqs };
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
  assert.ok(o.baselinePctPer100 > 10 && o.baselinePctPer100 < 20, 'baseline ' + o.baselinePctPer100);
  // an hour with no data of its own is never flagged, however its neighbours look
  assert.equal(o.hours[20].n, 0);
  assert.ok(!o.ranges.some((r) => r.start === '20:00'));
});

test('burn-hours: intervals near another account are skipped, never mixed', () => {
  const { hist, reqs } = fixture(5);
  const o = srv.computeBurnHours(hist, reqs, {}, 'UTC');
  assert.equal(o.hours[11].n, 10); // two intervals a day, nothing near B
  assert.equal(o.hours[9].n, 5);   // 09:30-10:00 reaches B's 10:10 point (15 min guard) every day
  assert.equal(o.hours[10].n, 5);  // so does 10:00-10:30
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

test.after(() => {
  try { if (srv.stopLive) srv.stopLive(); } catch { /* ignore */ }
  fs.rmSync(TMP, { recursive: true, force: true });
  setTimeout(() => process.exit(), 50).unref();
});
