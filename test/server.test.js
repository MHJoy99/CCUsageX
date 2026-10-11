'use strict';
// Run with: node --test test
// Uses synthetic transcripts in a temp dir; never touches ~/.claude or the real data/store.json.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ccu-test-'));
const CLAUDE = path.join(TMP, 'claude');
const PROJECTS = path.join(CLAUDE, 'projects');
process.env.CLAUDE_CONFIG_DIR = CLAUDE;
process.env.CCU_DATA_DIR = path.join(TMP, 'data');
process.env.CCU_START_DATE = '2026-01-01';
const srv = require('../server.js');

const T0 = Date.parse('2026-03-10T08:00:00Z');
const iso = (ms) => new Date(T0 + ms).toISOString();
let seq = 0;
const uid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} !~ ${b}`);

// ---------------------------------------------------------------- fixtures

function user(o) {
  const content = o.content !== undefined ? o.content : 'hello';
  return {
    parentUuid: o.parent || null, isSidechain: !!o.side, promptId: o.pid, type: 'user',
    message: { role: 'user', content }, uuid: o.uuid || uid(), timestamp: iso(o.t),
    cwd: o.cwd || 'C:\\proj\\a', sessionId: o.sid || 'S1', version: '2.1.0', entrypoint: 'cli',
    ...(o.human === false ? {} : o.human ? { origin: { kind: 'human' } } : {}),
    ...(o.extra || {}),
  };
}
function toolResult(o) {
  return user({ ...o, content: [{ type: 'tool_result', tool_use_id: 'toolu_x', content: 'ok' }], human: false });
}
function asst(o) {
  const usage = {
    input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...(o.usage || {}),
  };
  return {
    parentUuid: o.parent || null, isSidechain: !!o.side, type: 'assistant',
    message: { model: o.model || 'claude-opus-5-5', id: o.msg, role: 'assistant', content: o.content || [{ type: 'text', text: 'ok' }], stop_reason: o.stop || null, usage },
    requestId: o.req === undefined ? 'req_' + o.msg : o.req, apiBlockIndex: o.blk === undefined ? 0 : o.blk,
    uuid: o.uuid || uid(), timestamp: iso(o.t), cwd: o.cwd || 'C:\\proj\\a', sessionId: o.sid || 'S1',
    version: '2.1.0', entrypoint: 'cli', effort: o.effort || 'high', ...(o.extra || {}),
  };
}
function write(rel, lines, opts = {}) {
  const file = path.join(PROJECTS, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const text = lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + (opts.noNewline ? '' : '\n');
  fs.writeFileSync(file, text);
  return file;
}
function fresh() {
  fs.rmSync(PROJECTS, { recursive: true, force: true });
  fs.mkdirSync(PROJECTS, { recursive: true });
  fs.rmSync(process.env.CCU_DATA_DIR, { recursive: true, force: true });
  srv.resetState();
}
const reqs = () => [...srv._state.reqMap.values()].sort((a, b) => a.ts - b.ts);
const reqBy = (msg) => srv._state.reqMap.get(`${msg}:req_${msg}`);
const prompts = () => srv._state.store.prompts;

let server;
let port;
const get = (p, headers) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path: p, headers }, (res) => {
    let b = '';
    res.on('data', (d) => { b += d; });
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: b, json: () => JSON.parse(b) }));
  }).on('error', reject);
});
const api = async (p) => (await get(p)).json();

test.before(async () => { server = await srv.start(0); port = server.address().port; });
test.after(() => { server.close(); fs.rmSync(TMP, { recursive: true, force: true }); });

// ---------------------------------------------------------------- cost math

test('cost: Opus 5.5 input/output/cache read, 5m write = 1.25x input, 1h write = 2x input', () => {
  const c = srv.computeCost({ model: 'claude-opus-5-5', speed: 'standard', input: 1000, output: 2000, cacheRead: 10000, cacheWrite5m: 3000, cacheWrite1h: 4000 });
  near(c.input, 1000 * 4 / 1e6);
  near(c.output, 2000 * 20 / 1e6);
  near(c.cacheRead, 10000 * 0.2 / 1e6);
  near(c.cacheWrite, (3000 * 4 * 1.25 + 4000 * 4 * 2) / 1e6);
  near(c.total, 0.093);
});

test('cost: fast mode is 2x on every part', () => {
  const base = { model: 'claude-opus-5-5', input: 1000, output: 2000, cacheRead: 10000, cacheWrite5m: 3000, cacheWrite1h: 4000 };
  near(srv.computeCost({ ...base, speed: 'fast' }).total, 0.186);
  // models without a fast multiplier are unaffected
  const s = { model: 'claude-sonnet-5-5', input: 1000, output: 1000, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };
  near(srv.computeCost({ ...s, speed: 'fast' }).total, srv.computeCost({ ...s, speed: 'standard' }).total);
});

test('cost: Haiku 5.5 switches to the long-context tier above 100K prompt tokens', () => {
  const short = srv.computeCost({ model: 'claude-haiku-5-5', speed: 'standard', input: 1000, output: 1000, cacheRead: 1000, cacheWrite5m: 0, cacheWrite1h: 0 });
  near(short.total, (1000 * 0.1 + 1000 * 0.5 + 1000 * 0.01) / 1e6);
  const long = srv.computeCost({ model: 'claude-haiku-5-5', speed: 'standard', input: 60000, output: 1000, cacheRead: 50000, cacheWrite5m: 0, cacheWrite1h: 0 });
  near(long.total, (60000 * 0.5 + 1000 * 2.5 + 50000 * 0.05) / 1e6);
  // exactly 100K is still the base tier
  const edge = srv.computeCost({ model: 'claude-haiku-5-5', speed: 'standard', input: 100000, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 });
  near(edge.total, 100000 * 0.1 / 1e6);
});

test('cost: model id matching - suffixes ok, other versions are unpriced, not mispriced', () => {
  assert.ok(srv.priceFor('claude-opus-5-5[1m]'));
  assert.equal(srv.priceFor('claude-opus-5-5[1m]'), srv.priceFor('claude-opus-5-5'));
  assert.equal(srv.priceFor('claude-haiku-5-5-20261001'), srv.priceFor('claude-haiku-5-5'));
  assert.equal(srv.priceFor('claude-opus-5-6'), null); // must not fall back to claude-opus-5 prices
  assert.equal(srv.priceFor('constructor'), null);
  assert.equal(srv.priceFor('<synthetic>'), null);
});

// ---------------------------------------------------------------- parsing

test('dedupe: one line per content block, usage repeats, output grows -> one request with the max', () => {
  fresh();
  const u = uid();
  write('p/S1.jsonl', [
    user({ pid: 'P1', t: 0, uuid: u, human: true }),
    asst({ msg: 'm1', t: 1000, parent: u, blk: 0, content: [{ type: 'thinking', thinking: '' }], usage: { output_tokens: 16, cache_creation_input_tokens: 500, cache_creation: { ephemeral_5m_input_tokens: 500, ephemeral_1h_input_tokens: 0 } } }),
    asst({ msg: 'm1', t: 2000, blk: 1, content: [{ type: 'text', text: 'hello there' }], usage: { output_tokens: 100, cache_creation_input_tokens: 500, cache_creation: { ephemeral_5m_input_tokens: 500, ephemeral_1h_input_tokens: 0 } } }),
    asst({ msg: 'm1', t: 3000, blk: 2, content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }], stop: 'tool_use', usage: { output_tokens: 148, cache_creation_input_tokens: 500, cache_creation: { ephemeral_5m_input_tokens: 500, ephemeral_1h_input_tokens: 0 } } }),
  ]);
  srv.scan();
  assert.equal(reqs().length, 1);
  const r = reqBy('m1');
  assert.equal(r.output, 148);
  assert.equal(r.input, 10);
  assert.equal(r.cacheWrite5m, 500);
  assert.deepEqual(r.tools, ['Bash']);
  assert.equal(r.response, 'hello there');
  assert.equal(r.stopReason, 'tool_use');
  assert.equal(r.latencyMs, 3000 - 0); // parent is the user line at t=0 -> whole response time, not first block
  // the same request replayed in another transcript (resumed/forked session) is not counted twice
  write('p/S1-fork.jsonl', [asst({ msg: 'm1', t: 1000, blk: 0, sid: 'S9', content: [{ type: 'thinking', thinking: '' }], usage: { output_tokens: 16 } })]);
  srv.scan();
  assert.equal(reqs().length, 1);
  assert.equal(srv.summary(new URLSearchParams()).totals.requests, 1);
});

test('dedupe: same message id with different requestId are different requests', () => {
  fresh();
  write('p/S1.jsonl', [
    asst({ msg: 'm1', req: 'rA', t: 0 }),
    asst({ msg: 'm1', req: 'rB', t: 10 }),
  ]);
  srv.scan();
  assert.equal(reqs().length, 2);
});

test('<synthetic> model, zero-timestamp-less and pre-start records are ignored', () => {
  fresh();
  write('p/S1.jsonl', [
    asst({ msg: 'syn', model: '<synthetic>', t: 0 }),
    { type: 'assistant', message: { model: 'claude-opus-5-5', id: 'nots', usage: { input_tokens: 1, output_tokens: 1 } }, sessionId: 'S1' },
    asst({ msg: 'old', t: -90 * 864e5 }), // before 2026-01-01
    asst({ msg: 'ok', t: 5 }),
    'not json at all',
    '{"type":"assistant","message":',
  ]);
  srv.scan();
  assert.deepEqual(reqs().map((r) => r.key), ['ok:req_ok']);
});

test('partial last line is retried; a complete last line without newline is used', () => {
  fresh();
  const l1 = JSON.stringify(asst({ msg: 'a', t: 0 }));
  const l2 = JSON.stringify(asst({ msg: 'b', t: 10 }));
  const file = path.join(PROJECTS, 'p', 'S1.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, l1 + '\n' + l2.slice(0, 40));
  srv.scan();
  assert.deepEqual(reqs().map((r) => r.key), ['a:req_a']);
  fs.appendFileSync(file, l2.slice(40));
  srv.scan(); // line is now complete JSON but has no newline yet
  assert.equal(reqs().length, 2);
  fs.appendFileSync(file, '\n' + JSON.stringify(asst({ msg: 'c', t: 20 })) + '\n');
  srv.scan();
  assert.equal(reqs().length, 3);
  assert.equal(srv._state.reqMap.get('b:req_b').output, 20); // b was not double counted
});

test('truncated or rewritten transcript is re-read without double counting', () => {
  fresh();
  const u = uid();
  const lines = [
    user({ pid: 'P1', t: 0, uuid: u, human: true }),
    asst({ msg: 'm1', t: 1000, parent: u, content: [{ type: 'tool_use', id: 't', name: 'Read', input: {} }] }),
    asst({ msg: 'm2', t: 2000, content: [{ type: 'tool_use', id: 't2', name: 'Edit', input: {} }] }),
  ];
  const file = write('p/S1.jsonl', lines);
  srv.scan();
  assert.equal(reqs().length, 2);
  // rewrite: same length would be undetectable by size, so the head fingerprint must catch the change
  const rewritten = lines.map((l) => JSON.stringify(l).replace('"hello"', '"HELLO"'));
  fs.writeFileSync(file, rewritten.join('\n') + '\n' + JSON.stringify(asst({ msg: 'm3', t: 3000 })) + '\n');
  srv.scan();
  assert.equal(reqs().length, 3);
  assert.deepEqual(reqBy('m1').tools, ['Read']);
  assert.deepEqual(reqBy('m2').tools, ['Edit']);
  // truncate below the stored offset
  fs.writeFileSync(file, JSON.stringify(asst({ msg: 'm1', t: 1000, content: [{ type: 'tool_use', id: 't', name: 'Read', input: {} }] })) + '\n');
  srv.scan();
  assert.equal(reqs().length, 3);
  assert.deepEqual(reqBy('m1').tools, ['Read']);
});

test('files whose mtime is before the start date are not tracked', () => {
  fresh();
  const file = write('p/old.jsonl', [asst({ msg: 'x', t: 0 })]);
  const old = new Date('2025-06-01T00:00:00Z');
  fs.utimesSync(file, old, old);
  srv.scan();
  assert.equal(reqs().length, 0);
  assert.equal(Object.keys(srv._state.store.files).length, 0);
});

// ---------------------------------------------------------------- prompt attribution

function attributionFixture() {
  fresh();
  const u1 = uid(); const a1 = uid(); const tr1 = uid(); const a2 = uid(); const peer = uid(); const a3 = uid();
  const u2 = uid(); const a4 = uid(); const comp = uid(); const a5 = uid(); const intr = uid(); const a6 = uid();
  write('proj/S1.jsonl', [
    { type: 'ai-title', sessionId: 'S1', aiTitle: 'Fixture session' },
    user({ pid: 'P1', t: 0, uuid: u1, human: true, content: [{ type: 'text', text: 'first prompt <system-reminder>noise</system-reminder>' }, { type: 'image', source: {} }] }),
    asst({ msg: 'm1', t: 1000, uuid: a1, parent: u1, content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }], usage: { output_tokens: 50 } }),
    toolResult({ pid: 'P1', t: 2000, uuid: tr1, parent: a1 }),
    asst({ msg: 'm2', t: 4000, uuid: a2, parent: tr1, usage: { output_tokens: 70 } }),
    { type: 'attachment', parentUuid: a2, isSidechain: false, uuid: uid(), timestamp: iso(4500), sessionId: 'S1', cwd: 'C:\\proj\\a', attachment: { type: 'queued_command', prompt: [{ type: 'text', text: 'also do Y' }], commandMode: 'prompt', origin: { kind: 'human' } } },
    user({ pid: 'P1', t: 4600, parent: a2, content: '[Image: source: x.png]', human: false, extra: { isMeta: true } }),
    // harness-injected turn (subagent hand-back): not a prompt the user typed
    user({ pid: 'PSYS', t: 6000, uuid: peer, parent: a2, content: '[Subagent hand-back] report', human: false, extra: { isMeta: true, origin: { kind: 'peer' }, promptSource: 'system' } }),
    asst({ msg: 'm3', t: 7000, uuid: a3, parent: peer, usage: { output_tokens: 30 } }),
    user({ pid: 'P2', t: 100000, uuid: u2, human: true, content: 'second prompt', cwd: 'c:\\proj\\a\\sub' }),
    asst({ msg: 'm4', t: 101000, uuid: a4, parent: u2, model: 'claude-sonnet-5-5', effort: 'low', cwd: 'c:\\proj\\a\\sub' }),
    user({ pid: 'PCOMPACT', t: 102000, uuid: comp, parent: a4, content: 'This session is being continued from a previous conversation ...', human: false, extra: { isCompactSummary: true } }),
    asst({ msg: 'm5', t: 103000, uuid: a5, parent: comp }),
    user({ pid: 'PINT', t: 104000, uuid: intr, parent: a5, content: [{ type: 'text', text: '[Request interrupted by user]' }], human: false }),
    asst({ msg: 'm6', t: 105000, uuid: a6, parent: intr }),
  ]);
  // subagent spawned by P1; its later records are stamped with the parent thread's *current* promptId
  const s1 = uid(); const sa1 = uid(); const st1 = uid(); const sa2 = uid(); const resend = uid(); const sa3 = uid();
  write('proj/S1/subagents/agent-abc.jsonl', [
    user({ pid: 'P1', t: 1500, uuid: s1, side: true, content: 'You are agent A', human: false, extra: { agentId: 'abc' } }),
    asst({ msg: 's1', t: 2500, uuid: sa1, parent: s1, side: true, model: 'claude-sonnet-5-5', extra: { agentId: 'abc' } }),
    toolResult({ pid: 'P2', t: 120000, uuid: st1, parent: sa1, side: true, extra: { agentId: 'abc' } }),
    asst({ msg: 's2', t: 121000, uuid: sa2, parent: st1, side: true, model: 'claude-sonnet-5-5', extra: { agentId: 'abc' } }),
    user({ pid: 'P2', t: 130000, uuid: resend, parent: sa2, side: true, content: 'continue please', human: false, extra: { agentId: 'abc' } }),
    asst({ msg: 's3', t: 131000, uuid: sa3, parent: resend, side: true, model: 'claude-sonnet-5-5', extra: { agentId: 'abc' } }),
  ]);
  fs.writeFileSync(path.join(PROJECTS, 'proj/S1/subagents/agent-abc.meta.json'), JSON.stringify({ agentType: 'general-purpose', description: 'A: build thing' }));
  // headless prompt (no origin, promptSource sdk) in another session/project
  write('proj2/S2.jsonl', [
    user({ pid: 'PSDK', t: 200000, sid: 'S2', cwd: 'D:/other/', content: 'headless question', human: false, extra: { promptSource: 'sdk' } }),
    asst({ msg: 'm7', t: 201000, sid: 'S2', cwd: 'D:/other/', model: 'claude-haiku-5-5', parent: null, usage: { input_tokens: 1000, output_tokens: 1000, cache_read_input_tokens: 1000 } }),
  ]);
  // a prompt typed before the start date whose turn continues afterwards (and an orphan request)
  write('proj3/S3.jsonl', [
    user({ pid: 'PPRE', t: -80 * 864e5, sid: 'S3', cwd: 'E:\\x', human: true, content: 'old prompt' }),
    asst({ msg: 'm8', t: 300000, sid: 'S3', cwd: 'E:\\x', parent: null }),
  ]);
  srv.scan();
}

test('attribution: tool_results share the prompt, prompt text is cleaned, images counted', () => {
  attributionFixture();
  const p1 = prompts().P1;
  assert.equal(p1.text, 'first prompt');
  assert.equal(p1.images, 1);
  assert.equal(p1.origin, 'human');
  assert.equal(reqBy('m1').promptId, 'P1');
  assert.equal(reqBy('m2').promptId, 'P1');
  assert.equal(reqBy('m4').promptId, 'P2');
});

test('attribution: queued mid-turn message is attached to the running prompt, not a new prompt', () => {
  attributionFixture();
  assert.deepEqual(prompts().P1.queued, ['also do Y']);
  assert.equal(Object.values(prompts()).filter((p) => p.origin === 'human').length, 3); // P1, P2, PPRE
});

test('attribution: harness-injected turns roll up into the latest human prompt and are flagged', () => {
  attributionFixture();
  assert.equal(reqBy('m3').promptId, 'P1');
  assert.equal(reqBy('m3').sys, 'peer');
  const row = srv._state.reqMap.get('m3:req_m3');
  assert.ok(row);
  assert.equal(Object.values(prompts()).filter((p) => p.origin === 'peer').length, 1);
  assert.equal(srv._state.byPrompt.get('PSYS'), undefined);
});

test('attribution: compaction summaries and interrupt markers are not prompts and do not take over', () => {
  attributionFixture();
  assert.equal(prompts().PCOMPACT, undefined);
  assert.equal(prompts().PINT, undefined);
  assert.equal(reqBy('m5').promptId, 'P2');
  assert.equal(reqBy('m6').promptId, 'P2');
});

test('attribution: subagent requests belong to the spawning prompt, with agent info; later stamps are ignored', () => {
  attributionFixture();
  assert.equal(reqBy('s1').promptId, 'P1');
  assert.equal(reqBy('s1').sidechain, true);
  assert.equal(reqBy('s1').agentType, 'general-purpose');
  assert.equal(reqBy('s1').agentDesc, 'A: build thing');
  assert.equal(reqBy('s1').agentId, 'abc');
  assert.equal(reqBy('s2').promptId, 'P1'); // tool_result stamped P2 must not move it
  assert.equal(reqBy('s3').promptId, 'P2'); // an explicit restart message under P2 does
});

test('attribution: a headless SDK turn (promptSource sdk, no origin) is not a human prompt; pre-start prompt is kept when its turn runs past the start', () => {
  attributionFixture();
  assert.equal(prompts().PSDK.origin, 'sdk');
  assert.equal(reqBy('m7').promptId, null); // no human prompt in that session to roll into -> no synthetic prompt
  assert.equal(reqBy('m7').sys, 'sdk');
  assert.equal(prompts().PPRE.text, 'old prompt');
  assert.equal(reqBy('m8').promptId, 'PPRE');
});

test('attribution: a request with no prompt link joins the latest earlier human prompt of its session', () => {
  fresh();
  write('p/S1.jsonl', [user({ pid: 'PA', t: 0, human: true, content: 'ask' })]);
  write('p/S1/subagents/agent-z.jsonl', [asst({ msg: 'z1', t: 1000, side: true, parent: null })]); // no user record, no promptId
  srv.scan();
  assert.equal(reqBy('z1').promptId, 'PA');
});

test('project paths: drive-letter case, slashes and cd into a subfolder do not split a project', () => {
  attributionFixture();
  const projects = [...new Set(reqs().map((r) => r.project))].sort();
  assert.deepEqual(projects, ['C:\\proj\\a', 'D:/other', 'E:\\x']);
  assert.equal(reqBy('m4').project, 'C:\\proj\\a'); // session started in C:\proj\a, later records say c:\proj\a\sub
});

test('session title comes from ai-title', () => {
  attributionFixture();
  assert.equal(srv._state.store.sessions.S1.title, 'Fixture session');
});

test('latency = last block time - time of the record the request answers', () => {
  attributionFixture();
  assert.equal(reqBy('m2').latencyMs, 2000); // tool_result at 2000, answered at 4000
});

// ---------------------------------------------------------------- API

test('API: status, options, summary totals add up', async () => {
  attributionFixture();
  const st = await api('/api/status');
  assert.equal(st.requests, 11);
  assert.equal(st.prompts, 3);
  assert.equal(typeof st.tz, 'string');
  assert.equal(st.tzOffsetMin, (0 - new Date().getTimezoneOffset()) || 0); // JSON turns -0 into 0
  const opt = await api('/api/options');
  assert.deepEqual(opt.models, ['claude-haiku-5-5', 'claude-opus-5-5', 'claude-sonnet-5-5']);
  assert.equal(opt.projects.length, 3);
  assert.ok(opt.sessions.find((s) => s.id === 'S1' && s.title === 'Fixture session'));
  const sum = await api('/api/summary');
  assert.equal(sum.totals.requests, 11);
  assert.equal(sum.prompts, 3);
  assert.equal(sum.sessions, 3);
  assert.equal(sum.byModel.reduce((a, m) => a + m.requests, 0), 11);
  assert.equal(sum.byKind.find((k) => k.name === 'Subagent').requests, 3);
  near(sum.totals.cost, sum.byModel.reduce((a, m) => a + m.cost, 0), 1e-12);
  assert.equal(sum.trend.points.reduce((a, p) => a + p.requests, 0), 11);
  assert.ok(sum.tools.find((t) => t.name === 'Bash'));
  assert.ok(sum.latency && sum.latency.p50 > 0);
});

test('API: filters model / project / session / kind / prompt / q / time range', async () => {
  attributionFixture();
  const n = async (qs) => (await api('/api/requests?size=200&' + qs)).total;
  assert.equal(await n('model=claude-sonnet-5-5'), 4); // m4 + s1,s2,s3
  assert.equal(await n('model=claude-haiku-5-5'), 1);
  assert.equal(await n('project=' + encodeURIComponent('C:\\proj\\a')), 9);
  assert.equal(await n('session=S2'), 1);
  assert.equal(await n('kind=subagent'), 3);
  assert.equal(await n('kind=main'), 8);
  assert.equal(await n('prompt=P1'), 5); // m1 m2 m3(rolled up) s1 s2
  assert.equal(await n('prompt=P2'), 4); // m4 m5 m6 s3
  assert.equal(await n('q=' + encodeURIComponent('SECOND PROMPT')), 4); // matches prompt text, case-insensitive (m4 m5 m6 s3)
  assert.equal(await n('q=Bash'), 1); // matches tool name
  assert.equal(await n('q=zzzz-nothing'), 0);
  assert.equal(await n(`from=${T0 + 100000}&to=${T0 + 110000}`), 3); // m4 m5 m6 (+ none else)
  assert.equal(await n(`from=${T0 + 100000}&to=${T0 + 100000 - 1}`), 0);
  const combo = await api(`/api/requests?size=200&model=claude-sonnet-5-5&kind=subagent&prompt=P1`);
  assert.equal(combo.total, 2);
  const s = await api('/api/summary?model=claude-haiku-5-5');
  assert.equal(s.totals.requests, 1);
  near(s.totals.cost, (1000 * 0.1 + 1000 * 0.5 + 1000 * 0.01) / 1e6);
});

test('API: requests sorting, paging, dir', async () => {
  attributionFixture();
  const byTime = await api('/api/requests?size=5');
  assert.equal(byTime.total, 11);
  assert.equal(byTime.rows.length, 5);
  assert.ok(byTime.rows.every((r, i, a) => i === 0 || a[i - 1].ts >= r.ts));
  assert.equal(byTime.rows[0].key, 'm8:req_m8');
  const asc = await api('/api/requests?size=5&dir=asc');
  assert.ok(asc.rows.every((r, i, a) => i === 0 || a[i - 1].ts <= r.ts));
  const page3 = await api('/api/requests?size=5&page=3');
  assert.equal(page3.rows.length, 1);
  const byCost = await api('/api/requests?size=200&sort=cost');
  assert.ok(byCost.rows.every((r, i, a) => i === 0 || (a[i - 1].cost || 0) >= (r.cost || 0)));
  const byTok = await api('/api/requests?size=200&sort=tokens');
  assert.ok(byTok.rows.every((r, i, a) => i === 0 || a[i - 1].tokens >= r.tokens));
  for (const f of ['key', 'ts', 'model', 'effort', 'sidechain', 'project', 'sessionId', 'promptId', 'prompt', 'input', 'output', 'cacheRead', 'cacheWrite', 'thinking', 'tokens', 'cost', 'latencyMs', 'tools', 'stopReason', 'speed']) {
    assert.ok(f in byTime.rows[0], 'row field ' + f);
  }
});

test('API: prompts list rolls subagent + injected-turn cost into the prompt; no synthetic prompt rows', async () => {
  attributionFixture();
  const pr = await api('/api/prompts?size=50');
  assert.deepEqual(pr.rows.map((r) => r.id).sort(), ['P1', 'P2', 'PPRE']);
  const p1 = pr.rows.find((r) => r.id === 'P1');
  assert.equal(p1.requests, 5);
  assert.equal(p1.subagentRequests, 2);
  assert.equal(p1.text, 'first prompt');
  assert.equal(p1.images, 1);
  assert.ok(p1.durationMs > 0);
  const asc = await api('/api/prompts?size=50&dir=asc');
  assert.ok(asc.rows[0].ts <= asc.rows[asc.rows.length - 1].ts);
  const byCost = await api('/api/prompts?sort=cost');
  assert.ok(byCost.rows.every((r, i, a) => i === 0 || a[i - 1].cost >= r.cost));
  const d = await api('/api/prompt?id=P1');
  assert.equal(d.prompt.id, 'P1');
  assert.deepEqual(d.prompt.queued, ['also do Y']);
  assert.equal(d.requests.length, 5);
  assert.ok(d.requests.every((r, i, a) => i === 0 || a[i - 1].ts <= r.ts));
  assert.equal(d.sessionTitle, 'Fixture session');
  near(d.totals.cost, d.requests.reduce((a, r) => a + r.cost, 0), 1e-12);
  assert.equal((await get('/api/prompt?id=nope')).status, 404);
});

test('API: request detail has cost breakdown and metadata', async () => {
  fresh();
  write('p/S1.jsonl', [
    user({ pid: 'P1', t: 0, human: true, content: 'price me' }),
    asst({ msg: 'm1', t: 10, model: 'claude-opus-5-5[1m]', usage: { input_tokens: 1000, output_tokens: 2000, cache_read_input_tokens: 10000, cache_creation_input_tokens: 7000, cache_creation: { ephemeral_5m_input_tokens: 3000, ephemeral_1h_input_tokens: 4000 } }, content: [{ type: 'text', text: 'the answer' }] }),
  ]);
  srv.scan();
  const d = await api('/api/request?key=' + encodeURIComponent('m1:req_m1'));
  near(d.cost.total, 0.093);
  assert.deepEqual(Object.keys(d.cost).sort(), ['cacheRead', 'cacheWrite', 'input', 'output', 'total']);
  assert.equal(d.cacheWrite5m, 3000);
  assert.equal(d.cacheWrite1h, 4000);
  assert.equal(d.promptText, 'price me');
  assert.equal(d.response, 'the answer');
  assert.equal(d.version, '2.1.0');
  assert.equal(d.entrypoint, 'cli');
  assert.equal(d.sessionTitle, null);
  assert.equal((await get('/api/request?key=missing')).status, 404);
});

test('API: unknown model is returned unpriced, cost null, not counted as $0 silently', async () => {
  fresh();
  write('p/S1.jsonl', [asst({ msg: 'm1', t: 0, model: 'claude-opus-5-6' })]);
  srv.scan();
  const rows = await api('/api/requests');
  assert.equal(rows.rows[0].cost, null);
  assert.equal((await api('/api/summary')).totals.unpriced, 1);
});

test('API: sessions list', async () => {
  attributionFixture();
  const s = await api('/api/sessions');
  assert.equal(s.length, 3);
  const s1 = s.find((x) => x.id === 'S1');
  assert.equal(s1.title, 'Fixture session');
  assert.equal(s1.requests, 9);
  assert.equal(s1.prompts, 2);
  assert.equal(s1.project, 'C:\\proj\\a');
  assert.ok(s1.first <= s1.last);
});

test('API: CSV export has header, escaping and formula-injection guard', async () => {
  fresh();
  write('p/S1.jsonl', [
    user({ pid: 'P1', t: 0, human: true, content: '=HYPERLINK("http://x","click"), "quoted"\nnewline' }),
    asst({ msg: 'm1', t: 10 }),
  ]);
  srv.scan();
  const r = await get('/api/export.csv');
  assert.match(r.headers['content-type'], /text\/csv/);
  assert.match(r.headers['content-disposition'], /claude-code-usage-\d{4}-\d{2}-\d{2}\.csv/);
  const text = r.text.replace(/^\uFEFF/, '');
  assert.ok(text.startsWith('time,session,project,model,effort,type,input,output'));
  assert.ok(text.includes(`"'=HYPERLINK(""http://x"",""click""), ""quoted""\nnewline"`));
  assert.equal(text.split('\r\n').length, 2);
});

test('API: trend buckets use local time (hour/day) and sum to the totals', async () => {
  fresh();
  const base = new Date(2026, 2, 10, 23, 30, 0).getTime(); // local 23:30
  const mk = (id, ms) => ({ ...asst({ msg: id, t: 0 }), timestamp: new Date(base + ms).toISOString() });
  write('p/S1.jsonl', [mk('a', 0), mk('b', 20 * 60e3), mk('c', 70 * 60e3), mk('d', 26 * 3600e3)]);
  srv.scan();
  const hour = await api(`/api/summary?from=${base - 3600e3}&to=${base + 30 * 3600e3}&gran=hour`);
  assert.equal(hour.trend.gran, 'hour');
  for (const p of hour.trend.points) assert.equal(new Date(p.t).getMinutes(), 0);
  assert.equal(hour.trend.points[0].t, new Date(2026, 2, 10, 23, 0, 0).getTime());
  assert.equal(hour.trend.points[0].requests, 2); // a, b in 23:00 local
  assert.equal(hour.trend.points[1].requests, 1); // c at 00:40 local next day
  assert.equal(hour.trend.points.reduce((a, p) => a + p.requests, 0), 4);
  const day = await api(`/api/summary?from=${base - 3600e3}&to=${base + 30 * 3600e3}&gran=day`);
  assert.equal(day.trend.points[0].t, new Date(2026, 2, 10).getTime());
  assert.equal(day.trend.points[0].requests, 2);
  assert.equal(day.trend.points[1].t, new Date(2026, 2, 11).getTime());
  assert.equal(day.trend.points[1].requests, 1); // c
  assert.equal(day.trend.points[2].t, new Date(2026, 2, 12).getTime());
  assert.equal(day.trend.points[2].requests, 1); // d
});

test('API: /api/live', async () => {
  fresh();
  let l = await api('/api/live');
  assert.equal(l.active, false);
  assert.equal(l.lastTs, null);
  assert.deepEqual(l.recent, []);
  const now = Date.now();
  const rec = (id, ago) => ({ ...asst({ msg: id, t: 0 }), timestamp: new Date(now - ago).toISOString() });
  const lines = [];
  for (let i = 0; i < 12; i++) lines.push(rec('r' + i, (12 - i) * 1000 + 500));
  write('p/S1.jsonl', lines);
  srv.scan();
  l = await api('/api/live');
  assert.equal(l.active, true);
  assert.equal(l.recent.length, 10);
  assert.equal(l.recent[0].key, 'r11:req_r11');
  assert.ok(l.recent.every((r, i, a) => i === 0 || a[i - 1].ts >= r.ts));
  assert.ok(Math.abs(l.lastTs - (now - 1500)) < 5);
  fresh();
  write('p/S1.jsonl', [rec('old', 10 * 60e3)]);
  srv.scan();
  l = await api('/api/live');
  assert.equal(l.active, false);
  assert.equal(l.recent.length, 1);
});

test('HTTP: static files, traversal, bad host, bad method, unknown api', async () => {
  const idx = await get('/');
  assert.ok([200, 404].includes(idx.status)); // public/ is owned by another agent
  assert.equal((await get('/..%5Cserver.js')).status, 404);
  assert.equal((await get('/%2e%2e/config.json')).status, 404);
  assert.equal((await get('/api/status', { Host: 'evil.example.com' })).status, 403);
  assert.equal((await get('/api/status', { Host: `localhost:${port}` })).status, 200);
  assert.equal((await get('/api/nothing')).status, 404);
  const post = await new Promise((resolve) => {
    const rq = http.request({ host: '127.0.0.1', port, path: '/api/status', method: 'POST' }, (res) => { res.resume(); resolve(res.statusCode); });
    rq.end();
  });
  assert.equal(post, 405);
});

// ---------------------------------------------------------------- persistence + scale

test('store: save -> reload gives identical data and resumes without re-reading', async () => {
  attributionFixture();
  const before = await api('/api/summary');
  const beforeP = await api('/api/prompts?size=50');
  srv.saveStore(true);
  assert.ok(fs.existsSync(srv._state.STORE_FILE));
  const size = fs.statSync(srv._state.STORE_FILE).size;
  srv.resetState();
  srv.loadStore();
  assert.deepEqual(await api('/api/summary'), before);
  assert.deepEqual(await api('/api/prompts?size=50'), beforeP);
  srv.scan(); // offsets were persisted: nothing is read twice
  assert.deepEqual(await api('/api/summary'), before);
  // appending after reload still links to the right prompt through the persisted parent window
  const last = reqs().find((r) => r.key === 'm6:req_m6');
  const file = path.join(PROJECTS, 'proj/S1.jsonl');
  fs.appendFileSync(file, JSON.stringify(asst({ msg: 'm9', t: 106000, parent: null })) + '\n');
  srv.scan();
  assert.equal(reqBy('m9').promptId, 'P2');
  assert.ok(last && size > 0);
});

test('store: corrupt store file is set aside and rebuilt from the transcripts', async () => {
  attributionFixture();
  srv.saveStore(true);
  fs.writeFileSync(srv._state.STORE_FILE, '{"version":2,"files":');
  srv.resetState();
  srv.loadStore();
  srv.scan();
  assert.equal((await api('/api/summary')).totals.requests, 11);
  assert.ok(fs.existsSync(srv._state.STORE_FILE + '.corrupt'));
});

test('scale: 200k requests - summary/list/prompts stay fast, no spread RangeError, compact store', async () => {
  fresh();
  const fstate = srv.newFstate();
  const N = 200000;
  const t0 = Date.now();
  for (let i = 0; i < N; i++) {
    const pid = 'P' + Math.floor(i / 20);
    if (i % 20 === 0) srv.handleLine(JSON.stringify(user({ pid, t: i * 60000, human: true, content: 'prompt ' + pid })), fstate, 'x/S1.jsonl');
    srv.handleLine(JSON.stringify(asst({ msg: 'm' + i, t: i * 60000 + 5, usage: { input_tokens: 5, output_tokens: 100 + (i % 50), cache_read_input_tokens: 20000 }, model: i % 3 ? 'claude-opus-5-5' : 'claude-sonnet-5-5', sid: 'S' + (i % 40) })), fstate, 'x/S1.jsonl');
  }
  const loadMs = Date.now() - t0;
  assert.equal(reqs().length, N);
  let t = Date.now();
  const sum = await api('/api/summary');
  const sumMs = Date.now() - t;
  assert.equal(sum.totals.requests, N);
  assert.ok(sum.trend.points.length > 100);
  t = Date.now();
  const page = await api('/api/requests?sort=cost&size=50');
  const reqMs = Date.now() - t;
  assert.equal(page.total, N);
  t = Date.now();
  const pr = await api('/api/prompts?sort=cost&size=50');
  const prMs = Date.now() - t;
  assert.equal(pr.total, N / 20);
  t = Date.now();
  const det = await api('/api/prompt?id=P777');
  const detMs = Date.now() - t;
  assert.equal(det.requests.length, 20);
  t = Date.now();
  await api(`/api/requests?from=${T0 + 100000 * 60000}&to=${T0 + 100100 * 60000}`);
  const rangeMs = Date.now() - t;
  t = Date.now();
  srv.saveStore(true);
  const saveMs = Date.now() - t;
  const bytes = fs.statSync(srv._state.STORE_FILE).size;
  console.log(`# scale: ingest ${loadMs}ms, summary ${sumMs}ms, requests ${reqMs}ms, prompts ${prMs}ms, prompt ${detMs}ms, range ${rangeMs}ms, save ${saveMs}ms, store ${(bytes / 1048576).toFixed(1)}MB (${Math.round(bytes / N)} B/request)`);
  assert.ok(sumMs < 3000 && reqMs < 3000 && prMs < 3000, 'endpoints too slow');
  assert.ok(detMs < 200 && rangeMs < 500);
  assert.ok(bytes / N < 700, 'store not compact');
  const mem = process.memoryUsage().heapUsed / 1048576;
  assert.ok(mem < 1500, 'heap ' + mem);
});

