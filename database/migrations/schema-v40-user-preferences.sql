-- Schema v40: per-person preferences.
--
-- Each person's own settings that follow them across browsers and devices, one row per person as JSON. The first
-- one is their Action Center layout (which widgets, in what order, how wide). Until this is run, a person's layout is
-- kept only in their browser and the rest of the app works as before.
--
-- Run once on every existing database before deploying, as the database user the app connects with:
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f database/migrations/schema-v40-user-preferences.sql
--
-- Safe to run again: it changes nothing the second time.

begin;
create table if not exists public.user_preferences (
    tenant_id uuid not null references public.organizations(id) on delete cascade,
    user_id text not null,
    prefs jsonb default '{}'::jsonb not null,
    updated_at timestamp with time zone default now() not null,
    primary key (tenant_id, user_id)
);
commit;

select 'BA Client Ops Tracker database ready' as result, 40 as schema_version;
