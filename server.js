#!/usr/bin/env node
'use strict';
// CCUsageX — local Claude Code usage dashboard server. Zero dependencies.
// Reads Claude Code transcripts (~/.claude/projects/**/*.jsonl) incrementally,
// keeps its own copy in data/store.json (so history survives Claude Code's
// transcript cleanup), and serves the dashboard on 127.0.0.1 only.

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const ROOT = __dirname;
const CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const argPort = process.argv.indexOf('--port');
const PORT = Number(argPort > -1 ? process.argv[argPort + 1] : process.env.PORT || CONFIG.port || 3020);
const HOST = '127.0.0.1';
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
const DATA_DIR = process.env.CCU_DATA_DIR || path.join(os.homedir(), '.ccusagex'); // outside the install dir, so npx/updates keep history
const STORE_FILE = path.join(DATA_DIR, 'store.json');
const PUBLIC_DIR = path.join(ROOT, 'public');
const START_DATE = process.env.CCU_START_DATE || CONFIG.startDate;
const START_MS = !START_DATE || START_DATE === 'all' ? 0 : new Date(`${START_DATE}T00:00:00`).getTime(); // local midnight; 'all' = whole history
const STORE_VERSION = 2;
const PROMPT_MAX = 8000;
const RESPONSE_MAX = 1200;
const UUID_MEMORY = 400;     // per-file parent lookup window (in memory)
const UUID_PERSIST = 40;     // how many of those survive a restart
const SAVE_EVERY_MS = 15000; // debounce for store writes
const READ_CHUNK = 16 << 20;
const HEAD_BYTES = 256;      // fingerprint used to detect a rewritten transcript
const ACTIVE_MS = 120 * 1000;
const MAX_LATENCY_MS = 3600 * 1000;

// ---------------------------------------------------------------- state

function emptyStore() {
  return { version: STORE_VERSION, files: {}, prompts: {}, sessions: {} };
}

let store = emptyStore();
const reqMap = new Map();      // key -> request
let reqList = [];              // all requests, ascending by ts (see sortedList)
let listDirty = false;
const byPrompt = new Map();    // promptId -> [request]
const orphans = new Set();     // requests that still need a prompt
const projCanon = new Map();   // normalised path -> display path

let dirty = false;
let lastSaveAt = 0;
let dataVersion = 0;
let lastActivityTs = 0;
let lastWriteTs = 0;
let lineErrors = 0;
let lastScanAt = null;
let lastScanMs = 0;
let lastError = null;

function resetState() {
  store = emptyStore();
  reqMap.clear(); reqList = []; listDirty = false; byPrompt.clear(); orphans.clear(); projCanon.clear();
  dirty = false; lastSaveAt = 0; dataVersion++; lastActivityTs = 0; lastWriteTs = 0; lineErrors = 0;
  lastScanAt = null; lastScanMs = 0; lastError = null;
  memo.clear();
}

// ---------------------------------------------------------------- store (compact on disk)

const NUM_FIELDS = ['ts', 'parentTs', 'endTs', 'input', 'output', 'cacheRead', 'cacheWrite5m', 'cacheWrite1h', 'thinking', 'webSearch', 'webFetch', 'extraIter'];
const CAT_FIELDS = ['sessionId', 'project', 'model', 'requestedModel', 'effort', 'entrypoint', 'version', 'gitBranch', 'speed', 'serviceTier', 'stopReason', 'agentType', 'sys'];

function packRequests() {
  const dict = [];
  const idx = new Map();
  const cat = (v) => {
    if (v == null) return -1;
    let i = idx.get(v);
    if (i === undefined) { i = dict.length; dict.push(v); idx.set(v, i); }
    return i;
  };
  const rows = [];
  for (const r of reqMap.values()) {
    rows.push([r.key, r.promptId, r.agentId, r.agentDesc, r.sidechain ? 1 : 0, r.response, r.tools, r.blk,
      ...NUM_FIELDS.map((f) => r[f]), ...CAT_FIELDS.map((f) => cat(r[f]))]);
  }
  return { dict, rows };
}

function unpackRequest(a, dict) {
  const r = {
    key: a[0], promptId: a[1], agentId: a[2], agentDesc: a[3], sidechain: !!a[4], response: a[5], tools: a[6], blk: a[7],
  };
  NUM_FIELDS.forEach((f, i) => { r[f] = a[8 + i]; });
  CAT_FIELDS.forEach((f, i) => { const k = a[8 + NUM_FIELDS.length + i]; r[f] = k >= 0 ? dict[k] : null; });
  return r;
}

function packFiles() {
  const out = {};
  for (const [file, f] of Object.entries(store.files)) {
    const keep = f.uuidOrder.slice(-UUID_PERSIST);
    out[file] = {
      offset: f.offset, promptId: f.promptId, spawnPid: f.spawnPid, headLen: f.headLen, headHash: f.headHash, agent: f.agent,
      u: keep.map((u) => [u, f.uuids[u], f.pids[u]]),
    };
  }
  return out;
}

function unpackFiles(files) {
  const out = {};
  for (const [file, f] of Object.entries(files || {})) {
    const s = newFstate();
    Object.assign(s, { offset: f.offset || 0, promptId: f.promptId || null, spawnPid: f.spawnPid || null, headLen: f.headLen || 0, headHash: f.headHash || '', agent: f.agent || null });
    for (const [u, ts, pid] of f.u || []) { s.uuids[u] = ts; s.pids[u] = pid; s.uuidOrder.push(u); }
    out[file] = s;
  }
  return out;
}

