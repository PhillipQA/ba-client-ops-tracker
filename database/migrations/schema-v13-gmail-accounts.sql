-- v0.6.45: account-owned Gmail OAuth app configuration. Apply after v12.
begin;
create table if not exists public.gmail_accounts (
  tenant_id uuid primary key references public.organizations(id) on delete cascade,
  platform_enabled boolean not null default false,
  account_enabled boolean not null default false,
  encrypted_config text,
  revision uuid not null default gen_random_uuid(),
  updated_at timestamptz not null default now()
);
alter table public.user_communication_settings add column if not exists gmail_config_revision uuid;
alter table public.gmail_accounts enable row level security;
revoke all on public.gmail_accounts from public, anon, authenticated;
grant all on public.gmail_accounts to service_role;
commit;
