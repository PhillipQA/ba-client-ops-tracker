-- Schema v38: the BA Assistant's memory.
--
-- Each person can ask the BA Assistant to remember short notes (their preferences and standing facts). They are kept
-- here, one row per person. Until this is run the assistant works as before and simply remembers nothing.
--
-- Run once on every existing database before deploying, as the database user the app connects with:
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f database/migrations/schema-v38-assistant-memory.sql
--
-- Safe to run again: it changes nothing the second time.

begin;
create table if not exists public.user_assistant_memory (
    tenant_id uuid not null references public.organizations(id) on delete cascade,
    user_id text not null,
    notes jsonb default '[]'::jsonb not null,
    updated_at timestamp with time zone default now() not null,
    primary key (tenant_id, user_id)
);
commit;

select 'BA Client Ops Tracker database ready' as result, 38 as schema_version;
