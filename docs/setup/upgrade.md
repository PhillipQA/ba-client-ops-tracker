# Upgrade an existing installation

**Current application version: v0.6.99.**

Use the [README](../../README.md) for a new installation and the [changelog](../../CHANGELOG.md) to review changes. Version numbers in application releases and numbered database schemas are separate.

## Update from source

1. Back up the database and any separately stored evidence files.
2. Preserve your environment values and `TENANT_INTEGRATION_MASTER_KEY`. Changing this key prevents existing integration credentials from being decrypted.
3. Check the migration table below and apply only missing changes.
4. In the existing checkout:

```bash
git pull --ff-only
npm ci
npm run build
npm run typecheck:server
```

Reconcile local source edits before pulling. Restart the local production server with `npm start`, or redeploy on your host. Reload the app and confirm **v0.6.99**.

## Database requirements

**Do not run `database/setup.sql` on an existing database.**

For an existing Supabase database, the recent incremental migrations are:

| First required release | Migration | Purpose |
| --- | --- | --- |
| v0.6.56 | [schema-v16](../../database/migrations/schema-v16-functional-integrity.sql) | Workspace revision checks and Gmail sync state/multiple labels |
| v0.6.60 | [schema-v17](../../database/migrations/schema-v17-brd-template.sql) | BRD template support |
| v0.6.63 | [schema-v18](../../database/migrations/schema-v18-drf-error-logs.sql) | Private DRF diagnostics |
| v0.6.75 | [schema-v19](../../database/migrations/schema-v19-work-hub-github.sql) | Personal GitHub connections and issues |
| v0.6.76 | [schema-v20](../../database/migrations/schema-v20-work-hub-gitlab.sql) | Personal GitLab connections and issues |
| v0.6.80 | [schema-v21](../../database/migrations/schema-v21-golive-template.sql) | Optional custom Go Live templates |
| v0.6.83 | [schema-v22](../../database/migrations/schema-v22-signoff-form-templates.sql) | Optional custom UAT Sign Off, UAT Deployment Approval and Training Sign Off templates |
| v0.6.87 | [schema-v23](../../database/migrations/schema-v23-drive-attachments.sql) | Shared Google Drive for Gmail attachments; private list of tasks created from each email |
| v0.6.92 | [schema-v24](../../database/migrations/schema-v24-trackers.sql) | Trackers: sheets with your own columns, saved views, encrypted Secret cells, row history and a log of every Secret reveal. Also adds Trackers to each account's enabled modules |
| v0.6.96 | [schema-v25](../../database/migrations/schema-v25-tracker-task-links.sql) | Optional: link tasks and subtasks to tracker rows and cells, and show them in the Action Center |

Apply missing migrations in numerical order. For v0.6.74/v0.6.75 installations missing the Git provider tables, the [combined v19/v20 upgrade](../../database/upgrades/schema-v19-v20-work-hub-git-providers.sql) is available. Do not run both the combined script and the same individual migrations.

- **v0.6.78, v0.6.79, v0.6.81, v0.6.82, v0.6.84, v0.6.85 and v0.6.86 add no new database migration.**
- **v0.6.87:** apply v23 before connecting Google Drive. It works on Supabase and on plain PostgreSQL such as Northflank: Supabase-only roles and row-level security are applied only where those roles exist. On PostgreSQL, run it as the user that owns the tables, or grant the app's database user access to the new `tenant_drive_accounts` table afterwards. Until v23 is applied, Settings and Work Hub say so and nothing else changes. Tasks created from an email before v23 are still offered when saving that email's attachments, but only the most recent one.
- **v0.6.92:** apply v24 before using Trackers. It works on Supabase and on plain PostgreSQL such as Northflank (row-level security is applied only where the Supabase roles exist). On PostgreSQL, run it as the user that owns the tables, or grant the app's database user access to the new `tenant_trackers`, `tenant_tracker_rows` and `tenant_tracker_changes` tables afterwards. Until v24 is applied, the Trackers page says the migration is missing and nothing else changes. After applying it, Administrators see **Trackers** when they next sign in; give other people the **Trackers** module under Users & Permissions → Module access. Secret cells are encrypted with `TENANT_INTEGRATION_MASTER_KEY`, so keep that key: if it changes, stored Secret values can no longer be revealed. The recipient suggestions in the same release need no database change.
- **v0.6.96:** apply v25 to link tasks and subtasks to tracker rows and cells. It is optional: without it Trackers, move rows and change column type all work, and the link card says the migration is missing. It adds one table, `tenant_tracker_task_links`, and works on Supabase and plain PostgreSQL such as Northflank. On PostgreSQL, run it as the user that owns the tables, or grant the app's database user access to the new table afterwards.
- **v0.6.97, v0.6.98 and v0.6.99 add no new database migration.** v0.6.98's subtask cells use the v25 task links table, so apply v25 first if you skipped it.
- **v0.6.93, v0.6.94 and v0.6.95 add no new database migration.**
- Built-in Go Live generation works with the existing template table; v21 enables custom Go Live uploads/removal.
- The built-in UAT Sign Off, UAT Deployment Approval and Training Sign Off forms also work with the existing template table. Apply v22 before uploading or removing custom templates for them in Settings → Templates; until then those cards can only use the built-in template.
- For installations earlier than these rows, consult the [historical release notes](../releases/README.md) for prior schema prerequisites.
- PostgreSQL imports must contain the applicable schema and tracker functions. See the [cutover guide](northflank-postgres-cutover.md). Supabase-specific role/storage setup is not a fresh-install recipe for plain PostgreSQL; confirm compatibility before applying an older Supabase migration there.

Applying migrations is separate from installing code. Neither `git pull` nor the patch updater executes database SQL.

## Official patch ZIPs

