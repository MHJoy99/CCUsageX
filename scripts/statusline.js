#!/usr/bin/env node
'use strict';
// CCUsageX status line + plan-limits recorder. Zero dependencies, fast, never throws, always exits 0 with a line.
//
// Claude Code runs the configured `statusLine.command` and passes a JSON document on stdin (documented at
// code.claude.com/docs/en/statusline). For claude.ai Pro/Max subscribers it contains
//   rate_limits: { five_hour: { used_percentage, resets_at }, seven_day: { used_percentage, resets_at } }
// (resets_at = Unix epoch SECONDS; each window can be absent on its own). This script:
//   1. writes the document atomically to  <CCU_DATA_DIR or ~/.ccusagex>/limits/<session_id>.json
//   2. appends a compact line to           limits/history.jsonl  ONLY when a percentage or reset time changed
//   3. prints one short status line, e.g.  Opus 5.5 · 5h ▰▰▱▱▱ 23% ↻3:45pm · 7d 41% ↻Thu · ctx 9%
// It makes no network calls and never reads credentials. Only the stdin data is used.
//
// Options:  --chain "<command>"   pass the same stdin to another status line command and print its output instead
//           --install | --uninstall | --status   delegated to scripts/install-statusline.js
// Env:      CCU_DATA_DIR (data folder), NO_COLOR (no colour), CCU_ASCII=1 (ASCII-only symbols)

const fs = require('fs');
const path = require('path');
const os = require('os');

const HISTORY_MAX_BYTES = 5 * 1024 * 1024;
const PRUNE_AFTER_MS = 14 * 24 * 3600e3;
const WINDOWS = [['five_hour', '5h'], ['seven_day', '7d']];

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const num = (v) => (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : v);

// ---------------------------------------------------------------- stdin

function parseStdin(raw) {
  const text = String(raw == null ? '' : raw).replace(/^﻿/, '').trim();
  if (!text) return null;
  try {
    const j = JSON.parse(text);
    return j && typeof j === 'object' && !Array.isArray(j) ? j : null;
  } catch { return null; }
}

function readStdin(timeoutMs = 2500) {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    const chunks = [];
    let done = false;
    const finish = () => { if (done) return; done = true; clearTimeout(timer); resolve(Buffer.concat(chunks).toString('utf8')); };
    const timer = setTimeout(finish, timeoutMs);
    try {
      process.stdin.on('data', (d) => chunks.push(d));
      process.stdin.on('end', finish);
      process.stdin.on('error', finish);
      process.stdin.on('close', finish);
    } catch { finish(); }
  });
}

// ---------------------------------------------------------------- normalising what we store

function cleanWindow(w) {
  if (!w || typeof w !== 'object') return null;
  const used = num(w.used_percentage);
  if (!isNum(used)) return null;
  const out = { used_percentage: used };
  const r = num(w.resets_at);
  if (isNum(r)) out.resets_at = r;
  for (const k of ['used_usd', 'limit_usd']) { const v = num(w[k]); if (isNum(v)) out[k] = v; }
  if (typeof w.period === 'string') out.period = w.period.slice(0, 40);
  return out;
}

function cleanLimits(rl) {
  if (!rl || typeof rl !== 'object') return undefined;
  const out = {};
  for (const [k] of WINDOWS) { const w = cleanWindow(rl[k]); if (w) out[k] = w; }
  return Object.keys(out).length ? out : undefined;
}

function safeId(id) {
  let s = String(id == null ? '' : id).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80);
  if (!s) s = 'unknown';
  if (/^(con|prn|aux|nul|com\d|lpt\d|history)$/i.test(s)) s = '_' + s; // Windows device names, and our own history file
  return s;
}

