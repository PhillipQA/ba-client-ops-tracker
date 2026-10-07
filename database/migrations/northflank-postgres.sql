-- Apply after restoring the application's public schema to Northflank PostgreSQL.
-- Prefer npm run db:prepare-postgres, which discovers the application role and
-- applies the grants and RLS change in one transaction using PG_ADMIN_URL.
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

-- The restored Supabase tables have RLS policies for a future browser/JWT path.
-- This private Northflank database is only accessed by the Node server. Its
-- application role needs full rows (like the old Supabase service role).
-- As the owner/admin of the restored tables, disable RLS on the destination's
-- imported public tables, then grant privileges to the standard POSTGRES_URI
-- role. Do not run these against the Supabase source.
-- Example per table: alter table public.tenant_state disable row level security;
-- Replace <APP_DB_USER> with the username in Northflank's POSTGRES_URI:
-- grant usage on schema public to <APP_DB_USER>;
-- grant select, insert, update, delete on all tables in schema public to <APP_DB_USER>;
-- grant usage, select, update on all sequences in schema public to <APP_DB_USER>;
-- grant execute on all functions in schema public to <APP_DB_USER>;
-- alter default privileges in schema public grant select, insert, update, delete on tables to <APP_DB_USER>;
-- alter default privileges in schema public grant usage, select, update on sequences to <APP_DB_USER>;
