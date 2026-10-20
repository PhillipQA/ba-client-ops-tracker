# Database setup

The current fresh Supabase setup includes **schema versions 1–21**. Application v0.6.82 adds no migration beyond that schema.

## Choose the correct path

| Situation | Action |
| --- | --- |
| New, empty Supabase project | Run the complete [setup.sql](setup.sql) once in SQL Editor |
| Existing Supabase database | Apply only missing migrations from the [upgrade guide](../docs/setup/upgrade.md) |
| Moving the app while keeping the same database | Reuse the connection settings and integration master key; no fresh setup |
| Restoring existing data to another Supabase project | Restore a backup, copy storage files and apply only missing migrations |
| Existing Supabase data moving to Northflank PostgreSQL | Follow the [cutover guide](../docs/setup/northflank-postgres-cutover.md) |

The fresh setup creates empty tables and the initial account placeholders. It does not transfer users, workspaces, communications, documents, credentials or storage files. It checks for existing tracker tables and stops if it finds an existing or partial installation. It is not a rerunnable upgrade script.

## Fresh Supabase installation

1. Create a new, empty Supabase project.
2. Open SQL Editor, paste the complete [setup.sql](setup.sql), and run it once.
3. Confirm the result reports `BA Client Ops Tracker database setup complete` and `schema_version = 21`.
4. Configure `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `TENANT_INTEGRATION_MASTER_KEY`, `APP_BASE_URL` and the two bootstrap passwords on the application server.
5. Continue with the [installation and first-login guide](../README.md#install-locally).

No default working passwords are stored in the SQL. Bootstrap passwords must have at least 12 characters; the initial Account/User pairs are `internal_admin`/`admin` and `BXI-Core`/`Admin`.

## PostgreSQL / Northflank

The application supports `DATABASE_PROVIDER=postgres` with an application-user `DATABASE_URL`. The supported cutover imports an existing tracker database and prepares its permissions and evidence storage. [setup.sql](setup.sql) contains Supabase-specific setup and is not a standalone plain-PostgreSQL initialization script.

Database maintenance scripts read `.env` by default. When running locally with `.env.local`, either provide the variables to the process or set `DOTENV_CONFIG_PATH=.env.local`. The app server itself loads `.env.local` automatically.

## Folder contents

- `setup.sql` — complete fresh Supabase setup.
- `migrations/` — incremental schema changes.
- `upgrades/` — selected combined upgrades for matching older installations.
- [Upgrade guide](../docs/setup/upgrade.md) — current migration requirements and ordering.

## Maintaining the setup bundle

After adding a numbered migration:

```bash
npm run db:bundle
npm run db:check
```

The generator builds the ordered fresh-install script and records source checksums. These commands do not execute SQL or connect to a database. Commit the matching setup script and migrations together. Keep database exports and credentials out of this folder.
