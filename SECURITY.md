# Security Policy

## Supported versions

Only the latest release receives security fixes. The current line is 1.x.

## Reporting a vulnerability

Please do not open a public issue for a security problem. Report it privately through GitHub's private vulnerability
reporting:

https://github.com/MHJoy99/CCUsageX/security/advisories/new

Include:

- the version or commit, your operating system, and your Node.js version
- the steps to reproduce, with a synthetic transcript if possible
- what an attacker could do with it
- a proposed fix, if you have one

Do not send real prompts, transcripts or `store.json` files. A small synthetic transcript that reproduces the problem
is ideal.

CCUsageX is maintained by volunteers. We will acknowledge each report and keep you informed as it is worked on.

## Threat model

CCUsageX is a local tool. It assumes the machine and your user account are trusted. Its aim is that your usage data
does not leave the machine, and is not reachable from other machines or from other websites.

### What it does

- **Binds to `127.0.0.1` only.** The host is not configurable, so the server is not reachable from the network.
- **Checks the `Host` header.** Requests must name `127.0.0.1`, `localhost` or `[::1]`. This blocks DNS-rebinding
  attacks, where a web page resolves its own name to 127.0.0.1.
- **Accepts only `GET` and `HEAD`, plus two small `POST`s** (1.7.0), and sends no CORS headers, so a web page on
  another origin cannot read responses. `POST /api/switch {id}` runs CCSwitcherX's own `switch` command for an
  account id already in its pool; `POST /api/alerts {enabled}` turns the waste alert on or off. Both need the
  `X-Pulse: 1` header and a JSON content type (a cross-site form cannot send either), an `Origin` that is
  `127.0.0.1`/`localhost`/`[::1]` or none, and a body under 1 KB.
- **Makes no outbound requests** and loads no external scripts, stylesheets or fonts. The optional waste alert runs
  the one command you put in `~/.ccusagex/alerts.json` (your own messaging script); it is off unless that file exists.
- **Reads Claude Code transcripts read-only.** It writes only its own folder (`~/.ccusagex`, or the folder in
  `CCU_DATA_DIR`: the store, `plan-value.json`, `burn-plan.json` with account ids, % and $ only, `alerts-state.json`,
  and the `enabled` flag of `alerts.json`) and its runtime files in the install folder. It never writes to the
  CCSwitcherX folder.
- **Confines static files to `public/`.** Paths that resolve elsewhere get a 404.
- **Escapes spreadsheet formulas in CSV export.** Cells starting with `=`, `+`, `-`, `@`, a tab or a carriage return
  get a leading apostrophe.
- **Stops only its own server.** The launcher stops only the process whose PID it recorded, after checking that its
  command line is this project's `server.js`.
- **Keeps dependencies at zero.** There is no third-party package code to audit, and the repository runs no CI
  workflows or automated bots.

### What it does not do

- **It does not encrypt the store.** The store holds prompt text (up to 8,000 characters per prompt) and response text
  (up to 1,200 characters per request) as plain JSON. The file gets your default file permissions, and CCUsageX does
  not restrict them further. Treat `~/.ccusagex` as sensitive, and do not sync or share it.
- **It does not authenticate requests.** Any process that can connect to `127.0.0.1` on the port can read the dashboard
  while the server runs. On a shared computer, other local user accounts can do this too.
- **It is not designed to resist someone with access to your user account.** Anything running as you can read your
  transcripts and the store directly.

### Scope

In scope:

- bypassing the loopback binding or the `Host` check
- reading files outside the transcripts, the store and `public/`
- path traversal in static file serving
- cross-site scripting in the dashboard. Prompt text and transcript content are untrusted input and must be escaped
- CSV or spreadsheet formula injection in the export
- the launcher stopping a process it did not start
- a page on another origin reaching `POST /api/switch` or `POST /api/alerts`
- any write to `~/.claude`

Out of scope:

- Claude Code, Node.js and Microsoft Edge themselves
- problems that require an attacker who already has access to your user account