function buildSnapshot(j, now) {
  const model = j.model && typeof j.model === 'object' ? { id: j.model.id, display_name: j.model.display_name } : (typeof j.model === 'string' ? { id: j.model } : undefined);
  const snap = {
    receivedAt: now,
    sessionId: typeof j.session_id === 'string' ? j.session_id : (j.session_id != null ? String(j.session_id) : 'unknown'),
    model,
    cwd: typeof j.cwd === 'string' ? j.cwd : (j.workspace && typeof j.workspace.current_dir === 'string' ? j.workspace.current_dir : undefined),
    rate_limits: cleanLimits(j.rate_limits),
    spend_limit: cleanWindow(j.spend_limit) || undefined,
    cost: j.cost && typeof j.cost === 'object' ? j.cost : undefined,
    context_window: j.context_window && typeof j.context_window === 'object' ? j.context_window : undefined,
    version: typeof j.version === 'string' ? j.version : undefined,
    transcript_path: typeof j.transcript_path === 'string' ? j.transcript_path : undefined,
    workspace: j.workspace && typeof j.workspace === 'object' ? j.workspace : undefined,
  };
  for (const k of Object.keys(snap)) if (snap[k] === undefined) delete snap[k];
  return snap;
}

// ---------------------------------------------------------------- files

function dataDir(env = process.env) { return env.CCU_DATA_DIR || path.join(os.homedir(), '.ccusagex'); }

function atomicWrite(file, body) {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  fs.writeFileSync(tmp, body);
  for (let i = 0; ; i++) {
    try { fs.renameSync(tmp, file); return; } catch (e) {
      if (i >= 4) { // Windows can refuse to replace a file a reader has open: fall back to a plain write
        try { fs.writeFileSync(file, body); } finally { try { fs.unlinkSync(tmp); } catch { /* gone */ } }
        return;
      }
      const t = Date.now() + 4 * (i + 1); while (Date.now() < t) { /* brief spin; the whole run stays well under a frame */ }
    }
  }
}

function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }

function readTail(file, bytes) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    return buf.toString('utf8');
  } catch { return ''; } finally { if (fd != null) try { fs.closeSync(fd); } catch { /* ignore */ } }
}

function lastHistoryPoints(file) { // last recorded point per window, from the end of history.jsonl
  const out = {};
  const lines = readTail(file, 8192).split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    try { const p = JSON.parse(lines[i]); if (p && p.w && !out[p.w]) out[p.w] = p; } catch { /* partial line */ }
  }
  return out;
}

function capHistory(file, max) {
  let size = 0;
  try { size = fs.statSync(file).size; } catch { return false; }
  if (size <= max) return false;
  const buf = fs.readFileSync(file);
  let cut = buf.indexOf(0x0a, Math.floor(buf.length / 2));
  cut = cut < 0 ? Math.floor(buf.length / 2) : cut + 1;
  atomicWrite(file, buf.subarray(cut));
  return true;
}

function pruneOld(dir, now) {
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!/\.(json|tmp)$/.test(f)) continue;
      const p = path.join(dir, f);
      try { if (now - fs.statSync(p).mtimeMs > PRUNE_AFTER_MS) fs.unlinkSync(p); } catch { /* raced */ }
    }
  } catch { /* ignore */ }
}

// history keys: '5h' | '7d' | 'spend'
function windowPoints(snap) {
  const pts = [];
  const rl = snap.rate_limits || {};
  for (const [k, w] of WINDOWS) if (rl[k]) pts.push({ w, p: rl[k].used_percentage, r: rl[k].resets_at == null ? null : rl[k].resets_at });
  if (snap.spend_limit) pts.push({ w: 'spend', p: snap.spend_limit.used_percentage, r: snap.spend_limit.resets_at == null ? null : snap.spend_limit.resets_at });
  return pts;
}

