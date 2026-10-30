-- Apply once to databases at schema v32 (Supabase or Northflank PostgreSQL).
-- Reports → Data explorer: people query their account's data with SQL in the browser and save queries to reuse.
-- Saved queries are kept with reports (kind 'query'): private to whoever saved them, or shared by an Administrator
-- as the account's query templates. The Data explorer module is switched on for existing accounts, so
-- Administrators have it; other users are given it from Users & Permissions. Without this upgrade, queries still run
-- but cannot be saved.
begin;
alter table public.tenant_reports drop constraint if exists tenant_reports_kind_check;
alter table public.tenant_reports
  add constraint tenant_reports_kind_check check (kind in ('report', 'folder', 'template', 'query'));
update public.organizations set enabled_modules = enabled_modules || '["explorer"]'::jsonb
where jsonb_typeof(enabled_modules) = 'array' and not (enabled_modules ? 'explorer');
notify pgrst, 'reload schema';
commit;