Use this route only when an official patch matches your installed version.

```powershell
npm run patch:status
npm run patch -- "C:\Downloads\ba-client-ops-patch-vX.Y.Z.zip"
npm ci
npm run build
npm run typecheck:server
```

Replace the ZIP path with the actual patch and follow its version-specific instructions. Do not force a patch intended for a different baseline. Restart/redeploy after applying it.

`npm run patch:rollback` restores the most recently applied patch's code backup. It does not roll back database migrations, passwords or data changes. Patch backups are local; a source checkout update is managed through Git rather than this patch rollback command.

## Verify after updating

- Check the displayed application version.
- Open an existing workspace and confirm clients, projects and tasks are present.
- Check integrations you use, existing evidence downloads and document generation.
- For v0.6.98 (schema v25 needed for subtask cells): hard refresh, open a tracker's details and add two clients. Point at a row's first cell, click **+ Task**, create the task for one of the clients, then click **+** in another column and create its subtask; confirm both appear in Tasks under the right client and project and that closed tasks are not offered. Select a few rows and use **Create tasks**. Add a **Calculated** column such as `[Qty] * [Price]`, tick **Show the SUM in the totals row**, and confirm the totals row at the bottom.
- For v0.6.96 (apply schema v25 first for links): hard refresh, open a tracker, select a row and use **Move up**, **Move down**, **Top** or **Bottom** (or drag the row number); with a sort, filter, group or search active, moving is turned off. Open a column's **Edit column…** and change its type, then **Check the change** to see what would be cleared before confirming. Open a row, link a subtask under **Tasks and subtasks** (whole row or one column), set that subtask's follow-up date, and confirm it shows on that day in the Action Center with the tracker, row and cell, and that clicking the chip opens the row. In full view, confirm Import, Export and Exit full view are small icon buttons.
- For v0.6.95 (no database change): hard refresh, open a tracker with a long text column, open that column's menu and choose **Wide**, **Freeze column** and an alignment. In a Link column type `#1234 https://example.com/ticket` and confirm the cell shows #1234 and opens the address. Confirm the frozen columns stay in view when you scroll sideways, drag a header edge to resize, and reload to confirm the choices stay.
- For v0.6.94 (no database change): hard refresh, open a tracker and click **Full view**. Confirm the top bar (Add client, Add task) disappears, the left menu stays and the grid fills the screen, then click **Exit full view**.
- For v0.6.93 (no database change): hard refresh (Ctrl+Shift+R). Click the panel button beside the logo to collapse the left menu to icons, hover an icon and confirm its name appears, then reload and confirm the menu stays collapsed. In **My Themes** switch between Dark, Light and Gray and confirm no panel stays dark in the light looks.
- For v0.6.92, after applying v24: open **Trackers**, create a tracker from a template and add a row. Add a **Secret** column, save a fictional value, and confirm the grid shows only dots until you click **Reveal** in the row panel, and that the row's **History** lists the reveal without the value. Link the row to a task and confirm **Task status** fills in. Sign in as a Viewer and confirm the tracker opens but cannot be changed. Recipient suggestions (no database change): open **New email**, type the first letters of someone you have emailed before, and confirm they appear in the suggestions with how often you emailed them. Choose one with the arrow keys and Enter and confirm the address is added. In Document Creation, type a teammate's or client contact's full name in a signatory **Name** field, click away, and confirm their email fills in with a note to check it; a name nobody knows must leave the email empty.
- For v0.6.91 (no database change): open an email in Work Hub that was sent to several people, click **Reply by email**, and confirm the other people appear in Cc with a note offering **Reply to sender only**.
- For v0.6.90 (no database change): add the `gmail.send` scope to your Google Cloud consent screen (Data Access). In Work Hub → My integration settings choose **Allow sending email** and approve it on Google's page. Open a task that has a saved Drive file, click **Email**, send it to yourself, and confirm the 10-second Undo bar, the email in your Gmail Sent folder, a copy marked **Sent** in Work Hub linked to the task, and a short note in the task's activity.
- For v0.6.89 (no database change): sign a test DRF in DocHub with a task or subtask linked, and confirm the signed PDF appears in that task's folder in Drive and on the task under **Saved to Google Drive**. In Document Creation → DRF, **Choose from Google Drive** lists the files saved on tasks.
- For v0.6.87, after applying v23 and enabling the Google Drive API: as an account administrator open Settings → Integrations → Google Drive and connect. In Work Hub, create a task from a Gmail message with an attachment, click **Save to Drive**, pick the task or a subtask, and confirm the file appears under BA Client Ops Tracker / Client / Project / Task in Drive and as **Saved to Google Drive** on the task.
- For v0.6.86, open Work Hub, select a Gmail message that has an attachment and click the file name. It should download. Messages synced before this version download the same way.
- For v0.6.85, generate a BRD preview and an FSD preview and confirm the page text is dark on white, in dark and light appearance and with a wallpaper theme.
- For v0.6.84, generate an FSD preview and a BRD preview. A reply the AI formats badly is now repaired or retried automatically instead of stopping with "The AI returned an invalid document".
- For v0.6.83, open Document Creation → Sign Off Document and confirm all five forms are listed, then generate a UAT Sign Off with a table row. In Internal Admin → Task configuration, confirm the Waiting on options list.
- For v0.6.82, switch Tasks to Board view, log time on a task, and create a task from Work Hub → Linked work with a Waiting on value and dates. A browser that had the old version open needs one hard refresh (Ctrl+Shift+R) after this deploy.
- For v0.6.81, create two differently named tasks from one email. The form should stay open; trying an existing title for the same client/project should show a duplicate warning.

Focused automated checks:

```bash
npm run test:communications
npm run test:work-hub-tasks
npm run test:work-hub-sync
npm run test:trackers
```
