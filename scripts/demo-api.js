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

  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    if (url.indexOf('/api/') === -1) return fetch0(input, init);
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
