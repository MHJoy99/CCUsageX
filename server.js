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
  liveReset();
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
  const stripped = text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<ide_(selection|opened_file)>[\s\S]*?<\/ide_\1>/g, '')
    .replace(/<browser_instruction>[\s\S]*?<\/browser_instruction>/g, '')
    .trim();
  if (stripped) return stripped;
  // a message that is only an injected notice: show the notice itself, without its tags
  const notice = /<browser_instruction>([\s\S]*?)<\/browser_instruction>/.exec(text);
  return notice ? notice[1].trim() : '';
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

let replaying = false; // scanFile is re-reading a recent transcript only to rebuild the live view (store already has it)

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
    liveTitleSeen(o.sessionId);
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

  if (o.sessionId && known && ts >= liveNow - LIVE_KEEP_MS) { // the parent session reports a finished background subagent
    let note = null;
    if (o.type === 'queue-operation') note = o.operation === 'enqueue' ? o.content : null;
    else if (queued) note = textOf(o.attachment.prompt).text;
    else if (o.type === 'user' && c && !c.toolResult) note = c.text;
    if (typeof note === 'string' && note.includes('<task-notification>')) liveNotifications(o, note, ts, project);
  }

  const lv = o.sessionId && known && (o.type === 'user' || o.type === 'assistant') && ts >= liveNow - LIVE_KEEP_MS
    ? liveCtx(o, ts, project, side, file, fstate, pid) : null; // null = too old to be live
  if (lv && o.type === 'user') liveUser(o, c, kind, lv, file);

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
  if (lv) { lv.model = msg.model; liveAssistant(o, msg, lv, file); }
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
    if (replaying) { // live-only re-read at startup: the store already has this request. A hard stop can save the
      // stream-start usage but not the final line, so the usage max runs again (idempotent); content stays as stored.
      if (mergeUsage(r, u, msg, cw5m, cw1h)) { finalize(r); dirty = true; }
      if (lv) livePend(r, lv, file);
      return;
    }
    if (ts < r.ts) { r.ts = ts; listDirty = true; }
    if (r.parentTs == null && o.parentUuid && fstate.uuids[o.parentUuid] != null) r.parentTs = fstate.uuids[o.parentUuid];
    if (!r.promptId && pid) setPrompt(r, pid);
  }
  if (ts > r.endTs) r.endTs = ts;
  mergeUsage(r, u, msg, cw5m, cw1h);

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
  if (lv) livePend(r, lv, file);

  const s = sessionOf(o.sessionId);
  s.project = s.project || r.project;
  s.first = Math.min(s.first || ts, ts);
  s.last = Math.max(s.last || ts, ts);
  dirty = true;
}

