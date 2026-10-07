# BA Client Ops Tracker v0.6.74 — Custom FSD features

Upgrade from v0.6.73 with the matching patch. Use the full build for a fresh installation or deployment.

## What changed

- The heading remains **Scope & section mapping**.
- Removed the MMS Feature, MMS Report, Lynexus Feature and POS Feature selection checkboxes from FSD Creation.
- Added multiple **Feature Name** fields with **Add feature** and **Remove** controls. Enter 1–20 unique feature names. Every listed feature is included in the FSD.
- Each name becomes a section under **5. Software Features**, for example **5.1 Metabase Report** and **5.2 Sales Transfer**. Source mapping, section guidance and interpreted requirement reviews use these custom features.
- The report retains the process table rows: **PROCESS NAME, SCENARIO, SUB SCENARIO, PROCESS SCOPE, PROCESS DESCRIPTION, PROCESS INPUT, PROCESS FLOW and PROCESS OUTPUT**. Technical specification/data dictionary tables also remain available; missing values are marked TBD.
- Process codes use the client and feature order: `ACME-FEATURE-01`, scenario `ACME-FEATURE-01-01`, sub scenario `ACME-FEATURE-01-01-01`. The second feature uses `ACME-FEATURE-02`. Codes do not depend on a fixed product module.
- The overall basic-details field is labeled **Document title**. It supplies the cover/title and default filename; individual Feature Names supply the feature section headings.
- Existing saved drafts retain their uploaded text and notes. Active old module mappings move to one custom feature initially named from the existing document title. Review that feature name and add or separate features as needed. Old excluded mappings remain excluded until reassigned. Old previews and source reviews are refreshed to match the new scope.
- Renaming, adding, removing or reordering features invalidates source reviews and the previous preview. A source mapped to a removed feature is flagged for reassignment, and cannot silently move to a newly added feature.
- The v0.6.73 missing-information checklist and **Generate anyway — use available information** remain. Short notes and readable portions can generate a partial FSD; missing behavior remains TBD with concrete questions describing what to add. Unreadable/failed source reviews are skipped in this mode.

## Apply the patch on Windows

Run from the tracker project folder:

```powershell
npm run patch -- "C:\Downloads\ba-client-ops-patch-v0.6.74-fsd-custom-features.zip"
npm run build
npm run typecheck:server
```

Restart or redeploy the app and refresh the browser. The version label should show **0.6.74**. No new dependencies or database migrations are required.

The patch includes `patch-manifest.json` and upgrades exactly v0.6.73. Use the matching base version without `--force`. Existing environment variables and database settings stay in place.

For a fresh installation, extract the full build into a new project folder, follow `.env.example` and the README, run `npm ci`, then `npm run build`. Use `database/setup.sql` only for a fresh database.

## Check the enhancement

1. Open FSD Creation. Confirm **Scope & section mapping** remains and the four fixed module checkboxes are gone.
2. Complete Client, Document title, Product, Prepared by, Document date and Revision.
3. Enter **Metabase Report**, click **Add feature**, then enter **Sales Transfer**.
4. Add short notes as sources. Map report notes to **5.1 Metabase Report**; use a shared source for facts applying to multiple sections. Source review may run again after feature changes.
5. Inspect **Information needed for a fuller FSD**. Missing information should name the affected custom feature and suggest notes, workflow steps, sample reports or technical definitions to add.
6. Select **Generate anyway — use available information** when evidence is incomplete. Check both named feature sections and all eight process rows; unsupported content must remain TBD.
7. Review the preview, select the review checkbox and download Word. Confirm custom headings, generic feature codes, process tables, pending questions and source references appear in the document.
8. Remove a feature with a mapped source. Confirm the source is flagged for reassignment. Rename a feature and regenerate before downloading an updated document.

At least one readable reviewed source, named features, the basic document details and preset instructions are required. A short pasted note can provide the source. The normal preview requires successful, complete source reviews; Generate anyway permits partial reviews and skips failed/unreadable sources.

## Validation

- Production build and server TypeScript check passed.
- Functional regressions: **64 tests passed**, including 8 custom-feature tests and the available-information tests, plus route-level assertions.
- Automated checks cover feature field rendering, scope validation, old-draft migration, removed-source mappings, renamed/reordered review invalidation, missing-information suggestions, process row/code formatting, preview generation and actual Word XML export for multiple features.
- Unsupported cross-feature evidence and exports using changed feature names are rejected.
- Database bundle matches the existing 18 migrations / 30 tables.
- ZIP integrity, patch payload and application onto an isolated v0.6.73 copy were verified.

AI responses were simulated in route tests. Live AI credentials and an interactive browser session were unavailable; run the deployment checks above after applying the update.
