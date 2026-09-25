# v0.6.41 local verification

## Passed

- Frontend production build: `npm run build`.
- Strict server typecheck: `npm run typecheck:server`.
- 111 TypeScript tests: `node --import tsx --test tests/*.test.ts`.
- 6 layout/source checks: `node --test tests/*.test.mjs`.
- The new RTM AI suite covers source limits; verified quotations; foreign source/requirement rejection; hierarchy cycles; test-case-only warnings; discarded AI task/assignee/status fields; explicit review; stale previews; deterministic IDs; duplicate prevention; preservation of statuses/overrides; reference deduplication; saved evidence validation; authenticated tenant and Document Agent selection; source-consent gating; model-change gating; Viewer/module/anonymous access; disabled agent and malformed/provider-error behavior without credential exposure.
- Browser flow on local Chromium: Manual/AI switch; DOCX, text PDF and multi-sheet XLSX extraction; explicit transmission consent; failed-provider draft retention and retry; generation without saving; selection/review gating; source references and quotations; saved stage evidence; merging references into existing requirements without duplication; unchanged task records and assignment; reload; desktop/mobile layout and no uncaught browser errors.
- UI screenshots were inspected; the AI dialog's sticky header/footer were made opaque so scrolled text does not bleed through.

An existing auth test expected the literal version `0.6.36`, although the baseline already reported `0.6.40`. Its assertion now uses `APP_VERSION`; no authentication runtime code was changed for this.

## Test environment and limits

Local Linux with Node.js and the existing locked app dependencies. New dependencies were not added. Vite retains its existing non-blocking bundle-size and dependency `use client` warnings.

AI adapter calls were replaced by deterministic fixture responses in HTTP tests. The browser uses fixture API responses and the real RTM validation/reconciliation functions for saves. No user documents, live API credentials, provider usage, production tenant data or external messaging were used.

Live model output quality, quota, model access, provider-specific token limits, scanned-PDF OCR quality, Windows execution, production Render/Supabase persistence and cross-user refresh timing were not verified. Use a small known BRD/FSD/test-case set in staging first and compare the proposed mapping against the source documents.

Patch installation verification is performed against a disposable copy of the v0.6.40 full release. The patch must preserve environment files and match its payload byte-for-byte. The release package includes the source and upgrade instructions, not production data or credentials.