// Records the snapshot and returns { file, appended } (appended = history lines written). Throws on I/O errors; the caller swallows.
function record(snap, opts = {}) {
  const now = snap.receivedAt;
  const dir = path.join(opts.dataDir || dataDir(), 'limits');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, safeId(snap.sessionId) + '.json');
  const histFile = path.join(dir, 'history.jsonl');
  const prev = readJson(file);
  const prevPts = prev && typeof prev === 'object' ? windowPoints(prev) : null;
  const curPts = windowPoints(snap);
  const sig = (pts) => JSON.stringify((pts || []).map((x) => [x.w, x.p, x.r]));
  snap.changedAt = prev && prev.changedAt && sig(prevPts) === sig(curPts) ? prev.changedAt : now;
  atomicWrite(file, JSON.stringify(snap));

  let lines = '';
  let appended = 0;
  let known = null;
  for (const c of curPts) {
    const before = prevPts ? prevPts.find((x) => x.w === c.w) : null;
    if (before && before.p === c.p && before.r === c.r) continue;
    if (!prevPts) { // first snapshot of this session: skip a point another session already recorded
      known = known || lastHistoryPoints(histFile);
      const k = known[c.w];
      if (k && k.p === c.p && k.r === c.r) continue;
    }
    lines += JSON.stringify({ t: now, w: c.w, p: c.p, r: c.r }) + '\n';
    appended++;
  }
  if (lines) {
    fs.appendFileSync(histFile, lines);
    capHistory(histFile, opts.historyMax || HISTORY_MAX_BYTES);
  }
  if (!prev) pruneOld(dir, now);
  return { file, appended };
}

// ---------------------------------------------------------------- the printed line

function fmtClock(ms) {
  const d = new Date(ms);
  let h = d.getHours();
  const m = d.getMinutes();
  const ap = h >= 12 ? 'pm' : 'am';
  h = h % 12 || 12;
  return m ? `${h}:${String(m).padStart(2, '0')}${ap}` : `${h}${ap}`;
}
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function fmtReset(resetsSec, now, longWindow) {
  if (!isNum(resetsSec)) return '';
  const ms = resetsSec < 1e12 ? resetsSec * 1000 : resetsSec;
  if (ms <= now) return '';
  if (longWindow && ms - now > 20 * 3600e3) return DAYS[new Date(ms).getDay()];
  return fmtClock(ms);
}

function style(env) {
  const plain = !!env.NO_COLOR || env.TERM === 'dumb';
  const loc = String(env.LC_ALL || env.LC_CTYPE || env.LANG || '');
  const nonUtf = process.platform !== 'win32' && /^(C|POSIX)(\.|$)/i.test(loc) && !/utf-?8/i.test(loc);
  return { color: !plain, ascii: !!env.CCU_ASCII || nonUtf || env.TERM === 'dumb' };
}

function buildLine(snap, now, st) {
  const c = st.color;
  const dim = (s) => (c ? `\x1b[2m${s}\x1b[0m` : s);
  const tone = (s, pct) => (!c ? s : pct >= 90 ? `\x1b[31m${s}\x1b[0m` : pct >= 70 ? `\x1b[33m${s}\x1b[0m` : s);
  const sep = dim(st.ascii ? ' | ' : ' · ');
  const bar = (pct) => {
    const n = Math.max(0, Math.min(5, Math.round(pct / 20)));
    return st.ascii ? `[${'#'.repeat(n)}${'-'.repeat(5 - n)}]` : '▰'.repeat(n) + '▱'.repeat(5 - n);
  };
  const reset = st.ascii ? '->' : '↻';
  const parts = [];
  const m = snap && snap.model;
  const name = m && (m.display_name || m.id);
  parts.push(name ? String(name) : 'Claude');
  const rl = (snap && snap.rate_limits) || {};
  const w5 = rl.five_hour;
  const w7 = rl.seven_day;
  if (w5) {
    const p = Math.max(0, Math.min(100, w5.used_percentage));
    const r = fmtReset(w5.resets_at, now, false);
    parts.push(`${dim('5h')} ${tone(`${bar(p)} ${Math.round(p)}%`, p)}${r ? dim(` ${reset}${r}`) : ''}`);
  }
  if (w7) {
    const p = Math.max(0, Math.min(100, w7.used_percentage));
    const r = fmtReset(w7.resets_at, now, true);
    parts.push(`${dim('7d')} ${tone(`${Math.round(p)}%`, p)}${r ? dim(` ${reset}${r}`) : ''}`);
  }
  const sp = snap && snap.spend_limit;
  if (sp && !w5 && !w7) {
    const p = Math.max(0, Math.min(100, sp.used_percentage));
    const usd = isNum(sp.used_usd) && isNum(sp.limit_usd) ? ` $${sp.used_usd.toFixed(sp.used_usd < 10 ? 2 : 0)}/$${sp.limit_usd.toFixed(0)}` : '';
    parts.push(`${dim('spend')} ${tone(`${Math.round(p)}%`, p)}${dim(usd)}`);
  }
  const cw = snap && snap.context_window;
  if (cw) {
    let cp = num(cw.used_percentage);
    if (!isNum(cp) && cw.current_usage && isNum(cw.context_window_size) && cw.context_window_size > 0) {
      const u = cw.current_usage;
      const tok = (isNum(u.input_tokens) ? u.input_tokens : 0) + (isNum(u.cache_read_input_tokens) ? u.cache_read_input_tokens : 0) + (isNum(u.cache_creation_input_tokens) ? u.cache_creation_input_tokens : 0);
      cp = tok / cw.context_window_size * 100;
    }
    if (isNum(cp)) parts.push(`${dim('ctx')} ${tone(`${Math.round(Math.max(0, Math.min(100, cp)))}%`, cp)}`);
  }
  return parts.join(sep);
}

