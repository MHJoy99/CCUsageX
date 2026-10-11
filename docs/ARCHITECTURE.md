# Architecture

CCUsageX is one Node.js process (`server.js`, no npm dependencies) that reads Claude Code's transcript files,
turns them into per-request records, prices them, keeps its own copy of the history, and serves a static dashboard
and a JSON API on `127.0.0.1`. Everything runs on your machine. Nothing is sent anywhere.

This document describes how the code works, so you can check its numbers or change it. For setup and usage see
[README.md](../README.md). For common questions see [FAQ.md](FAQ.md).

```
 ~/.claude/projects/**/*.jsonl        (Claude Code transcripts, read-only)
              │
              │  scan every scanIntervalSeconds (default 5)
              ▼
 ┌──────────────────────────────────────────────┐
 │ server.js                                    │
 │  incremental scanner + line parser           │
 │  dedupe  ·  prompt attribution               │
 │  pricing (config.json)                       │
 │  in-memory index                             │──────► ~/.ccusagex/store.json
 │  HTTP API (/api/*)  +  static files (public/)│        (own copy, debounced writes)
 └──────────────────────┬───────────────────────┘
                        │  http://127.0.0.1:3020
                        ▼
 browser: public/index.html · app.js · charts.js · styles.css
```

## Components

| Part | Where | Role |
|---|---|---|
| Scanner | `server.js` `scan`, `scanFile`, `feed` | Finds `*.jsonl` under `<CLAUDE_CONFIG_DIR>/projects`, reads only new bytes per file. |
| Parser | `server.js` `handleLine` | Interprets one transcript record: prompt starts, requests, titles, queued messages. |
| Index | `server.js` `reqMap`, `reqList`, `byPrompt`, `store` | In-memory maps keyed by request key, prompt id and session id. |
| Attribution | `server.js` `promptKind`, `resolveOrphans` | Decides which human prompt each request belongs to. |
| Pricing | `server.js` `priceFor`, `computeCost`; `config.json` | Converts token counts to API-equivalent USD. |
| Store | `server.js` `loadStore`, `saveStore` | Persists the index to `store.json` so history outlives transcript cleanup. |
| Queries | `server.js` `summary`, `requestsPage`, `promptsPage`, `sessionsList`, `exportCsv`, `live` | Build API responses from the index. |
| HTTP | `server.js` `handle` | Host check, method check, routing, static files, JSON responses. |
| UI | `public/app.js`, `public/index.html` | Fetches the API, renders tables, drawers and filters. |
| Charts | `public/charts.js` | Dependency-free inline-SVG charts, exposed as `window.Charts`. |
| Styles | `public/styles.css` | Design tokens (light and dark) and layout. |
| Launcher | `CCUsageX.ps1`, `Open-CCUsageX.cmd`, `Close-CCUsageX.cmd` | Windows only: starts or stops the server and opens an Edge app window. |

