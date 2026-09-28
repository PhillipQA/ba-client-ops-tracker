# v0.6.56 functional verification

Baseline: the supplied v0.6.55 full-build archive (220 files, SHA-256 `dcabb0ac0c6d744180508fad366992ee5722067e0ffba8a6e3fb8443997d6f69`). Scope: application functionality and AI interpretation. No security test suite or live production mutation was performed.

## Build and repeatable tests

- `npm run build`: passed (TypeScript and Vite). Existing large-bundle and lucide-react directive warnings remain; no build errors.
- `npm run typecheck:server`: passed.
- `npm run db:check`: passed; 16 migrations, 29 tables.
- `npm run test:functional`: passed. This runs 35 selected existing functional cases, 9 new integrity cases, 1 Gmail route scenario, and 15 isolated provider/route checks. Access-control and security suites are intentionally excluded.
- New service cases exercise revision detection, activity preservation, duplicate requirement IDs, exact source excerpts, unknown case references, computed coverage, FSD module filtering, BA context totals/retrieval, Gmail continuation/MIME bodies, business-day rollover and historical reminder suppression.
- The Gmail route imported 65 messages over three pages, retained two labels, refreshed existing bodies, and preserved archive/task-link fields. Separate continuation tests verify that the five-page batch limit resumes unfinished labels.
- AI route checks use synthetic fixtures and mocked provider responses. They cover all four configured adapters, grounded FSD generation and Word export, test-case Excel export, rejection of unsupported scope/references, visible partial BA context and stale/fresh workspace saves.
- The workspace and assistant route fixtures execute the actual route declarations in isolation with controlled dependencies. They are not a complete deployed-server end-to-end test.

## Browser checks

Actual React components ran in headless Chromium against Vite. API fixtures were used for repeatability. The hybrid PDF check used the real browser Tesseract OCR engine with local English language data, not a mocked OCR result.

1. Returning to Document Creation refreshes template and AI availability.
2. Deleting a case recalculates coverage immediately.
3. Client filter applies to Workload by user.
4. User filter scopes workload rows.
5. Hybrid PDF preserves footer and scanned requirement body.
6. DOCX line breaks retain distinct rule fields.
7. Clearing AI chat cancels late responses.
8. Cloud save queue advances own revisions and blocks stale queued saves until recovery.
9. Business date refreshes across Manila midnight without page reload.

No page errors were recorded. The repaired PDF extraction retained the selectable footer and recovered: “Supervisor approval is mandatory for refunds.” Word extraction kept minimum and maximum on separate lines. Cloud recovery additionally verified that the most recent failed snapshot remains available for download until explicit recovery.

## Database execution

The full fresh setup was executed in an isolated PostgreSQL/WASM runtime with the required Supabase roles and pgcrypto extension. It created all 29 tables. The real v16 save wrapper accepted a current timestamp, rejected a stale timestamp with SQLSTATE `40001`, and retained a concurrently edited task and a new task. The additive v16 migration was rerun successfully without changing stored operational data. Hosted Supabase/PostgREST was not contacted; an installed-environment smoke check is still needed.

## Packaging

A clean copy of the supplied v0.6.55 archive was updated with the existing patch utility. Every resulting release file was compared byte-for-byte with the v0.6.56 full build. Both ZIPs passed archive integrity checks. The updater rollback was also checked against the original baseline. The full build contains source, templates, assets, documentation and tests; dependencies, build output and local credentials are not bundled.

## Interpretation limits and deployment checks

The source-excerpt check validates the presence of a quote, not semantic entailment. Module classification, OCR, ambiguous requirements and case expectations still require review. There is no claim that any AI-generated suite is complete or that its cases have been executed. FSD now uses two provider calls. Long contexts still have explicit detail caps, alongside full-scope counts and a visible partial-context message.

No real AI model, Gmail mailbox, DocHub or production Supabase integration was exercised. After migration/restart, verify one current-revision save, a two-session conflict, a small document generation with known requirements, and a Gmail sync using the intended account. Confirm that every app instance and browser is on v0.6.56.

Gmail pagination and MIME field handling follow the official [messages.list](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list) and [Message](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages) documentation.
