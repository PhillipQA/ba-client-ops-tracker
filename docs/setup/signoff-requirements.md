# BA Client Ops Tracker Sign Off Document

## v0.6.83 update — UAT, UAT Deployment and Training forms

Confirmed October 20, 2026. **Sign Off Document** now offers five forms: Production Deployment Form, Go Live Sign Off, **UAT Sign Off**, **UAT Deployment Approval** and **Training Sign Off**. The three new forms were supplied as separate Word templates; they were restyled to match the existing Production and Go Live templates, which are unchanged.

Confirmed decisions:

- **Layout.** UAT Sign Off and Training Sign Off follow the Go Live layout (logo, title, Prepared By and Date header; Name / (Date) signature lines). UAT Deployment Approval follows the Production layout (logo, title, page-number header; stacked signature blocks with a Date line).
- **Signers.** Two iRipple and two client signatories to start on every form; names and positions are editable and up to 20 per side can be added. No signer positions are fixed.
- **Editable parts.** Detail values, the wording of every section and the table rows. Standard wording from the supplied forms is pre-filled and can be restored for the current form.
- **Product.** Product Deployed uses the shared product list; version is free text.
- **Tables.** Rows are typed in manually (no import). Up to 40 rows per table; blank rows are dropped and one blank row is kept so a table is never headings only.
- **Templates.** Each form has its own built-in template and its own upload/remove/restore card in Settings → Templates.

| Form | Template key | Header | References | Fields | Sections | Tables |
| --- | --- | --- | --- | --- | --- | --- |
| UAT Sign Off | `uat` | Prepared By / Date | `SOF-` | UAT date (start, optional end), version, testing environment, overall result | introduction, scope_of_uat, defects_classification, acceptance_criteria | tested_modules, high_priority_issues, remaining_issues |
| UAT Deployment Approval | `uatdeploy` | Page | `PAF-` | target deployment date, enhancement name, deployment type, version, client name | purpose, scope, deployment_authorization | none |
| Training Sign Off | `training` | Prepared By / Date | `SOF-` | training date (start, optional end), version, training mode, training facilitator | training_participants, training_scope, training_objectives, training_materials, training_modules | training_activities |

Template notes for custom uploads:

