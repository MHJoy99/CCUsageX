'use strict';
// Run with: node --test test/install-statusline.test.js
// Installer for the Claude Code status line hook. Every test uses its own temp config dir and a fake
// statusline.js, so the real ~/.claude/settings.json is never read or written.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const lib = require('../scripts/install-statusline.js');
const SCRIPT = path.join(__dirname, '..', 'scripts', 'install-statusline.js');
const { HELPER_KEY } = lib;

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ccu-statusline-'));
let counter = 0;

// A fresh config dir plus a fake scripts/statusline.js the installer can point at.
function setup(initial) {
  const n = ++counter;
  const configDir = path.join(TMP, `claude-${n}`);
  fs.mkdirSync(configDir, { recursive: true });
  const scriptPath = path.join(TMP, `app-${n}`, 'scripts', 'statusline.js');
  fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
  fs.writeFileSync(scriptPath, '// fake statusline\n');
  const file = path.join(configDir, 'settings.json');
  if (initial !== undefined) fs.writeFileSync(file, initial, 'utf8');
  return { configDir, scriptPath, file, dataDir: path.join(TMP, `data-${n}`) };
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
const backupsOf = (file) => fs.readdirSync(path.dirname(file)).filter((f) => f.startsWith('settings.json.bak-'));
const normalize = (p) => p.replace(/\\/g, '/');

test.after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('fresh install creates settings.json with the CCUsageX status line', () => {
  const env = setup();
  const r = lib.install({ configDir: env.configDir, scriptPath: env.scriptPath });
  assert.equal(r.changed, true);
  assert.equal(r.backup, null, 'nothing to back up when settings.json was missing');
  assert.equal(r.created, true);
  const text = fs.readFileSync(env.file, 'utf8');
  assert.equal(text.endsWith('\n'), true);
  assert.equal(text, JSON.stringify({
    statusLine: {
      type: 'command',
      command: `node "${normalize(env.scriptPath)}"`,
      padding: 0,
      refreshInterval: 30,
    },
  }, null, 2) + '\n');
  assert.equal(r.chained, false);
  assert.equal(lib.isOurs(readJson(env.file).statusLine, env.scriptPath), true);
});

test('install keeps every other key, in order, and backs up the old file first', () => {
  const original = '{\n  "model": "opus",\n  "env": { "FOO": "1" },\n  "permissions": { "allow": ["Bash(ls)"] }\n}\n';
  const env = setup(original);
  const r = lib.install({ configDir: env.configDir, scriptPath: env.scriptPath, now: new Date(2026, 9, 11, 9, 30, 5) });
  assert.match(path.basename(r.backup), /^settings\.json\.bak-20261011-093005$/);
  assert.equal(fs.readFileSync(r.backup, 'utf8'), original, 'backup is a byte-for-byte copy');
  const data = readJson(env.file);
  assert.deepEqual(Object.keys(data), ['model', 'env', 'permissions', 'statusLine']);
  assert.deepEqual(data.env, { FOO: '1' });
  assert.deepEqual(data.permissions, { allow: ['Bash(ls)'] });
});

test('backup names never overwrite an earlier backup in the same second', () => {
  const env = setup('{}');
  const now = new Date(2026, 9, 11, 10, 0, 0);
  lib.install({ configDir: env.configDir, scriptPath: env.scriptPath, now });
  lib.uninstall({ configDir: env.configDir, scriptPath: env.scriptPath, now });
  lib.install({ configDir: env.configDir, scriptPath: env.scriptPath, now });
  assert.equal(backupsOf(env.file).length, 3, 'three writes in one second give three distinct backups');
  assert.equal(new Set(backupsOf(env.file)).size, 3);
});

test('invalid JSON aborts without writing or backing up', () => {
  const broken = '{ "model": "opus", ';
  const env = setup(broken);
  assert.throws(() => lib.install({ configDir: env.configDir, scriptPath: env.scriptPath }), /not valid JSON/);
  assert.equal(fs.readFileSync(env.file, 'utf8'), broken);
  assert.equal(backupsOf(env.file).length, 0);
});

test('a JSON value that is not an object aborts without writing', () => {
  const env = setup('[1, 2, 3]');
  assert.throws(() => lib.install({ configDir: env.configDir, scriptPath: env.scriptPath }), /does not contain a JSON object/);
  assert.equal(fs.readFileSync(env.file, 'utf8'), '[1, 2, 3]');
});

test('a UTF-8 byte order mark is kept', () => {
  const env = setup('\uFEFF{"model":"opus"}');
  lib.install({ configDir: env.configDir, scriptPath: env.scriptPath });
  const raw = fs.readFileSync(env.file, 'utf8');
  assert.equal(raw.charCodeAt(0), 0xfeff);
  assert.equal(readJson(env.file).model, 'opus');
});

test('installing twice says so and changes nothing', () => {
  const env = setup();
  lib.install({ configDir: env.configDir, scriptPath: env.scriptPath });
  const before = fs.readFileSync(env.file, 'utf8');
  const r = lib.install({ configDir: env.configDir, scriptPath: env.scriptPath });
  assert.equal(r.changed, false);
  assert.match(r.message, /^Already installed/);
  assert.equal(fs.readFileSync(env.file, 'utf8'), before);
  assert.equal(backupsOf(env.file).length, 0);
});

test('an existing status line is chained, not replaced, and saved exactly', () => {
  const previous = { type: 'command', command: 'bash ~/my "status".sh $HOME \\x', padding: 1, refreshInterval: 5 };
  const env = setup(JSON.stringify({ theme: 'dark', statusLine: previous }, null, 2));
  const r = lib.install({ configDir: env.configDir, scriptPath: env.scriptPath });
  assert.equal(r.chained, true);
  const data = readJson(env.file);
  assert.deepEqual(data[HELPER_KEY], previous);
  assert.equal(data.theme, 'dark');
  assert.equal(data.statusLine.type, 'command');
  assert.equal(data.statusLine.padding, 0);
  assert.equal(data.statusLine.refreshInterval, 30);
  assert.match(data.statusLine.command, /^node ".*statusline\.js" --chain ".*"$/);
  assert.ok(data.statusLine.command.includes('--chain'));
});

test('the chained command survives a POSIX shell round trip', (t) => {
  const probe = spawnSync('sh', ['-c', 'printf %s "ok"'], { encoding: 'utf8' });
  if (probe.error || probe.status !== 0) {
    t.skip('no POSIX sh available');
    return;
  }
  const original = 'echo "a $HOME `date` \\n \'q\' \\\\ end"';
  const quoted = lib.escapeForDoubleQuotes(original);
  // The script goes through stdin: passing it as an argument would let Windows re-quote the backslashes.
  const out = spawnSync('sh', [], { encoding: 'utf8', input: `printf '%s' "${quoted}"` });
  assert.equal(out.stdout, original);
});

test('uninstall after a chained install restores the previous status line exactly', () => {
  const previous = { type: 'command', command: '/usr/bin/status --fast', padding: 2 };
  const original = JSON.stringify({ statusLine: previous, model: 'sonnet' }, null, 2) + '\n';
  const env = setup(original);
  lib.install({ configDir: env.configDir, scriptPath: env.scriptPath });
  const r = lib.uninstall({ configDir: env.configDir, scriptPath: env.scriptPath });
  assert.equal(r.changed, true);
  const data = readJson(env.file);
  assert.deepEqual(data, { statusLine: previous, model: 'sonnet' });
  assert.equal(HELPER_KEY in data, false);
  assert.deepEqual(Object.keys(data), ['statusLine', 'model']);
});

test('uninstall after a fresh install removes the status line and keeps other keys', () => {
  const env = setup('{"model":"opus"}');
  lib.install({ configDir: env.configDir, scriptPath: env.scriptPath });
  lib.uninstall({ configDir: env.configDir, scriptPath: env.scriptPath });
  assert.deepEqual(readJson(env.file), { model: 'opus' });
});

test('uninstall when CCUsageX is not installed writes nothing', () => {
  const original = '{"statusLine":{"type":"command","command":"my-own-thing"}}';
  const env = setup(original);
  const r = lib.uninstall({ configDir: env.configDir, scriptPath: env.scriptPath });
  assert.equal(r.changed, false);
  assert.equal(fs.readFileSync(env.file, 'utf8'), original);
  assert.equal(backupsOf(env.file).length, 0);
});

test('a status line changed by hand after install is not overwritten by --install or --uninstall', () => {
  const env = setup();
  lib.install({ configDir: env.configDir, scriptPath: env.scriptPath });
  const data = readJson(env.file);
  data[HELPER_KEY] = { type: 'command', command: 'old' };
  data.statusLine = { type: 'command', command: 'someone-else' };
  fs.writeFileSync(env.file, JSON.stringify(data, null, 2) + '\n');
  const before = fs.readFileSync(env.file, 'utf8');
  assert.throws(() => lib.install({ configDir: env.configDir, scriptPath: env.scriptPath }), /Run --uninstall first/);
  const r = lib.uninstall({ configDir: env.configDir, scriptPath: env.scriptPath });
  assert.equal(r.changed, false);
  assert.equal(fs.readFileSync(env.file, 'utf8'), before);
});

test('--dry-run reports the change and writes nothing', () => {
  const env = setup('{"model":"opus"}');
  const before = fs.readFileSync(env.file, 'utf8');
  const r = lib.install({ configDir: env.configDir, scriptPath: env.scriptPath, dryRun: true });
  assert.equal(r.dryRun, true);
  assert.equal(r.changed, true);
  assert.equal(r.planned.type, 'command');
  assert.equal(fs.readFileSync(env.file, 'utf8'), before);
  assert.equal(backupsOf(env.file).length, 0);
});

test('a missing helper script stops the install before anything is written', () => {
  const env = setup('{"model":"opus"}');
  const missing = path.join(TMP, 'nowhere', 'statusline.js');
  assert.throws(() => lib.install({ configDir: env.configDir, scriptPath: missing }), /Cannot find/);
  assert.equal(fs.readFileSync(env.file, 'utf8'), '{"model":"opus"}');
});

test('buildCommand uses forward slashes for Windows paths', () => {
  assert.equal(
    lib.buildCommand('C:\\Users\\me\\CCUsage\\scripts\\statusline.js', null),
    'node "C:/Users/me/CCUsage/scripts/statusline.js"',
  );
});

test('isOurs recognises the CCUsageX command from another checkout, but not unrelated commands', () => {
  assert.equal(lib.isOurs({ type: 'command', command: 'node "D:/old/CCUsage/scripts/statusline.js"' }, 'E:\\CCUsage\\scripts\\statusline.js'), true);
  assert.equal(lib.isOurs({ type: 'command', command: 'node "/home/me/tools/statusline.js"' }, '/x/CCUsage/scripts/statusline.js'), false);
  assert.equal(lib.isOurs(undefined, '/x'), false);
});

test('status reports none, installed, chained and other', () => {
  const env = setup();
  const opts = { configDir: env.configDir, scriptPath: env.scriptPath, dataDir: env.dataDir };
  assert.equal(lib.status(opts).state, 'none');

  lib.install({ configDir: env.configDir, scriptPath: env.scriptPath });
  let s = lib.status(opts);
  assert.equal(s.state, 'ccusagex');
  assert.equal(s.installed, true);
  assert.equal(s.chainedCommand, null);
  assert.equal(s.limitsFiles, null);
  assert.match(lib.formatStatus(s), /CCUsageX is installed/);

  fs.mkdirSync(path.join(env.dataDir, 'limits'), { recursive: true });
  fs.writeFileSync(path.join(env.dataDir, 'limits', 'abc.json'), '{}');
  s = lib.status(opts);
  assert.equal(s.limitsFiles, 1);

  lib.uninstall({ configDir: env.configDir, scriptPath: env.scriptPath });
  fs.writeFileSync(env.file, '{"statusLine":{"type":"command","command":"other"}}');
  assert.equal(lib.status(opts).state, 'other');

  fs.writeFileSync(env.file, '{ broken');
  const bad = lib.status(opts);
  assert.equal(bad.state, 'invalid');
  assert.match(lib.formatStatus(bad), /cannot read settings/);
});

test('status after a chained install shows the chained command', () => {
  const env = setup('{"statusLine":{"type":"command","command":"my-status"}}');
  lib.install({ configDir: env.configDir, scriptPath: env.scriptPath });
  const s = lib.status({ configDir: env.configDir, scriptPath: env.scriptPath, dataDir: env.dataDir });
  assert.equal(s.state, 'ccusagex');
  assert.equal(s.chainedCommand, 'my-status');
});

test('CLI: --status reads the config dir from --config-dir and writes nothing', () => {
  const env = setup('{"model":"opus"}');
  const before = fs.readFileSync(env.file, 'utf8');
  const out = spawnSync(process.execPath, [SCRIPT, '--status', '--config-dir', env.configDir], {
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_CONFIG_DIR: path.join(TMP, 'should-not-be-used'), CCU_DATA_DIR: env.dataDir },
  });
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /Status line   : not set/);
  assert.ok(out.stdout.includes(env.configDir), 'settings path comes from --config-dir');
  assert.equal(fs.readFileSync(env.file, 'utf8'), before);
});

