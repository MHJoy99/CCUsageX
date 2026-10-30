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
const CF_BEACON = `<script defer src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon='{"token": "a2f7f3d589ae4c8688a646d54918b0e7"}'></script>`;

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
for (const f of ['app.js', 'charts.js', 'styles.css', 'live.js', 'live.css', 'limits.js', 'limits.css', 'plan.js']) fs.copyFileSync(path.join(ROOT, 'public', f), path.join(OUT, f));
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
  .replace('</body>', `${CF_BEACON}\n</body>`)
  .replace('<script src="charts.js"></script>', '<script src="api.js"></script>\n<script src="charts.js"></script>');
if (!html.includes('api.js')) throw new Error('could not inject api.js into index.html');
fs.writeFileSync(path.join(OUT, 'index.html'), html);

// 3b. desktop widget demo (docs/demo/widget.html). Skipped when public/widget.html does not exist yet;
// once it exists, its css/js must exist too and the transform must succeed, or the build throws.
const WIDGET_SRC = path.join(ROOT, 'public', 'widget.html');
if (fs.existsSync(WIDGET_SRC)) {
  for (const f of ['widget.css', 'widget.js', 'pv-charts.js']) fs.copyFileSync(path.join(ROOT, 'public', f), path.join(OUT, f));
  const widgetStyle = `<style>
  html, body { overflow: auto !important; }
  .demo-caption { box-sizing: border-box; width: 100%; padding: 12px 14px 16px; text-align: center; font: 500 11px/1.4 -apple-system,'Segoe UI',system-ui,sans-serif; color: #6b6478; }
  .demo-caption a { color: #5b3df5; text-decoration: underline; text-underline-offset: 2px; }
</style>`;
  const widgetCaption = `<div class="demo-caption" role="note">
  <strong>Live demo</strong> · fictional data, running entirely in your browser ·
  <a href="https://github.com/MHJoy99/CCUsageX#quick-start">Run the widget on your own Claude Code logs →</a>
</div>`;
  let widget = fs.readFileSync(WIDGET_SRC, 'utf8')
    .replace(/<title>[^<]*<\/title>/, '<title>Claude Pulse widget — CCUsageX live demo</title>\n<meta name="robots" content="index,follow">\n<link rel="canonical" href="https://mhjoy99.github.io/CCUsageX/demo/widget.html">\n<meta name="description" content="Interactive demo of the CCUsageX desktop widget: plan limits, peak-hour clock and burn pace on fictional data.">')
    .replace('</head>', `${widgetStyle}\n</head>`)
    .replace('</body>', `${widgetCaption}\n${CF_BEACON}\n</body>`)
    .replace('<script src="widget.js"></script>', '<script src="api.js"></script>\n<script src="widget.js"></script>');
  if (!widget.includes('<script src="api.js"></script>') || !widget.includes('demo/widget.html') || !widget.includes('static.cloudflareinsights.com')) {
    throw new Error('could not transform public/widget.html for the demo (api.js, canonical or beacon not injected)');
  }
  fs.writeFileSync(path.join(OUT, 'widget.html'), widget);
}

fs.rmSync(TMP, { recursive: true, force: true });
const size = fs.readdirSync(OUT).reduce((a, f) => a + fs.statSync(path.join(OUT, f)).size, 0);
console.log(`docs/demo built: ${(size / 1024).toFixed(0)} KB, ${store.req.length} requests`);