// Claude Code writes one line per content block; usage repeats (output_tokens grows while streaming) — keep the max.
// Returns true when anything changed.
function mergeUsage(r, u, msg, cw5m, cw1h) {
  const before = r.input + r.output + r.cacheRead + r.cacheWrite5m + r.cacheWrite1h + r.thinking + r.webSearch + r.webFetch + r.extraIter;
  const stop = r.stopReason;
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
  return r.stopReason !== stop || r.input + r.output + r.cacheRead + r.cacheWrite5m + r.cacheWrite1h + r.thinking + r.webSearch + r.webFetch + r.extraIter !== before;
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
    fstate.agent = { type: m.agentType || null, desc: m.description ? String(m.description).slice(0, 200) : null, toolUseId: m.toolUseId || null };
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
  liveNow = Date.now();
  let fstate = store.files[file];
  if (!fstate) {
    if (st.mtimeMs < START_MS) return; // nothing in it can be on/after the start date
    fstate = store.files[file] = newFstate();
  }
  if (st.mtimeMs > lastWriteTs) lastWriteTs = st.mtimeMs;
  const hot = liveNow - st.mtimeMs < LIVE_KEEP_MS;
  if (hot) {
    LV.hot.set(file, st.mtimeMs);
    if (!LV.replayed.has(file)) { // first look in this process: a store from an earlier run skips the file, but the live view starts empty
      remember(LV.replayed, file, 5000);
      if (fstate.offset > 0) { fstate = store.files[file] = newFstate(); replaying = true; }
    }
  }
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
    replaying = false;
    liveFlush(file, liveNow - st.mtimeMs < LIVE_EMIT_MS);
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

// Fingerprint of the UI files: an open dashboard reloads itself when this changes (no manual refresh after updates).
function uiBuild() {
  try {
    let h = 0;
    for (const n of fs.readdirSync(PUBLIC_DIR).sort()) {
      const st = fs.statSync(path.join(PUBLIC_DIR, n));
      for (const ch of n + ':' + st.size + ':' + Math.floor(st.mtimeMs)) h = (Math.imul(h, 31) + ch.charCodeAt(0)) | 0;
    }
    return (h >>> 0).toString(36);
  } catch { return null; }
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
    lineErrors, requestsWithExtraIterations: extra, partialRequests: partial, uiBuild: uiBuild(),
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

// ---------------------------------------------------------------- live (real-time view)
// Events are extracted by handleLine while it parses (no second parser), folded into per-session state, kept in a
// 500-event ring buffer and pushed to /api/stream subscribers (Server-Sent Events). Everything here is bounded.

const LIVE_EMIT_MS = 10 * 60e3;   // only records this fresh produce events (no history floods)
const LIVE_KEEP_MS = 30 * 60e3;   // sessions stay in the live map this long (older records are ignored by it)
const LIVE_IDLE_MS = 10 * 60e3;   // no events for this long -> phase 'idle'
const LIVE_PARTIAL_MS = 4000;     // a request with no stop_reason is finalised as partial after this much quiet
const LIVE_PING_MS = 15000;
const LIVE_STATE_MIN_MS = 1000;   // `state` events at most this often
const LIVE_RING = 500;
const LIVE_RECENT = 40;
const LIVE_AGENTS_MAX = 64;       // per session; finished ones are dropped first
const LIVE_STALE_GEN_MS = 180e3;  // 'generating' with no events for this long -> 'idle' (stale)
const LIVE_STALE_TOOL_MS = 15 * 60e3; // 'tool' with no events for this long -> 'idle' (stale)
const LIVE_UNKNOWN_MS = 10 * 60e3;    // a subagent idle (stale) this long without ever ending -> 'done', endStatus 'unknown'
const LIVE_END_GRACE_MS = 5000;   // after a hand-back / task-notification end, records this close behind it do not revive the agent
const LIVE_END_DUP_MS = 120e3;    // a second end signal this close to the first is the same ending (only the status may improve)
const LIVE_PENDING_ENDS = 200;    // task-notifications seen before their agent's transcript, per session
const LIVE_CTX_LIMIT = 1000000;
const SSE_BACKLOG_MAX = 4 << 20;  // drop a subscriber that does not read

let liveNow = Date.now();
const seqSeed = Math.floor(Date.now() / 1000) * 1000; // ids stay monotonic across restarts, so a stale Last-Event-ID never resumes
const LV = {
  seq: seqSeed, evicted: seqSeed, ring: [], sessions: new Map(), tools: new Map(), emittedKeys: new Set(), emittedReqs: new Set(),
  pend: new Map(), titles: new Set(), hot: new Map(), replayed: new Set(), subs: new Set(), servers: new Set(),
  watcher: null, watchIno: null, watchTry: 0, polling: false, pollTimer: null, lastWalk: 0, lastDirCheck: 0, rootCheck: 0,
  fileTimers: new Map(), tick: null, lastStateAt: 0, lastStateStr: '', lastPing: 0, tidyTimer: null, stateDirty: false, totals: null,
};

function liveReset() {
  LV.ring = []; LV.evicted = LV.seq; LV.sessions.clear(); LV.tools.clear(); LV.emittedKeys.clear(); LV.emittedReqs.clear();
  LV.pend.clear(); LV.titles.clear(); LV.hot.clear(); LV.replayed.clear(); LV.stateDirty = true; LV.totals = null;
}

function remember(set, k, max) {
  set.add(k);
  if (set.size > max) set.delete(set.values().next().value);
}

function clip(s, n) {
  s = String(s == null ? '' : s).trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function toolSummary(name, input) {
  if (!input || typeof input !== 'object') return '';
  let v;
  switch (name) {
    case 'Bash': v = input.command || input.description; break;
    case 'Read': case 'Edit': case 'Write': case 'MultiEdit': case 'NotebookEdit': v = input.file_path || input.notebook_path; break;
    case 'Grep': case 'Glob': v = input.pattern; break;
    case 'WebSearch': v = input.query; break;
    case 'WebFetch': v = input.url; break;
    case 'Agent': case 'Task': v = input.description || input.prompt; break;
    default:
  }
  if (typeof v !== 'string' || !v) {
    v = '';
    for (const x of Object.values(input)) if (typeof x === 'string' && x) { v = x; break; }
  }
  return clip(v.replace(/\s+/g, ' '), 160);
}

function liveCtx(o, ts, project, side, file, fstate, pid) {
  const agent = side ? fstate.agent : null;
  const agentId = side ? (o.agentId || (/[\\/]subagents[\\/]/.test(file) ? path.basename(file, '.jsonl').replace(/^agent-/, '') : null)) : null;
  return {
    ts, sessionId: o.sessionId, promptId: pid || null, agentId, agentType: (agent && agent.type) || null, sidechain: side,
    model: null, project, entrypoint: o.entrypoint || null, agentMeta: agent, silent: ts < liveNow - LIVE_EMIT_MS,
  };
}

function newAgent(agentId, type, desc, ts) {
  return {
    agentId: agentId || null, agentType: type || null, desc: desc || null, model: null, phase: agentId ? 'generating' : 'idle', phaseSince: ts,
    currentTool: null, open: new Map(), requests: 0, cost: 0, startedTs: ts, lastTs: ts,
  };
}

function liveSession(c) {
  let s = LV.sessions.get(c.sessionId);
  if (!s) {
    s = {
      sessionId: c.sessionId, project: c.project || null, model: null, entrypoint: c.entrypoint || null, startedTs: c.ts, lastTs: c.ts,
      promptText: '', promptTs: null, ctxTokens: 0, agents: new Map(), turn: { requests: 0, cost: 0, tokens: 0, output: 0, startedTs: c.ts },
      recent: [], lastTitle: undefined, pendingEnds: new Map(),
    };
    s.agents.set('', newAgent(null, null, null, c.ts));
    LV.sessions.set(c.sessionId, s);
  }
  if (!s.entrypoint && c.entrypoint) s.entrypoint = c.entrypoint;
  if (!s.project && c.project) s.project = c.project;
  return s;
}

function setPhase(a, phase, ts) {
  if (a.phase !== phase) { a.phase = phase; a.phaseSince = ts; }
}

const END_RANK = { unknown: 0, end_turn: 1, handback: 2, completed: 3, failed: 3, killed: 4 };

function markDone(a, ts, status) {
  a.phase = 'done'; a.phaseSince = ts; a.currentTool = null; a.open.clear();
  a.endedTs = ts; a.endStatus = status || 'end_turn';
  a.endGrace = a.endStatus === 'end_turn' || a.endStatus === 'unknown' ? 0 : LIVE_END_GRACE_MS;
}

function dropAgent(s, keep) { // keep a session's agent list bounded: finished first, else the quietest
  let victim = null;
  for (const [k, x] of s.agents) if (k && x !== keep && x.phase === 'done') { victim = k; break; }
  if (victim == null) {
    let oldest = Infinity;
    for (const [k, x] of s.agents) if (k && x !== keep && x.lastTs < oldest) { oldest = x.lastTs; victim = k; }
  }
  if (victim != null) s.agents.delete(victim);
}

const REVIVES = new Set(['prompt', 'text', 'thinking', 'tool_use']);

function applyEvent(s, ev) {
  const key = ev.agentId || '';
  let a = s.agents.get(key);
  if (!a) {
    a = newAgent(ev.agentId, ev.agentType, null, ev.ts);
    s.agents.set(key, a);
    if (s.agents.size > LIVE_AGENTS_MAX) dropAgent(s, a);
  }
  if (ev.ts > s.lastTs) s.lastTs = ev.ts;
  if (ev.ts > a.lastTs) a.lastTs = ev.ts;
  if (ev.agentType && !a.agentType) a.agentType = ev.agentType;
  if (ev.model) { a.model = ev.model; if (!key || !s.model) s.model = ev.model; }
  let frozen = false; // a finished subagent: the tail of its transcript (hand-back result, ...) must not bring it back
  if (key && a.phase === 'done') {
    if (REVIVES.has(ev.kind) && ev.ts > a.endedTs + (a.endGrace || 0)) { // it was resumed (SendMessage) -> alive again
      delete a.endedTs; delete a.endStatus; a.endGrace = 0;
    } else frozen = ev.kind !== 'request' && ev.kind !== 'subagent_end' && ev.kind !== 'subagent_start';
  }
  if (frozen) return;
  switch (ev.kind) {
    case 'prompt':
      setPhase(a, 'generating', ev.ts); a.currentTool = null; a.open.clear();
      // injected turns (task-notification, peer messages, …) continue the user's turn: keep showing the human prompt
      if (!ev.sidechain && (!ev.origin || ev.origin === 'human')) {
        s.promptText = ev.text.slice(0, 200); s.promptTs = ev.ts;
        s.turn = { requests: 0, cost: 0, tokens: 0, output: 0, startedTs: ev.ts };
      }
      break;
    case 'text': case 'thinking':
      setPhase(a, 'generating', ev.ts); a.currentTool = null;
      break;
    case 'tool_use':
      a.open.set(ev.toolUseId, { tool: ev.tool, summary: ev.summary, since: ev.ts });
      a.currentTool = { tool: ev.tool, summary: ev.summary, since: ev.ts };
      setPhase(a, 'tool', ev.ts);
      break;
    case 'tool_result':
      a.open.delete(ev.toolUseId);
      if (a.open.size) { a.currentTool = { ...[...a.open.values()].pop() }; setPhase(a, 'tool', ev.ts); } else {
        a.currentTool = null; setPhase(a, 'generating', ev.ts);
      }
      break;
    case 'request':
      a.requests++; a.cost += ev.cost || 0;
      s.turn.requests++; s.turn.cost += ev.cost || 0; s.turn.tokens += ev.input + ev.output + ev.cacheRead + ev.cacheWrite; s.turn.output += ev.output;
      if (!key) s.ctxTokens = ev.input + ev.cacheRead + ev.cacheWrite;
      break;
    case 'turn_end':
      setPhase(a, 'waiting_user', ev.ts); a.currentTool = null; a.open.clear();
      break;
    case 'subagent_start':
      if (ev.desc) a.desc = ev.desc;
      break;
    case 'subagent_end':
      if (key) markDone(a, ev.ts, ev.endStatus);
      break;
    default:
  }
}

function liveEmit(kind, c, fields) {
  const s = liveSession(c);
  const ag = s.agents.get(c.agentId || '');
  const ev = {
    id: ++LV.seq, ts: c.ts, kind, sessionId: c.sessionId, promptId: c.promptId || null, agentId: c.agentId || null,
    agentType: c.agentType || (ag && ag.agentType) || null, sidechain: !!c.sidechain, model: c.model || (ag && ag.model) || s.model || null,
    project: c.project || s.project || null, ...fields,
  };
  applyEvent(s, ev);
  s.recent.push(ev);
  if (s.recent.length > LIVE_RECENT) s.recent.shift();
  LV.stateDirty = true;
  if (!c.silent) {
    LV.ring.push(ev);
    if (LV.ring.length > LIVE_RING) LV.evicted = LV.ring.shift().id;
    if (LV.subs.size) sseBroadcast(`id: ${ev.id}\nevent: ev\ndata: ${JSON.stringify(ev)}\n\n`);
  }
  return ev;
}

// A subagent is over: end_turn, a SubagentHandback call, or the parent's task-notification. Emits one subagent_end;
// a second signal for the same ending (hand-back, then notification) only improves endStatus.
function liveEndAgent(base, agentId, ts, status) {
  const s = liveSession(base);
  const a = s.agents.get(agentId);
  if (!a) {
    if (status === 'end_turn') return;
    s.pendingEnds.delete(agentId);
    s.pendingEnds.set(agentId, { ts, status });
    if (s.pendingEnds.size > LIVE_PENDING_ENDS) s.pendingEnds.delete(s.pendingEnds.keys().next().value);
    return;
  }
  if (a.phase === 'done') {
    const d = ts - a.endedTs;
    if (Math.abs(d) <= LIVE_END_DUP_MS) { if ((END_RANK[status] || 0) > (END_RANK[a.endStatus] || 0)) a.endStatus = status; return; }
    if (d < 0) return; // an older ending seen out of order
  }
  liveEmit('subagent_end', { ...base, ts, agentId, agentType: a.agentType || base.agentType || null, sidechain: true }, { agentId, endStatus: status });
}

const HANDBACK = /hand_?back/i;
const NOTE_STATUS = [[/^(completed?|done|success(ful)?|finished)$/, 'completed'], [/^(killed|stopped|cancel+ed|aborted)$/, 'killed'], [/^(failed|error(ed)?)$/, 'failed']];

// <task-notification><task-id>AGENT</task-id>...<status>completed|killed|failed</status>... in the parent session
function liveNotifications(o, text, ts, project) {
  const re = /<task-notification>([\s\S]*?)(?:<\/task-notification>|$)/g;
  const base = {
    ts, sessionId: o.sessionId, promptId: null, agentId: null, agentType: null, sidechain: false, model: null, project, entrypoint: o.entrypoint || null,
    agentMeta: null, silent: ts < liveNow - LIVE_EMIT_MS,
  };
  let m;
  for (let n = 0; n < 20 && (m = re.exec(text)); n++) {
    const id = /<task-id>\s*([^<\s]{1,80})\s*<\/task-id>/.exec(m[1]);
    const st = /<status>\s*([^<]{1,40}?)\s*<\/status>/.exec(m[1]);
    if (!id || !st) continue;
    const word = st[1].toLowerCase();
    const hit = NOTE_STATUS.find(([rx]) => rx.test(word));
    if (hit) liveEndAgent(base, id[1], ts, hit[1]);
  }
}

// first record of a subagent transcript
function liveAgentStart(c) {
  if (!c.sidechain || !c.agentId) return;
  const s = liveSession(c);
  const a = s.agents.get(c.agentId);
  const meta = c.agentMeta;
  if (a) {
    if (meta) { if (!a.agentType && meta.type) a.agentType = meta.type; if (!a.desc && meta.desc) a.desc = meta.desc; }
    return;
  }
  liveEmit('subagent_start', c, { agentId: c.agentId, agentType: c.agentType, desc: (meta && meta.desc) || null, toolUseId: (meta && meta.toolUseId) || null });
  const pe = s.pendingEnds.get(c.agentId); // its task-notification was read before its own transcript (startup order, or a late file)
  if (pe) {
    s.pendingEnds.delete(c.agentId);
    if (c.ts <= pe.ts + LIVE_END_GRACE_MS) liveEndAgent(c, c.agentId, pe.ts, pe.status);
  }
}

function liveUser(o, c, kind, lv, file) {
  liveFinalizeOthers(file, null); // any user record means the previous API message is over
  liveAgentStart(lv);
  const content = o.message && o.message.content;
  if (Array.isArray(content)) {
    for (const b of content) {
      if (!b || b.type !== 'tool_result' || !b.tool_use_id) continue;
      const dk = `r:${b.tool_use_id}`;
      if (LV.emittedKeys.has(dk)) continue;
      remember(LV.emittedKeys, dk, 6000);
      const t = LV.tools.get(b.tool_use_id);
      LV.tools.delete(b.tool_use_id);
      liveEmit('tool_result', lv, { toolUseId: b.tool_use_id, tool: t ? t.tool : null, isError: !!b.is_error, durationMs: t ? Math.max(0, lv.ts - t.ts) : null });
      if (t && lv.sidechain && lv.agentId && HANDBACK.test(t.tool)) liveEndAgent(lv, lv.agentId, lv.ts, 'handback');
    }
  }
  if (lv.sidechain) return;
  const dk = `u:${o.uuid || ''}`;
  if (kind) {
    if (o.uuid && LV.emittedKeys.has(dk)) return;
    remember(LV.emittedKeys, dk, 6000);
    const text = clip(cleanPrompt(c.text), 300);
    liveEmit('prompt', { ...lv, promptId: o.promptId || o.uuid || lv.promptId }, { text: kind === 'human' ? text : clip(`[${kind}] ${text}`, 300), origin: kind });
  } else if (INTERRUPT.test(c.text) && !LV.emittedKeys.has(dk)) {
    remember(LV.emittedKeys, dk, 6000);
    liveEmit('turn_end', lv, { stopReason: null, reason: 'interrupted' });
  }
}

function liveAssistant(o, msg, lv, file) {
  const mkey = `${msg.id || o.uuid}:${o.requestId || ''}`;
  liveFinalizeOthers(file, mkey);
  liveAgentStart(lv);
  const blocks = Array.isArray(msg.content) ? msg.content : [];
  blocks.forEach((b, i) => {
    if (!b || typeof b !== 'object') return;
    const dk = `a:${o.uuid || mkey + ':' + o.apiBlockIndex}:${i}`;
    if (LV.emittedKeys.has(dk)) return;
    if (b.type === 'text') {
      const text = clip(b.text, 300);
      if (!text) return;
      remember(LV.emittedKeys, dk, 6000);
      liveEmit('text', lv, { text });
    } else if (b.type === 'thinking' || b.type === 'redacted_thinking') {
      remember(LV.emittedKeys, dk, 6000);
      liveEmit('thinking', lv, {});
    } else if (b.type === 'tool_use' && b.name) {
      remember(LV.emittedKeys, dk, 6000);
      const id = b.id || dk;
      LV.tools.set(id, { tool: b.name, ts: lv.ts });
      if (LV.tools.size > 4000) LV.tools.delete(LV.tools.keys().next().value);
      liveEmit('tool_use', lv, { tool: b.name, toolUseId: id, summary: toolSummary(b.name, b.input) });
      if (lv.sidechain && lv.agentId && HANDBACK.test(b.name)) liveEndAgent(lv, lv.agentId, lv.ts, 'handback');
    }
  });
}

// ---- requests: one `request` event per API message, when its stop_reason line arrives (batch end) or as a partial

function livePend(r, lv, file) {
  if (LV.emittedReqs.has(r.key)) return;
  const p = LV.pend.get(r.key);
  if (p) { p.seen = Date.now(); p.c = { ...lv, model: r.model }; return; }
  LV.pend.set(r.key, { r, c: { ...lv, model: r.model }, file, seen: Date.now() });
}

const TURN_END = new Set(['end_turn', 'refusal']);

function liveEmitRequest(p, how) {
  if (!LV.pend.delete(p.r.key)) return;
  remember(LV.emittedReqs, p.r.key, 4000);
  const r = p.r;
  const c = { ...p.c, ts: r.endTs };
  liveEmit('request', c, {
    key: r.key, input: r.input, output: r.output, cacheRead: r.cacheRead, cacheWrite: r.cacheWrite5m + r.cacheWrite1h, thinking: r.thinking,
    cost: r.cost ? r.cost.total : null, latencyMs: r.latencyMs, stopReason: r.stopReason, usagePartial: !!r.usagePartial,
  });
  const ended = TURN_END.has(r.stopReason) || (!r.stopReason && how === 'timer' && !r.tools.length && !!r.response);
  if (!ended) return;
  if (c.sidechain) {
    if (c.agentId) liveEndAgent(c, c.agentId, c.ts, 'end_turn');
  } else liveEmit('turn_end', c, { stopReason: r.stopReason || null, ...(r.stopReason ? {} : { inferred: true }) });
}

function liveFinalizeOthers(file, exceptKey) {
  for (const p of [...LV.pend.values()]) if (p.file === file && p.r.key !== exceptKey) liveEmitRequest(p, 'next');
}

function liveTitleSeen(sessionId) { LV.titles.add(sessionId); }

// end of one scanFile call: emit the requests that are complete, then the title changes
function liveFlush(file, fileFresh) {
  for (const p of [...LV.pend.values()]) if (p.file === file && p.r.stopReason) liveEmitRequest(p, 'batch');
  if (!LV.titles.size) return;
  for (const id of LV.titles) {
    const s = LV.sessions.get(id);
    if (!s) continue;
    const title = sessionTitle(id);
    if (title && title !== s.lastTitle) {
      s.lastTitle = title;
      if (fileFresh) liveEmit('title', { ts: Date.now(), sessionId: id, promptId: null, agentId: null, sidechain: false, project: s.project }, { title });
    }
  }
  LV.titles.clear();
}

// ---- state payload

function liveTotals(now) {
  const k = `${dataVersion}|${Math.floor(now / 1000)}`;
  if (LV.totals && LV.totals.k === k) return LV.totals;
  const list = sortedList();
  const today = { requests: 0, cost: 0, tokens: 0, output: 0 };
  const win = { requests: 0, cost: 0, tokens: 0 };
  const midnight = new Date(now).setHours(0, 0, 0, 0);
  const fiveMin = now - 5 * 60e3;
  for (let i = lowerBound(list, Math.min(midnight, fiveMin)); i < list.length; i++) {
    const r = list[i];
    if (r.ts >= midnight) { today.requests++; today.cost += costOf(r); today.tokens += tokensOf(r); today.output += r.output; }
    if (r.ts >= fiveMin) { win.requests++; win.cost += costOf(r); win.tokens += tokensOf(r); }
  }
  LV.totals = { k, today, rate: { tokensPerMin: win.tokens / 5, costPerMin: win.cost / 5, requestsPerMin: win.requests / 5 } };
  return LV.totals;
}

// What the API reports for one agent at `now`. Claude Code never says "I am still alive", so quiet agents are
// derived: generating > 180 s / tool > 15 min without events -> idle (stale); a subagent idle for 10 more minutes
// that never ended -> done, endStatus 'unknown'. Any later event revives it (applyEvent).
function agentView(a, now) {
  let phase = a.phase;
  let stale = false;
  let endedTs = a.endedTs;
  let endStatus = a.endStatus;
  const lim = phase === 'generating' ? LIVE_STALE_GEN_MS : phase === 'tool' ? LIVE_STALE_TOOL_MS : Infinity;
  const quiet = now - a.lastTs;
  if (quiet > lim) {
    if (a.agentId && quiet > lim + LIVE_UNKNOWN_MS) { phase = 'done'; endedTs = a.lastTs; endStatus = 'unknown'; } else { phase = 'idle'; stale = true; }
  }
  return {
    agentId: a.agentId, agentType: a.agentType, desc: a.desc, model: a.model, phase, phaseSince: phase === a.phase ? a.phaseSince : a.lastTs,
    currentTool: phase === a.phase && a.currentTool ? { ...a.currentTool } : null, requests: a.requests, cost: a.cost, startedTs: a.startedTs, lastTs: a.lastTs,
    ...(phase === 'done' ? { endedTs, endStatus } : {}), ...(stale ? { stale: true } : {}),
  };
}

function liveState(nowArg) {
  const now = nowArg == null ? Date.now() : nowArg;
  const t = liveTotals(now);
  const sessions = [];
  for (const s of LV.sessions.values()) {
    if (now - s.lastTs > LIVE_KEEP_MS) continue;
    const idle = now - s.lastTs > LIVE_IDLE_MS;
    const agents = [];
    let mainView = null;
    for (const a of s.agents.values()) {
      const v = agentView(a, now);
      if (idle && v.phase !== 'done') { v.phase = 'idle'; v.currentTool = null; }
      agents.push(v);
      if (!a.agentId) mainView = v;
    }
    let phase = mainView.phase;
    if (phase === 'idle' && agents.some((a) => a.agentId && (a.phase === 'generating' || a.phase === 'tool'))) phase = 'generating';
    if (idle) phase = 'idle';
    const known = store.sessions[s.sessionId] || {};
    sessions.push({
      sessionId: s.sessionId, title: sessionTitle(s.sessionId), project: s.project, model: s.model, entrypoint: s.entrypoint,
      startedTs: known.first && known.first < s.startedTs ? known.first : s.startedTs, lastTs: s.lastTs,
      phase, phaseSince: idle ? Math.min(mainView.phaseSince, s.lastTs) : mainView.phaseSince,
      currentTool: idle || !mainView.currentTool ? null : { ...mainView.currentTool },
      promptText: s.promptText, promptTs: s.promptTs, context: { tokens: s.ctxTokens, limit: LIVE_CTX_LIMIT },
      agents, turn: { ...s.turn }, recent: s.recent.slice(),
      ...(mainView.stale ? { stale: true } : {}),
    });
  }
  sessions.sort((a, b) => b.lastTs - a.lastTs);
  const active = sessions.some((s) => s.phase === 'generating' || s.phase === 'tool' || now - s.lastTs < ACTIVE_MS);
  limitsRefresh(500);
  return { now, active, sessions, today: t.today, rate: t.rate, limits: limitsPayload(now) };
}

function liveSweepSessions(now) {
  for (const [id, s] of LV.sessions) if (now - s.lastTs > LIVE_KEEP_MS) { LV.sessions.delete(id); LV.stateDirty = true; }
  for (const [f, m] of LV.hot) if (now - m > LIVE_KEEP_MS) LV.hot.delete(f);
}

// ---- SSE

function sseBroadcast(chunk) {
  for (const sub of LV.subs) {
    try {
      if (sub.res.writableLength > SSE_BACKLOG_MAX) { sub.res.destroy(); continue; }
      sub.res.write(chunk);
    } catch { LV.subs.delete(sub); }
  }
}

function sseState(event, state) {
  return `id: ${LV.seq}\nevent: ${event}\ndata: ${JSON.stringify(state)}\n\n`;
}

function stateKey(st) { return JSON.stringify({ ...st, now: 0, limits: 0 }); } // limits have their own event

function sseConnect(req, res, u) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', 'X-Content-Type-Options': 'nosniff',
  });
  if (req.method === 'HEAD') return res.end();
  req.socket.setTimeout(0);
  req.socket.setNoDelay(true);
  res.write('retry: 1000\n\n');
  const raw = req.headers['last-event-id'] || u.searchParams.get('lastEventId') || '';
  const last = /^\d+$/.test(raw) ? Number(raw) : null;
  if (last != null && last >= LV.evicted && last <= LV.seq) { // resume: replay what the client missed, then re-sync
    for (const ev of LV.ring) if (ev.id > last) res.write(`id: ${ev.id}\nevent: ev\ndata: ${JSON.stringify(ev)}\n\n`);
  }
  const state = liveState();
  res.write(sseState('snapshot', state));
  res.write(sseState('limits', state.limits));
  const sub = { res };
  if (!LV.subs.size) LV.lastPing = Date.now(); // first ping 15 s after the first subscriber
  if (!LV.subs.size) { LIM.lastKey = limitsKey(state.limits); LIM.lastSentAt = Date.now(); } // the limits event above is this client's baseline
  LV.subs.add(sub);
  LV.lastStateStr = stateKey(state);
  const done = () => { LV.subs.delete(sub); };
  req.on('close', done);
  res.on('close', done);
  res.on('error', done);
  liveEnsureRunning();
}

