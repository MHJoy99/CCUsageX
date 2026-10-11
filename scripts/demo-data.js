#!/usr/bin/env node
'use strict';
// Generates realistic, entirely fictional Claude Code transcripts for demos and screenshots.
//   node scripts/demo-data.js <outDir> [--days 30] [--seed 42] [--serve] [--port 3020]
// Writes <outDir>/projects/<project>/<session>.jsonl (+ <session>/subagents/agent-<id>.jsonl).
// With --serve it then starts the dashboard on that data (data store kept in <outDir>/data).

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); return i > -1 ? argv[i + 1] : d; };
const OUT = path.resolve(argv[0] && !argv[0].startsWith('--') ? argv[0] : '.demo');
const DAYS = Number(opt('--days', 30));
const SEED = Number(opt('--seed', 42));
const NOW = Number(opt('--now', Date.now()));

// ---------------------------------------------------------------- seeded PRNG

let s = SEED >>> 0;
function rnd() { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }
const pick = (a) => a[Math.floor(rnd() * a.length)];
const between = (a, b) => a + (b - a) * rnd();
const int = (a, b) => Math.floor(between(a, b + 1));
function weighted(pairs) { const tot = pairs.reduce((x, p) => x + p[1], 0); let r = rnd() * tot; for (const [v, w] of pairs) { if ((r -= w) <= 0) return v; } return pairs[0][0]; }
function logn(med, spread) { return med * Math.exp((rnd() * 2 - 1) * spread); }
let idn = 0;
const hex = (n) => Array.from({ length: n }, () => '0123456789abcdef'[Math.floor(rnd() * 16)]).join('');
const uuid = () => `${hex(8)}-${hex(4)}-4${hex(3)}-a${hex(3)}-${hex(12)}`;
const msgId = () => `msg_demo${String(++idn).padStart(6, '0')}${hex(10)}`;

// ---------------------------------------------------------------- fictional content

const PROJECTS = [
  { cwd: '/home/dev/code/acme-api', branch: 'main', title: 'acme-api' },
  { cwd: '/home/dev/code/acme-web', branch: 'feat/charts', title: 'acme-web' },
  { cwd: '/home/dev/code/ccusagex', branch: 'main', title: 'ccusagex' },
  { cwd: '/home/dev/code/infra', branch: 'ops/terraform', title: 'infra' },
];
const HEADLINE = ['Refactor the auth middleware', 'Add charts API for scatter', 'Write the README', 'Fix flaky test in verify.js', 'Explain store.json layout', 'Why is the scan slow?'];
const PROMPTS = [
  'Add pagination to the /orders endpoint', 'Rename config keys to camelCase and update docs', 'Summarise yesterday\'s changes',
  'Debug the SSE reconnect loop', 'Implement the pricing lookup with tests', 'Review server.js for edge cases',
  'Add a dark mode toggle', 'Make the CSV export guard against formula injection', 'Write a migration for the sessions table',
  'Why does the build fail on Node 18?', 'Add retry with backoff to the webhook sender', 'Profile the summary endpoint',
  'Turn this into a reusable hook', 'Add keyboard navigation to the drawer', 'Explain this stack trace',
  'Bump dependencies and fix breaking changes', 'Add an index for the time-range query', 'Write unit tests for the parser',
  'Clean up the logging', 'Draft release notes for v1.4', 'Split the monolith route file', 'Add rate limiting to login',
  'Convert the cron job to a queue worker', 'Find where the memory leak comes from', 'Make the chart tooltips keyboard accessible',
  'Port the bash script to Node', 'Add a local test runner script', 'Document the HTTP API',
];
const TOOLS = [['Bash', 1820], ['Read', 1310], ['Edit', 760], ['Grep', 410], ['Write', 220], ['Glob', 120], ['WebSearch', 64], ['TodoWrite', 40]];
const ANSWERS = [
  'Done. I updated the handler, added tests and all 38 pass.', 'Here is what I found: the scan re-reads unchanged files; I added an mtime check.',
  'I refactored the middleware into three small functions and kept the public API unchanged.', 'The flaky test depended on wall-clock time; it now uses a fixed clock.',
  'Summary of changes: new endpoint, docs updated, CHANGELOG entry added.', 'The store is a compact, dictionary-packed JSON file; here is the layout.',
];
const SUBAGENTS = [['Explore', 'Find all call sites'], ['general-purpose', 'Review the diff'], ['Explore', 'Map the data flow'], ['general-purpose', 'Write the test fixtures']];

// ---------------------------------------------------------------- writer

const files = new Map();
function emit(file, rec) { if (!files.has(file)) files.set(file, []); files.get(file).push(JSON.stringify(rec)); }
const iso = (t) => new Date(t).toISOString();

