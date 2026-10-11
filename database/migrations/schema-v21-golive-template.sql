-- Enables optional custom Go Live templates. Built-in generation needs no new row.
BEGIN;
ALTER TABLE public.tenant_templates DROP CONSTRAINT IF EXISTS tenant_templates_template_type_check;
ALTER TABLE public.tenant_templates ADD CONSTRAINT tenant_templates_template_type_check
  CHECK (template_type IN ('drf', 'brd', 'fsd', 'signoff', 'golive'));
NOTIFY pgrst, 'reload schema';
COMMIT;
