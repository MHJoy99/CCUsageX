## Summary

<!-- What does this change, and why? -->

## Related issue

<!-- "Fixes #123", or "None" -->

## Type of change

- [ ] Bug fix
- [ ] New feature
- [ ] Refactor or cleanup, no behaviour change
- [ ] Documentation only
- [ ] Pricing or configuration change (give the price source and the date checked)

## Checklist

- [ ] `node --check server.js`, `node --check public/app.js` and `node --check public/charts.js` pass
- [ ] `node --test test/server.test.js` passes
- [ ] Behaviour changes have a test, using synthetic transcripts
- [ ] The HTTP API stays backward compatible (fields added, none renamed or removed)
- [ ] `docs/ARCHITECTURE.md` or `docs/FAQ.md` updated if the documented behaviour changed
- [ ] `CHANGELOG.md` updated under Unreleased, if a user will notice the change
- [ ] No new runtime dependencies, network calls or external assets
- [ ] No real data in the diff: no transcripts, `store.json`, prompt text, personal paths or email addresses
- [ ] Screenshots attached for UI changes, in light and dark themes
