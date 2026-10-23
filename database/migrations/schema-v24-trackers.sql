-- Apply once to existing v0.6.91 databases (Supabase or Northflank PostgreSQL).
-- Trackers: sheets that each account shapes itself. A tracker keeps its columns and saved views;
-- its rows live in their own table so one edit saves one row. Secret cells are stored encrypted
-- (AES-256-GCM, the integration master key) and are only ever read through a logged reveal.
begin;
create table if not exists public.tenant_trackers (
  tenant_id uuid not null references public.organizations(id) on delete cascade,
  id uuid not null,
  name text not null check (length(name) between 1 and 120),
  client_id text not null default '',
  project_id text not null default '',
  private boolean not null default false,
  template text not null default '',
  columns jsonb not null default '[]'::jsonb,
  views jsonb not null default '[]'::jsonb,
  revision integer not null default 1,
  created_by text not null default '',
  created_by_name text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  primary key (tenant_id, id)
);
create index if not exists tenant_trackers_recent on public.tenant_trackers(tenant_id, updated_at desc);

create table if not exists public.tenant_tracker_rows (
  tenant_id uuid not null,
  tracker_id uuid not null,
  id uuid not null,
  position bigint not null,
  data jsonb not null default '{}'::jsonb,
  secrets jsonb not null default '{}'::jsonb,
  task_id text not null default '',
  version integer not null default 1,
  created_by text not null default '',
  updated_by text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, tracker_id, id),
  foreign key (tenant_id, tracker_id) references public.tenant_trackers(tenant_id, id) on delete cascade
);
create index if not exists tenant_tracker_rows_order on public.tenant_tracker_rows(tenant_id, tracker_id, position, created_at);

-- Who changed what, and every Secret reveal. Secret values are never written here.
create table if not exists public.tenant_tracker_changes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.organizations(id) on delete cascade,
  tracker_id uuid not null,
  row_id text not null default '',
  actor_id text not null default '',
  actor_name text not null default '',
  kind text not null,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists tenant_tracker_changes_row on public.tenant_tracker_changes(tenant_id, tracker_id, row_id, created_at desc);

-- Supabase only: lock the tables to the service role, as for the other private tables.
-- Plain PostgreSQL (Northflank) has no anon/service_role, and enabling row level security
-- there would block the app's database user, so it is skipped.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'alter table public.tenant_trackers enable row level security';
    execute 'alter table public.tenant_tracker_rows enable row level security';
    execute 'alter table public.tenant_tracker_changes enable row level security';
    execute 'revoke all on public.tenant_trackers, public.tenant_tracker_rows, public.tenant_tracker_changes from public, anon, authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant all on public.tenant_trackers, public.tenant_tracker_rows, public.tenant_tracker_changes to service_role';
  end if;
end $$;

-- Switch the Trackers module on for existing accounts. Administrators get it with their account's modules;
-- other users are given it from Account Users. Accounts that already list it are left alone.
update public.organizations set enabled_modules = enabled_modules || '["trackers"]'::jsonb
where jsonb_typeof(enabled_modules) = 'array' and not (enabled_modules ? 'trackers');
notify pgrst, 'reload schema';
commit;
