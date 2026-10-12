# BA Client Ops Tracker v0.6.73 — FSD from available information

Upgrade from v0.6.72 with the matching patch. The full build is also included for a fresh installation or deployment.

## What changed

- FSD Creation → **5. Preview & generate** now shows **Information needed for a fuller FSD**, with concrete **What to add** guidance from current source reviews and generated preview gaps. Suggested inputs include plain-text notes, workflows, sample reports, field definitions, role descriptions and API examples. No formal BRD or specific document type is mandatory.
- **Generate anyway — use available information** creates a partial draft from short notes and verified readable portions of incomplete documents. It skips unreadable documents and failed source reviews, explains which sources were skipped, and preserves missing selected sections as **TBD / Pending information**.
- Missing template sections and structural process/data/acceptance tables are supplied with TBD values where needed; the creator does not fill unknown rules, fields or technical values by guessing.
- Missing information, concrete suggestions and skipped-source explanations remain visible in the preview and Word export. A readable source with no mapped requirements can produce a template draft with TBD content and questions explaining what to add.
- **Client, Feature name, Product, Prepared by, Document date and Revision remain required** for either generation option. Preset instructions and at least one readable reviewed source are also needed. Short pasted notes can supply that source.
- The normal preview option still requires successful, complete source reviews. Generate anyway allows partial reviews and skips unsuccessful ones.
- Unchecked modules stay excluded. Source excerpts, requirement links and current-source validation still apply. Changes to the source or scope require a regenerated preview. Download still requires the user's review checkbox and a configured FSD template.
- Corrected the fetch response type in DocHub signed-PDF downloading, resolving the five server TypeScript errors found in v0.6.72.

## Apply the patch on Windows

Run these commands from the tracker project folder:

```powershell
npm run patch -- "C:\Downloads\ba-client-ops-patch-v0.6.73-fsd-available-information.zip"
npm run build
npm run typecheck:server
```

Restart the app or redeploy, then refresh the browser. No new dependencies or database migration are required. The version label should show **0.6.73**.

The patch includes `patch-manifest.json` and upgrades exactly v0.6.72. Do not use `--force` on a different version.

For a fresh installation, extract the full build into a new project folder, configure the environment using `.env.example` and the README, run `npm ci`, then `npm run build`. Existing deployments should keep their environment variables and database. `database/setup.sql` is for a fresh database only.

## Check the enhancement

1. Fill in the required basic document fields.
2. Paste a short note such as “The stock report shows item codes” and add it as a source. Select only MMS Report if that is the intended scope.
3. Check the **Information needed for a fuller FSD** list. It should show specific missing information and possible inputs, rather than only asking for mapping.
4. Click **Generate anyway — use available information**. Available facts should appear; missing sections or fields should be marked TBD. Unchecked modules must not appear.
5. Try a partly readable document alongside a readable source. Verified portions should be used and unreadable/failed reviews listed as skipped.
6. Review the preview, select the review checkbox, and download Word. Pending questions, source references and skipped-source explanations should remain in the document.
7. Add supporting notes and regenerate to incorporate the new information. Blank required basic fields must still prevent generation.

## Validation

- Production build and server TypeScript check: passed.
- Functional regression command: 56 tests passed plus route-level assertions for AI adapters, FSD generation/export, test-case generation and workspace updates.
- New available-information tests: 8 passed (included in the functional regression count).
- Full DocHub suite: 19 passed, including signed-PDF downloading and native signer reminders.
- Database bundle: matches 18 migrations / 30 tables.
- Patch payload and application onto an isolated v0.6.72 copy: verified.

AI and external integrations were tested with simulated provider responses; live account credentials were not used. The readiness component was rendered in automated checks. An interactive browser check was unavailable in this environment, so the deployment checks above should be run after applying the patch.
