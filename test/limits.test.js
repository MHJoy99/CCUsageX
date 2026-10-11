'use strict';
// Run with: node --test test/limits.test.js
// Plan usage limits: scripts/statusline.js (stdin -> snapshot files + printed line) and the server side
// (/api/limits, SSE `limits`, /api/live/state). Synthetic data only; temp CLAUDE_CONFIG_DIR / CCU_DATA_DIR.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');
const { performance } = require('perf_hooks');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ccu-limits-'));
const DATA = path.join(TMP, 'data');
process.env.CLAUDE_CONFIG_DIR = path.join(TMP, 'claude');
process.env.CCU_DATA_DIR = DATA;
process.env.CCU_START_DATE = '2026-01-01';
fs.mkdirSync(path.join(TMP, 'claude', 'projects'), { recursive: true });
const srv = require('../server.js');
const sl = require('../scripts/statusline.js');
const SCRIPT = path.join(__dirname, '..', 'scripts', 'statusline.js');

let server;
let port;
const clients = [];
test.before(async () => { server = await srv.start(0); port = server.address().port; });
test.after(() => {
  for (const c of clients) c.destroy();
  server.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

const H = 3600e3;
const MIN = 60e3;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freshDir = () => fs.mkdtempSync(path.join(TMP, 'd-'));
const limitsDir = (d) => path.join(d, 'limits');
const readHist = (d) => fs.readFileSync(path.join(limitsDir(d), 'history.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
const PLAIN = { color: false, ascii: false };

function stdin(o = {}) { // a status line document as documented: seconds for resets_at
  const now = o.now || Date.now();
  const j = { session_id: o.sid || 'sess-1', model: { id: 'claude-opus-5-5', display_name: 'Opus 5.5' }, cwd: '/home/dev/proj', version: '2.1.0',
    workspace: { current_dir: '/home/dev/proj' }, cost: { total_cost_usd: 0.42 }, context_window: { used_percentage: 9 } };
  const rl = {};
  if (o.five !== null) rl.five_hour = { used_percentage: o.five == null ? 23.5 : o.five, resets_at: Math.round((now + (o.fiveIn == null ? 2 * H : o.fiveIn)) / 1000) };
  if (o.seven !== null) rl.seven_day = { used_percentage: o.seven == null ? 41.2 : o.seven, resets_at: Math.round((now + (o.sevenIn == null ? 3 * 24 * H : o.sevenIn)) / 1000) };
  if (o.noLimits) delete j.rate_limits; else j.rate_limits = rl;
  if (o.spend) j.spend_limit = { used_percentage: 30, resets_at: Math.round((now + 10 * 24 * H) / 1000), used_usd: 15, limit_usd: 50, period: 'month' };
  return j;
}

// ---------------------------------------------------------------- statusline.js: stdin variants

test('statusline: full document -> snapshot file, history lines and a clean line', () => {
  const d = freshDir();
  const now = Date.UTC(2026, 5, 1, 12, 0, 0);
  const r = sl.process(JSON.stringify(stdin({ now })), { dataDir: d, now, style: PLAIN });
  assert.match(r.line, /^Opus 5\.5 · 5h ▰▱▱▱▱ 24% ↻\d{1,2}(:\d\d)?[ap]m · 7d 41% ↻\w{3} · ctx 9%$/);
  const snap = JSON.parse(fs.readFileSync(path.join(limitsDir(d), 'sess-1.json'), 'utf8'));
  assert.equal(snap.receivedAt, now);
  assert.equal(snap.sessionId, 'sess-1');
  assert.equal(snap.model.display_name, 'Opus 5.5');
  assert.equal(snap.cwd, '/home/dev/proj');
  assert.equal(snap.rate_limits.five_hour.used_percentage, 23.5);
  assert.equal(snap.cost.total_cost_usd, 0.42);
  assert.equal(snap.context_window.used_percentage, 9);
  const h = readHist(d);
  assert.deepEqual(h.map((x) => [x.t, x.w, x.p]), [[now, '5h', 23.5], [now, '7d', 41.2]]);
  assert.equal(h[0].r, snap.rate_limits.five_hour.resets_at); // epoch seconds as received
});

test('statusline: missing rate_limits (not a subscriber) still records the session and prints a line', () => {
  const d = freshDir();
  const r = sl.process(JSON.stringify(stdin({ noLimits: true })), { dataDir: d, style: PLAIN });
  assert.equal(r.line, 'Opus 5.5 · ctx 9%');
  const snap = JSON.parse(fs.readFileSync(path.join(limitsDir(d), 'sess-1.json'), 'utf8'));
  assert.equal(snap.rate_limits, undefined);
  assert.equal(fs.existsSync(path.join(limitsDir(d), 'history.jsonl')), false);
});

test('statusline: one window only', () => {
  const d = freshDir();
  const r = sl.process(JSON.stringify(stdin({ seven: null })), { dataDir: d, style: PLAIN });
  assert.match(r.line, /5h ▰▱▱▱▱ 24%/);
  assert.doesNotMatch(r.line, /7d/);
  const snap = JSON.parse(fs.readFileSync(path.join(limitsDir(d), 'sess-1.json'), 'utf8'));
  assert.deepEqual(Object.keys(snap.rate_limits), ['five_hour']);
  assert.deepEqual(readHist(d).map((x) => x.w), ['5h']);
});

test('statusline: spend_limit (gateway users) is stored, printed and historised as "spend"', () => {
  const d = freshDir();
  const r = sl.process(JSON.stringify(stdin({ five: null, seven: null, spend: true })), { dataDir: d, style: PLAIN });
  assert.match(r.line, /spend 30% \$15\.0\/\$50|spend 30% \$15\/\$50/);
  const snap = JSON.parse(fs.readFileSync(path.join(limitsDir(d), 'sess-1.json'), 'utf8'));
  assert.equal(snap.spend_limit.used_usd, 15);
  assert.equal(snap.spend_limit.period, 'month');
  assert.deepEqual(readHist(d).map((x) => x.w), ['spend']);
});

test('statusline: garbage and empty stdin never throw, still give a line, write nothing', () => {
  const d = freshDir();
  for (const raw of ['', '   \n', '{not json', '[1,2,3]', 'null', '"str"', '\u0000\u0001garbage', undefined, null]) {
    const r = sl.process(raw, { dataDir: d, style: PLAIN });
    assert.equal(r.line, 'Claude', JSON.stringify(raw));
  }
  assert.equal(fs.existsSync(limitsDir(d)), false);
  // wrong types inside a valid document are ignored, not fatal
  const r = sl.process(JSON.stringify({ session_id: 7, model: 5, rate_limits: { five_hour: { used_percentage: 'lots', resets_at: {} }, seven_day: 3 }, context_window: 'x', cost: 3 }), { dataDir: d, style: PLAIN });
  assert.equal(typeof r.line, 'string');
  assert.ok(r.line.length > 0);
});

test('statusline: colour rules - dim labels, amber from 70 %, red from 90 %; NO_COLOR drops colour, CCU_ASCII gives plain ASCII', () => {
  const d = freshDir();
  const col = (five, env = {}) => sl.process(JSON.stringify(stdin({ five })), { dataDir: d, env, now: Date.now() }).line;
  assert.doesNotMatch(col(10), /\x1b\[3[13]m/);
  assert.match(col(75), /\x1b\[33m/);
  assert.match(col(92), /\x1b\[31m/);
  assert.match(col(10), /\x1b\[2m/);
  const nc = col(95, { NO_COLOR: '1' });
  assert.doesNotMatch(nc, //);
  assert.match(nc, /5h ▰{5} 95%/);
  const plain = col(95, { NO_COLOR: '1', CCU_ASCII: '1' });
  assert.doesNotMatch(plain, /\x1b/);
  assert.doesNotMatch(plain, /[^\x20-\x7e]/); // pure ASCII
  assert.match(plain, /5h \[#{5}\] 95%/);
});

test('statusline: --chain prints the other command\'s output; a failing chain falls back to our line', () => {
  const d = freshDir();
  const node = JSON.stringify(process.execPath);
  const ok = sl.process(JSON.stringify(stdin()), { dataDir: d, style: PLAIN, chain: `${node} -e "process.stdin.on('data',x=>{const j=JSON.parse(x);console.log('CHAIN '+j.session_id)})"` });
  assert.equal(ok.line, 'CHAIN sess-1');
  assert.ok(fs.existsSync(path.join(limitsDir(d), 'sess-1.json')), 'data is still recorded when chaining');
  const bad = sl.process(JSON.stringify(stdin()), { dataDir: d, style: PLAIN, chain: `${node} -e "process.exit(3)"` });
  assert.match(bad.line, /^Opus 5\.5/);
});

// ---------------------------------------------------------------- statusline.js: files

test('statusline: atomic write, per-session files, no temp leftovers, unsafe ids contained', () => {
  const d = freshDir();
  for (const sid of ['a-1', 'b-2', '../../evil', 'con']) sl.process(JSON.stringify(stdin({ sid })), { dataDir: d, style: PLAIN });
  const files = fs.readdirSync(limitsDir(d)).sort();
  assert.ok(files.includes('a-1.json') && files.includes('b-2.json'));
  assert.ok(!files.some((f) => f.endsWith('.tmp')), files.join());
  assert.ok(files.every((f) => !f.includes('..')));
  assert.ok(!fs.existsSync(path.join(d, 'evil.json')) && !fs.existsSync(path.join(TMP, 'evil.json')));
  assert.equal(sl.safeId('con'), '_con');
  assert.equal(sl.safeId('history'), '_history');
  // a snapshot read while another run rewrites it is always whole JSON
  const f = path.join(limitsDir(d), 'a-1.json');
  for (let i = 0; i < 60; i++) {
    sl.process(JSON.stringify(stdin({ sid: 'a-1', five: i })), { dataDir: d, style: PLAIN });
    JSON.parse(fs.readFileSync(f, 'utf8'));
  }
});

test('statusline: history grows only when a percentage or resets_at changes (per session)', () => {
  const d = freshDir();
  const now = Date.now();
  const run = (o, t) => sl.process(JSON.stringify(stdin({ now, ...o })), { dataDir: d, style: PLAIN, now: t });
  run({}, now);
  assert.equal(readHist(d).length, 2);
  run({}, now + 30e3);                       // identical numbers: nothing appended
  run({}, now + 60e3);
  assert.equal(readHist(d).length, 2);
  run({ five: 30 }, now + 90e3);             // 5h moved, 7d did not
  let h = readHist(d);
  assert.equal(h.length, 3);
  assert.deepEqual([h[2].w, h[2].p, h[2].t], ['5h', 30, now + 90e3]);
  run({ five: 30, fiveIn: 2 * H + 5000 }, now + 120e3); // same percent, new resets_at
  assert.equal(readHist(d).length, 4);
  run({ sid: 'other', five: 30, fiveIn: 2 * H + 5000 }, now + 150e3); // another session's first report of an already recorded value
  assert.equal(readHist(d).length, 4);
  run({ sid: 'other', five: 31, fiveIn: 2 * H + 5000 }, now + 180e3);
  assert.equal(readHist(d).length, 5);
});

test('statusline: history is capped (keeps the newest half, whole lines)', () => {
  const d = freshDir();
  const max = 4000;
  const now = Date.now();
  for (let i = 0; i < 400; i++) {
    sl.process(JSON.stringify(stdin({ now, five: i % 100, seven: null })), { dataDir: d, style: PLAIN, now: now + i * 1000, historyMax: max });
  }
  const file = path.join(limitsDir(d), 'history.jsonl');
  assert.ok(fs.statSync(file).size <= max, 'size ' + fs.statSync(file).size);
  const h = readHist(d); // every remaining line parses
  assert.ok(h.length > 10);
  assert.equal(h[h.length - 1].t, now + 399 * 1000);
  assert.equal(h[h.length - 1].p, 399 % 100);
});

// ---------------------------------------------------------------- projection math (pure)

const NOW = 1_800_000_000_000;
const sec = (ms) => Math.round(ms / 1000);
const snapOf = (o) => ({ receivedAt: NOW, changedAt: NOW, sessionId: 's', ...o });
const five = (used, inMs, extra = {}) => snapOf({ rate_limits: { five_hour: { used_percentage: used, resets_at: sec(NOW + inMs) } }, ...extra });
const hp = (w, minAgo, p, inMs, w5 = true) => ({ t: NOW - minAgo * MIN, w, p, r: sec(NOW + inMs) });

test('math: windowStart = resetsAt - windowMs, elapsedPct, and the payload shape', () => {
  const o = srv.computeLimits([five(30, 2 * H)], [], NOW);
  const w = o.windows.five_hour;
  assert.equal(o.available, true);
  assert.equal(o.source, 'statusline');
  assert.equal(w.windowMs, 5 * H);
  assert.equal(w.resetsAt, sec(NOW + 2 * H) * 1000);
  assert.equal(w.startedAt, w.resetsAt - 5 * H);
  assert.equal(w.elapsedPct, 60);               // 3 h of 5 h
  assert.equal(w.usedPct, 30);
  assert.equal(w.burnPerHour, null);            // one point only
  assert.equal(w.projectedPctAtReset, null);
  assert.equal(w.projectedHitAt, null);
  assert.equal(w.status, 'ok');
  assert.deepEqual(w.history, [{ t: NOW, p: 30 }]);
  const s7 = srv.computeLimits([snapOf({ rate_limits: { seven_day: { used_percentage: 10, resets_at: sec(NOW + 24 * H) } } })], [], NOW).windows.seven_day;
  assert.equal(s7.windowMs, 7 * 24 * H);
  assert.equal(s7.elapsedPct, 85.71);           // 6 d of 7 d
});

test('math: least-squares burn (%/h) from history points inside the window, projection at reset', () => {
  const hist = [hp('5h', 60, 20, 2 * H), hp('5h', 30, 25, 2 * H), hp('5h', 0, 30, 2 * H)];
  const w = srv.computeLimits([five(30, 2 * H)], hist, NOW).windows.five_hour;
  assert.equal(w.burnPerHour, 10);
  assert.equal(w.projectedPctAtReset, 50);      // 30 + 10 * 2 h
  assert.equal(w.projectedHitAt, null);
  assert.equal(w.willExceed, false);
  // noisy points: slope is the regression, not first-to-last
  const noisy = [hp('5h', 60, 10, 2 * H), hp('5h', 40, 14, 2 * H), hp('5h', 20, 15, 2 * H), hp('5h', 0, 22, 2 * H)];
  const n = srv.computeLimits([five(22, 2 * H)], noisy, NOW).windows.five_hour;
  const xs = [0, 20 / 60, 40 / 60, 1]; const ys = [10, 14, 15, 22];
  const mx = xs.reduce((a, b) => a + b) / 4; const my = ys.reduce((a, b) => a + b) / 4;
  const slope = xs.reduce((a, x, i) => a + (x - mx) * (ys[i] - my), 0) / xs.reduce((a, x) => a + (x - mx) ** 2, 0);
  assert.ok(Math.abs(n.burnPerHour - slope) < 0.001, `${n.burnPerHour} vs ${slope}`);
  assert.ok(Math.abs(n.projectedPctAtReset - (22 + slope * 2)) < 0.06);
});

test('math: projection above 100 is flagged, projectedHitAt is when it crosses 100 (before the reset)', () => {
  const hist = [hp('5h', 60, 60, 2 * H), hp('5h', 30, 70, 2 * H), hp('5h', 0, 80, 2 * H)];
  const w = srv.computeLimits([five(80, 2 * H)], hist, NOW).windows.five_hour;
  assert.equal(w.burnPerHour, 20);
  assert.equal(w.projectedPctAtReset, 120);
  assert.equal(w.willExceed, true);
  assert.equal(w.projectedHitAt, NOW + 1 * H);  // (100 - 80) / 20 h
  assert.equal(w.status, 'watch');
  // crossing exactly at the reset still counts; one tick later does not
  const exact = srv.computeLimits([five(80, 1 * H)], hist.map((x) => ({ ...x, r: sec(NOW + 1 * H) })), NOW).windows.five_hour;
  assert.equal(exact.projectedPctAtReset, 100);
  assert.equal(exact.projectedHitAt, NOW + 1 * H);
  const late = srv.computeLimits([five(80, 0.9 * H)], hist.map((x) => ({ ...x, r: sec(NOW + 0.9 * H) })), NOW).windows.five_hour;
  assert.equal(late.projectedPctAtReset, 98);
  assert.equal(late.projectedHitAt, null);
  assert.equal(late.willExceed, false);
});

test('math: burn is null with < 2 points or < 5 minutes of span; never negative; projection floor at 0', () => {
  const stale = (o) => srv.computeLimits([o], [], NOW);
  assert.equal(stale(five(30, 2 * H)).windows.five_hour.burnPerHour, null);
  const short = [hp('5h', 4, 29, 2 * H), hp('5h', 0, 30, 2 * H)];
  assert.equal(srv.computeLimits([five(30, 2 * H)], short, NOW).windows.five_hour.burnPerHour, null);
  const ok = [hp('5h', 6, 29, 2 * H), hp('5h', 0, 30, 2 * H)];
  assert.ok(srv.computeLimits([five(30, 2 * H)], ok, NOW).windows.five_hour.burnPerHour > 0);
  const falling = [hp('5h', 50, 40, 2 * H), hp('5h', 0, 30, 2 * H)];
  const f = srv.computeLimits([five(30, 2 * H)], falling, NOW).windows.five_hour;
  assert.equal(f.burnPerHour, 0);
  assert.equal(f.projectedPctAtReset, 30);
  // points of another window instance (different resets_at) or from before the window began are ignored
  const foreign = [{ t: NOW - 50 * MIN, w: '5h', p: 5, r: sec(NOW - 3 * H) }, { t: NOW - 6 * H, w: '5h', p: 1, r: sec(NOW + 2 * H) }];
  assert.equal(srv.computeLimits([five(30, 2 * H)], foreign, NOW).windows.five_hour.burnPerHour, null);
});

test('math: lookback is 60 min for 5h and 24 h for 7d; a fresh unchanged value counts as a flat burn of 0', () => {
  const old = [hp('5h', 180, 5, 2 * H)];
  assert.equal(srv.computeLimits([five(5, 2 * H)], old, NOW).windows.five_hour.burnPerHour, 0); // reported just now, unchanged for 3 h
  const aged = { ...five(5, 2 * H), receivedAt: NOW - 30 * MIN, changedAt: NOW - 30 * MIN };
  assert.equal(srv.computeLimits([aged], old, NOW).windows.five_hour.burnPerHour, null);        // report is 30 min old: no guess
  // 5h: a point 2 h ago is outside the lookback, so only the last hour sets the slope
  const hist = [hp('5h', 120, 0, 2 * H), hp('5h', 60, 10, 2 * H), hp('5h', 0, 12, 2 * H)];
  assert.equal(srv.computeLimits([five(12, 2 * H)], hist, NOW).windows.five_hour.burnPerHour, 2);
  // 7d: the same shape over 24 h
  const h7 = [{ t: NOW - 24 * H, w: '7d', p: 10, r: sec(NOW + 3 * 24 * H) }, { t: NOW, w: '7d', p: 34, r: sec(NOW + 3 * 24 * H) }];
  const w7 = srv.computeLimits([snapOf({ rate_limits: { seven_day: { used_percentage: 34, resets_at: sec(NOW + 3 * 24 * H) } } })], h7, NOW).windows.seven_day;
  assert.equal(w7.burnPerHour, 1);
  assert.equal(w7.projectedPctAtReset, 106);    // 34 + 1 %/h * 72 h
  assert.equal(w7.willExceed, true);
  assert.equal(w7.projectedHitAt, NOW + 66 * H); // (100 - 34) / 1
});

test('math: status thresholds 70 / 90 / 100', () => {
  const st = (p) => srv.computeLimits([five(p, 2 * H)], [], NOW).windows.five_hour.status;
  assert.deepEqual([0, 69.9, 70, 89.9, 90, 99.9, 100, 140].map(st), ['ok', 'ok', 'watch', 'watch', 'high', 'high', 'limit', 'limit']);
  assert.equal(srv.computeLimits([five(140, 2 * H)], [], NOW).windows.five_hour.usedPct, 100); // clamped
});

test('math: window dropped after resetsAt (reset map says it happened); the other window stays', () => {
  const s = snapOf({ rate_limits: { five_hour: { used_percentage: 90, resets_at: sec(NOW - 1000) }, seven_day: { used_percentage: 50, resets_at: sec(NOW + 24 * H) } } });
  const o = srv.computeLimits([s], [], NOW);
  assert.equal(o.windows.five_hour, undefined);
  assert.equal(o.windows.seven_day.usedPct, 50);
  assert.equal(o.available, true);
  assert.equal(o.reset.five_hour, sec(NOW - 1000) * 1000);
  const onlyOver = srv.computeLimits([five(90, -1000)], [], NOW);
  assert.equal(onlyOver.available, false);
  assert.equal(onlyOver.reason, 'no-data');
  assert.deepEqual(Object.keys(onlyOver.windows), []);
  assert.ok(onlyOver.reset.five_hour);
});

test('math: stale flag after 15 minutes (values still returned)', () => {
  const at = (ageMs) => srv.computeLimits([{ ...five(40, 2 * H), receivedAt: NOW - ageMs, changedAt: NOW - ageMs }], [], NOW);
  const fresh = at(14 * MIN);
  assert.equal(fresh.stale, undefined);
  assert.equal(fresh.reason, undefined);
  assert.equal(fresh.available, true);
  const old = at(16 * MIN);
  assert.equal(old.stale, true);
  assert.equal(old.reason, 'stale');
  assert.equal(old.available, true);
  assert.equal(old.windows.five_hour.usedPct, 40);
  assert.equal(old.updatedAt, NOW - 16 * MIN);
});

test('math: freshest snapshot across sessions wins per window; an idle session re-reporting old numbers does not', () => {
  const a = { ...five(10, 2 * H), sessionId: 'a', receivedAt: NOW - 60e3, changedAt: NOW - 60e3 };
  const b = { ...five(12, 2 * H), sessionId: 'b', receivedAt: NOW - 10e3, changedAt: NOW - 10e3 };
  assert.equal(srv.computeLimits([a, b], [], NOW).windows.five_hour.usedPct, 12);
  assert.equal(srv.computeLimits([b, a], [], NOW).windows.five_hour.usedPct, 12);
  const idle = { ...five(8, 2 * H), sessionId: 'c', receivedAt: NOW - 1000, changedAt: NOW - 3 * H }; // refreshes every few seconds, numbers unchanged for hours
  const o = srv.computeLimits([a, b, idle], [], NOW);
  assert.equal(o.windows.five_hour.usedPct, 12);
  assert.equal(o.windows.five_hour.updatedAt, NOW - 1000);
  assert.equal(o.sessions, 3);
  // windows are chosen independently: 5h from one session, 7d from another
  const only7 = snapOf({ sessionId: 'd', receivedAt: NOW - 5e3, changedAt: NOW - 5e3, rate_limits: { seven_day: { used_percentage: 60, resets_at: sec(NOW + 24 * H) } } });
  const m = srv.computeLimits([b, only7], [], NOW);
  assert.equal(m.windows.five_hour.usedPct, 12);
  assert.equal(m.windows.seven_day.usedPct, 60);
});

test('math: availability reasons - no-data and not-subscriber', () => {
  assert.deepEqual([srv.computeLimits([], [], NOW).available, srv.computeLimits([], [], NOW).reason], [false, 'no-data']);
  const none = srv.computeLimits([snapOf({ cwd: '/x' })], [], NOW);
  assert.equal(none.available, false);
  assert.equal(none.reason, 'not-subscriber');
  assert.equal(none.sessions, 1);
  assert.deepEqual(none.windows, {});
  const garbage = srv.computeLimits([null, 5, { receivedAt: 'x' }, { receivedAt: NOW, rate_limits: { five_hour: { used_percentage: 'x' } } }], null, NOW);
  assert.equal(garbage.available, false);
});

test('math: spend_limit passes through its dollars and period', () => {
  const o = srv.computeLimits([snapOf({ spend_limit: { used_percentage: 30, resets_at: sec(NOW + 10 * 24 * H), used_usd: 15, limit_usd: 50, period: 'month' } })], [], NOW);
  const w = o.windows.spend_limit;
  assert.equal(w.usedPct, 30);
  assert.equal(w.usedUsd, 15);
  assert.equal(w.limitUsd, 50);
  assert.equal(w.period, 'month');
  assert.equal(w.windowMs, null);
  assert.equal(w.elapsedPct, null);
  assert.equal(o.windows.five_hour, undefined);
});

test('math: payload history is capped at 120 points, newest kept', () => {
  const hist = [];
  for (let i = 0; i < 300; i++) hist.push({ t: NOW - (299 - i) * 30e3, w: '5h', p: Math.min(99, i / 4), r: sec(NOW + 2 * H) });
  const w = srv.computeLimits([five(74.5, 2 * H)], hist, NOW).windows.five_hour;
  assert.equal(w.history.length, 120);
  assert.equal(w.history[w.history.length - 1].t, NOW);
  assert.ok(w.history.every((p, i, a) => i === 0 || p.t > a[i - 1].t));
});

// ---------------------------------------------------------------- server over HTTP

const getJson = (p, opts = {}) => new Promise((resolve, reject) => {
  const rq = http.request({ host: '127.0.0.1', port, path: p, method: opts.method || 'GET', headers: opts.headers }, (res) => {
    let b = '';
    res.on('data', (d) => { b += d; });
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: b, json: () => JSON.parse(b) }));
  });
  rq.on('error', reject);
  rq.end();
});

function sse() {
  const msgs = [];
  let waiters = [];
  let buf = '';
  const req = http.get({ host: '127.0.0.1', port, path: '/api/stream' }, (res) => {
    res.setEncoding('utf8');
    res.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const raw = buf.slice(0, i); buf = buf.slice(i + 2);
        const m = { event: 'message', data: null, at: performance.now() };
        for (const l of raw.split('\n')) {
          if (l.startsWith('event:')) m.event = l.slice(6).trim();
          else if (l.startsWith('data:')) m.data = JSON.parse(l.slice(5).trim());
        }
        msgs.push(m);
        waiters = waiters.filter((w) => !w(m));
      }
    });
    res.on('error', () => {});
  });
  req.on('error', () => {});
  clients.push(req);
  return {
    msgs,
    close: () => req.destroy(),
    waitFor(pred, ms = 3000) {
      const hit = msgs.find(pred);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('timeout; got ' + msgs.map((x) => x.event).join())), ms);
        waiters.push((m) => { if (pred(m)) { clearTimeout(t); resolve(m); return true; } return false; });
      });
    },
  };
}

test('server: /api/limits with no data, then reflects snapshot files and picks the freshest session', async () => {
  const empty = (await getJson('/api/limits')).json();
  assert.equal(empty.available, false);
  assert.equal(empty.reason, 'no-data');
  assert.equal(empty.source, 'statusline');
  assert.deepEqual(empty.windows, {});

  const t = Date.now();
  sl.process(JSON.stringify(stdin({ sid: 'sa', now: t, five: 20, seven: 50 })), { dataDir: DATA, style: PLAIN, now: t - 5000 });
  sl.process(JSON.stringify(stdin({ sid: 'sb', now: t, five: 25, seven: 52 })), { dataDir: DATA, style: PLAIN, now: t - 1000 });
  const r = await getJson('/api/limits');
  assert.equal(r.status, 200);
  assert.match(r.headers['content-type'], /application\/json/);
  assert.equal(r.headers['cache-control'], 'no-store');
  const j = r.json();
  assert.equal(j.available, true);
  assert.equal(j.sessions, 2);
  assert.equal(j.windows.five_hour.usedPct, 25);
  assert.equal(j.windows.seven_day.usedPct, 52);
  assert.equal(j.windows.five_hour.windowMs, 5 * H);
  assert.ok(Math.abs(j.windows.five_hour.resetsAt - (t + 2 * H)) < 1500);
  assert.ok(j.windows.five_hour.history.length >= 2);
  assert.ok(j.updatedAt >= t - 1000 && j.updatedAt <= Date.now());
  assert.equal(j.stale, undefined);
  assert.ok(Math.abs(j.windows.five_hour.elapsedPct - 60) < 0.1);
});

test('server: Host guard and method rules apply to /api/limits', async () => {
  assert.equal((await getJson('/api/limits', { headers: { Host: 'evil.example.com' } })).status, 403);
  assert.equal((await getJson('/api/limits', { headers: { Host: 'localhost:' + port } })).status, 200);
  assert.equal((await getJson('/api/limits', { method: 'POST' })).status, 405);
});

test('server: /api/live/state and the SSE snapshot include limits', async () => {
  const st = (await getJson('/api/live/state')).json();
  assert.ok(st.limits, 'limits in live state');
  assert.equal(st.limits.available, true);
  assert.equal(st.limits.windows.five_hour.usedPct, 25);
  assert.ok(Array.isArray(st.sessions));
  const c = sse();
  const snap = await c.waitFor((m) => m.event === 'snapshot');
  assert.equal(snap.data.limits.windows.five_hour.usedPct, 25);
  const first = await c.waitFor((m) => m.event === 'limits');
  assert.equal(first.data.windows.five_hour.usedPct, 25);
  c.close();
});

test('server: an SSE `limits` event arrives within ~300 ms of a new snapshot file', async () => {
  const c = sse();
  await c.waitFor((m) => m.event === 'limits');
  const lat = [];
  for (const used of [31, 37, 44]) {
    const t = Date.now();
    const t0 = performance.now();
    sl.process(JSON.stringify(stdin({ sid: 'sb', now: t, five: used, seven: 52 })), { dataDir: DATA, style: PLAIN, now: t });
    const m = await c.waitFor((x) => x.event === 'limits' && x.data.windows.five_hour && x.data.windows.five_hour.usedPct === used, 2000);
    lat.push(m.at - t0);
    assert.equal(m.data.windows.five_hour.status, 'ok');
    await sleep(20);
  }
  assert.ok(Math.max(...lat) < 300, 'latencies ' + lat.map((x) => x.toFixed(0)).join(', ') + ' ms');
  // a value crossing a threshold changes status in the pushed payload; history and burn grow with it
  const t = Date.now();
  sl.process(JSON.stringify(stdin({ sid: 'sb', now: t, five: 91, seven: 52 })), { dataDir: DATA, style: PLAIN, now: t });
  const hi = await c.waitFor((x) => x.event === 'limits' && x.data.windows.five_hour && x.data.windows.five_hour.usedPct === 91, 2000);
  assert.equal(hi.data.windows.five_hour.status, 'high');
  assert.ok(hi.data.windows.five_hour.history.length >= 5);
  // an unchanged re-report is still announced (updatedAt moved) but a no-op rewrite of the same bytes is not required
  c.close();
});

test('server: a half-written / garbage file in limits/ is ignored, the last good value stays', async () => {
  const before = (await getJson('/api/limits')).json().windows.five_hour.usedPct;
  fs.writeFileSync(path.join(DATA, 'limits', 'broken.json'), '{"receivedAt": 12');
  fs.writeFileSync(path.join(DATA, 'limits', 'note.txt'), 'hello');
  await sleep(80);
  const after = (await getJson('/api/limits')).json();
  assert.equal(after.windows.five_hour.usedPct, before);
  fs.rmSync(path.join(DATA, 'limits', 'broken.json'));
});

test('end-to-end: piping the sample through `node scripts/statusline.js` (CCU_DATA_DIR set) is visible at /api/limits', async () => {
  fs.rmSync(path.join(DATA, 'limits'), { recursive: true, force: true });
  await sleep(50);
  const t = Date.now();
  const doc = JSON.stringify(stdin({ sid: 'e2e', now: t, five: 63.5, seven: 12.25 }));
  const t0 = performance.now();
  const r = spawnSync(process.execPath, [SCRIPT], { input: doc, env: { ...process.env, CCU_DATA_DIR: DATA, NO_COLOR: '1', CCU_ASCII: '1' }, encoding: 'utf8' });
  const wall = performance.now() - t0;
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^Opus 5\.5 \| 5h \[###--\] 64% ->.+\| 7d 12% ->.+\| ctx 9%\n$/);
  assert.ok(wall < 1500, 'spawn took ' + wall.toFixed(0) + ' ms');
  const j = (await getJson('/api/limits')).json();
  assert.equal(j.available, true);
  assert.equal(j.windows.five_hour.usedPct, 63.5);
  assert.equal(j.windows.seven_day.usedPct, 12.25);
  assert.equal(j.sessions, 1);
  // garbage, empty and closed stdin through the real process: exit 0 and one line
  for (const input of ['', 'garbage{', '{"session_id":"x"']) {
    const g = spawnSync(process.execPath, [SCRIPT], { input, env: { ...process.env, CCU_DATA_DIR: DATA }, encoding: 'utf8' });
    assert.equal(g.status, 0);
    assert.equal(g.stdout.trim(), 'Claude');
  }
});