function liveTick() {
  const now = Date.now();
  for (const p of [...LV.pend.values()]) if (now - p.seen > LIVE_PARTIAL_MS) liveEmitRequest(p, 'timer');
  liveSweepSessions(now);
  liveEnsureWatch(now);
  limitsEnsureWatch(now);
  if (LV.subs.size) {
    try { limitsBroadcast(false); } catch (e) { lastError = 'limits: ' + String(e && e.message || e); }
    if (now - LV.lastPing >= LIVE_PING_MS) { LV.lastPing = now; sseBroadcast(': ping\n\n'); }
    if (now - LV.lastStateAt >= LIVE_STATE_MIN_MS) {
      const st = liveState();
      const k = stateKey(st);
      if (k !== LV.lastStateStr) { LV.lastStateStr = k; LV.lastStateAt = now; sseBroadcast(sseState('state', st)); }
    }
  }
}

// ---- freshness: fs.watch (recursive), one file scanned per change; polling when that is not available

function liveScanFile(file) {
  try { scanFile(file); } catch (e) { lastError = 'live scan: ' + String(e && e.message || e); }
  if (!LV.tidyTimer) {
    LV.tidyTimer = setTimeout(() => {
      LV.tidyTimer = null;
      try { resolveOrphans(); saveStore(); } catch (e) { lastError = String(e && e.message || e); }
    }, 500);
    LV.tidyTimer.unref();
  }
}

function liveKick(file) { // scan right away, and once more 30 ms later for anything written in the meantime
  const t = LV.fileTimers.get(file);
  if (t) { t.again = true; return; }
  const rec = { again: false, timer: null };
  LV.fileTimers.set(file, rec);
  setImmediate(() => liveScanFile(file));
  rec.timer = setTimeout(() => {
    LV.fileTimers.delete(file);
    if (rec.again) liveScanFile(file);
  }, 30);
  rec.timer.unref();
}

function liveOnFsEvent(name) {
  if (!LV.watcher) return;
  const n = name == null ? '' : String(name);
  if (!/\.jsonl$/i.test(n)) { liveCheckRoot(); return; } // directories, meta files; also guards a watcher spinning on a deleted root
  liveKick(path.isAbsolute(n) ? path.normalize(n.replace(/^\\\\\?\\/, '')) : path.join(PROJECTS_DIR, n));
}

function liveCheckRoot() {
  const now = Date.now();
  if (now - LV.rootCheck < 250) return;
  LV.rootCheck = now;
  let ino = null;
  try { ino = fs.statSync(PROJECTS_DIR).ino; } catch { /* gone */ }
  if (ino == null || ino !== LV.watchIno) liveDropWatcher();
}

function liveDropWatcher() {
  const w = LV.watcher;
  LV.watcher = null;
  if (w) { try { w.close(); } catch { /* ignore */ } }
  LV.watchTry = 0; // the tick re-creates it
}

function liveStartPolling() {
  if (LV.polling) return;
  LV.polling = true;
  LV.pollTimer = setInterval(() => {
    const now = Date.now();
    if (now - LV.lastWalk >= 2000) { // discover new transcripts
      LV.lastWalk = now;
      for (const f of walkJsonl(PROJECTS_DIR)) if (!store.files[f]) liveScanFile(f);
    }
    for (const [f, m] of LV.hot) {
      let st;
      try { st = fs.statSync(f); } catch { LV.hot.delete(f); continue; }
      const fst = store.files[f];
      if (st.mtimeMs !== m || (fst && st.size !== fst.offset)) liveScanFile(f);
    }
  }, 500);
  LV.pollTimer.unref();
}

function liveEnsureWatch(now = Date.now()) {
  if (LV.polling) return;
  if (LV.watcher) {
    if (now - LV.lastDirCheck > 5000) { LV.lastDirCheck = now; liveCheckRoot(); }
    return;
  }
  if (now - LV.watchTry < 1000) return;
  LV.watchTry = now;
  if (process.env.CCU_LIVE_POLL === '1') return liveStartPolling();
  let ino;
  try { ino = fs.statSync(PROJECTS_DIR).ino; } catch { return; } // not there yet; try again on the next tick
  try {
    const w = fs.watch(PROJECTS_DIR, { recursive: true, persistent: false }, (type, name) => liveOnFsEvent(name));
    w.on('error', () => { if (LV.watcher === w) liveDropWatcher(); });
    w.on('close', () => { if (LV.watcher === w) { LV.watcher = null; LV.watchTry = 0; } });
    LV.watcher = w;
    LV.watchIno = ino;
  } catch (e) {
    if (e && e.code !== 'ENOENT') liveStartPolling(); // recursive watch unsupported here (older Linux Node)
    return;
  }
  setImmediate(() => { try { scan(); } catch { /* scan reports its own errors */ } }); // cover anything written before the watcher existed
}

function liveEnsureRunning() {
  if (LV.tick) return;
  LV.tick = setInterval(liveTick, 1000);
  LV.tick.unref();
}

function liveAttach(server) {
  LV.servers.add(server);
  liveEnsureRunning();
  liveEnsureWatch();
  limitsEnsureWatch();
  const origClose = server.close;
  server.close = function close(...args) { // open event streams would keep close() waiting forever
    for (const sub of LV.subs) if (sub.res.socket && sub.res.socket.server === server) sub.res.destroy();
    return origClose.apply(this, args);
  };
  server.once('close', () => {
    LV.servers.delete(server);
    if (!LV.servers.size) stopLive();
  });
}

function stopLive() {
  liveDropWatcher();
  limitsStop();
  if (LV.tick) { clearInterval(LV.tick); LV.tick = null; }
  if (LV.pollTimer) { clearInterval(LV.pollTimer); LV.pollTimer = null; }
  LV.polling = false;
  for (const rec of LV.fileTimers.values()) clearTimeout(rec.timer);
  LV.fileTimers.clear();
  if (LV.tidyTimer) { clearTimeout(LV.tidyTimer); LV.tidyTimer = null; }
  for (const sub of LV.subs) { try { sub.res.destroy(); } catch { /* ignore */ } }
  LV.subs.clear();
}

// ---------------------------------------------------------------- plan limits (from Claude Code's status line)
// scripts/statusline.js records the documented `rate_limits` of the status line stdin as <DATA_DIR>/limits/<session>.json
// (+ limits/history.jsonl, one line per change). Nothing here calls the network or reads credentials.

const LIM_DIR = path.join(DATA_DIR, 'limits');
const LIM_STALE_MS = 15 * 60e3;       // freshest report older than this -> stale (values are still returned)
const LIM_KEEP_MS = 8 * 24 * 3600e3;  // ignore snapshots / history points older than this
const LIM_HIST_POINTS = 120;          // points per window in the payload
const LIM_MIN_SPAN_MS = 5 * 60e3;     // burn rate needs at least this much time between its first and last point
const LIM_WINDOWS = {
  five_hour: { key: '5h', windowMs: 5 * 3600e3, lookbackMs: 60 * 60e3 },
  seven_day: { key: '7d', windowMs: 7 * 24 * 3600e3, lookbackMs: 24 * 3600e3 },
  spend_limit: { key: 'spend', windowMs: null, lookbackMs: 24 * 3600e3 },
};
const LIM = {
  snaps: new Map(),      // file -> { mtimeMs, size, snap }
  hist: { size: 0, offset: 0, mtimeMs: 0, points: [] },
  loadedAt: 0, watcher: null, watchTry: 0, kick: null, lastKey: '', lastSentAt: 0,
};

function limStatus(p) { return p >= 100 ? 'limit' : p >= 90 ? 'high' : p >= 70 ? 'watch' : 'ok'; }
function limFiniteNum(v) { return typeof v === 'number' && Number.isFinite(v) ? v : null; }
function limRound(v, d) { const k = 10 ** d; return Math.round(v * k) / k; }
function limMs(v) { v = limFiniteNum(v); return v == null ? null : v < 1e12 ? Math.round(v * 1000) : Math.round(v); } // epoch seconds -> ms

// Least-squares slope of used% over time, in percentage points per hour. null with < 2 points or < 5 minutes of span.
// minSpanMs lets long windows demand more history, so a short burst is not extrapolated over days.
function limBurn(points, minSpanMs = LIM_MIN_SPAN_MS) {
  if (points.length < 2) return null;
  if (points[points.length - 1].t - points[0].t < minSpanMs) return null;
  const t0 = points[0].t;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const q of points) { const x = (q.t - t0) / 3600e3; sx += x; sy += q.p; sxx += x * x; sxy += x * q.p; }
  const n = points.length;
  const den = n * sxx - sx * sx;
  if (!(den > 0)) return null;
  return Math.max(0, (n * sxy - sx * sy) / den);
}

