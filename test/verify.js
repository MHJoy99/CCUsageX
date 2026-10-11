#!/usr/bin/env node
'use strict';
/*
 * Independent verification of the Claude Code Usage dashboard (agent E).
 *
 * This file deliberately shares NO code with server.js. It re-reads the raw
 * Claude Code transcripts (READ-ONLY), recomputes every number from scratch and
 * compares them with what the running dashboard API reports (and with ccusage).
 *
 *   node test/verify.js                  snapshot mode (default, exact comparison)
 *   node test/verify.js --live           live mode (real ~/.claude, last 90 s excluded)
 *   node test/verify.js --port 3027      port for the throw-away server (default 3027)
 *   node test/verify.js --json out.json  also dump all results as JSON
 *   node test/verify.js --no-ccusage     skip the ccusage cross-check
 *
 * Snapshot mode: ~/.claude/projects is copied (complete lines only) into a temp
 * dir, a *copy* of the project (server.js + config.json + public/) is started
 * with CLAUDE_CONFIG_DIR pointing at that snapshot, so the dashboard and this
 * script see byte-identical input and your real store (~/.ccusagex/store.json) is never touched.
 *
 * Exit code 0 = every check passed, 1 = at least one discrepancy.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const cp = require('child_process');

const PROJECT = path.resolve(__dirname, '..');
const CONFIG = JSON.parse(fs.readFileSync(path.join(PROJECT, 'config.json'), 'utf8'));
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => { const i = argv.indexOf(n); return i > -1 ? argv[i + 1] : d; };
const LIVE = flag('--live');
const PORT = Number(opt('--port', 3027));
const JSON_OUT = opt('--json', null);
const START_DATE = process.env.CCU_START_DATE || CONFIG.startDate;
const START_MS = !START_DATE || START_DATE === 'all' ? 0 : Date.parse(`${START_DATE}T00:00:00`); // local midnight
const REAL_CLAUDE = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const LIVE_LAG_MS = 90 * 1000;

// ------------------------------------------------------------------ helpers
const results = { checks: [], notes: [] };
function check(name, dashboard, independent, tol = 0, note = '') {
  const a = typeof dashboard === 'number' ? dashboard : dashboard;
  const ok = typeof a === 'number' && typeof independent === 'number' ? Math.abs(a - independent) <= tol : canon(a) === canon(independent);
  results.checks.push({ name, dashboard: a, independent, ok, note });
  return ok;
}
const canon = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((kk) => [kk, x[kk]])) : x));
const money = (n) => (n == null ? 'n/a' : '$' + n.toFixed(6));
const fmt = (v) => (typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toFixed(6)) : JSON.stringify(v));
function pct(sorted, p) { return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : null; }
function stats(arr) {
  const s = arr.slice().sort((a, b) => a - b);
  return { n: s.length, mean: s.length ? s.reduce((a, b) => a + b, 0) / s.length : null, p50: pct(s, 0.5), p95: pct(s, 0.95), max: s.length ? s[s.length - 1] : null };
}

function walk(dir, out = []) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

// copy projects dir keeping only complete lines (a file being appended may end mid-line)
function snapshot(srcProjects, dstRoot) {
  const dst = path.join(dstRoot, 'projects');
  let n = 0, bytes = 0;
  for (const f of walk(srcProjects)) {
    const buf = fs.readFileSync(f);
    const end = buf.lastIndexOf(0x0a);
    const rel = path.relative(srcProjects, f);
    const out = path.join(dst, rel);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, end < 0 ? Buffer.alloc(0) : buf.subarray(0, end + 1));
    n++; bytes += end + 1;
  }
  return { dir: dst, files: n, bytes };
}

// ------------------------------------------------------------------ pricing (own implementation, config.json values)
function priceFor(model) {
  const m = CONFIG.pricing.models;
  if (m[model]) return m[model];
  let best = null;
  for (const k of Object.keys(m)) if (model.startsWith(k) && (!best || k.length > best.length)) best = k;
  return best ? m[best] : null;
}
function costOf(model, t, speed) {
  const p = priceFor(model);
  if (!p) return null;
  const promptTokens = t.input + t.cacheRead + t.cw5m + t.cw1h;
  const lc = p.longContext;
  const rate = lc && promptTokens > lc.thresholdTokens ? lc : p;
  const mult = speed === 'fast' && p.fastMultiplier ? p.fastMultiplier : 1;
  const c = {
    input: t.input * rate.input / 1e6 * mult,
    cacheWrite: (t.cw5m * rate.input * CONFIG.pricing.cacheWrite5mMultiplier + t.cw1h * rate.input * CONFIG.pricing.cacheWrite1hMultiplier) / 1e6 * mult,
    cacheRead: t.cacheRead * rate.cacheRead / 1e6 * mult,
    output: t.output * rate.output / 1e6 * mult,
  };
  c.total = c.input + c.cacheWrite + c.cacheRead + c.output;
  return c;
}

// ------------------------------------------------------------------ independent analysis of raw JSONL
function analyse(projectsDir, cutoffMs) {
  const A = {
    files: 0, lines: 0, badLines: 0,
    requests: new Map(),       // key -> request
    humanPrompts: new Map(),   // promptId -> {ts,sessionId,text}
    humanRecords: 0,
    anomalies: [],
    sessions: new Map(),
    toolCounts: {},
    nonHumanUserKinds: {},
    turnStarts: new Map(),     // promptId -> any real (non-meta, non-sidechain, non-tool_result) turn-starting user record
  };
  const perFile = [];
  for (const file of walk(projectsDir)) {
    A.files++;
    const isSub = /[\\/]subagents[\\/]/.test(file);
    const recs = [];
    const byUuid = new Map();
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      A.lines++;
      let o;
      try { o = JSON.parse(line); } catch { A.badLines++; continue; }
      o._ts = o.timestamp ? Date.parse(o.timestamp) : NaN;
      recs.push(o);
      if (o.uuid) byUuid.set(o.uuid, o);
    }
    perFile.push({ file, recs, byUuid, isSub });
  }

  const inWindow = (ts) => !Number.isNaN(ts) && ts >= START_MS && ts <= cutoffMs;
  const seenUser = new Set();

  for (const { file, recs, byUuid, isSub } of perFile) {
    const groups = new Map();
    for (const o of recs) {
      if (o.type === 'user' && inWindow(o._ts) && o.message) {
        const c = o.message.content;
        const hasToolResult = Array.isArray(c) && c.some((b) => b && b.type === 'tool_result');
        if (!hasToolResult && !o.isSidechain && o.promptId && (!A.turnStarts.has(o.promptId) || (A.turnStarts.get(o.promptId).meta && !o.isMeta))) {
          const txt = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n') : '';
          A.turnStarts.set(o.promptId, { id: o.promptId, meta: !!o.isMeta, origin: o.origin ? o.origin.kind : (o.promptSource === 'sdk' ? 'sdk(no origin)' : 'none'), text: txt.slice(0, 80) });
        }
        const human =(o.origin && o.origin.kind === 'human') || o.turnOrigin === 'human';
        if (human && !o.isMeta && !hasToolResult) {
          if (o.uuid && seenUser.has(o.uuid)) continue;
          if (o.uuid) seenUser.add(o.uuid);
          A.humanRecords++;
          const id = o.promptId || o.uuid;
          if (!A.humanPrompts.has(id)) {
            let text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n') : '';
            A.humanPrompts.set(id, { id, ts: o._ts, sessionId: o.sessionId, text: text.slice(0, 120), requests: 0, subagentRequests: 0, cost: 0, tokens: 0 });
          }
        } else if (!hasToolResult) {
          const k = `origin=${o.origin ? o.origin.kind : 'none'} meta=${!!o.isMeta} sidechain=${!!o.isSidechain} src=${o.promptSource || '-'}`;
          A.nonHumanUserKinds[k] = (A.nonHumanUserKinds[k] || 0) + 1;
        }
      }
      if (o.type === 'assistant' && o.message && o.message.usage && o.message.model && o.message.model !== '<synthetic>') {
        const key = `${o.message.id || o.uuid}|${o.requestId || ''}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(o);
      }
    }

    // classify parent record for latency analysis
    const kindOf = (r) => {
      if (!r) return 'missing';
      if (r.type === 'user') {
        const c = r.message && r.message.content;
        if (Array.isArray(c) && c.some((b) => b && b.type === 'tool_result')) return 'tool_result';
        if ((r.origin && r.origin.kind === 'human') || r.turnOrigin === 'human') return 'human-prompt';
        return r.isMeta ? 'user-meta' : (r.isSidechain ? 'subagent-prompt' : 'user-other');
      }
      return r.type;
    };
    const isHumanRec = (r) => r.type === 'user' && !r.isMeta && ((r.origin && r.origin.kind === 'human') || r.turnOrigin === 'human')
      && !(Array.isArray(r.message && r.message.content) && r.message.content.some((b) => b && b.type === 'tool_result'));
    // Ground-truth owner of a request: walk the parent chain to the human prompt that started the work.
    // Peer messages / task notifications / tool results get NEW promptIds in the transcript but belong to the same human turn.
    const ownerOf = (o) => {
      let cur = o, rootUser = null;
      for (let i = 0; i < 100000 && cur; i++) {
        if (cur.type === 'user') { rootUser = cur; if (isHumanRec(cur)) return { human: cur.promptId || cur.uuid, root: null }; }
        cur = cur.parentUuid ? byUuid.get(cur.parentUuid) : null;
      }
      return { human: null, root: rootUser ? (rootUser.promptId || null) : null };
    };
    const promptOf = (o) => {
      let cur = o;
      for (let i = 0; i < 100000 && cur; i++) {
        if (cur.type === 'user' && cur.promptId) return cur.promptId;
        cur = cur.parentUuid ? byUuid.get(cur.parentUuid) : null;
      }
      return null;
    };

    for (const [key, lines] of groups) {
      const first = lines[0];
      const last = lines[lines.length - 1];
      if (!inWindow(first._ts)) continue;
      if (A.requests.has(key)) { A.anomalies.push(`duplicate request key across files: ${key}`); continue; }
      const tok = (o) => {
        const u = o.message.usage;
        const cc = u.cache_creation;
        const total = u.cache_creation_input_tokens || 0;
        const cw1h = cc ? (cc.ephemeral_1h_input_tokens || 0) : 0;
        const cw5m = cc ? (cc.ephemeral_5m_input_tokens || 0) : total;
        if (cc && cw1h + cw5m !== total) A.anomalies.push(`cache_creation breakdown ${cw5m}+${cw1h} != ${total} for ${key}`);
        return {
          input: u.input_tokens || 0, output: u.output_tokens || 0, cacheRead: u.cache_read_input_tokens || 0,
          cw5m, cw1h, thinking: (u.output_tokens_details && u.output_tokens_details.thinking_tokens) || 0,
        };
      };
      const tl = tok(last), tf = tok(first);
      // sanity: the last written line should carry the final (max) usage; a naive 'first line wins' dedupe would under-count output
      for (const f of ['input', 'output', 'cacheRead', 'cw5m', 'cw1h', 'thinking']) {
        const mx = Math.max(...lines.map((l) => tok(l)[f]));
        if (mx !== tl[f]) A.anomalies.push(`last line is not max for ${f} in ${key}`);
      }
      const u = last.message.usage;
      if (u.iterations && (u.iterations.length !== 1 || u.iterations[0].type !== 'message')) A.anomalies.push(`non-trivial iterations (advisor?) in ${key}`);
      const speed = u.speed || 'standard';
      const tools = [];
      const seenTool = new Set();
      for (const l of lines) for (const b of l.message.content || []) {
        if (b && b.type === 'tool_use' && !seenTool.has(b.id)) { seenTool.add(b.id); tools.push(b.name); A.toolCounts[b.name] = (A.toolCounts[b.name] || 0) + 1; }
      }
      const parent = first.parentUuid ? byUuid.get(first.parentUuid) : null;
      let eff = parent; // effective parent: skip attachments / system records
      for (let i = 0; i < 50 && eff && eff.type !== 'user' && eff.type !== 'assistant'; i++) eff = eff.parentUuid ? byUuid.get(eff.parentUuid) : null;
      const sidechain = !!first.isSidechain || isSub;
      const r = {
        key, id: first.message.id, requestId: first.requestId, model: first.message.model, ts: first._ts, lastLineTs: last._ts,
        lines: lines.length, sessionId: first.sessionId, sidechain, speed, tools, file,
        tokens: tl, firstLineTokens: tf,
        cost: costOf(first.message.model, tl, speed),
        parentKind: kindOf(parent), effParentKind: kindOf(eff),
        latencyEnd: parent && !(parent.type === 'attachment' && parent.attachment && parent.attachment.type === 'queued_command') && last._ts >= parent._ts && last._ts - parent._ts < 3600000 ? last._ts - parent._ts : null,
        latencyImmediate: parent && parent._ts <= first._ts ? first._ts - parent._ts : null,
        latencyEffective: eff && eff._ts <= first._ts ? first._ts - eff._ts : null,
        blockSpanMs: last._ts - first._ts,
        chainPromptId: promptOf(first), owner: ownerOf(first), promptId: null,
      };
      A.requests.set(key, r);
    }
  }

  for (const r of A.requests.values()) {
    r.promptId = r.owner.human || (r.owner.root && A.humanPrompts.has(r.owner.root) ? r.owner.root : null);
  }
  // roll-ups
  const T = () => ({ requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cw5m: 0, cw1h: 0, thinking: 0, tokens: 0, cost: 0, unpriced: 0 });
  const add = (a, r, useFirst) => {
    const t = useFirst ? r.firstLineTokens : r.tokens;
    a.requests++; a.input += t.input; a.output += t.output; a.cacheRead += t.cacheRead;
    a.cw5m += t.cw5m; a.cw1h += t.cw1h; a.cacheWrite += t.cw5m + t.cw1h; a.thinking += t.thinking;
    a.tokens += t.input + t.output + t.cacheRead + t.cw5m + t.cw1h;
    const c = costOf(r.model, t, r.speed);
    if (c) a.cost += c.total; else a.unpriced++;
  };
  A.totals = T(); A.totalsFirstLine = T(); A.byModel = {}; A.byModelFirstLine = {}; A.bySession = {}; A.byKind = { Main: T(), Subagent: T() };
  for (const r of A.requests.values()) {
    add(A.totals, r); add(A.totalsFirstLine, r, true);
    (A.byModel[r.model] = A.byModel[r.model] || T()); add(A.byModel[r.model], r);
    (A.byModelFirstLine[r.model] = A.byModelFirstLine[r.model] || T()); add(A.byModelFirstLine[r.model], r, true);
    (A.bySession[r.sessionId] = A.bySession[r.sessionId] || T()); add(A.bySession[r.sessionId], r);
    add(A.byKind[r.sidechain ? 'Subagent' : 'Main'], r);
    const hp = r.promptId && A.humanPrompts.get(r.promptId);
    if (hp) { hp.requests++; if (r.sidechain) hp.subagentRequests++; hp.cost += r.cost ? r.cost.total : 0; hp.tokens += r.tokens.input + r.tokens.output + r.tokens.cacheRead + r.tokens.cw5m + r.tokens.cw1h; }
  }
  A.sessionIds = new Set([...A.requests.values()].map((r) => r.sessionId));
  A.misattributedByServerStyle = [...A.requests.values()].filter((r) => r.chainPromptId !== r.promptId);
  A.requestsWithoutHumanPrompt = [...A.requests.values()].filter((r) => !(r.promptId && A.humanPrompts.has(r.promptId)));
  return A;
}

// ------------------------------------------------------------------ dashboard access
function getJson(port, p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p, timeout: 30000 }, (res) => {
      let b = '';
      res.on('data', (d) => (b += d));
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(new Error(`bad JSON from ${p}: ${b.slice(0, 200)}`)); } });
    }).on('error', reject);
  });
}
async function pageAll(port, base, sort) {
  const rows = [];
  let total = Infinity;
  for (let page = 1; rows.length < total && page < 200; page++) {
    const j = await getJson(port, `${base}${base.includes('?') ? '&' : '?'}sort=${sort}&page=${page}&size=200`);
    total = j.total;
    if (!j.rows.length) break;
    rows.push(...j.rows);
  }
  return { total, rows };
}
function copyDir(src, dst) { fs.cpSync(src, dst, { recursive: true }); }
async function startServer(port, claudeDir) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccu-server-'));
  for (const f of ['server.js', 'config.json']) fs.copyFileSync(path.join(PROJECT, f), path.join(tmp, f));
  if (fs.existsSync(path.join(PROJECT, 'public'))) copyDir(path.join(PROJECT, 'public'), path.join(tmp, 'public'));
  const env = { ...process.env };
  if (claudeDir) env.CLAUDE_CONFIG_DIR = claudeDir;
  const child = cp.spawn(process.execPath, ['server.js', '--port', String(port)], { cwd: tmp, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setTimeout(r, 300));
    try { const s = await getJson(port, '/api/status'); if (s && s.lastScanAt) return { child, tmp, status: s, log: () => log }; } catch { /* not up yet */ }
    if (child.exitCode != null) throw new Error('server exited: ' + log);
  }
  throw new Error('server did not start: ' + log);
}

