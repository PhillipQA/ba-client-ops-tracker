# BA Client Ops Tracker v0.6.7

Adds Sign Off creation using the supplied iRipple Production Deployment Approval Form. This patch requires **v0.6.6**.

## What changes

- The original iRipple logo, document title, header structure, and page numbering are retained. A single editable client name updates the PAF reference, client heading, approval column, and Client Name row. Choose an existing account client or type a custom name.
- Three iRipple and three client approval slots have name and position fields. Unused slots can stay blank. Signature and signing-date lines stay blank for approval.
- The generated Target Deployment Date uses **MM/DD/YYYY**, without a time. The browser date picker may follow your device's locale; the displayed document date shows the export format.
- Deployment choices: **Production - New Site**, **Production - Head Office**, **Production - Branch**.
- Product choices: **Barter RPOS 5.1**, **Barter FPOS 5.1**, **Barter CX v1.1**, **Barter CX v1.0**.
- Site Code / Name is editable. Purpose, Scope, and Deployment Authorization retain the sample wording, including its new-site language for all deployment types.
- Add, caption, reorder, or remove attachments. JPEG, PNG, and WEBP images are prepared in the browser and embedded in Word on individual attachment pages. PDF, Word, Excel, PowerPoint, CSV, text, and ZIP files are supplied alongside the form in a downloadable ZIP; their contents are not converted into Word pages. Limits: 20 files, 5 MB each, 12 MB total after image preparation. Images are resized to a maximum 1,800-pixel long edge.
- Download is an editable `.docx`, or a ZIP when supporting non-image files are included. No AI, Ollama, or local runner is needed.
- Administrators and Contributors with Document Creation access can generate. Viewers have a read-only form. Authentication and module/role restrictions are also enforced by the server.

The reference follows the sample's two-digit sequence style, e.g. `PAF-SAMPLECLIENTINC-2026-01`. The year defaults to the current year; year and number are editable. Numbers are manually assigned, not reserved or automatically incremented. Client punctuation and spaces are removed only in the reference.

Draft fields survive switching document tabs but are not saved across refreshes or leaving Document Creation. Download before leaving. Attachments are processed for the download and are not stored as account records.

## Apply the patch

1. Stop the app. From your project folder, run `npm run patch:status` and confirm **0.6.6**. Complete earlier upgrades first; do not force this patch onto another version.
2. Save `ba-client-ops-patch-v0.6.7-from-v0.6.6.zip` in `E:\Playwright`.
3. From `E:\Playwright\ba-client-ops-tracker`, run:

```bat
npm run patch -- "E:\Playwright\ba-client-ops-patch-v0.6.7-from-v0.6.6.zip"
npm run test:signoff
npm run typecheck:server
npm run build
npm run patch:status
```

No npm installation, SQL migration, or environment change is required for a working v0.6.6 installation. Keep existing database migrations and credentials. The bundled `templates/signoff-template.docx` must be deployed with the source.

Restart locally with `npm run dev`. To update Render, commit the patched source to your existing connected repository and deploy with the existing build/start commands. A local patch does not update the hosted app. Refresh and sign in after restarting.

The full-build ZIP contains source for a separate installation or replacement checkout. Follow README.md for fresh setup. It excludes credentials, tenant data, dependencies, and compiled output.

## Use and verify

1. Open **Document Creation → Sign Off** as an Administrator or Contributor with access.
2. Set the client, deployment date/type, product, site, document year/number, and signatories.
3. Add three or four images, optionally caption and reorder them, then generate.
4. Open the downloaded Word document and confirm the client references, six approval slots, date, retained sections, and attachment order.
5. Add a PDF or another supported file and generate again. Confirm the ZIP contains the Word form plus the supporting files.
6. Verify a Viewer cannot generate, and existing DRF/FSD creation, users, themes, and integration settings remain available.

## Validation

Production build and server TypeScript checks passed. All 20 automated tests passed: six Sign Off, nine account/profile/theme, and five existing integration tests. Sign Off coverage includes actual HTTP authorization, client substitution, all dropdown choices, date validation, retained text and logo, image order/relationships, ZIP file integrity, and upload limits. Existing API tests use in-memory stores and mock external providers.

Generated Word pages were rendered and visually reviewed, including six signatories, long client/name/title values, and four portrait/landscape images. The real updater was checked for apply, exact payload contents, environment preservation, version guard, and rollback.

Browser interaction and live Render/Supabase deployment were not tested in this environment. Browser-side image preparation needs the deployment check above. Very long fields can expand pagination; Word remains editable for final approval formatting.

## Roll back

Stop the app, run `npm run patch:rollback`, rebuild, and redeploy the restored source. No database changes require reversal. Downloaded documents remain on your computer.