// ---------------------------------------------------------------- breakdown fields (additive)

test('API: costParts / thinkingCost / byModel extras / prompt breakdown / activity', async () => {
  fresh();
  const u = uid();
  const big = { input_tokens: 1000, output_tokens: 2000, cache_read_input_tokens: 10000, cache_creation_input_tokens: 7000, cache_creation: { ephemeral_5m_input_tokens: 3000, ephemeral_1h_input_tokens: 4000 }, output_tokens_details: { thinking_tokens: 500 } };
  write('p/S1.jsonl', [
    user({ pid: 'P1', t: 0, uuid: u, human: true, content: 'build it' }),
    asst({ stop: 'end_turn', msg: 'o1', t: 4000, parent: u, usage: big }),                    // 4 s -> 500 tok/s
    asst({ stop: 'end_turn', msg: 'o2', t: 6000, parent: null, usage: { ...big, output_tokens: 1000, output_tokens_details: {} } }), // no parent -> no latency
  ]);
  const su = uid();
  write('p/S1/subagents/agent-q.jsonl', [
    user({ pid: 'P1', t: 100, uuid: su, side: true, content: 'sub task', human: false }),
    asst({ stop: 'end_turn', msg: 's1', t: 2100, parent: su, side: true, model: 'claude-sonnet-5-5', usage: { input_tokens: 1000, output_tokens: 1000, cache_read_input_tokens: 0 } }), // 2 s -> 500 tok/s
  ]);
  write('p/S2.jsonl', [
    user({ pid: 'P2', t: 50000, sid: 'S2', human: true, content: 'second' }),
    asst({ stop: 'end_turn', msg: 'h1', t: 51000, sid: 'S2', model: 'claude-haiku-5-5', usage: { input_tokens: 1000, output_tokens: 1000, cache_read_input_tokens: 1000 } }),
  ]);
  srv.scan();
  const s = await api('/api/summary');
  const o1 = { input: 4000 / 1e6, cacheWrite: (3000 * 5 + 4000 * 8) / 1e6, cacheRead: 2000 / 1e6, output: 40000 / 1e6 };
  const opus = s.byModel.find((m) => m.name === 'claude-opus-5-5');
  near(opus.costParts.input, 2 * o1.input);
  near(opus.costParts.cacheWrite, 2 * o1.cacheWrite);
  near(opus.costParts.cacheRead, 2 * o1.cacheRead);
  near(opus.costParts.output, o1.output + 20000 / 1e6);
  near(opus.thinkingCost, 500 * 20 / 1e6);
  near(opus.cost, opus.costParts.input + opus.costParts.cacheWrite + opus.costParts.cacheRead + opus.costParts.output);
  // every Agg has the parts, and they add up to cost
  const aggs = [s.totals, ...s.byModel, ...s.byProject, ...s.byEffort, ...s.byKind, ...s.byVersion, ...s.trend.points];
  for (const a of aggs) {
    assert.deepEqual(Object.keys(a.costParts).sort(), ['cacheRead', 'cacheWrite', 'input', 'output']);
    assert.equal(typeof a.thinkingCost, 'number');
    near(a.cost, a.costParts.input + a.costParts.cacheWrite + a.costParts.cacheRead + a.costParts.output, 1e-12);
  }
  near(s.totals.thinkingCost, 500 * 20 / 1e6);
  assert.equal(s.trend.points.reduce((a, p) => a + p.costParts.output, 0) > 0, true);
  // per-model extras
  assert.equal(opus.requests, 2);
  assert.equal(opus.prompts, 1);
  near(opus.speed, 500); // only o1 has a latency: 2000 tokens / 4 s
  assert.equal(opus.latencyP50, 4000);
  near(opus.costPerRequest, opus.cost / 2);
  assert.equal(opus.tokensPerRequest, opus.tokens / 2);
  const son = s.byModel.find((m) => m.name === 'claude-sonnet-5-5');
  near(son.speed, 500);
  const hk = s.byModel.find((m) => m.name === 'claude-haiku-5-5');
  assert.equal(hk.speed, null); // no usable latency
  assert.equal(hk.latencyP50, null);
  // prompts
  const pr = await api('/api/prompts?size=50');
  const p1 = pr.rows.find((r) => r.id === 'P1');
  assert.equal(p1.subagentRequests, 1);
  near(p1.subagentCost, (1000 * 2 + 1000 * 10) / 1e6);
  assert.equal(p1.thinking, 500);
  assert.equal(p1.input, 3000);
  assert.equal(p1.cacheRead, 20000);
  assert.equal(p1.cacheWrite, 14000);
  near(p1.thinkingCost, 500 * 20 / 1e6);
  near(p1.costParts.output, o1.output + 20000 / 1e6 + 10000 / 1e6);
  near(p1.cost, p1.costParts.input + p1.costParts.cacheWrite + p1.costParts.cacheRead + p1.costParts.output);
  // activity feed: newest prompt first, text capped at 160
  assert.deepEqual(s.activity.map((a) => a.id), ['P2', 'P1']);
  assert.deepEqual(Object.keys(s.activity[0]).sort(), ['cost', 'durationMs', 'id', 'models', 'requests', 'text', 'ts']);
  assert.equal(s.activity[1].requests, 3);
  near(s.activity[1].cost, p1.cost);
  assert.deepEqual(s.activity[0].models, ['claude-haiku-5-5']);
});

