/* CCUsageX live demo — runs the real server.js in the browser over a fictional, pre-ingested store.
   window.fetch('/api/…') is answered by server.js's own handle(), so the demo can't drift from the app.
   Built into docs/demo/api.js by scripts/build-pages-demo.js. */
(function () {
  'use strict';

  var TIME_KEYS = /^(ts|first|last|start|end|lastTs|endTs|parentTs)$/;
  function shiftDeep(v, d) {
    if (Array.isArray(v)) { for (var i = 0; i < v.length; i++) v[i] = shiftDeep(v[i], d); return v; }
    if (v && typeof v === 'object') {
      for (var k in v) {
        if (typeof v[k] === 'number' && TIME_KEYS.test(k) && v[k] > 1e12) v[k] += d;
        else if (v[k] && typeof v[k] === 'object') shiftDeep(v[k], d);
      }
    }
    return v;
  }

  function text(url) { return fetch0(url, { cache: 'no-cache' }).then(function (r) { if (!r.ok) throw new Error(url + ' ' + r.status); return r.text(); }); }
  var fetch0 = window.fetch.bind(window);

  // minimal stand-ins for the Node modules server.js uses
  function makeModules(files) {
    var norm = function (p) {
      var parts = [];
      String(p).replace(/\\/g, '/').split('/').forEach(function (s, i) {
        if (s === '..') parts.pop(); else if (s && s !== '.') parts.push(s); else if (i === 0 && s === '') parts.push('');
      });
      return parts.join('/') || '/';
    };
    var path = {
      sep: '/',
      join: function () { return norm(Array.prototype.slice.call(arguments).join('/')); },
      normalize: norm,
      basename: function (p, ext) { var b = String(p).split(/[\\/]/).pop(); return ext && b.slice(-ext.length) === ext ? b.slice(0, -ext.length) : b; },
      extname: function (p) { var m = /\.[^./\\]*$/.exec(String(p)); return m ? m[0] : ''; },
    };
    var nope = function () { var e = new Error('ENOENT (demo)'); e.code = 'ENOENT'; throw e; };
    var fs = {
      readFileSync: function (p) {
        for (var k in files) if (String(p).slice(-k.length) === k) return files[k];
        return nope();
      },
      existsSync: function () { return false; },
      statSync: nope, readdirSync: nope, openSync: nope, readSync: nope, closeSync: function () {},
      mkdirSync: function () {}, writeFileSync: function () {}, renameSync: function () {}, unlinkSync: function () {},
      createReadStream: nope,
    };
    return {
      fs: fs, path: path,
      os: { homedir: function () { return '/demo'; }, tmpdir: function () { return '/tmp'; } },
      http: { createServer: function () { return { listen: function () {}, once: function () {} }; } },
      crypto: { createHash: function () { return { update: function () { return this; }, digest: function () { return ''; } }; } },
    };
  }

  var ready = Promise.all([text('server.js'), text('config.json'), text('demo-store.json')]).then(function (res) {
    var data = JSON.parse(res[2]);
    var delta = Date.now() - data.builtAt;
    var store = data.store;
    (store.req || []).forEach(function (row) { for (var i = 8; i <= 10; i++) if (typeof row[i] === 'number') row[i] += delta; });
    shiftDeep(store.prompts, delta);
    shiftDeep(store.sessions, delta);
    var mods = makeModules({ 'config.json': res[1], 'store.json': JSON.stringify(store) });
    var module = { exports: {} };
    var proc = { env: { CCU_START_DATE: 'all' }, argv: [], platform: 'browser', on: function () {}, exit: function () {} };
    var req = function (name) { if (mods[name]) return mods[name]; throw new Error('demo: no module ' + name); };
    var src = res[0].replace(/^#!.*\n/, '');
    new Function('require', 'module', 'exports', '__dirname', 'process', src)(req, module, module.exports, '/app', proc);
    module.exports.loadStore();
    return module.exports;
  });

  function call(srv, url) {
    var u = new URL(url, location.href);
    var p = u.pathname.slice(u.pathname.indexOf('/api/'));
    return new Promise(function (resolve) {
      var res = {
        statusCode: 200, headers: {}, headersSent: false,
        writeHead: function (s, h) { this.statusCode = s; this.headers = h || {}; this.headersSent = true; },
        end: function (body) { resolve({ status: this.statusCode, headers: this.headers, body: body || '' }); },
        destroy: function () { resolve({ status: 500, headers: {}, body: '' }); },
      };
      srv.handle({ method: 'GET', url: p + u.search, headers: { host: '127.0.0.1:3020' } }, res);
    });
  }

  /* ================================================================== Live simulator (fictional, deterministic-but-lively)
     Replaces EventSource('/api/stream') and answers /api/live/state with the same contract as server.js (see .team/LIVE.md):
     a main agent working through a fictional prompt (thinking, text, tool calls, subagents, requests, turn_end), looping forever. */
  var Sim = (function () {
    var seed = 20260601;
    function rnd() { seed |= 0; seed = seed + 0x6D2B79F5 | 0; var t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }
    function rr(a, b) { return a + rnd() * (b - a); }
    function ri(a, b) { return Math.round(rr(a, b)); }
    function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
    var PRICE = { 'claude-opus-5-5': [5, 25, 0.5, 6.25], 'claude-sonnet-5-5': [3, 15, 0.3, 3.75], 'claude-haiku-5-5': [1, 5, 0.1, 1.25] };
    var OPUS = 'claude-opus-5-5', SONNET = 'claude-sonnet-5-5', HAIKU = 'claude-haiku-5-5';
    function priceCost(m, i, o, cr, cw) { var p = PRICE[m] || PRICE[SONNET]; return (i * p[0] + o * p[1] + cr * p[2] + cw * p[3]) / 1e6; }

    var nextId = 1, sessions = {}, order = [], subs = [], ring = [], reqLog = {}, promptLog = {}, reqWin = [], started = false, uid = 1;
    var today = { requests: 214, cost: 14.62, tokens: 31800000, output: 212400 };

    function mkSession(id, project, title, model) {
      var s = { sessionId: id, title: title, project: project, model: model, entrypoint: 'cli', startedTs: Date.now() - 3600000, lastTs: 0,
        phase: 'idle', phaseSince: 0, currentTool: null, promptText: '', promptTs: 0, promptId: null, context: { tokens: 52000, limit: 1000000 },
        agents: [{ agentId: null, agentType: 'main', desc: '', model: model, phase: 'idle', phaseSince: 0, currentTool: null, requests: 0, cost: 0, lastTs: 0 }],
        turn: { requests: 0, cost: 0, tokens: 0, output: 0, startedTs: 0 }, recent: [], running: {}, ctxTok: 50000 };
      sessions[id] = s; order.push(id);
      return s;
    }
    function agentRec(s, id) { for (var i = 0; i < s.agents.length; i++) if ((s.agents[i].agentId || null) === (id || null)) return s.agents[i]; return null; }

    function emit(s, kind, f, silentTs) {
      var ts = silentTs || Date.now();
      var ev = { id: nextId++, ts: ts, kind: kind, sessionId: s.sessionId, promptId: s.promptId, agentId: f.agentId || null, agentType: f.agentType || null,
        sidechain: !!f.agentId, model: f.model || (f.agentId ? null : s.model), project: s.project };
      for (var k in f) if (k !== 'agentId' && k !== 'agentType') ev[k] = f[k];
      var sub = f.agentId != null;
      var a = agentRec(s, f.agentId || null), main = agentRec(s, null);
      s.lastTs = ts; if (a) a.lastTs = ts;
      switch (kind) {
        case 'prompt':
          s.promptText = f.text; s.promptTs = ts; s.promptId = ev.promptId = f.promptId;
          s.turn = { requests: 0, cost: 0, tokens: 0, output: 0, startedTs: ts };
          s.phase = 'generating'; s.phaseSince = ts; s.currentTool = null; main.phase = 'generating'; main.phaseSince = ts; main.currentTool = null;
          s.agents = [main]; promptLog[s.promptId] = { text: f.text, ts: ts, sessionId: s.sessionId, project: s.project, reqs: [] };
          break;
        case 'tool_use':
          s.running[f.toolUseId] = { agent: f.agentId || null, tool: f.tool, summary: f.summary, since: ts };
          if (a) { a.phase = 'tool'; a.phaseSince = ts; a.currentTool = { tool: f.tool, summary: f.summary, since: ts }; }
          if (!sub) { s.phase = 'tool'; s.phaseSince = ts; s.currentTool = a.currentTool; }
          break;
        case 'tool_result': {
          delete s.running[f.toolUseId];
          var left = null; for (var u in s.running) if (s.running[u].agent === (f.agentId || null)) left = s.running[u];
          if (a) { a.currentTool = left ? { tool: left.tool, summary: left.summary, since: left.since } : null; a.phase = left ? 'tool' : 'generating'; a.phaseSince = ts; }
          if (!sub && a) { s.phase = a.phase; s.phaseSince = ts; s.currentTool = a.currentTool; }
          break;
        }
        case 'request':
          if (a) { a.requests++; a.cost += f.cost; }
          today.requests++; today.cost += f.cost;
          var tot = f.input + f.output + f.cacheRead + f.cacheWrite; today.tokens += tot; today.output += f.output;
          s.turn.requests++; s.turn.cost += f.cost; s.turn.tokens += tot; s.turn.output += f.output;
          if (!sub) s.context.tokens = f.input + f.cacheRead + f.cacheWrite;
          reqWin.push({ ts: ts, tok: tot, cost: f.cost });
          reqLog[f.key] = ev; if (promptLog[s.promptId]) promptLog[s.promptId].reqs.push(f.key);
          break;
        case 'subagent_start':
          s.agents.push({ agentId: f.agentId, agentType: f.agentType, desc: f.desc, model: f.model, phase: 'generating', phaseSince: ts, currentTool: null, requests: 0, cost: 0, lastTs: ts });
          break;
        case 'subagent_end': if (a) { a.phase = 'done'; a.currentTool = null; } break;
        case 'turn_end': s.phase = 'waiting_user'; s.phaseSince = ts; s.currentTool = null; main.phase = 'waiting_user'; main.phaseSince = ts; main.currentTool = null; break;
        case 'title': s.title = f.title; break;
      }
      s.recent.unshift(ev); if (s.recent.length > 40) s.recent.length = 40;
      ring.push(ev); if (ring.length > 500) ring.shift();
      if (!silentTs) subs.forEach(function (c) { c._emit('ev', ev, ev.id); });
      return ev;
    }

    function rate() {
      var cut = Date.now() - 300000, t = 0, c = 0, n = 0;
      reqWin = reqWin.filter(function (r) { return r.ts >= cut; });
      reqWin.forEach(function (r) { t += r.tok; c += r.cost; n++; });
      return { tokensPerMin: t / 5, costPerMin: c / 5, requestsPerMin: n / 5 };
    }
    function state() {
      var now = Date.now();
      return { now: now, active: order.some(function (id) { return now - sessions[id].lastTs < 120000; }),
        sessions: order.map(function (id) { var s = sessions[id], o = {}; for (var k in s) if (k !== 'running' && k !== 'ctxTok') o[k] = s[k]; return o; }).sort(function (a, b) { return b.lastTs - a.lastTs; }),
        today: today, rate: rate() };
    }

    /* ---- tiny scripting layer */
    function request(s, ag, o) {
      var model = ag.model || s.model, main = !ag.agentId;
      var inp = ri(2, 14), cw = ri(500, 3600), out = o.out || ri(120, 900), cr = main ? s.ctxTok : ri(18000, 52000);
      if (main) { s.ctxTok += cw + out; if (s.ctxTok > 540000) s.ctxTok = 56000; }
      var c = priceCost(model, inp, out, cr, cw);
      return emit(s, 'request', { key: 'sim-' + (uid++), input: inp, output: out, cacheRead: cr, cacheWrite: cw, thinking: o.think ? ri(60, 380) : 0, cost: c,
        latencyMs: Math.round(out / (model === HAIKU ? 210 : model === SONNET ? 135 : 94) * 1000 + rr(400, 900)), stopReason: o.stop || 'tool_use', usagePartial: false, model: model, agentId: ag.agentId, agentType: ag.agentType });
    }
    // one assistant message: optional thinking/text, tool_use blocks, request; then tools run in parallel and return results
    function step(s, ag, d) {
      var wait = d.gen == null ? rr(1400, 3800) : d.gen;
      return sleep(wait).then(function () {
        if (d.think) emit(s, 'thinking', Object.assign({}, ag));
        return sleep(d.think ? rr(300, 700) : 0);
      }).then(function () {
        if (d.text) emit(s, 'text', Object.assign({ text: d.text }, ag));
        return sleep(d.text ? rr(250, 600) : 0);
      }).then(function () {
        var uses = (d.tools || []).map(function (t) {
          var id = 'tu_' + (uid++);
          emit(s, 'tool_use', Object.assign({ tool: t.tool, toolUseId: id, summary: t.summary }, ag));
          return { t: t, id: id, at: Date.now() };
        });
        request(s, ag, { out: d.out, think: d.think, stop: d.stop || (uses.length ? 'tool_use' : 'end_turn') });
        return Promise.all(uses.map(function (u) {
          return sleep(u.t.dur || 400).then(function () { return u.t.agent ? runSub(s, u) : null; }).then(function () {
            emit(s, 'tool_result', Object.assign({ toolUseId: u.id, tool: u.t.tool, isError: !!u.t.err, durationMs: Date.now() - u.at }, ag));
          });
        }));
      });
    }
    function runSub(s, u) {
      var spec = u.t.agent, id = 'ag_' + (uid++).toString(16) + 'f3', ag = { agentId: id, agentType: spec.type, model: spec.model };
      emit(s, 'subagent_start', Object.assign({ desc: u.t.summary }, ag));
      var p = Promise.resolve();
      spec.steps.forEach(function (d) { p = p.then(function () { return step(s, ag, d); }); });
      return p.then(function () { return sleep(300); }).then(function () {
        request(s, ag, { out: ri(500, 1100), stop: 'end_turn' });
        emit(s, 'subagent_end', ag);
      });
    }

    var TURNS = [
      { prompt: 'Refactor the auth middleware to use signed session tokens', steps: [
        { think: 1, text: "I'll start by reading the current middleware and finding where sessions are verified.", tools: [
          { tool: 'Read', summary: 'src/auth/middleware.ts', dur: 380 }, { tool: 'Grep', summary: 'verifySession', dur: 640 }, { tool: 'Glob', summary: 'src/**/*.test.ts', dur: 300 }] },
        { think: 1, text: 'Two things need checking before I touch anything. I will fan out in parallel.', tools: [
          { tool: 'Agent', summary: 'Find every caller of verifySession', dur: 100, agent: { type: 'Explore', model: HAIKU, steps: [
            { gen: 1500, tools: [{ tool: 'Grep', summary: 'verifySession(', dur: 520 }, { tool: 'Glob', summary: 'src/routes/**/*.ts', dur: 280 }] },
            { gen: 1700, tools: [{ tool: 'Read', summary: 'src/routes/session.ts', dur: 420 }, { tool: 'Read', summary: 'src/routes/admin.ts', dur: 460 }] },
            { gen: 1600, tools: [{ tool: 'Grep', summary: 'req.session', dur: 700 }] }] } },
          { tool: 'Agent', summary: 'Audit test coverage for session handling', dur: 2200, agent: { type: 'general-purpose', model: SONNET, steps: [
            { gen: 1800, tools: [{ tool: 'Glob', summary: 'test/**/*session*', dur: 330 }] },
            { gen: 2200, tools: [{ tool: 'Read', summary: 'test/auth.test.ts', dur: 410 }, { tool: 'Bash', summary: 'npx vitest --listTests | grep auth', dur: 2600 }] },
            { gen: 2400, tools: [{ tool: 'Read', summary: 'test/fixtures/session.json', dur: 300 }] }] } }] },
        { think: 1, text: 'Callers are all behind one helper, so the change stays local. Writing the signing helper first.', out: 1300, tools: [
          { tool: 'Write', summary: 'src/auth/tokens.ts', dur: 240 }, { tool: 'Edit', summary: 'src/auth/middleware.ts', dur: 290 }, { tool: 'Edit', summary: 'src/routes/session.ts', dur: 310 }] },
        { text: 'Running the auth tests.', tools: [{ tool: 'Bash', summary: 'npm test -- auth', dur: 6200, err: true }] },
        { think: 1, text: 'One test still expects the old cookie name. Updating the fixture.', tools: [{ tool: 'Edit', summary: 'test/auth.test.ts', dur: 280 }] },
        { text: 'Re-running.', tools: [{ tool: 'Bash', summary: 'npm test -- auth', dur: 5300 }] },
        { text: 'Done. Sessions are now signed with a rotating key, the middleware verifies the signature before touching the store, and all 38 auth tests pass.', out: 1500, stop: 'end_turn', tools: [] }
      ] },
      { prompt: 'Why is the scan slow?', steps: [
        { think: 1, text: 'Let me look at how the scan walks the transcript directory.', tools: [{ tool: 'Grep', summary: 'function scan', dur: 520 }, { tool: 'Read', summary: 'server.js', dur: 410 }] },
        { think: 1, text: 'It re-stats every file on each pass. Profiling to confirm.', tools: [{ tool: 'Bash', summary: 'node --cpu-prof server.js --scan-once', dur: 4800 }] },
        { text: 'Checking how many files are tracked.', tools: [{ tool: 'Agent', summary: 'Measure stat() cost per transcript file', dur: 100, agent: { type: 'Explore', model: HAIKU, steps: [
          { gen: 1300, tools: [{ tool: 'Bash', summary: 'node -e "benchStat()"', dur: 1900 }] }, { gen: 1700, tools: [{ tool: 'Read', summary: 'store.json', dur: 360 }] }] } }] },
        { text: 'The first pass is slow because it hashes every file; later passes only stat. Caching the offsets makes the cold start about 5x faster.', out: 1100, stop: 'end_turn', tools: [] }
      ] },
      { prompt: 'Fix flaky test in verify.js', steps: [
        { think: 1, text: 'Reading the test and running it a few times to catch the flake.', tools: [{ tool: 'Read', summary: 'test/verify.js', dur: 360 }, { tool: 'Bash', summary: 'for i in 1 2 3 4 5; do node test/verify.js; done', dur: 7400, err: true }] },
        { think: 1, text: 'It races on the temp directory name. Using a unique suffix.', tools: [{ tool: 'Edit', summary: 'test/verify.js', dur: 300 }] },
        { text: 'Confirming over ten runs.', tools: [{ tool: 'Bash', summary: 'for i in $(seq 10); do node test/verify.js || exit 1; done', dur: 9100 }] },
        { text: 'Fixed: the test shared a temp path between parallel runs. Ten consecutive runs are green.', out: 700, stop: 'end_turn', tools: [] }
      ] }
    ];
    var TURNS_B = [
      { prompt: 'Write the README', steps: [
        { text: 'Skimming the package and docs for what to document.', tools: [{ tool: 'Read', summary: 'package.json', dur: 300 }, { tool: 'Glob', summary: 'docs/**/*.md', dur: 260 }] },
        { think: 1, text: 'Drafting the README now.', out: 1400, tools: [{ tool: 'Write', summary: 'README.md', dur: 420 }] },
        { text: 'The README is in place with install, usage and a screenshot section.', stop: 'end_turn', out: 600, tools: [] }
      ] },
      { prompt: 'Explain store.json layout', steps: [
        { text: 'Opening the store to see its shape.', tools: [{ tool: 'Read', summary: 'store.json', dur: 380 }, { tool: 'Grep', summary: 'saveStore', dur: 450 }] },
        { text: 'store.json keeps requests as compact rows plus a per-file offset table so a rescan only reads appended lines.', stop: 'end_turn', out: 800, tools: [] }
      ] }
    ];

    function loopSession(s, turns, firstDelay, pause) {
      var n = 0;
      function turn() {
        var t = turns[n++ % turns.length];
        emit(s, 'prompt', { text: t.prompt, promptId: 'sim-prompt-' + (uid++) });
        var p = Promise.resolve();
        t.steps.forEach(function (d) { p = p.then(function () { return step(s, { agentId: null }, d); }); });
        return p.then(function () { emit(s, 'turn_end', {}); return sleep(pause()); }).then(turn);
      }
      sleep(firstDelay).then(turn);
    }

    function seedHistory(s, offsetSec) {
      // a finished earlier turn so the first frame already has context, a timeline and rates
      var t0 = Date.now() - offsetSec * 1000;
      emit(s, 'prompt', { text: 'Add charts API for scatter', promptId: 'sim-prompt-' + (uid++) }, t0);
      var offs = [6, 31, 58, 83, 109, 140, 171, 205, 236], tools = ['Read', 'Edit', 'Bash', 'Grep', 'Edit', 'Bash', 'Read', 'Edit', 'Bash'];
      offs.forEach(function (o, k) {
        var ts = t0 + o * 1000, id = 'tu_h' + k;
        emit(s, 'tool_use', { tool: tools[k], toolUseId: id, summary: 'src/charts/scatter.ts' }, ts);
        var rq = request(s, { agentId: null }, { out: ri(200, 1400), stop: 'tool_use' });
        rq.ts = ts + 200; reqWin[reqWin.length - 1].ts = ts + 200;
        emit(s, 'tool_result', { toolUseId: id, tool: tools[k], isError: false, durationMs: ri(300, 3000) }, ts + 2200);
      });
      emit(s, 'turn_end', {}, t0 + 262 * 1000);
      s.running = {};
    }

    function start() {
      if (started) return; started = true;
      var A = mkSession('sim-a', '/home/dev/orbit-api', 'Refactor auth middleware', OPUS); A.ctxTok = 61000;
      var B = mkSession('sim-b', '/home/dev/docs-site', 'Docs site cleanup', SONNET); B.ctxTok = 38000;
      seedHistory(A, 300);
      emit(B, 'prompt', { text: 'Fix the broken sidebar links', promptId: 'sim-prompt-' + (uid++) }, Date.now() - 74000);
      emit(B, 'turn_end', {}, Date.now() - 52000);
      setInterval(function () { if (subs.length) { var st = state(); subs.forEach(function (c) { c._emit('state', st); }); } }, 1000);
      loopSession(A, TURNS, 900, function () { return rr(11000, 16000); });
      loopSession(B, TURNS_B, 13000, function () { return rr(22000, 34000); });
    }

    function requestDetail(key) {
      var ev = reqLog[key]; if (!ev) return null;
      var s = sessions[ev.sessionId], p = promptLog[ev.promptId], m = PRICE[ev.model] || PRICE[SONNET];
      var tot = ev.input + ev.output + ev.cacheRead + ev.cacheWrite;
      return { key: key, ts: ev.ts, model: ev.model, requestedModel: ev.model, effort: 'high', speed: 'standard', serviceTier: 'standard', sidechain: ev.sidechain, agentType: ev.agentType, agentDesc: '',
        version: '2.1.0', entrypoint: 'cli', gitBranch: 'main', latencyMs: ev.latencyMs, stopReason: ev.stopReason, project: ev.project, sessionId: ev.sessionId, sessionTitle: s ? s.title : '',
        input: ev.input, output: ev.output, cacheRead: ev.cacheRead, cacheWrite: ev.cacheWrite, cacheWrite5m: ev.cacheWrite, cacheWrite1h: 0, thinking: ev.thinking, tokens: tot, usagePartial: false,
        cost: { input: ev.input * m[0] / 1e6, output: ev.output * m[1] / 1e6, cacheRead: ev.cacheRead * m[2] / 1e6, cacheWrite: ev.cacheWrite * m[3] / 1e6, total: ev.cost },
        tools: [], response: '(live demo request, fictional)', promptText: p ? p.text : '', promptId: ev.promptId, promptTs: p ? p.ts : null };
    }
    function promptDetail(id) {
      var p = promptLog[id]; if (!p) return null;
      var rows = p.reqs.map(function (k) { return reqLog[k]; }).filter(Boolean);
      var t = { requests: rows.length, tokens: 0, cost: 0, input: 0, output: 0, cacheWrite: 0, cacheRead: 0, thinking: 0, unpriced: 0 };
      var out = rows.map(function (e) {
        t.tokens += e.input + e.output + e.cacheRead + e.cacheWrite; t.cost += e.cost; t.input += e.input; t.output += e.output; t.cacheWrite += e.cacheWrite; t.cacheRead += e.cacheRead; t.thinking += e.thinking;
        return { key: e.key, ts: e.ts, model: e.model, effort: 'high', sidechain: e.sidechain, project: e.project, sessionId: e.sessionId, promptId: id, input: e.input, output: e.output, cacheRead: e.cacheRead, cacheWrite: e.cacheWrite,
          thinking: e.thinking, tokens: e.input + e.output + e.cacheRead + e.cacheWrite, cost: e.cost, latencyMs: e.latencyMs, tools: [], stopReason: e.stopReason, usagePartial: false, agentType: e.agentType };
      });
      return { prompt: { text: p.text, ts: p.ts, sessionId: p.sessionId, project: p.project, origin: 'human' }, sessionTitle: (sessions[p.sessionId] || {}).title, totals: t, requests: out };
    }

    /* EventSource stand-in */
    function FakeES(url) {
      var self = this; this.url = url; this.readyState = 0; this.onopen = null; this.onerror = null; this._l = {};
      start();
      setTimeout(function () {
        if (self.readyState === 2) return;
        self.readyState = 1;
        if (self.onopen) self.onopen({ type: 'open' });
        self._emit('snapshot', state());
        subs.push(self);
      }, 50);
    }
    FakeES.prototype.addEventListener = function (t, f) { (this._l[t] = this._l[t] || []).push(f); };
    FakeES.prototype.removeEventListener = function (t, f) { var a = this._l[t] || [], i = a.indexOf(f); if (i >= 0) a.splice(i, 1); };
    FakeES.prototype._emit = function (t, data, id) {
      var e = { type: t, data: JSON.stringify(data), lastEventId: id == null ? '' : String(id) };
      (this._l[t] || []).slice().forEach(function (f) { try { f(e); } catch (x) { if (window.console) console.error(x); } });
    };
    FakeES.prototype.close = function () { this.readyState = 2; var i = subs.indexOf(this); if (i >= 0) subs.splice(i, 1); };
    FakeES.CONNECTING = 0; FakeES.OPEN = 1; FakeES.CLOSED = 2;
    return { FakeES: FakeES, state: function () { start(); return state(); }, requestDetail: requestDetail, promptDetail: promptDetail };
  })();
  (function () {
    var Native = window.EventSource;
    window.EventSource = function (url, opts) {
      if (String(url).indexOf('/api/stream') !== -1) return new Sim.FakeES(url);
      return new Native(url, opts);
    };
    window.EventSource.CONNECTING = 0; window.EventSource.OPEN = 1; window.EventSource.CLOSED = 2;
  })();
  function json(o, st) { return new Response(JSON.stringify(o), { status: st || 200, headers: { 'Content-Type': 'application/json; charset=utf-8' } }); }

  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    if (url.indexOf('/api/') === -1) return fetch0(input, init);
    if (url.indexOf('/api/live/state') !== -1) return Promise.resolve(json(Sim.state()));
    if (url.indexOf('/api/stream') !== -1) return Promise.resolve(json({ error: 'use EventSource' }, 404));
    var sm = /\/api\/(request|prompt)\?(?:key|id)=(sim-[^&]+)/.exec(url);
    if (sm) {
      var d = sm[1] === 'request' ? Sim.requestDetail(decodeURIComponent(sm[2])) : Sim.promptDetail(decodeURIComponent(sm[2]));
      return Promise.resolve(d ? json(d) : json({ error: 'not found' }, 404));
    }
    return ready.then(function (srv) { return call(srv, url); }).then(function (r) {
      return new Response(r.body, { status: r.status, headers: r.headers });
    });
  };

  // "Export CSV" is a plain link; serve it from the in-browser server too
  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest && e.target.closest('a[href*="/api/export.csv"]');
    if (!a) return;
    e.preventDefault();
    ready.then(function (srv) { return call(srv, a.getAttribute('href')); }).then(function (r) {
      var blob = new Blob([r.body], { type: 'text/csv;charset=utf-8' });
      var link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = 'ccusagex-demo.csv';
      document.body.appendChild(link); link.click(); link.remove();
      setTimeout(function () { URL.revokeObjectURL(link.href); }, 2000);
    });
  }, true);
})();
