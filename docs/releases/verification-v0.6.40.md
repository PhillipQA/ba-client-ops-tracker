# v0.6.40 verification

## Completed

- Production frontend build (`npm run build`) and strict backend TypeScript check (`npm run typecheck:server`).
- 37 passing focused tests: 13 RTM cases plus existing lifecycle, tenant-settings preservation and subtask-assignment cases.
- RTM rules cover: incomplete descendants beneath a completed parent; duplicate child links; explicit QA failure/pass; reopened QA work; custom completion statuses; cancellation; cross-client and missing requirement links; Viewer/module write restrictions; task-only workers updating linked status; Administrator override authorization and reason; server-derived history; content revisions and impact review; stale saves; hierarchy cycles; removal of linked work/requirements; N/A denominators; archive/activate; quoted/multiline CSV parsing; parent mapping; duplicate import IDs; and unsafe document URLs.
- Chromium browser flow using the actual React app and mocked tenant HTTP responses: create two client-specific RTMs under one shared project, add a requirement, link a parent and its subtasks, open and complete a linked subtask through the existing editor, observe automatic RTM completion, edit/review a changed requirement, export Excel, import it into the other client's RTM, reload saved state, and switch tile/list layouts. No browser page errors were recorded.
- Desktop and narrow-screen screenshots reviewed; theme contrast and tab spacing adjusted.
- Generated XLSX opened with an independent spreadsheet library: RTM and History sheets, 44 matrix columns, frozen header, requirement text, calculated development status, and history rows checked. Exported values are stored as text cells rather than formulas. The actual browser import successfully read the generated workbook without carrying task links to the other client.
- Patch application through the existing updater against a clean v0.6.39 copy, version check, payload comparison, protected environment preservation and ZIP integrity.

## Scope and limits

Local Linux, Node.js 24, Chromium and the package's locked dependencies. The UI fixture reused the real RTM validation/reconciliation functions but mocked HTTP storage and authentication; no live Supabase/Render account was used. The new RTM fields use the existing tenant JSON snapshot and save RPC without SQL changes. Production database persistence, real multi-user network concurrency, Windows/PowerShell execution, and live Discord, AI, Calendar, DocHub, email or external document services were not exercised. Existing non-blocking bundle-size and Lucide directive warnings remain.

Browser visual checks covered the new module, import flow and linked task editor, not a full regression of every existing screen. Separate users see remote changes through the existing focus/five-minute refresh rather than push updates.