// One window's payload entry. `hist` = recorded points {t,p} for exactly this window instance (any order), `wd` = LIM_WINDOWS entry,
// `cur` = { used, resetsAt(ms)|null, updatedAt(ms) }.
//   windowStart = resetsAt - windowMs;  elapsedPct = (now - windowStart) / windowMs
//   burn = least-squares slope of the points inside the lookback (60 min for 5h, 24 h for 7d) and inside the window
//   projectedPctAtReset = max(0, used + burn * hoursLeft);  projectedHitAt = now + (100 - used) / burn when that crosses 100 before the reset
function limWindow(wd, cur, hist, now) {
  const used = Math.max(0, Math.min(100, cur.used));
  const resetsAt = cur.resetsAt;
  const windowMs = wd.windowMs;
  const startedAt = windowMs && resetsAt ? resetsAt - windowMs : null;
  const elapsedPct = startedAt != null ? limRound(Math.max(0, Math.min(100, (now - startedAt) / windowMs * 100)), 2) : null;
  const seen = Math.min(now, cur.updatedAt);
  const pts = hist.filter((q) => q.t <= now && (startedAt == null || q.t >= startedAt)).sort((a, b) => a.t - b.t);
  if (!pts.length || pts[pts.length - 1].t < seen) pts.push({ t: seen, p: used }); // the value held as of the last report
  const lb = Math.max(startedAt == null ? 0 : startedAt, now - wd.lookbackMs);
  const fit = pts.filter((q) => q.t >= lb);
  const before = pts.filter((q) => q.t < lb);
  // percentages only change when recorded, so the value in force when the lookback began counts as a point (only while reports are fresh)
  if (before.length && fit.length && fit[0].t > lb && now - seen <= LIM_STALE_MS) fit.unshift({ t: lb, p: before[before.length - 1].p });
  const burn = limBurn(fit, windowMs ? Math.max(LIM_MIN_SPAN_MS, windowMs / 40) : LIM_MIN_SPAN_MS); // 5h: 7.5 min, 7d: 4.2 h
  const hoursLeft = resetsAt ? Math.max(0, (resetsAt - now) / 3600e3) : null;
  let projected = null;
  let hitAt = null;
  if (burn != null && hoursLeft != null) {
    projected = limRound(Math.max(0, used + burn * hoursLeft), 1);
    if (used < 100 && burn > 0 && used + burn * hoursLeft >= 100) hitAt = Math.round(now + (100 - used) / burn * 3600e3);
  }
  let out = pts;
  if (out.length > LIM_HIST_POINTS) { // even downsample, keep first and last
    const step = (out.length - 1) / (LIM_HIST_POINTS - 1);
    out = Array.from({ length: LIM_HIST_POINTS }, (_, i) => pts[Math.round(i * step)]);
  }
  return {
    usedPct: limRound(used, 2), resetsAt, windowMs, startedAt, elapsedPct,
    burnPerHour: burn == null ? null : limRound(burn, 3),
    projectedPctAtReset: projected, projectedHitAt: hitAt,
    status: limStatus(used),
    history: out.map((q) => ({ t: q.t, p: limRound(q.p, 2) })),
    willExceed: projected != null && projected > 100,   // extra: the projection crosses 100 % before the reset
    updatedAt: cur.updatedAt,                            // extra: when this value was last reported
  };
}


// Per-model weekly windows ("weekly_scoped") come only from the /usage probe snapshot: `scoped: [{ label, used_percentage, resets_at, severity, is_active }]`.
function limScoped(valid, hist, now) {
  let snap = null;
  for (const s of valid) if (Array.isArray(s.scoped) && (!snap || s.receivedAt > snap.receivedAt)) snap = s;
  if (!snap) return [];
  const out = [];
  for (const sc of snap.scoped) {
    if (!sc || typeof sc.label !== 'string') continue;
    const used = limFiniteNum(sc.used_percentage);
    const resetsAt = limMs(sc.resets_at);
    if (used == null || resetsAt == null || resetsAt <= now) continue;
    const wd = { key: '7d:' + sc.label, windowMs: 7 * 24 * 3600e3, lookbackMs: 24 * 3600e3 };
    const points = (hist || []).filter((h) => h && h.w === wd.key && limFiniteNum(h.t) != null && limFiniteNum(h.p) != null &&
      limMs(h.r) != null && Math.abs(limMs(h.r) - resetsAt) < 120e3).map((h) => ({ t: h.t, p: h.p }));
    const e = limWindow(wd, { used, resetsAt, updatedAt: snap.receivedAt }, points, now);
    out.push({ key: sc.label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'scoped', label: sc.label, ...e,
      severity: typeof sc.severity === 'string' ? sc.severity : null, isActive: sc.is_active === true });
  }
  return out;
}

function limExtraUsage(valid) {
  let snap = null;
  for (const s of valid) if (s.extra_usage && s.extra_usage.is_enabled === true && (!snap || s.receivedAt > snap.receivedAt)) snap = s;
  if (!snap) return null;
  const x = snap.extra_usage;
  return { enabled: true, monthlyLimit: limFiniteNum(x.monthly_limit), usedCredits: limFiniteNum(x.used_credits), utilization: limFiniteNum(x.utilization), currency: typeof x.currency === 'string' ? x.currency : null };
}

// snaps: parsed snapshot files; hist: [{t,w,p,r}] from history.jsonl. Pure: everything depends on the arguments and `now`.
function computeLimits(snaps, hist, now) {
  const valid = (snaps || []).filter((s) => s && limFiniteNum(s.receivedAt) != null && now - s.receivedAt < LIM_KEEP_MS && s.receivedAt <= now + 60e3);
  const out = { available: false, source: 'statusline', updatedAt: null, windows: {}, sessions: valid.filter((s) => now - s.receivedAt < 24 * 3600e3).length, now };
  if (!valid.length) { out.reason = 'no-data'; return out; }
  const reset = {};
  const hasData = valid.some((s) => s.rate_limits || s.spend_limit);
  for (const name of Object.keys(LIM_WINDOWS)) {
    const wd = LIM_WINDOWS[name];
    const cands = [];
    for (const s of valid) {
      const w = name === 'spend_limit' ? s.spend_limit : s.rate_limits && s.rate_limits[name];
      if (!w) continue;
      const used = limFiniteNum(w.used_percentage);
      if (used == null) continue;
      const resetsAt = limMs(w.resets_at);
      if (resetsAt != null && resetsAt <= now) { reset[name] = Math.max(reset[name] || 0, resetsAt); continue; } // window is over: back to 0
      cands.push({ s, used, resetsAt, w });
    }
    if (!cands.length) continue;
    // the account is the same in every session: the snapshot whose numbers changed most recently wins
    const fresh = (c) => (limFiniteNum(c.s.changedAt) != null ? c.s.changedAt : c.s.receivedAt);
    cands.sort((a, b) => fresh(b) - fresh(a) || b.s.receivedAt - a.s.receivedAt || b.used - a.used);
    const win = cands[0];
    const same = cands.filter((c) => win.resetsAt == null || (c.resetsAt != null && Math.abs(c.resetsAt - win.resetsAt) < 60e3));
    const updatedAt = Math.max(...same.map((c) => c.s.receivedAt));
    const points = (hist || []).filter((h) => h && h.w === wd.key && limFiniteNum(h.t) != null && limFiniteNum(h.p) != null &&
      (win.resetsAt == null ? h.r == null : limMs(h.r) != null && Math.abs(limMs(h.r) - win.resetsAt) < 120e3)).map((h) => ({ t: h.t, p: h.p }));
    const entry = limWindow(wd, { used: win.used, resetsAt: win.resetsAt, updatedAt }, points, now);
    entry.source = win.s.source === 'usage' ? 'usage' : 'statusline';
    if (typeof win.w.severity === 'string') entry.severity = win.w.severity;
    if (typeof win.w.is_active === 'boolean') entry.isActive = win.w.is_active;
    if (name === 'spend_limit') {
      entry.usedUsd = limFiniteNum(win.w.used_usd);
      entry.limitUsd = limFiniteNum(win.w.limit_usd);
      entry.period = typeof win.w.period === 'string' ? win.w.period : null;
    }
    out.windows[name] = entry;
  }
  const names = Object.keys(out.windows);
  const scoped = limScoped(valid, hist, now);
  if (scoped.length) out.windows.scoped = scoped;
  const xu = limExtraUsage(valid);
  if (xu) out.extraUsage = xu;
  const lead = out.windows.five_hour || out.windows.seven_day;
  if (lead) out.source = lead.source;
  if (Object.keys(reset).length) out.reset = reset; // extra: windows reported earlier that have since reset (their old resetsAt, ms)
  out.activeSessions = valid.filter((s) => now - s.receivedAt < LIM_STALE_MS).length;
  if (!names.length && !scoped.length) { out.reason = hasData ? 'no-data' : 'not-subscriber'; return out; }
  out.available = true;
  out.updatedAt = Math.max(...names.map((n) => out.windows[n].updatedAt), ...scoped.map((w) => w.updatedAt));
  if (now - out.updatedAt > LIM_STALE_MS) { out.stale = true; out.reason = 'stale'; }
  return out;
}

function limitsReadHistory() {
  const h = LIM.hist;
  const file = path.join(LIM_DIR, 'history.jsonl');
  let st;
  try { st = fs.statSync(file); } catch { h.size = 0; h.offset = 0; h.mtimeMs = 0; h.points = []; return; }
  if (st.size === h.size && st.mtimeMs === h.mtimeMs) return;
  let start = h.offset;
  if (st.size < h.size) { start = 0; h.points = []; } // the statusline script capped (rewrote) the file
  let skipFirst = false;
  const MAX = 2 << 20;
  if (st.size - start > MAX) { start = st.size - MAX; skipFirst = true; h.points = []; }
  let text = '';
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(st.size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      text = buf.toString('utf8');
    } finally { fs.closeSync(fd); }
  } catch { return; }
  h.size = st.size;
  h.mtimeMs = st.mtimeMs;
  const cut = text.lastIndexOf('\n');
  if (cut < 0) return; // no complete line yet
  h.offset = start + Buffer.byteLength(text.slice(0, cut + 1));
  const lines = text.slice(0, cut).split('\n');
  if (skipFirst) lines.shift();
  const min = Date.now() - LIM_KEEP_MS;
  for (const ln of lines) {
    if (!ln) continue;
    try {
      const p = JSON.parse(ln);
      if (p && typeof p.w === 'string' && limFiniteNum(p.t) != null && limFiniteNum(p.p) != null) h.points.push({ t: p.t, w: p.w, p: p.p, r: p.r == null ? null : p.r });
    } catch { /* partial or foreign line */ }
  }
  h.points = h.points.filter((p) => p.t >= min);
  if (h.points.length > 50000) h.points = h.points.slice(-50000);
}

// Re-read changed snapshot files. maxAgeMs > 0 lets cheap callers (live state, ticks) reuse a very recent read.
function limitsRefresh(maxAgeMs = 0) {
  const nowMs = Date.now();
  if (maxAgeMs > 0 && nowMs - LIM.loadedAt < maxAgeMs) return;
  LIM.loadedAt = nowMs;
  let names = [];
  try { names = fs.readdirSync(LIM_DIR); } catch { LIM.snaps.clear(); }
  const seen = new Set();
  for (const n of names) {
    if (!/\.json$/i.test(n)) continue;
    const f = path.join(LIM_DIR, n);
    seen.add(f);
    let st;
    try { st = fs.statSync(f); } catch { continue; }
    const c = LIM.snaps.get(f);
    if (c && c.mtimeMs === st.mtimeMs && c.size === st.size) continue;
    try {
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (j && typeof j === 'object') LIM.snaps.set(f, { mtimeMs: st.mtimeMs, size: st.size, snap: j });
    } catch { /* half-written or foreign file: keep what we had, the next event retries */ }
  }
  for (const f of [...LIM.snaps.keys()]) if (!seen.has(f)) LIM.snaps.delete(f);
  limitsReadHistory();
}

// Is CCUsageX's status line configured in Claude Code's settings? Read-only, cached briefly. null = can't tell.
let limInstalled = { at: 0, v: null };
function statuslineInstalled(now = Date.now()) {
  if (now - limInstalled.at < 10e3) return limInstalled.v;
  let v = null;
  try {
    const j = JSON.parse(fs.readFileSync(path.join(CLAUDE_DIR, 'settings.json'), 'utf8').replace(/^﻿/, ''));
    const cmd = j && j.statusLine && typeof j.statusLine.command === 'string' ? j.statusLine.command : '';
    v = /statusline.js/i.test(cmd);
  } catch (e) { v = e && e.code === 'ENOENT' ? false : null; }
  limInstalled = { at: now, v };
  return v;
}

function limitsPayload(now = Date.now()) {
  const p = computeLimits([...LIM.snaps.values()].map((x) => x.snap), LIM.hist.points, now);
  p.installed = statuslineInstalled(now);
  p.probe = probePublic(now);
  return p;
}

// What counts as a change worth pushing: values, status, reset time, availability. Not the ticking clock.
function limitsKey(p) {
  return JSON.stringify([p.available, p.reason || null, !!p.stale, p.installed, p.updatedAt, p.sessions, p.activeSessions,
    Object.entries(p.windows).filter(([k]) => k !== 'scoped').map(([k, w]) => [k, w.usedPct, w.resetsAt, w.status, w.burnPerHour, w.updatedAt, w.isActive, w.severity]),
    (p.windows.scoped || []).map((w) => [w.key, w.usedPct, w.resetsAt, w.status, w.isActive]), p.extraUsage || null, p.source,
    p.probe ? [p.probe.enabled, p.probe.ok, p.probe.lastError, p.probe.running] : null, p.reset ? Object.keys(p.reset).sort() : null]);
}

