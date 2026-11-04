# Protected features (owner-chosen)

Anything here stays unless the owner asks for that exact change.

| Feature | Where | Rule |
|---|---|---|
| Today's budget card | `public/widget.js` renderBudget, `server.js` pvBudget | Default ON. The main number is today's $ across all accounts, with rollover, so every weekly allowance is used before reset. |
| Run dry card | widget, `budget.dry` | Default ON. Now / usual / heavy (+ switcher "last few minutes"), which limit (5h or weekly), when it comes back. |
| Burn order card | widget, `budget.order` | Default ON. Soonest reset first, $ left, what is lost at each reset. |
| 10 extras | widget settings | Each behind its own remembered switch, default OFF: live coach, account picker + Switch, waste alert, next 10 days, prompts left (effort what-if), by workspace, report card, US busy hours (measured burn only), use-it list, 5h limits counted (always in the math). |
| Older cards (peak clock, rings, per-model, right now, plan value, insights) | widget | Default ON again since 1.7.1 (owner 2026-11-04), with coach + 10-day strip. Never hide them by default again without his ask. |
| Screen-height cap + wheel scroll | `widget.js` fitScreen, `widget.css` `#card.capped` | Under Rainmeter the card never runs off the screen; the cards scroll. |
| Rings show one account | `server.js` limOneAccount | 5-hour and weekly come from the same account (switcher active), never mixed. |
| Light glass look | `public/widget.css` | Keep. |
| No single account shown above 100% | widget | Never scare with >100% per account. |
| Waste alert goes to the owner's private chat only | `~/.ccusagex/alerts.json` | Never a team group. |

## History

- 2026-11-04 (1.7.1): owner: "claude pulse make it show many data it showed earlier but not better". 1.7.0 had hidden
  every older card; they are on again by default (+ coach, 10-day strip), the card is capped to the screen and
  scrolls, and the rings no longer mix accounts (they showed 15% weekly while Personal was at 97%). Undo: `git revert`
  the 1.7.1 commit.

- 2026-11-04 (1.7.0): owner: "the Claude Pulse is not doing enough to show me how much i should use and when i will
  hit the limit, at what time, if i keep using." Added the three default cards and the extras; older cards behind
  switches. Undo: turn the switches back on in settings, or check out 1.6.0.
- 2026-11-04: owner: "do which ever we can? with real imags assets and all". New widget screenshots and two promo
  images in `docs/screenshots` (demo data only; promo HTML sources stay out of the repo). The site gallery shows
  each shot at a fixed width (was fixed 420 px height). Undo: `git revert` that commit.
