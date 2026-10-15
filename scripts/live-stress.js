#!/usr/bin/env node
'use strict';
// Synthetic live-view stress generator. Fictional content only.
//   node scripts/live-stress.js <claudeConfigDir> [--agents 25] [--speed 1] [--duration 120] [--seed 1]
//
// Writes transcripts IN REAL TIME under <claudeConfigDir>/projects/-home-dev-code-stress-fixture/:
//   <session>.jsonl                          main session (claude-opus-5-5): one human prompt, its own tool calls,
//                                            one Agent tool_use per background helper, task-notification records
//                                            (queue-operation enqueue + queued_command attachment), end_turn at the end
//   <session>/subagents/agent-<id>.jsonl     helper transcript: 2-8 tool calls, then a SubagentHandback (completed)
//   <session>/subagents/agent-<id>.meta.json {agentType, description, toolUseId, requestShape:"background", model}
// Record shapes follow scripts/demo-data.js and docs/ARCHITECTURE.md.
//
// --duration is the scenario length in SIMULATED seconds; a simulated second takes 1/--speed real seconds.
// Endings: ~10% of the non-stalled helpers are killed (notification, no handback); 2 helpers never finish
// (no handback, no notification) to exercise staleness. Everything is planned from --seed; timestamps are the real
// write time. The run ends after the last notification (or --duration) with the main turn's end_turn.
// Ctrl+C stops it. A previous run's output directory is replaced only if it carries this tool's marker file.

const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const usage = () => console.log('usage: node scripts/live-stress.js <claudeConfigDir> [--agents 25] [--speed 1] [--duration 120] [--seed 1]');
if (argv.includes('-h') || argv.includes('--help')) { usage(); process.exit(0); }
if (!argv[0] || argv[0].startsWith('--')) { usage(); process.exit(2); }

