# Protected features (owner-chosen)

Anything here stays unless the owner asks for that exact change.

| Feature | Where | Rule |
|---|---|---|
| Today's budget card | `public/widget.js` renderBudget, `server.js` pvBudget | Default ON. The main number is today's $ across all accounts, with rollover, so every weekly allowance is used before reset. |
| Run dry card | widget, `budget.dry` | Default ON. Now / usual / heavy (+ switcher "last few minutes"), which limit (5h or weekly), when it comes back. |
| Burn order card | widget, `budget.order` | Default ON. Soonest reset first, $ left, what is lost at each reset. |
| 10 extras | widget settings | Each behind its own remembered switch, default OFF: live coach, account picker + Switch, waste alert, next 10 days, prompts left (effort what-if), by workspace, report card, US busy hours (measured burn only), use-it list, 5h limits counted (always in the math). |
| Older cards (peak clock, rings, right now, plan value, insights) | widget | Hidden by default since 1.7.0, never deleted; each is a switch. |
| Light glass look | `public/widget.css` | Keep. |
| No single account shown above 100% | widget | Never scare with >100% per account. |
| Waste alert goes to the owner's private chat only | `~/.ccusagex/alerts.json` | Never a team group. |

## History

- 2026-11-04 (1.7.0): owner: "the Claude Pulse is not doing enough to show me how much i should use and when i will
  hit the limit, at what time, if i keep using." Added the three default cards and the extras; older cards behind
  switches. Undo: turn the switches back on in settings, or check out 1.6.0.