The server keeps everything in memory. Heavy responses are memoised (see [HTTP API](#http-api)), so a dashboard
refresh does not re-walk the index for every panel.

## Data flow

1. **Startup.** `loadStore()` restores `store.json` if it exists and its version matches. Then `scan()` runs once,
   and a timer calls `scan()` every `scanIntervalSeconds` (default 5, minimum 2).
2. **Scan.** `walkJsonl` lists every `*.jsonl` under `<CLAUDE_CONFIG_DIR>/projects`, including
   `subagents/` folders. A file whose mtime is before the start date is skipped when it is first seen.
   `GET /api/live` also triggers a scan if the last one finished more than 1.5 s ago.
3. **Incremental read.** Each file has a stored byte `offset`. `scanFile` reads from that offset in chunks of up to
   16 MiB and processes only complete lines (up to the last `\n`). A final line without a newline is used only if it
   is a complete JSON object; otherwise it is retried on the next scan.
4. **Rewritten files.** If the file is shorter than the stored offset, or the SHA-1 of its first 256 bytes differs
   from the stored fingerprint, the file state is reset and the file is read again from the start. This is safe
   because requests are deduplicated by key (see [Dedupe](#dedupe-rule)).
5. **Parse.** Each line goes to `handleLine` (see [Transcript record format](#transcript-record-format)).
6. **Clean-up.** When something changed, `resolveOrphans()` attaches requests without a prompt link and rolls
   harness-started turns into the human prompt they belong to (see [Prompt attribution](#prompt-attribution)).
7. **Finalise.** `finalize(r)` computes response time (`latencyMs`), cost (`cost`) and the partial-usage flag
   (`usagePartial`) for every request it touches.
8. **Persist.** `saveStore()` runs at most every 15 seconds while data is dirty, and always on exit (SIGINT, SIGTERM,
   process exit). It writes `store.json.tmp` and renames it over `store.json`.
9. **Serve.** API calls read the index only. The UI polls `/api/summary`, `/api/prompts`, `/api/requests`,
   `/api/sessions` and `/api/options` and refreshes every 10 seconds while the tab is visible. It also polls
   `/api/live` for the live indicator.

## Transcript record format

CCUsageX reads the JSONL transcripts Claude Code writes. The format is Claude Code's own and is not a published
API, so CCUsageX tolerates missing fields and ignores records it does not understand. Each line is one JSON object.

Files:

- Main thread: `~/.claude/projects/<encoded-project-path>/<sessionId>.jsonl`
- Subagents: `~/.claude/projects/<encoded-project-path>/<sessionId>/subagents/agent-<id>.jsonl`, with a sibling
  `agent-<id>.meta.json` holding `agentType` and `description`.

Fields CCUsageX reads from each record:

| Field | Used for |
|---|---|
| `type` | `user`, `assistant`, `attachment`, `ai-title`, `custom-title`. Other types are ignored. |
| `timestamp` | ISO time. Records without a valid one are ignored for usage. |
| `uuid`, `parentUuid` | Identity of the record, and the link used for response time. |
| `sessionId`, `cwd` | Session, and project (the first `cwd` seen in a session). |
| `promptId` | Prompt link. Set on turn starts and on the records that continue them. |
| `origin.kind`, `turnOrigin`, `promptSource` | Whether a user record is a human turn or a harness-injected turn. |
| `isSidechain`, `isMeta`, `isCompactSummary`, `isVisibleInTranscriptOnly` | Records that never start a prompt. |
| `attachment` with `type: "queued_command"`, `attachment.prompt` | A message typed while a turn was running. |
| `requestId`, `apiBlockIndex` | Request key, and one-line-per-content-block bookkeeping. |
| `agentId`, `requestedModel`, `effort`, `entrypoint`, `version`, `gitBranch` | Request metadata. |
| `aiTitle`, `customTitle` | Session title (a custom title wins). |
| `message.id`, `message.model`, `message.role`, `message.content[]` | Request identity, model, and content blocks (`text`, `tool_use` names, `thinking`). |
| `message.stop_reason` | Whether the message's usage is final (see [Partial usage](#partial-usage)). |
| `message.usage` | Token counts (see below). |

Fields of `message.usage` that CCUsageX reads:

| Field | Maps to |
|---|---|
| `input_tokens` | `input` |
| `output_tokens` | `output` |
| `cache_read_input_tokens` | `cacheRead` |
| `cache_creation_input_tokens` and `cache_creation.ephemeral_5m_input_tokens` / `ephemeral_1h_input_tokens` | `cacheWrite5m`, `cacheWrite1h` (if the split is missing, the total minus 1h goes to 5m) |
| `output_tokens_details.thinking_tokens` | `thinking` (already inside `output`) |
| `server_tool_use.web_search_requests`, `web_fetch_requests` | `webSearch`, `webFetch` |
| `iterations[]` | `extraIter`: entries whose `type` is not `message` |
| `speed`, `service_tier` | `speed` (`fast` or `standard`), `serviceTier` |

Records with `message.model` equal to `<synthetic>` (Claude Code's placeholder) are ignored.

## Dedupe rule

A request is keyed by:

```
key = `${message.id || record.uuid}:${requestId || ''}`
```

Claude Code writes one transcript line per content block of an API message, and each line repeats the message's
usage. While the response streams, `output_tokens` grows, so later lines carry larger numbers. The rule is:

- All lines with the same key update one request record.
- Each usage field is merged with **max**, so the last (largest) value wins.
- Tool names and text are appended once per `apiBlockIndex`. Re-reading a rewritten file therefore cannot
  double-count content.
- The same key found in another transcript file (a resumed or forked session) is counted once.
- Same `message.id` with a different `requestId` is a different request.

Example: three lines for one message, with `output_tokens` 16, 100 and 148, become one request with `output` 148.

Tokens for a request, used in every total:

```
tokens = input + output + cacheRead + cacheWrite5m + cacheWrite1h
```

Thinking tokens are not added again, because they are already part of `output`.

## Prompt attribution

A **prompt** is a turn the user started by typing. Every request belongs to at most one prompt, so the drill-down
from a prompt lists every request it caused.

Rules, in the order the code applies them:

1. **Prompt starts.** A `user` record starts a prompt when `origin.kind` (or `turnOrigin`) is `human`, and it is
   not `isMeta`, a tool result, a sidechain record, a compaction summary, a visible-only record, or an interrupt
   marker (`[Request interrupted by user`). The prompt id is `promptId`, or the record `uuid` if there is none.
2. **Injected turns roll up.** Turns the harness starts itself (for example `task-notification`, a peer hand-back,
   or a headless SDK turn with `promptSource` set and no origin) are stored with `origin` set to that kind and their
   text prefixed `[kind]`. They are not counted as prompts. Their requests roll up into the latest human prompt in
   the same session that started before them, and each such request gets `sys` set to the kind (shown as
   `trigger` in API rows). With no human prompt to roll into, `promptId` is `null`. No synthetic prompt is created.
3. **Subagents.** A record is a subagent record if `isSidechain` is true or its file path contains `/subagents/`.
   Its requests belong to the prompt that spawned the subagent: the most recent non-tool-result `user` record with
   a `promptId` in that same file. Later `promptId` stamps in that file are ignored, because the parent thread
   stamps tool results with whatever prompt is current. Subagent requests get `agentType` and `agentDesc` from the
   `.meta.json` file.
4. **Queued messages.** A `queued_command` attachment (a message typed while a turn was running) is appended to
   the running prompt's `queued` list. It does not start a new prompt.
5. **Requests without a link.** A request with no `promptId` joins the latest human prompt of its session that
   started before it.
6. **Pre-start prompts.** A human prompt that started before the start date is kept in memory. If its turn runs
   past the start date, its requests are still attributed to it.
7. **Projects and sessions.** A session's project is the canonical form of the first `cwd` seen for it. Canonical
   form removes trailing slashes, upper-cases a Windows drive letter, and treats `C:\x`, `c:\x` and `C:/x` as one
   project. A session title is the `customTitle` if present, otherwise the `aiTitle`.

## Pricing

Prices live in `config.json` under `pricing`. USD per million tokens.

```json
"claude-sonnet-5-5": { "input": 2, "output": 10, "cacheRead": 0.20 }
```

Optional keys per model:

- `fastMultiplier`: applied to every cost part when the request's `speed` is `fast`.
- `longContext`: `{ "thresholdTokens", "input", "output", "cacheRead" }`, used instead of the base rates when the
  request's prompt tokens exceed `thresholdTokens`.

Global keys: `cacheWrite5mMultiplier` (1.25) and `cacheWrite1hMultiplier` (2). Cache writes are priced as a
multiple of the model's input price, so they are not listed per model.

Cost of one request (`computeCost` in `server.js`):

```
promptTokens = input + cacheRead + cacheWrite5m + cacheWrite1h
tier         = longContext if it exists and promptTokens > thresholdTokens, else the base rates

input_cost      = input        * tier.input     / 1e6
cacheWrite_cost = (cacheWrite5m * tier.input * 1.25 + cacheWrite1h * tier.input * 2) / 1e6
cacheRead_cost  = cacheRead    * tier.cacheRead / 1e6
output_cost     = output       * tier.output    / 1e6

if speed == "fast" and the model has fastMultiplier: multiply all four parts by it
total = input_cost + cacheWrite_cost + cacheRead_cost + output_cost
```

Notes:

- The long-context test uses the request's total prompt tokens, and the whole request is priced at the long-context
  rates. It is not a per-token split.
- Cache writes use the tier's input rate, so a long-context request also pays the long-context input rate on
  cache writes.
- Thinking cost is reported separately (`thinkingCost`) as `thinking × tier.output`. It is a part of `output_cost`,
  not an extra charge.
- Model ids are matched exactly first. Otherwise the longest configured key that is a prefix of the id is used, if
  the rest of the id is empty, a bracket suffix such as `[1m]`, an `@...` suffix, or a `-YYYYMMDD` date. Other
  versions are **not** priced with a neighbouring version's rates. They are counted in tokens and flagged as
  `unpriced` (`cost` is `null`).
- Prices are not stored with requests. `loadStore()` recomputes every request's cost from the current `config.json`,
  so a price fix takes effect for all history after a restart, including history whose transcripts are gone.

Current table (`pricing.source` in `config.json` names the source and the check date):

| Model | Input | Output | Cache read | Notes |
|---|---:|---:|---:|---|
| claude-fable-5-1 | 10 | 50 | 0.25 | |
| claude-mythos-5-1 | 10 | 50 | 0.25 | |
| claude-fable-5 | 10 | 50 | 1 | |
| claude-opus-5-5 | 4 | 20 | 0.20 | fast ×2 |
| claude-opus-5 | 5 | 25 | 0.50 | fast ×2 |
| claude-opus-4-8 | 5 | 25 | 0.50 | fast ×2 |
| claude-opus-4-7 | 5 | 25 | 0.50 | |
| claude-opus-4-6 | 5 | 25 | 0.50 | |
| claude-sonnet-5-5 | 2 | 10 | 0.20 | |
| claude-sonnet-5 | 2 | 10 | 0.20 | |
| claude-sonnet-4-6 | 3 | 15 | 0.30 | |
| claude-haiku-5-5 | 0.10 | 0.50 | 0.01 | long context above 100,000 prompt tokens: 0.50 / 2.50 / 0.05 |
| claude-haiku-4-5 | 1 | 5 | 0.10 | |

Cache writes for every model: 5-minute = 1.25 × input, 1-hour = 2 × input.

## Partial usage

Claude Code can write a message's usage before the response has finished. A request is flagged `usagePartial` when
no line of its message carries a `stop_reason`. For such a request, `output` and `thinking` hold the value recorded
at stream start, which can be lower than the final count. Those numbers are used as recorded. They are never
estimated.

Effects:

- `usagePartial` is on each request row and detail record.
- Totals count partial requests in `partial` (summary totals, per model, per trend point), and `/api/status` reports
  `partialRequests`.
- Partial requests are excluded from the tokens-per-second median, because their latency would make the speed look
  near zero.
- Totals are therefore a lower bound for `output` and `thinking` when `partial` is above zero.

## Response time

Response time (`latencyMs`) is computed per request in `finalize`:

```
latencyMs = endTs - parentTs
```

- `parentTs` is the timestamp of the transcript record the request's first line replies to (its `parentUuid`).
  This is usually the user message, or the tool result that prompted the next model call.
- `endTs` is the timestamp of the request's last transcript line.
- The value is `null` if `parentTs` is unknown, if `endTs < parentTs`, or if the difference is one hour or more.
- Parent lookup is per transcript file, from a window of the last 400 records. A parent in another file gives `null`.

So response time covers the model's time from the input it answered to the end of its reply. This includes thinking
and streaming. It excludes tool execution, because the next request's parent is the tool result.

Summaries report `latency.avg`, `latency.p50` and `latency.p95` over requests with a value. Percentiles are taken
by index in the sorted list (`floor(n × 0.5)` and `floor(n × 0.95)`), without interpolation.

Tokens per second (`speed` on each model) is the median of `output / (latencyMs / 1000)` over non-partial requests
with a positive latency. It is approximate, because latency is a gap between records.

## Local store

`store.json` is CCUsageX's own copy of the history. Claude Code deletes transcripts older than its
`cleanupPeriodDays` setting (default 30). Once CCUsageX has read a request, the record stays in the store after the
transcript is gone.

Location: `$CCU_DATA_DIR/store.json`, or `~/.ccusagex/store.json` if `CCU_DATA_DIR` is not set. The directory is
outside the install folder, so replacing or updating the install keeps the history.

Format (version 2): a JSON object with `files` (per transcript: offset, head fingerprint, the last 40 record
uuid→timestamp/prompt pairs), `prompts`, `sessions`, a `dict` of repeated strings, and `req`, one compact array per
request. Writes go to `store.json.tmp`, then rename to `store.json`.

Recovery:

- Unreadable JSON: the file is renamed to `store.json.corrupt` and history is rebuilt from the transcripts that still
  exist.
- Different store version: ignored and rebuilt the same way.
- Deleting `store.json` is safe only if you accept that old history will then come back only from transcripts that
  still exist.

Privacy: the store contains prompt text (up to 8,000 characters per prompt, plus queued messages up to 500 characters
each) and response text (up to 1,200 characters per request). The file is written with your default file-permission
mode. CCUsageX does not restrict its permissions.

## HTTP API

Served by `server.js` on `127.0.0.1:<port>`.

Rules that apply to every request:

- **Host check.** The `Host` header must be `127.0.0.1`, `localhost` or `[::1]`, with an optional port. Anything else
  gets `403 Forbidden`. This blocks DNS-rebinding attacks against the local server.
- **Methods.** `GET` and `HEAD` only. Other methods get `405`.
- **Responses** are JSON, UTF-8, with `Cache-Control: no-store`, except `/api/export.csv`.
- **CORS.** No `Access-Control-*` headers are sent, so other origins cannot read responses.
- **Errors.** Unknown `/api/*` paths get `404 {"error":"not found"}`. Unexpected exceptions get
  `500 {"error": "<message>"}`. Unknown request keys or prompt ids get `404 {"error":"not found"}`.
- **Times** are epoch milliseconds in responses. Query `from` and `to` accept epoch milliseconds, or any string
  `Date.parse` accepts. A date-only string is parsed as UTC, so use epoch milliseconds for exact local boundaries.
- **Memoisation.** `/api/options`, `/api/summary`, `/api/requests`, `/api/prompts` and `/api/sessions` are cached
  in memory for at most one minute and until the data changes. Cache keys include the query string.

### Shared query parameters

| Parameter | Meaning |
|---|---|
| `from` | Inclusive lower bound. Default: start date (`startMs`). |
| `to` | Inclusive upper bound. Default: now plus one day for lists, and now (capped) for the summary trend. |
| `model` | Exact model id, e.g. `claude-sonnet-5-5`. |
| `project` | Exact project path, as returned in responses. |
| `session` | Session id. |
| `kind` | `main` (not a subagent) or `subagent`. Other values are ignored. |
| `prompt` | Prompt id. |
| `q` | Case-insensitive substring. For prompts, it matches the prompt text and queued messages. For requests, it matches the request's response, tool names, model, or its prompt. |

### `GET /api/status`

Server and data state. Not range-filtered.

| Field | Description |
|---|---|
| `startDate` | Configured start date, or `"all"`. |
| `startMs` | Start date as epoch ms (0 for `all`). |
| `projectsDir` | Transcript folder being read. |
| `lastScanAt`, `lastScanMs` | When the last scan finished, and how long it took. |
| `lastError` | Last scan or store error, or `null`. |
| `filesTracked` | Transcript files in the store. |
| `requests` | Stored requests. |
| `prompts` | Stored human prompts. |
| `promptsWithUsage` | Distinct prompt ids that have at least one request. |
| `pricingSource` | `pricing.source` from `config.json`. |
| `pricedModels` | Model keys in the price table. |
| `tz`, `tzOffsetMin` | Local time zone name and offset in minutes. |
| `lineErrors` | Transcript lines that failed to process. |
| `requestsWithExtraIterations` | Requests with `extraIter` above zero. |
| `partialRequests` | Requests flagged `usagePartial`. |

### `GET /api/options`

Values for the filter drop-downs. Not range-filtered.

```
{ "models": [string], "projects": [string],
  "sessions": [{ "id", "title" }] }     // newest first; title = custom title, AI title, or first 8 chars of id
```

### `GET /api/summary`

Extra parameter: `gran` = `hour` or `day`. Default: `day` if the range is longer than three days, otherwise `hour`.
The server switches to `day` if there would be more than 2,000 hour buckets. The trend holds at most 5,000 points.

```
{
  "totals": Agg,
  "prompts": number,            // distinct prompt ids with requests in range
  "sessions": number,
  "cacheHitRate": number,       // cacheRead / (input + cacheRead + cacheWrite), 0..1
  "latency": { "avg", "p50", "p95" } | null,      // ms
  "byModel":   [Group + { "prompts", "speed", "speedSamples", "latencyP50", "costPerRequest", "tokensPerRequest" }],
  "byProject": [Group], "byEffort": [Group], "byKind": [Group], "byVersion": [Group],
  "tools": [{ "name", "count" }],
  "trend": { "gran": "hour" | "day", "points": [{ "t": epochMs, ...Agg }] },
  "activity": [{ "id", "ts", "text" (160 chars), "requests", "cost", "models", "durationMs" }]   // newest 30 prompts
}
```

`Group` is `{ "name", ...Agg }`. `byKind` names are `Main` and `Subagent`. `byEffort` uses `(none)` when unset.
`byVersion` uses `(unknown)`. Groups are sorted by `tokens`, descending.

`Agg`:

| Field | Description |
|---|---|
| `requests` | Count. |
| `input`, `output`, `cacheRead` | Token sums. |
| `cacheWrite` | 5-minute and 1-hour writes together. |
| `thinking` | Thinking tokens (inside `output`). |
| `tokens` | `input + output + cacheRead + cacheWrite`. |
| `cost` | API-equivalent USD. Unpriced requests add 0. |
| `unpriced` | Requests whose model has no price. |
| `partial` | Requests flagged `usagePartial`. |
| `costParts` | `{ input, cacheWrite, cacheRead, output }` in USD. |
| `thinkingCost` | USD of thinking tokens (part of `costParts.output`). |

`trend.points` sum to `totals` for every field. The test suite checks this.

### `GET /api/requests`

Paged list of requests.

Extra parameters:

- `sort`: `time` (default), `cost`, `tokens` or `latency`. Unknown values fall back to `time`.
- `dir`: `desc` (default, largest or newest first) or `asc`.
- `page`: 1-based, default 1.
- `size`: 5 to 200, default 20.

```
{ "total": number, "page": number, "size": number, "rows": [Row] }
```

`Row`:

```
{ "key", "ts", "model", "effort", "sidechain", "project", "sessionId", "promptId",
  "prompt"       // first 140 characters of the prompt, or ""
  "input", "output", "cacheRead", "cacheWrite", "thinking", "tokens",
  "cost"         // USD, or null if unpriced
  "latencyMs"    // or null
  "tools"        // tool names, in order
  "stopReason", "usagePartial", "speed",
  "agentType", "agentDesc",
  "trigger"      // kind of injected turn, or null
}
```

`cacheWrite` in a row is the 5-minute and 1-hour writes together. The request key has the form `<message.id>:<requestId>`.

### `GET /api/prompts`

Paged list of prompts, with their requests rolled up.

Extra parameters: `sort` (`time` default, `cost`, `tokens`), `dir`, `page`, `size` (as above).

```
{ "total": number, "page": number, "size": number, "rows": [{
    "id", "ts", "text" (220 characters), "images", "sessionId", "project",
    "requests", "subagentRequests", "tokens", "output", "cost", "durationMs", "models": [string],
    "origin",       // "human" for typed prompts
    "queued",       // number of queued messages
    "costParts", "thinkingCost", "thinking", "cacheRead", "cacheWrite", "input", "subagentCost"
} ] }
```

`durationMs` is the time from the prompt to its last request. If the prompt record is missing, `text` reads
`(prompt text not captured)`.

### `GET /api/sessions`

Not paged. Returns an array sorted by last activity, newest first.

```
[{ "id", "title" | null, "project", "first", "last", "prompts", ...Agg }]
```

### `GET /api/request?key=<key>`

One request in full. Use `%3A` for the colon in the key.

```
{ ...all request fields except block bookkeeping,
  "key", "ts", "parentTs", "endTs", "sessionId", "sessionTitle", "project",
  "promptId", "promptText", "promptImages", "promptTs",
  "sidechain", "agentId", "agentType", "agentDesc",
  "model", "requestedModel", "effort", "entrypoint", "version", "gitBranch",
  "speed", "serviceTier",
  "input", "output", "cacheRead", "cacheWrite5m", "cacheWrite1h", "thinking",
  "webSearch", "webFetch", "extraIter",
  "stopReason", "usagePartial", "sys",
  "tools": [string], "response" (1,200 characters max), "latencyMs",
  "cost": { "input", "cacheWrite", "cacheRead", "output", "total" } | null,
  "tokens" }
```

### `GET /api/prompt?id=<promptId>`

One prompt with its requests, oldest first.

```
{ "prompt": { "id", "ts", "sessionId", "project", "sidechain", "origin", "text" (8,000 characters max),
              "images", "queued"?: [string] } | null,
  "sessionTitle": string | null,
  "totals": Agg,
  "requests": [Row] }
```

### `GET /api/export.csv`

Same filters as the other list endpoints. Returns every matching request, newest first (no paging), as
`text/csv` with `Content-Disposition: attachment; filename="claude-code-usage-YYYY-MM-DD.csv"` (local date).

- UTF-8 with a byte-order mark. CRLF line endings.
- Columns: `time` (ISO), `session`, `project`, `model`, `effort`, `type` (`main` or `subagent`), `input`, `output`,
  `cache_write_5m`, `cache_write_1h`, `cache_read`, `thinking`, `total_tokens`, `cost_usd` (6 decimals), `latency_ms`,
  `stop_reason`, `tools` (space-separated), `prompt` (first 500 characters).
- Cells that start with `=`, `+`, `-`, `@`, a tab or a carriage return get a leading apostrophe. Cells with commas,
  quotes or line breaks are quoted.

### `GET /api/live`

Liveness for the header indicator. Scans first if the last scan is more than 1.5 s old.

```
{ "active": boolean,        // a request ended within the last 120 seconds
  "lastTs": epochMs | null,
  "recent": [Row],          // ten most recent requests, newest first
  "now": epochMs,
  "lastWriteTs": epochMs | null }     // newest transcript mtime seen
```

### Static files

`GET /` serves `public/index.html`. Any other `GET` path maps to a file under `public/` (`app.js`, `charts.js`,
`styles.css`). Paths that resolve outside `public/` get `404`. Content types come from the extension.

## Design tokens

Defined on `:root` in `public/styles.css`. The light set is the default (`<html data-theme="light">`). The
`[data-theme="dark"]` set replaces it. The theme toggle writes the choice to `localStorage` under `ccu.theme`, and an
inline script in `index.html` applies it before first paint.

| Token | Light | Dark | Use |
|---|---|---|---|
| `--page` | `#ffffff` | `#0b0d18` | Page background |
| `--surface-1` | `#ffffff` | `#12152a` | Cards |
| `--surface-2` | `#f5f5f7` | `#1a1e38` | Inset areas |
| `--surface-3` | `#ebebef` | `#242948` | Hover and raised areas |
| `--text-primary` | `#0b0b10` | `#eeeef6` | Body text |
| `--text-secondary` | `#4d4e58` | `#b0b3c9` | Labels |
| `--text-muted` | `#85868f` | `#7c809c` | Captions |
| `--grid` | `#ececf0` | `#232845` | Chart gridlines |
| `--axis` | `#b4b5be` | `#4b5074` | Chart axes, unpriced model colour |
| `--border` | `#e3e3e8` | `#262b4a` | Borders |
| `--accent` | `#5b3fd0` | `#a594ff` | Accent text and highlights |
| `--accent-soft` | `rgba(91,63,208,.10)` | `rgba(165,148,255,.14)` | Accent backgrounds |
| `--good` | `#0ca30c` | `#0ca30c` | Status: good |
| `--warning` | `#fab219` | `#fab219` | Status: warning |
| `--critical` | `#d03b3b` | `#d03b3b` | Status: critical |
| `--series-1` … `--series-8` | see below | see below | Categorical series, fixed order |
| `--ink`, `--on-ink` | `#0b0b10`, `#ffffff` | `#f1f1f8`, `#0b0d18` | Inverted surfaces |
| `--shadow`, `--scrim`, `--glass`, `--row-hover` | | | Elevation, overlays, hover |

Series, in order:

- Light: `#2a78d6 #eb6834 #1baf7a #eda100 #e87ba4 #008300 #6250d6 #e34948`
- Dark: `#3987e5 #d95926 #199e70 #c98500 #d55181 #008300 #9085e9 #e66767`

Model colour is fixed by model, not by rank: `claude-opus-5-5` → series 1, `claude-sonnet-5-5` → 2,
`claude-haiku-5-5` → 3, `claude-fable-5-1` → 4. Other models take series 5 to 8 in first-seen order. The assignment
is stored in `localStorage` under `ccu.modelSlots`. After slot 8 is used, further models get the neutral `--axis`
colour.

Fonts and layout: `--serif` (Iowan Old Style, Palatino, Georgia, Times New Roman), `--sans` (Segoe UI Variable,
Segoe UI, system-ui, Roboto), `--mono` (Cascadia Mono, Consolas). Header height `--hh` 60px, content width `--maxw`
1320px, corner radius `--r` 14px. Reduced-motion users get no animation (`prefers-reduced-motion`).

## Charts API

`public/charts.js` is a plain script that defines `window.Charts`. Each function renders inline SVG into the
container, clears it first, re-renders when the container resizes, and shows a shared hover tooltip.

```js
Charts.donut(container, items, opts)              // items: [{name, value, color}]
Charts.stackedBars(container, points, series, opts) // points: [{t, [key]: n}], series: [{key, name, color}]
Charts.hbars(container, items, opts)              // items: [{name, value, color?, sub?}]
Charts.sparkline(container, values, opts)         // opts: {color}
Charts.seriesColor(index)                         // "var(--series-N)", N = 1..8
```

The module also exposes `columns`, `stackedColumns`, `scatter`, `countUp` and `reveal`. `Charts.animations = false`
turns off animation (reduced motion is always honoured). Colours are passed as CSS values, such as
`var(--series-1)`. Unchanged data and size are a no-op, so the UI can call these every few seconds.

## File layout

```
server.js                 HTTP server, scanner, parser, dedupe, attribution, pricing, store
config.json               start date, port, scan interval, prices
public/index.html         dashboard shell and theme bootstrap
public/styles.css         design tokens and layout
public/app.js             UI state, fetching, tables, drawers, filters, CSV link
public/charts.js          inline-SVG chart kit (window.Charts)
test/server.test.js       unit and API tests on synthetic transcripts (node --test)
test/verify.js            independent recomputation from a copy of the transcripts (optional ccusage cross-check)
test/charts-demo.html     chart gallery with fixture data
CCUsageX.ps1              Windows launcher: start, stop, status, restart
Open-CCUsageX.cmd         double-click wrapper: start and open the window
Close-CCUsageX.cmd        double-click wrapper: stop the server and close the window
docs/                     this file and FAQ.md
.github/                  issue forms and pull request template (no CI workflows)
```

Runtime files, outside the repository:

| Path | Contents |
|---|---|
| `~/.ccusagex/store.json` (or `$CCU_DATA_DIR/store.json`) | History store. Keep it; back it up if it matters to you. |
| `<install dir>/state/server.pid` | PID of the server started by the launcher. |
| `<install dir>/state/edge-profile/` | Browser profile of the app window. Delete it to reset window size and position. |
| `<install dir>/logs/server.out.log`, `server.err.log` | Server output, overwritten on each start. |

## Configuration

Precedence for the port: `--port <n>` argument, then `PORT` environment variable, then `port` in `config.json`,
then `3020`. The host is always `127.0.0.1` and cannot be changed.

| Setting | Where | Default | Notes |
|---|---|---|---|
| Port | `--port`, `PORT`, `config.json` `port` | `3020` | The launcher reads `config.json`. |
| Start date | `config.json` `startDate`, or `CCU_START_DATE` | `"all"` | `YYYY-MM-DD` (local midnight) or `all`. Read at start-up. |
| Scan interval | `config.json` `scanIntervalSeconds` | `5` | Minimum 2. |
| Prices | `config.json` `pricing` | see table | Read at start-up. Stored history is repriced on restart. |

## Environment variables

| Variable | Default | Effect |
|---|---|---|
| `PORT` | `3020` (or `config.json` port) | Listening port, if `--port` is not given. |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Claude Code config folder. Transcripts are read from `<dir>/projects`. |
| `CCU_DATA_DIR` | `~/.ccusagex` | Folder for `store.json`. |
| `CCU_START_DATE` | `config.json` `startDate` | Overrides the start date: `YYYY-MM-DD` or `all`. |

The test suite sets `CLAUDE_CONFIG_DIR`, `CCU_DATA_DIR` and `CCU_START_DATE` to temporary folders, so tests never touch
real data.

## Operational limits

- Everything is in memory. Very large histories use more RAM. The test suite includes a 200,000-request scale check.
- A single transcript line is limited only by memory. Reads grow the chunk size when a line is longer than 16 MiB.
- Parent lookup keeps 400 record uuids per file while scanning, and 40 are persisted.
- Summaries cap the trend at 5,000 points. Hour buckets above 2,000 switch the summary to day buckets.
- `/api/export.csv` has no row limit.
