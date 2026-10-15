# Changelog

All notable changes to CCUsageX are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.4.1] - 2026-10-16

### Fixed

- Heavy hours no longer count a weekly snapshot that flickers down and back up (82, 81, 82) as new usage. Busy hours
  have more snapshots, so this made them look heavier than they were. The weekly percentage now uses its running
  maximum within each week.
- After a hard stop and restart, a request whose final usage line had not been saved yet now picks it up when the
  transcript is re-read, instead of keeping the stream-start output count.
- Edits to the `widget` block in `config.json` apply without restarting CCUsageX.
- Heavy hours skip any interval whose model has no price, so unpriced requests do not skew the measured band.
- Heavy hours and the US band validate `timeZone` and the manual range in `config.json`. Invalid values are reported
  instead of breaking the widget.
- The widget survives a bad time zone and network timeouts.
- The reset countdown is correct on a day when daylight saving time starts or ends.
- The installer removes only a WebView2 plugin it installed itself, and places the skin near the top-right of the
  primary screen on first run.

### Changed

- README covers the installer on Windows PowerShell 5.1 and PowerShell 7.
- Docs link the sources of the plan-change dates, state that `minDays` applies only to `auto` mode, and use synthetic
  values in every example.

## [1.4.0] - 2026-10-15

### Added

- **Desktop widget "Claude Pulse"** (`public/widget.html`): a compact glass widget with a 24-hour peak clock, 5-hour and
  weekly rings, per-model weekly limits, burn pace, settings gear, compact mode and an offline state. Works in any
  browser at `http://127.0.0.1:3020/widget.html`. See [docs/WIDGET.md](docs/WIDGET.md).
- **Measured heavy hours.** `GET /api/burn-hours` finds the hours of the day when your weekly limit drains faster per
  dollar of work (per-account weekly percentage against API-equivalent cost, per local hour, 3-hour smoothing, 1.15x
  baseline, at least 3 days of data), alongside an informational US busy-hours band.
- **`widget` block in `config.json`** (`usPeak` and `heavyHours` settings).
- **Rainmeter skin** (`integrations/rainmeter/ClaudePulse/`) and **installer** `scripts/install-widget.ps1`: checks
  Rainmeter, installs the pinned and SHA256-verified WebView2 plugin, copies and activates the skin, optional
  `-StartWithWindows`, `-WhatIf` dry run and `-Uninstall`. No admin rights.

### Changed

- The widget shows times in your computer's local time zone.
- README, FAQ and architecture notes cover the widget.

## [1.3.1] - 2026-10-13

### Fixed

- **Plan limits no longer show "auto-refresh failed" for minutes after a one-off error.** After a first or second failed
  `/usage` probe in a row the server retries after 15 seconds instead of waiting the full 2 (or 15) minute interval.
  The back-off to 15 minutes after three failures is unchanged.
- Probe failures are now diagnosable: each one is logged to the server's stderr with the last line of `claude`'s own
  error output. The error shown on the page stays short and path-free.
- Tests: the `/usage` fixture's reset times are shifted relative to now, so the probe tests no longer fail once the
  captured 5-hour window has passed.

### Changed

- Windows launcher: opens the dashboard in Google Chrome (Edge app window, then the default browser, as fallbacks) and
  runs the server in a lightweight mode (smaller Node heap, size-optimised GC, below-normal priority), roughly halving RAM.
- FAQ: how to start the server hidden at logon, and what to do about "auto-refresh failed".

## [1.3.0] - 2026-10-11

### Added

- **Plan limits refresh automatically.** The server runs Claude Code's documented `/usage` report in the background
  (`claude -p` with the prompt `/usage`: a local command, no model tokens, no transcript, about 3 seconds). It runs once
  at start, then every 2 minutes while the dashboard is being viewed and every 15 minutes otherwise, and backs off
  after repeated failures. This works for the VS Code panel as well as the terminal.
- **Per-model weekly limits** are shown under the two gauges when Claude Code reports them, with the active ("binding")
  limit tagged, and in the header pill's tooltip.
- A refresh button and an "Updated ... auto-refresh every 2 min" line on the Plan limits card. `GET /api/limits?refresh=1`
  runs a probe on demand (at most one per 20 seconds).
- `/api/limits` payload additions: `windows.scoped`, `isActive` and `severity`, `extraUsage`, `source` (`usage` or
  `statusline`) and `probe`.
