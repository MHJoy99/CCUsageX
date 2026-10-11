'use strict';
// Run with: node --test test/live.test.js
// Real-time Live view: drives the server over HTTP (/api/stream, Server-Sent Events) against a temp CLAUDE_CONFIG_DIR,
// appends transcript lines to a jsonl file and measures how long the matching event takes to reach the client.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const { spawn } = require('child_process');
const { performance } = require('perf_hooks');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ccu-live-'));
const CLAUDE = path.join(TMP, 'claude');
const PROJECTS = path.join(CLAUDE, 'projects');
fs.mkdirSync(path.join(PROJECTS, 'p'), { recursive: true });
process.env.CLAUDE_CONFIG_DIR = CLAUDE;
process.env.CCU_DATA_DIR = path.join(TMP, 'data');
process.env.CCU_START_DATE = '2026-01-01';
const srv = require('../server.js');

let server;
let port;
const clients = [];
test.before(async () => { server = await srv.start(0); port = server.address().port; });
test.after(() => {
  for (const c of clients) c.close();
  server.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

// ---------------------------------------------------------------- fixtures

let seq = 0;
const uid = () => `10000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;
const iso = (ms) => new Date(ms).toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function base(o) {
  return {
    parentUuid: o.parent || null, isSidechain: !!o.side, uuid: o.uuid || uid(), timestamp: iso(o.t === undefined ? Date.now() : o.t),
    cwd: o.cwd || '/home/dev/proj', sessionId: o.sid, version: '2.1.0', entrypoint: 'cli', ...(o.agentId ? { agentId: o.agentId } : {}),
  };
}
function userRec(o) {
  return { ...base(o), type: 'user', promptId: o.pid, ...(o.human ? { origin: { kind: 'human' } } : {}), message: { role: 'user', content: o.content === undefined ? 'hello' : o.content } };
}
function resultRec(o) {
  return userRec({ ...o, content: [{ type: 'tool_result', tool_use_id: o.tool, content: 'ok', ...(o.error ? { is_error: true } : {}) }] });
}
function asstRec(o) {
  return {
    ...base(o), type: 'assistant', requestId: 'req_' + o.msg, apiBlockIndex: o.blk || 0,
    message: {
      id: o.msg, model: o.model || 'claude-opus-5-5', role: 'assistant', content: o.content || [{ type: 'text', text: 'ok' }], stop_reason: o.stop === undefined ? null : o.stop,
      usage: { input_tokens: 10, output_tokens: o.out || 20, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 },
    },
  };
}
const toLines = (recs) => recs.map((r) => JSON.stringify(r)).join('\n') + '\n';
const append = (rel, recs) => {
  const f = path.join(PROJECTS, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.appendFileSync(f, toLines(recs));
  return f;
};

// ---------------------------------------------------------------- SSE client

function parseMsg(raw) {
  const m = { event: 'message', id: null, data: null, comment: null };
  const data = [];
  for (const line of raw.split('\n')) {
    if (line.startsWith(':')) m.comment = line.slice(1).trim();
    else if (line.startsWith('event:')) m.event = line.slice(6).trim();
    else if (line.startsWith('id:')) m.id = Number(line.slice(3).trim());
    else if (line.startsWith('retry:')) m.retry = Number(line.slice(6).trim());
    else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
  }
  if (data.length) m.data = JSON.parse(data.join('\n'));
  return m;
}

function connect(opts = {}) {
  return new Promise((resolve, reject) => {
    const msgs = [];
    let waiters = [];
    let buf = '';
    const req = http.get({ host: '127.0.0.1', port: opts.port || port, path: opts.path || '/api/stream', headers: opts.headers }, (res) => {
      res.setEncoding('utf8');
      res.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const m = parseMsg(buf.slice(0, i));
          buf = buf.slice(i + 2);
          m.at = performance.now();
          msgs.push(m);
          waiters = waiters.filter((w) => !w.try(m));
        }
      });
      res.on('error', () => {});
      const client = {
        res, msgs, headers: res.headers, status: res.statusCode,
        evs: (pred = () => true) => msgs.filter((m) => m.event === 'ev' && pred(m.data)),
        waitFor(pred, ms = 3000) { // resolves with the first message (already received or future) that matches
          const hit = msgs.find(pred);
          if (hit) return Promise.resolve(hit);
          return new Promise((res2, rej2) => {
            const w = { try: (m) => { if (pred(m)) { clearTimeout(t); res2(m); return true; } return false; } };
            const t = setTimeout(() => { waiters = waiters.filter((x) => x !== w); rej2(new Error('timeout waiting for message; got ' + JSON.stringify(msgs.slice(-5).map((x) => x.event + ':' + (x.data && x.data.kind))))); }, ms);
            waiters.push(w);
          });
        },
        waitEv(pred, ms) { return client.waitFor((m) => m.event === 'ev' && pred(m.data), ms); },
        close() { req.destroy(); res.destroy(); },
      };
      clients.push(client);
      resolve(client);
    });
    req.on('error', reject);
  });
}

const getJson = (p, headers) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path: p, headers }, (res) => {
    let b = '';
    res.on('data', (d) => { b += d; });
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: b, json: () => JSON.parse(b) }));
  }).on('error', reject);
});
const liveState = async () => (await getJson('/api/live/state')).json();
const sessionOf = async (sid) => (await liveState()).sessions.find((s) => s.sessionId === sid);

// ---------------------------------------------------------------- tests

test('SSE: headers, retry, snapshot first; Host guard, 405 and HEAD rules still apply', async () => {
  const c = await connect();
  assert.equal(c.status, 200);
  assert.match(c.headers['content-type'], /^text\/event-stream/);
  assert.equal(c.headers['cache-control'], 'no-cache, no-transform');
  assert.equal(c.headers.connection, 'keep-alive');
  assert.equal(c.headers['x-accel-buffering'], 'no');
  const first = await c.waitFor(() => true);
  assert.equal(first.retry, 1000);
  const snap = await c.waitFor((m) => m.event === 'snapshot');
  assert.ok(Array.isArray(snap.data.sessions));
  assert.ok(typeof snap.data.now === 'number' && 'today' in snap.data && 'rate' in snap.data && 'active' in snap.data);
  assert.ok(Number.isInteger(snap.id));

  assert.equal((await getJson('/api/stream', { Host: 'evil.example.com' })).status, 403);
  assert.equal((await getJson('/api/live/state', { Host: 'evil.example.com' })).status, 403);
  const post = await new Promise((resolve) => {
    const rq = http.request({ host: '127.0.0.1', port, path: '/api/stream', method: 'POST' }, (res) => { res.resume(); resolve(res.statusCode); });
    rq.end();
  });
  assert.equal(post, 405);
  const head = await new Promise((resolve, reject) => {
    const rq = http.request({ host: '127.0.0.1', port, path: '/api/stream', method: 'HEAD' }, (res) => { res.resume(); res.on('end', () => resolve(res)); });
    rq.on('error', reject);
    rq.end();
  });
  assert.equal(head.statusCode, 200);
  assert.match(head.headers['content-type'], /^text\/event-stream/);
  // other endpoints (and the memo cache) are untouched
  const live = (await getJson('/api/live')).json();
  assert.ok('active' in live && Array.isArray(live.recent));
  assert.equal((await getJson('/api/status')).status, 200);
  assert.equal((await getJson('/api/summary')).status, 200);
});

test('latency: a line appended to the transcript reaches the SSE client in < 500 ms (median; max < 2 s under load)', async () => {
  const sid = 'LAT1';
  const f = append(`p/${sid}.jsonl`, [userRec({ sid, pid: 'PL', human: true, content: 'warm up' })]);
  const c = await connect();
  await c.waitEv((e) => e.kind === 'prompt' && e.sessionId === sid);
  const lat = [];
  for (let i = 0; i < 25; i++) {
    const mark = `latency-probe-${i}`;
    const t0 = performance.now();
    fs.appendFileSync(f, toLines([asstRec({ sid, msg: 'mL' + i, content: [{ type: 'text', text: mark }], stop: 'tool_use' })]));
    const m = await c.waitEv((e) => e.kind === 'text' && e.text === mark, 2000);
    lat.push(m.at - t0);
    await sleep(40);
  }
  lat.sort((a, b) => a - b);
  const median = lat[lat.length >> 1];
  console.log(`# live latency (append -> client), ms: min ${lat[0].toFixed(1)}, median ${median.toFixed(1)}, p90 ${lat[Math.floor(lat.length * 0.9)].toFixed(1)}, max ${lat[lat.length - 1].toFixed(1)} (n=${lat.length}, fs.watch)`);
  assert.ok(median < 500, `median ${median}`);
  assert.ok(lat[lat.length - 1] < 2000, `max ${lat[lat.length - 1]}`);
});

