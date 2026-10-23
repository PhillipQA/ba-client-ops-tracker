-- Apply once to existing v0.6.95 or older databases (Supabase or Northflank PostgreSQL).
-- Tracker task links: a tracker row, or one cell of it, can be linked to any number of tasks and subtasks.
-- The Action Center reads these links to show where a task came from. Nothing else changes.
begin;
create table if not exists public.tenant_tracker_task_links (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  tracker_id uuid not null,
  row_id uuid not null,
  column_id text not null default '',
  task_id text not null,
  created_by text not null default '',
  created_by_name text not null default '',
  created_at timestamptz not null default now(),
  foreign key (tenant_id, tracker_id) references public.tenant_trackers(tenant_id, id) on delete cascade
);
create unique index if not exists tenant_tracker_task_links_unique on public.tenant_tracker_task_links(tenant_id, tracker_id, row_id, column_id, task_id);
create index if not exists tenant_tracker_task_links_task on public.tenant_tracker_task_links(tenant_id, task_id);

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'alter table public.tenant_tracker_task_links enable row level security';
    execute 'revoke all on public.tenant_tracker_task_links from public, anon, authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant all on public.tenant_tracker_task_links to service_role';
  end if;
end $$;
notify pgrst, 'reload schema';
commit;
