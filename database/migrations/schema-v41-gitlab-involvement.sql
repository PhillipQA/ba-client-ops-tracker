-- Schema v41: GitLab tickets from every project, and more about each one.
--
-- Work Hub now pulls the GitLab issues a person is part of from every project they can see: ones they created, ones
-- assigned to them, and ones they commented on. Three columns are added to the cached issues:
--   commented_by_me  the person commented on the issue (kept once found)
--   due_date         the issue's due date, for the Due filter and sorting
--   details          weight, time estimate and spent, checklist progress, iteration, confidential, linked merge
--                    requests, type, and when and by whom it was closed
-- Until this is run, GitLab sync and the ticket list in Work Hub stop with a message asking for it.
--
-- Run once on every existing database before deploying, as the database user the app connects with:
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f database/migrations/schema-v41-gitlab-involvement.sql
--
-- Safe to run again: it changes nothing the second time.

begin;
alter table public.user_gitlab_issues add column if not exists commented_by_me boolean default false not null;
alter table public.user_gitlab_issues add column if not exists due_date date;
alter table public.user_gitlab_issues add column if not exists details jsonb default '{}'::jsonb not null;
create index if not exists user_gitlab_issues_owner_due
    on public.user_gitlab_issues (tenant_id, owner_user_id, instance_url, gitlab_user_id, due_date);
commit;

select 'BA Client Ops Tracker database ready' as result, 41 as schema_version;
