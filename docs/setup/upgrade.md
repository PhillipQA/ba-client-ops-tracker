# Upgrade an existing installation

**Current application version: v0.6.84.**

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

Reconcile local source edits before pulling. Restart the local production server with `npm start`, or redeploy on your host. Reload the app and confirm **v0.6.84**.

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

Apply missing migrations in numerical order. For v0.6.74/v0.6.75 installations missing the Git provider tables, the [combined v19/v20 upgrade](../../database/upgrades/schema-v19-v20-work-hub-git-providers.sql) is available. Do not run both the combined script and the same individual migrations.

- **v0.6.78, v0.6.79, v0.6.81 and v0.6.82 add no new database migration.**
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
- For v0.6.84, generate an FSD preview and a BRD preview. A reply the AI formats badly is now repaired or retried automatically instead of stopping with "The AI returned an invalid document".
- For v0.6.83, open Document Creation → Sign Off Document and confirm all five forms are listed, then generate a UAT Sign Off with a table row. In Internal Admin → Task configuration, confirm the Waiting on options list.
- For v0.6.82, switch Tasks to Board view, log time on a task, and create a task from Work Hub → Linked work with a Waiting on value and dates. A browser that had the old version open needs one hard refresh (Ctrl+Shift+R) after this deploy.
- For v0.6.81, create two differently named tasks from one email. The form should stay open; trying an existing title for the same client/project should show a duplicate warning.

Focused automated checks:

```bash
npm run test:communications
npm run test:work-hub-tasks
npm run test:work-hub-sync
```