function saveStore(force) {
  if (!dirty) return;
  if (!force && Date.now() - lastSaveAt < SAVE_EVERY_MS) return;
  const { dict, rows } = packRequests();
  const body = JSON.stringify({ version: STORE_VERSION, files: packFiles(), prompts: store.prompts, sessions: store.sessions, dict, req: rows });
  const tmp = STORE_FILE + '.tmp';
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(tmp, body);
    try { fs.renameSync(tmp, STORE_FILE); } catch { fs.unlinkSync(STORE_FILE); fs.renameSync(tmp, STORE_FILE); }
    dirty = false;
    lastSaveAt = Date.now();
  } catch (e) {
    lastError = 'store write failed: ' + String(e && e.message || e);
  }
}

function loadStore() {
  let raw;
  try { raw = fs.readFileSync(STORE_FILE, 'utf8'); } catch { return; }
  let j;
  try { j = JSON.parse(raw); } catch {
    try { fs.renameSync(STORE_FILE, STORE_FILE + '.corrupt'); } catch { /* ignore */ }
    return;
  }
  if (!j || j.version !== STORE_VERSION) return; // older layouts are rebuilt from the transcripts
  store = { version: STORE_VERSION, files: unpackFiles(j.files), prompts: j.prompts || {}, sessions: j.sessions || {} };
  for (const a of j.req || []) {
    const r = unpackRequest(a, j.dict || []);
    finalize(r);
    indexRequest(r);
  }
  for (const s of Object.values(store.sessions)) if (s.project) canonProject(s.project);
  dataVersion++;
}

// ---------------------------------------------------------------- pricing

const PRICE_KEYS = Object.keys(CONFIG.pricing.models).sort((a, b) => b.length - a.length);
const priceCache = new Map();

function priceFor(model) {
  if (!model) return null;
  if (priceCache.has(model)) return priceCache.get(model);
  const models = CONFIG.pricing.models;
  let p = Object.prototype.hasOwnProperty.call(models, model) ? models[model] : null;
  if (!p) {
    // dated / suffixed ids (claude-opus-5-5[1m], claude-haiku-5-5-20261001) but never a different version
    const key = PRICE_KEYS.find((k) => model.startsWith(k) && /^(\[.*\]|@.*|-\d{8}.*)?$/.test(model.slice(k.length)));
    p = key ? models[key] : null;
  }
  priceCache.set(model, p);
  return p;
}

function computeCost(r) {
  const p = priceFor(r.model);
  if (!p) return null;
  const promptTokens = r.input + r.cacheRead + r.cacheWrite5m + r.cacheWrite1h;
  const tier = p.longContext && promptTokens > p.longContext.thresholdTokens ? p.longContext : p;
  const m5 = CONFIG.pricing.cacheWrite5mMultiplier;
  const m1 = CONFIG.pricing.cacheWrite1hMultiplier;
  const fast = r.speed === 'fast' ? (p.fastMultiplier || 1) : 1;
  const parts = {
    input: (r.input * tier.input) / 1e6,
    cacheWrite: ((r.cacheWrite5m * tier.input * m5) + (r.cacheWrite1h * tier.input * m1)) / 1e6,
    cacheRead: (r.cacheRead * tier.cacheRead) / 1e6,
    output: (r.output * tier.output) / 1e6,
  };
  for (const k of Object.keys(parts)) parts[k] *= fast;
  parts.total = parts.input + parts.cacheWrite + parts.cacheRead + parts.output;
  return parts;
}

// ---------------------------------------------------------------- parsing

function textOf(content) {
  if (typeof content === 'string') return { text: content, images: 0, toolResult: false };
  if (!Array.isArray(content)) return { text: '', images: 0, toolResult: false };
  let text = '';
  let images = 0;
  let toolResult = false;
  for (const b of content) {
    if (!b) continue;
    if (b.type === 'text' && typeof b.text === 'string') text += (text ? '\n' : '') + b.text;
    else if (b.type === 'image') images++;
    else if (b.type === 'tool_result') toolResult = true;
  }
  return { text, images, toolResult };
}

function cleanPrompt(text) {
  const cmd = /<command-name>\s*([^<]*?)\s*<\/command-name>/.exec(text);
  if (cmd) {
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text);
    return `${cmd[1]} ${args ? args[1].trim() : ''}`.trim();
  }
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<ide_(selection|opened_file)>[\s\S]*?<\/ide_\1>/g, '')
    .trim();
}

