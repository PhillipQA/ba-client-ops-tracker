-- v0.6.51: consolidate DRF, FSD, and Sign Off templates under account Settings.
-- Existing tenant_templates rows are retained as DRF templates.

begin;

alter table public.tenant_templates
  add column if not exists template_type text not null default 'drf';

alter table public.tenant_templates
  add column if not exists is_enabled boolean not null default true;

alter table public.tenant_templates
  drop constraint if exists tenant_templates_template_type_check;

alter table public.tenant_templates
  add constraint tenant_templates_template_type_check
  check (template_type in ('drf','fsd','signoff'));

alter table public.tenant_templates
  drop constraint if exists tenant_templates_pkey;

alter table public.tenant_templates
  add constraint tenant_templates_pkey primary key (tenant_id, template_type);

alter table public.tenant_templates enable row level security;
revoke all on public.tenant_templates from public, anon, authenticated;
grant all on public.tenant_templates to service_role;

notify pgrst, 'reload schema';
commit;