function limitsBroadcast(fresh) {
  if (!LV.subs.size) return;
  limitsRefresh(fresh ? 0 : 900);
  const now = Date.now();
  const p = limitsPayload(now);
  const k = limitsKey(p);
  if (k === LIM.lastKey && now - LIM.lastSentAt < 60e3) return; // unchanged; a heartbeat every minute keeps clocks and projections fresh
  LIM.lastKey = k;
  LIM.lastSentAt = now;
  sseBroadcast(sseState('limits', p));
}

function limitsKick() { // a file in limits/ changed: wait a few ms for the rename to settle, then read once
  if (LIM.kick) return;
  LIM.kick = setTimeout(() => {
    LIM.kick = null;
    try { limitsBroadcast(true); } catch (e) { lastError = 'limits: ' + String(e && e.message || e); }
  }, 20);
  LIM.kick.unref();
}

function limitsEnsureWatch(now = Date.now()) {
  if (LIM.watcher || now - LIM.watchTry < 2000) return;
  LIM.watchTry = now;
  try { fs.mkdirSync(LIM_DIR, { recursive: true }); } catch { return; }
  try {
    const w = fs.watch(LIM_DIR, { persistent: false }, () => limitsKick());
    w.on('error', () => { if (LIM.watcher === w) { LIM.watcher = null; try { w.close(); } catch { /* ignore */ } } });
    LIM.watcher = w;
  } catch { /* the 1 s tick still picks changes up */ }
}

function limitsStop() {
  probeStop();
  if (LIM.watcher) { try { LIM.watcher.close(); } catch { /* ignore */ } LIM.watcher = null; }
  if (LIM.kick) { clearTimeout(LIM.kick); LIM.kick = null; }
}

// ---------------------------------------------------------------- plan limits: Claude Code's documented /usage report
// `claude -p --input-format stream-json` with the single prompt "/usage" is answered locally by Claude Code (no model call, no
// transcript, total_cost_usd 0) with an assistant message carrying `usage_report.rate_limits` (Agent SDK: SDKUsageReport).
// We run it on a schedule and store the result as the pseudo-session snapshot `usage-probe`, the same shape the status line writes.
// No credentials are read and no HTTP endpoint is called by CCUsageX; only the documented CLI command runs, with fixed arguments.

const PROBE_ARGS = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--no-session-persistence'];
const PROBE_INPUT = '{"type":"user","message":{"role":"user","content":"/usage"}}\n';
const PROBE_TIMEOUT_MS = 30e3;
const PROBE_FAST_MS = 2 * 60e3;       // while the dashboard is being looked at
const PROBE_SLOW_MS = 15 * 60e3;      // otherwise, and after repeated failures
const PROBE_RETRY_MS = 15e3;          // after a first or second failure in a row (a one-off CLI hiccup should not show for minutes)
const PROBE_VIEW_MS = 10 * 60e3;      // "being looked at" = an SSE subscriber or an /api request within this time
const PROBE_FIRST_MS = 3e3;
const PROBE_MIN_GAP_MS = 20e3;        // ?refresh=1 will not start a probe closer than this to the previous one
const PROBE_WAIT_CAP_MS = 15e3;       // ...and waits at most this long for it
const PROBE_OUT_MAX = 4 << 20;
const PROBE = {
  started: false, timer: null, startAt: 0, running: null, lastStartAt: 0, lastAt: 0, lastOkAt: 0, lastOk: false, lastError: null,
  fails: 0, viewAt: 0, noLimits: false, bin: null, binAt: 0, prev: null, prevLoaded: false, timeoutMs: PROBE_TIMEOUT_MS,
};
function probeEnabled() { return process.env.CCU_LIMITS_PROBE !== '0'; }

function probeIsFile(f) { try { return fs.statSync(f).isFile(); } catch { return false; } }

function probeVersionKey(name) { // anthropic.claude-code-2.1.296-win32-x64 -> [2,1,296]
  const m = /claude-code-(\d+(?:\.\d+)*)/.exec(name);
  return m ? m[1].split('.').map(Number) : [];
}
function probeCmpVer(a, b) { for (let i = 0; i < Math.max(a.length, b.length); i++) { const d = (a[i] || 0) - (b[i] || 0); if (d) return d; } return 0; }

// -> { cmd, args, shell } | null.  CCU_CLAUDE_BIN: a JSON array ["cmd", "arg", ...], a .js/.mjs/.cjs script (run with this node), or an executable path.
function probeResolveBin() {
  const env = process.env.CCU_CLAUDE_BIN;
  if (env && env.trim()) {
    const v = env.trim();
    if (v[0] === '[') {
      try {
        const a = JSON.parse(v);
        if (Array.isArray(a) && a.length && a.every((x) => typeof x === 'string')) return { cmd: a[0], args: [...a.slice(1), ...PROBE_ARGS], shell: false };
      } catch { /* fall through */ }
      return null;
    }
    if (/\.(m|c)?js$/i.test(v)) return { cmd: process.execPath, args: [v, ...PROBE_ARGS], shell: false };
    return { cmd: v, args: PROBE_ARGS, shell: /\.(cmd|bat)$/i.test(v) };
  }
  const win = process.platform === 'win32';
  const names = win ? ['claude.exe', 'claude.cmd'] : ['claude'];
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const n of names) {
      const f = path.join(dir.replace(/^"|"$/g, ''), n);
      if (probeIsFile(f)) return { cmd: f, args: PROBE_ARGS, shell: /\.(cmd|bat)$/i.test(f) };
    }
  }
  const home = os.homedir();
  const exe = win ? 'claude.exe' : 'claude';
  for (const root of ['.vscode', '.vscode-insiders', '.cursor', '.windsurf']) {
    const dir = path.join(home, root, 'extensions');
    let list = [];
    try { list = fs.readdirSync(dir).filter((n) => /^anthropic\.claude-code-\d/.test(n)); } catch { continue; }
    list.sort((a, b) => probeCmpVer(probeVersionKey(b), probeVersionKey(a)));
    for (const n of list) {
      const f = path.join(dir, n, 'resources', 'native-binary', exe);
      if (probeIsFile(f)) return { cmd: f, args: PROBE_ARGS, shell: false };
    }
  }
  return null;
}

// First line of Claude Code's stream-json output that carries a usage report (top level, or inside `message`).
function probeParseOutput(text) {
  for (const ln of String(text).split('\n')) {
    if (ln.indexOf('usage_report') < 0) continue;
    let j;
    try { j = JSON.parse(ln); } catch { continue; }
    const r = j && (j.usage_report || (j.message && j.message.usage_report));
    if (r && typeof r === 'object') return r;
  }
  return null;
}

const probeMinute = (iso) => { const t = Date.parse(iso); return Number.isFinite(t) ? Math.round(t / 60e3) * 60e3 : null; }; // resets_at jitters by sub-seconds between calls

function probeScopeLabel(sc) {
  if (!sc || typeof sc !== 'object') return null;
  const m = sc.model && (sc.model.display_name || sc.model.name);
  const sf = typeof sc.surface === 'string' ? sc.surface : sc.surface && (sc.surface.display_name || sc.surface.name);
  return (typeof m === 'string' && m) || (typeof sf === 'string' && sf) || null;
}

// usage_report -> snapshot (pure). rate_limits null -> `rate_limits: null` (API key / 3P / token without user:profile scope).
function probeSnapshot(report, now) {
  const snap = { receivedAt: now, sessionId: 'usage-probe', source: 'usage', rate_limits: null };
  const rl = report && report.rate_limits;
  if (!rl || typeof rl !== 'object') return snap;
  const lim = Array.isArray(rl.limits) ? rl.limits : [];
  const win = (l) => {
    const used = limFiniteNum(l.percent), at = probeMinute(l.resets_at);
    if (used == null || at == null) return null;
    return { used_percentage: used, resets_at: at, ...(typeof l.severity === 'string' ? { severity: l.severity } : {}), ...(typeof l.is_active === 'boolean' ? { is_active: l.is_active } : {}) };
  };
  snap.rate_limits = {};
  const scoped = [];
  const seen = new Set();
  for (const l of lim) {
    if (!l || typeof l !== 'object') continue;
    const w = win(l);
    if (!w) continue;
    if (l.kind === 'session' && !snap.rate_limits.five_hour) snap.rate_limits.five_hour = w;
    else if (l.kind === 'weekly_all' && !snap.rate_limits.seven_day) snap.rate_limits.seven_day = w;
    else if (l.kind === 'weekly_scoped') {
      let label = probeScopeLabel(l.scope) || 'Scoped';
      if (seen.has(label)) label += ' #' + (scoped.length + 1);
      seen.add(label);
      scoped.push({ label, used_percentage: w.used_percentage, resets_at: w.resets_at, severity: w.severity || null, is_active: w.is_active === true });
    }
  }
  if (scoped.length) snap.scoped = scoped;
  const x = rl.extra_usage;
  if (x && typeof x === 'object' && x.is_enabled === true) snap.extra_usage = { is_enabled: true, monthly_limit: limFiniteNum(x.monthly_limit), used_credits: limFiniteNum(x.used_credits), utilization: limFiniteNum(x.utilization), currency: typeof x.currency === 'string' ? x.currency : null };
  return snap;
}

function probePoints(snap) { // [{w, p, r}] with history keys '5h' | '7d' | '7d:<label>'; r in epoch seconds like the status line writes
  const out = [];
  const rl = snap && snap.rate_limits;
  if (rl) {
    if (rl.five_hour) out.push({ w: '5h', p: rl.five_hour.used_percentage, r: Math.round(rl.five_hour.resets_at / 1000) });
    if (rl.seven_day) out.push({ w: '7d', p: rl.seven_day.used_percentage, r: Math.round(rl.seven_day.resets_at / 1000) });
  }
  for (const s of (snap && snap.scoped) || []) out.push({ w: '7d:' + s.label, p: s.used_percentage, r: Math.round(s.resets_at / 1000) });
  return out;
}

function probeCapHistory(file, max) {
  try {
    if (fs.statSync(file).size <= max) return;
    const buf = fs.readFileSync(file);
    let cut = buf.indexOf(0x0a, Math.floor(buf.length / 2));
    cut = cut < 0 ? Math.floor(buf.length / 2) : cut + 1;
    const tmp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, buf.subarray(cut));
    fs.renameSync(tmp, file);
  } catch { /* the status line caps it too */ }
}

// Persist the snapshot (limits/usage-probe.json) and append history lines for windows whose value or reset time changed.
function probeStore(snap) {
  fs.mkdirSync(LIM_DIR, { recursive: true });
  const file = path.join(LIM_DIR, 'usage-probe.json');
  if (!PROBE.prevLoaded) { PROBE.prevLoaded = true; try { PROBE.prev = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { PROBE.prev = null; } }
  const prev = PROBE.prev;
  if (!snap.rate_limits && prev && prev.rate_limits) return false; // keep the last good report (it just ages)
  const cur = probePoints(snap), old = prev ? probePoints(prev) : null;
  const sig = (pts) => JSON.stringify((pts || []).map((x) => [x.w, x.p, x.r]));
  snap.changedAt = prev && prev.changedAt && sig(old) === sig(cur) ? prev.changedAt : snap.receivedAt;
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(snap));
  fs.renameSync(tmp, file);
  let lines = '';
  for (const c of cur) {
    const b = old && old.find((x) => x.w === c.w);
    if (b && b.p === c.p && b.r === c.r) continue;
    lines += JSON.stringify({ t: snap.receivedAt, w: c.w, p: c.p, r: c.r }) + '\n';
  }
  if (lines) {
    const hf = path.join(LIM_DIR, 'history.jsonl');
    fs.appendFileSync(hf, lines);
    probeCapHistory(hf, 5 * 1024 * 1024);
  }
  PROBE.prev = snap;
  return true;
}