function walkJsonl(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkJsonl(p, out);
    else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

// Same folder written as "c:\x", "C:\x" or "C:/x" is one project.
function canonProject(cwd) {
  if (!cwd) return '(unknown)';
  let p = String(cwd).replace(/[\\/]+$/, '');
  const win = /^[A-Za-z]:/.test(p);
  if (win) p = p[0].toUpperCase() + p.slice(1);
  const k = win ? p.toLowerCase().replace(/\//g, '\\') : p;
  if (!projCanon.has(k)) projCanon.set(k, p);
  return projCanon.get(k);
}

function newFstate() {
  return { offset: 0, promptId: null, spawnPid: null, headLen: 0, headHash: '', agent: null, uuids: {}, pids: {}, uuidOrder: [] };
}

function sessionOf(id) {
  return store.sessions[id] || (store.sessions[id] = { id });
}

function numOf(v) { return Number.isFinite(v) && v > 0 ? v : 0; }

const INTERRUPT = /^\s*\[Request interrupted by user/;

// What kind of turn does this user record start? 'human' only when origin.kind or turnOrigin says so; another
// string for turns the harness injects itself (task-notification, peer, headless 'sdk', ...), null = not a turn start.
function promptKind(o, c) {
  if (o.isCompactSummary || o.isVisibleInTranscriptOnly || o.isSidechain || c.toolResult || INTERRUPT.test(c.text)) return null;
  const origin = o.origin && o.origin.kind;
  if (origin === 'human' || o.turnOrigin === 'human') return o.isMeta ? null : 'human';
  if (origin || o.promptSource) return String(origin || o.promptSource);
  return o.isMeta || !o.promptId ? null : 'other';
}

function handleLine(line, fstate, file) {
  let o;
  try { o = JSON.parse(line); } catch { return; }
  if (!o || typeof o !== 'object') return;
  const ts = o.timestamp ? Date.parse(o.timestamp) : NaN;
  const known = !Number.isNaN(ts);

  if ((o.type === 'ai-title' && o.aiTitle) || (o.type === 'custom-title' && o.customTitle)) {
    if (!o.sessionId) return;
    const s = sessionOf(o.sessionId);
    if (o.type === 'custom-title') s.customTitle = String(o.customTitle).slice(0, 200);
    else s.title = String(o.aiTitle).slice(0, 200);
    dirty = true;
    return;
  }

  const sess = o.sessionId ? sessionOf(o.sessionId) : null;
  if (sess && !sess.project && o.cwd) sess.project = canonProject(o.cwd); // launch folder; cd inside a session does not split it
  const project = (sess && sess.project) || canonProject(o.cwd);

  const side = !!o.isSidechain || /[\\/]subagents[\\/]/.test(file);
  let adopt = null; // promptId this line starts/continues
  let kind = null;
  let c = null;
  if (o.type === 'user') {
    c = textOf(o.message && o.message.content);
    kind = promptKind(o, c);
    const interrupt = INTERRUPT.test(c.text);
    if (o.promptId && !o.isCompactSummary && !(interrupt && !store.prompts[o.promptId])) adopt = o.promptId;
    // A subagent's work belongs to the prompt that spawned it. Its later tool_result records are stamped with
    // whatever promptId the parent thread has at that moment, so only a (re)start message sets the owner.
    if (side && o.promptId && !o.isMeta && !c.toolResult) fstate.spawnPid = o.promptId;
  }
  const pid = (side && fstate.spawnPid) || adopt || (o.parentUuid && fstate.pids[o.parentUuid]) || fstate.promptId || null;
  if (adopt) fstate.promptId = adopt;

  const queued = o.type === 'attachment' && o.attachment && o.attachment.type === 'queued_command';
  if (o.uuid && known && !queued) { // queued_command carries the (earlier) enqueue time, not the write time
    fstate.uuids[o.uuid] = ts;
    fstate.pids[o.uuid] = pid;
    fstate.uuidOrder.push(o.uuid);
    if (fstate.uuidOrder.length > UUID_MEMORY) {
      const old = fstate.uuidOrder.shift();
      delete fstate.uuids[old];
      delete fstate.pids[old];
    }
  }

  if (queued && pid && store.prompts[pid]) { // a human message typed while the turn was running
    const p = store.prompts[pid];
    const text = cleanPrompt(textOf(o.attachment.prompt).text).slice(0, 500);
    if (text && !(p.queued || []).includes(text)) { (p.queued = p.queued || []).push(text); dirty = true; dataVersion++; }
    return;
  }

  if (o.type === 'user') {
    if (!kind || !known || side) return;
    const id = o.promptId || o.uuid;
    const prompt = {
      id, ts, sessionId: o.sessionId, project, sidechain: false, origin: kind,
      text: cleanPrompt(c.text).slice(0, PROMPT_MAX), images: c.images,
    };
    if (kind !== 'human') prompt.text = `[${kind}] ${prompt.text}`.slice(0, PROMPT_MAX);
    if (ts < START_MS) { if (sess && kind === 'human') sess.pre = prompt; return; } // kept in case the turn runs past the start date
    if (store.prompts[id]) return;
    store.prompts[id] = prompt;
    dirty = true; dataVersion++;
    return;
  }

  if (o.type !== 'assistant' || !o.message || !o.message.usage) return;
  const msg = o.message;
  if (!msg.model || msg.model === '<synthetic>') return;
  if (!known || ts < START_MS) return;

  if (pid && !store.prompts[pid] && sess && sess.pre && sess.pre.id === pid) { store.prompts[pid] = sess.pre; dataVersion++; }
  const key = `${msg.id || o.uuid}:${o.requestId || ''}`;
  const u = msg.usage;
  const cc = u.cache_creation || {};
  const cw1h = numOf(cc.ephemeral_1h_input_tokens);
  const cwTotal = numOf(u.cache_creation_input_tokens);
  const cw5m = cc.ephemeral_5m_input_tokens != null ? numOf(cc.ephemeral_5m_input_tokens) : Math.max(0, cwTotal - cw1h);

  let r = reqMap.get(key);
  if (!r) {
    const sidechain = side;
    const agent = fstate.agent || {};
    r = {
      key, ts, parentTs: o.parentUuid && fstate.uuids[o.parentUuid] != null ? fstate.uuids[o.parentUuid] : null, endTs: ts,
      sessionId: o.sessionId, project, promptId: null, sidechain,
      agentId: o.agentId || (sidechain ? path.basename(file, '.jsonl').replace(/^agent-/, '') : null),
      agentType: agent.type || null, agentDesc: agent.desc || null,
      model: msg.model, requestedModel: o.requestedModel || msg.model, effort: o.effort || null,
      entrypoint: o.entrypoint || null, version: o.version || null, gitBranch: o.gitBranch || null,
      speed: u.speed || 'standard', serviceTier: u.service_tier || null,
      input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, thinking: 0,
      webSearch: 0, webFetch: 0, extraIter: 0, stopReason: null, sys: null, tools: [], response: '', blk: [],
    };
    indexRequest(r);
    setPrompt(r, pid);
  } else {
    if (ts < r.ts) { r.ts = ts; listDirty = true; }
    if (r.parentTs == null && o.parentUuid && fstate.uuids[o.parentUuid] != null) r.parentTs = fstate.uuids[o.parentUuid];
    if (!r.promptId && pid) setPrompt(r, pid);
  }
  if (ts > r.endTs) r.endTs = ts;
  // Claude Code writes one line per content block; usage repeats (output_tokens grows while streaming) — keep the max.
  r.input = Math.max(r.input, numOf(u.input_tokens));
  r.output = Math.max(r.output, numOf(u.output_tokens));
  r.cacheRead = Math.max(r.cacheRead, numOf(u.cache_read_input_tokens));
  r.cacheWrite5m = Math.max(r.cacheWrite5m, cw5m);
  r.cacheWrite1h = Math.max(r.cacheWrite1h, cw1h);
  r.thinking = Math.max(r.thinking, numOf(u.output_tokens_details && u.output_tokens_details.thinking_tokens));
  r.webSearch = Math.max(r.webSearch, numOf(u.server_tool_use && u.server_tool_use.web_search_requests));
  r.webFetch = Math.max(r.webFetch, numOf(u.server_tool_use && u.server_tool_use.web_fetch_requests));
  if (Array.isArray(u.iterations)) r.extraIter = Math.max(r.extraIter, u.iterations.filter((it) => it && it.type && it.type !== 'message').length);
  if (msg.stop_reason) r.stopReason = msg.stop_reason;

  const bi = o.apiBlockIndex;
  if (bi == null || !r.blk.includes(bi)) { // re-reading a rewritten file must not double-add content
    if (bi != null) r.blk.push(bi);
    for (const b of Array.isArray(msg.content) ? msg.content : []) {
      if (b && b.type === 'tool_use' && b.name) r.tools.push(b.name);
      else if (b && b.type === 'text' && b.text && r.response.length < RESPONSE_MAX) {
        r.response = (r.response ? r.response + '\n' : '') + b.text;
        if (r.response.length > RESPONSE_MAX) r.response = r.response.slice(0, RESPONSE_MAX) + '…';
      }
    }
  }
  finalize(r);

  const s = sessionOf(o.sessionId);
  s.project = s.project || r.project;
  s.first = Math.min(s.first || ts, ts);
  s.last = Math.max(s.last || ts, ts);
  dirty = true;
}

function finalize(r) {
  r.latencyMs = r.parentTs != null && r.endTs >= r.parentTs && r.endTs - r.parentTs < MAX_LATENCY_MS ? r.endTs - r.parentTs : null;
  r.cost = computeCost(r);
  r.usagePartial = !r.stopReason; // no line of the message carried stop_reason: output/thinking are the stream-start values
  if (r.endTs > lastActivityTs) lastActivityTs = r.endTs;
  dataVersion++;
}

function indexRequest(r) {
  if (reqList.length && r.ts < reqList[reqList.length - 1].ts) listDirty = true;
  reqMap.set(r.key, r);
  reqList.push(r);
  if (r.promptId) addByPrompt(r);
  else orphans.add(r);
}

function addByPrompt(r) {
  let a = byPrompt.get(r.promptId);
  if (!a) byPrompt.set(r.promptId, a = []);
  a.push(r);
}

function setPrompt(r, pid) {
  if (r.promptId) {
    const old = byPrompt.get(r.promptId);
    if (old) { const i = old.indexOf(r); if (i > -1) old.splice(i, 1); if (!old.length) byPrompt.delete(r.promptId); }
  }
  r.promptId = pid || null;
  if (!pid) { orphans.add(r); return; }
  orphans.delete(r);
  addByPrompt(r);
}

// Requests with no prompt link (e.g. a subagent record without promptId): attach to the latest
// prompt of the same session that started before the request.
function humanPromptsBySession() {
  const bySession = new Map();
  for (const p of Object.values(store.prompts)) {
    if (p.origin !== 'human') continue;
    if (!bySession.has(p.sessionId)) bySession.set(p.sessionId, []);
    bySession.get(p.sessionId).push(p);
  }
  for (const list of bySession.values()) list.sort((x, y) => x.ts - y.ts);
  return bySession;
}

function latestBefore(list, ts) {
  let best = null;
  if (list) for (const p of list) { if (p.ts <= ts) best = p; else break; }
  return best;
}

// Two clean-ups after each scan, only when something changed:
//  - requests with no prompt link (e.g. a subagent record without promptId) join the latest human prompt
//    of their session that started before them;
//  - turns the harness starts itself (task-notification, peer hand-back) are not prompts the user typed:
//    their requests roll up into the latest human prompt of the session and are flagged via request.sys.
//    With no human prompt to roll into they get promptId null (never a synthetic prompt).
let tidyVersion = -1;
function resolveOrphans() {
  if (tidyVersion === dataVersion) return;
  const bySession = humanPromptsBySession();
  const humanFor = (sessionId, ts) => {
    let root = latestBefore(bySession.get(sessionId), ts);
    const sess = store.sessions[sessionId];
    if (!root && sess && sess.pre && sess.pre.ts <= ts) root = store.prompts[sess.pre.id] = sess.pre;
    return root;
  };
  for (const r of [...orphans]) {
    const best = humanFor(r.sessionId, r.ts);
    if (best) { setPrompt(r, best.id); dirty = true; dataVersion++; }
  }
  for (const p of Object.values(store.prompts)) {
    if (p.origin === 'human') continue;
    const list = byPrompt.get(p.id);
    if (!list || !list.length) continue;
    const root = humanFor(p.sessionId, p.ts);
    for (const r of list.slice()) { r.sys = r.sys || p.origin; setPrompt(r, root ? root.id : null); }
    dirty = true; dataVersion++;
  }
  tidyVersion = dataVersion;
}

function readHead(fd, len) {
  const b = Buffer.alloc(len);
  const n = fs.readSync(fd, b, 0, len, 0);
  return crypto.createHash('sha1').update(b.subarray(0, n)).digest('hex');
}

function loadAgentMeta(file, fstate) {
  if (fstate.agent || !/[\\/]subagents[\\/]/.test(file)) return;
  try {
    const m = JSON.parse(fs.readFileSync(file.replace(/\.jsonl$/, '.meta.json'), 'utf8'));
    fstate.agent = { type: m.agentType || null, desc: m.description ? String(m.description).slice(0, 200) : null };
  } catch { /* meta may not exist yet */ }
}

function feed(chunk, fstate, file) {
  for (const line of chunk.split('\n')) {
    if (!line.trim()) continue;
    try { handleLine(line, fstate, file); } catch (e) { lineErrors++; lastError = 'line error: ' + String(e && e.message || e); }
  }
}

function scanFile(file) {
  let st;
  try { st = fs.statSync(file); } catch { return; }
  let fstate = store.files[file];
  if (!fstate) {
    if (st.mtimeMs < START_MS) return; // nothing in it can be on/after the start date
    fstate = store.files[file] = newFstate();
  }
  if (st.mtimeMs > lastWriteTs) lastWriteTs = st.mtimeMs;
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return; }
  try {
    // truncated or rewritten transcript: start over (idempotent — requests are deduplicated by id)
    if (st.size < fstate.offset || (fstate.headLen && fstate.headLen <= st.size && readHead(fd, fstate.headLen) !== fstate.headHash)) {
      fstate = store.files[file] = newFstate();
    }
    if (st.size === fstate.offset) return;
    loadAgentMeta(file, fstate);
    let pos = fstate.offset;
    let size = READ_CHUNK;
    while (pos < st.size) {
      const len = Math.min(size, st.size - pos);
      const buf = Buffer.allocUnsafe(len);
      const n = fs.readSync(fd, buf, 0, len, pos);
      if (n <= 0) break;
      const end = buf.lastIndexOf(0x0a, n - 1);
      if (end < 0) {
        if (pos + len < st.size) { size *= 2; continue; } // one very long line
        const tail = buf.toString('utf8', 0, n).trim();
        if (tail.startsWith('{') && tail.endsWith('}')) { // last line without newline: use it if it is complete
          let ok = true;
          try { JSON.parse(tail); } catch { ok = false; }
          if (ok) { feed(tail, fstate, file); pos += n; }
        }
        break;
      }
      feed(buf.toString('utf8', 0, end + 1), fstate, file);
      pos += end + 1;
      size = READ_CHUNK;
    }
    fstate.offset = pos;
    if (fstate.headLen < Math.min(HEAD_BYTES, pos)) {
      fstate.headLen = Math.min(HEAD_BYTES, pos);
      fstate.headHash = readHead(fd, fstate.headLen);
    }
    dirty = true;
  } finally {
    fs.closeSync(fd);
  }
}

function scan() {
  const t0 = Date.now();
  try {
    for (const f of walkJsonl(PROJECTS_DIR)) scanFile(f);
    resolveOrphans();
    saveStore();
    lastError = null;
  } catch (e) {
    lastError = String(e && e.stack || e);
    console.error(lastError);
  }
  lastScanAt = Date.now();
  lastScanMs = lastScanAt - t0;
}

// ---------------------------------------------------------------- queries

function num(v, d) {
  if (v == null || v === '') return d;
  const n = Number(v);
  if (Number.isFinite(n)) return n;
  const t = Date.parse(v); // also accept ISO dates
  return Number.isNaN(t) ? d : t;
}

function sortedList() {
  if (listDirty) { reqList.sort((a, b) => a.ts - b.ts); listDirty = false; }
  return reqList;
}

function lowerBound(list, t) { // first index with ts >= t
  let lo = 0, hi = list.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (list[mid].ts < t) lo = mid + 1; else hi = mid; }
  return lo;
}

// Matching requests, ascending by ts.
function filterRequests(q) {
  const list = sortedList();
  const from = num(q.get('from'), START_MS);
  const to = num(q.get('to'), Date.now() + 864e5);
  const model = q.get('model') || '';
  const project = q.get('project') || '';
  const session = q.get('session') || '';
  const kind = q.get('kind') || '';
  const prompt = q.get('prompt') || '';
  const search = (q.get('q') || '').toLowerCase();
  let hitPrompts = null;
  if (search) {
    hitPrompts = new Set();
    for (const p of Object.values(store.prompts)) if (p.text.toLowerCase().includes(search) || (p.queued || []).some((t) => t.toLowerCase().includes(search))) hitPrompts.add(p.id);
  }
  const out = [];
  for (let i = lowerBound(list, from); i < list.length; i++) {
    const r = list[i];
    if (r.ts > to) break;
    if (model && r.model !== model) continue;
    if (project && r.project !== project) continue;
    if (session && r.sessionId !== session) continue;
    if (prompt && r.promptId !== prompt) continue;
    if (kind === 'main' && r.sidechain) continue;
    if (kind === 'subagent' && !r.sidechain) continue;
    if (search && !(hitPrompts.has(r.promptId) || `${r.response}\n${r.tools.join(' ')}\n${r.model}`.toLowerCase().includes(search))) continue;
    out.push(r);
  }
  return out;
}

function tokensOf(r) { return r.input + r.output + r.cacheRead + r.cacheWrite5m + r.cacheWrite1h; }
function costOf(r) { return r.cost ? r.cost.total : 0; }

function blankAgg() {
  return {
    requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, thinking: 0, tokens: 0, cost: 0, unpriced: 0, partial: 0,
    costParts: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 }, thinkingCost: 0,
  };
}