test('events: prompt, text, thinking, tool_use summary, tool_result durationMs + isError, request, title', async () => {
  const sid = 'EV1';
  const c = await connect();
  const t = Date.now();
  const f = append(`p/${sid}.jsonl`, [
    userRec({ sid, pid: 'PE', human: true, t, content: '<system-reminder>x</system-reminder>Fix the flaky test please' }),
    asstRec({ sid, msg: 'mE1', t: t + 100, blk: 0, content: [{ type: 'thinking', thinking: '' }], stop: 'tool_use' }),
    asstRec({ sid, msg: 'mE1', t: t + 200, blk: 1, content: [{ type: 'text', text: 'Let me look.' }], stop: 'tool_use' }),
    asstRec({ sid, msg: 'mE1', t: t + 300, blk: 2, content: [{ type: 'tool_use', id: 'toolu_a', name: 'Bash', input: { command: 'npm test\n  --silent', description: 'x' } }], stop: 'tool_use' }),
    asstRec({ sid, msg: 'mE1', t: t + 301, blk: 3, content: [{ type: 'tool_use', id: 'toolu_b', name: 'Read', input: { file_path: 'C:\\proj\\a.js' } }], stop: 'tool_use' }),
  ]);
  const p = await c.waitEv((e) => e.kind === 'prompt' && e.sessionId === sid);
  assert.equal(p.data.text, 'Fix the flaky test please');
  assert.equal(p.data.promptId, 'PE');
  assert.equal(p.data.sidechain, false);
  assert.equal(p.data.agentId, null);
  assert.equal(p.data.project, '/home/dev/proj');
  assert.ok(p.id > 0 && p.id === p.data.id);
  const th = await c.waitEv((e) => e.kind === 'thinking' && e.sessionId === sid);
  assert.equal(th.data.text, undefined);
  assert.equal((await c.waitEv((e) => e.kind === 'text' && e.sessionId === sid)).data.text, 'Let me look.');
  const tu = await c.waitEv((e) => e.kind === 'tool_use' && e.toolUseId === 'toolu_a');
  assert.equal(tu.data.tool, 'Bash');
  assert.equal(tu.data.summary, 'npm test --silent');
  assert.equal((await c.waitEv((e) => e.kind === 'tool_use' && e.toolUseId === 'toolu_b')).data.summary, 'C:\\proj\\a.js');
  // request: emitted once the stop_reason line is in
  const rq = await c.waitEv((e) => e.kind === 'request' && e.sessionId === sid);
  assert.equal(rq.data.key, 'mE1:req_mE1');
  assert.equal(rq.data.stopReason, 'tool_use');
  assert.equal(rq.data.usagePartial, false);
  assert.equal(rq.data.input, 10);
  assert.equal(rq.data.cacheRead, 1000);
  assert.ok(rq.data.cost > 0);
  assert.equal(rq.data.model, 'claude-opus-5-5');

  fs.appendFileSync(f, toLines([
    resultRec({ sid, pid: 'PE', t: t + 1800, tool: 'toolu_a' }),
    resultRec({ sid, pid: 'PE', t: t + 2100, tool: 'toolu_b', error: true }),
    { type: 'ai-title', aiTitle: 'Flaky test hunt', sessionId: sid },
  ]));
  const ra = await c.waitEv((e) => e.kind === 'tool_result' && e.toolUseId === 'toolu_a');
  assert.equal(ra.data.durationMs, 1500);
  assert.equal(ra.data.isError, false);
  assert.equal(ra.data.tool, 'Bash');
  const rb = await c.waitEv((e) => e.kind === 'tool_result' && e.toolUseId === 'toolu_b');
  assert.equal(rb.data.isError, true);
  assert.equal(rb.data.durationMs, 1799);
  const ti = await c.waitEv((e) => e.kind === 'title' && e.sessionId === sid);
  assert.equal(ti.data.title, 'Flaky test hunt');
  // monotonic ids
  const ids = c.evs().map((m) => m.id);
  assert.deepEqual(ids, [...ids].sort((a, b) => a - b));
  assert.equal(new Set(ids).size, ids.length);
});

test('request: exactly one event for a multi-line message, even if more lines arrive later', async () => {
  const sid = 'RQ1';
  const c = await connect();
  const t = Date.now();
  const f = append(`p/${sid}.jsonl`, [
    userRec({ sid, pid: 'PR', human: true, t }),
    asstRec({ sid, msg: 'mR', t: t + 10, blk: 0, content: [{ type: 'thinking', thinking: '' }], stop: 'end_turn', out: 16 }),
    asstRec({ sid, msg: 'mR', t: t + 20, blk: 1, content: [{ type: 'text', text: 'one' }], stop: 'end_turn', out: 90 }),
    asstRec({ sid, msg: 'mR', t: t + 30, blk: 2, content: [{ type: 'text', text: 'two' }], stop: 'end_turn', out: 148 }),
  ]);
  const rq = await c.waitEv((e) => e.kind === 'request' && e.sessionId === sid);
  assert.equal(rq.data.output, 148); // the batch's final usage, not the first line's
  fs.appendFileSync(f, toLines([asstRec({ sid, msg: 'mR', t: t + 40, blk: 3, content: [{ type: 'text', text: 'three' }], stop: 'end_turn', out: 200 })]));
  await c.waitEv((e) => e.kind === 'text' && e.text === 'three');
  await sleep(300);
  assert.equal(c.evs((e) => e.kind === 'request' && e.sessionId === sid).length, 1);
  assert.equal(c.evs((e) => e.kind === 'turn_end' && e.sessionId === sid).length, 1);
  // re-reading the file (rewritten transcript) does not replay anything
  const before = c.evs().length;
  const text = fs.readFileSync(f, 'utf8');
  fs.writeFileSync(f, text);
  srv.scan();
  await sleep(300);
  assert.equal(c.evs().length, before);
});