// Runs the probe once. Resolves { ok, report } | { ok:false, error } and never rejects.
function probeExec() {
  return new Promise((resolve) => {
    let done = false;
    const finish = (r) => { if (!done) { done = true; resolve(r); } };
    const nowMs = Date.now();
    if (!PROBE.bin || nowMs - PROBE.binAt > 5 * 60e3) { PROBE.bin = probeResolveBin(); PROBE.binAt = nowMs; }
    const bin = PROBE.bin;
    if (!bin) return finish({ ok: false, error: 'claude not found' });
    let child;
    try {
      // a .cmd shim needs a shell; the arguments are fixed constants, so one quoted command line is safe (and avoids Node's DEP0190)
      child = bin.shell
        ? require('child_process').spawn('"' + bin.cmd + '" ' + bin.args.join(' '), { cwd: os.tmpdir(), shell: true, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
        : require('child_process').spawn(bin.cmd, bin.args, { cwd: os.tmpdir(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch { return finish({ ok: false, error: 'cannot start claude' }); }
    let out = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { if (process.platform === 'win32' && child.pid) require('child_process').spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => {}); } catch { /* ignore */ }
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      setTimeout(() => finish({ ok: false, error: 'timeout' }), 500).unref();
    }, PROBE.timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => { if (out.length < PROBE_OUT_MAX) out += d; });
    child.stdout.on('error', () => {});
    let err = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
    child.stderr.on('error', () => {});
    child.stdin.on('error', () => {});
    child.on('error', (e) => { clearTimeout(timer); finish({ ok: false, error: e && e.code === 'ENOENT' ? 'claude not found' : 'cannot start claude' }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) return finish({ ok: false, error: 'timeout' });
      const rep = probeParseOutput(out);
      if (!rep) {
        const why = err.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop() || '';
        return finish({ ok: false, error: code ? 'claude exited with code ' + code : 'no usage report in the output', detail: why.slice(0, 300) });
      }
      finish({ ok: true, report: rep });
    });
    try { child.stdin.end(PROBE_INPUT); } catch { /* the error handler reports */ }
  });
}

// One probe cycle: run, store, update the status. Never overlaps (returns the running promise), never throws.
function probeRun() {
  if (PROBE.running) return PROBE.running;
  PROBE.lastStartAt = Date.now();
  const p = (async () => {
    let r;
    try { r = await probeExec(); } catch { r = { ok: false, error: 'probe failed' }; }
    const now = Date.now();
    PROBE.lastAt = now;
    if (r.ok) {
      try {
        const snap = probeSnapshot(r.report, now);
        PROBE.noLimits = !snap.rate_limits;
        probeStore(snap);
        PROBE.lastOk = true; PROBE.lastOkAt = now; PROBE.lastError = null; PROBE.fails = 0;
      } catch { PROBE.lastOk = false; PROBE.lastError = 'could not save the report'; PROBE.fails++; }
    } else {
      PROBE.lastOk = false; PROBE.lastError = r.error || 'probe failed'; PROBE.fails++;
      // stderr detail goes to the local server log only; the public error stays short and path-free
      console.error(new Date(now).toISOString() + ' limits probe failed (' + PROBE.fails + ' in a row): ' + PROBE.lastError + (r.detail ? ' | ' + r.detail : ''));
    }
    PROBE.running = null;
    try { limitsRefresh(0); limitsBroadcast(true); } catch (e) { lastError = 'limits: ' + String(e && e.message || e); }
  })();
  PROBE.running = p;
  return p;
}

function probeInterval(now = Date.now()) {
  if (PROBE.fails >= 3) return PROBE_SLOW_MS;
  if (PROBE.fails > 0) return PROBE_RETRY_MS;
  return LV.subs.size || now - PROBE.viewAt < PROBE_VIEW_MS ? PROBE_FAST_MS : PROBE_SLOW_MS;
}
function probeNextAt(now = Date.now()) {
  if (!probeEnabled() || !PROBE.started) return null;
  return PROBE.lastStartAt ? PROBE.lastStartAt + probeInterval(now) : PROBE.startAt;
}
function probeTick() {
  const now = Date.now();
  if (!probeEnabled() || PROBE.running) return;
  if (now >= probeNextAt(now)) probeRun();
}
function probeTouch() { PROBE.viewAt = Date.now(); } // an /api request: somebody is looking

function probeStart() {
  if (PROBE.started || !probeEnabled()) return;
  PROBE.started = true;
  PROBE.startAt = Date.now() + PROBE_FIRST_MS;
  PROBE.timer = setInterval(probeTick, 1000);
  PROBE.timer.unref();
}
function probeStop() {
  if (PROBE.timer) { clearInterval(PROBE.timer); PROBE.timer = null; }
  PROBE.started = false;
}

// ?refresh=1: start a probe unless one began less than 20 s ago, wait for the running one (at most 15 s).
function probeRefresh() {
  if (!probeEnabled()) return Promise.resolve();
  if (!PROBE.running && Date.now() - PROBE.lastStartAt >= PROBE_MIN_GAP_MS) probeRun();
  if (!PROBE.running) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(resolve, PROBE_WAIT_CAP_MS);
    t.unref();
    PROBE.running.then(() => { clearTimeout(t); resolve(); });
  });
}

function probePublic(now = Date.now()) {
  const enabled = probeEnabled();
  return {
    enabled, ok: enabled && PROBE.lastOk, lastAt: PROBE.lastAt || null, lastOkAt: PROBE.lastOkAt || null, lastError: enabled ? PROBE.lastError : null,
    nextAt: enabled ? probeNextAt(now) : null, intervalMs: probeInterval(now), running: !!PROBE.running,
    ...(PROBE.noLimits && PROBE.lastOk ? { noLimits: true } : {}),
  };
}

// ---------------------------------------------------------------- widget: measured heavy hours
// "Your heavy hours": when does the weekly limit (7d %) drain fastest per dollar of API-equivalent work? Pure, from your own
// limits history ({t ms, w, p %, r reset epoch s}) and request list. Different `r` = different account/window.
// MIN_CHUNK_COST: a stretch needs about 1.5 weekly points of work, or whole-point rounding is most of its rate.
// MIN_WINDOW_COST: an hour (with its two neighbours) needs this much work before it can be called heavy.
const BH = { MAX_GAP_MS: 3 * 3600e3, GUARD_MS: 15 * 60e3, MIN_WINDOW_COST: 50, CHUNK_MS: 3 * 3600e3, MIN_CHUNK_COST: 20, OUTLIER_X: 3 };
const bhDtf = new Map();
function bhZone() { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } }
function bhParts(ms, tz) {
  let f = bhDtf.get(tz);
  if (!f) { f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }); bhDtf.set(tz, f); }
  const o = {};
  for (const x of f.formatToParts(new Date(ms))) o[x.type] = x.value;
  return { h: Number(o.hour) % 24, day: o.year + '-' + o.month + '-' + o.day };
}
function bhHHMM(m) { m = ((m % 1440) + 1440) % 1440; return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); }
// "H:MM" or "HH:MM" with hours < 24 and minutes < 60 -> "HH:MM"; anything else -> null
function bhManualTime(s) {
  const x = typeof s === 'string' ? /^(\d{1,2}):(\d{2})$/.exec(s) : null;
  return x && Number(x[1]) < 24 && Number(x[2]) < 60 ? x[1].padStart(2, '0') + ':' + x[2] : null;
}

// The 1.4.2 measurement, shared by heavy hours and plan value. hist: [{t,w,p,r}]; reqs ascending by ts.
// Returns every chunk {a (the account's 7d reset), t1, t2, dp, cost}, the (t, account) events and a ts search.
function bhChunks(hist, reqs) {
  const pts = (hist || []).filter((x) => x && typeof x.t === 'number' && typeof x.p === 'number').slice().sort((a, b) => a.t - b.t);
  // account of every row: 7d rows carry their own reset; other rows borrow it from a 7d row with the same t
  const acctAt = new Map();
  for (const x of pts) if (x.w === '7d' && x.r != null) acctAt.set(x.t, x.r);
  const events = [];
  for (const x of pts) { const a = x.w === '7d' ? x.r : acctAt.get(x.t); if (a != null) events.push({ t: x.t, a }); }
  const by = new Map();
  for (const x of pts) if (x.w === '7d' && x.r != null) { if (!by.has(x.r)) by.set(x.r, []); by.get(x.r).push(x); }
  const firstAt = (t) => { let a = 0, b = reqs.length; while (a < b) { const m = (a + b) >> 1; if (reqs[m].ts < t) a = m + 1; else b = m; } return a; };
  // null when a request in [t1, t2) has no price (unknown model): that stretch is skipped, never counted as $0
  const costBetween = (t1, t2) => {
    let c = 0;
    for (let i = firstAt(t1); i < reqs.length && reqs[i].ts < t2; i++) {
      if (!reqs[i].cost) return null;
      c += reqs[i].cost.total || 0;
    }
    return c;
  };
  const otherNear = (acct, t1, t2) => {
    const from = t1 - BH.GUARD_MS, to = t2 + BH.GUARD_MS;
    let a = 0, b = events.length;
    while (a < b) { const m = (a + b) >> 1; if (events[m].t < from) a = m + 1; else b = m; }
    for (let i = a; i < events.length && events[i].t <= to; i++) if (events[i].a !== acct) return true;
    return false;
  };
  // Sessions, not single intervals: the weekly % moves in whole points, so one interval's rate is mostly rounding.
  // Per account, consecutive snapshots (running max: the % only rises within a week, but snapshots flicker 82, 81, 82)
  // form a stretch while they are at most MAX_GAP apart with no other account's snapshot near them, cut into chunks of
  // up to CHUNK_MS. A chunk's NET rise over its whole cost is its rate.
  const chunks = [];
  for (const [acct, raw] of by) {
    let hi = -Infinity;
    const rows = raw.map((x) => { hi = Math.max(hi, x.p); return { t: x.t, p: hi }; });
    let s0 = 0;
    const close = (i) => {
      const a = rows[s0], b = rows[i];
      if (i > s0 && b.t > a.t) {
        const cost = costBetween(a.t, b.t);
        if (cost !== null && cost >= BH.MIN_CHUNK_COST) chunks.push({ a: acct, t1: a.t, t2: b.t, dp: b.p - a.p, cost });
      }
      s0 = i;
    };
    for (let i = 1; i < rows.length; i++) {
      const a = rows[i - 1], b = rows[i];
      if (b.t - a.t > BH.MAX_GAP_MS || b.t <= a.t || otherNear(acct, a.t, b.t)) { close(i - 1); s0 = i; continue; }
      if (b.t - rows[s0].t > BH.CHUNK_MS) close(i - 1);
    }
    close(rows.length - 1);
  }
  return { chunks, events, firstAt };
}
// A chunk whose weekly % rose far faster than usual for the work on this machine was mostly used elsewhere
// (claude.ai, another device); one far slower mostly paid for work on another account at the same time. Both are
// dropped (more than OUTLIER_X times off the median).
function bhKeep(chunks) {
  const rates = chunks.map((c) => c.dp / c.cost).sort((x, y) => x - y);
  const median = rates.length ? rates[Math.floor(rates.length / 2)] : 0;
  return chunks.filter((c) => !(median > 0 && (c.dp / c.cost > BH.OUTLIER_X * median || c.dp / c.cost < median / BH.OUTLIER_X)));
}

// hist: [{t,w,p,r}]; reqs: ascending by ts with .cost.total; cfg: CONFIG.widget.heavyHours-like
function computeBurnHours(hist, reqs, cfg = {}, tz = bhZone()) {
  const mode = cfg.mode === 'manual' || cfg.mode === 'off' ? cfg.mode : 'auto';
  const minDays = Math.max(1, Number(cfg.minDays) || 3);
  const threshold = Number(cfg.threshold) > 1 ? Number(cfg.threshold) : 1.15;
  const base = { ok: true, mode, timeZone: tz, days: 0, minDays, baselinePctPer100: null, hours: [], ranges: [], reason: '' };
  if (mode === 'off') return { ...base, reason: 'off' };
  if (mode === 'manual') {
    const m = cfg.manual || {};
    const start = bhManualTime(m.start), end = bhManualTime(m.end);
    if (!start || !end) return { ...base, ok: false, reason: 'invalid manual range' };
    return { ...base, ranges: [{ start, end, ratio: null }], reason: 'manual' };
  }
  const { chunks, firstAt } = bhChunks(hist, reqs);
  const days = new Set();
  const agg = Array.from({ length: 24 }, () => ({ dp: 0, cost: 0, n: 0 }));
  let totDp = 0, totCost = 0;
  // local hour/day of a request, cached per 15 minutes (every time zone offset is a multiple of 15 minutes)
  const qCache = new Map();
  const partsAt = (ms) => { const q = Math.floor(ms / 9e5); let v = qCache.get(q); if (!v) qCache.set(q, v = bhParts(q * 9e5, tz)); return v; };
  for (const c of bhKeep(chunks)) {
    // spread the chunk over the local hours its work fell in, by cost
    const per = new Map();
    for (let i = firstAt(c.t1); i < reqs.length && reqs[i].ts < c.t2; i++) {
      const pt = partsAt(reqs[i].ts), w = (reqs[i].cost && reqs[i].cost.total) || 0;
      per.set(pt.h, (per.get(pt.h) || 0) + w);
      if (w > 0) days.add(pt.day);
    }
    for (const [h, w] of per) { if (!(w > 0)) continue; const g = agg[h]; g.dp += c.dp * w / c.cost; g.cost += w; g.n++; }
    totDp += c.dp; totCost += c.cost;
  }
  base.days = days.size;
  if (days.size < minDays || !(totCost > 0) || !(totDp > 0)) return { ...base, ok: false, reason: 'need more data' };
  const baseline = totDp / totCost;
  base.baselinePctPer100 = Math.round(baseline * 1e4) / 100;
  const sm = agg.map((_, h) => {
    let dp = 0, cost = 0;
    for (const d of [-1, 0, 1]) { const g = agg[(h + d + 24) % 24]; dp += g.dp; cost += g.cost; }
    return { dp, cost, rate: cost > 0 ? dp / cost : null };
  });
  base.hours = agg.map((g, h) => ({ h, pctPer100: sm[h].rate == null ? null : Math.round(sm[h].rate * 1e4) / 100, cost: Math.round(g.cost * 100) / 100, n: g.n }));
  // an hour needs data of its own, so smoothing never stretches a range into hours you did not use
  const heavy = sm.map((x, h) => agg[h].cost > 0 && x.cost >= BH.MIN_WINDOW_COST && x.rate != null && x.rate >= threshold * baseline);
  if (heavy.every(Boolean)) return { ...base, reason: 'no clear heavy window' };
  // contiguous runs on the 24 h circle (start scanning at a non-heavy hour so runs never straddle the scan edge)
  const start0 = heavy.findIndex((v) => !v);
  for (let k = 0; k < 24;) {
    const h = (start0 + k) % 24;
    if (!heavy[h]) { k++; continue; }
    let len = 0, w = 0, ws = 0;
    while (k + len < 24 && heavy[(start0 + k + len) % 24]) { const x = sm[(start0 + k + len) % 24]; w += x.cost; ws += x.cost * (x.rate / baseline); len++; }
    base.ranges.push({ start: bhHHMM(h * 60), end: bhHHMM((h + len) * 60), ratio: Math.round((ws / w) * 100) / 100 });
    k += len;
  }
  base.ranges.sort((a, b) => a.start.localeCompare(b.start));
  base.reason = base.ranges.length ? 'measured' : 'no clear heavy window';
  return base;
}

