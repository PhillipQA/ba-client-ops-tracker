# Functional verification — v0.6.57

## Automated checks

- `npm run build` — production TypeScript/Vite build. Existing large-chunk and lucide-react directive warnings remain non-blocking.
- `npm run typecheck:server` — server TypeScript validation.
- `npm run test:functional` — 35 selected existing functional regressions, 9 functional-integrity cases, 3 new source-review test cases, 1 Gmail functional-sync test, and 15 isolated provider/route/save checks.

The new source-review cases exercise the actual Express routes and generation adapter against controlled AI responses. They check review without details/preset, original evidence retention, wrong excerpts, scope and text changes, OCR warning handling, unreadable/incomplete blocking, two-source contradictory facts, current preset delivery, one-call generation from reused reviews, source names, Word export and exclusion of sources mapped to unchecked modules.

## Browser verification

Chromium ran the actual FSD component and source reader with controlled HTTP responses:

1. File upload automatically reviews the source before required details or preset selection.
2. A later supporting file joins the current preset in preview; the earlier review is reused.
3. Changing preset invalidates export without rereading unchanged sources.
4. Editing source text or checked scope requires fresh review.
5. A failed AI call retains extracted text and supports a source-specific retry.
6. Removing a source excludes it from the next preview request.
7. Reset during an active review discards its late response and persists the cleared draft.
8. Pasted notes receive automatic source review too.

The source-review cards were visually inspected. Browser fixtures do not establish live model quality.

## Packaging

Full and patch ZIP integrity checked. The patch is based on the v0.6.56 full build. Applied source files match the new full build byte for byte; rollback restores the original source files and removes newly added files.

## Not performed

No live tenant AI, Render, Supabase, Gmail or other external account calls. No security tests. OCR behavior and database schema were not changed by this feature; their prior v0.6.56 checks were not repeated. This release does not promise semantic correctness from successful quote validation or from a model's readable assessment.
