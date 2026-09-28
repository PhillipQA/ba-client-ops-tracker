-- v0.6.63: private diagnostic records for DRF failures.
begin;
create table if not exists public.drf_error_logs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.organizations(id) on delete cascade,
  user_id text not null references public.app_users(id) on delete cascade,
  stage text not null check (stage in ('cor_upload','cor_local','cor_ai','template_render','download','dochub')),
  source text not null check (source in ('browser','server')),
  message text not null,
  error_code text,
  context jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists drf_error_logs_user_recent on public.drf_error_logs (tenant_id, user_id, created_at desc);
alter table public.drf_error_logs enable row level security;
revoke all on public.drf_error_logs from public, anon, authenticated;
grant all on public.drf_error_logs to service_role;
notify pgrst, 'reload schema';
commit;
