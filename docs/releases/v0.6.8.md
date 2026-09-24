# BA Client Ops Tracker v0.6.8

Adds client/project editing and archive/reactivate controls. The patch requires **v0.6.7**. No database migration, environment change, or new npm dependency is required.

## Behavior and permissions

| Action | Administrator | Contributor | Viewer |
| --- | --- | --- | --- |
| Rename an existing client | Yes, with Clients access | No | No |
| Edit client contact, health, notes, completion status | With Clients access | With Clients access | No |
| Edit project name, summary, target date, completion status | With Projects access | With Projects access | No |
| Archive / Activate client or project | With the relevant module | With the relevant module | No |
| Delete client or project | Never | Never | Never |

Existing permissions for creating clients/projects and working with tasks remain in place. Renaming retains record IDs, tasks, subtasks, report links, and client theme associations. Archived metadata can still be corrected through Edit; completion status remains Closed until activation.

## Completion and archive workflow

1. Finish every task and subtask. A task status marked as closed in Internal Admin counts as complete. Setting only Waiting on = Done does not bypass an open task status.
2. Edit the client and set Completion status to **Closed**. Closing is blocked while any of that client's tasks/subtasks remain open, including work on other projects.
3. Edit the project and set Completion status to **Closed**. Closing is blocked while any of its tasks/subtasks remain open.
4. Choose **Archive / Deactivate**. The project must be Closed, every related task/subtask complete, and every linked client Closed. Client archiving similarly requires the client Closed, its work complete, and all linked projects Closed. A record with no linked work can be closed and archived.
5. Use the **Archived / Inactive** or **All** filter to find the record later, open it, and choose **Activate**.

**Active** means usable; **Archived / Inactive** means read-only work. Completion status is separate. Activation preserves the previous Closed completion status and all history; use Edit to change the completion status when appropriate. Activate the project before changing a linked client's completion status away from Closed. If both client and project are archived, activate both before resuming their work.

Projects are shared across clients. Their archive check always covers all clients, even when viewing the project through one client's dashboard. This release uses the client's existing account-wide Closed status; it does not introduce a separate client-completion status for each project.

## Archived records and history

- Clients and Projects now have Active, Archived / Inactive, and All filters. Existing records default active.
- Archived records and their completed tasks, communications, reports, and evidence remain viewable.
- Archived clients/projects are excluded from new task and AI work selectors. Server checks also block creating, reopening, editing, deleting, moving, or adding evidence to archived work. Historical evidence downloads remain available.
- AI-applied work and planner changes follow the same archive guard. Discord messages are still captured; archived references are left unassigned instead of creating work inside an archive.
- A project cannot be archived by removing or reassigning unfinished tasks in the same save. Subtasks are checked independently, including older records that inherit their association through a parent.
- Name/archive changes are applied in the UI only after their save succeeds. Record versions reject stale metadata updates. Per-tenant server serialization rechecks the latest snapshot before committing an in-flight save; conflicting requests report a reload/retry message.

Archive state and record versions are stored in existing tenant snapshots and normalized raw_data. Use the existing **single application instance** deployment configuration; the serialization lock is process-local.

## Apply the patch

1. Stop the app. In `E:\Playwright\ba-client-ops-tracker`, run `npm run patch:status` and confirm **0.6.7**. Complete earlier upgrades first.
2. Save `ba-client-ops-patch-v0.6.8-from-v0.6.7.zip` in `E:\Playwright`.
3. From the project folder, run:

```bat
npm run patch -- "E:\Playwright\ba-client-ops-patch-v0.6.8-from-v0.6.7.zip"
npm run test:lifecycle
npm run typecheck:server
npm run build
npm run patch:status
```

Restart with `npm run dev`. To update Render, commit the patched source to the connected repository and redeploy using the existing build/start commands. The local patch does not update the hosted app. Refresh browser tabs after deployment so older clients cannot attempt obsolete saves.

The full-build ZIP is source for a separate installation or replacement checkout. It excludes credentials, tenant data, dependencies, and compiled output. Follow README.md for a fresh installation.

## Deployment checks

1. As Administrator, rename a client. Verify the new name throughout linked tasks/projects/reports and after reload.
2. As Contributor, verify client name is read-only, project name can be edited with Projects access, and missing module access blocks editing. Confirm Viewers cannot edit or archive.
3. Create a shared project with two clients and a subtask. Leave the subtask open while its parent is done: archive must stay blocked. Complete all work but leave one client Active: archive must still stay blocked.
4. Close both clients and the project, archive, and verify it appears under Archived / Inactive. Confirm tasks cannot be added or changed and evidence still opens.
5. Activate the project/client, add work again, and verify archive state survives reload and another user signing in.
6. Confirm existing Sign Off, DRF/FSD, user management, themes, and integrations still operate.

## Validation and limits

- Production frontend build and strict server TypeScript checks passed.
- All 34 automated tests passed: 14 lifecycle/save-guard tests, nine account/profile/theme tests, five integration tests, and six Sign Off tests.
- Lifecycle tests cover rename permissions, module/Viewer restrictions, deletion prevention, shared-client/subtask completion, custom completion statuses, archive write restrictions, activation, inherited associations, stale versions, concurrent commits, tenant isolation, and failed saves. The persistence tests use in-memory stores; they do not prove live Supabase connectivity.
- The real patch updater was verified for apply, byte-for-byte payload identity, environment preservation, version guard, and rollback.
- Browser interaction/visual QA and live Render/Supabase deployment were not performed; an installed browser executable was unavailable. Perform the deployment checks above before relying on the new flow in production.

## Roll back

Stop the app, run `npm run patch:rollback`, rebuild, and redeploy the restored source. No SQL migration requires reversal. Rollback restores code; saved renames and archive flags are not reversed. v0.6.7 does not understand archive restrictions or project archive fields, so do not resume normal work on archived data with that older version. Keep a current database backup and prefer a forward fix if archives have been used.
