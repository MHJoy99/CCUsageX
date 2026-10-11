# Changelog

All notable changes to CCUsageX are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
