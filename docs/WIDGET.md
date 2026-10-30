# Desktop widget (Claude Pulse)

Claude Pulse is a small always-visible widget for your plan limits and your heavy hours. The widget itself is a web
page, `public/widget.html`, served by your local CCUsageX. You can open it in any browser, or pin it to the Windows
desktop with the Rainmeter skin in `integrations/rainmeter/ClaudePulse/`.

## What it shows

- **Peak clock.** A 24-hour dial in your computer's time zone with two bands:
  - **Your heavy hours**, measured from your own history (see [How heavy hours are measured](#how-heavy-hours-are-measured)).
  - **US busy hours**, informational only (see [The US busy-hours band](#the-us-busy-hours-band)).
- **5-hour and weekly rings** for your plan limits, with reset times.
- **Per-model weekly limits** when Claude Code reports them.
- **Burn pace**: whether you are on track to hit a limit before it resets.
- **Plan value**: your plan in API-equivalent dollars per week and per day, against today's and yesterday's spend
  (see [How plan value is measured](#how-plan-value-is-measured)).
- **Settings gear**, **compact mode**, and an **offline state** when the CCUsageX server is not running.

## Install (Windows, Rainmeter)

You need [Rainmeter](https://www.rainmeter.net) (the installer never installs it for you) and CCUsageX running.

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-widget.ps1
```

What the script does, in order:

1. Checks that you are on Windows and that Rainmeter is installed. If not, it prints https://www.rainmeter.net and exits
   with code 2.
2. Downloads the NSTechBytes [WebView2 plugin](https://github.com/NSTechBytes/WebView2) `v1.0.0` from its official
   GitHub release, checks the SHA256 (`f1b207eb61cfd3487cab39be3b176310af464104eb9f385357617b4fbf23e80c`) and copies
   the DLL to `%APPDATA%\Rainmeter\Plugins`. An existing `WebView2.dll` is left alone.
3. Copies the skin to your Rainmeter Skins folder (read from `Rainmeter.ini`, default `Documents\Rainmeter\Skins`).
4. Activates it with Rainmeter's own command line (`Rainmeter.exe !ActivateConfig ...`). It never edits `Rainmeter.ini`
   by hand. On the first run the widget is placed near the top-right of your primary screen; drag it anywhere and
   Rainmeter remembers the spot. Running the script again reloads the skin and keeps its position.

| Option | Effect |
|---|---|
| `-WhatIf` | Dry run: prints each step, changes nothing, downloads nothing. |
| `-Port 3021` | Writes another CCUsageX port into the skin. Without it, the port already in the skin is kept (default 3020). |
| `-StartWithWindows` | Adds a Startup shortcut that launches Rainmeter at logon. The widget waits for CCUsageX and loads when it answers. |
| `-Uninstall` | Deactivates and deletes the skin and the Startup shortcut. |
| `-Uninstall -RemovePlugin` | Also deletes `WebView2.dll`. |

No admin rights are needed. The only network access is the one-time plugin download.

### Without Rainmeter, or on macOS and Linux

Open `http://127.0.0.1:3020/widget.html` in a browser. Most browsers can open it as a small app window
(Chrome and Edge: menu, "Cast, save and share", "Install page as app").

## Configuration

The widget reads the `widget` block of [`config.json`](../config.json) (server side) and keeps its own display choices
(compact mode, which sections are visible) in the browser or Rainmeter WebView storage. The settings gear edits the
display options. Time values are 24-hour `HH:MM`.

| Key | Default | Meaning |
|---|---|---|
| `widget.usPeak.enabled` | `true` | Show the US busy-hours band. |
| `widget.usPeak.days` | `[1,2,3,4,5]` | Days of the week it applies to, 0 = Sunday, in `timeZone`. |
| `widget.usPeak.start`, `end` | `05:00`, `11:00` | The band, in `timeZone`. |
| `widget.usPeak.timeZone` | `America/Los_Angeles` | Daylight saving time is applied automatically. |
| `widget.usPeak.label` | `US busy hours` | Text on the widget. |
| `widget.heavyHours.mode` | `auto` | `auto` measures from your history, `manual` uses `manual.start`/`manual.end`, `off` hides the band. |
| `widget.heavyHours.manual` | `21:00` to `03:00` | Used only in `manual` mode. May cross midnight. |
| `widget.heavyHours.minDays` | `3` | Days of data needed before `auto` shows anything. |
| `widget.heavyHours.threshold` | `1.15` | An hour is heavy when it burns at least this many times your average. |

All times on the widget are shown in your computer's local time zone. Edits to `config.json` apply without restarting
CCUsageX. The widget refreshes its heavy-hours schedule every 10 minutes (or reload the widget). Rainmeter variables
live in the `[Variables]` section of the installed `ClaudePulse.ini`: `Port` (the CCUsageX port, set by
`scripts\install-widget.ps1 -Port`) and `W`/`H` (starting size; the page resizes the window itself).

## How heavy hours are measured

"Heavy" means: your weekly limit drops faster than usual for the same amount of work. CCUsageX measures it
from two things it already has, and sends nothing anywhere:

1. **The weekly percentage** from your plan-limit snapshots (the status line or the `/usage` probe), per account.
   Snapshots can flicker by a point (82, 81, 82), so it uses the highest value seen so far that week.
2. **The API-equivalent cost** of the requests you made between two snapshots.

It works in **stretches**, not single snapshots, because the weekly percentage moves in whole points and one half
hour's rate is mostly rounding. Per account, consecutive snapshots form a stretch while they are at most 3 hours
apart and no other account's snapshot is within 15 minutes; a stretch is cut into pieces of up to 3 hours. Each
piece needs at least $20 of API-equivalent work (about one and a half weekly points), and its rate is its **net**
rise in weekly percent over its whole cost. A piece more than 3 times faster or slower than your median piece is
dropped: its weekly percentage was mostly moved by use outside this machine (claude.ai, another device) or paid for
work on another account at the same time. Each kept piece is spread over the **local hours** its work fell in, by
cost. For each hour of the day it then computes percent per dollar, smoothed with its two neighbours (a 3-hour
window). The baseline is your overall percent per dollar. An hour is heavy when its smoothed rate is **at least 1.15
times the baseline** and the 3-hour window holds at least $50 of work; runs of heavy hours become the band(s).

It needs **at least 3 distinct days** of paired data (`minDays`). Before that the widget says it needs more data. The
raw numbers are in `GET /api/burn-hours` (`mode`, `days`, `baselinePctPer100`, per-hour `pctPer100`, `ranges`).
The measurement depends on plan-limit snapshots, so install the [status line](FAQ.md) (or keep the server running
so the `/usage` probe collects them).

## How plan value is measured

The card answers "what does my plan give, and how much of it did I use?" in API-equivalent dollars:

- **Dollars per 1% weekly.** The same stretches as the heavy hours (running maximum, 3-hour pieces with at least $20
  of work, no other account nearby, pieces 3 times off the median dropped) from the last 7 days are pooled: total
  dollars over total weekly-percent rise. The plan is that times 100 per week, and a seventh of it per day.
- **Range.** With fewer than 6 pieces, or when they scatter by more than 10%, the card shows a range instead of one
  number. With fewer than 3 pieces (or under 10 points of weekly rise) it shows the last good value, labelled
  "last measured <date>".
- **Today and yesterday** are local calendar days, each compared with one plan-day. A tick on the bar marks one
  plan-day.
- **Accounts.** If the CCSwitcherX account switcher folder `~/.claude-accounts` exists, the card lists
  every saved account (weekly %, reset time, spare dollars) and the total work left this week. Only `usage.json` and
  `autoswitch.json` are read; saved sign-ins are never opened. Every dollar is counted for the account that was
  active when it was spent (the nearest weekly row within 6 hours). Names come from your own
  `~/.ccusagex/account-labels.json` (`{ "<profile id>": "Name" }`); without it accounts are numbered. The runway
  drains the active account to the switcher's `weekLimit`, then the account that resets soonest.
- **Will it last?** Your usual day is the average of the last 7 full local days; your heavy day is the busiest of
  them (or today, if busier). Both are run through the accounts as above. "Enough" means even the heavy pace lasts to
  the end of the 7-day window, "tight" means only the usual pace does, "runs dry" means the usual pace does not. "Safe
  up to $X/day" is the highest steady pace that still lasts. "Full <time>" is when an account reaches the limit at
  your usual pace before it resets.
- **Tips.** Every prompt of the last 7 days is costed with its helpers and grouped by the effort it ran at. A lower
  effort is suggested only when it costs at least 15% less per prompt (both with 20+ prompts); the saving assumes half
  of the higher-effort prompts are routine. Opus helpers are re-priced on Sonnet 5.5 from their real tokens; fast mode
  counts its surcharge. Moving routine (medium/low) prompts to Sonnet 5.5 is suggested only when the week is tight or
  short. Compact mode hides the tips.

The numbers are in `GET /api/plan-value`. Hide the card with the gear (Plan value).

### The US busy-hours band

On 2026-03-26 Anthropic said 5-hour limits would drain faster on weekdays 5-11am Pacific
([Business Insider](https://www.businessinsider.com/claude-usage-caps-changes-popularity-anthropic-2026-3)). On 2026-05-06 it removed
that peak-hour reduction for Pro and Max ([announcement](https://www.anthropic.com/news/higher-limits-spacex)), so
the band is **informational** and the widget never claims it changes your limits. Your measured heavy hours are the
ones to trust. Hide the US band with `widget.usPeak.enabled: false`.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| The widget shows an offline state | CCUsageX is not running. Start it (`node server.js` or `Open-CCUsageX.cmd`). The widget connects by itself once the server answers. Check the `Port` variable if you use a non-default port. |
| Blank or empty box | The WebView2 plugin did not load. In Rainmeter's log (Manage, About, Log) look for `Plugin` errors. Run the installer again and check `%APPDATA%\Rainmeter\Plugins\WebView2.dll` exists. |
| "Plugin blocked" or the DLL cannot be copied | Windows marked the file as downloaded, or antivirus quarantined it. Right-click the DLL, Properties, tick "Unblock", then refresh the skin. Quit Rainmeter before replacing a DLL that is in use. |
| WebView2 runtime missing | The plugin needs the Microsoft Edge WebView2 Runtime. It ships with Windows 11 and current Edge on Windows 10; otherwise install it from https://developer.microsoft.com/microsoft-edge/webview2/. |
| Widget is in the wrong place | Drag it. For a fixed spot use Rainmeter's skin menu, Position. |
| High CPU or RAM | WebView2 is a small browser. Typical use is low, but you can lower it by switching on compact mode, or by hiding the widget (right-click, Unload skin) when you do not need it. The page only polls the local server. |
| Heavy hours say "need more data" | Needs 3 days of paired plan-limit snapshots. Install the status line and keep using Claude Code. |
| Times look off by hours | The widget uses this computer's time zone. Fix the Windows time zone, not the config. |

To remove everything: `powershell -ExecutionPolicy Bypass -File scripts\install-widget.ps1 -Uninstall -RemovePlugin`.