test('API: activity is capped at 30 prompts, newest first, text at 160 chars', async () => {
  fresh();
  const lines = [];
  for (let i = 0; i < 40; i++) {
    lines.push(user({ pid: 'Q' + i, t: i * 1000, human: true, content: 'x'.repeat(300) }));
    lines.push(asst({ msg: 'q' + i, t: i * 1000 + 10 }));
  }
  write('p/S1.jsonl', lines);
  srv.scan();
  const s = await api('/api/summary');
  assert.equal(s.activity.length, 30);
  assert.equal(s.activity[0].id, 'Q39');
  assert.equal(s.activity[29].id, 'Q10');
  assert.equal(s.activity[0].text.length, 160);
});

test('usagePartial: requests with no stop_reason on any line are flagged and counted, numbers untouched', async () => {
  fresh();
  write('p/S1.jsonl', [
    user({ pid: 'P1', t: 0, human: true }),
    asst({ msg: 'done', t: 10, stop: 'end_turn', usage: { output_tokens: 500 } }),
    asst({ msg: 'cut', t: 20, usage: { output_tokens: 7 } }), // stream-start usage only
    asst({ msg: 'late', t: 30, blk: 0, usage: { output_tokens: 3 } }),
    asst({ msg: 'late', t: 31, blk: 1, stop: 'tool_use', usage: { output_tokens: 90 } }), // a later line carries the stop_reason
  ]);
  srv.scan();
  const rows = (await api('/api/requests?size=50')).rows;
  const by = Object.fromEntries(rows.map((r) => [r.key.split(':')[0], r]));
  assert.equal(by.done.usagePartial, false);
  assert.equal(by.cut.usagePartial, true);
  assert.equal(by.late.usagePartial, false);
  assert.equal(by.cut.output, 7); // recorded value, not estimated
  const s = await api('/api/summary');
  assert.equal(s.totals.partial, 1);
  assert.equal(s.byModel[0].partial, 1);
  assert.equal(s.trend.points.reduce((a, p) => a + p.partial, 0), 1);
  assert.equal((await api('/api/status')).partialRequests, 1);
  assert.equal((await api('/api/request?key=cut%3Areq_cut')).usagePartial, true);
});

