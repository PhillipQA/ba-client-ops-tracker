-- Schema v45: GIT Tracker rows follow their ticket.
--
-- A GIT Tracker's columns named after a ticket field (Title, Labels, Due date…) or a label group (Priority takes
-- High from priority::high) fill themselves from the ticket. When GitLab or GitHub is synced (sign-in, Sync in Work
-- Hub, Refresh in the GIT Tracker) they are updated to what the ticket says now, except cells a person changed by
-- hand, which are pinned.
--
--   tenant_git_tracker_tickets.follows_ticket   whether the entry's rows follow the ticket (on unless turned off)
--   tenant_git_tracker_tickets.pinned_cells     row id -> column ids changed by hand, which a refresh leaves alone
--   tenant_git_tracker_tickets.refreshed_at     when the rows were last compared with the ticket
--
-- Run once on every existing database before deploying, as the database user the app connects with:
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f database/migrations/schema-v45-git-follow.sql
--
-- Safe to run again. Until it is run, GIT Trackers work as before: new rows still fill from the ticket, but nothing
-- is refreshed.

begin;

alter table public.tenant_git_tracker_tickets add column if not exists follows_ticket boolean default true not null;
alter table public.tenant_git_tracker_tickets add column if not exists pinned_cells jsonb default '{}'::jsonb not null;
alter table public.tenant_git_tracker_tickets add column if not exists refreshed_at timestamp with time zone;

commit;

select 'BA Client Ops Tracker database ready' as result, 45 as schema_version;
