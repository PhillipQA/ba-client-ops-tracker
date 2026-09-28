# Functional verification — v0.6.58

- Production TypeScript/Vite build and server type check passed.
- In Chromium, a text source upload triggered AI review with document details empty. The source was readable, the processing panel showed success, no preview request was sent, and the disabled preview button listed Client, Feature name and Prepared by as missing.
- After filling the required fields, preview became available. A later document and the selected preset reached the request together. Source edits, scope changes, failed-review retry, source removal, Reset during a pending review, and pasted notes behaved as checked in v0.6.57.
- The screen displayed App v0.6.58; the new guidance was visually inspected in the browser.
- Both ZIP archives passed integrity checking. Installing the patch on the v0.6.57 full build produced the v0.6.58 full build byte for byte, and rollback restored v0.6.57.

Browser responses for AI were controlled fixtures. Hosted Render, live AI provider credentials, Supabase and security testing were not exercised. The source review and backend generation logic remain the v0.6.57 implementation.