test('request without stop_reason is finalised as a partial after a quiet period (once)', async () => {
  const sid = 'PART1';
  const c = await connect();
  const t = Date.now();
  append(`p/${sid}.jsonl`, [
    userRec({ sid, pid: 'PP', human: true, t }),
    asstRec({ sid, msg: 'mP', t: t + 10, content: [{ type: 'text', text: 'streaming' }], stop: null }),
  ]);
  await c.waitEv((e) => e.kind === 'text' && e.sessionId === sid);
  assert.equal(c.evs((e) => e.kind === 'request' && e.sessionId === sid).length, 0);
  const rq = await c.waitEv((e) => e.kind === 'request' && e.sessionId === sid, 7000);
  assert.equal(rq.data.usagePartial, true);
  assert.equal(rq.data.stopReason, null);
  assert.equal((await c.waitEv((e) => e.kind === 'turn_end' && e.sessionId === sid, 1000)).data.inferred, true);
});

test('phase machine: generating -> tool -> generating -> waiting_user, with currentTool and turn totals', async () => {
  const sid = 'PH1';
  const c = await connect();
  const t = Date.now();
  const f = append(`p/${sid}.jsonl`, [userRec({ sid, pid: 'PH', human: true, t, content: 'phase test prompt' })]);
  await c.waitEv((e) => e.kind === 'prompt' && e.sessionId === sid);
  let s = await sessionOf(sid);
  assert.equal(s.phase, 'generating');
  assert.equal(s.promptText, 'phase test prompt');
  assert.equal(s.currentTool, null);

  fs.appendFileSync(f, toLines([asstRec({ sid, msg: 'mH1', t: t + 100, content: [{ type: 'tool_use', id: 'toolu_h', name: 'Grep', input: { pattern: 'foo.*bar' } }], stop: 'tool_use' })]));
  await c.waitEv((e) => e.kind === 'request' && e.sessionId === sid);
  s = await sessionOf(sid);
  assert.equal(s.phase, 'tool');
  assert.equal(s.currentTool.tool, 'Grep');
  assert.equal(s.currentTool.summary, 'foo.*bar');
  assert.equal(s.agents[0].agentId, null);
  assert.equal(s.agents[0].phase, 'tool');
  assert.equal(s.turn.requests, 1);

  fs.appendFileSync(f, toLines([resultRec({ sid, pid: 'PH', t: t + 500, tool: 'toolu_h' })]));
  await c.waitEv((e) => e.kind === 'tool_result' && e.sessionId === sid);
  s = await sessionOf(sid);
  assert.equal(s.phase, 'generating');
  assert.equal(s.currentTool, null);

  fs.appendFileSync(f, toLines([asstRec({ sid, msg: 'mH2', t: t + 900, content: [{ type: 'text', text: 'all done' }], stop: 'end_turn' })]));
  await c.waitEv((e) => e.kind === 'turn_end' && e.sessionId === sid);
  s = await sessionOf(sid);
  assert.equal(s.phase, 'waiting_user');
  assert.equal(s.turn.requests, 2);
  assert.ok(s.turn.cost > 0 && s.turn.tokens > 2000 && s.turn.output === 40);
  assert.equal(s.context.limit, 1000000);
  assert.equal(s.context.tokens, 1010);
  assert.equal(s.model, 'claude-opus-5-5');
  assert.equal(s.recent.length, 7); // prompt, tool_use, request, tool_result, text, request, turn_end
});

test('phase machine: an interrupted turn ends as waiting_user', async () => {
  const sid = 'INT1';
  const c = await connect();
  const t = Date.now();
  const f = append(`p/${sid}.jsonl`, [userRec({ sid, pid: 'PI', human: true, t })]);
  await c.waitEv((e) => e.kind === 'prompt' && e.sessionId === sid);
  fs.appendFileSync(f, toLines([userRec({ sid, t: t + 50, content: [{ type: 'text', text: '[Request interrupted by user]' }] })]));
  const te = await c.waitEv((e) => e.kind === 'turn_end' && e.sessionId === sid);
  assert.equal(te.data.reason, 'interrupted');
  assert.equal((await sessionOf(sid)).phase, 'waiting_user');
});

test('subagents: subagent_start from the first record, agent attribution, subagent_end, session agents list', async () => {
  const sid = 'SUB1';
  const c = await connect();
  const t = Date.now();
  append(`p/${sid}.jsonl`, [
    userRec({ sid, pid: 'PS', human: true, t }),
    asstRec({ sid, msg: 'mS1', t: t + 50, content: [{ type: 'tool_use', id: 'toolu_agent', name: 'Agent', input: { description: 'Explore the scanner', subagent_type: 'Explore', prompt: 'long prompt text' } }], stop: 'tool_use' }),
  ]);
  const tu = await c.waitEv((e) => e.kind === 'tool_use' && e.toolUseId === 'toolu_agent');
  assert.equal(tu.data.tool, 'Agent');
  assert.equal(tu.data.summary, 'Explore the scanner');
  const dir = path.join(PROJECTS, 'p', sid, 'subagents');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'agent-abc123.meta.json'), JSON.stringify({ agentType: 'Explore', description: 'Explore the scanner', toolUseId: 'toolu_agent' }));
  const af = append(`p/${sid}/subagents/agent-abc123.jsonl`, [
    userRec({ sid, pid: 'PS', side: true, agentId: 'abc123', t: t + 100, content: 'Look at the scanner' }),
    asstRec({ sid, msg: 'mS2', side: true, agentId: 'abc123', t: t + 200, content: [{ type: 'tool_use', id: 'toolu_sub', name: 'Glob', input: { pattern: '**/*.js' } }], stop: 'tool_use' }),
  ]);
  const st = await c.waitEv((e) => e.kind === 'subagent_start' && e.sessionId === sid);
  assert.equal(st.data.agentId, 'abc123');
  assert.equal(st.data.agentType, 'Explore');
  assert.equal(st.data.desc, 'Explore the scanner');
  assert.equal(st.data.toolUseId, 'toolu_agent');
  assert.equal(st.data.sidechain, true);
  const stu = await c.waitEv((e) => e.kind === 'tool_use' && e.toolUseId === 'toolu_sub');
  assert.equal(stu.data.agentId, 'abc123');
  assert.equal(stu.data.agentType, 'Explore');
  assert.equal(stu.data.sidechain, true);
  assert.equal(c.evs((e) => e.kind === 'prompt' && e.sessionId === sid).length, 1); // a subagent's task message is not a prompt
  assert.equal(c.evs((e) => e.kind === 'subagent_start' && e.sessionId === sid).length, 1);
  let s = await sessionOf(sid);
  let sub = s.agents.find((a) => a.agentId === 'abc123');
  assert.ok(sub);
  assert.equal(sub.agentType, 'Explore');
  assert.equal(sub.phase, 'tool');
  assert.equal(sub.currentTool.tool, 'Glob');
  const main = s.agents.find((a) => a.agentId === null);
  assert.equal(main.currentTool.tool, 'Agent'); // the main agent waits on its Agent tool
  assert.equal(s.currentTool.tool, 'Agent');

  fs.appendFileSync(af, toLines([
    resultRec({ sid, pid: 'PS', side: true, agentId: 'abc123', t: t + 400, tool: 'toolu_sub' }),
    asstRec({ sid, msg: 'mS3', side: true, agentId: 'abc123', t: t + 600, content: [{ type: 'text', text: 'found it' }], stop: 'end_turn' }),
  ]));
  const end = await c.waitEv((e) => e.kind === 'subagent_end' && e.sessionId === sid);
  assert.equal(end.data.agentId, 'abc123');
  assert.equal(c.evs((e) => e.kind === 'turn_end' && e.sessionId === sid).length, 0); // the main agent has not finished
  s = await sessionOf(sid);
  sub = s.agents.find((a) => a.agentId === 'abc123');
  assert.equal(sub.phase, 'done');
  assert.equal(sub.requests, 2);
  assert.equal(s.turn.requests, 3); // subagent requests roll into the turn
  assert.equal(s.phase, 'tool');
});