function base(o, sess) {
  return { parentUuid: o.parent || null, isSidechain: !!o.side, userType: 'external', entrypoint: sess.entry, cwd: sess.proj.cwd, sessionId: sess.id, version: '2.1.296', gitBranch: sess.proj.branch, timestamp: iso(o.t), uuid: o.uuid || uuid() };
}

// One API request = 1–3 transcript lines (one per content block) sharing message.id + requestId.
function request(file, sess, o) {
  const id = msgId();
  const req = `req_demo${hex(16)}`;
  const tools = o.tools || [];
  const blocks = [];
  if (o.thinking) blocks.push({ type: 'thinking', thinking: '', signature: '' });
  if (o.text) blocks.push({ type: 'text', text: o.text });
  for (const name of tools) blocks.push({ type: 'tool_use', id: 'toolu_' + hex(20), name, input: {} });
  if (!blocks.length) blocks.push({ type: 'text', text: 'OK.' });
  const ctx = sess.ctx;
  const write5m = Math.round(o.newTokens);
  const usage = {
    input_tokens: int(1, 12), cache_creation_input_tokens: write5m, cache_read_input_tokens: ctx,
    output_tokens: o.output, output_tokens_details: { thinking_tokens: o.thinking || 0 },
    server_tool_use: { web_search_requests: tools.includes('WebSearch') ? 1 : 0, web_fetch_requests: 0 },
    service_tier: 'standard', cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: write5m }, speed: 'standard',
  };
  const start = o.t;
  const end = o.t + o.durMs;
  let parent = o.parent;
  let last;
  blocks.forEach((b, i) => {
    const isLast = i === blocks.length - 1;
    const t = Math.round(start + (end - start) * ((i + 1) / blocks.length));
    const u = o.partial
      ? { ...usage, output_tokens: int(3, 20), output_tokens_details: undefined }
      : (isLast ? usage : { ...usage, output_tokens: Math.max(1, Math.round(usage.output_tokens * (i + 1) / blocks.length)) });
    const rec = {
      ...base({ t, parent, side: o.side }, sess), type: 'assistant', requestId: req, apiBlockIndex: i, effort: sess.effort, requestedModel: o.model,
      message: { model: o.model, id, type: 'message', role: 'assistant', content: [b], stop_reason: isLast && !o.partial ? (tools.length ? 'tool_use' : 'end_turn') : null, stop_sequence: null, usage: u },
    };
    emit(file, rec);
    parent = rec.uuid;
    last = rec;
  });
  sess.ctx = Math.min(420000, ctx + write5m);
  return { uuid: last.uuid, end };
}

