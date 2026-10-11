# CCUsageX FAQ

Answers to common questions about CCUsageX, a local dashboard for Claude Code usage. For setup see
[README.md](../README.md). For how the numbers are computed see [ARCHITECTURE.md](ARCHITECTURE.md).

## How do I see my Claude Code token usage?

Start CCUsageX and open `http://127.0.0.1:3020`, which shows input, output, cache read, cache write and thinking
tokens for the range you pick. It reads the transcript files Claude Code already writes under `~/.claude/projects`,
so nothing needs to be enabled in Claude Code. Use the range buttons (today, 24 hours, 7 days, 30 days, all) and the
filters for model, project, session and request kind to narrow the view.

## How much would my Claude Code usage cost on the API?

CCUsageX shows an API-equivalent cost: each request's token counts multiplied by the model's list price in
`config.json`. Cache writes are priced at 1.25 times the input price for 5-minute writes and 2 times for 1-hour writes,
and cache reads at a small fraction of the input price. The result is what the same usage would cost at Anthropic API
rates. On a Claude Code subscription nothing is billed per token, so treat the figure as a comparison, not an invoice.

## Where are Claude Code logs stored?

Claude Code writes its transcripts as JSON Lines files under `~/.claude/projects/<project>/`, and subagent transcripts
under a `subagents/` folder inside each session. On Windows that is `%USERPROFILE%\.claude\projects`. CCUsageX only
reads these files and never changes them. Its own copy of the history is in `~/.ccusagex/store.json`, or in
`$CCU_DATA_DIR` if you set it.

## Why do subagent requests show low output tokens?