test('no flood: old records at discovery emit nothing; 10-30 min old ones only fill the state', async () => {
  const c = await connect();
  const now = Date.now();
  const n0 = c.evs().length;
  const lines = [];
  for (let i = 0; i < 30; i++) lines.push(asstRec({ sid: 'OLD1', msg: 'mO' + i, t: now - 3 * 3600e3 + i * 1000, content: [{ type: 'text', text: 'old ' + i }], stop: 'end_turn' }));
  lines.unshift(userRec({ sid: 'OLD1', pid: 'PO', human: true, t: now - 3 * 3600e3 - 1000 }));
  const mid = [userRec({ sid: 'MID1', pid: 'PM', human: true, t: now - 20 * 60e3, content: 'twenty minutes ago' }),
    asstRec({ sid: 'MID1', msg: 'mM1', t: now - 20 * 60e3 + 500, content: [{ type: 'text', text: 'hi' }], stop: 'end_turn' })];
  fs.mkdirSync(path.join(PROJECTS, 'q'), { recursive: true });
  fs.writeFileSync(path.join(PROJECTS, 'q', 'OLD1.jsonl'), toLines(lines));
  fs.writeFileSync(path.join(PROJECTS, 'q', 'MID1.jsonl'), toLines(mid));
  srv.scan();
  await sleep(300);
  assert.equal(c.evs().length, n0, 'no events for old history');
  assert.equal(await sessionOf('OLD1'), undefined);
  const mid1 = await sessionOf('MID1');
  assert.ok(mid1, 'a 20 min old session is in the state');
  assert.equal(mid1.promptText, 'twenty minutes ago');
  assert.equal(mid1.phase, 'idle'); // no events for 10 min
  assert.equal(mid1.recent.length, 4); // prompt, text, request, turn_end (silent)
  const snap = await (await connect()).waitFor((m) => m.event === 'snapshot');
  assert.ok(snap.data.sessions.some((s) => s.sessionId === 'MID1'));
  assert.ok(!snap.data.sessions.some((s) => s.sessionId === 'OLD1'));
});

test('Last-Event-ID: missed events are replayed (then a fresh snapshot); unknown ids just get the snapshot', async () => {
  const sid = 'RES1';
  const c1 = await connect();
  const t = Date.now();
  const f = append(`p/${sid}.jsonl`, [userRec({ sid, pid: 'PRS', human: true, t })]);
  await c1.waitEv((e) => e.kind === 'prompt' && e.sessionId === sid);
  const lastSeen = c1.evs().slice(-1)[0].id;
  c1.close();
  fs.appendFileSync(f, toLines([
    asstRec({ sid, msg: 'mRS', t: t + 10, content: [{ type: 'text', text: 'while you were away' }], stop: 'end_turn' }),
  ]));
  await sleep(250);
  const c2 = await connect({ headers: { 'Last-Event-ID': String(lastSeen) } });
  const snap = await c2.waitFor((m) => m.event === 'snapshot');
  const replayed = c2.msgs.slice(0, c2.msgs.indexOf(snap)).filter((m) => m.event === 'ev');
  assert.equal(replayed.length, 3, 'text, request, turn_end replayed');
  assert.ok(replayed.every((m) => m.id > lastSeen));
  assert.ok(replayed.some((m) => m.data.kind === 'text' && m.data.text === 'while you were away'));
  assert.ok(!replayed.some((m) => m.data.kind === 'prompt' && m.data.sessionId === sid), 'already delivered events are not replayed');
  assert.ok(snap.id >= replayed[replayed.length - 1].id);
  // an id from a previous server run (or garbage) must not replay anything
  for (const bad of ['5', 'abc', String(Number.MAX_SAFE_INTEGER)]) {
    const c3 = await connect({ headers: { 'Last-Event-ID': bad } });
    await c3.waitFor((m) => m.event === 'snapshot');
    assert.equal(c3.evs().length, 0, 'Last-Event-ID ' + bad);
  }
  // current id: nothing to replay
  const c4 = await connect({ headers: { 'Last-Event-ID': String(snap.id) } });
  await c4.waitFor((m) => m.event === 'snapshot');
  assert.equal(c4.evs().length, 0);
});

test('state events: re-sync pushed at most once a second, and only when something changed', async () => {
  const sid = 'ST1';
  const c = await connect();
  await c.waitFor((m) => m.event === 'snapshot');
  await sleep(1300);
  assert.equal(c.msgs.filter((m) => m.event === 'state').length, 0, 'nothing changed -> no state event');
  const t = Date.now();
  const f = append(`p/${sid}.jsonl`, [userRec({ sid, pid: 'PST', human: true, t, content: 'state probe' })]);
  const st = await c.waitFor((m) => m.event === 'state' && m.data.sessions.some((s) => s.sessionId === sid), 3000);
  assert.equal(st.data.sessions.find((s) => s.sessionId === sid).promptText, 'state probe');
  for (let i = 0; i < 6; i++) { fs.appendFileSync(f, toLines([asstRec({ sid, msg: 'mST' + i, t: t + i, content: [{ type: 'text', text: 'x' + i }], stop: 'tool_use' })])); await sleep(100); }
  await sleep(1200);
  const states = c.msgs.filter((m) => m.event === 'state');
  for (let i = 1; i < states.length; i++) assert.ok(states[i].at - states[i - 1].at >= 900, 'state spacing ' + (states[i].at - states[i - 1].at));
});

test('Live endpoints: /api/live/state shape and /api/live unchanged', async () => {
  const r = await getJson('/api/live/state');
  assert.equal(r.status, 200);
  assert.equal(r.headers['cache-control'], 'no-store');
  const j = r.json();
  assert.ok(j.sessions.length > 0);
  const s = j.sessions[0];
  for (const k of ['sessionId', 'title', 'project', 'model', 'entrypoint', 'startedTs', 'lastTs', 'phase', 'phaseSince', 'currentTool', 'promptText', 'promptTs', 'context', 'agents', 'turn', 'recent']) assert.ok(k in s, k);
  assert.ok(s.recent.length <= 40);
  for (const k of ['requests', 'cost', 'tokens', 'output']) assert.ok(k in j.today, k);
  for (const k of ['tokensPerMin', 'costPerMin', 'requestsPerMin']) assert.ok(k in j.rate, k);
  assert.ok(j.today.requests > 0 && j.rate.requestsPerMin > 0);
  assert.ok(j.sessions.every((x, i, a) => i === 0 || a[i - 1].lastTs >= x.lastTs));
  const old = (await getJson('/api/live')).json();
  assert.deepEqual(Object.keys(old).sort(), ['active', 'lastTs', 'lastWriteTs', 'now', 'recent']);
});

test('tool summaries: per-tool rules, whitespace collapsed, capped at 160', async () => {
  const sid = 'SUM1';
  const c = await connect();
  const t = Date.now();
  const tools = [
    ['WebSearch', { query: 'node fs.watch recursive' }, 'node fs.watch recursive'],
    ['WebFetch', { url: 'https://example.com/a' }, 'https://example.com/a'],
    ['Edit', { file_path: '/a/b.js', old_string: 'x', new_string: 'y' }, '/a/b.js'],
    ['mcp__thing__go', { n: 1, what: 'first string wins' }, 'first string wins'],
    ['Bash', { command: 'x'.repeat(400) }, 'x'.repeat(159) + '…'],
  ];
  append(`p/${sid}.jsonl`, [
    userRec({ sid, pid: 'PSU', human: true, t }),
    ...tools.map(([name, input], i) => asstRec({ sid, msg: 'mSU' + i, t: t + 10 + i, content: [{ type: 'tool_use', id: 'toolu_su' + i, name, input }], stop: 'tool_use' })),
  ]);
  for (let i = 0; i < tools.length; i++) {
    const e = await c.waitEv((x) => x.kind === 'tool_use' && x.toolUseId === 'toolu_su' + i);
    assert.equal(e.data.summary, tools[i][2], tools[i][0]);
  }
});

