-- Apply after schema-v11. Private content never enters tenant_state.
begin;
create table if not exists public.user_communication_settings (
  tenant_id uuid not null references public.organizations(id) on delete cascade,
  user_id text not null references public.app_users(id) on delete cascade,
  discord_user_id text,
  discord_capture_mentions boolean not null default true,
  gmail_email text,
  gmail_refresh_token text,
  gmail_labels jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, user_id),
  unique (tenant_id, discord_user_id),
  check (discord_user_id is null or discord_user_id ~ '^[0-9]{15,22}$')
);
create table if not exists public.user_communications (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.organizations(id) on delete cascade,
  owner_user_id text not null references public.app_users(id) on delete cascade,
  source text not null check (source in ('Gmail','Discord','Manual')),
  external_id text,
  thread_id text,
  subject text not null default '',
  body text not null default '',
  sender text not null default '',
  source_label text,
  attachments jsonb not null default '[]'::jsonb,
  client_id text,
  project_id text,
  status text not null default 'New' check (status in ('New','Open','Resolved','Archived')),
  linked_task_id text,
  received_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (tenant_id, owner_user_id, source, external_id)
);
create index if not exists user_communications_owner_recent on public.user_communications(tenant_id,owner_user_id,received_at desc);
alter table public.user_communication_settings enable row level security;
alter table public.user_communications enable row level security;
revoke all on public.user_communication_settings, public.user_communications from public, anon, authenticated;
grant all on public.user_communication_settings, public.user_communications to service_role;
commit;
