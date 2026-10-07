# BA Client Ops Tracker v0.6.77 — Active tab refresh

Automatic reads now follow the page and source tab you are viewing. The All Items / Tasks overview uses the loaded workspace and does not start automatic database checks. **Refresh now** is available in the top bar when you need current data.

## Install on v0.6.76

Apply `ba-client-ops-patch-v0.6.77-active-tab-refresh.zip` from the existing project folder:

```powershell
npm run patch -- "C:\Downloads\ba-client-ops-patch-v0.6.77-active-tab-refresh.zip"
npm run build
npm run typecheck:server
```

Restart or redeploy the app server, then reload the browser. Confirm version **0.6.77**. Restarting the server is necessary to stop the old background jobs.

This patch expects v0.6.76. The full build is also supplied for a fresh installation or a deployment that needs the complete project. Keep the existing environment configuration and integration encryption key when updating an existing deployment. This release adds no dependencies, environment variables, or database migrations. Databases already on v0.6.76 need no SQL changes. Earlier databases still require any unapplied migrations through schema-v20; see `database/README.md`.

## Refresh behavior

| View | Automatic reads while visible and online |
| --- | --- |
| All Items / Tasks overview | None. Use **Refresh now**. |
| Workspace data views, including a selected client or project | Small revision check on entry, return to the page, and every five minutes. Download the workspace only after a change. |
| Work Hub → Email | Gmail sync on entry and every five minutes, with paced continuation while Email remains active. Other source tabs do not sync Gmail. |
| Work Hub → Discord | Only the current message page is refreshed every two minutes. The bot continues receiving incoming messages. |
| Work Hub → GitHub / GitLab | Only the selected provider syncs. Checks and continuation stop when you leave it, open its settings, hide the browser tab, or go offline. |
| Documents or a linked task outside All Items | Pending document checks every two minutes. History reads small revision metadata before fetching document cards. Preparations still converting to PDF check every 15 seconds while their form is active. |
| Hidden browser tab or offline page | Automatic checks pause. In-flight automatic browser requests are cancelled. |

The initial sign-in still loads the workspace once. Explicit actions, including saves, manual refresh, opening notifications, and document generation, continue to read or write their required data. Incoming Discord messages and registered DocHub webhooks continue working. Requests already accepted by the server can finish after the browser cancels them.

The obsolete 12-second Discord inquiry poll is removed. Notifications no longer download the full workspace every minute. Opening the bell fetches only the notification field. Background scans of every tenant's workspace and documents are removed. Follow-up dates and due alerts catch up on the next workspace load, detected change of business date, or save; they do not require an idle server scan. Document history no longer downloads file bytes or the workspace just to look up creator names.

## Checks

Production build, server type checking, existing functional regressions, communications tests, and 14 new refresh/egress checks pass. The new checks cover All Items suppression, hidden/offline and source-switch cancellation, unchanged/changed revisions, preservation of an edit during refresh, tenant-midnight rollover detection, narrow Supabase projections, and scoped DocHub scans.

Live Supabase quota usage and external account sync were not measured in this environment. The fix reduces future unnecessary reads; it does not reverse bytes already transferred.

To rerun the checks:

```powershell
npm run test:functional
npm run test:communications
```
