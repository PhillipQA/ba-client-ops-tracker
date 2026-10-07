-- BA Client Ops Tracker v0.6.76: Work Hub Git providers upgrade.
-- For existing v0.6.74 or v0.6.75 databases. Retains existing GitHub data.
begin;

-- Apply once to existing v0.6.74 databases. Private GitHub data stays outside tenant_state.
create table if not exists public.user_github_connections (
  tenant_id uuid not null references public.organizations(id) on delete cascade,
  user_id text not null references public.app_users(id) on delete cascade,
  github_user_id bigint not null,
  github_login text not null,
  encrypted_token text,
  repositories jsonb not null default '[]'::jsonb,
  sync_cursor jsonb,
  last_synced_at timestamptz,
  retry_after timestamptz,
  revision uuid not null default gen_random_uuid(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, user_id)
);
create table if not exists public.user_github_issues (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.organizations(id) on delete cascade,
  owner_user_id text not null references public.app_users(id) on delete cascade,
  github_user_id bigint not null,
  github_id bigint not null,
  number integer not null,
  repository text not null,
  title text not null default '',
  body text not null default '',
  html_url text not null,
  state text not null check (state in ('open','closed')),
  state_reason text,
  creator text not null,
  assignees jsonb not null default '[]'::jsonb,
  labels jsonb not null default '[]'::jsonb,
  milestone text not null default '',
  comments_count integer not null default 0,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  imported_at timestamptz not null default now(),
  created_by_me boolean not null default false,
  assigned_to_me boolean not null default false,
  available boolean not null default true,
  qa_status text not null default 'Not started' check (qa_status in ('Not started','In progress','Needs retest','Passed','Failed','Blocked')),
  linked_task_id text,
  unique (tenant_id, owner_user_id, github_user_id, github_id)
);
create index if not exists user_github_issues_owner_recent on public.user_github_issues(tenant_id,owner_user_id,github_user_id,updated_at desc);
alter table public.user_github_connections enable row level security;
alter table public.user_github_issues enable row level security;
revoke all on public.user_github_connections, public.user_github_issues from public, anon, authenticated;
grant all on public.user_github_connections, public.user_github_issues to service_role;

-- Apply once to existing v0.6.75 databases. Private GitLab data stays outside tenant_state.
create table if not exists public.user_gitlab_connections (
  tenant_id uuid not null references public.organizations(id) on delete cascade,
  user_id text not null references public.app_users(id) on delete cascade,
  instance_url text not null,
  gitlab_user_id bigint not null,
  gitlab_login text not null,
  encrypted_token text,
  repositories jsonb not null default '[]'::jsonb,
  sync_cursor jsonb,
  last_synced_at timestamptz,
  retry_after timestamptz,
  revision uuid not null default gen_random_uuid(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, user_id)
);
create table if not exists public.user_gitlab_issues (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.organizations(id) on delete cascade,
  owner_user_id text not null references public.app_users(id) on delete cascade,
  instance_url text not null,
  gitlab_user_id bigint not null,
  gitlab_id bigint not null,
  number integer not null,
  repository text not null,
  title text not null default '',
  body text not null default '',
  html_url text not null,
  state text not null check (state in ('open','closed')),
  state_reason text,
  creator text not null,
  assignees jsonb not null default '[]'::jsonb,
  labels jsonb not null default '[]'::jsonb,
  milestone text not null default '',
  comments_count integer not null default 0,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  imported_at timestamptz not null default now(),
  created_by_me boolean not null default false,
  assigned_to_me boolean not null default false,
  available boolean not null default true,
  qa_status text not null default 'Not started' check (qa_status in ('Not started','In progress','Needs retest','Passed','Failed','Blocked')),
  linked_task_id text,
  unique (tenant_id, owner_user_id, instance_url, gitlab_user_id, gitlab_id)
);
create index if not exists user_gitlab_issues_owner_recent on public.user_gitlab_issues(tenant_id,owner_user_id,instance_url,gitlab_user_id,updated_at desc);
alter table public.user_gitlab_connections enable row level security;
alter table public.user_gitlab_issues enable row level security;
revoke all on public.user_gitlab_connections, public.user_gitlab_issues from public, anon, authenticated;
grant all on public.user_gitlab_connections, public.user_gitlab_issues to service_role;

notify pgrst, 'reload schema';
commit;