// ---------------------------------------------------------------- child processes

function freePort() {
  return new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
}

test('timers are unref()ed: a started server that is unref()ed lets the process exit (watcher and timers must not hold the loop)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccu-unref-'));
  fs.mkdirSync(path.join(dir, 'claude', 'projects', 'p'), { recursive: true });
  const code = `
    const http = require('http');
    const srv = require(${JSON.stringify(path.join(__dirname, '..', 'server.js'))});
    srv.start(0).then((s) => {
      const port = s.address().port;
      http.get({ host: '127.0.0.1', port, path: '/api/stream' }, (res) => {
        res.once('data', () => { console.log('connected'); res.destroy(); s.unref(); });
      });
    });`;
  const t0 = Date.now();
  const out = await new Promise((resolve) => {
    const ch = spawn(process.execPath, ['-e', code], { env: { ...process.env, CLAUDE_CONFIG_DIR: path.join(dir, 'claude'), CCU_DATA_DIR: path.join(dir, 'data') } });
    let stdout = '';
    ch.stdout.on('data', (d) => { stdout += d; });
    const kill = setTimeout(() => { ch.kill(); resolve({ stdout, exited: false }); }, 8000);
    ch.on('exit', () => { clearTimeout(kill); resolve({ stdout, exited: true }); });
  });
  fs.rmSync(dir, { recursive: true, force: true });
  assert.match(out.stdout, /connected/);
  assert.ok(out.exited, 'process must exit by itself');
  assert.ok(Date.now() - t0 < 7000);
});

test('polling fallback (CCU_LIVE_POLL=1): events still flow, within the 500 ms poll interval', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccu-poll-'));
  const proj = path.join(dir, 'claude', 'projects', 'p');
  fs.mkdirSync(proj, { recursive: true });
  const f = path.join(proj, 'POLL1.jsonl');
  fs.writeFileSync(f, toLines([userRec({ sid: 'POLL1', pid: 'PPO', human: true })]));
  const p = await freePort();
  const ch = spawn(process.execPath, [path.join(__dirname, '..', 'server.js'), '--port', String(p)], {
    env: { ...process.env, CLAUDE_CONFIG_DIR: path.join(dir, 'claude'), CCU_DATA_DIR: path.join(dir, 'data'), CCU_START_DATE: '2026-01-01', CCU_LIVE_POLL: '1' },
    stdio: 'ignore',
  });
  try {
    let c;
    for (let i = 0; i < 50 && !c; i++) { try { c = await connect({ port: p }); } catch { await sleep(100); } }
    assert.ok(c, 'server up');
    await c.waitFor((m) => m.event === 'snapshot');
    await sleep(2500); // let the poller discover the file and the periodic scan pass
    const lat = [];
    for (let i = 0; i < 5; i++) {
      const mark = 'poll-probe-' + i;
      const t0 = performance.now();
      fs.appendFileSync(f, toLines([asstRec({ sid: 'POLL1', msg: 'mPO' + i, content: [{ type: 'text', text: mark }], stop: 'tool_use' })]));
      lat.push((await c.waitEv((e) => e.kind === 'text' && e.text === mark, 3000)).at - t0);
      await sleep(100);
    }
    lat.sort((a, b) => a - b);
    console.log(`# polling-mode latency, ms: min ${lat[0].toFixed(1)}, median ${lat[2].toFixed(1)}, max ${lat[4].toFixed(1)}`);
    assert.ok(lat[4] < 2500);
  } finally {
    ch.kill();
    await sleep(100);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- subagent lifecycle (background subagents never send end_turn)

const noteText = (id, status) => `<task-notification>\n<task-id>${id}</task-id>\n<tool-use-id>toolu_x</tool-use-id>\n<status>${status}</status>\n<summary>Agent "demo" finished</summary>\n</task-notification>`;
const queueRec = (o) => ({ type: 'queue-operation', operation: o.op || 'enqueue', timestamp: iso(o.t), sessionId: o.sid, content: noteText(o.id, o.status) });
const attachRec = (o) => ({ ...base(o), type: 'attachment', attachment: { type: 'queued_command', prompt: noteText(o.id, o.status) } });
const handbackUse = (o) => asstRec({ ...o, content: [{ type: 'tool_use', id: 'toolu_hb_' + o.agentId, name: o.name || 'SubagentHandback', input: { summary: 'done' } }], stop: null });
const handbackResult = (o) => resultRec({ ...o, tool: 'toolu_hb_' + o.agentId });

let msgSeq = 0;
const nextMsg = () => 'mLC' + (++msgSeq);

function subFile(sid, id) { return `p/${sid}/subagents/agent-${id}.jsonl`; }
function subMeta(sid, id, desc) {
  const dir = path.join(PROJECTS, 'p', sid, 'subagents');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `agent-${id}.meta.json`), JSON.stringify({ agentType: 'general-purpose', description: desc || 'bg ' + id, toolUseId: 'toolu_' + id, requestShape: 'background', model: 'sonnet' }));
}
// the first records of a background subagent: task message, a tool call and its result
function subStart(sid, id, t) {
  const o = { sid, pid: 'P' + sid, side: true, agentId: id };
  return [
    userRec({ ...o, t, content: 'task for ' + id }),
    asstRec({ ...o, msg: nextMsg(), t: t + 50, content: [{ type: 'tool_use', id: 'toolu_w_' + id, name: 'Glob', input: { pattern: '**/*.js' } }], stop: null }),
    resultRec({ ...o, t: t + 100, tool: 'toolu_w_' + id }),
  ];
}
const subOf = (s, id) => s.agents.find((a) => a.agentId === id);
async function waitState(pred, ms = 4000) {
  const t0 = Date.now();
  for (;;) {
    const st = await liveState();
    if (pred(st)) return st;
    if (Date.now() - t0 > ms) throw new Error('state never matched: ' + JSON.stringify(st.sessions.map((s) => [s.sessionId, s.phase, s.agents.map((a) => a.phase + ':' + (a.endStatus || ''))])));
    await sleep(40);
  }
}

