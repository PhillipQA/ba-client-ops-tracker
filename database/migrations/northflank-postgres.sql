-- Apply after restoring the application's public schema to Northflank PostgreSQL.
-- Connect as the owner/admin of the restored tables. The app's DATABASE_URL user
-- must have table, sequence, and function privileges and must bypass Supabase RLS.
begin;
create table if not exists public.tracker_evidence_files (
  bucket text not null,
  storage_path text not null,
  mime_type text not null,
  content bytea not null,
  created_at timestamptz not null default now(),
  primary key (bucket, storage_path)
);
commit;

-- Replace <APP_DB_USER> with the username in Northflank's POSTGRES_URI and run
-- these grants as the owner of the restored objects (without angle brackets):
-- grant usage on schema public to <APP_DB_USER>;
-- grant select, insert, update, delete on all tables in schema public to <APP_DB_USER>;
-- grant usage, select, update on all sequences in schema public to <APP_DB_USER>;
-- grant execute on all functions in schema public to <APP_DB_USER>;
-- alter default privileges in schema public grant select, insert, update, delete on tables to <APP_DB_USER>;
-- alter default privileges in schema public grant usage, select, update on sequences to <APP_DB_USER>;
-- Supabase tables may have row level security. The application DB role needs
-- BYPASSRLS (or ownership of all restored tables, without FORCE ROW LEVEL SECURITY).
-- Check: select current_user, rolbypassrls from pg_roles where rolname = current_user;
-- If false, have the database admin grant BYPASSRLS to the application role.
