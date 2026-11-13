-- Schema v37: trackers that add new Seeds projects as rows.
--
-- A tracker switched on for it ("Add new Seeds projects as rows", in Tracker details) gets a row, with its task, for
-- each new Seeds project of one of its clients that the Seeds sync brings in. Trackers made before it are off.
--
-- Run once on every existing database before deploying, as the database user the app connects with:
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f database/migrations/schema-v37-tracker-seeds-rows.sql
--
-- Safe to run again: it changes nothing the second time.

begin;
alter table public.tenant_trackers add column if not exists seeds_rows boolean default false not null;
commit;

select 'BA Client Ops Tracker database ready' as result, 37 as schema_version;