- Keep the mapping tags that appear in the built-in template for the form (`{client_name}`, `{document_reference}`, `{product}`, signer tags, `{@attachments}` and the form's own fields and sections). Upload is rejected if one is missing.
- Each table is one repeating Word row. Put `{#table_name}` at the start of the first cell and `{/table_name}` at the end of the last cell of that row. Column tags are `{module_name}`, `{pct_passed}`, `{pct_failed}`, `{uat_cycles}`, `{status}` for tested modules; `{issue_name}`, `{description}`, `{environment}`, `{status}`, `{classification}` for the issue tables; `{module_name}`, `{attendees}`, `{venue}`, `{start_date}`, `{end_date}`, `{instructor}` for training activities.
- UAT and Training dates print as `MM/DD/YYYY`, or `MM/DD/YYYY to MM/DD/YYYY` for a range, through `{uat_date}` and `{training_date}`.
- Section wording is plain text. Bold, underline and superscript emphasis from the supplied forms is not carried.

Built-in generation needs no new template row. Apply `database/migrations/schema-v22-signoff-form-templates.sql` to manage optional custom templates for the new forms in Settings.

## v0.6.80 update

Confirmed October 11, 2026. The module is **Sign Off Document**, with a toggle for **Production Deployment Form** and **Sign Off Form**. The Sign Off Form uses the supplied Go Live Sign Off template. The October instructions supersede the older fixed signer counts and fixed retained wording below.

- Each form starts with two iRipple and two client signatories. Add or remove approvers manually, up to 20 per side. Signature and signing-date lines remain available for approval. DocHub preparation retains its existing maximum of 12 active signers across both sides.
- Narrative sections use editable multiline text boxes. Blank sections remain blank; generation does not invent activities, branches, or known-issue results. Restore defaults resets section wording for the current form only.
- Both forms retain separate in-memory details, filenames, signatories, email addresses, attachments and DocHub choices while switching. Refreshing or leaving the mounted workspace does not save these drafts. Reset applies only to the current form.
- The Production layout, PAF reference, deployment fields and attachments remain supported. The Go Live layout retains its original logo/header, uses an SOF reference, and maps author/date rather than retaining sample identity or dates.
- Go Live required fields: client, client/project name, go-live date, go-live type, product, prepared by, document date, year and document number. Existing product choices are shared with Production.

| Uploaded template section | Editable form field / mapping |
| --- | --- |
| Client/Project heading | Client / Project Name (`project_name`) |
| Approval heading; Client Name row | Client name (`client_name`) |
| Go Live Date | Go Live Date (`go_live_date`) |
| Go Live Type | Pilot Branch / Store Roll Out (`go_live_type`) |
| Product Deployed | Product deployed (`product`) |
| Header version; Prepared By; Date | `document_reference`, `prepared_by`, `document_date` |
| Introduction | `introduction` |
| Activities Completed | `activities_completed` |
| Receipt Printout Validation | `receipt_validation` |
| Mall Integration Requirements | `mall_integration` |
| Branch/es that Went Live | `branches_live` |
| Known Issues | `known_issues` |
| Acknowledgement | `acknowledgement` |
| Approval rows | Indexed iRipple/client name and title fields, expanded from the first approval row |

Built-in generation requires no new template row. Apply `database/migrations/schema-v21-golive-template.sql` to manage optional custom Go Live templates in Settings. The uploaded source document remains unchanged.

## Original production requirements

Confirmed September 20, 2026 for the iRipple BA Project. Implemented in the v0.6.7 release package; hosted deployment remains a separate step. Ollama integration remains paused.

Reference: the user's SO GO-Live - Roving-POS.docx, identity libfile_1f39e52463cc8191a078ad466e4a849e. Preserve the original sample.

## Confirmed instructions

1. Retain the iRipple logo, document title, and header layout; customize the client in the PAF reference.
2. The client heading follows the client for this document.
3. Agreed and Approved has three iRipple and three client signatories, with editable text fields.
4. Target Deployment Date exports as MM/DD/YYYY.
5. Deployment Type dropdown: Production - New Site; Production - Head Office; Production - Branch.
6. Product Deployed dropdown: Barter RPOS 5.1; Barter FPOS 5.1; Barter CX v1.1; Barter CX v1.0.
7. Site Code / Name is customizable.
8. Client Name in the details follows the document client.
9. Retain Purpose from the sample.
10. Retain Scope from the sample.
11. Retain Deployment Authorization from the sample. This latest instruction supersedes the earlier Deployment History label.
12. Allow attachments, usually three or four images.

## Implementation choices

- Output is editable Word. Uploaded JPEG/PNG/WEBP images appear on attachment pages; other supported files accompany it in a ZIP.
- One editable client field populates all client references. Existing account clients are offered as suggestions.
- Six name/position pairs; unused pairs may stay blank. Signature/date lines are left for approval.
- Date-only output, since the requested format contains no time.
- Reference follows sample PAF-CLIENT-YYYY-01 style; spaces/punctuation removed in the client reference only. Year and sequence are editable; no automatic number reservation/increment.
- Fixed Purpose/Scope/Authorization text remains unchanged for every dropdown selection.
- Optional image captions and ordering. Limits: 20 files, 5 MB per file, 12 MB total after preparation; images resized to 1,800-pixel long edge.
- Administrators/Contributors with Document Creation access can generate; Viewers cannot.
- Session-only draft fields/attachments; generated files are downloaded, not stored as account records.
- No AI service, local runner, new dependency, or database migration is needed.

See UPGRADE-v0.6.7.md in the release package for installation, validation, and deployment checks.
