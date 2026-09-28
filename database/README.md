# Database setup

For a **new Supabase project**, use just **[`setup.sql`](setup.sql)**. Paste the complete file into Supabase SQL Editor and click **Run once**. It includes schema versions 1–17 in dependency order, all current tables, indexes, functions, row security, permissions, and the initial Internal Admin / BXI-Core accounts.

| Deployment situation | What to run |
| --- | --- |
| New app installation with a new, empty Supabase database | `database/setup.sql` once |
| Moving the app to another server while keeping the same Supabase project | No database SQL |
| Updating an existing database | Only newer migrations required by the release notes |
| Moving existing data to a new Supabase project | Restore a database backup first; then apply only missing migrations. Do not run fresh setup over the restored database. |

`setup.sql` creates the database structure and initial account placeholders. It does **not** transfer existing users, projects, messages, documents, integration credentials, or storage files. Existing integrations and their data require the same `TENANT_INTEGRATION_MASTER_KEY` when moving servers.

The script stops before making changes if any BA Tracker table already exists, including a partial installation. All setup statements use one transaction: an error rolls back the setup. It is intentionally a fresh-install script, not a rerunnable upgrade script. Use a new empty project or the appropriate migration path if the guard stops it; do not delete production tables to make it run.

The initial accounts have no default password. Set these on the application server before first login:

- `INTERNAL_ADMIN_BOOTSTRAP_PASSWORD` — at least 12 characters, for Account `internal_admin`, User `admin`.
- `BXI_CORE_BOOTSTRAP_PASSWORD` — at least 12 characters, for Account `BXI-Core`, User `Admin`.

Also configure `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `TENANT_INTEGRATION_MASTER_KEY`, and `APP_BASE_URL`. Follow [the deployment guide](../docs/setup/deploy-new-server.md).

## Folder contents

- `setup.sql` — the only SQL file needed for a fresh installation.
- `migrations/` — historical upgrades, retained for existing environments and release traceability. Fresh installations do not need to open these individually.
- `README.md` — these instructions.

## Keeping the setup current

When adding a numbered migration, regenerate the setup from the repository root:

```bash
npm run db:bundle
npm run db:check
```

The generator requires a complete, ordered migration sequence, includes source checksums, and strips only standalone transaction wrappers before surrounding the combined script with one transaction. It does not execute SQL or contact Supabase. Keep `setup.sql` committed with the matching migrations. Never put credentials or database exports in this folder.

## Upgrading from v0.6.55 to v0.6.56

Stop the old app, run `migrations/schema-v16-functional-integrity.sql` once, deploy v0.6.56 and rebuild. This adds atomic revision checks and Gmail sync progress / multiple labels. Do not use `setup.sql` on an existing database. All active server instances must use v0.6.56 before users resume; older servers call the legacy save function. Users should reload their browser after upgrading.

## Upgrading from v0.6.59 to v0.6.60

Run `migrations/schema-v17-brd-template.sql` once, then deploy v0.6.60 and rebuild. This only expands the document-template type constraint so each account can use the built-in or a custom BRD template. Existing data and templates are preserved. Do not run `setup.sql` on an existing database.
