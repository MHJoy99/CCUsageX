<div align="center">

<img src="assets/hero-banner.svg" alt="CCUsageX — a local dashboard that shows every prompt, token and API-equivalent dollar of your Claude Code usage" width="100%">

# CCUsageX — Claude Code usage dashboard

**See every prompt, token and dollar of your Claude Code usage.**
A local, zero-dependency web dashboard that reads Claude Code's own logs and shows requests, models, tokens,
cache hits, response times, tools, sessions and the API-equivalent cost of each prompt you type.

[![Live demo](https://img.shields.io/badge/live%20demo-open-5b3df5?style=flat-square)](https://mhjoy99.github.io/CCUsageX/demo/)
[![License: MIT](https://img.shields.io/badge/license-MIT-2a78d6?style=flat-square)](LICENSE)
![Node 18+](https://img.shields.io/badge/node-%E2%89%A518-1baf7a?style=flat-square)
![Zero dependencies](https://img.shields.io/badge/dependencies-0-1baf7a?style=flat-square)
![Local only](https://img.shields.io/badge/data-stays%20on%20your%20machine-eb6834?style=flat-square)

[**Live demo**](https://mhjoy99.github.io/CCUsageX/demo/) ·
[**Website**](https://mhjoy99.github.io/CCUsageX/) ·
[Quick start](#quick-start) ·
[How it works](#how-it-works) ·
[FAQ](#faq) ·
[Docs](docs/ARCHITECTURE.md)

</div>

---

## What is CCUsageX?

**CCUsageX is a free, open-source dashboard for [Claude Code](https://docs.claude.com/en/docs/claude-code) usage that runs
entirely on your computer.** It reads the transcript files Claude Code already writes to `~/.claude/projects`, works out
exactly which API requests each of your prompts triggered (including subagents), and shows the tokens, cache savings,
response time and **API-equivalent cost** of every one, in a fast web UI at `http://127.0.0.1:3020`.
Nothing is uploaded anywhere, and it needs nothing but Node.js 18+.

<img src="assets/kpi-strip.svg" alt="Example totals: 1,284 requests, 96 prompts, 182.4M tokens, $87.42 API-equivalent, 96.1% cache hit rate" width="100%">

## Features

<table>
<tr>
<td width="50%"><img src="assets/feature-prompts.svg" alt="Every prompt you type, with its requests, cost, duration and model" width="100%"></td>
<td width="50%"><img src="assets/feature-cost.svg" alt="Cost per prompt split by output, thinking, cache write, cache read and input" width="100%"></td>
</tr>
<tr>
<td width="50%"><img src="assets/feature-tokens-cache.svg" alt="Token mix and cache hit rate, with how much caching saved" width="100%"></td>
<td width="50%"><img src="assets/feature-speed.svg" alt="Output speed and cost by model" width="100%"></td>
</tr>
</table>

- **Every prompt, priced.** Click any prompt to read it in full and see each API request it caused, including
  subagents, with tokens and cost per request.
- **Real token accounting.** Input, output, cache write (5-minute and 1-hour), cache read and thinking tokens,
  deduplicated exactly the way Claude Code writes them (one line per content block, one request each).
- **API-equivalent cost.** Priced at Anthropic list prices from an editable [`config.json`](config.json), including the
  cache-write multipliers, Haiku long-context tier and fast mode. Useful on a Pro/Max subscription to see what your
  usage is worth.
- **Cache savings.** Cache hit rate and the dollars caching saved you.
- **Plan usage limits.** Your 5-hour session and 7-day weekly limits on Pro and Max, with reset times, a pace
  projection and a small history. Read from Claude Code's status line; see [Plan usage limits](#plan-usage-limits).
- **Models, effort, speed.** Output tokens per second, response time (typical and slowest 5%), effort levels and
  Claude Code versions.
- **Tools, sessions, projects.** Which tools ran how often, per-session and per-project breakdowns.
- **Live view, in real time.** A mission-control tab that streams what Claude Code is doing as it happens:
  current status with a ticking timer, the main agent and its subagents, tool calls as live swimlanes, a
  scrolling activity chart, context-window gauge, rolling cost and token counters, and an event feed.
  Events reach the browser a few milliseconds after Claude Code writes them (file watcher + Server-Sent Events).
- **Keeps your history.** Claude Code deletes old transcripts after 30 days by default; CCUsageX keeps its own copy.
- **Filters and export.** Time range, model, project, session, main vs subagent, full-text search, CSV export.
- **Honest numbers.** Independently verified against a separate re-implementation and against ccusage token counts;
  known gaps in Claude Code's logs are labelled in the UI ([details](docs/FAQ.md)).

## Quick start

<img src="assets/quickstart-terminal.svg" alt="git clone https://github.com/MHJoy99/CCUsageX, then node server.js" width="100%">

You need **Node.js 18 or newer**. No `npm install` step: there are no dependencies.

```bash
git clone https://github.com/MHJoy99/CCUsageX.git
cd CCUsageX
node server.js
```

Open **http://127.0.0.1:3020**. Or run it straight from GitHub without cloning:

```bash
npx github:MHJoy99/CCUsageX
```

Want to look around first? Try the [**live demo**](https://mhjoy99.github.io/CCUsageX/demo/) (fictional data), or run
the demo locally with `npm run demo`.

### Windows: open it like a desktop app

Double-click **`Open-CCUsageX.cmd`**. It starts the server hidden and opens the dashboard in its own Edge app window
(no tabs, no address bar). `Close-CCUsageX.cmd` stops both. For a Start Menu entry and more, see
[`CCUsageX.ps1`](CCUsageX.ps1) (`-Action start|stop|status|restart`).

### macOS / Linux

`node server.js`, then open http://127.0.0.1:3020. To keep it running in the background, use your usual tool
(`launchd`, `systemd --user`, `pm2`, `tmux`).

## Plan usage limits

<img src="assets/plan-limits.svg" alt="Example plan limits: session 5-hour window 23% used, resets in 2h 14m; weekly 7-day window 41% used, resets Thursday" width="100%">

CCUsageX can show how much of your Claude subscription limit you have used: the **5-hour session** window and the
**7-day weekly** window, with when each one resets. Claude Code reports these two percentages to its status line, so
CCUsageX reads them from there. It does not log in, does not call any Claude endpoint and does not read your
credentials. Set it up once, from the repository folder:

```bash
npm run statusline:install        # or: node scripts/install-statusline.js --install
node scripts/install-statusline.js --status
npm run statusline:uninstall      # restores the status line you had before
```

The installer edits only the `statusLine` entry of your Claude Code `settings.json` (`~/.claude/settings.json`, or
`$CLAUDE_CONFIG_DIR/settings.json`):

- It copies the file to `settings.json.bak-<YYYYMMDD-HHMMSS>` first, and leaves every other setting as it was.
- If you already have a status line, it keeps running. CCUsageX runs it and shows its output, and saves your previous
  setting under `ccusagexPreviousStatusLine`, so `--uninstall` puts it back exactly.
- An invalid `settings.json` stops the installer before anything is written.
- `--dry-run` shows the change without writing, and `--config-dir <dir>` picks another Claude Code folder.

Things to know:

- **Pro and Max only.** Claude Code reports these limits for claude.ai subscriptions. API-key and other plans show
  no limit data.
- **Appears after the first reply.** Claude Code sends the numbers with its first response in a session, so the
  dashboard shows the setup state until you send a message.
- **Terminal app, not the VS Code panel.** Status lines run in the terminal `claude` app. In testing, the VS Code panel
  did not report limits, so if you work mostly in VS Code, send a message in terminal `claude` now and then to refresh the numbers.
  The card marks values older than 15 minutes as stale and shows when they were last updated.
- **Overall windows only.** Claude Code does not report separate Opus or Sonnet limits, so CCUsageX does not show them.
- **Local data only.** Snapshots are written to `~/.ccusagex/limits/` (or `$CCU_DATA_DIR/limits/`). Nothing is sent
  anywhere. The status line runs on each reply and about every 30 seconds. It is built to finish in under 100 ms.

Details, including the data fields and the burn-rate projection, are in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#plan-usage-limits).

## Screenshots

<div align="center">
<img src="docs/screenshots/dashboard-light.png" alt="CCUsageX dashboard, light theme: KPI tiles, cost per prompt, speed by model, tokens per prompt, activity feed" width="100%">
<br><br>
<img src="docs/screenshots/dashboard-dark.png" alt="CCUsageX dashboard, dark theme" width="49%">
<img src="docs/screenshots/prompt-drawer.png" alt="Prompt detail drawer: the full prompt text and every request it triggered, with token and cost breakdown" width="49%">
<br><br>
<img src="docs/screenshots/live.png" alt="CCUsageX Live view: real-time status, agent tree with subagents, tool-call swimlanes, streaming activity chart, context gauge and event feed" width="100%">
<br><sub>All screenshots use fictional demo data. Try the Live tab in the <a href="https://mhjoy99.github.io/CCUsageX/demo/#view=live">live demo</a>.</sub>
</div>

## How it works

<img src="assets/architecture.svg" alt="Claude Code writes transcripts to ~/.claude/projects; CCUsageX scans, dedupes, attributes and prices them, keeps a local store, and serves the dashboard on 127.0.0.1" width="100%">

1. Claude Code (CLI or IDE extension) writes every conversation to `~/.claude/projects/**/*.jsonl`.
2. CCUsageX reads those files **read-only**, incrementally, every few seconds.
3. Each API response is counted once (by message id + request id) and attributed to the human prompt that caused it.
   Subagent work rolls up to the parent prompt.
4. Requests are priced with [`config.json`](config.json) and kept in `~/.ccusagex/store.json`.
5. A small built-in HTTP server serves the dashboard and a JSON API on `127.0.0.1` only.

Full details, including the record format, dedupe rules and the HTTP API, are in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## How it compares

| | **CCUsageX** | [ccusage](https://github.com/ryoppippi/ccusage) | [Claude-Code-Usage-Monitor](https://github.com/Maciek-roboblog/Claude-Code-Usage-Monitor) | [Sniffly](https://github.com/chiphuyen/sniffly) |
|---|---|---|---|---|
| Interface | Local web dashboard | CLI tables / JSON | Live terminal UI | Local web dashboard |
| Cost per **prompt**, with the prompt text | ✅ | — | — | Partial |
| Subagent requests attributed to the parent prompt | ✅ | — | — | — |
| Cache hit rate and cache savings | ✅ | Tokens only | — | — |
| Response time and output speed by model | ✅ | — | Burn rate | — |
| Keeps history after Claude Code's 30-day cleanup | ✅ | — | — | — |
| Other coding agents (Codex, OpenCode, …) | — | ✅ | — | — |
| Live plan-limit / quota tracking | ✅ | Partial | ✅ | — |
| Dependencies | None | npm package | Python package | Python package |

These tools work well together. ccusage is excellent for quick terminal reports across many agents, and the
Usage Monitor is great for watching plan limits live.

## Configuration

Everything is in [`config.json`](config.json):

| Key | Default | Meaning |
|---|---|---|
| `startDate` | `"all"` | Only count usage on/after this local date (`"YYYY-MM-DD"`), or `"all"` |
| `port` | `3020` | Dashboard port (bound to `127.0.0.1`) |
| `scanIntervalSeconds` | `5` | How often transcripts are re-scanned |
| `pricing.models` | Anthropic list prices | USD per million tokens: `input`, `output`, `cacheRead`, optional `fastMultiplier`, `longContext` |

Environment variables: `PORT`, `CLAUDE_CONFIG_DIR` (where Claude Code keeps its data, default `~/.claude`),
`CCU_DATA_DIR` (where CCUsageX keeps its store, default `~/.ccusagex`), `CCU_START_DATE`.

## Privacy

- Runs only on your machine and listens on `127.0.0.1` only (requests with a foreign `Host` header are rejected).
- Makes **no outbound network requests**, has no telemetry and no dependencies.
- Reads `~/.claude` **read-only**. Its own copy, which includes your prompt text, is stored in `~/.ccusagex/`.
  Delete that folder to remove it.
- The optional plan-limits status line writes only its snapshots under `~/.ccusagex/limits/`. Its installer edits
  only the `statusLine` entry in Claude Code's `settings.json`, after making a backup.

## FAQ

**How do I see my Claude Code token usage?**
Run `node server.js` in this repo and open http://127.0.0.1:3020. CCUsageX reads Claude Code's logs and shows tokens
per prompt, request, model, session and day.

**How much does my Claude Code usage cost?**
CCUsageX prices every request at Anthropic's API list prices ("API-equivalent cost"). If you're on a Pro or Max
subscription, that's the value of your usage, not money you were charged.

**Where does Claude Code store its logs?**
In `~/.claude/projects/<project>/<session>.jsonl` (on Windows, `%USERPROFILE%\.claude\projects`). Subagent
transcripts sit in a `subagents` folder next to the session file.

**Does CCUsageX send my data anywhere?**
No. It has no network code beyond its own local server, which only listens on `127.0.0.1`.

**Why do some subagent requests show very few output tokens?**
For many subagent requests Claude Code only writes the usage from the start of the stream, so output and thinking
tokens are a lower bound. CCUsageX flags these requests and labels the affected totals instead of guessing.

**How is it different from ccusage?**
ccusage is a CLI that reports usage across many coding agents. CCUsageX is a web dashboard focused on Claude Code that
goes per prompt: prompt text, subagent attribution, cache savings, response times and persistent history.

More answers in [docs/FAQ.md](docs/FAQ.md).

## Development

```bash
npm test          # 38 unit tests on synthetic transcripts (node:test, no deps)
npm run verify    # independent re-count of your real logs vs. the running dashboard
npm run demo      # dashboard on generated demo data
```

See [CONTRIBUTING.md](CONTRIBUTING.md). Bugs and ideas are welcome in
[issues](https://github.com/MHJoy99/CCUsageX/issues).

## License

[MIT](LICENSE) © MHJoy99. CCUsageX is an independent project and is not affiliated with or endorsed by Anthropic.
"Claude" and "Claude Code" are trademarks of Anthropic.
