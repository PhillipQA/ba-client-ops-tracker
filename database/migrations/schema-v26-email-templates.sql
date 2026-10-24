-- Apply once to existing v0.7.x or older databases (Supabase or Northflank PostgreSQL).
-- Email signatures (one per person) and email templates (shared with the account, or kept to oneself).
-- Until it is applied, email works as before: the signature box keeps the copy in this browser and templates are unavailable.
begin;
create table if not exists public.user_email_signatures (
  tenant_id uuid not null references public.organizations(id) on delete cascade,
  user_id text not null,
  signature text not null default '' check (length(signature) <= 2000),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, user_id)
);

create table if not exists public.tenant_email_templates (
  tenant_id uuid not null references public.organizations(id) on delete cascade,
  id uuid not null,
  name text not null check (length(name) between 1 and 120),
  subject text not null default '' check (length(subject) <= 200),
  body text not null default '' check (length(body) <= 30000),
  shared boolean not null default true,
  created_by text not null default '',
  created_by_name text not null default '',
  updated_by_name text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, id)
);
create index if not exists tenant_email_templates_name on public.tenant_email_templates(tenant_id, name);

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'alter table public.user_email_signatures enable row level security';
    execute 'alter table public.tenant_email_templates enable row level security';
    execute 'revoke all on public.user_email_signatures, public.tenant_email_templates from public, anon, authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant all on public.user_email_signatures, public.tenant_email_templates to service_role';
  end if;
end $$;
notify pgrst, 'reload schema';
commit;