// config.json > widget is re-read when the file's mtime changes, so edits apply without a restart. CONFIG keeps the
// startup copy for everything else. widgetVersion moves on every reload and is part of the burn-hours memo key.
const WIDGET_FILE = process.env.CCU_WIDGET_CONFIG || path.join(ROOT, 'config.json'); // tests point this at a temp copy
let widgetCache = { mtime: null, block: CONFIG.widget || {} };
let widgetVersion = 0;
function widgetConfig() {
  let mtime;
  try { mtime = fs.statSync(WIDGET_FILE).mtimeMs; } catch { return widgetCache.block; }
  if (mtime === widgetCache.mtime) return widgetCache.block;
  let block = widgetCache.block;
  try { block = JSON.parse(fs.readFileSync(WIDGET_FILE, 'utf8')).widget || {}; } catch { /* half-saved or invalid: keep the last good block */ }
  widgetCache = { mtime, block };
  widgetVersion++;
  return block;
}

const US_PEAK_TZ = 'America/Los_Angeles';
function validTimeZone(tz) { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; } }

function burnHoursPayload() {
  limitsRefresh(2000);
  const w = widgetConfig();
  const out = computeBurnHours(LIM.hist.points, sortedList(), w.heavyHours || {});
  out.usPeak = w.usPeak || null;
  if (out.usPeak && out.usPeak.timeZone != null && !validTimeZone(out.usPeak.timeZone)) {
    out.warning = `usPeak.timeZone "${out.usPeak.timeZone}" is not a valid time zone; showing ${US_PEAK_TZ} instead`;
    out.usPeak = { ...out.usPeak, timeZone: US_PEAK_TZ };
  }
  return out;
}

// ---------------------------------------------------------------- plan value (what the plan gives vs what we spend)

// Every saved account is measured on its own: each $ interval belongs to the account whose weekly row is nearest in
// time (the status line writes the ACTIVE account's row), never to the account active now. An account is its 7d
// reset modulo one week, so the same account links across weeks.
const PV = { WEEK_MS: 7 * 864e5, MATCH_MS: 120e3, NEAR_MS: 6 * 3600e3, MIN_CHUNKS: 3, MIN_DP: 10, OWN_CHUNKS: 3, THIN_REL: 0.1, SAVE_EVERY_MS: 10 * 60e3 };
const pvDtf = new Map();
function pvOffset(ms, tz) {
  let f = pvDtf.get(tz);
  if (!f) { f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }); pvDtf.set(tz, f); }
  const o = {};
  for (const x of f.formatToParts(new Date(ms))) o[x.type] = Number(x.value);
  return Date.UTC(o.year, o.month - 1, o.day, o.hour % 24, o.minute, o.second) - Math.floor(ms / 1000) * 1000;
}
// local midnight of the day that holds ms
function pvDayStart(ms, tz) {
  const l = new Date(ms + pvOffset(ms, tz));
  const mid = Date.UTC(l.getUTCFullYear(), l.getUTCMonth(), l.getUTCDate());
  const t = mid - pvOffset(ms, tz);
  return mid - pvOffset(t, tz); // DST: the offset at midnight can differ from the offset now
}
function pvSlot(resetMs) { return ((Math.round(resetMs / 1000) * 1000) % PV.WEEK_MS + PV.WEEK_MS) % PV.WEEK_MS; }
function pvSameSlot(a, b) { const d = Math.abs(a - b) % PV.WEEK_MS; return Math.min(d, PV.WEEK_MS - d) <= PV.MATCH_MS; }
const r2 = (v) => Math.round(v * 100) / 100;

// Pooled $ per 1% weekly over kept chunks, with a ~95% range from the chunks' own scatter (ratio estimator).
function pvRate(chunks) {
  let dp = 0, cost = 0;
  for (const c of chunks) { dp += c.dp; cost += c.cost; }
  if (!(dp > 0) || !(cost > 0)) return null;
  const rate = dp / cost, n = chunks.length;
  let e2 = 0;
  for (const c of chunks) e2 += (c.dp - rate * c.cost) ** 2;
  const se = n > 1 ? Math.sqrt(e2 * n / (n - 1)) / cost : rate;
  const hiRate = rate + 2 * se, loRate = Math.max(rate - 2 * se, rate / 4);
  return { perPct: 1 / rate, lo: 1 / hiRate, hi: 1 / loRate, chunks: n, dp, cost, rel: 2 * se / rate };
}

// Drain the accounts at perHour $/h: active first, then the one that resets soonest; every reset refills its account.
// cap is where the switcher moves on (its weekLimit). Returns { until, dryUntil, outlasts, fills } where fills[i] is
// when accts[i] first reaches the cap (null if it does not inside the horizon).
function pvRunway(accts, perHour, now, cap, horizonMs = PV.WEEK_MS) {
  if (!(perHour > 0) || !accts.length) return null;
  const fills = accts.map(() => null);
  const A = [];
  accts.forEach((a, i) => { if (a.perPct > 0) A.push({ i, used: a.pct, r: a.resetsAt, k: a.perPct, active: a.active }); });
  if (!A.length) return null;
  const pick = () => A.filter((a) => a.used < cap - 1e-9).sort((x, y) => x.r - y.r)[0] || null;
  let cur = A.find((a) => a.active && a.used < cap - 1e-9) || pick();
  const end = now + horizonMs;
  let t = now;
  for (let guard = 0; guard < 200 && t < end; guard++) {
    const nextReset = Math.min(...A.map((a) => a.r));
    if (!cur) return { until: t, dryUntil: nextReset, outlasts: false, fills };
    const emptyAt = t + (cap - cur.used) * cur.k / perHour * 3600e3;
    if (emptyAt <= nextReset && emptyAt < end) { cur.used = cap; t = emptyAt; if (fills[cur.i] == null) fills[cur.i] = Math.round(t); cur = pick(); continue; }
    const t2 = Math.min(nextReset, end);
    cur.used += (t2 - t) / 3600e3 * perHour / cur.k;
    t = t2;
    for (const a of A) while (a.r <= t) { a.used = 0; a.r += PV.WEEK_MS; }
    if (!cur) cur = pick();
  }
  return { until: null, dryUntil: null, outlasts: true, fills };
}

// The highest steady $/day the accounts carry for a whole week without running dry (accounts refill at their resets).
function pvSafeDay(accts, now, cap) {
  const ok = (perDay) => { const r = pvRunway(accts, perDay / 24, now, cap); return !r || r.outlasts; };
  let lo = 0, hi = 1000;
  while (hi < 1e7 && ok(hi)) { lo = hi; hi *= 2; }
  if (hi >= 1e7) return null;
  for (let i = 0; i < 30 && hi - lo > 0.5; i++) { const m = (lo + hi) / 2; if (ok(m)) lo = m; else hi = m; }
  return Math.floor(lo);
}

// What the logs say about effort and models, measured on the last 7 days: cost per prompt (helpers included) by the
// prompt's effort, helper tokens re-priced on Sonnet 5.5, the fast-mode surcharge, and (only when the week is tight)
// the routine prompts re-priced on Sonnet 5.5. Each tip carries its own sentence so the widget and dashboard agree.
const PV_HELPER_MODEL = 'claude-sonnet-5-5';
const PV_EFFORT_STEP = [['max', 'xhigh'], ['xhigh', 'high']];
const pvUsd = (v) => '$' + (v >= 10 || Number.isInteger(v) ? Math.round(v).toLocaleString('en-US') : v.toFixed(2));
function pvTips(reqs, from, to, days, verdict) {
  if (!(days > 0)) return { effort: [], tips: [] };
  const prompts = new Map(); // promptId -> { effort, cost, opus, alt }
  let helperOpus = 0, helperAlt = 0, fastExtra = 0, total = 0;
  for (const q of reqs) {
    if (q.ts < from || q.ts >= to || !q.cost) continue;
    const c = q.cost.total || 0;
    total += c;
    const heavyModel = /opus|fable|mythos/.test(q.model || '') && typeof q.input === 'number';
    const alt = heavyModel ? computeCost({ ...q, model: PV_HELPER_MODEL, speed: null }) : null;
    if (q.promptId) {
      let p = prompts.get(q.promptId);
      if (!p) prompts.set(q.promptId, p = { effort: null, cost: 0, opus: 0, alt: 0 });
      p.cost += c;
      if (!q.sidechain && !p.effort && q.effort) p.effort = q.effort;
      if (!q.sidechain && alt) { p.opus += c; p.alt += alt.total; }
    }
    if (q.speed === 'fast') {
      const pr = priceFor(q.model), m = pr && pr.fastMultiplier > 1 ? pr.fastMultiplier : 0;
      if (m) fastExtra += c - c / m;
    }
    if (q.sidechain && alt) { helperOpus += c; helperAlt += alt.total; }
  }
  if (!(total > 0)) return { effort: [], tips: [] };
  const eff = new Map();
  let routineOpus = 0, routineAlt = 0;
  for (const p of prompts.values()) {
    if (!p.effort) continue;
    const e = eff.get(p.effort) || { cost: 0, n: 0 }; e.cost += p.cost; e.n++; eff.set(p.effort, e);
    if (p.effort === 'medium' || p.effort === 'low') { routineOpus += p.opus; routineAlt += p.alt; }
  }
  const order = ['low', 'medium', 'high', 'xhigh', 'max'];
  const effort = [...eff.entries()].filter(([, e]) => e.n >= 5)
    .map(([k, e]) => ({ effort: k, prompts: e.n, perPrompt: r2(e.cost / e.n), share: r2(e.cost / total) }))
    .sort((a, b) => order.indexOf(a.effort) - order.indexOf(b.effort));
  const save = [], info = [];
  for (const [hiE, loE] of PV_EFFORT_STEP) {
    const a = eff.get(hiE), b = eff.get(loE);
    if (!a || !b || a.n < 20 || b.n < 20) continue;
    const ca = a.cost / a.n, cb = b.cost / b.n;
    if (ca > cb * 1.15) {
      // move half of the higher-effort prompts (the routine ones) down a step
      const d = Math.round(a.cost * (1 - cb / ca) / 2 / days);
      if (d >= 1) save.push({ kind: 'effort', savePerDay: d, text: hiE + ' prompts cost ' + pvUsd(ca) + ' vs ' + pvUsd(cb) + ' on ' + loE + ': ' + loE + ' for routine work saves ≈ ' + pvUsd(d) + '/day' });
    } else if (!info.length) {
      info.push({ kind: 'effort', savePerDay: 0, text: hiE + ' costs about the same per prompt as ' + loE + ' (' + pvUsd(ca) + ' vs ' + pvUsd(cb) + '): use it whenever the task needs it' });
    }
  }
  if (helperOpus - helperAlt >= days) {
    const d = Math.round((helperOpus - helperAlt) / days);
    save.push({ kind: 'helpers', savePerDay: d, text: 'Helpers ran on Opus for ' + pvUsd(helperOpus / days) + '/day: on Sonnet 5.5 the same work saves ≈ ' + pvUsd(d) + '/day' });
  }
  if (fastExtra >= days) {
    const d = Math.round(fastExtra / days);
    save.push({ kind: 'fast', savePerDay: d, text: 'Fast mode added ' + pvUsd(d) + '/day: turn it off when speed does not matter' });
  }
  if (verdict && verdict !== 'enough' && routineOpus - routineAlt >= days) {
    const d = Math.round((routineOpus - routineAlt) / days);
    save.push({ kind: 'model', savePerDay: d, text: 'Medium-effort chores on Sonnet 5.5 instead of Opus save ≈ ' + pvUsd(d) + '/day' });
  }
  save.sort((a, b) => b.savePerDay - a.savePerDay);
  return { effort, tips: save.concat(info) };
}

