# v0.6.55 validation

The full `npm run build` (TypeScript + Vite) and `npm run typecheck:server` passed using the unchanged dependency lock. Vite emitted existing bundle-size and lucide-react directive warnings; no compiler or build errors occurred.

The FSD scope suite passed 4/4; the DocHub suite passed 13/13. The database setup matches 15 migrations and 29 tables; only the release label in the bundled SQL changed.

The actual document creator components were exercised in headless Chromium with the project's Vite server. Mock API responses and controlled delayed reads allow reproducible reset checks without sending user documents or using real AI/DocHub credentials. This does not constitute a live integration/OCR accuracy test.

## Browser checks: 19 passed

1. FSD opens in Advanced Mode with scope and mapping always visible.
2. FSD removal is visible while collapsed; the same file can be added again.
3. FSD Reset clears all draft input and survives reload; reusable presets remain.
4. Existing Basic draft converts to Advanced without losing inputs or retaining its old preview.
5. Reset during source reading discards the late upload and allows a fresh upload.
6. Reset aborts FSD generation and ignores a late provider response.
7. Reset during FSD export prevents a stale download.
8. DRF Reset clears uploads, extracted/editable fields, POS rows, signers and all DocHub choices.
9. Reset during local COR reading prevents stale extracted values and the subsequent AI request.
10. Reset during DRF generation prevents stale download and DocHub preparation.
11. Reset clears pending DocHub document/retry state and ignores a late preparation result.
12. Sign Off Reset clears deployment inputs, signers, attachment bytes/captions and DocHub choices.
13. Reset during attachment reading prevents the discarded Sign Off attachment returning.
14. Reset during Sign Off generation prevents stale download and completion status.
15. Test Case Reset clears sources, text, skill selection, coverage and preview; reusable skills survive reload.
16. Reset during coverage generation discards the late coverage map.
17. Reset during test-case generation ignores the late suite.
18. Reset during test-case export prevents a stale spreadsheet download.
19. No browser runtime errors in the reset flows.

## Packaging

The patch updater was run against a newly extracted v0.6.54 archive. Its resulting source matches the v0.6.55 full-build archive byte for byte. Patch and full-build ZIP integrity checks passed. The package includes source and standard assets, not node_modules, test fixtures or local credentials.