- `CCU_CLAUDE_BIN` (path to the `claude` binary, a `.js` script or a JSON array) and `CCU_LIMITS_PROBE=0` (turn it off).

### Changed

- The status line is now optional. It still gives instant updates in terminal sessions, and the source that changed most
  recently wins.

## [1.2.0] - 2026-10-11

### Added

- **Plan usage limits** for Pro and Max: the 5-hour session and 7-day weekly windows with reset times, a pace
  projection and a short history. The numbers come from the `rate_limits` field that Claude Code passes to its status
  line. They are not read from the transcripts or from any undocumented endpoint.
- `scripts/install-statusline.js` (`--install`, `--uninstall`, `--status`, `--dry-run`, `--config-dir`): edits only the
  `statusLine` entry in `settings.json` after backing it up. An existing status line keeps running through `--chain`,
  and `--uninstall` restores it exactly. Exposed as `npm run statusline:install` and `npm run statusline:uninstall`.
- `scripts/statusline.js`, the status line helper that writes snapshots to `~/.ccusagex/limits/`.
- `GET /api/limits`, and a `limits` event on the Server-Sent Events stream.

## [1.1.0] - 2026-10-11

### Added

- **Live view**: a real-time tab streaming what Claude Code is doing, over Server-Sent Events fed by a file watcher
  (events arrive within milliseconds): status with a running timer, rolling cost and token counters, a streaming
  activity chart, the agent constellation with subagents, tool-call swimlanes, context gauge, current turn and event
  feed. Resume via `Last-Event-ID`, polling fallback, simulated live session in the GitHub Pages demo.
- `scripts/live-stress.js`: real-time synthetic load (main session plus N background subagents) for testing.

### Fixed

- Background subagents are now marked done: Claude Code ends them with a `SubagentHandback` tool call and a parent
  `<task-notification>` (completed, killed or failed) instead of `end_turn`, so they no longer show as
  "generating" forever.
- Quiet agents become idle after 3 minutes generating (15 minutes in a tool); never-ending subagents are closed as
  unknown after 10 more minutes; a restart rebuilds the live state of recent transcripts.
- The Live view stays legible with any number of subagents: up to six active nodes, "+N more", a Finished tray with
  status, duration and cost, scrollable tool lanes labelled by task, and compact numbers on narrow screens.
- The current turn keeps showing the prompt you typed when an injected turn (task notification) arrives, and injected
  `<browser_instruction>` notices are stripped from prompt text.

## [1.0.0] - 2026-10-11

### Added

- Local dashboard served on `127.0.0.1` that reads Claude Code's transcripts under `~/.claude/projects`, read-only.
- Incremental scanner that reads only new bytes, and re-reads a transcript that was rewritten or truncated without
  double counting.
- Request deduplication by message id and request id, with each usage field taken at its largest value across lines.
- Prompt attribution: typed prompts, subagent work, harness-started turns rolled up into the prompt that caused them,
  and messages typed while a turn was running.
- API-equivalent cost from `config.json`, with 5-minute and 1-hour cache-write multipliers, a long-context price tier,
  a fast-mode multiplier, and model-version matching. Models without a price are flagged as unpriced rather than
  guessed.
- Cache hit rate, thinking tokens, response time (average, p50 and p95), and tokens per second by model.
- Partial-usage flag for requests whose usage was only recorded at the start of the response.
- Views for overview, cost, tokens, speed, models, prompts, tools, sessions and requests, with drill-down from a prompt
  to every request it triggered, and full request detail.
- Filters for time range (today, 24 hours, 7 days, 30 days, all), model, project, session, main thread or subagent,
  and text search. The current view is kept in the URL.
- Live indicator for requests in the last two minutes.
- Local history store at `~/.ccusagex/store.json`, so history survives Claude Code deleting old transcripts.
- CSV export of the current filters, with spreadsheet formula escaping.
- Light and dark themes.
- Windows launcher (`CCUsageX.ps1`) with start, stop, status and restart actions. It opens the dashboard in an Edge
  app window, and never stops processes it did not start.
- JSON API, documented in `docs/ARCHITECTURE.md`.
- Test suite (`node --test test/server.test.js`) on synthetic transcripts, and an optional verification script
  (`test/verify.js`) that recomputes the numbers independently.
- No npm dependencies. Requires Node.js 18 or newer.

### Security

- Listens on `127.0.0.1` only, checks the `Host` header, accepts only `GET` and `HEAD`, and makes no outbound
  requests.