test('speed: partial (stream-start only) records are excluded from tokens/second', async () => {
  fresh();
  write('p/S1.jsonl', [
    user({ pid: 'P1', t: 0, human: true, uuid: 'u0' }),
    asst({ stop: 'end_turn', msg: 'a', t: 2000, parent: 'u0', model: 'claude-sonnet-5-5', usage: { output_tokens: 1000 } }), // 500 tok/s
    asst({ msg: 'b', t: 4000, parent: 'u0', model: 'claude-sonnet-5-5', usage: { output_tokens: 5 } }), // partial: would fake 1.25 tok/s
  ]);
  srv.scan();
  const son = (await api('/api/summary')).byModel.find((m) => m.name === 'claude-sonnet-5-5');
  near(son.speed, 500);
  assert.equal(son.speedSamples, 1);
});

test('prompt text: injected <browser_instruction> notices are stripped; a notice-only message shows the notice text', async () => {
  fresh();
  write('p/B1.jsonl', [
    user({ pid: 'PB1', t: 0, sid: 'B1', human: true, content: '<browser_instruction>[Browser disconnected: reconnect]</browser_instruction>\nfix the login form' }),
    asst({ msg: 'bm1', t: 2000, sid: 'B1', stop: 'end_turn' }),
    user({ pid: 'PB2', t: 60000, sid: 'B1', human: true, content: '<browser_instruction>[Browser disconnected: reconnect]</browser_instruction>' }),
    asst({ msg: 'bm2', t: 62000, sid: 'B1', stop: 'end_turn' }),
  ]);
  srv.scan();
  const rows = (await api('/api/prompts?sort=time&dir=asc&size=10')).rows;
  assert.equal(rows.find((r) => r.id === 'PB1').text, 'fix the login form');
  assert.equal(rows.find((r) => r.id === 'PB2').text, '[Browser disconnected: reconnect]');
});
