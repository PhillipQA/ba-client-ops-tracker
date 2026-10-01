# BA Client Ops Tracker v0.6.71 — All Tasks status filter

This patch upgrades v0.6.70. Task Module → All tasks now includes a dedicated **Status** filter. It defaults to **All statuses**, uses the workspace-configured task statuses, and also keeps any legacy status values found on existing tasks available so older records are never hidden from filtering.

The Status filter combines with the existing search, Waiting on, Client, Project, and Due / follow-up filters. **Clear filters** resets Status together with the other All Tasks filters.

## Upgrade

1. Confirm `package.json` shows v0.6.70.
2. Run `npm run patch -- "path-to-ba-client-ops-patch-v0.6.71-task-status-filter.zip"` from the project directory.
3. Run `npm run build`, restart/redeploy the app, and refresh the browser.
4. Open Task Module → All tasks. Verify Status defaults to All statuses, selecting a status narrows the list/count, and Clear filters restores the full list.

No database migration or dependency install is required.
