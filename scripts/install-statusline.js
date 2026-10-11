#!/usr/bin/env node
'use strict';

// Adds, removes or inspects the Claude Code status line hook that feeds CCUsageX plan usage limits.
//
//   node scripts/install-statusline.js --install | --uninstall | --status [--dry-run] [--config-dir <dir>]
//
// Edits <config dir>/settings.json only. Zero dependencies, Node 18+.

const fs = require('fs');
const os = require('os');
const path = require('path');

const HELPER_KEY = 'ccusagexPreviousStatusLine';
const REFRESH_INTERVAL = 30;
const DEFAULT_SCRIPT = path.join(__dirname, 'statusline.js');

const USAGE = `Usage: node scripts/install-statusline.js <action> [options]

Actions (choose one):
  --install       Point Claude Code's status line at scripts/statusline.js. If you already have a
                  status line, it keeps running through --chain and is saved for --uninstall.
  --uninstall     Remove CCUsageX and restore the status line you had before (if any).
  --status        Show what is configured.

Options:
  --dry-run            Show what would change; write nothing.
  --config-dir <dir>   Claude Code config folder. Default: $CLAUDE_CONFIG_DIR, else ~/.claude.
  -h, --help           Show this help.
`;

function toSlash(p) {
  return String(p).replace(/\\/g, '/');
}

// The chained command is run by the shell Claude Code uses (POSIX sh, Git Bash on Windows), inside double quotes.
function escapeForDoubleQuotes(s) {
  return s.replace(/[\\"$`]/g, '\\$&');
}

function buildCommand(scriptPath, previous) {
  let cmd = `node "${toSlash(scriptPath)}"`;
  if (previous) cmd += ` --chain "${escapeForDoubleQuotes(previous.command)}"`;
  return cmd;
}

function ourStatusLine(command) {
  return { type: 'command', command, padding: 0, refreshInterval: REFRESH_INTERVAL };
}

function isCommandObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && typeof v.command === 'string';
}

function isOurs(statusLine, scriptPath = DEFAULT_SCRIPT) {
  if (!isCommandObject(statusLine)) return false;
  const cmd = toSlash(statusLine.command);
  if (cmd.includes(toSlash(scriptPath))) return true;
  // Same CCUsageX script from another checkout (the folder was moved or renamed).
  return /scripts\/statusline\.js/.test(cmd) && /ccusage/i.test(cmd);
}

function settingsFile(configDir) {
  return path.join(configDir, 'settings.json');
}

function readSettings(file) {
  if (!fs.existsSync(file)) return { exists: false, bom: false, data: {} };
  let text = fs.readFileSync(file, 'utf8');
  const bom = text.charCodeAt(0) === 0xfeff;
  if (bom) text = text.slice(1);
  if (text.trim() === '') return { exists: true, bom, data: {} };
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error(`${file} is not valid JSON (${e.message}). Nothing was changed. Fix the file, then run again.`);
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`${file} does not contain a JSON object. Nothing was changed.`);
  }
  return { exists: true, bom, data };
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function stamp(d) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

