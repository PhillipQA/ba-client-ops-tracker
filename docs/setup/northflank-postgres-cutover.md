# Move existing tracker data to Northflank PostgreSQL

The app supports `DATABASE_PROVIDER=postgres`. This guide covers importing an existing Supabase tracker database, not creating a plain PostgreSQL database from scratch.

A PostgreSQL dump of `public` does not include Supabase Storage evidence files. Copy those separately using the evidence migration command below.

## 1. Prepare the final import

1. Confirm that the source project matches the running app's `SUPABASE_URL`.
2. Pause writes to the old app during the final export/import. An earlier restore is a snapshot, not continuous replication.
3. Restore the final Supabase `public` schema/data to the destination PostgreSQL addon. Preserve account records, tracker functions and the applicable schema migrations.
4. Keep the source database and a backup until destination verification succeeds.
5. Preserve `TENANT_INTEGRATION_MASTER_KEY` exactly so stored integration credentials remain readable.

## 2. Configure a one-off maintenance process

Use a secure service shell or temporary job that can reach both databases. Provide:

| Variable | Value |
| --- | --- |
| `DATABASE_URL` | Destination PostgreSQL application-user URI |
| `PG_ADMIN_URL` | Destination admin URI for the preparation command; use the same host/database with the separate admin user |
| `SUPABASE_URL` | Currently running source project's URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Source project's server-side service-role key |

The helper scripts read process environment variables and `.env` by default. If running locally with `.env.local`, set the dotenv path first:

**PowerShell**

```powershell
$env:DOTENV_CONFIG_PATH = ".env.local"
```

**macOS / Linux**

```bash
export DOTENV_CONFIG_PATH=.env.local
```

Keep the admin URI in the one-off maintenance process rather than the permanent application service.

## 3. Prepare, compare and copy evidence

From the repository root:

```bash
npm ci
npm run db:prepare-postgres
npm run db:verify-migration
npm run db:migrate-evidence
```

- Preparation creates `public.tracker_evidence_files`, grants the application user access and disables imported Supabase row policies on the private destination tables. It runs in one transaction and does not modify Supabase.
- Verification compares source/destination counts for the tables it checks and each workspace revision. It fails on mismatches; it is not a full byte-for-byte comparison of every column.
- Evidence migration copies referenced task files into the destination evidence table. Rerunning updates existing copies.

Do not switch the running app if verification or evidence transfer fails. Resolve mismatched data, absent tracker functions or missing files first. Preparation can report absent optional password-recovery functions; if recovery is needed, restore its schema/functions before testing it.

## 4. Switch the application service

1. Build with `npm ci && npm run build`; start with `npm start`.
2. Set `DATABASE_PROVIDER=postgres` and the application user's `DATABASE_URL` on the service. Use the destination's required TLS settings and a hostname the service can reach.
3. Keep the existing integration key and public `APP_BASE_URL`.
4. Retain source Supabase variables until verification and the live checks below pass; PostgreSQL runtime mode does not use them.
5. Redeploy with one application instance.

For desktop database administration, a private addon hostname may need Northflank forwarding. Do not assume it is directly reachable from DBeaver on your computer.

## 5. Verify and retire the old connection

Check Internal Admin login, a tenant workspace, an existing evidence download, a harmless saved edit and the integrations you use. Confirm password recovery if enabled.

After these checks pass, remove the unused Supabase variables from the application service and linked configuration, then redeploy. Keep the source backup until the rollout is accepted.

To return to Supabase, set `DATABASE_PROVIDER=supabase`, restore its connection variables and redeploy. PostgreSQL writes made after cutover are not copied back automatically; reconcile those records before rollback.

See the [README](../../README.md) for application installation and the [upgrade guide](upgrade.md) for version/schema requirements.