test('subagent end: SubagentHandback (any case), task-notification (queue-operation or queued_command; completed/killed/failed), end_turn - exactly one subagent_end each', async () => {
  const sid = 'END1';
  const c = await connect();
  const t = Date.now() - 20000;
  const main = append(`p/${sid}.jsonl`, [userRec({ sid, pid: 'P' + sid, human: true, t, content: 'spawn the team' })]);
  const ids = ['hb1', 'hb2', 'nk', 'nf', 'nc', 'hbn', 'et'];
  for (const id of ids) { subMeta(sid, id); append(subFile(sid, id), subStart(sid, id, t + 1000)); }
  const o = (id) => ({ sid, pid: 'P' + sid, side: true, agentId: id });
  append(subFile(sid, 'hb1'), [handbackUse({ ...o('hb1'), msg: nextMsg(), t: t + 3000 }), handbackResult({ ...o('hb1'), t: t + 3100 })]);
  append(subFile(sid, 'hb2'), [handbackUse({ ...o('hb2'), msg: nextMsg(), t: t + 3000, name: 'mcp__x__subagent_hand_back' }), handbackResult({ ...o('hb2'), t: t + 3100 })]);
  append(subFile(sid, 'hbn'), [handbackUse({ ...o('hbn'), msg: nextMsg(), t: t + 3000 }), handbackResult({ ...o('hbn'), t: t + 3100 })]);
  append(subFile(sid, 'et'), [asstRec({ ...o('et'), msg: nextMsg(), t: t + 3000, content: [{ type: 'text', text: 'all done' }], stop: 'end_turn' })]);
  await c.waitEv((e) => e.kind === 'subagent_end' && e.agentId === 'et');
  await c.waitEv((e) => e.kind === 'subagent_end' && e.agentId === 'hbn');
  // the parent session reports the rest (the same notification shows up as enqueue, queued_command and a later remove)
  fs.appendFileSync(main, toLines([
    queueRec({ sid, id: 'nk', status: 'killed', t: t + 4000 }),
    attachRec({ sid, id: 'nk', status: 'killed', t: t + 4000 }),
    queueRec({ sid, id: 'nk', status: 'killed', op: 'remove', t: t + 4100 }),
    attachRec({ sid, id: 'nf', status: 'failed', t: t + 4000 }),
    queueRec({ sid, id: 'nc', status: 'completed', t: t + 4000 }),
    queueRec({ sid, id: 'hbn', status: 'completed', t: t + 3300 }), // after its hand-back: only the status improves
    queueRec({ sid, id: 'bash123', status: 'completed', t: t + 4000 }), // a background shell, not an agent
    queueRec({ sid, id: 'nc2', status: 'running', t: t + 4000 }), // not an ending
  ]));
  await c.waitEv((e) => e.kind === 'subagent_end' && e.agentId === 'nc');
  await c.waitEv((e) => e.kind === 'subagent_end' && e.agentId === 'nf');
  const st = await waitState((x) => {
    const s = x.sessions.find((q) => q.sessionId === sid);
    return s && ids.every((id) => subOf(s, id) && subOf(s, id).phase === 'done') && subOf(s, 'hbn').endStatus === 'completed';
  });
  const s = st.sessions.find((q) => q.sessionId === sid);
  const want = { hb1: 'handback', hb2: 'handback', nk: 'killed', nf: 'failed', nc: 'completed', hbn: 'completed', et: 'end_turn' };
  for (const id of ids) {
    assert.equal(subOf(s, id).endStatus, want[id], id);
    assert.ok(subOf(s, id).endedTs > 0, id);
    assert.ok(!subOf(s, id).stale, id);
    assert.equal(c.evs((e) => e.kind === 'subagent_end' && e.agentId === id).length, 1, 'one subagent_end for ' + id);
  }
  assert.equal(subOf(s, 'hb1').endedTs, t + 3000, 'done at the SubagentHandback call, not at its tool_result');
  assert.equal(c.evs((e) => e.kind === 'subagent_end' && e.agentId === 'hb1')[0].data.endStatus, 'handback');
  assert.ok(!s.agents.some((a) => a.agentId === 'bash123' || a.agentId === 'nc2'));
  assert.equal(s.phase, 'generating'); // the main agent has not finished; only the agents ended
});

test('subagent end: a resumed agent comes back; the tail of its transcript right after the hand-back does not revive it', async () => {
  const sid = 'REV1';
  const c = await connect();
  const T0 = Date.now() - 60000;
  const o = { sid, pid: 'P' + sid, side: true, agentId: 'rv' };
  append(`p/${sid}.jsonl`, [userRec({ sid, pid: 'P' + sid, human: true, t: T0 - 1000 })]);
  subMeta(sid, 'rv', 'resumable');
  const f = append(subFile(sid, 'rv'), [...subStart(sid, 'rv', T0), handbackUse({ ...o, msg: nextMsg(), t: T0 + 1000 }), handbackResult({ ...o, t: T0 + 1100 })]);
  await c.waitEv((e) => e.kind === 'subagent_end' && e.agentId === 'rv');
  fs.appendFileSync(f, toLines([asstRec({ ...o, msg: nextMsg(), t: T0 + 3000, content: [{ type: 'text', text: 'trailing words' }], stop: null })])); // inside the 5 s grace
  await c.waitEv((e) => e.kind === 'text' && e.agentId === 'rv' && e.text === 'trailing words');
  let a = subOf(await sessionOf(sid), 'rv');
  assert.equal(a.phase, 'done');
  assert.equal(a.endStatus, 'handback');
  // resumed later (SendMessage): new work revives it, the old ending is forgotten
  fs.appendFileSync(f, toLines([asstRec({ ...o, msg: nextMsg(), t: T0 + 20000, content: [{ type: 'tool_use', id: 'toolu_again', name: 'Read', input: { file_path: '/x/y.js' } }], stop: null })]));
  await c.waitEv((e) => e.kind === 'tool_use' && e.toolUseId === 'toolu_again');
  a = subOf(await sessionOf(sid), 'rv');
  assert.equal(a.phase, 'tool');
  assert.equal(a.endStatus, undefined);
  assert.equal(a.endedTs, undefined);
  fs.appendFileSync(f, toLines([handbackUse({ ...o, msg: nextMsg(), t: T0 + 25000 }), handbackResult({ ...o, t: T0 + 25100 })]));
  await c.waitEv((e) => e.kind === 'subagent_end' && e.agentId === 'rv' && e.ts === T0 + 25000);
  a = subOf(await sessionOf(sid), 'rv');
  assert.equal(a.phase, 'done');
  assert.equal(a.endedTs, T0 + 25000);
  assert.equal(c.evs((e) => e.kind === 'subagent_end' && e.agentId === 'rv').length, 2);
});

