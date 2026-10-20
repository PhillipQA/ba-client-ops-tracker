-- Enables optional custom templates for the UAT Sign Off, UAT Deployment Approval and
-- Training Sign Off forms. Built-in generation needs no new row.
BEGIN;
ALTER TABLE public.tenant_templates DROP CONSTRAINT IF EXISTS tenant_templates_template_type_check;
ALTER TABLE public.tenant_templates ADD CONSTRAINT tenant_templates_template_type_check
  CHECK (template_type IN ('drf', 'brd', 'fsd', 'signoff', 'golive', 'uat', 'uatdeploy', 'training'));
NOTIFY pgrst, 'reload schema';
COMMIT;
