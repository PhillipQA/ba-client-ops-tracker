# BA Client Ops Tracker v0.6.60 — BRD Creator

This release upgrades **v0.6.59** and adds a separate **Document Creation → BRD Creation** workflow based on the supplied iRipple BRD Word layout.

## Upgrade from v0.6.59

1. Back up the source and tenant database, then stop the running app.
2. Confirm `npm run patch:status` reports **0.6.59**.
3. Apply `ba-client-ops-patch-v0.6.60-brd-creator.zip` from the project folder.
4. In Supabase SQL Editor, run `database/migrations/schema-v17-brd-template.sql` once. It only expands the existing document-template constraint to include BRD templates.
5. Run `npm run build`, restart the app, and refresh open browser tabs.

No new npm package, environment variable, or API key is introduced. BRD Creation reuses the account's existing **Document Agent** configuration. Existing tenant data, DRF/FSD/Sign-Off templates, communication integrations, and document drafts are preserved.

## What changed

- **Separate BRD Creation module inside Document Creation.** It is not merged into FSD Creation.
- Accepts PDF, DOCX, text/Markdown, CSV/JSON, images/screenshots, pasted requirements, meeting notes and chat content using the existing document reader/OCR pipeline.
- Incomplete material is accepted. The Document Agent produces a useful business-level draft from the information available, while material uncertainty is listed for review instead of blocking creation.
- Editable preview maps the supplied BRD structure: Project Name, Module, Date, Prepared By, Version, Introduction/Summary, Business Objectives, Business Problem, In-Scope, Stakeholders, Functional Requirements, Acceptance Criteria and Customer Mapping.
- Functional requirements receive stable `BR-001`, `BR-002`, ... IDs and source references where the AI can support them.
- The built-in BRD template preserves the supplied visual layout and is available through **Settings → Templates**. Accounts can upload a replacement BRD DOCX as long as its mapping tags are retained.
- **Use in FSD Creator** sends the reviewed structured BRD data directly into FSD Creation as a BRD source. It does not re-OCR the generated Word document.
- BRD drafts remain browser-session scoped, matching the current FSD document-creation workflow. Reset removes sources, preview and draft fields for the current BRD.

## Database migration

`schema-v17-brd-template.sql` changes only the allowed values for `tenant_templates.template_type` from `drf/fsd/signoff` to `drf/brd/fsd/signoff`. Fresh installs use the regenerated `database/setup.sql`, which now bundles migrations 1–17.

## Deployment verification

Open Document Creation → BRD Creation, add a short/incomplete requirement source, generate a preview, edit a requirement, mark the preview reviewed, and download the BRD. Then choose **Use in FSD Creator** and confirm the BRD appears automatically under FSD Requirements & supporting sources as a BRD source.
