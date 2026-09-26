# Deploy on a new server

## Decide whether the database is new

If the new server will use your existing Supabase project, skip database setup. Use that project's URL/service-role key and the **same integration master key**. This keeps existing data accessible. Do not run `database/setup.sql` on that database.

For a completely new installation, create a new Supabase project. Open **SQL Editor**, paste the complete contents of **`database/setup.sql`**, and run it once. You do not need to run schema.sql or v2–v14 individually. The last result reports `BA Client Ops Tracker database setup complete` with schema version `14`.

This fresh setup creates empty application tables and initial account placeholders. If you want your existing data in another database, use a database backup/restore instead, and migrate any associated storage files separately. Preserve the integration master key. A fresh schema script is not a data backup.

## Configure the application server

Extract the full build, or deploy its source through your normal repository workflow. Use Node.js 22 or newer. Configure these environment variables privately on the server (or in `.env.local` for local work):

| Variable | Value |
| --- | --- |
| `SUPABASE_URL` | Target Supabase project's URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Target project's service-role key; server only |
| `TENANT_INTEGRATION_MASTER_KEY` | Existing key when moving data; generate a new key for a separate new installation |
| `APP_BASE_URL` | Public HTTPS URL of the new app server |
| `INTERNAL_ADMIN_BOOTSTRAP_PASSWORD` | Unique password of at least 12 characters; required for the initial platform account |
| `BXI_CORE_BOOTSTRAP_PASSWORD` | Unique password of at least 12 characters; required for the initial BXI-Core account |

Generate a master key for a **new independent installation** with:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Install and build:

```bash
npm ci
npm run build
npm start
```

For Render, the build command can be `npm ci && npm run build`, with `npm start` as the start command. Let Render supply its port. The bootstrap passwords initialize the seeded users when they first successfully sign in; the SQL file does not contain working passwords.

## First login and integrations

Use Account `internal_admin`, User `admin`, and your platform bootstrap password to manage tenants. Use Account `BXI-Core`, User `Admin`, and the BXI-Core bootstrap password for the initial tenant. The initial tenant includes the current module list, including Requirements & Traceability.

Integration approval and credentials are still configured through Internal Admin and each tenant's Settings. On a new independent database, configure those connections again. If the application's public URL changed, use the new callback addresses displayed in Gmail and Calendar account setup to update the corresponding Google OAuth clients and app settings before reconnecting.

This guide changes database installation packaging only. It does not migrate data automatically or replace your server environment settings.