test('CLI: CLAUDE_CONFIG_DIR is used when --config-dir is absent', () => {
  const env = setup();
  const out = spawnSync(process.execPath, [SCRIPT, '--status'], {
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_CONFIG_DIR: env.configDir, CCU_DATA_DIR: env.dataDir },
  });
  assert.equal(out.status, 0, out.stderr);
  assert.ok(out.stdout.includes(env.configDir));
});

test('CLI: bad arguments exit with code 2', () => {
  const noAction = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
  assert.equal(noAction.status, 2);
  assert.match(noAction.stderr, /Usage:/);

  const both = spawnSync(process.execPath, [SCRIPT, '--install', '--status'], { encoding: 'utf8' });
  assert.equal(both.status, 2);

  const unknown = spawnSync(process.execPath, [SCRIPT, '--frobnicate'], { encoding: 'utf8' });
  assert.equal(unknown.status, 2);

  const noDir = spawnSync(process.execPath, [SCRIPT, '--status', '--config-dir'], { encoding: 'utf8' });
  assert.equal(noDir.status, 2);
});

test('CLI: invalid settings.json makes --install exit 1 and leave the file alone', () => {
  const env = setup('{ not json');
  const out = spawnSync(process.execPath, [SCRIPT, '--install', '--config-dir', env.configDir], {
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_CONFIG_DIR: '', CCU_DATA_DIR: env.dataDir },
  });
  // The real helper script (scripts/statusline.js) may or may not exist yet. Either way nothing is written.
  assert.notEqual(out.status, 0);
  assert.equal(fs.readFileSync(env.file, 'utf8'), '{ not json');
  assert.equal(backupsOf(env.file).length, 0);
});
