-- Apply once to existing v0.8.x or older databases (Supabase or Northflank PostgreSQL). Needs schema v24 (Trackers).
-- Connected Google Sheets: a tracker can follow one tab of a Sheet. Rows remember their key in the Sheet and the values
-- at the last sync (what a later two-way sync needs), whether they are still in the Sheet, and whether they wait for review.
-- Until it is applied, Trackers work as before and connecting a Sheet says the migration is missing.
begin;
alter table public.tenant_tracker_rows add column if not exists source_key text not null default '';
alter table public.tenant_tracker_rows add column if not exists source_values jsonb not null default '{}'::jsonb;
alter table public.tenant_tracker_rows add column if not exists source_missing boolean not null default false;
alter table public.tenant_tracker_rows add column if not exists review boolean not null default false;
create index if not exists tenant_tracker_rows_source on public.tenant_tracker_rows(tenant_id, tracker_id, source_key) where source_key <> '';
create index if not exists tenant_tracker_rows_review on public.tenant_tracker_rows(tenant_id, tracker_id) where review;

create table if not exists public.tenant_tracker_sources (
  tenant_id uuid not null,
  tracker_id uuid not null,
  spreadsheet_id text not null,
  spreadsheet_name text not null default '',
  tab text not null,
  key_header text not null,
  header_map jsonb not null default '{}'::jsonb,
  mode text not null default 'one_way' check (mode in ('one_way', 'two_way')),
  connected_by text not null default '',
  connected_by_name text not null default '',
  connected_email text not null default '',
  last_synced_at timestamptz,
  last_status text not null default 'never',
  last_error text not null default '',
  last_report jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, tracker_id),
  foreign key (tenant_id, tracker_id) references public.tenant_trackers(tenant_id, id) on delete cascade
);

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'alter table public.tenant_tracker_sources enable row level security';
    execute 'revoke all on public.tenant_tracker_sources from public, anon, authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant all on public.tenant_tracker_sources to service_role';
  end if;
end $$;
notify pgrst, 'reload schema';
commit;