// Cost of the thinking tokens alone (already inside costParts.output): thinking tokens x output price.
function thinkingCostOf(r) {
  const p = priceFor(r.model);
  if (!r.thinking || !p) return 0;
  const promptTokens = r.input + r.cacheRead + r.cacheWrite5m + r.cacheWrite1h;
  const tier = p.longContext && promptTokens > p.longContext.thresholdTokens ? p.longContext : p;
  return (r.thinking * tier.output / 1e6) * (r.speed === 'fast' ? (p.fastMultiplier || 1) : 1);
}
function addAgg(a, r) {
  a.requests++;
  a.input += r.input;
  a.output += r.output;
  a.cacheRead += r.cacheRead;
  a.cacheWrite += r.cacheWrite5m + r.cacheWrite1h;
  a.thinking += r.thinking;
  a.tokens += tokensOf(r);
  a.cost += costOf(r);
  if (r.usagePartial) a.partial++;
  if (r.cost) {
    const cp = a.costParts;
    cp.input += r.cost.input;
    cp.cacheWrite += r.cost.cacheWrite;
    cp.cacheRead += r.cost.cacheRead;
    cp.output += r.cost.output;
    a.thinkingCost += thinkingCostOf(r);
  } else a.unpriced++;
  return a;
}
function addTo(map, k, r) {
  let a = map.get(k);
  if (!a) map.set(k, a = blankAgg());
  addAgg(a, r);
}
function groups(map) {
  return [...map.entries()].map(([name, a]) => ({ name, ...a })).sort((x, y) => y.tokens - x.tokens);
}

