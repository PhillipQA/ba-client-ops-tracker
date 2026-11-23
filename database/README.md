# Database

The app uses **PostgreSQL** (on Northflank in production), reached through `DATABASE_URL`.

- [`schema.sql`](schema.sql) creates everything the app needs on an **empty** database, at the latest schema version (the number in its last line), plus the two starting sign-ins. It contains no data and no passwords.

## Set up a new database

Run `schema.sql` once, as the same database user the app connects with, so that user owns the tables:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f database/schema.sql
```

It should end with `BA Client Ops Tracker database ready` and that version number. No `psql`? Open the file in DBeaver (or any SQL client) connected to the database and run the whole script.

`schema.sql` stops without changing anything if the app's tables already exist, so running it against the live database by mistake is harmless. **Never run it to "reset" a database**: it does not copy, keep or remove data.

On Northflank, the database is reachable only inside the project. To run the script from your computer, forward the addon first (Northflank CLI: `northflank forward addon --projectId <project> --addonId <addon>`), then use the forwarded connection string.

## The live database

The live Northflank database was moved from Supabase, so it still carries a few Supabase leftovers that `schema.sql` no longer creates: disabled row-level security policies, the `request_organization_id()` helper, and possibly the `pgcrypto` extension. They are not used and do no harm; leave them, or drop them at a quiet time:

```sql
-- Optional tidy-up on the live database (as the table owner). The app does not use any of these.
do $$ declare r record; begin
  for r in select schemaname, tablename, policyname from pg_policies where schemaname = 'public' loop
    execute format('drop policy %I on %I.%I', r.policyname, r.schemaname, r.tablename);
  end loop;
end $$;
drop function if exists public.request_organization_id();
```

## Updating an existing database

Each release that changes the database adds a file in [migrations/](migrations/) and says so in [CHANGELOG.md](../CHANGELOG.md) ("Database update needed: schema vNN"). Run those files in order, each once, before deploying that release. They are safe to run again. In DBeaver, open the file connected to the live database and run it with **Execute SQL Script** (Alt+X). If DBeaver shows `25P02 current transaction is aborted`, run `rollback;` and then the script again.

## Changing the schema later

1. Add a migration file with the next version number, `database/migrations/schema-v<next>-<what-it-does>.sql` (see the newest file in [migrations/](migrations/)), written so it can run once on an existing database (for example `alter table … add column if not exists …`).
2. Apply it to every existing database (the live one, and any test copies).
3. Fold the same change into `schema.sql` and bump its version number, so a new install gets it too.
4. Note it in [CHANGELOG.md](../CHANGELOG.md), saying what to run before deploying.

## Backups

Use Northflank's addon backups (or `pg_dump`) before applying a migration. Evidence files (task screenshots and attachments) are stored in the database, in `tracker_evidence_files`, so a database backup includes them.
