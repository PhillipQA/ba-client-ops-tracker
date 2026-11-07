-- Schema v36: Seeds can be saved as an account integration (Settings › Integrations › Seeds).
-- Run once on an existing database before connecting Seeds. Safe to run again.
begin;

alter table public.tenant_integrations drop constraint if exists tenant_integrations_integration_type_check;
alter table public.tenant_integrations
  add constraint tenant_integrations_integration_type_check
  check (integration_type = any (array['discord'::text, 'openai'::text, 'seeds'::text]));

commit;

select 'Seeds integration ready' as result, 36 as schema_version;