function floorTo(t, gran) {
  const d = new Date(t);
  if (gran === 'day') d.setHours(0, 0, 0, 0); else d.setMinutes(0, 0, 0);
  return d.getTime();
}
function nextBucket(t, gran) {
  if (gran === 'day') { const d = new Date(t); d.setDate(d.getDate() + 1); return floorTo(d.getTime(), 'day'); }
  return floorTo(t + 36e5, 'hour');
}

function median(arr) {
  if (!arr.length) return null;
  const a = arr.slice().sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

function summary(q) {
  const rows = filterRequests(q);
  const totals = blankAgg();
  const by = { model: new Map(), project: new Map(), effort: new Map(), kind: new Map(), version: new Map() };
  const promptIds = new Set(), sessionIds = new Set(), toolCounts = new Map();
  const lat = [];
  const modelX = new Map(); // per model: distinct prompts, tokens/second samples, latencies
  for (const r of rows) {
    addAgg(totals, r);
    addTo(by.model, r.model, r);
    let mx = modelX.get(r.model);
    if (!mx) modelX.set(r.model, mx = { prompts: new Set(), speeds: [], lat: [] });
    if (r.promptId) mx.prompts.add(r.promptId);
    if (r.latencyMs > 0) {
      mx.lat.push(r.latencyMs);
      // partial records only hold the stream-start output count, so they'd fake a near-zero speed
      if (!r.usagePartial) mx.speeds.push(r.output / (r.latencyMs / 1000));
    }
    addTo(by.project, r.project, r);
    addTo(by.effort, r.effort || '(none)', r);
    addTo(by.kind, r.sidechain ? 'Subagent' : 'Main', r);
    addTo(by.version, r.version || '(unknown)', r);
    if (r.promptId) promptIds.add(r.promptId);
    sessionIds.add(r.sessionId);
    if (r.latencyMs != null) lat.push(r.latencyMs);
    for (const t of r.tools) toolCounts.set(t, (toolCounts.get(t) || 0) + 1);
  }
  lat.sort((a, b) => a - b);
  const inputSide = totals.input + totals.cacheRead + totals.cacheWrite;

  // trend buckets, local time (rows are ascending)
  const from = num(q.get('from'), START_MS);
  const to = Math.min(num(q.get('to'), Date.now()), Date.now());
  let gran = q.get('gran') === 'day' || (q.get('gran') !== 'hour' && to - from > 3 * 864e5) ? 'day' : 'hour';
  const first = rows.length ? rows[0].ts : to;
  const startB = floorTo(Math.max(from, Math.min(first, to)), gran);
  if (gran === 'hour' && (to - startB) / 36e5 > 2000) gran = 'day';
  const points = [];
  for (let t = floorTo(startB, gran); t <= to && points.length < 5000; t = nextBucket(t, gran)) points.push({ t, ...blankAgg() });
  if (points.length) {
    const end = nextBucket(points[points.length - 1].t, gran);
    let bi = 0;
    for (const r of rows) {
      while (bi + 1 < points.length && r.ts >= points[bi + 1].t) bi++;
      if (r.ts >= points[0].t && r.ts < end) addAgg(points[bi], r);
    }
  }

  return {
    totals,
    prompts: promptIds.size,
    sessions: sessionIds.size,
    cacheHitRate: inputSide ? totals.cacheRead / inputSide : 0,
    latency: lat.length ? { avg: lat.reduce((a, b) => a + b, 0) / lat.length, p50: lat[Math.floor(lat.length * 0.5)], p95: lat[Math.floor(lat.length * 0.95)] } : null,
    byModel: groups(by.model).map((m) => {
      const x = modelX.get(m.name);
      // speed: median output tokens/second. Approximate - latency is the gap since the previous transcript record.
      return {
        ...m, prompts: x.prompts.size, speed: median(x.speeds), speedSamples: x.speeds.length, latencyP50: median(x.lat),
        costPerRequest: m.requests ? m.cost / m.requests : 0, tokensPerRequest: m.requests ? m.tokens / m.requests : 0,
      };
    }),
    byProject: groups(by.project),
    byEffort: groups(by.effort),
    byKind: groups(by.kind),
    byVersion: groups(by.version),
    tools: [...toolCounts.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
    trend: { gran, points },
    activity: groupPrompts(rows).sort((a, b) => b.ts - a.ts).slice(0, 30).map((p) => ({
      id: p.id, ts: p.ts, text: p.text.slice(0, 160), requests: p.requests, cost: p.cost, models: p.models, durationMs: p.durationMs,
    })),
  };
}

function rowView(r) {
  const p = r.promptId && store.prompts[r.promptId];
  return {
    key: r.key, ts: r.ts, model: r.model, effort: r.effort, sidechain: r.sidechain, project: r.project,
    sessionId: r.sessionId, promptId: r.promptId, prompt: p ? p.text.slice(0, 140) : '',
    input: r.input, output: r.output, cacheRead: r.cacheRead, cacheWrite: r.cacheWrite5m + r.cacheWrite1h,
    thinking: r.thinking, tokens: tokensOf(r), cost: r.cost ? r.cost.total : null, latencyMs: r.latencyMs,
    tools: r.tools, stopReason: r.stopReason, usagePartial: r.usagePartial, speed: r.speed, agentType: r.agentType, agentDesc: r.agentDesc, trigger: r.sys,
  };
}

const SORTS = {
  time: (a, b) => b.ts - a.ts,
  cost: (a, b) => costOf(b) - costOf(a),
  tokens: (a, b) => tokensOf(b) - tokensOf(a),
  latency: (a, b) => (b.latencyMs || 0) - (a.latencyMs || 0),
};

function pageArgs(q) {
  return { size: Math.floor(Math.min(200, Math.max(5, num(q.get('size'), 20)))), page: Math.floor(Math.max(1, num(q.get('page'), 1))) };
}

function requestsPage(q) {
  const rows = filterRequests(q);
  const sort = q.get('sort');
  if (sort && sort !== 'time' && SORTS[sort]) rows.sort(SORTS[sort]); else rows.reverse();
  if (q.get('dir') === 'asc') rows.reverse();
  const { size, page } = pageArgs(q);
  return { total: rows.length, page, size, rows: rows.slice((page - 1) * size, page * size).map(rowView) };
}

function groupPrompts(rows) {
  const by = new Map();
  for (const r of rows) {
    if (!r.promptId) continue;
    let g = by.get(r.promptId);
    if (!g) by.set(r.promptId, g = { agg: blankAgg(), last: 0, models: new Set(), subagents: 0, subCost: 0 });
    addAgg(g.agg, r);
    if (r.endTs > g.last) g.last = r.endTs;
    g.models.add(r.model);
    if (r.sidechain) { g.subagents++; g.subCost += costOf(r); }
  }
  return [...by.entries()].map(([id, g]) => {
    const p = store.prompts[id] || { ts: g.last, text: '(prompt text not captured)', sessionId: null, images: 0 };
    return {
      id, ts: p.ts, text: p.text, images: p.images || 0, sessionId: p.sessionId, project: p.project,
      requests: g.agg.requests, subagentRequests: g.subagents, tokens: g.agg.tokens, output: g.agg.output,
      cost: g.agg.cost, durationMs: p.ts ? Math.max(0, g.last - p.ts) : null, models: [...g.models],
      origin: p.origin || null, queued: (p.queued || []).length,
      costParts: g.agg.costParts, thinkingCost: g.agg.thinkingCost, thinking: g.agg.thinking, cacheRead: g.agg.cacheRead,
      cacheWrite: g.agg.cacheWrite, input: g.agg.input, subagentCost: g.subCost,
    };
  });
}

function promptsPage(q) {
  const sort = q.get('sort');
  const list = groupPrompts(filterRequests(q)).sort(sort === 'cost' ? (a, b) => b.cost - a.cost : sort === 'tokens' ? (a, b) => b.tokens - a.tokens : (a, b) => b.ts - a.ts);
  if (q.get('dir') === 'asc') list.reverse();
  const { size, page } = pageArgs(q);
  return { total: list.length, page, size, rows: list.slice((page - 1) * size, page * size).map((p) => ({ ...p, text: p.text.slice(0, 220) })) };
}

function sessionTitle(id) {
  const s = store.sessions[id] || {};
  return s.customTitle || s.title || null;
}

function sessionsList(q) {
  const rows = filterRequests(q);
  const by = new Map();
  for (const r of rows) {
    let g = by.get(r.sessionId);
    if (!g) by.set(r.sessionId, g = { agg: blankAgg(), prompts: new Set(), first: r.ts, last: r.ts });
    addAgg(g.agg, r);
    if (r.promptId) g.prompts.add(r.promptId);
    if (r.ts < g.first) g.first = r.ts;
    if (r.ts > g.last) g.last = r.ts;
  }
  return [...by.entries()].map(([id, g]) => {
    const s = store.sessions[id] || {};
    return { id, title: sessionTitle(id), project: s.project || null, first: g.first, last: g.last, prompts: g.prompts.size, ...g.agg };
  }).sort((a, b) => b.last - a.last);
}

function requestDetail(key) {
  const r = reqMap.get(key);
  if (!r) return null;
  const p = r.promptId && store.prompts[r.promptId];
  const { blk, ...rest } = r;
  return { ...rest, tokens: tokensOf(r), promptText: p ? p.text : null, promptImages: p ? p.images : 0, promptTs: p ? p.ts : null, sessionTitle: sessionTitle(r.sessionId) };
}

function promptDetail(id) {
  const p = store.prompts[id];
  const rows = (byPrompt.get(id) || []).slice().sort((a, b) => a.ts - b.ts);
  if (!p && !rows.length) return null;
  const agg = blankAgg();
  for (const r of rows) addAgg(agg, r);
  return { prompt: p || null, sessionTitle: sessionTitle((p && p.sessionId) || (rows[0] && rows[0].sessionId)), totals: agg, requests: rows.map(rowView) };
}

function filterOptions() {
  const models = new Set(), projects = new Set();
  for (const r of reqMap.values()) { models.add(r.model); projects.add(r.project); }
  const sessions = Object.values(store.sessions).filter((s) => s.first).sort((a, b) => b.last - a.last)
    .map((s) => ({ id: s.id, title: sessionTitle(s.id) || s.id.slice(0, 8) }));
  return { models: [...models].sort(), projects: [...projects].sort(), sessions };
}

function live() {
  const list = sortedList();
  const now = Date.now();
  return {
    active: lastActivityTs > 0 && now - lastActivityTs < ACTIVE_MS,
    lastTs: lastActivityTs || null,
    recent: list.slice(-10).reverse().map(rowView),
    now,
    lastWriteTs: lastWriteTs || null,
  };
}

function status() {
  const withUsage = new Set();
  for (const r of reqMap.values()) if (r.promptId) withUsage.add(r.promptId);
  let extra = 0, partial = 0;
  for (const r of reqMap.values()) { if (r.extraIter) extra++; if (r.usagePartial) partial++; }
  return {
    startDate: START_DATE, startMs: START_MS, projectsDir: PROJECTS_DIR, lastScanAt, lastScanMs, lastError,
    filesTracked: Object.keys(store.files).length, requests: reqMap.size,
    prompts: Object.values(store.prompts).filter((p) => p.origin === 'human').length, promptsWithUsage: withUsage.size,
    pricingSource: CONFIG.pricing.source, pricedModels: Object.keys(CONFIG.pricing.models),
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone, tzOffsetMin: -new Date().getTimezoneOffset(),
    lineErrors, requestsWithExtraIterations: extra, partialRequests: partial,
  };
}

function csvEscape(v) {
  let s = v == null ? '' : String(v);
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = "'" + s; // spreadsheet formula injection
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function exportCsv(q) {
  const rows = filterRequests(q).reverse();
  const head = ['time', 'session', 'project', 'model', 'effort', 'type', 'input', 'output', 'cache_write_5m', 'cache_write_1h', 'cache_read', 'thinking', 'total_tokens', 'cost_usd', 'latency_ms', 'stop_reason', 'tools', 'prompt'];
  const lines = [head.join(',')];
  for (const r of rows) {
    const p = r.promptId && store.prompts[r.promptId];
    lines.push([
      new Date(r.ts).toISOString(), r.sessionId, r.project, r.model, r.effort, r.sidechain ? 'subagent' : 'main',
      r.input, r.output, r.cacheWrite5m, r.cacheWrite1h, r.cacheRead, r.thinking, tokensOf(r),
      r.cost ? r.cost.total.toFixed(6) : '', r.latencyMs, r.stopReason, r.tools.join(' '), p ? p.text.slice(0, 500) : '',
    ].map(csvEscape).join(','));
  }
  return lines.join('\r\n');
}

// ---------------------------------------------------------------- http

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8' };
const memo = new Map(); // responses of the heavy endpoints, valid for one data version and one minute

function memoJson(key, fn) {
  const k = `${dataVersion}|${Math.floor(Date.now() / 60000)}|${key}`;
  let s = memo.get(k);
  if (s === undefined) {
    if (memo.size > 64) memo.clear();
    s = JSON.stringify(fn());
    memo.set(k, s);
  }
  return s;
}

function sendRaw(res, body, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(body);
}
function sendJson(res, obj, status = 200) { sendRaw(res, JSON.stringify(obj), status); }

const HOST_OK = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;

function handle(req, res) {
  try {
    if (!HOST_OK.test(req.headers.host || '')) { res.writeHead(403); return res.end('Forbidden'); } // DNS-rebinding guard
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end('Method not allowed'); }
    const u = new URL(req.url, 'http://localhost');
    const q = u.searchParams;
    const key = u.pathname + '?' + q.toString();
    switch (u.pathname) {
      case '/api/status': return sendJson(res, status());
      case '/api/options': return sendRaw(res, memoJson(key, filterOptions));
      case '/api/summary': return sendRaw(res, memoJson(key, () => summary(q)));
      case '/api/requests': return sendRaw(res, memoJson(key, () => requestsPage(q)));
      case '/api/prompts': return sendRaw(res, memoJson(key, () => promptsPage(q)));
      case '/api/sessions': return sendRaw(res, memoJson(key, () => sessionsList(q)));
      case '/api/live':
        if (Date.now() - (lastScanAt || 0) > 1500) scan(); // freshest possible answer for the live indicator
        return sendJson(res, live());
      case '/api/request': {
        const d = requestDetail(q.get('key') || '');
        return d ? sendJson(res, d) : sendJson(res, { error: 'not found' }, 404);
      }
      case '/api/prompt': {
        const d = promptDetail(q.get('id') || '');
        return d ? sendJson(res, d) : sendJson(res, { error: 'not found' }, 404);
      }
      case '/api/export.csv': {
        const d = new Date();
        const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="claude-code-usage-${day}.csv"` });
        return res.end('\uFEFF' + exportCsv(q));
      }
      default:
    }
    if (u.pathname.startsWith('/api/')) return sendJson(res, { error: 'not found' }, 404);
    const rel = u.pathname === '/' ? 'index.html' : decodeURIComponent(u.pathname).replace(/^\/+/, '');
    const file = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404); return res.end('Not found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
  } catch (e) {
    if (res.headersSent) return res.destroy();
    sendJson(res, { error: String(e && e.message || e) }, 500);
  }
}

function createServer() { return http.createServer(handle); }

function start(port = PORT, host = HOST) {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server));
  });
}

// ---------------------------------------------------------------- main

if (require.main === module) {
  loadStore();
  scan();
  const timer = setInterval(scan, Math.max(2, CONFIG.scanIntervalSeconds || 5) * 1000);
  start(PORT, HOST).then(() => {
    console.log(`CCUsageX on http://${HOST}:${PORT}  (reading ${PROJECTS_DIR}, since ${START_DATE})`);
  }).catch((e) => {
    console.error(e && e.code === 'EADDRINUSE' ? `Port ${PORT} is already in use.` : String(e && e.stack || e));
    clearInterval(timer);
    process.exit(1);
  });
  const bye = () => { saveStore(true); process.exit(0); };
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
  process.on('exit', () => saveStore(true));
}

module.exports = {
  start, createServer, handle, scan, scanFile, handleLine, loadStore, saveStore, resetState, newFstate,
  computeCost, priceFor, summary, filterRequests, live, status, resolveOrphans,
  _state: { get store() { return store; }, reqMap, byPrompt, STORE_FILE, START_MS, PROJECTS_DIR },
};