// ------------------------------------------------------------------ ccusage
function runCcusage(args, claudeDir) {
  try {
    const out = cp.execSync(`ccusage claude ${args} --json --since ${CONFIG.startDate.replace(/-/g, '')}`, {
      env: { ...process.env, CLAUDE_CONFIG_DIR: claudeDir }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000, maxBuffer: 1 << 28, shell: true,
    });
    return JSON.parse(out);
  } catch (e) { return { error: String(e.message || e).slice(0, 300) }; }
}

// ------------------------------------------------------------------ main
(async () => {
  const startedAt = Date.now();
  let claudeDir = REAL_CLAUDE, cutoff = Infinity, snap = null, tmpRoot = null;
  if (!LIVE) {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ccu-snap-'));
    snap = snapshot(path.join(REAL_CLAUDE, 'projects'), tmpRoot);
    claudeDir = tmpRoot;
    console.log(`[snapshot] ${snap.files} files, ${(snap.bytes / 1048576).toFixed(1)} MiB -> ${snap.dir}`);
  } else {
    cutoff = Date.now() - LIVE_LAG_MS;
    console.log(`[live] real transcripts; records newer than ${new Date(cutoff).toISOString()} are excluded from both sides`);
  }
  const projectsDir = path.join(claudeDir, 'projects');

  const server = await startServer(PORT, claudeDir);
  let exitCode = 0;
  try {
    const st0 = server.status;
    console.log(`[server] copy of project started on :${PORT}; reads ${st0.projectsDir}; ${st0.requests} requests, ${st0.prompts} prompts`);
    if (path.resolve(st0.projectsDir) !== path.resolve(projectsDir)) {
      results.notes.push(`WARNING: dashboard reads ${st0.projectsDir}, not the snapshot ${projectsDir} (server ignores CLAUDE_CONFIG_DIR?). Exact comparison is not valid; re-run with --live.`);
    }
    const qs = LIVE ? `?to=${cutoff}` : '?';
    const A = analyse(projectsDir, cutoff);
    console.log(`[independent] ${A.files} files, ${A.lines} lines (${A.badLines} unparsable), ${A.requests.size} unique requests, ${A.humanPrompts.size} human prompts`);

    // ---- API reads
    const S = await getJson(PORT, `/api/summary${qs}&gran=day`);
    const R = await pageAll(PORT, `/api/requests${qs}`, 'time');
    const P = await pageAll(PORT, `/api/prompts${qs}`, 'time');
    const SES = await getJson(PORT, `/api/sessions${qs}`);

    // ---- 1. totals
    for (const f of ['requests', 'input', 'output', 'cacheRead', 'cacheWrite', 'thinking', 'tokens']) check(`summary.totals.${f}`, S.totals[f], A.totals[f]);
    check('summary.totals.cost (USD)', S.totals.cost, A.totals.cost, 1e-6);
    check('summary.totals.unpriced', S.totals.unpriced, A.totals.unpriced);
    check('summary.prompts vs strict human prompts (origin.kind=human) with >=1 request', S.prompts, [...A.humanPrompts.values()].filter((p) => p.requests > 0).length, 0, 'summary counts distinct promptIds on requests: includes non-human turn starters and ghost ids');
    check('summary.sessions', S.sessions, A.sessionIds.size);
    // ---- per model
    check('models present', S.byModel.map((m) => m.name).sort(), Object.keys(A.byModel).sort());
    for (const [m, a] of Object.entries(A.byModel)) {
      const d = S.byModel.find((x) => x.name === m) || {};
      for (const f of ['requests', 'input', 'output', 'cacheRead', 'cacheWrite', 'thinking']) check(`byModel[${m}].${f}`, d[f], a[f]);
      check(`byModel[${m}].cost`, d.cost, a.cost, 1e-6);
    }
    // ---- kind
    for (const k of ['Main', 'Subagent']) {
      const d = S.byKind.find((x) => x.name === k) || { requests: 0, cost: 0 };
      check(`byKind[${k}].requests`, d.requests, A.byKind[k].requests);
      check(`byKind[${k}].cost`, d.cost, A.byKind[k].cost, 1e-6);
    }
    // ---- trend buckets must add up to the totals (hourly and daily)
    for (const g of ['hour', 'day']) {
      const T = await getJson(PORT, `/api/summary${qs}&gran=${g}`);
      const pts = T.trend.points;
      check(`trend(${g}) sum of requests == total`, pts.reduce((a, p) => a + p.requests, 0), A.totals.requests);
      check(`trend(${g}) sum of tokens == total`, pts.reduce((a, p) => a + p.tokens, 0), A.totals.tokens);
      check(`trend(${g}) sum of cost == total`, pts.reduce((a, p) => a + p.cost, 0), A.totals.cost, 1e-6);
    }
    // ---- tools
    const dTools = Object.fromEntries((S.tools || []).map((t) => [t.name, t.count]));
    check('tool call counts', dTools, A.toolCounts);

    // ---- 2. per request
    check('/api/requests total', R.total, A.requests.size);
    const dKeys = new Map(R.rows.map((r) => [r.key, r]));
    const toDash = (r) => `${r.id}:${r.requestId}`;
    const missing = [], extra = [], fieldDiffs = [];
    for (const r of A.requests.values()) {
      const d = dKeys.get(toDash(r));
      if (!d) { missing.push(toDash(r)); continue; }
      const exp = { input: r.tokens.input, output: r.tokens.output, cacheRead: r.tokens.cacheRead, cacheWrite: r.tokens.cw5m + r.tokens.cw1h, thinking: r.tokens.thinking, model: r.model, ts: r.ts };
      for (const [f, v] of Object.entries(exp)) if (d[f] !== v) fieldDiffs.push(`${toDash(r)} ${f}: dashboard=${d[f]} independent=${v}`);
      if (r.cost && Math.abs(d.cost - r.cost.total) > 1e-9) fieldDiffs.push(`${toDash(r)} cost: dashboard=${d.cost} independent=${r.cost.total}`);
    }
    const indKeys = new Set([...A.requests.values()].map(toDash));
    for (const k of dKeys.keys()) if (!indKeys.has(k)) extra.push(k);
    check('requests missing from dashboard', missing.length, 0, 0, missing.slice(0, 5).join(', '));
    check('requests only in dashboard', extra.length, 0, 0, extra.slice(0, 5).join(', '));
    check('per-request field mismatches', fieldDiffs.length, 0, 0, fieldDiffs.slice(0, 5).join(' | '));
    results.fieldDiffs = fieldDiffs;

    // ---- 3. per prompt
    // (a) strict definition from the brief: origin.kind==='human' (or turnOrigin) && !isMeta && !tool_result
    const withReq = [...A.humanPrompts.values()].filter((p) => p.requests > 0);
    check('/api/prompts rows == strict human prompts with >=1 request', P.total, withReq.length, 0, 'rows also include non-human turn starters (peer / task-notification / sdk) and ghost ids');
    const dP = new Map(P.rows.map((p) => [p.id, p]));
    const byOrigin = {};
    for (const p of P.rows) {
      const o = byOrigin[p.origin || '(none)'] = byOrigin[p.origin || '(none)'] || { rows: 0, requests: 0, cost: 0 };
      o.rows++; o.requests += p.requests; o.cost += p.cost;
    }
    results.dashboardPromptOrigins = byOrigin;
    // (b) rows that correspond to no real turn-starting user record => "ghost" rows ("(prompt text not captured)")
    const ghosts = P.rows.filter((p) => !A.turnStarts.has(p.id));
    const ghostCost = ghosts.reduce((a, p) => a + p.cost, 0);
    check('dashboard prompt rows with no real prompt record (ghost rows)', ghosts.length, 0, 0, ghosts.slice(0, 6).map((p) => `${p.id.slice(0, 8)} "${(p.text || '').slice(0, 30)}" requests=${p.requests} cost=${money(p.cost)}`).join(' | '));
    // (c) rows labelled origin human that are not strict-human (sdk sessions without origin.kind)
    const labelledHumanNotStrict = P.rows.filter((p) => p.origin === 'human' && !A.humanPrompts.has(p.id));
    check('rows labelled origin=human that are NOT origin.kind==="human" in the transcript', labelledHumanNotStrict.length, 0, 0, labelledHumanNotStrict.slice(0, 4).map((p) => `${p.id.slice(0, 8)} "${(p.text || '').slice(0, 40)}"`).join(' | ') + ' (promptSource=sdk, no origin field)');
    // (d) turn-level arithmetic: group requests by nearest-ancestor promptId, which is what a per-turn row should contain
    const turn = new Map();
    for (const r of A.requests.values()) {
      const id = r.chainPromptId; if (!id) continue;
      if (!turn.has(id)) turn.set(id, { requests: 0, sub: 0, cost: 0 });
      const g = turn.get(id); g.requests++; if (r.sidechain) g.sub++; g.cost += r.cost ? r.cost.total : 0;
    }
    const tDiffs = [];
    for (const [id, g] of turn) {
      const d = dP.get(id);
      if (!d) { tDiffs.push(`${id.slice(0, 8)} missing from dashboard (independent requests=${g.requests})`); continue; }
      if (d.requests !== g.requests) tDiffs.push(`${id.slice(0, 8)} requests dashboard=${d.requests} independent=${g.requests}`);
      if (d.subagentRequests !== g.sub) tDiffs.push(`${id.slice(0, 8)} subagentRequests dashboard=${d.subagentRequests} independent=${g.sub}`);
      if (Math.abs(d.cost - g.cost) > 1e-6) tDiffs.push(`${id.slice(0, 8)} cost dashboard=${money(d.cost)} independent=${money(g.cost)}`);
    }
    for (const id of dP.keys()) if (!turn.has(id)) tDiffs.push(`${id.slice(0, 8)} dashboard row has no requests in transcripts`);
    results.turnLevelDiffs = tDiffs; // informational: differs from the dashboard only when it re-attributes subagent / follow-on work to the owning human prompt
    const rowReq = P.rows.reduce((a, p) => a + p.requests, 0), rowCost = P.rows.reduce((a, p) => a + p.cost, 0);
    check('sum of /api/prompts rows: requests == total requests (nothing orphaned)', rowReq, A.requests.size);
    check('sum of /api/prompts rows: cost == total cost', rowCost, A.totals.cost, 1e-6);
    // (e) owner level: each strict human prompt including ALL work it caused (subagents, follow-on peer / task-notification turns)
    const pDiffs = [], absent = [];
    for (const p of A.humanPrompts.values()) {
      const d = dP.get(p.id);
      if (!d) { if (p.requests > 0) absent.push(`${p.id.slice(0, 8)} "${p.text.slice(0, 40)}" independent requests=${p.requests}`); continue; }
      if (d.requests !== p.requests) pDiffs.push(`${p.id.slice(0, 8)} "${p.text.slice(0, 30)}": requests dashboard=${d.requests} owner-attributed=${p.requests}`);
      if (Math.abs(d.cost - p.cost) > 1e-6) pDiffs.push(`${p.id.slice(0, 8)} "${p.text.slice(0, 30)}": cost dashboard=${money(d.cost)} owner-attributed=${money(p.cost)}`);
      if (d.subagentRequests !== p.subagentRequests) pDiffs.push(`${p.id.slice(0, 8)}: subagentRequests dashboard=${d.subagentRequests} owner-attributed=${p.subagentRequests}`);
    }
    check('strict human prompts with requests absent from /api/prompts', absent.length, 0, 0, absent.slice(0, 6).join(' | '));
    check('per-HUMAN-prompt totals vs owner attribution (incl. subagent + follow-on turns)', pDiffs.length, 0, 0, pDiffs.slice(0, 6).join(' | '));
    const unattributed = A.requestsWithoutHumanPrompt;
    const mis = A.misattributedByServerStyle;
    results.misattributed = { n: mis.length, cost: mis.reduce((a, r) => a + (r.cost ? r.cost.total : 0), 0), sidechain: mis.filter((r) => r.sidechain).length, ghostIds: [...new Set(mis.map((r) => r.chainPromptId))].map((x) => (x || 'null').slice(0, 8)) };
    results.unattributed = { n: unattributed.length, cost: unattributed.reduce((a, r) => a + (r.cost ? r.cost.total : 0), 0), sidechain: unattributed.filter((r) => r.sidechain).length };
    results.promptDetails = { ghosts: ghosts.map((p) => ({ id: p.id, text: p.text, requests: p.requests, cost: p.cost })), ghostCost, absent, pDiffs, tDiffs, turnStartOrigins: [...A.turnStarts.values()].map((t) => t.origin) };

    // ---- 4. sessions
    check('/api/sessions count', SES.length, A.sessionIds.size);
    const sDiffs = [];
    for (const [sid, a] of Object.entries(A.bySession)) {
      const d = SES.find((s) => s.id === sid);
      if (!d) { sDiffs.push(`${sid.slice(0, 8)} missing`); continue; }
      if (d.requests !== a.requests) sDiffs.push(`${sid.slice(0, 8)} requests ${d.requests} vs ${a.requests}`);
      if (d.tokens !== a.tokens) sDiffs.push(`${sid.slice(0, 8)} tokens ${d.tokens} vs ${a.tokens}`);
      if (Math.abs(d.cost - a.cost) > 1e-6) sDiffs.push(`${sid.slice(0, 8)} cost ${money(d.cost)} vs ${money(a.cost)}`);
      const indPrompts = new Set([...A.requests.values()].filter((r) => r.sessionId === sid && r.promptId).map((r) => r.promptId)).size;
      if (d.prompts !== indPrompts) sDiffs.push(`${sid.slice(0, 8)} prompts ${d.prompts} vs ${indPrompts} (distinct human prompts that own requests)`);
    }
    check('per-session mismatches', sDiffs.length, 0, 0, sDiffs.slice(0, 6).join(' | '));
    results.sessionDiffs = sDiffs;

    // ---- 5. latency (current server definition: LAST content-block line ts - parent record ts of the first line; null if >= 1 h)
    const latImm = [...A.requests.values()].map((r) => r.latencyImmediate).filter((v) => v != null).sort((a, b) => a - b);
    const latEnd = [...A.requests.values()].map((r) => r.latencyEnd).filter((v) => v != null).sort((a, b) => a - b);
    const perReqLat = [];
    for (const r of A.requests.values()) {
      const d = dKeys.get(toDash(r));
      if (d && (d.latencyMs ?? null) !== (r.latencyEnd ?? null)) perReqLat.push(`${toDash(r).slice(0, 20)} dashboard=${d.latencyMs} independent=${r.latencyEnd}`);
    }
    check('per-request latencyMs mismatches (end-of-response definition)', perReqLat.length, 0, 0, perReqLat.slice(0, 5).join(' | '));
    results.latencyDiffs = perReqLat;
    if (S.latency && latEnd.length) {
      check('latency.count (non-null)', R.rows.filter((r) => r.latencyMs != null).length, latEnd.length);
      check('latency.avg ms', S.latency.avg, latEnd.reduce((a, b) => a + b, 0) / latEnd.length, 1, '');
      check('latency.p50 ms', S.latency.p50, pct(latEnd, 0.5), 0);
      check('latency.p95 ms', S.latency.p95, pct(latEnd, 0.95), 0);
    }
    const byClass = {};
    for (const r of A.requests.values()) {
      const k = `${r.sidechain ? 'sub' : 'main'}:${r.effParentKind}`;
      (byClass[k] = byClass[k] || { lat: [], span: [], total: [], multi: 0 }).lat.push(r.latencyEffective ?? 0);
      byClass[k].total.push((r.latencyEffective ?? 0) + r.blockSpanMs);
      byClass[k].span.push(r.blockSpanMs);
      if (r.lines > 1) byClass[k].multi++;
    }
    results.latency = Object.fromEntries(Object.entries(byClass).map(([k, v]) => [k, { n: v.lat.length, multiBlock: v.multi, latency: stats(v.lat), blockSpan: stats(v.span), totalToLastBlock: stats(v.total) }]));
    const parentKinds = {};
    for (const r of A.requests.values()) parentKinds[r.parentKind] = (parentKinds[r.parentKind] || 0) + 1;
    results.latencyImmediateParentKinds = parentKinds;
    results.latencyOverall = { immediate: stats(latImm), blockSpanAll: stats([...A.requests.values()].map((r) => r.blockSpanMs)), multiBlockRequests: [...A.requests.values()].filter((r) => r.lines > 1).length };

    // ---- 6. ccusage
    if (!flag('--no-ccusage')) {
      const cd = runCcusage('daily', claudeDir);
      const cs = runCcusage('session', claudeDir);
      results.ccusage = { daily: cd, session: cs };
      if (cd.error || cs.error) results.notes.push('ccusage failed: ' + (cd.error || cs.error));
      else {
        const t = cd.totals;
        const cc = { input: t.inputTokens, output: t.outputTokens, cacheRead: t.cacheReadTokens, cacheWrite: t.cacheCreationTokens };
        results.ccusageTotals = cc;
        // ccusage cannot split 5m/1h cache writes in its JSON. Two repricings at config.json rates: (a) all cache writes at the 5m rate, (b) using the independent 1h share of that model
        let atConfig = 0, atConfig5mOnly = 0;
        const perModel = {};
        for (const d of cd.daily) for (const m of d.modelBreakdowns) {
          const ind = A.byModel[m.modelName];
          const share1h = ind && ind.cacheWrite ? ind.cw1h / ind.cacheWrite : 0;
          const cw1h = Math.round(m.cacheCreationTokens * share1h);
          const c = costOf(m.modelName, { input: m.inputTokens, output: m.outputTokens, cacheRead: m.cacheReadTokens, cw5m: m.cacheCreationTokens - cw1h, cw1h }, 'standard');
          const c5 = costOf(m.modelName, { input: m.inputTokens, output: m.outputTokens, cacheRead: m.cacheReadTokens, cw5m: m.cacheCreationTokens, cw1h: 0 }, 'standard');
          atConfig += c ? c.total : 0; atConfig5mOnly += c5 ? c5.total : 0;
          const p = perModel[m.modelName] = perModel[m.modelName] || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, costAtConfig: 0 };
          p.input += m.inputTokens; p.output += m.outputTokens; p.cacheRead += m.cacheReadTokens; p.cacheWrite += m.cacheCreationTokens; p.cost += m.cost; p.costAtConfig += c ? c.total : 0; p.costAtConfig5mOnly = (p.costAtConfig5mOnly || 0) + (c5 ? c5.total : 0);
        }
        results.ccusageCompare = {
          totals: { ccusage: cc, ccusageCostReported: t.totalCost, ccusageTokensAtConfigPrices: atConfig, ccusageTokensAtConfigPrices5mOnly: atConfig5mOnly,
            independentLastLine: { input: A.totals.input, output: A.totals.output, cacheRead: A.totals.cacheRead, cacheWrite: A.totals.cacheWrite, cost: A.totals.cost },
            independentFirstLine: { input: A.totalsFirstLine.input, output: A.totalsFirstLine.output, cacheRead: A.totalsFirstLine.cacheRead, cacheWrite: A.totalsFirstLine.cacheWrite, cost: A.totalsFirstLine.cost } },
          perModel, independentPerModel: A.byModel, independentPerModelFirstLine: A.byModelFirstLine,
        };
        // session level
        results.ccusageSessions = cs.sessions.map((s) => {
          const a = A.bySession[s.sessionId];
          return { sessionId: s.sessionId, ccusageTokens: s.totalTokens, ccusageCost: s.totalCost, ccusageOutput: s.outputTokens, independentTokens: a ? a.tokens : null, independentCost: a ? a.cost : null, independentOutput: a ? a.output : null, independentRequests: a ? a.requests : null };
        });
        check('ccusage session count vs dashboard sessions', cs.sessions.length, SES.length, 0, 'ccusage may fold/omit sessions differently');
      }
    }

    // ---- 7. spot-check requests
    const all = [...A.requests.values()];
    const picks = [];
    const pick = (label, r) => { if (r && !picks.find((p) => p.r.key === r.key)) picks.push({ label, r }); };
    pick('multi-line message whose first line has partial output_tokens', all.find((r) => r.lines > 1 && r.firstLineTokens.output !== r.tokens.output));
    pick('most expensive request', all.slice().sort((a, b) => (b.cost ? b.cost.total : 0) - (a.cost ? a.cost.total : 0))[0]);
    pick('subagent request (sonnet)', all.find((r) => r.sidechain && /sonnet/.test(r.model)));
    pick('main-thread opus request with 5m cache write', all.find((r) => !r.sidechain && /opus/.test(r.model) && r.tokens.cw5m > 0));
    pick('single-line end_turn style request', all.find((r) => r.lines === 1));
    pick('request with thinking tokens', all.find((r) => r.tokens.thinking > 0));
    pick('request with 1h cache write', all.find((r) => r.tokens.cw1h > 0));
    for (const r of all) { if (picks.length >= 5) break; pick('additional', r); }
    results.spot = [];
    for (const { label, r } of picks.slice(0, 5)) {
      const raw = [];
      for (const l of fs.readFileSync(r.file, 'utf8').split('\n')) {
        if (!l.includes(r.id)) continue;
        try { const o = JSON.parse(l); if (o.type === 'assistant' && o.message.id === r.id) raw.push({ ts: o.timestamp, stop_reason: o.message.stop_reason, content: (o.message.content || []).map((b) => b.type), usage: o.message.usage }); } catch { /* ignore */ }
      }
      let det = null;
      try { det = await getJson(PORT, `/api/request?key=${encodeURIComponent(toDash(r))}`); } catch (e) { det = { error: String(e) }; }
      const p = priceFor(r.model), t = r.tokens;
      const hand = {
        input: `${t.input} x $${p.input}/M = ${(t.input * p.input / 1e6).toFixed(8)}`,
        cacheWrite: `${t.cw5m} x $${p.input}x1.25/M + ${t.cw1h} x $${p.input}x2/M = ${((t.cw5m * p.input * 1.25 + t.cw1h * p.input * 2) / 1e6).toFixed(8)}`,
        cacheRead: `${t.cacheRead} x $${p.cacheRead}/M = ${(t.cacheRead * p.cacheRead / 1e6).toFixed(8)}`,
        output: `${t.output} x $${p.output}/M = ${(t.output * p.output / 1e6).toFixed(8)}`,
        total: r.cost.total.toFixed(8),
      };
      const ok = det && det.cost && Math.abs(det.cost.total - r.cost.total) < 1e-9 && det.input === t.input && det.output === t.output && det.cacheRead === t.cacheRead && det.cacheWrite5m === t.cw5m && det.cacheWrite1h === t.cw1h;
      results.spot.push({ label, key: toDash(r), file: path.relative(projectsDir, r.file), model: r.model, speed: r.speed, linesInTranscript: r.lines, rawUsageLines: raw, dashboard: det && !det.error ? { input: det.input, output: det.output, cacheRead: det.cacheRead, cacheWrite5m: det.cacheWrite5m, cacheWrite1h: det.cacheWrite1h, thinking: det.thinking, cost: det.cost, latencyMs: det.latencyMs, ts: det.ts } : det, hand, match: !!ok });
      check(`spot-check ${toDash(r).slice(0, 24)} (${label})`, !!ok, true);
    }
    results.independent = { requests: A.requests.size, humanPrompts: A.humanPrompts.size, humanRecords: A.humanRecords, sessions: A.sessionIds.size, totals: A.totals, byModel: A.byModel, anomalies: A.anomalies, nonHumanUserKinds: A.nonHumanUserKinds, requestsWithoutHumanPrompt: results.unattributed };
    results.dashboardStatus = await getJson(PORT, '/api/status');
  } catch (e) {
    console.error('VERIFY ERROR', e);
    exitCode = 2;
  } finally {
    try { server.child.kill(); } catch { /* ignore */ }
    await new Promise((r) => setTimeout(r, 300));
    try { fs.rmSync(server.tmp, { recursive: true, force: true }); } catch { /* ignore */ }
    if (tmpRoot) try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  // ---- report
  console.log('\n==== CHECKS ====');
  let bad = 0;
  for (const c of results.checks) {
    if (!c.ok) bad++;
    console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}  dashboard=${fmt(c.dashboard)}  independent=${fmt(c.independent)}${c.note ? '   [' + c.note + ']' : ''}`);
  }
  if (results.misattributed) console.log(`
requests whose most-recent-promptId-in-file differs from their owning human prompt: ${results.misattributed.n} (subagent ${results.misattributed.sidechain}, cost ${money(results.misattributed.cost)}) ghost ids ${results.misattributed.ghostIds.join(',')}`);
  if (results.unattributed) console.log(`\nrequests whose prompt chain does not end at a human prompt: ${results.unattributed.n} (subagent: ${results.unattributed.sidechain}, cost ${money(results.unattributed.cost)})`);
  if (results.independent) {
    console.log('\nnon-human user records (excluded from prompt count):', results.independent.nonHumanUserKinds);
    if (results.independent.anomalies.length) console.log('data anomalies:', results.independent.anomalies.slice(0, 10));
  }
  if (results.latency) { console.log('\nlatency by (kind:effective parent):'); console.log(JSON.stringify(results.latency, null, 1)); console.log('immediate parent kinds', results.latencyImmediateParentKinds); console.log(JSON.stringify(results.latencyOverall)); }
  if (results.ccusageCompare) { console.log('\nccusage compare:'); console.log(JSON.stringify(results.ccusageCompare, null, 1)); }
  if (results.ccusageSessions) { console.log('\nccusage sessions:'); console.table(results.ccusageSessions); }
  if (results.spot) for (const s of results.spot) console.log('\nSPOT', JSON.stringify(s, null, 1));
  for (const n of results.notes) console.log(n);
  console.log(`\n${results.checks.length - bad}/${results.checks.length} checks passed; ${bad} FAILED; ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
  if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify(results, null, 1));
  process.exit(exitCode || (bad ? 1 : 0));
})();