function toolResults(file, sess, o) {
  const rec = { ...base({ t: o.t, parent: o.parent, side: o.side }, sess), type: 'user', promptId: o.promptId, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_' + hex(20), content: 'ok' }] } };
  emit(file, rec);
  return rec.uuid;
}

function turn(sess, t, text, isHeadline) {
  const file = path.join('projects', sess.slug, `${sess.id}.jsonl`);
  const promptId = uuid();
  const prompt = { ...base({ t }, sess), type: 'user', promptId, origin: { kind: 'human' }, turnOrigin: 'human', promptSource: 'user', message: { role: 'user', content: text } };
  emit(file, prompt);
  let parent = prompt.uuid;
  let clock = t + int(300, 900);
  const steps = isHeadline ? int(9, 14) : weighted([[int(3, 6), 3], [int(6, 12), 5], [int(12, 20), 2]]);
  const spawnAt = rnd() < (isHeadline ? 0.9 : 0.35) ? int(1, Math.max(1, steps - 2)) : -1;
  for (let i = 0; i < steps; i++) {
    const lastStep = i === steps - 1;
    const tools = lastStep ? [] : [weighted(TOOLS)].concat(rnd() < 0.25 ? [weighted(TOOLS)] : []);
    const output = Math.round(lastStep ? logn(900, 0.8) : logn(260, 0.9)) + (isHeadline ? 300 : 0);
    const thinking = rnd() < 0.55 ? Math.round(output * between(0.1, 0.35)) : 0;
    const durMs = Math.round(Math.max(900, output / logn(sess.speed, 0.15) * 1000 + logn(350, 0.5)));
    const r = request(file, sess, { t: clock, parent, model: sess.model, output, thinking, durMs, tools, text: lastStep ? pick(ANSWERS) : (rnd() < 0.4 ? 'Let me check.' : ''), newTokens: logn(5200, 0.7) });
    clock = r.end + int(400, 4000);
    if (i === spawnAt) subagent(sess, promptId, r.uuid, clock);
    if (!lastStep) { parent = toolResults(file, sess, { t: clock, parent: r.uuid, promptId }); clock += int(200, 900); }
  }
  return clock;
}

function subagent(sess, promptId, parentUuid, t) {
  const [agentType, desc] = pick(SUBAGENTS);
  const agentId = hex(17);
  const file = path.join('projects', sess.slug, sess.id, 'subagents', `agent-${agentId}.jsonl`);
  fs.mkdirSync(path.join(OUT, path.dirname(file)), { recursive: true });
  files.set(file.replace(/\.jsonl$/, '.meta.json'), [JSON.stringify({ agentType, description: desc })]);
  const sub = { ...sess, ctx: int(9000, 16000) };
  const first = { ...base({ t, side: true }, sub), type: 'user', promptId, agentId, message: { role: 'user', content: desc + '. Report back with file paths.' } };
  emit(file, first);
  let parent = first.uuid;
  let clock = t + int(300, 900);
  const model = agentType === 'Explore' && rnd() < 0.55 ? 'claude-haiku-5-5' : 'claude-sonnet-5-5';
  const speed = model === 'claude-haiku-5-5' ? 210 : 135;
  const n = int(4, 11);
  for (let i = 0; i < n; i++) {
    const last = i === n - 1;
    const output = Math.round(logn(last ? 700 : 220, 0.7));
    const r = request(file, sub, { t: clock, parent, side: true, model, output, thinking: 0, durMs: Math.round(output / logn(speed, 0.15) * 1000 + logn(300, 0.5)), tools: last ? [] : [weighted(TOOLS.slice(0, 5))], text: last ? 'Found 6 call sites; summary below.' : '', newTokens: logn(2600, 0.6), partial: rnd() < 0.18 });
    clock = r.end + int(300, 2500);
    if (!last) { parent = toolResults(file, sub, { t: clock, parent: r.uuid, promptId, side: true }); clock += int(150, 700); }
  }
}

// ---------------------------------------------------------------- schedule

const DAY = 864e5;
const today0 = new Date(NOW); today0.setHours(0, 0, 0, 0);
const sessionDays = [];
for (let d = DAYS - 1; d >= 0; d--) {
  const day = new Date(today0.getTime() - d * DAY);
  const wd = day.getDay();
  if ((wd === 0 || wd === 6) && rnd() < 0.8 && d !== 0) continue;
  if (rnd() < 0.3 && d !== 0) continue;
  sessionDays.push(day.getTime());
}
const headlines = HEADLINE.slice();
let sessions = 0;
let prompts = 0;
for (const dayStart of sessionDays) {
  const nSess = dayStart === today0.getTime() ? 1 : int(1, 1);
  for (let k = 0; k < nSess; k++) {
    sessions++;
    const proj = pick(PROJECTS);
    const main = weighted([['claude-opus-5-5', 6], ['claude-sonnet-5-5', 3]]);
    const sess = {
      id: uuid(), proj, slug: proj.cwd.replace(/[^a-zA-Z0-9]/g, '-'), entry: pick(['cli', 'claude-vscode']),
      effort: weighted([['high', 5], ['medium', 3], ['xhigh', 2]]), model: main, speed: main === 'claude-opus-5-5' ? 94 : 135, ctx: int(30000, 52000),
    };
    const file = path.join('projects', sess.slug, `${sess.id}.jsonl`);
    const isToday = dayStart === today0.getTime();
    let t = isToday ? NOW - 70 * 60e3 : dayStart + int(9, 15) * 36e5 + int(0, 59) * 60e3;
    const nPrompts = isToday ? 6 : int(5, 9);
    for (let p = 0; p < nPrompts; p++) {
      const headline = headlines.length && (isToday ? p < 3 : rnd() < 0.12) ? headlines.shift() : null;
      t = turn(sess, t, headline || pick(PROMPTS), !!headline);
      prompts++;
      t += isToday ? int(3, 9) * 60e3 : int(4, 40) * 60e3;
      if (isToday && t > NOW - 2 * 60e3) break;
    }
    emit(file, { type: 'ai-title', aiTitle: `${proj.title}: ${pick(['auth refactor', 'charts work', 'docs pass', 'test fixes', 'perf investigation', 'release prep'])}`, sessionId: sess.id });
  }
}

// ---------------------------------------------------------------- write

fs.rmSync(path.join(OUT, 'projects'), { recursive: true, force: true });
for (const [rel, lines] of files) {
  const f = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, lines.join('\n') + '\n');
}
console.log(`demo data: ${sessions} sessions, ${prompts} prompts, ${files.size} files -> ${OUT}`);

if (argv.includes('--serve')) {
  const env = { ...process.env, CLAUDE_CONFIG_DIR: OUT, CCU_DATA_DIR: path.join(OUT, 'data'), CCU_START_DATE: 'all' };
  fs.rmSync(env.CCU_DATA_DIR, { recursive: true, force: true });
  const args = [path.join(__dirname, '..', 'server.js')];
  if (opt('--port')) args.push('--port', opt('--port'));
  const child = spawn(process.execPath, args, { env, stdio: 'inherit' });
  child.on('exit', (code) => process.exit(code || 0));
}
