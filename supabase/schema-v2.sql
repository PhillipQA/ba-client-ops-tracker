-- BA Client Ops Tracker - Data Architecture v2
-- Run this AFTER supabase/schema.sql in the Supabase SQL Editor.
-- It keeps tracker_state intact while adding normalized, auditable tables.

create table if not exists public.clients (
  id text primary key,
  name text not null default '',
  contact text not null default '',
  email text not null default '',
  status text not null default '',
  health text not null default '',
  notes text not null default '',
  raw_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists public.projects (
  id text primary key,
  name text not null default '',
  status text not null default '',
  target_date date,
  summary text not null default '',
  raw_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists public.tasks (
  id text primary key,
  client_id text,
  project_id text,
  parent_task_id text,
  subtask_order integer,
  title text not null default '',
  type text not null default 'Task',
  priority text not null default '',
  status text not null default '',
  waiting_on text not null default '',
  owner text not null default '',
  date_raised date,
  due_date date,
  follow_up_date date,
  description text not null default '',
  resolution text not null default '',
  resolved_date date,
  source text not null default '',
  external_source_id text,
  source_sender text,
  raw_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index if not exists tasks_client_id_idx on public.tasks(client_id);
create index if not exists tasks_project_id_idx on public.tasks(project_id);
create index if not exists tasks_parent_task_id_idx on public.tasks(parent_task_id);
create index if not exists tasks_due_date_idx on public.tasks(due_date);
create index if not exists tasks_follow_up_date_idx on public.tasks(follow_up_date);

create table if not exists public.inquiries (
  id text primary key,
  client_id text,
  project_id text,
  title text not null default '',
  priority text not null default '',
  status text not null default '',
  waiting_on text not null default '',
  owner text not null default '',
  date_raised date,
  follow_up_date date,
  description text not null default '',
  resolution text not null default '',
  resolved_date date,
  source text not null default '',
  external_source_id text,
  source_sender text,
  raw_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index if not exists inquiries_client_id_idx on public.inquiries(client_id);
create index if not exists inquiries_project_id_idx on public.inquiries(project_id);
create unique index if not exists inquiries_external_source_id_uidx on public.inquiries(external_source_id) where external_source_id is not null;

create table if not exists public.activity_logs (
  id text primary key,
  client_id text,
  project_id text,
  activity_date date,
  text text not null default '',
  raw_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index if not exists activity_logs_client_id_idx on public.activity_logs(client_id);
create index if not exists activity_logs_project_id_idx on public.activity_logs(project_id);

create table if not exists public.planner_activities (
  id text primary key,
  client_id text,
  project_id text,
  title text not null default '',
  activity_date date,
  start_time text,
  end_time text,
  end_date date,
  all_day boolean not null default false,
  source text not null default '',
  status text not null default '',
  notes text not null default '',
  calendar_event_id text,
  calendar_link text,
  raw_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists public.app_users (
  id text primary key,
  username text not null,
  password_hash text not null default '',
  name text not null default '',
  email text not null default '',
  phone text not null default '',
  role text not null default 'Contributor',
  modules jsonb not null default '[]'::jsonb,
  status text not null default 'Active',
  created_on date,
  raw_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create unique index if not exists app_users_username_lower_uidx on public.app_users(lower(username)) where deleted_at is null;

create table if not exists public.task_statuses (
  id text primary key,
  label text not null,
  is_completed boolean not null default false,
  sort_order integer not null default 0,
  raw_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);


create table if not exists public.app_settings (
  id text primary key,
  setting_key text not null unique,
  value jsonb not null default '{}'::jsonb,
  raw_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists public.audit_logs (
  id uuid primary key,
  entity_type text not null,
  entity_id text not null,
  action text not null,
  changed_fields jsonb not null default '[]'::jsonb,
  before_data jsonb,
  after_data jsonb,
  changed_by text,
  changed_by_name text,
  source text not null default 'tracker',
  changed_at timestamptz not null default now()
);
create index if not exists audit_logs_entity_idx on public.audit_logs(entity_type, entity_id, changed_at desc);
create index if not exists audit_logs_changed_at_idx on public.audit_logs(changed_at desc);

create table if not exists public.data_migration_runs (
  id uuid primary key,
  status text not null,
  reason text not null default 'manual-migration',
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  started_by text,
  counts jsonb,
  error text
);

-- Documents are prepared now so Document Creation can use structured metadata later.
create table if not exists public.documents (
  id uuid primary key default gen_random_uuid(),
  document_type text not null,
  client_id text,
  project_id text,
  status text not null default 'Draft',
  extracted_data jsonb not null default '{}'::jsonb,
  generated_storage_path text,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);


create table if not exists public.document_versions (
  id uuid primary key default gen_random_uuid(),
  document_id uuid references public.documents(id) on delete cascade,
  version_number integer not null,
  storage_path text,
  snapshot jsonb not null default '{}'::jsonb,
  created_by text,
  created_at timestamptz not null default now(),
  unique(document_id, version_number)
);

create table if not exists public.document_attachments (
  id uuid primary key default gen_random_uuid(),
  document_id uuid references public.documents(id) on delete cascade,
  storage_path text not null,
  file_name text not null,
  mime_type text,
  file_size bigint,
  attachment_role text,
  uploaded_by text,
  uploaded_at timestamptz not null default now(),
  deleted_at timestamptz
);

-- The browser must never talk to these tables directly. The Node server uses the service role.
do $$
declare t text;
begin
  foreach t in array array['clients','projects','tasks','inquiries','activity_logs','planner_activities','app_users','task_statuses','app_settings','audit_logs','data_migration_runs','documents','document_versions','document_attachments']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from anon, authenticated', t);
  end loop;
end $$;
