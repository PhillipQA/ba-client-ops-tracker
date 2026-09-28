# BA Client Ops Tracker v0.6.56

Functional correctness and AI interpretation fixes, based on the v0.6.55 review (F01–F12).

## Upgrade from v0.6.55

This release requires **database migration v16**. The patch contains the migration but does not execute it. The tested baseline is `ba-client-ops-tracker-v0.6.55-full-build(1).zip`.

1. Keep a database backup and a copy of the existing app directory. Stop every app/server instance during the upgrade. Older instances use the legacy save function and must not keep accepting writes.
2. From the existing project directory, apply the patch:

   ```sh
   npm run patch -- "/path/to/ba-client-ops-patch-v0.6.56-functional-ai-fixes.zip"
   ```

   On Windows, replace the quoted path with the actual ZIP path, for example `C:\Downloads\ba-client-ops-patch-v0.6.56-functional-ai-fixes.zip`.
3. Run the entire `database/migrations/schema-v16-functional-integrity.sql` in the existing Supabase project's SQL Editor. It adds the atomic save wrapper, Gmail sync progress and multiple-label storage. It preserves existing records and backfills their original Gmail label. Do **not** run `database/setup.sql` against an existing database.
4. Build and verify:

   ```sh
   npm run build
   npm run typecheck:server
   npm run db:check
   npm run test:functional
   ```

5. Restart using your existing production process manager or `npm start`. Reload all open browser sessions. Confirm the displayed version is **0.6.56**.

There are no runtime dependency changes; an existing installation with its v0.6.55 dependencies does not need `npm install`. Keep its environment configuration, integration master key, templates and external data. For a new installation, extract the full-build ZIP, run `npm ci`, follow `README.md`, and use `database/setup.sql` only on a new, empty Supabase database. Fresh setup now includes migrations 1–16 and 29 tables.

The patch utility creates an application-file rollback backup. Database migration v16 is additive and can remain installed during a file rollback, but v0.6.55 will again have the reviewed functional defects, including stale-save overwrites. Stop all instances before any rollback; do not delete database tables or replay historical migrations.

## What changed

| Review | Fix |
| --- | --- |
| F01 — shared saves | The browser sends the revision it loaded; stale snapshots receive a conflict instead of replacing newer work. Database compare-and-save runs under the workspace lock, including across server instances. Server-owned comments, evidence, DocHub records, accounts and notification state are retained. Activity history is merged by ID. Pending saves stop after a conflict, and the UI offers a downloadable pending copy plus reload. |
| F02–F03 — test cases | Unique requirement IDs, verified source excerpts and validation of every reference. Coverage is computed from distinct requirements linked to complete cases and recalculates after editing, deleting or duplicating rows. Unconfirmed expected results are excluded from the link count. XLSX export revalidates sources and references. |
| F04 — source extraction | Hybrid PDF pages with images undergo OCR even when they have selectable headers or footers. Native text is retained alongside OCR. Word extraction preserves breaks, tabs, tables, headers, footers and notes; embedded raster images undergo OCR. Unsupported visuals and low-confidence OCR are flagged. COR extraction uses the same reader and no longer silently stops after four PDF pages. Oversized text is rejected with a split-document message. |
| F05 — FSD scope and interpretation | A separate interpretation step extracts atomic, module-tagged requirements with verified quotes. Explicitly excluded source mappings are removed before interpretation. Only selected requirements reach the writing step. Content blocks must link to those requirements; unknown links, wrong module links and recognized excluded-module names are rejected. Preview and Word references expose the evidence for review. |
| F06 — BA Assistant context | Exact full-scope aggregates, explicit business-date periods, relevant and urgent record selection, readable client/project/assignee names, and visible partial-context notices. Current assignments and historical contributions are separated. |
| F07 — settings freshness | Returning to Document Creation refreshes templates and COR AI availability. Template changes also trigger refresh without resetting the draft. |
| F08 — Gmail | Pagination with persistent continuation, at most five pages per sync, clear “more messages remain” feedback, all labels stored, existing messages refreshed without resetting task links/status, and full readable HTML or attachment-backed text bodies. |
| F09 — reports | Workload and task metrics use the selected client, project and assigned user. CSV includes the filter scope. Shared planner activities have no user assignment; their separate scope is stated explicitly. |
| F10 — reminders | A historical rollover no longer suppresses a later follow-up-today reminder. |
| F11 — dates | Server work events and browser “today” use the configured business timezone. Browser dates refresh at midnight and on focus; reporting normalizes older event timestamps to that timezone. |
| F12 — chat reset | Clearing or switching chat context cancels the current request and discards late responses. |

## After updating

- Regenerate older FSD previews and test coverage maps to add source excerpts; their source text and draft inputs remain available.
- FSD preview now uses two AI calls: interpretation, then writing. This can take longer and use more provider tokens. Review the interpreted requirements, module classifications, source quotes and pending questions before exporting.
- Source excerpts prove where text came from; they do not prove the model's interpretation is correct. Linked test coverage is not proof of semantic completeness or passed testing. Human review remains part of both workflows.
- OCR reads English text. Diagram meaning, image placement, other languages, poor scans and unsupported embedded image formats still require original-document review. PDFs containing images may take longer to read.
- On a save conflict, use **Download edits and reload latest**, reopen stale editors and reapply the required changes. The pending JSON is a reference copy, not an automatic import or merge. Open, unsubmitted form fields remain in the editor and should also be retained before closing it.
- Gmail sync processes up to 150 message listings per click. If more remain, click again to resume. Once the label scan is complete, the next sync starts from the newest messages. Attachment filenames are shown; attachment contents are not imported as requirements. Very long email bodies are explicitly marked when shortened.

## Validation

Production build, server type check, database bundle, selected functional regressions, provider/route fixtures, browser checks, real fixture OCR, local PostgreSQL migration execution, and clean patch installation were verified. Security testing was intentionally excluded. Details are in `docs/releases/verification-v0.6.56.md`.

No live AI, Gmail or production Supabase account was contacted. Live provider access, quotas, model quality on your actual documents and deployment configuration still need an account-level smoke check after installation.