// ---------------------------------------------------------------- main

function chainOutput(cmd, raw, timeoutMs = 3000) {
  try {
    const r = require('child_process').spawnSync(cmd, { input: raw, shell: true, encoding: 'utf8', timeout: timeoutMs, windowsHide: true, maxBuffer: 1 << 20 });
    const out = String(r.stdout || '').replace(/\s+$/, '');
    return r.status === 0 && out ? out : null;
  } catch { return null; }
}

// Pure-ish core, used by main() and the tests. Returns { line, recorded }. Never throws.
function process_(raw, opts = {}) {
  const env = opts.env || process.env;
  const now = isNum(opts.now) ? opts.now : Date.now();
  let line = 'Claude';
  let recorded = null;
  try {
    const j = parseStdin(raw);
    if (j) {
      const snap = buildSnapshot(j, now);
      try { recorded = record(snap, { dataDir: opts.dataDir || dataDir(env), historyMax: opts.historyMax || Number(env.CCU_LIMITS_HISTORY_MAX) || undefined }); } catch { /* disk problems must not blank the line */ }
      line = buildLine(snap, now, opts.style || style(env));
    }
  } catch { /* fall through to the default line */ }
  if (opts.chain) {
    const out = chainOutput(opts.chain, raw);
    if (out) line = out;
  }
  return { line, recorded };
}

function argValue(argv, name) {
  const i = argv.findIndex((a) => a === name || a.startsWith(name + '='));
  if (i < 0) return null;
  return argv[i].includes('=') ? argv[i].slice(name.length + 1) : (argv[i + 1] || null);
}

async function main() {
  const argv = process.argv.slice(2);
  try {
    if (argv.some((a) => a === '--install' || a === '--uninstall' || a === '--status')) {
      const inst = path.join(__dirname, 'install-statusline.js');
      if (!fs.existsSync(inst)) { console.log('install-statusline.js is not available in this copy.'); return; }
      const r = require('child_process').spawnSync(process.execPath, [inst, ...argv], { stdio: 'inherit' });
      process.exitCode = r.status || 0;
      return;
    }
    const raw = await readStdin();
    const { line } = process_(raw, { chain: argValue(argv, '--chain') });
    process.stdout.write(line + '\n');
  } catch {
    try { process.stdout.write('Claude\n'); } catch { /* nothing left to try */ }
  }
}

if (require.main === module) {
  process.on('uncaughtException', () => { try { process.stdout.write('Claude\n'); } catch { /* ignore */ } process.exitCode = 0; });
  main();
}

module.exports = { parseStdin, buildSnapshot, record, buildLine, process: process_, safeId, cleanLimits, style, fmtReset, HISTORY_MAX_BYTES };
