# CCUsageX: rules for AI sessions

- Read first: `docs/ARCHITECTURE.md` (API), `docs/WIDGET.md` (Claude Pulse), `SECURITY.md`, and `docs/PROTECTED.md`
  (features the owner chose; never drop or hide them without his ask).
- Public repo: no account names, emails, real dollars, personal paths or chat ids in tracked files, the demo or
  commits. The demo (`scripts/demo-api.js` -> `node scripts/build-pages-demo.js` -> `docs/demo/`) stays synthetic.
- Local-only files live in `~/.ccusagex` (`alerts.json` holds the alert command; `use-it.json`); never commit them.
- Shared calculation with CCSwitcherX (its own repo and session): Pulse owns the $ and the order and writes
  `~/.ccusagex/burn-plan.json` (v1, ids/%/$ only); the switcher owns live checks, per-account `weekLines` and when to
  move. Change the file format only together with that session. Never edit switcher code; never trigger a real
  switch while testing.
- Tests: `npm test` (all must pass). Run: `CCUsageX.ps1 restart -NoOpen`, then check `/api/plan-value` and
  `/widget.html`; Rainmeter skin `ClaudePulse` refresh. Test windows only on the second monitor, never take focus.
- Memory: plan-value stats/tips are cached (`pvSlowCache`, server.js); never rebuild them per request (OOM 2026-11-04).
- Releases: CHANGELOG + `package.json` + `integrations/rainmeter/ClaudePulse/ClaudePulse.ini` versions together.
  No GitHub Actions, no AI co-author lines, never `git stash`.
