#!/usr/bin/env node
'use strict';
// Builds the static live demo in docs/demo/: the real dashboard UI + the real server.js running in the
// browser over a pre-ingested, fictional data store (see docs/demo/api.js).
//   node scripts/build-pages-demo.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'docs', 'demo');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ccusagex-demo-'));

// 1. fictional transcripts
execFileSync(process.execPath, [path.join(__dirname, 'demo-data.js'), TMP, '--seed', '7'], { stdio: 'inherit' });

// 2. ingest them with the real server code (env must be set before require)
process.env.CLAUDE_CONFIG_DIR = TMP;
process.env.CCU_DATA_DIR = path.join(TMP, 'data');
process.env.CCU_START_DATE = 'all';
const srv = require(path.join(ROOT, 'server.js'));
srv.scan();
srv.saveStore(true);
const store = JSON.parse(fs.readFileSync(path.join(TMP, 'data', 'store.json'), 'utf8'));
store.files = {}; // transcript paths/offsets aren't needed in the browser
const builtAt = Date.now();

// 3. assemble docs/demo
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'demo-store.json'), JSON.stringify({ builtAt, store }));
fs.copyFileSync(path.join(ROOT, 'server.js'), path.join(OUT, 'server.js'));
fs.copyFileSync(path.join(ROOT, 'config.json'), path.join(OUT, 'config.json'));
for (const f of ['app.js', 'charts.js', 'styles.css']) fs.copyFileSync(path.join(ROOT, 'public', f), path.join(OUT, f));
fs.copyFileSync(path.join(__dirname, 'demo-api.js'), path.join(OUT, 'api.js'));

let html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const banner = `
<div class="demo-banner" role="note">
  <strong>Live demo</strong> · fictional data, running entirely in your browser ·
  <a href="https://github.com/MHJoy99/CCUsageX#quick-start">Run it on your own Claude Code logs →</a>
</div>
<style>
  .demo-banner{position:relative;z-index:60;padding:8px 16px;text-align:center;font:500 13px/1.4 -apple-system,'Segoe UI',system-ui,sans-serif;
    color:#fff;background:linear-gradient(90deg,#5b3df5,#3a1d9e 60%,#c13584)}
  .demo-banner a{color:#fff;text-decoration:underline;text-underline-offset:2px}
</style>`;
html = html
  .replace(/<title>[^<]*<\/title>/, '<title>CCUsageX live demo — Claude Code usage dashboard</title>\n<meta name="robots" content="index,follow">\n<link rel="canonical" href="https://mhjoy99.github.io/CCUsageX/demo/">\n<meta name="description" content="Interactive demo of CCUsageX, the local Claude Code usage dashboard: prompts, tokens, cache hits and API-equivalent cost, on fictional data.">')
  .replace(/<body([^>]*)>/, (m) => m + banner)
  .replace('<script src="charts.js"></script>', '<script src="api.js"></script>\n<script src="charts.js"></script>');
if (!html.includes('api.js')) throw new Error('could not inject api.js into index.html');
fs.writeFileSync(path.join(OUT, 'index.html'), html);

fs.rmSync(TMP, { recursive: true, force: true });
const size = fs.readdirSync(OUT).reduce((a, f) => a + fs.statSync(path.join(OUT, f)).size, 0);
console.log(`docs/demo built: ${(size / 1024).toFixed(0)} KB, ${store.req.length} requests`);
