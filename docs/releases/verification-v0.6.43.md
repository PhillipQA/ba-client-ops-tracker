# v0.6.43 verification

## Reproduction

Using the v0.6.42 source, a green-grass background and a partially signed document, the details backdrop measured approximately 1110 × 342 px inside the Document history panel on a 1440 × 950 px viewport. An expanded activity list extended beyond the panel and screen. The card also displayed the saved setup instruction after signing had started.

## Checks

- `npm run build`: passed. Existing dependency directive and bundle-size warnings remain.
- `npm run typecheck:server`: passed.
- `npm run test:dochub`: 13 passed, including the setup-required → externally created signing request → partially signed → completed transition, persisted setup-note cleanup, saved-record guidance, unchanged task status and no automatic send request.
- Local Chromium with simulated app/DocHub API responses: checked the native modal over the themed page, contained scrolling with 35 activity entries, viewport bounds, reachable close button, no horizontal dialog overflow, keyboard access, focus return, Escape/close/backdrop dismissal, status refresh and completed-document archive behavior.
- Checked Dark and Light at desktop width; Gray and original appearance at smaller viewport sizes; original green-grass background at desktop width. Personal colors continue to reach the dialog because it remains in the app's themed DOM.
- No browser page errors or unexpected write requests during the checked flow. The only simulated write was the requested status refresh.
- Patch applied to a clean v0.6.42 source copy. Resulting source matches the full v0.6.43 package; environment-file sentinels were preserved.
- Templates, background assets, RTM source, appearance styles, dependencies and existing database migrations compared byte-for-byte with v0.6.42 and preserved.

## Limits

This validation used local Linux/Chromium and simulated integration responses. It did not access the user's live DocHub account, sign or send a document, deploy to Render, write to live Supabase, or exercise Windows/macOS/iOS browsers.
