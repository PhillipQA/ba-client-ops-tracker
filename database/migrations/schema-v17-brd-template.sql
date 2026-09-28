-- Schema v17: allow tenant-specific BRD document templates.
BEGIN;

ALTER TABLE public.tenant_templates
  DROP CONSTRAINT IF EXISTS tenant_templates_template_type_check;

ALTER TABLE public.tenant_templates
  ADD CONSTRAINT tenant_templates_template_type_check
  CHECK (template_type IN ('drf', 'brd', 'fsd', 'signoff'));

COMMIT;