const opt = (name, d) => {
  const i = argv.indexOf(name);
  return i > -1 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const num = (name, d, lo, hi) => {
  const v = Number(opt(name, d));
  if (!Number.isFinite(v) || v < lo || v > hi) { console.error(`${name} must be a number in [${lo}, ${hi}]`); process.exit(2); }
  return v;
};

const CONFIG_DIR = path.resolve(argv[0]);
const AGENTS = Math.floor(num('--agents', 25, 0, 200));
const SPEED = num('--speed', 1, 0.01, 1000);
const DURATION = num('--duration', 120, 10, 7200);
const SEED = Math.floor(num('--seed', 1, 0, 2 ** 31 - 1));

// ---------------------------------------------------------------- seeded PRNG (plan + ids)

let rs = SEED >>> 0;
function rnd() {
  rs = (rs + 0x6d2b79f5) >>> 0;
  let t = rs;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const between = (a, b) => a + (b - a) * rnd();
const int = (a, b) => Math.floor(between(a, b + 1));
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const hex = (n) => Array.from({ length: n }, () => '0123456789abcdef'[Math.floor(rnd() * 16)]).join('');
const uuid = () => `${hex(8)}-${hex(4)}-4${hex(3)}-a${hex(3)}-${hex(12)}`;

// ---------------------------------------------------------------- fictional content

const CWD = '/home/dev/code/stress-fixture';
const GIT_BRANCH = 'feat/orders-audit';
const VERSION = '2.1.296';
const SLUG = CWD.replace(/[^a-zA-Z0-9]/g, '-');
const PROJECT_DIR = path.join(CONFIG_DIR, 'projects', SLUG);
const MARKER = '.live-stress';
const MAIN_MODEL = 'claude-opus-5-5';
const SUB_MODEL = { general: 'claude-sonnet-5-5', explore: 'claude-haiku-5-5' };
const CTX_LIMIT = 1000000;

const SESSION_ID = uuid();
const PROMPT_ID = uuid();
const MAIN_FILE = path.join(PROJECT_DIR, `${SESSION_ID}.jsonl`);
const SUB_DIR = path.join(PROJECT_DIR, SESSION_ID, 'subagents');

const PROMPT = 'Audit the orders module in parallel: helpers check pagination, cursors, the CSV export and the retry paths while I map the call sites.';
const DESCS = [
  'Map pagination call sites', 'Audit cursor encoding', 'Check CSV formula guard', 'Trace session cache keys',
  'Review webhook retry path', 'Inventory invoice rounding', 'Find tax table consumers', 'Check retry helper backoff',
  'Read queue worker shutdown', 'Summarise route file layout', 'Scan tests for wall-clock use', 'Audit auth middleware order',
  'List config keys in use', 'Compare defaults with docs', 'Find unbounded cache growth', 'Check error envelope shape',
  'Map billing to order events', 'Review rate-limit headers', 'Profile slow list query', 'Verify docs examples',
  'Check logging of personal fields', 'Find dead exports in lib', 'Trace retry budget usage', 'Review migration for sessions table',
  'Check timezone handling in invoices', 'Sample fixture coverage', 'Read changelog entries', 'Find TODO markers in src',
  'Check dependency pins', 'Review CORS allow-list',
];
const FILES = [
  'src/orders/pagination.js', 'src/orders/cursor.js', 'src/orders/routes.js', 'src/billing/invoice.js', 'src/billing/tax.js',
  'src/auth/session.js', 'src/auth/middleware.js', 'src/csv/export.js', 'src/webhooks/sender.js', 'src/queue/worker.js',
  'test/orders.test.js', 'test/billing.test.js', 'docs/api.md', 'config/defaults.json', 'lib/retry.js', 'lib/cache.js',
];
const GREP_TERMS = ['cursor', 'retry', 'formatCsv', 'sessionKey', 'TODO', 'invoiceTotal', 'pageSize'];
const SHELL = ['npm test -- --silent orders', 'node --check src/orders/cursor.js', 'git log --oneline -n 8', 'wc -l src/billing/*.js', 'ls test'];
const MAIN_TEXT = ['Reading the route wiring first.', 'Checking how the cursor is decoded.', 'Looking at the export path next.', 'Helpers are running; I will keep mapping call sites.'];

// One fictional tool call; withEdit lets helpers occasionally propose an Edit.
function makeCall(withEdit) {
  const roll = rnd();
  const file = `${CWD}/${pick(FILES)}`;
  if (withEdit && roll < 0.12) return { name: 'Edit', input: { file_path: file, old_string: 'const LIMIT = 50;', new_string: 'const LIMIT = 100;' }, result: 'The file has been updated.' };
  if (roll < 0.4) return { name: 'Read', input: { file_path: file }, result: `${int(20, 400)} lines read` };
  if (roll < 0.7) return { name: 'Grep', input: { pattern: pick(GREP_TERMS), path: `${CWD}/src`, output_mode: 'content' }, result: `${int(1, 9)} matches in ${int(1, 4)} files` };
  if (roll < 0.85) return { name: 'Glob', input: { pattern: pick(['src/**/*.js', 'test/**/*.test.js', 'docs/*.md']) }, result: `${int(3, 40)} files` };
  return { name: 'Bash', input: { command: pick(SHELL), description: 'Quick check' }, result: 'exit 0' };
}

// ---------------------------------------------------------------- guard + output directory

if (fs.existsSync(PROJECT_DIR)) {
  if (!fs.existsSync(path.join(PROJECT_DIR, MARKER))) {
    console.error(`refusing to touch ${PROJECT_DIR}: it was not created by live-stress`);
    process.exit(2);
  }
  fs.rmSync(PROJECT_DIR, { recursive: true, force: true });
}
fs.mkdirSync(SUB_DIR, { recursive: true });
fs.writeFileSync(path.join(PROJECT_DIR, MARKER), 'synthetic transcripts from scripts/live-stress.js\n');

// ---------------------------------------------------------------- scheduler (simulated seconds, sorted queue)

const queue = [];
let seq = 0;
let simNow = 0;
function at(t, fn) {
  const item = { t, seq: seq++, fn };
  let i = queue.length;
  while (i > 0 && queue[i - 1].t > t) i--;
  queue.splice(i, 0, item);
}

// ---------------------------------------------------------------- writers

const counts = { spawned: 0, done: 0, killed: 0, stalled: 0, lines: 0 };
const nowIso = () => new Date().toISOString();
function write(file, obj) {
  fs.appendFileSync(file, JSON.stringify(obj) + '\n');
  counts.lines++;
}
function log(msg) {
  console.log(`[sim ${simNow.toFixed(1).padStart(6)}s] ${msg} | spawned ${counts.spawned}/${AGENTS} done ${counts.done} killed ${counts.killed} lines ${counts.lines}`);
}

// actor = { file, side, agentId, model, parent, ctx, promptId }
function base(a) {
  const r = {
    parentUuid: a.parent, isSidechain: a.side, userType: 'external', entrypoint: 'cli', cwd: CWD, sessionId: SESSION_ID,
    version: VERSION, gitBranch: GIT_BRANCH, timestamp: nowIso(), uuid: uuid(),
  };
  if (a.side) r.agentId = a.agentId;
  return r;
}

function userLine(a, content) {
  const r = { ...base(a), type: 'user', promptId: a.promptId, message: { role: 'user', content } };
  write(a.file, r);
  a.parent = r.uuid;
}

function toolResult(a, toolUseId, text) {
  userLine(a, [{ type: 'tool_result', tool_use_id: toolUseId, content: text }]);
}

// One API message: one line per content block, all sharing message.id + requestId. stop_reason sits on the last line;
// stop === null is a stream that never reached its stop (stream-start usage only, as Claude Code writes it).
function request(a, blocks, stop) {
  const mid = `msg_stress${hex(20)}`;
  const rid = `req_stress${hex(16)}`;
  const partial = stop === null;
  const cw = int(1200, 6000);
  const cr = a.ctx;
  a.ctx = Math.min(CTX_LIMIT, a.ctx + cw);
  const out = partial ? int(3, 18) : int(120, 700) + (blocks.length > 1 ? 0 : 200);
  blocks.forEach((b, i) => {
    const last = i === blocks.length - 1;
    const content = b.type === 'tool_use'
      ? { type: 'tool_use', id: b.id, name: b.name, input: b.input }
      : { type: 'text', text: b.text };
    const usage = {
      input_tokens: int(1, 9), cache_creation_input_tokens: cw, cache_read_input_tokens: cr,
      output_tokens: partial ? out : Math.max(1, Math.round(out * (i + 1) / blocks.length)),
      output_tokens_details: { thinking_tokens: 0 }, server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
      service_tier: 'standard', cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: cw }, speed: 'standard',
    };
    const r = {
      ...base(a), type: 'assistant', requestId: rid, apiBlockIndex: i, requestedModel: a.model, effort: 'high',
      message: {
        model: a.model, id: mid, type: 'message', role: 'assistant', content: [content],
        stop_reason: last ? stop : null, stop_sequence: null, usage,
      },
    };
    write(a.file, r);
    a.parent = r.uuid;
  });
}

// The parent session receives the helper's result as a task notification (queue-operation enqueue, then the
// queued_command attachment the harness delivers into the turn).
function notify(main, agent, status, resultText) {
  const text = `<task-notification>\n<task-id>${agent.agentId}</task-id>\n<tool-use-id>${agent.toolUseId}</tool-use-id>\n<status>${status}</status>\n<summary>Agent "${agent.desc}" ${status}</summary>\n<result>${resultText}</result>\n</task-notification>`;
  const ts = nowIso();
  write(MAIN_FILE, { type: 'queue-operation', operation: 'enqueue', timestamp: ts, sessionId: SESSION_ID, content: text });
  write(MAIN_FILE, {
    parentUuid: main.parent, isSidechain: false, userType: 'external', entrypoint: 'cli', cwd: CWD, sessionId: SESSION_ID,
    version: VERSION, gitBranch: GIT_BRANCH, timestamp: ts, uuid: uuid(), type: 'attachment',
    attachment: {
      type: 'queued_command', prompt: text, source_uuid: uuid(), delivery_id: hex(12), commandMode: 'task-notification',
      origin: { kind: 'task-notification', producer: 'session-task' }, runId: uuid(), timestamp: ts,
    },
  });
}

// ---------------------------------------------------------------- plan

const main = { file: MAIN_FILE, side: false, agentId: null, model: MAIN_MODEL, parent: null, ctx: 30000, promptId: PROMPT_ID };

// Endings: a shuffled order decides which helpers are stalled (never end) and which are killed.
const order = Array.from({ length: AGENTS }, (_, i) => i);
for (let i = order.length - 1; i > 0; i--) {
  const j = Math.floor(rnd() * (i + 1));
  [order[i], order[j]] = [order[j], order[i]];
}
const stalledN = AGENTS >= 4 ? 2 : 0;
const killedN = Math.round((AGENTS - stalledN) * 0.1);
const ending = new Array(AGENTS).fill('completed');
order.slice(0, stalledN).forEach((i) => { ending[i] = 'stalled'; });
order.slice(stalledN, stalledN + killedN).forEach((i) => { ending[i] = 'killed'; });

// Spawns are staggered over the first ~45% of the scenario.
const spawnTimes = Array.from({ length: AGENTS }, () => between(3, Math.max(4, DURATION * 0.45))).sort((x, y) => x - y);

at(0, () => {
  write(MAIN_FILE, { type: 'ai-title', aiTitle: `stress-fixture: ${AGENTS} background helpers`, sessionId: SESSION_ID });
  const r = {
    parentUuid: null, isSidechain: false, userType: 'external', entrypoint: 'cli', cwd: CWD, sessionId: SESSION_ID,
    version: VERSION, gitBranch: GIT_BRANCH, timestamp: nowIso(), uuid: uuid(), type: 'user', promptId: PROMPT_ID,
    origin: { kind: 'human' }, turnOrigin: 'human', promptSource: 'user', message: { role: 'user', content: PROMPT },
  };
  write(MAIN_FILE, r);
  main.parent = r.uuid;
  log(`main prompt written (${SESSION_ID})`);
});

let maxFinish = 0;
const agentPlans = [];
for (let i = 0; i < AGENTS; i++) {
  const s = spawnTimes[i];
  const agentType = rnd() < 0.6 ? 'general-purpose' : 'Explore';
  const desc = DESCS[i % DESCS.length] + (i >= DESCS.length ? ` #${Math.floor(i / DESCS.length) + 1}` : '');
  const model = agentType === 'Explore' && rnd() < 0.5 ? SUB_MODEL.explore : SUB_MODEL.general;
  const agentId = hex(17);
  const toolUseId = `toolu_${hex(20)}`;
  const prompt = `${desc}. Look only at the files you need and report back with file paths and line numbers.`;
  const meta = { agentId, desc, toolUseId };
  const sub = { file: path.join(SUB_DIR, `agent-${agentId}.jsonl`), side: true, agentId, model, parent: null, ctx: int(9000, 16000), promptId: PROMPT_ID };
  const spawnText = rnd() < 0.5 ? `Helper for ${desc.toLowerCase()}.` : null;
  agentPlans.push({ i, ...meta, agentType, status: ending[i] });

  // main session: the Agent tool_use, then its immediate async result
  at(s, () => {
    const blocks = [];
    if (spawnText) blocks.push({ type: 'text', text: spawnText });
    blocks.push({ type: 'tool_use', id: toolUseId, name: 'Agent', input: { description: desc, prompt, subagent_type: agentType, run_in_background: true } });
    request(main, blocks, 'tool_use');
    counts.spawned++;
    log(`spawn "${desc}" (${agentType}, ${model})`);
  });
  at(s + 0.4, () => toolResult(main, toolUseId, `Async agent launched (agentId ${agentId}). A notification arrives when it finishes.`));

  // helper transcript: meta first, then the prompt, then 2-8 tool calls
  at(s + 0.2, () => {
    fs.writeFileSync(sub.file.replace(/\.jsonl$/, '.meta.json'), JSON.stringify({
      agentType, description: desc, toolUseId, requestShape: 'background', model,
    }) + '\n');
    userLine(sub, prompt);
  });
  let t = s + between(0.8, 2.0);
  const calls = int(2, 8);
  for (let k = 0; k < calls; k++) {
    const c = makeCall(true);
    const id = `toolu_${hex(20)}`;
    const stop = rnd() < 0.55 ? null : 'tool_use';
    const tt = t;
    at(tt, () => request(sub, [{ type: 'tool_use', id, name: c.name, input: c.input }], stop));
    at(tt + between(0.3, 1.0), () => toolResult(sub, id, c.result));
    t = tt + between(2.5, 6);
  }

  if (ending[i] === 'completed') {
    const hb = t + (rnd() < 0.5 ? between(0, DURATION * 0.35) : 0); // some helpers linger, which shuffles the finish order
    const hbId = `toolu_${hex(20)}`;
    const stop = rnd() < 0.5 ? null : 'tool_use';
    const n = int(3, 12);
    at(hb, () => request(sub, [{ type: 'tool_use', id: hbId, name: 'SubagentHandback', input: { summary: `Checked ${n} items; findings and file paths below.` } }], stop));
    at(hb + 0.3, () => toolResult(sub, hbId, 'Handback received.'));
    const fin = hb + 0.8;
    at(fin, () => { notify(main, meta, 'completed', `Checked ${n} items; file paths and findings are in the handback.`); counts.done++; log(`done "${desc}" completed`); });
    maxFinish = Math.max(maxFinish, fin);
  } else if (ending[i] === 'killed') {
    const fin = t + between(0.5, 2);
    at(fin, () => { notify(main, meta, 'killed', 'Stopped before the handback.'); counts.killed++; log(`done "${desc}" killed`); });
    maxFinish = Math.max(maxFinish, fin);
  } else {
    counts.stalled++; // never finishes: no handback, no notification
  }
}

// main agent keeps working in between, then ends its turn after the last notification
const tEnd = Math.max(DURATION, maxFinish + 2);
for (let t = 4; t < tEnd - 2; t += between(3, 7)) {
  at(t, () => {
    const c = makeCall(false);
    const id = `toolu_${hex(20)}`;
    request(main, [{ type: 'text', text: pick(MAIN_TEXT) }, { type: 'tool_use', id, name: c.name, input: c.input }], 'tool_use');
    at(simNow + between(0.6, 1.8), () => toolResult(main, id, c.result));
  });
}
at(tEnd, () => {
  const stalledNames = agentPlans.filter((p) => p.status === 'stalled').map((p) => `"${p.desc}"`).join(', ');
  const text = `Helper results: ${counts.done} completed, ${counts.killed} killed, ${stalledNames ? `${stalledN} never reported (${stalledNames})` : 'none outstanding'}. No repository files were changed.`;
  request(main, [{ type: 'text', text }], 'end_turn');
  log('main turn ended (end_turn)');
});

// ---------------------------------------------------------------- run in real time

const EXPECT = { completed: AGENTS - stalledN - killedN, killed: killedN, stalled: stalledN };
console.log(`live-stress: seed ${SEED}, ${AGENTS} agents (expect ${EXPECT.completed} completed, ${EXPECT.killed} killed, ${EXPECT.stalled} stalled), speed x${SPEED}, ${DURATION}s simulated (~${(tEnd / SPEED).toFixed(0)}s real) -> ${PROJECT_DIR}`);

process.on('SIGINT', () => {
  console.log(`\nlive-stress: interrupted at sim ${simNow.toFixed(1)}s; ${counts.lines} lines written to ${PROJECT_DIR}`);
  process.exit(0);
});

(async () => {
  const start = Date.now();
  while (queue.length) {
    const item = queue.shift();
    const wait = start + (item.t * 1000) / SPEED - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    simNow = item.t;
    item.fn();
  }
  console.log(`live-stress: done. ${counts.lines} lines, ${counts.done} completed, ${counts.killed} killed, ${counts.stalled} stalled (no end) in ${((Date.now() - start) / 1000).toFixed(1)}s real`);
})();
