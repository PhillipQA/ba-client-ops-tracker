# BA Client Ops Tracker v0.6.10 — Activity tiles

Action Center > Activities now uses responsive tiles (three columns on wide screens, two on medium screens, one on mobile). Today and This Week tabs and Sunday–Saturday boundaries remain unchanged.

Tiles show the title, client/project, status, task priority, follow-up/due dates, and parent task for subtasks. Existing edit, mark-done, and calendar actions remain available. Overdue dates within the selected view are highlighted; this release does not change which dates each view includes.

Comments/notes show a two-line preview. Hover to read the full text, or click/tap to keep the popover open. Long comments scroll, preserve line breaks, and wrap. Escape, Close, or clicking outside dismisses the popover. Keyboard users can activate the comment button with Enter or Space. The full text opens outside themed panels to avoid clipping. Existing task descriptions and activity notes supply these previews; no new comment storage is introduced.

Includes the v0.6.9 client/project modal fixes. No new dependencies, database migrations, or environment changes.

## Update an existing installation

Choose the patch matching your installed version (run `npm run patch:status` if unsure). Save the ZIP in E:\Playwright. Stop the app, then run from E:\Playwright\ba-client-ops-tracker:

For v0.6.9:
```bat
npm run patch -- "E:\Playwright\ba-client-ops-patch-v0.6.10-from-v0.6.9.zip"
npm run build
npm run dev
```

For v0.6.8, use the `ba-client-ops-patch-v0.6.10-from-v0.6.8.zip` filename instead. Apply only one patch. Refresh the browser after restart. For Render, commit the updated source to the connected repository and redeploy.

The full-build ZIP contains the complete source plus compiled dist. For a fresh checkout, install dependencies with `npm install`, configure your environment following README.md, and run `npm run build`. Use a patch for an existing installation to preserve its local configuration.

## Build status

Production compilation (`npm run build`) succeeded. Existing Lucide module-directive and Vite chunk-size warnings remain. Automated tests, browser checks, and patch apply/rollback tests were intentionally not run at the user's request. No live deployment was performed.

## Rollback

Stop the app, run `npm run patch:rollback`, then `npm run build` and restart/redeploy. The patch updater creates a backup when applying the patch.