test('staleness: generating > 180 s and tool > 15 min go idle (stale); a quiet subagent that never ended becomes done/unknown; any new event revives', async () => {
  const sid = 'STALE1';
  const c = await connect();
  const now = Date.now();
  const ago = (ms) => now - ms;
  append(`p/${sid}.jsonl`, [userRec({ sid, pid: 'P' + sid, human: true, t: ago(1500), content: 'stale test' }), asstRec({ sid, msg: nextMsg(), t: ago(1000), content: [{ type: 'text', text: 'still here' }], stop: null })]);
  const make = (id, t, content) => {
    subMeta(sid, id, 'agent ' + id);
    const o = { sid, pid: 'P' + sid, side: true, agentId: id };
    return append(subFile(sid, id), [userRec({ ...o, t: t - 500, content: 'go' }), asstRec({ ...o, msg: nextMsg(), t, content, stop: null })]);
  };
  const text = [{ type: 'text', text: 'working' }];
  const bash = (n) => [{ type: 'tool_use', id: 'toolu_s_' + n, name: 'Bash', input: { command: 'sleep 9999' } }];
  const fg200 = make('g200', ago(200e3), text);
  make('g100', ago(100e3), text);
  const ft16 = make('t16', ago(16 * 60e3), bash('t16'));
  make('t14', ago(14 * 60e3), bash('t14'));
  const fx14 = make('x14', ago(14 * 60e3), text);
  make('x12', ago(12 * 60e3), text);
  await waitState((x) => { const s = x.sessions.find((q) => q.sessionId === sid); return s && s.agents.length === 7; });
  let s = await sessionOf(sid);
  const A = (id) => subOf(s, id);
  assert.equal(A('g100').phase, 'generating');
  assert.ok(!A('g100').stale);
  assert.equal(A('g200').phase, 'idle');
  assert.equal(A('g200').stale, true);
  assert.equal(A('g200').currentTool, null);
  assert.equal(A('g200').phaseSince, A('g200').lastTs);
  assert.equal(A('t14').phase, 'tool');
  assert.equal(A('t14').currentTool.tool, 'Bash');
  assert.equal(A('t16').phase, 'idle');
  assert.equal(A('t16').stale, true);
  assert.equal(A('x12').phase, 'idle'); // 12 min quiet: stale, but not yet given up on
  assert.equal(A('x12').stale, true);
  assert.equal(A('x14').phase, 'done');
  assert.equal(A('x14').endStatus, 'unknown');
  assert.equal(A('x14').endedTs, A('x14').lastTs);
  assert.ok(!A('x14').stale);
  assert.equal(s.phase, 'generating'); // the main agent is fresh
  // revival: an event for any of them brings it back
  const o = (id) => ({ sid, pid: 'P' + sid, side: true, agentId: id });
  fs.appendFileSync(fg200, toLines([asstRec({ ...o('g200'), msg: nextMsg(), content: text, stop: null })]));
  fs.appendFileSync(ft16, toLines([resultRec({ ...o('t16'), tool: 'toolu_s_t16' })]));
  fs.appendFileSync(fx14, toLines([asstRec({ ...o('x14'), msg: nextMsg(), content: bash('x14'), stop: null })]));
  s = (await waitState((x) => {
    const q = x.sessions.find((r) => r.sessionId === sid);
    return q && subOf(q, 'g200').phase === 'generating' && subOf(q, 't16').phase === 'generating' && subOf(q, 'x14').phase === 'tool';
  })).sessions.find((q) => q.sessionId === sid);
  for (const id of ['g200', 't16', 'x14']) { assert.ok(!subOf(s, id).stale, id); assert.equal(subOf(s, id).endStatus, undefined, id); }
  assert.equal(c.evs((e) => e.kind === 'subagent_end' && e.sessionId === sid).length, 0, 'derived endings emit no events');
});

test('staleness: the main agent too (generating > 180 s; tool > 15 min while a subagent keeps the session alive)', async () => {
  const now = Date.now();
  append('p/STALE2.jsonl', [userRec({ sid: 'STALE2', pid: 'PS2', human: true, t: now - 250e3 }), asstRec({ sid: 'STALE2', msg: nextMsg(), t: now - 200e3, content: [{ type: 'text', text: 'thinking out loud' }], stop: null })]);
  append('p/STALE3.jsonl', [
    userRec({ sid: 'STALE3', pid: 'PS3', human: true, t: now - 17 * 60e3 }),
    asstRec({ sid: 'STALE3', msg: nextMsg(), t: now - 16 * 60e3, content: [{ type: 'tool_use', id: 'toolu_m3', name: 'Bash', input: { command: 'npm test' } }], stop: 'tool_use' }),
  ]);
  subMeta('STALE3', 'live1', 'still working');
  append(subFile('STALE3', 'live1'), [
    userRec({ sid: 'STALE3', pid: 'PS3', side: true, agentId: 'live1', t: now - 40e3, content: 'go' }),
    asstRec({ sid: 'STALE3', msg: nextMsg(), side: true, agentId: 'live1', t: now - 30e3, content: [{ type: 'text', text: 'on it' }], stop: null }),
  ]);
  const st = await waitState((x) => x.sessions.some((s) => s.sessionId === 'STALE2') && x.sessions.some((s) => s.sessionId === 'STALE3' && s.agents.length === 2));
  const s2 = st.sessions.find((s) => s.sessionId === 'STALE2');
  assert.equal(s2.phase, 'idle');
  assert.equal(s2.stale, true);
  assert.equal(s2.agents[0].phase, 'idle');
  assert.equal(s2.agents[0].stale, true);
  const s3 = st.sessions.find((s) => s.sessionId === 'STALE3');
  const m3 = s3.agents.find((a) => a.agentId === null);
  assert.equal(m3.phase, 'idle');
  assert.equal(m3.stale, true);
  assert.equal(m3.currentTool, null);
  assert.equal(s3.phase, 'generating'); // the live subagent keeps the session going
  assert.equal(s3.currentTool, null);
  assert.equal(subOf(s3, 'live1').phase, 'generating');
});

// 25 background subagents finishing in random order with mixed endings
function rng(seed) { return () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

test('25 concurrent background subagents finish in random order with mixed endings: every one ends exactly once with the right status', async () => {
  const seed = Number(process.env.LIVE_SEED) || 20260101;
  const rnd = rng(seed);
  const shuffle = (arr) => { for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; } return arr; };
  const sid = 'BURST25';
  const c = await connect();
  const t = Date.now() - 60000;
  const kinds = shuffle([...Array(8).fill('handback'), ...Array(6).fill('handback+completed'), ...Array(4).fill('killed'), ...Array(3).fill('failed'), ...Array(2).fill('completed'), ...Array(2).fill('end_turn')]);
  assert.equal(kinds.length, 25);
  const agents = kinds.map((kind, i) => ({ id: 'bg' + String(i).padStart(2, '0'), kind, end: t + 5000 + Math.floor(rnd() * 30000) }));
  const want = { handback: 'handback', 'handback+completed': 'completed', killed: 'killed', failed: 'failed', completed: 'completed', end_turn: 'end_turn' };
  const main = append(`p/${sid}.jsonl`, [
    userRec({ sid, pid: 'P' + sid, human: true, t, content: 'run the burst' }),
    asstRec({ sid, msg: nextMsg(), t: t + 100, content: [{ type: 'text', text: 'spawned 25 agents in the background' }], stop: 'end_turn' }),
  ]);
  const statusOf = (a) => (a.kind === 'handback+completed' ? 'completed' : a.kind);
  const notes = (a) => [queueRec({ sid, id: a.id, status: statusOf(a), t: a.end + 100 }), attachRec({ sid, id: a.id, status: statusOf(a), t: a.end + 100 })];
  const noteOnly = agents.filter((a) => a.kind === 'killed' || a.kind === 'failed' || a.kind === 'completed');
  const early = noteOnly.slice(0, 3); // reported by the parent BEFORE their own transcript exists
  fs.appendFileSync(main, toLines(early.flatMap(notes)));
  const steps = [];
  for (const a of agents) {
    const o = { sid, pid: 'P' + sid, side: true, agentId: a.id };
    const tail = [];
    if (a.kind.startsWith('handback')) tail.push(handbackUse({ ...o, msg: nextMsg(), t: a.end }), handbackResult({ ...o, t: a.end + 50 }));
    else if (a.kind === 'end_turn') tail.push(asstRec({ ...o, msg: nextMsg(), t: a.end, content: [{ type: 'text', text: 'finished' }], stop: 'end_turn' }));
    else tail.push(asstRec({ ...o, msg: nextMsg(), t: a.end - 100, content: [{ type: 'text', text: 'working until the end' }], stop: null }));
    steps.push(() => { subMeta(sid, a.id, 'burst ' + a.id); append(subFile(sid, a.id), [...subStart(sid, a.id, t + 1000 + Math.floor(rnd() * 500)), ...tail]); });
    if (!early.includes(a) && a.kind !== 'handback' && a.kind !== 'end_turn') steps.push(() => fs.appendFileSync(main, toLines(notes(a))));
  }
  for (const fn of shuffle(steps)) { fn(); if (rnd() < 0.3) await sleep(15); }
  const st = await waitState((x) => { const s = x.sessions.find((q) => q.sessionId === sid); return s && s.agents.filter((a) => a.phase === 'done').length === 25; }, 8000);
  const s = st.sessions.find((q) => q.sessionId === sid);
  assert.equal(s.agents.length, 26);
  await sleep(100);
  for (const a of agents) {
    const v = subOf(s, a.id);
    assert.ok(v, a.id);
    assert.equal(v.phase, 'done', `${a.id} ${a.kind} (seed ${seed})`);
    assert.equal(v.endStatus, want[a.kind], `${a.id} ${a.kind} (seed ${seed})`);
    assert.equal(c.evs((e) => e.kind === 'subagent_end' && e.agentId === a.id).length, 1, `${a.id} subagent_end count (seed ${seed})`);
  }
  assert.equal(s.agents.filter((a) => a.phase === 'generating' || a.phase === 'tool').length, 0);
  assert.equal(s.phase, 'waiting_user'); // the main agent's own end_turn
});

