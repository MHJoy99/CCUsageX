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

All times on the widget are shown in your computer's local time zone. The server re-reads the block while running, so
edit, save, and the widget updates within a minute. Rainmeter variables live in the first lines of the installed
`ClaudePulse.ini`: `Port` (CCUsageX port) and `W`/`H` (starting size; the page resizes the window itself).

## How heavy hours are measured

"Heavy" means: your weekly limit drops faster than usual for the same amount of work. CCUsageX measures it
from two things it already has, and sends nothing anywhere:

1. **The weekly percentage** from your plan-limit snapshots (the status line or the `/usage` probe), per account.
2. **The API-equivalent cost** of the requests you made between two snapshots.

For every pair of consecutive weekly-percentage snapshots of the same account (not more than 3 hours apart, and
with no other account's snapshot within 15 minutes), it records `percent used` and `cost` and files them under the
**local hour** in the middle of the interval. For each hour of the day it then computes percent per dollar. Each hour
is smoothed with its two neighbours (a 3-hour window), so one noisy hour cannot make a band. The baseline is your
overall percent per dollar. An hour is heavy when its smoothed rate is **at least 1.15 times the baseline**, and runs
of heavy hours become the band(s). Windows with almost no spend are ignored.

It needs **at least 3 distinct days** of paired data (`minDays`). Before that the widget says it needs more data. The
raw numbers are in `GET /api/burn-hours` (`mode`, `days`, `baselinePctPer100`, per-hour `pctPer100`, `ranges`).
The measurement depends on plan-limit snapshots, so install the [status line](FAQ.md) (or keep the server running
so the `/usage` probe collects them).

### The US busy-hours band

On 2026-03-26 Anthropic said 5-hour limits would drain faster on weekdays 5-11am Pacific. On 2026-05-06 it removed
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
