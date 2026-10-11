#!/usr/bin/env node
'use strict';
// Captures README/site screenshots from the static live demo (docs/demo) in a real-time headless browser.
//   node scripts/build-pages-demo.js && node scripts/screenshots.js
// Uses Edge or Chrome via the DevTools protocol (Node 22+ for the global WebSocket). Output: docs/screenshots/*.png

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DOCS = path.join(ROOT, 'docs');
const OUT = path.join(DOCS, 'screenshots');
const BROWSERS = [
  process.env.BROWSER,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/microsoft-edge',
].filter(Boolean);
const BROWSER = BROWSERS.find((b) => fs.existsSync(b));
if (!BROWSER) { console.error('No Edge/Chrome found; set BROWSER=<path>'); process.exit(1); }
if (typeof WebSocket === 'undefined') { console.error('Needs Node 22+ (global WebSocket)'); process.exit(1); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };

function serveDocs() { // mimics GitHub Pages: docs/ served under /CCUsageX/
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let p = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/CCUsageX/, '');
      let f = path.join(DOCS, p);
      if (!f.startsWith(DOCS) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
      if (fs.statSync(f).isDirectory()) f = path.join(f, 'index.html');
      res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
      fs.createReadStream(f).pipe(res);
    }).listen(0, '127.0.0.1', () => resolve(srv));
  });
}

async function browser() {
  const port = 9400 + Math.floor(Math.random() * 400);
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'ccusagex-shot-'));
  const proc = spawn(BROWSER, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', `--remote-debugging-port=${port}`, `--user-data-dir=${prof}`, 'about:blank'], { stdio: 'ignore' });
  let list;
  for (let i = 0; i < 60 && !list; i++) { try { list = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); } catch { await sleep(250); } }
  const ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0; const pending = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d.result || d); pending.delete(d.id); } };
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const close = () => { ws.close(); proc.kill(); setTimeout(() => fs.rmSync(prof, { recursive: true, force: true }), 1500); };
  return { send, close };
}

async function shot(b, url, file, { width = 1440, height = 1800, theme = 'light', before } = {}) {
  await b.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  await b.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] });
  await b.send('Page.enable');
  await b.send('Runtime.enable');
  await b.send('Page.navigate', { url });
  await sleep(1500);
  await b.send('Runtime.evaluate', { expression: `localStorage.setItem('ccu.theme', ${JSON.stringify(theme)}); location.reload();` });
  await sleep(6500); // charts animate in real time
  if (before) { await b.send('Runtime.evaluate', { expression: before }); await sleep(2500); }
  const r = await b.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, file), Buffer.from(r.data, 'base64'));
  console.log('saved', path.join('docs', 'screenshots', file));
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const srv = await serveDocs();
  const url = `http://127.0.0.1:${srv.address().port}/CCUsageX/demo/`;
  const b = await browser();
  try {
    await shot(b, url, 'dashboard-light.png', { theme: 'light' });
    await shot(b, url, 'dashboard-dark.png', { theme: 'dark' });
    await shot(b, url, 'prompt-drawer.png', {
      theme: 'light', width: 1440, height: 1000,
      before: "(document.querySelector('.fi[data-prompt]')||document.querySelector('[data-prompt]')).click()",
    });
  } finally {
    b.close();
    srv.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