// hist: limits history; reqs ascending with .cost; sw: { profiles: [{id, label, pct, resetsAt(ms), fetchedAt(ms)}],
// activeId, activeAt, weekLimit } or null; last: { perPct, lo, hi, chunks, at } from the last good measurement or null.
function computePlanValue(hist, reqs, sw, now = Date.now(), tz = bhZone(), last = null) {
  hist = hist || []; reqs = reqs || [];
  const { chunks, events } = bhChunks(hist, reqs);
  const kept = bhKeep(chunks).filter((c) => c.t2 > now - PV.WEEK_MS);
  const pooled = pvRate(kept);
  const measured = !!(pooled && pooled.chunks >= PV.MIN_CHUNKS && pooled.dp >= PV.MIN_DP);
  let plan = null;
  if (measured) plan = { perPct: pooled.perPct, lo: pooled.lo, hi: pooled.hi, chunks: pooled.chunks, at: now, stale: false, thin: pooled.chunks < 6 || pooled.rel > PV.THIN_REL };
  else if (last && last.perPct > 0) plan = { perPct: last.perPct, lo: last.lo || last.perPct, hi: last.hi || last.perPct, chunks: last.chunks || 0, at: last.at || null, stale: true, thin: false };
  const out = { ok: !!plan, timeZone: tz, now, plan: null, today: null, yesterday: null, pace: null, accounts: null, runway: null, forecast: null, effort: [], tips: [], reason: plan ? (measured ? 'measured' : 'last measured') : 'need more data' };
  if (plan) {
    out.plan = {
      perPct: r2(plan.perPct), perWeek: Math.round(plan.perPct * 100), perDay: Math.round(plan.perPct * 100 / 7),
      range: plan.thin ? { lo: Math.round(plan.lo * 100), hi: Math.round(plan.hi * 100) } : null,
      chunks: plan.chunks, thin: plan.thin, stale: plan.stale, measuredAt: plan.at,
    };
  }
  // accounts: the switcher's profiles plus the ones seen in history
  const slots = [];
  const slotOf = (rMs) => { const k = pvSlot(rMs); let s = slots.find((x) => pvSameSlot(x.slot, k)); if (!s) slots.push(s = { slot: k, id: null, label: null, sw: null }); return s; };
  if (sw && Array.isArray(sw.profiles)) for (const p of sw.profiles) if (p.resetsAt > 0) Object.assign(slotOf(p.resetsAt), { id: p.id, label: p.label || null, sw: p });
  const evSlot = events.map((e) => slotOf(e.a * 1000));
  const latest = new Map(); // latest weekly row per account from the status line's history
  for (const x of hist) if (x && x.w === '7d' && x.r != null && typeof x.p === 'number') {
    const s = slotOf(x.r * 1000), l = latest.get(s);
    if (!l || x.t > l.t) latest.set(s, x);
  }
  // the account of a request: nearest (t, account) event, if one is close enough
  const accountAt = (t) => {
    let a = 0, b = events.length;
    while (a < b) { const m = (a + b) >> 1; if (events[m].t < t) a = m + 1; else b = m; }
    let best = -1, bd = Infinity;
    for (const i of [a - 1, a]) if (i >= 0 && i < events.length && Math.abs(events[i].t - t) < bd) { bd = Math.abs(events[i].t - t); best = i; }
    return best >= 0 && bd <= PV.NEAR_MS ? evSlot[best] : null;
  };
  const firstAt = (t) => { let a = 0, b = reqs.length; while (a < b) { const m = (a + b) >> 1; if (reqs[m].ts < t) a = m + 1; else b = m; } return a; };
  const sumSpan = (t1, t2) => {
    const d = { from: t1, to: t2, cost: 0, unpriced: 0, split: new Map(), unknown: 0 };
    for (let i = firstAt(t1); i < reqs.length && reqs[i].ts < t2; i++) {
      const q = reqs[i];
      if (!q.cost) { d.unpriced++; continue; }
      const c = q.cost.total || 0;
      d.cost += c;
      const s = accountAt(q.ts);
      if (s) d.split.set(s, (d.split.get(s) || 0) + c); else d.unknown += c;
    }
    return d;
  };
  const dayStart = pvDayStart(now, tz), yStart = pvDayStart(dayStart - 1, tz);
  const today = sumSpan(dayStart, now + 1), yday = sumSpan(yStart, dayStart), last24 = sumSpan(now - 864e5, now + 1);
  // per-account rate: its own kept chunks when it has enough, else the pooled rate
  const own = new Map();
  for (const c of kept) { const s = slotOf(c.a * 1000); if (!own.has(s)) own.set(s, []); own.get(s).push(c); }
  const perPctOf = (s) => {
    const o = own.get(s);
    const r = o && o.length >= PV.OWN_CHUNKS ? pvRate(o) : null;
    return r && r.dp >= PV.MIN_DP ? { v: r.perPct, own: true } : (plan ? { v: plan.perPct, own: false } : null);
  };
  // active: the account of the newest status-line row, unless the switcher moved on after it
  const lastEv = events.length ? events.length - 1 : -1;
  let activeSlot = lastEv >= 0 ? evSlot[lastEv] : null;
  if (sw && sw.activeId && (lastEv < 0 || (sw.activeAt || 0) > events[lastEv].t)) activeSlot = slots.find((s) => s.id === sw.activeId) || activeSlot;
  const acc = [];
  for (const s of slots) {
    const h = latest.get(s), p = s.sw;
    let pct = null, resetsAt = null, at = 0, src = null;
    if (p) { pct = p.pct; resetsAt = p.resetsAt; at = p.fetchedAt || 0; src = 'switcher'; }
    if (h && h.t >= at) { pct = h.p; resetsAt = h.r * 1000; at = h.t; src = 'statusline'; }
    if (pct == null || !(resetsAt > 0)) continue;
    if (!p && resetsAt <= now - PV.WEEK_MS) continue; // an old week seen only in history
    if (resetsAt <= now) { pct = 0; while (resetsAt <= now) resetsAt += PV.WEEK_MS; }
    const k = perPctOf(s);
    acc.push({ key: s, id: s.id, label: s.label, active: s === activeSlot, pct: Math.round(pct * 10) / 10, resetsAt: Math.round(resetsAt), updatedAt: at ? Math.round(at) : null, source: src,
      perPct: k ? r2(k.v) : null, ownRate: !!(k && k.own), spare: k ? Math.round(Math.max(0, 100 - pct) * k.v) : null });
  }
  acc.sort((a, b) => (b.active - a.active) || (a.resetsAt - b.resetsAt));
  acc.forEach((a, i) => { if (!a.label) a.label = 'Account ' + (i + 1); });
  const labelOf = (s) => { const a = acc.find((x) => x.key === s); return a ? a.label : 'Earlier account'; };
  const day = (d) => {
    const split = [];
    for (const [s, c] of d.split) split.push({ id: s.id, label: labelOf(s), cost: r2(c) });
    if (d.unknown > 0.005) split.push({ id: null, label: 'Unattributed', cost: r2(d.unknown) });
    split.sort((a, b) => b.cost - a.cost);
    return { from: d.from, to: Math.min(d.to, now), cost: r2(d.cost), unpriced: d.unpriced, planDays: plan ? Math.round(d.cost / (plan.perPct * 100 / 7) * 100) / 100 : null, split };
  };
  out.today = day(today);
  out.yesterday = day(yday);
  // your usual day: the last 7 full local days (fewer when the logs are younger); the busiest of them is the heavy day
  const firstReq = reqs.length ? reqs[0].ts : now;
  const dayCosts = [];
  let oldest = dayStart;
  for (let e = dayStart, i = 0; i < 7; i++) {
    const s = pvDayStart(e - 1, tz);
    if (e <= firstReq) break;
    dayCosts.push(sumSpan(s, e).cost);
    e = oldest = s;
  }
  const usualDay = dayCosts.length ? dayCosts.reduce((x, v) => x + v, 0) / dayCosts.length : 0;
  const heavyDay = dayCosts.length ? Math.max(...dayCosts, today.cost) : today.cost;
  out.pace = { perHour: r2(last24.cost / 24), last24h: r2(last24.cost), usualDay: Math.round(usualDay), heavyDay: Math.round(heavyDay), days: dayCosts.length };
  const accounts = acc.map(({ key, ...a }) => a);
  const cap = sw && sw.weekLimit > 0 && sw.weekLimit <= 100 ? sw.weekLimit : 100;
  if (sw) out.accounts = { list: accounts, count: accounts.length, spare: Math.round(accounts.reduce((x, a) => x + (a.spare || 0), 0)), weekLimit: cap };
  // without the switcher only the active account counts: nothing moves you to another one
  const pool = sw ? accounts : accounts.filter((a) => a.active);
  const rwPerHour = usualDay > 0 ? usualDay / 24 : out.pace.perHour;
  const rw = pool.length ? pvRunway(pool, rwPerHour, now, cap) : null;
  if (rw) {
    const { fills, ...r } = rw;
    out.runway = { ...r, accounts: pool.length, cap, perHour: r2(rwPerHour) };
    pool.forEach((a, i) => { a.fullAt = fills[i]; });
  }
  // the forecast: will the accounts carry your usual week, and a heavy one?
  if (pool.length && plan && usualDay > 0) {
    const heavy = pvRunway(pool, heavyDay / 24, now, cap);
    const safeDay = pvSafeDay(pool, now, cap);
    const usualOk = !rw || rw.outlasts, heavyOk = !heavy || heavy.outlasts;
    out.forecast = {
      verdict: usualOk ? (heavyOk ? 'enough' : 'tight') : 'short',
      usualDay: Math.round(usualDay), heavyDay: Math.round(heavyDay), safeDay,
      headroom: safeDay != null ? r2(safeDay / usualDay) : null,
      dryAt: usualOk ? null : rw.until, backAt: usualOk ? null : rw.dryUntil,
      heavyDryAt: heavyOk ? null : heavy.until,
    };
  }
  const lg = pvTips(reqs, oldest, dayStart, dayCosts.length, out.forecast && out.forecast.verdict);
  out.effort = lg.effort;
  out.tips = lg.tips;
  return out;
}

// CCSwitcherX (~/.claude-accounts): read-only, and only its usage numbers and switch state. Saved profiles are
// encrypted files holding sign-ins and are never opened; labels come from ~/.ccusagex/account-labels.json
// ({ "<profile id>": "label" }), a local file that is never part of the repo.
const SWITCHER_DIR = process.env.CCU_SWITCHER_DIR || path.join(os.homedir(), '.claude-accounts');
const LABELS_FILE = path.join(DATA_DIR, 'account-labels.json');
const PLAN_FILE = path.join(DATA_DIR, 'plan-value.json');
let swCache = { sig: null, val: null };
function pvReadJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } }
function pvMtime(f) { try { return fs.statSync(f).mtimeMs; } catch { return 0; } }
function readSwitcher() {
  const uf = path.join(SWITCHER_DIR, 'usage.json'), af = path.join(SWITCHER_DIR, 'autoswitch.json');
  const um = pvMtime(uf);
  if (!um) return null;
  const sig = [um, pvMtime(af), pvMtime(LABELS_FILE)].join('|');
  if (swCache.sig === sig) return swCache.val;
  const usage = pvReadJson(uf) || {}, auto = pvReadJson(af) || {}, labels = pvReadJson(LABELS_FILE) || {};
  const profiles = [];
  for (const id of Object.keys(usage)) {
    if (!/^[0-9a-f]{6,64}$/i.test(id)) continue;
    const w = usage[id] && usage[id].week;
    if (!w || typeof w.pct !== 'number' || !(Number(w.resetsAt) > 0)) continue;
    const fa = Number(usage[id].fetchedAt) || 0;
    profiles.push({ id, label: typeof labels[id] === 'string' ? labels[id].slice(0, 40) : null, pct: w.pct, resetsAt: Number(w.resetsAt) * 1000, fetchedAt: fa > 1e12 ? fa : fa * 1000 });
  }
  const la = Number(auto.lastSwitchAt) || 0;
  const val = { profiles, activeId: typeof auto.lastTo === 'string' ? auto.lastTo : null, activeAt: la > 1e12 ? la : la * 1000, weekLimit: Number(auto.weekLimit) || 100 };
  swCache = { sig, val };
  return val;
}

let pvLast = pvReadJson(PLAN_FILE);
function planValuePayload() {
  limitsRefresh(2000);
  const out = computePlanValue(LIM.hist.points, sortedList(), readSwitcher(), Date.now(), bhZone(), pvLast);
  const p = out.plan;
  if (p && !p.stale && !p.thin && (!pvLast || Date.now() - (pvLast.at || 0) > PV.SAVE_EVERY_MS)) {
    pvLast = { perPct: p.perPct, lo: p.perPct, hi: p.perPct, chunks: p.chunks, at: Date.now() };
    try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(PLAN_FILE, JSON.stringify(pvLast)); } catch { /* keep it in memory */ }
  }
  return out;
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
    if (u.pathname.startsWith('/api/')) probeTouch();
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
      case '/api/plan-value': return sendRaw(res, memoJson(key + '|pv', planValuePayload));
      case '/api/burn-hours': widgetConfig(); return sendRaw(res, memoJson(key + '|' + widgetVersion, burnHoursPayload));
      case '/api/limits':
        if (q.get('refresh') === '1' && probeEnabled()) {
          return probeRefresh().then(() => { limitsRefresh(0); sendJson(res, limitsPayload()); })
            .catch(() => { if (!res.headersSent) sendJson(res, { error: 'limits unavailable' }, 500); });
        }
        limitsRefresh(0);
        return sendJson(res, limitsPayload());
      case '/api/stream': return sseConnect(req, res, u);
      case '/api/live/state':
        if (!LV.watcher && !LV.polling && Date.now() - (lastScanAt || 0) > 1500) scan(); // no watcher (not started): stay fresh anyway
        return sendJson(res, liveState());
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
    server.listen(port, host, () => {
      liveAttach(server);
      resolve(server);
    });
  });
}

// ---------------------------------------------------------------- main

if (require.main === module) {
  loadStore();
  scan();
  const timer = setInterval(scan, Math.max(2, CONFIG.scanIntervalSeconds || 5) * 1000);
  start(PORT, HOST).then(() => {
    probeStart();
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
  computeBurnHours, burnHoursPayload, computePlanValue, planValuePayload, pvRunway, pvSafeDay, pvTips, pvDayStart, liveState, stopLive, computeLimits, limitsPayload, probeStart, probeStop, probeRun, probeRefresh, probePublic, probeParseOutput, probeSnapshot, probeResolveBin, probeInterval, probeTouch, _probe: PROBE, computeCost, priceFor, summary, filterRequests, live, status, resolveOrphans,
  _state: { get store() { return store; }, reqMap, byPrompt, STORE_FILE, START_MS, PROJECTS_DIR },
};
