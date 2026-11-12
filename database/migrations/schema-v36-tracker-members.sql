-- Schema v36: people added to a tracker by hand.
--
-- A tracker shows in the folder of each of its users: its creator, the people on its projects, and the people its
-- creator or an Administrator adds by hand. This column keeps those added people (account ids). Trackers made before
-- it have nobody added, so the default is an empty list.
--
-- Run once on every existing database before deploying, as the database user the app connects with:
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f database/migrations/schema-v36-tracker-members.sql
--
-- Safe to run again: it changes nothing the second time.

begin;
alter table public.tenant_trackers add column if not exists members jsonb default '[]'::jsonb not null;
commit;

select 'BA Client Ops Tracker database ready' as result, 36 as schema_version;
