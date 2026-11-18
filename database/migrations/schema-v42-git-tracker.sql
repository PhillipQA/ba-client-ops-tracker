-- Schema v42: GIT Tracker.
--
-- A GIT Tracker is a special kind of tracker. A person adds a GitLab or GitHub ticket to it from Work Hub (never
-- automatically), and the tracker's template turns the ticket into rows, Tasks and Subtasks under the Client and
-- Project its repository is mapped to. One GIT Tracker can hold tickets of every client.
--
--   tenant_trackers.kind                 'standard' (every tracker so far) or 'git'
--   tenant_trackers.git_config           the GIT template's generation rules, copied when the tracker is made
--   tenant_trackers.git_template_id/_revision   which template, and which revision of it, was copied
--   tenant_tracker_templates.kind        'standard' or 'git'; GIT templates are offered only for GIT Trackers
--   tenant_tracker_templates.generation  a GIT template's rows, column rules and field mapping
--   tenant_git_repository_mappings       per workspace, set by Administrators: repository -> Client and Project
--   tenant_git_tracker_tickets           a ticket added to a GIT Tracker, with the Client and Project it was mapped to
--                                        when it was added (kept even if the mapping changes) and its generation status
--   tenant_git_ticket_tasks              each Task and Subtask a ticket entry generated, and the rule that made it
--   user_github_issues.repository_id, user_gitlab_issues.repository_id
--                                        the provider's stable repository id, filled in by the next sync
--
-- Run once on every existing database before deploying, as the database user the app connects with:
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f database/migrations/schema-v42-git-tracker.sql
--
-- Safe to run again: it changes nothing the second time. Existing trackers and templates become 'standard' and
-- behave exactly as before.

begin;

alter table public.tenant_trackers add column if not exists kind text default 'standard' not null;
alter table public.tenant_trackers add column if not exists git_config jsonb default '{}'::jsonb not null;
alter table public.tenant_trackers add column if not exists git_template_id uuid;
alter table public.tenant_trackers add column if not exists git_template_revision integer;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'tenant_trackers_kind_check') then
    alter table public.tenant_trackers
      add constraint tenant_trackers_kind_check check (kind = any (array['standard'::text, 'git'::text]));
  end if;
end $$;
create index if not exists tenant_trackers_git on public.tenant_trackers (tenant_id) where kind = 'git';

alter table public.tenant_tracker_templates add column if not exists kind text default 'standard' not null;
alter table public.tenant_tracker_templates add column if not exists generation jsonb default '{}'::jsonb not null;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'tenant_tracker_templates_kind_check') then
    alter table public.tenant_tracker_templates
      add constraint tenant_tracker_templates_kind_check check (kind = any (array['standard'::text, 'git'::text]));
  end if;
end $$;

create table if not exists public.tenant_git_repository_mappings (
    id uuid default gen_random_uuid() not null primary key,
    tenant_id uuid not null references public.organizations(id) on delete cascade,
    provider text not null check (provider = any (array['github'::text, 'gitlab'::text])),
    instance_url text not null,
    connection_user_id text default ''::text not null,
    repository_id bigint not null check (repository_id > 0),
    repository_path text not null check (length(repository_path) between 1 and 300),
    client_id text not null check (length(client_id) between 1 and 100),
    project_id text not null check (length(project_id) between 1 and 100),
    is_active boolean default true not null,
    created_by text default ''::text not null,
    updated_by text default ''::text not null,
    created_at timestamp with time zone default now() not null,
    updated_at timestamp with time zone default now() not null
);
-- One active mapping per repository; replaced mappings stay, inactive, for history.
create unique index if not exists tenant_git_repository_mappings_active
    on public.tenant_git_repository_mappings (tenant_id, provider, instance_url, repository_id) where is_active;

create table if not exists public.tenant_git_tracker_tickets (
    id uuid not null primary key,
    tenant_id uuid not null references public.organizations(id) on delete cascade,
    tracker_id uuid not null,
    provider text not null check (provider = any (array['github'::text, 'gitlab'::text])),
    instance_url text not null,
    repository_id bigint not null check (repository_id > 0),
    repository_path text not null,
    issue_id bigint not null check (issue_id > 0),
    issue_number integer not null check (issue_number > 0),
    issue_url text not null,
    title_snapshot text default ''::text not null,
    client_id text not null,
    project_id text not null,
    mapping_id uuid,
    template_id uuid,
    template_revision integer,
    generation_status text default 'Pending'::text not null
        check (generation_status = any (array['Pending'::text, 'Processing'::text, 'Completed'::text, 'Failed'::text])),
    generation_error text default ''::text not null,
    attempts integer default 0 not null,
    added_by text not null,
    added_by_name text default ''::text not null,
    created_at timestamp with time zone default now() not null,
    updated_at timestamp with time zone default now() not null,
    foreign key (tenant_id, tracker_id) references public.tenant_trackers(tenant_id, id) on delete cascade
);
-- A ticket is in a GIT Tracker at most once: repeated clicks and concurrent requests meet this constraint.
create unique index if not exists tenant_git_tracker_tickets_once
    on public.tenant_git_tracker_tickets (tenant_id, tracker_id, provider, instance_url, issue_id);
create index if not exists tenant_git_tracker_tickets_issue
    on public.tenant_git_tracker_tickets (tenant_id, provider, instance_url, issue_id);
create index if not exists tenant_git_tracker_tickets_tracker_client
    on public.tenant_git_tracker_tickets (tenant_id, tracker_id, client_id);

create table if not exists public.tenant_git_ticket_tasks (
    id uuid default gen_random_uuid() not null primary key,
    tenant_id uuid not null references public.organizations(id) on delete cascade,
    git_tracker_ticket_id uuid not null references public.tenant_git_tracker_tickets(id) on delete cascade,
    tracker_row_id uuid,
    rule_key text not null check (length(rule_key) between 1 and 120),
    task_id text not null,
    parent_task_id text,
    work_type text not null check (work_type = any (array['Task'::text, 'Subtask'::text])),
    template_id uuid,
    created_at timestamp with time zone default now() not null
);
-- One rule makes a given piece of work once per ticket entry, however often generation is retried.
create unique index if not exists tenant_git_ticket_tasks_once
    on public.tenant_git_ticket_tasks (git_tracker_ticket_id, rule_key);
create index if not exists tenant_git_ticket_tasks_task on public.tenant_git_ticket_tasks (tenant_id, task_id);

alter table public.user_github_issues add column if not exists repository_id bigint;
alter table public.user_gitlab_issues add column if not exists repository_id bigint;

commit;

select 'BA Client Ops Tracker database ready' as result, 42 as schema_version;