// startup: transcripts that already exist when the server starts

async function runServer(dataDir, fn) {
  const p = await freePort();
  const ch = spawn(process.execPath, [path.join(__dirname, '..', 'server.js'), '--port', String(p)], {
    env: { ...process.env, CLAUDE_CONFIG_DIR: CLAUDE, CCU_DATA_DIR: dataDir, CCU_START_DATE: '2026-01-01' }, stdio: 'ignore',
  });
  try {
    let st = null;
    for (let i = 0; i < 100 && !st; i++) {
      try {
        const r = await new Promise((resolve, reject) => {
          http.get({ host: '127.0.0.1', port: p, path: '/api/live/state' }, (res) => { let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => resolve(JSON.parse(b))); }).on('error', reject);
        });
        if (r.sessions.some((s) => s.sessionId === 'BOOT1')) st = r;
      } catch { /* not up yet */ }
      if (!st) await sleep(100);
    }
    return fn(st);
  } finally {
    ch.kill();
    await sleep(100);
  }
}

test('startup replay: subagents that already finished load as done (persisted store and fresh data dir), running ones stay active', async () => {
  const sid = 'BOOT1';
  const now = Date.now();
  const o = (id) => ({ sid, pid: 'P' + sid, side: true, agentId: id });
  const main = append(`p/${sid}.jsonl`, [userRec({ sid, pid: 'P' + sid, human: true, t: now - 300e3, content: 'boot test' }), asstRec({ sid, msg: nextMsg(), t: now - 250e3, content: [{ type: 'text', text: 'spawning' }], stop: null })]);
  for (const id of ['bh', 'bk', 'bn', 'br', 'bs']) subMeta(sid, id, 'boot ' + id);
  append(subFile(sid, 'bh'), [...subStart(sid, 'bh', now - 240e3), handbackUse({ ...o('bh'), msg: nextMsg(), t: now - 200e3 }), handbackResult({ ...o('bh'), t: now - 199e3 })]);
  append(subFile(sid, 'bk'), [...subStart(sid, 'bk', now - 240e3), asstRec({ ...o('bk'), msg: nextMsg(), t: now - 150e3, content: [{ type: 'text', text: 'interrupted' }], stop: null })]);
  append(subFile(sid, 'bn'), [...subStart(sid, 'bn', now - 240e3), handbackUse({ ...o('bn'), msg: nextMsg(), t: now - 120e3 }), handbackResult({ ...o('bn'), t: now - 119e3 })]);
  append(subFile(sid, 'br'), [...subStart(sid, 'br', now - 60e3), asstRec({ ...o('br'), msg: nextMsg(), t: now - 5e3, content: [{ type: 'tool_use', id: 'toolu_br', name: 'Bash', input: { command: 'npm run build' } }], stop: null })]);
  append(subFile(sid, 'bs'), [...subStart(sid, 'bs', now - 15 * 60e3), asstRec({ ...o('bs'), msg: nextMsg(), t: now - 14 * 60e3, content: [{ type: 'text', text: 'went quiet' }], stop: null })]);
  fs.appendFileSync(main, toLines([
    queueRec({ sid, id: 'bk', status: 'killed', t: now - 149e3 }), attachRec({ sid, id: 'bk', status: 'killed', t: now - 149e3 }),
    queueRec({ sid, id: 'bh', status: 'completed', t: now - 199e3 }), queueRec({ sid, id: 'bn', status: 'completed', t: now - 118e3 }),
  ]));
  srv.scan();
  srv.saveStore(true); // a store from an "earlier run": every file already read to its end
  const check = (st) => {
    assert.ok(st, 'server reported the session');
    const s = st.sessions.find((q) => q.sessionId === sid);
    const e = (id) => `${id}=${subOf(s, id).phase}:${subOf(s, id).endStatus || ''}`;
    assert.equal(subOf(s, 'bh').phase, 'done', e('bh'));
    assert.equal(subOf(s, 'bh').endStatus, 'completed');
    assert.equal(subOf(s, 'bk').phase, 'done', e('bk'));
    assert.equal(subOf(s, 'bk').endStatus, 'killed');
    assert.equal(subOf(s, 'bn').phase, 'done', e('bn'));
    assert.equal(subOf(s, 'bn').endStatus, 'completed');
    assert.equal(subOf(s, 'br').phase, 'tool');
    assert.equal(subOf(s, 'br').currentTool.tool, 'Bash');
    assert.equal(subOf(s, 'bs').phase, 'done'); // quiet for 14 min, never ended
    assert.equal(subOf(s, 'bs').endStatus, 'unknown');
    assert.equal(subOf(s, 'bh').desc, 'boot bh');
    assert.equal(s.agents.filter((a) => a.phase === 'generating').length, 0);
    assert.equal(s.phase, 'generating'); // 'br' is working
  };
  await runServer(path.join(TMP, 'data'), check); // persisted store: the scanner skips these files, the live view is rebuilt anyway
  await runServer(path.join(TMP, 'data-fresh'), check); // nothing stored: everything is read
});

test('current turn keeps the human prompt when an injected turn (task-notification) arrives; agents carry startedTs', async () => {
  const sid = 'INJ1';
  const t = Date.now() - 15000;
  const main = append(`p/${sid}.jsonl`, [userRec({ sid, pid: 'P' + sid, human: true, t, content: 'audit the orders module' })]);
  subMeta(sid, 'sa1', 'Check pagination');
  append(subFile(sid, 'sa1'), subStart(sid, 'sa1', t + 1000));
  await waitState((st) => { const s = st.sessions.find((x) => x.sessionId === sid); return s && subOf(s, 'sa1'); });
  fs.appendFileSync(main, toLines([
    { ...userRec({ sid, pid: 'Q' + sid, t: t + 5000, content: noteText('sa1', 'completed') }), origin: { kind: 'task-notification' } },
  ]));
  const st = await waitState((x) => { const s = x.sessions.find((y) => y.sessionId === sid); return s && subOf(s, 'sa1') && subOf(s, 'sa1').phase === 'done'; });
  const s = st.sessions.find((x) => x.sessionId === sid);
  assert.equal(s.promptText, 'audit the orders module');
  const a = subOf(s, 'sa1');
  assert.equal(typeof a.startedTs, 'number');
  assert.ok(a.startedTs <= a.endedTs, 'startedTs before endedTs');
  assert.ok(Math.abs(a.startedTs - (t + 1000)) < 2000, 'startedTs is the first subagent record');
});