Some subagent transcript records contain only the usage recorded when the response started, and no `stop_reason` on
any of their lines. CCUsageX flags those requests as partial and uses the recorded numbers without estimating. The
output count for those requests can therefore be lower than the final value, which makes totals a lower bound.
Partial requests are counted in the `partial` field of the summary and are left out of the tokens-per-second figures.
See [Partial usage](ARCHITECTURE.md#partial-usage).

## Is my data sent anywhere?

No. The server listens only on `127.0.0.1`, rejects requests whose `Host` header is not local, makes no outbound
network requests, and loads no external scripts, fonts or stylesheets. Your prompt text is saved locally in
`~/.ccusagex/store.json` so the history survives transcript cleanup, so treat that file as sensitive. See
[SECURITY.md](../SECURITY.md) for the full threat model.

## How is CCUsageX different from ccusage?

ccusage is a separate open-source command-line tool that also reads Claude Code transcripts and reports usage in the
terminal. CCUsageX is a local browser dashboard that keeps its own copy of the history, attributes requests to the
prompt that caused them (including subagent work), and lets you drill from a prompt to every request it triggered.
Both read the same files, but they apply their own dedupe and attribution rules, so totals can differ slightly. Use
whichever fits your workflow, or both to cross-check.

## Does it work with Claude Pro and Claude Max?

Yes. CCUsageX reads local transcript files, and those are written whichever plan you are on. The costs it shows are
API-equivalent values for the usage, not what your plan charges. Your 5-hour and weekly plan limits are a separate
feature. They are shown only on Pro and Max, and refresh automatically from Claude Code's `/usage` report. See
[How do I see my plan usage limits?](#how-do-i-see-my-plan-usage-limits-5-hour-and-weekly).

## How do I see my plan usage limits (5-hour and weekly)?

There is nothing to set up. CCUsageX runs Claude Code's documented `/usage` report in the background (a local command: no
model tokens, no transcript) and shows the 5-hour session and 7-day weekly windows with their reset times and a pace
projection, plus the per-model weekly limits when Claude Code reports them. It refreshes every 2 minutes while you look at
the dashboard, and the refresh button on the card does it on demand. This works for the terminal app and the VS Code
panel alike, on Pro and Max plans only. The status line (`npm run statusline:install`) is optional and only adds instant
updates in terminal sessions. [Plan usage limits](ARCHITECTURE.md#plan-usage-limits) describes the data source.

## Why does the limits card say there is no data yet?

The card explains which state it is in. The usual reasons are:

- **The automatic refresh cannot run.** CCUsageX could not start `claude` (not on your `PATH`, or `CCU_LIMITS_PROBE=0`).
  The card shows the short reason. Set `CCU_CLAUDE_BIN` to the full path of the `claude` binary, or set up the status line
  as a fallback with `npm run statusline:install` and send one message in terminal `claude`.
- **Not a Pro or Max plan.** Claude Code reports these limits only for claude.ai subscriptions. API-key plans, third-party
  providers and logins without profile access have no limit data.
- **Stale.** The last report is more than 15 minutes old. With the automatic refresh working this clears itself within
  a couple of minutes.

`node scripts/install-statusline.js --status` prints whether the status line hook is installed and whether its helper
script is present.

## Will installing the status line change my Claude Code settings? Can I undo it?

It changes one entry, `statusLine`, in your Claude Code `settings.json`. Before writing, the installer copies the file to
`settings.json.bak-<YYYYMMDD-HHMMSS>` in the same folder, and every other setting is kept. If you already had a status
line, it keeps running: CCUsageX calls it with `--chain` and shows its output, and your previous setting is saved under
`ccusagexPreviousStatusLine`. To undo everything, run `npm run statusline:uninstall`. It restores your previous status
line exactly and removes the saved key. `--dry-run` shows the change without writing anything. An invalid
`settings.json` stops the installer before it writes anything.

## I use the VS Code extension. Do the limits update?

Yes. The numbers come from Claude Code's `/usage` report, which CCUsageX asks for in the background, so they do not
depend on which Claude Code app you use. In our tests the optional status line reported only from terminal sessions.

## Are there Opus or Sonnet limits?

When Claude Code reports per-model weekly limits in its `/usage` report, the card shows them under "Weekly limits by
model", with the limit Claude Code marks as active tagged "binding". If your plan has none, the row is hidden. CCUsageX
never estimates them.

## Does the limits feature read my login or call Anthropic?

No. CCUsageX does not read `~/.claude/.credentials.json`, does not call any usage endpoint, and makes no network request
itself. It runs the local `claude -p` command with the prompt `/usage`, which Claude Code answers on your machine without
a model call, and stores the result in `~/.ccusagex/limits/` (or `$CCU_DATA_DIR/limits/`).

## How do I change prices or the start date?

Edit `config.json` in the install folder and restart the server. Prices are under `pricing.models`, in USD per million
tokens, and `startDate` takes `YYYY-MM-DD` or `all`. Restarting is enough for prices, because CCUsageX reprices stored
history when it loads. On Windows, run `CCUsageX.ps1 -Action restart`. Elsewhere, stop the `node server.js` process and
start it again. A model without a price entry is counted in tokens and marked unpriced, not priced at a guess.

## Why does my history only go back 30 days?

Claude Code deletes transcript files older than its `cleanupPeriodDays` setting, which defaults to 30. CCUsageX keeps
a copy of every request it has read, so the history survives that deletion, but it can only copy what it saw while it
was running. To keep more history, raise `cleanupPeriodDays` in Claude Code's `settings.json`, and leave CCUsageX
running so it reads the transcripts before they are removed. See
[Local store](ARCHITECTURE.md#local-store).

## How do I run CCUsageX on macOS or Linux?

Install Node.js 18 or newer, then run `node server.js` from the repository folder. Open `http://127.0.0.1:3020` in
your browser. There are no packages to install, because CCUsageX has no npm dependencies. Set `CLAUDE_CONFIG_DIR` if
your Claude Code folder is not `~/.claude`, and `--port` or `PORT` to use another port. The Windows launcher and its
desktop-app window are not available on macOS or Linux.

## How do I open CCUsageX as a desktop app on Windows?

Double-click `Open-CCUsageX.cmd`, or run `CCUsageX.ps1 -Action start` in PowerShell. The script starts the server in the
background, then opens the dashboard in its own Microsoft Edge window with no tabs or address bar. You can create a
desktop or Start Menu shortcut to `Open-CCUsageX.cmd`. If Edge is not installed, the dashboard opens in your default
browser instead. Closing the window does not stop the server, and `Close-CCUsageX.cmd` does.

## How do I export to CSV?

Click the export button in the dashboard header. It downloads every request that matches the current filters, newest
first, as a CSV file named `claude-code-usage-YYYY-MM-DD.csv`. The same export is available at `/api/export.csv`, which
accepts the same filter parameters. Cells that start with `=`, `+`, `-` or `@` are escaped so spreadsheets do not run
them as formulas. See [the export section of the API reference](ARCHITECTURE.md#get-apiexportcsv).

## What is cache hit rate and why does it matter?

Cache hit rate is the share of input-side tokens served from the prompt cache: cache read divided by the sum of input,
cache read and cache write. It matters because a cache read costs only a small fraction of the input price, while a
cache write costs more than normal input. In the current price table, cache reads are between 2.5% and 10% of the
model's input price. A session that keeps rewriting its cache, for example after the default 5-minute cache lifetime
has passed while idle, pays more for the same conversation.

## What does "unpriced" mean?

A request is unpriced when its model id has no entry in `config.json`, or when it is a different version from the
entries there. CCUsageX still counts its tokens, but it does not guess a price, so its cost is shown as empty and it
adds nothing to the cost totals. Add or correct the model's entry in `config.json` and restart to price it. See
[Pricing](ARCHITECTURE.md#pricing).

## What counts as a prompt?

A prompt is a turn you started by typing a message in Claude Code. Subagent work and requests from turns that Claude
Code starts itself, such as background task notifications or headless SDK runs, are not counted as prompts. Their
requests are attributed to the latest prompt you typed in the same session before them, and are marked with the kind
of turn they came from. Messages you type while a turn is running are added to that prompt as queued messages. See
[Prompt attribution](ARCHITECTURE.md#prompt-attribution).

## Why is the response time an estimate?

Response time is the gap between the transcript record a model call answers and the last line of its reply, so it
includes the model's thinking and streaming but not tool execution. Claude Code writes records at its own pace, so the
gap is only approximate. Tokens per second is the median of output tokens divided by that gap, which is also an
estimate. Requests whose parent record is missing, or whose gap is an hour or longer, have no response time. See
[Response time](ARCHITECTURE.md#response-time).

## Why is the dashboard empty?

Open `http://127.0.0.1:3020/api/status` (or run `CCUsageX.ps1 -Action status` on Windows) to see what the server is reading. The usual causes are a start date
later than your usage, no transcript files under the Claude Code projects folder, or a `CLAUDE_CONFIG_DIR` that points
somewhere other than `~/.claude`. The `projectsDir` field in the status response shows the folder being read. If
`lastError` is set, it names the problem.

## What do I do if port 3020 is already in use?

Another program is listening on that port, and CCUsageX does not stop it. Either close that program, or choose another
port by setting `port` in `config.json`, using `PORT` in the environment, or starting the server with `--port <number>`.
The Windows launcher exits with code 2 in this case. Run `CCUsageX.ps1 -Action status` to see whether a CCUsageX server
is already running.

## Can I see usage from several computers in one dashboard?

No. CCUsageX reads only the transcripts on the machine it runs on, and it does not sync. Run it on each computer to see
that computer's usage. Each computer keeps its own `store.json`.

## Does CCUsageX change my Claude Code files?

No. The transcripts under `~/.claude` are read-only to CCUsageX, and it writes only its own store in `~/.ccusagex`
(or `CCU_DATA_DIR`) and its runtime files in the install folder.
