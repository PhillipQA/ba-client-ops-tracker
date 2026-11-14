-- Schema v39: task timers.
--
-- A person can time their work on a task instead of typing the hours. Their timers are kept here, one row per
-- person, so a closed tab or another device loses nothing. Until this is run, timers are unavailable and the rest of
-- the app works as before.
--
-- Run once on every existing database before deploying, as the database user the app connects with:
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f database/migrations/schema-v39-task-timers.sql
--
-- Safe to run again: it changes nothing the second time.

begin;
create table if not exists public.user_task_timers (
    tenant_id uuid not null references public.organizations(id) on delete cascade,
    user_id text not null,
    timers jsonb default '[]'::jsonb not null,
    updated_at timestamp with time zone default now() not null,
    primary key (tenant_id, user_id)
);
commit;

select 'BA Client Ops Tracker database ready' as result, 39 as schema_version;
