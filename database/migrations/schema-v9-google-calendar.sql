-- v0.6.27: additive, rerunnable. Run after v8. No existing workspace data is changed.
begin;
create table if not exists public.google_calendar_accounts (
  tenant_id uuid primary key references public.organizations(id) on delete cascade,
  platform_enabled boolean not null default false,
  account_enabled boolean not null default false,
  encrypted_config text,
  revision uuid not null default gen_random_uuid(),
  updated_at timestamptz not null default now()
);
create unique index if not exists app_users_id_organization_unique on public.app_users(id, organization_id);
create table if not exists public.google_calendar_connections (
  tenant_id uuid not null references public.google_calendar_accounts(tenant_id) on delete cascade,
  user_id text not null,
  config_revision uuid not null,
  encrypted_tokens text not null,
  selected_calendars jsonb not null default '["primary"]'::jsonb check (jsonb_typeof(selected_calendars) = 'array' and jsonb_array_length(selected_calendars) <= 10),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, user_id),
  foreign key (user_id, tenant_id) references public.app_users(id, organization_id) on delete cascade
);
alter table public.google_calendar_accounts enable row level security;
alter table public.google_calendar_connections enable row level security;
revoke all on public.google_calendar_accounts, public.google_calendar_connections from public, anon, authenticated;
grant all on public.google_calendar_accounts, public.google_calendar_connections to service_role;
commit;
