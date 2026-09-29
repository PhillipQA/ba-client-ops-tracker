# BA Client Ops Tracker v0.6.67 — Gmail sync quota hotfix

This patch upgrades v0.6.66. Gmail now searches only the latest 10 days when discovering messages under selected labels. Previously imported messages stay in the Communications Hub, including older ones; the update does not delete them.

The sync scans at most three pages of 20 messages per request, saves its progress, checks the newest pages during a longer backfill, and resumes automatically about 75 seconds later while the Hub is open. Full message bodies already saved under a label are not fetched again when “Check Gmail now” is clicked. Concurrent checks for the same user share one job. When a quota error occurs, the server pauses checks for one minute and returns a clear message.

## Upgrade

1. Confirm `package.json` shows v0.6.66.
2. Run `npm run patch -- "path-to-ba-client-ops-patch-v0.6.67-gmail-quota.zip"` from the project directory.
3. Run `npm run build`, restart the app, redeploy the updated source, and refresh the browser.
4. Open Communications Hub. Check that a new email in a selected label appears and that a repeated “Check Gmail now” does not duplicate it. If the 10-day backfill has more pages, leave the Hub open for the next paced check.

No database migration or dependency install is required. The new query window resets any unfinished cursor from the previous unbounded sync.