// Writes settings.json (2-space JSON, trailing newline). A copy of the old file is kept first.
function writeSettings(file, data, bom, now) {
  let backup = null;
  if (fs.existsSync(file)) {
    const base = `${file}.bak-${stamp(now)}`;
    backup = base;
    for (let n = 2; fs.existsSync(backup); n++) backup = `${base}-${n}`;
    fs.copyFileSync(file, backup);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, (bom ? '﻿' : '') + JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
  return backup;
}

function hasKey(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function install({ configDir, scriptPath = DEFAULT_SCRIPT, dryRun = false, now = new Date() }) {
  const file = settingsFile(configDir);
  if (!fs.existsSync(scriptPath)) {
    throw new Error(`Cannot find ${scriptPath}. Nothing was changed.`);
  }
  if (/["$`\r\n]/.test(toSlash(scriptPath))) {
    throw new Error(`The path ${scriptPath} has a quote, $, backtick or line break, which cannot go in a command. Move the folder, then run again.`);
  }
  const s = readSettings(file);
  const data = s.data;
  const helperSaved = hasKey(data, HELPER_KEY);
  const cur = data.statusLine;
  const present = cur !== undefined && cur !== null;
  let message;
  let chained = false;

  if (present && isOurs(cur, scriptPath)) {
    let previous = null;
    if (helperSaved) {
      previous = data[HELPER_KEY];
      if (!isCommandObject(previous)) {
        throw new Error(`${HELPER_KEY} in ${file} is not a status line. Nothing was changed; fix or remove that key.`);
      }
    }
    const command = buildCommand(scriptPath, previous);
    if (cur.command === command) {
      return { changed: false, file, backup: null, message: `Already installed: ${command}` };
    }
    data.statusLine = ourStatusLine(command);
    message = 'Updated the path to scripts/statusline.js in statusLine.';
    chained = previous !== null;
  } else if (present) {
    if (helperSaved) {
      throw new Error(`statusLine in ${file} was changed after CCUsageX was installed, and ${HELPER_KEY} is still there. ` +
        'Nothing was changed. Run --uninstall first, then --install again.');
    }
    if (!isCommandObject(cur)) {
      throw new Error(`The existing statusLine in ${file} is not a command, so it cannot be chained. Nothing was changed.`);
    }
    data[HELPER_KEY] = cur;
    data.statusLine = ourStatusLine(buildCommand(scriptPath, cur));
    chained = true;
    message = `Installed. Your existing status line still runs (chained with --chain); it is saved as ${HELPER_KEY}.`;
  } else {
    if (helperSaved) {
      throw new Error(`${HELPER_KEY} is in ${file} but statusLine is missing. Nothing was changed. Remove that key, then run again.`);
    }
    data.statusLine = ourStatusLine(buildCommand(scriptPath, null));
    message = 'Installed.';
  }

  if (dryRun) {
    return { changed: true, dryRun: true, file, backup: null, chained, planned: data.statusLine, message };
  }
  const backup = writeSettings(file, data, s.bom, now);
  return { changed: true, file, backup, chained, planned: data.statusLine, message, created: !s.exists };
}

function uninstall({ configDir, scriptPath = DEFAULT_SCRIPT, dryRun = false, now = new Date() }) {
  const file = settingsFile(configDir);
  const s = readSettings(file);
  const data = s.data;
  const helperSaved = hasKey(data, HELPER_KEY);
  const ours = isOurs(data.statusLine, scriptPath);
  let message;

  if (helperSaved) {
    if (!ours) {
      return {
        changed: false, file, backup: null,
        message: `statusLine is not CCUsageX's, so it was left alone. ${HELPER_KEY} is still in settings.json; ` +
          'delete it by hand if you no longer need it.',
      };
    }
    const previous = data[HELPER_KEY];
    if (!isCommandObject(previous)) {
      throw new Error(`${HELPER_KEY} in ${file} is not a status line, so the previous status line cannot be restored. Nothing was changed.`);
    }
    data.statusLine = previous;
    delete data[HELPER_KEY];
    message = 'Removed CCUsageX and restored your previous status line.';
  } else if (ours) {
    delete data.statusLine;
    message = 'Removed the CCUsageX status line.';
  } else {
    return { changed: false, file, backup: null, message: `CCUsageX is not installed in ${file}. Nothing to do.` };
  }

  if (dryRun) {
    return { changed: true, dryRun: true, file, backup: null, planned: data.statusLine === undefined ? null : data.statusLine, message };
  }
  const backup = writeSettings(file, data, s.bom, now);
  return { changed: true, file, backup, planned: data.statusLine === undefined ? null : data.statusLine, message };
}

function status({ configDir, scriptPath = DEFAULT_SCRIPT, dataDir }) {
  const file = settingsFile(configDir);
  const limitsDir = path.join(dataDir, 'limits');
  let limitsFiles = null;
  try {
    limitsFiles = fs.readdirSync(limitsDir).filter((f) => f.endsWith('.json')).length;
  } catch {
    limitsFiles = null;
  }
  const info = {
    settingsFile: file,
    settingsExists: fs.existsSync(file),
    scriptPath,
    scriptExists: fs.existsSync(scriptPath),
    limitsDir,
    limitsFiles,
    state: 'none',
    command: null,
    chainedCommand: null,
    helperSaved: false,
    installed: false,
  };
  let s;
  try {
    s = readSettings(file);
  } catch (e) {
    info.state = 'invalid';
    info.error = e.message;
    return info;
  }
  const cur = s.data.statusLine;
  info.helperSaved = hasKey(s.data, HELPER_KEY);
  if (cur === undefined || cur === null) {
    info.state = 'none';
  } else if (isOurs(cur, scriptPath)) {
    info.state = 'ccusagex';
    info.installed = true;
    info.command = cur.command;
    if (isCommandObject(s.data[HELPER_KEY])) info.chainedCommand = s.data[HELPER_KEY].command;
  } else {
    info.state = 'other';
    info.command = typeof cur === 'object' && typeof cur.command === 'string' ? cur.command : JSON.stringify(cur);
  }
  return info;
}

function formatStatus(info) {
  const lines = [];
  lines.push(`Settings file : ${info.settingsFile} (${info.settingsExists ? 'found' : 'missing'})`);
  if (info.state === 'invalid') {
    lines.push(`Status line   : cannot read settings: ${info.error}`);
  } else if (info.state === 'ccusagex') {
    lines.push('Status line   : CCUsageX is installed');
    lines.push(`  command     : ${info.command}`);
    if (info.chainedCommand) lines.push(`  chains to   : ${info.chainedCommand}`);
  } else if (info.state === 'other') {
    lines.push('Status line   : set to another command (not CCUsageX)');
    lines.push(`  command     : ${info.command}`);
    if (info.helperSaved) lines.push(`  note        : ${HELPER_KEY} is saved; --uninstall will not touch this status line`);
  } else {
    lines.push('Status line   : not set');
  }
  lines.push(`Helper script : ${info.scriptPath} (${info.scriptExists ? 'found' : 'MISSING'})`);
  lines.push(`Limits data   : ${info.limitsDir} (${info.limitsFiles === null ? 'not created yet' : `${info.limitsFiles} session file(s)`})`);
  if (!info.installed && info.state !== 'invalid') {
    lines.push('');
    lines.push('To set it up: npm run statusline:install');
  }
  return lines.join('\n');
}

function main(argv = process.argv.slice(2), env = process.env, log = console.log, errLog = console.error) {
  let action = null;
  let dryRun = false;
  let configDir = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--install' || a === '--uninstall' || a === '--status') {
      if (action) {
        errLog('Choose only one of --install, --uninstall or --status.');
        return 2;
      }
      action = a.slice(2);
    } else if (a === '--dry-run') {
      dryRun = true;
    } else if (a === '--config-dir') {
      configDir = argv[++i];
      if (!configDir) {
        errLog('--config-dir needs a folder.');
        return 2;
      }
    } else if (a.startsWith('--config-dir=')) {
      configDir = a.slice('--config-dir='.length);
    } else if (a === '-h' || a === '--help') {
      log(USAGE);
      return 0;
    } else {
      errLog(`Unknown argument: ${a}`);
      errLog(USAGE);
      return 2;
    }
  }
  if (!action) {
    errLog(USAGE);
    return 2;
  }

  const dir = path.resolve(configDir || env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'));
  const dataDir = path.resolve(env.CCU_DATA_DIR || path.join(os.homedir(), '.ccusagex'));

  try {
    if (action === 'status') {
      log(formatStatus(status({ configDir: dir, dataDir })));
      return 0;
    }
    const result = action === 'install'
      ? install({ configDir: dir, dryRun })
      : uninstall({ configDir: dir, dryRun });
    if (!result.dryRun || !result.changed) log(result.message);
    if (result.dryRun) {
      log(`[dry-run] Nothing written. ${result.changed ? `Would write ${result.file}` : 'No change needed.'}`);
      if (result.planned !== undefined && result.planned !== null) {
        log(`[dry-run] statusLine would be: ${JSON.stringify(result.planned)}`);
      }
      return 0;
    }
    if (result.changed) {
      log(`File       : ${result.file}`);
      if (result.backup) log(`Backup     : ${result.backup}`);
      else if (result.created) log('Created    : new settings.json (there was none before)');
      if (action === 'install') {
        log('Plan limits appear after Claude\'s first reply in a session (Pro and Max plans only).');
      }
    }
    return 0;
  } catch (e) {
    errLog(`Error: ${e.message}`);
    return 1;
  }
}

module.exports = {
  install,
  uninstall,
  status,
  formatStatus,
  buildCommand,
  isOurs,
  escapeForDoubleQuotes,
  readSettings,
  main,
  HELPER_KEY,
  DEFAULT_SCRIPT,
};

if (require.main === module) {
  process.exitCode = main();
}
