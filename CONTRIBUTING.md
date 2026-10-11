# Contributing to CCUsageX

Thanks for helping. CCUsageX is deliberately small. It has zero npm dependencies, no build step, no CDN assets, and
it never sends data off the machine. Changes should keep those properties.

Before you start, read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) to see how transcripts become numbers. For a
security problem, follow [SECURITY.md](SECURITY.md) and do not open a public issue.

## Development setup

You need Node.js 18 or newer. The Windows launcher also needs Windows PowerShell 5.1 or PowerShell 7.

```sh
git clone https://github.com/MHJoy99/CCUsageX.git
cd CCUsageX
node server.js          # serves http://127.0.0.1:3020
```

There is no `npm install` step. While developing, point the server at a fixture instead of your real Claude Code
folder so you do not read or write real data:

```sh
CLAUDE_CONFIG_DIR=/path/to/fixture CCU_DATA_DIR=/path/to/scratch node server.js
```

On Windows PowerShell, use `$env:CLAUDE_CONFIG_DIR = 'C:\path\to\fixture'` and `$env:CCU_DATA_DIR = '...'` before
`node server.js`.

## Checks

Run these before you open a pull request. CI runs the same steps on Ubuntu, Windows and macOS with Node 18, 20 and 22.

```sh
node --check server.js public/app.js public/charts.js
node --test test/server.test.js
```

Name the test file explicitly. `node --test test` does not work on newer Node versions.

`test/verify.js` is an optional independent check. It copies your transcripts, recomputes the numbers from the copy,
and compares them with a running server. It needs `ccusage` on your PATH unless you pass `--no-ccusage`. Its output
can include fragments of your prompts, so review it before you paste it anywhere.

## Ground rules

- **No new runtime dependencies, no build step, no network calls, no CDN assets.** These are product guarantees.
- **Keep the HTTP API backward compatible.** Add fields and endpoints. Do not rename or remove fields that exist.
  Document any addition in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
- **Prices change only with a source.** When you change a price in `config.json`, update `pricing.source` with where
  the price came from and the date you checked it.
- **Never commit real data.** That means transcripts, `store.json`, prompt text, response text, personal paths, email
  addresses and names. Use synthetic fixtures in tests, like the ones in `test/server.test.js`.
- **Behaviour changes need a test.** Add it to `test/server.test.js`, using synthetic transcripts in a temporary folder.
- **The launcher never kills a process it did not start.** Keep it that way.

## Pull requests

- Keep each pull request to one logical change. Explain what changed and why.
- Update [CHANGELOG.md](CHANGELOG.md) under `Unreleased` for anything a user would notice.
- Update [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) or [docs/FAQ.md](docs/FAQ.md) when the behaviour they describe
  changes.
- Fill in the pull request template. Add screenshots for UI changes, in both light and dark themes.

## Code style

- Plain JavaScript with `'use strict'`, two-space indentation and single quotes, matching the existing files.
- Comments explain why something is done, not what the code does.
- Keep the UI as plain scripts and inline SVG. Do not add modules or a bundler.

## Licence

CCUsageX is released under the MIT licence. By contributing you agree that your contribution is released under the
same licence.

## Code of conduct

Everyone taking part in the project is expected to follow [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
