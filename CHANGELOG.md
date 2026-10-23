# Changelog

**Current application release: v0.6.89**

Changes are listed newest first. For installation, use the [README](README.md). For database requirements and update commands, use the [upgrade guide](docs/setup/upgrade.md). Older patch instructions apply only to the versions they name.

## v0.6.89 — Google Drive in Document Creation
Released October 23, 2026.

No database change. It uses the Google Drive connection from v0.6.87, so an account administrator must have connected Google Drive in **Settings → Integrations**.

### Added

- **Signed documents file themselves.** When DocHub shows a DRF or Sign Off document as fully signed, the signed PDF is saved to the shared Google Drive under **Client / Project / Task / Subtask**, following the task or subtask linked in DocHub options (for example, DRF Creation). It is also listed on that task under **Saved to Google Drive**, and a system comment records where it went. If no task is linked, it goes to the **Client / Project** folder. If neither a task nor a client is linked, or Drive is not connected, the document says why and nothing is lost.
- **Failed saves are retried.** A Google Drive problem never affects the signature. The save is retried by the background check a few times, and the document card shows a **Save to Google Drive** (or **Retry**) button. The same button files documents that were signed before this release. Only documents that become fully signed after this release are filed automatically.
- **Choose from Google Drive in DRF Creation.** Next to the COR upload, a picker lists the files the tracker saved to task and subtask folders (for example a COR saved from an email), with search and a client filter. The chosen file is used exactly like one chosen from the computer. It passes through the tracker to your browser and is not stored.
- **Save to Google Drive for generated documents.** After you generate a BRD, FSD or test case suite, a bar offers to file it under a task or subtask you choose.

### Notes

- The app can only see files it created (the narrow `drive.file` permission), so the picker lists files saved through the tracker. Files added to those folders by hand in Drive are not listed.
- Requirements Traceability exports are not filed to Drive yet.

## v0.6.88 — Save to Drive works on every message in an email thread
Released October 23, 2026.

No database change.

### Fixed

- **"Create a task from this email first" appeared even after a task was created.** A thread in Work Hub lists every message in it, each with its own attachments, but a task was linked only to the message that was open when it was created. An attachment on an older message in the same thread therefore saw no tasks. **Save to Drive** now offers the tasks, and their subtasks, created from any message in that thread. The same check applies when saving, so a different thread, or another user's copy of the thread, still cannot file into those tasks.
- The task list in the picker is now reloaded each time it opens, so a task created after the picker was first opened shows up without leaving the page.
- The empty-picker message now says that tasks made on the Tasks page are not linked to an email, and points to **Create a project task** in Work Hub.

## v0.6.87 — Save Gmail attachments to Google Drive task folders
Released October 23, 2026.

**Database migration required:** apply [schema v23](database/migrations/schema-v23-drive-attachments.sql) before connecting Google Drive. It runs on Supabase and on plain PostgreSQL (Northflank).

### Added

- **One shared Google Drive per account.** An account administrator connects it in **Settings → Integrations → Google Drive — team folder**. It uses the account's existing Gmail OAuth client and callback address. In Google Cloud, only the Google Drive API needs to be enabled; no new redirect URI is needed.
- The app asks only for access to files and folders it creates (`drive.file`). It creates a **BA Client Ops Tracker** folder and, inside it, one folder per client, project, task and subtask. Share that folder with your team, or move it into a shared drive.
- **Save to Drive in Work Hub.** After you create a task from a Gmail message, each attachment has a **Save to Drive** button. Pick the task or one of its subtasks, and the file is copied from Gmail to `Client / Project / Task / Subtask` in Drive. The app keeps no copy.
- The task, or subtask, shows the file under **Saved to Google Drive** with an **Open in Drive** link, and the activity log records the save.
- An email that created several tasks lists all of them, with their subtasks. Archived work isn't offered. Saving the same file to the same task twice is refused.
- Folders follow the records: if a task is renamed, its folder is renamed. If a folder is deleted in Drive, it is created again on the next save.
- Only the email's owner can save its attachments, and only to tasks created from that email. Viewers cannot save. Drive links on tasks can only be written by the server, never by a browser save.

## v0.6.86 — Download Gmail attachments from Work Hub
Released October 23, 2026.

### Added

- Gmail attachments in **Work Hub** are now links. Click a file name in a message or its thread to download that file.
- The file is fetched from Gmail at the moment you click and passed straight to your browser. It is **not saved** in the database or on the server. If the email or the attachment has since been deleted in Gmail, Work Hub says so.
- Only the user whose mailbox the message came from can download its attachments. Every download checks the user, the account and Work Hub access first.
- Newly synced messages also show each file's size. Messages synced before this version download the same way; they just don't show a size.
- Files always download and never open inside the app. This also applies to HTML and image files, so a file sent by email cannot run inside the app.
- No new Gmail permission is needed. Gmail continues to use read-only access.

No database migration is needed.

## v0.6.85 — Readable BRD and FSD previews
Released October 21, 2026.

### Fixed

- The **BRD preview** was close to unreadable in the dark appearance and with wallpaper themes: headings, table cells, lists and the summary came out in pale grey on the white page (a contrast of about 1.1 to 1, where 4.5 to 1 is the minimum). The dark workspace's text colors were reaching the page that stands for the Word document.
- The BRD and FSD previews now keep dark text on white in every appearance (dark, light and the older appearance), every wallpaper theme and both operating-system color preferences. Table headers on the FSD preview in the older appearance with a wallpaper theme, the notes inside the "Partial draft" warning, and the Edit preview inputs, delete buttons and "Add" buttons on the BRD page are covered too.
- The Word exports are unchanged.

No database migration is needed.

## v0.6.84 — FSD and BRD generation survive unreadable AI replies
Released October 21, 2026.

### Fixed

- Generating an FSD preview could stop with "The AI returned an invalid document. Your draft is retained; retry with a smaller scope." The AI had finished, but its reply contained a formatting slip the app could not read — typically a line break or an unescaped quotation mark inside the text, which is more likely in long documents or when the sources quote on-screen messages.
- The app now repairs these slips when it can do so safely (line breaks and tabs inside text, quotation marks inside text, trailing commas, extra words or code fences around the document). If the reply still cannot be read, it asks the AI once more, with a reminder to return clean JSON, before showing an error. The BRD preview gets the same repair and retry. Source reviews and the older source-map step repair slips as well but do not retry.
- If both attempts fail, the message now says the reply could not be read and that trying again usually works, instead of suggesting a smaller scope. The draft and sources are kept as before.
- When a reply cannot be read, the server log records only its length and shape, never document text.

No database migration is needed.

## v0.6.83 — More Sign Off forms and configurable Waiting on
Released October 21, 2026.

### More Sign Off documents

- **Document Creation → Sign Off Document** now offers five forms: Production Deployment Form, **Go Live Sign Off** (the button was labelled "Sign Off Form"), and three new forms: **UAT Sign Off**, **UAT Deployment Approval** and **Training Sign Off**.
- The three new Word templates are styled like the existing two. UAT Sign Off and Training Sign Off use the Go Live layout (Prepared By and Date header, Name / (Date) signature lines). UAT Deployment Approval uses the Production layout (page-number header, stacked signature blocks with a Date line). All five share the iRipple logo, fonts, shaded labels and table borders.
- Everything on the new forms is editable before you generate: the detail values, the wording of every section (the standard wording from the supplied forms is pre-filled and can be restored), and the table rows. UAT has Summary of Tested Modules, High Priority Issues and Remaining Issues tables; Training has Training Activities Completed. Add or remove rows in the form; blank rows are left out of the document.
- Product Deployed uses the same product list as the other forms, and the version is typed in. UAT and Training take a start date and an optional end date, printed as `MM/DD/YYYY to MM/DD/YYYY`. UAT Deployment Approval has a Target Deployment Date, a Deployment type (suggested options or your own wording) and an Enhancement name shown under "CLIENT ENHANCEMENT".
- Each form starts with two iRipple and two client signatories and allows up to 20 per side. Attachments, DocHub preparation, filenames and Reset work as before. UAT Deployment Approval references start with `PAF-`; UAT and Training start with `SOF-`. Suggested filenames start with `UAT-`, `UAD-` and `TRN-`.
- **Settings → Templates** has a card for each new form to upload your own Word template, remove it, or restore the built-in one. Uploads are checked for the required mapping tags. Custom uploads for the new forms need `schema-v22`; the built-in templates work without it.
- Known limitation: section wording is plain text, so bold, underline and superscript emphasis from the supplied forms is not carried over (for example, Training Objectives uses "Barter™").

### Configurable "Waiting on" options

- Internal Admin → Platform settings → choose an account → **Task configuration** now has a **Waiting on options** list. Add, rename, reorder and remove options per account, the same way task statuses are managed.
- The first option is the default for new and reopened tasks. One option marks a task as done (Done by default). It can be renamed but not removed, and completing a task still sets it.
- Renaming an option moves every task that uses it to the new name when you save. An option that tasks still use can't be removed until they are moved.
- The task forms, task filter, Board view, Work Hub → Create task, Reports, the BA Assistant and email/Discord capture all use the account's list. Accounts that never change it keep the previous six options, so nothing changes until an admin edits the list.
- The Action Center "Waiting on Dev" card follows the Developer option (including a renamed one). If an account removes it, the card shows "Waiting on others".
- Users should reload their workspace after the list changes, as with status changes.

## v0.6.82 — Task board, effort tracking and fixes
Released October 20, 2026.

### Schedule and waiting-on for linked tasks

- Work Hub → GitHub/GitLab → Linked work → Create task now has a **Waiting on** field (default Me) and a **Task schedule** with optional start, due and follow-up dates, matching the main task form.
- A due date earlier than the start date is blocked in the form and rejected by the server. Omitted fields keep the previous behaviour (waiting on Me, no dates).

### Fix blank page after a deploy

- Fixes a blank page with "Expected a JavaScript-or-Wasm module script but the server responded with a MIME type of text/html" in browsers that had the site open or cached before a deploy. The browser kept an old `index.html` that pointed at asset files the new build no longer has, and the server answered those requests with the HTML page.
- `index.html` is now sent with `Cache-Control: no-cache`, so browsers check for a new version on every load. Hashed files under `/assets` are cached for a year, since their names change with each build.
- A missing file under `/assets` now returns 404 instead of the HTML page.
- A tab left open across a deploy reloads itself once when it can't load a code chunk.
- After this is deployed, a browser that is already stuck needs one hard refresh (Ctrl+Shift+R). No further cache clearing is needed after that.

### Task board and effort tracking

- **Board view for Tasks.** Switch the Tasks page between Table and Board. Group columns by status (from your configured task statuses) or by who the task is waiting on. Drag a card to another column, or use its Move menu, to change its status or waiting-on. Closed statuses and Done start collapsed. Cards show priority, due or follow-up date, client and project, subtask progress, comments, assignee and effort. The chosen layout is remembered per user.
- **Effort estimates.** Tasks and subtasks have an optional Estimate (hours) field. A main task without its own estimate uses the sum of its subtasks' estimates.
- **Time logging.** The task editor has an Effort section showing estimate, logged and remaining or over-estimate time, a breakdown by category, and a Log time form (date, hours in quarter-hour steps, category, optional note, and which subtask to log against). Quick +15m/+30m/+1h buttons fill the hours. Main tasks include time logged on their subtasks. People can remove their own entries; Administrators can remove any entry.
- **Effort report.** Reports has a new Effort panel for the selected range, client, project and user: hours logged, estimate vs actual, tasks with time but no estimate, hours by client (within vs over estimate), hours by category, hours by user against capacity (40h per week for now), the biggest overruns, and a CSV export of time entries.
- Time entries are written only through `POST /api/tasks/:taskId/time-entries` and `DELETE /api/tasks/:taskId/time-entries/:entryId`, which record the signed-in user as the author. Workspace saves keep the stored entries and validate estimates. Logging time does not cause save conflicts for other people editing the workspace.

### Security hardening

- Changing your email address or password in My profile now requires your current password, with a limit on wrong guesses.
- Sessions now expire on the server: 8 hours after sign-in, or 2 hours without activity (`SESSION_IDLE_TIMEOUT_MINUTES`). Expired sessions are cleaned up automatically.
- Failed sign-ins are limited per address and per user as well as per address-and-user, so one password tried against many users, or one user attacked from many addresses, is stopped.
- Internal Admin can only view data or change its own password and recovery email until the bootstrap password is replaced.
- Add baseline security headers: no content-type sniffing, no framing, referrer and permissions policies, and HSTS in production.
- Non-administrators no longer receive other users' email addresses and phone numbers.
- Evidence and DRF routes require a tenant workspace login like the rest of the workspace routes.
- Add `npm test` and run the authentication tests in CI.

**Database:** no new migration. Estimates and time entries are stored on the task record.

## v0.6.81 — Multiple tasks from one email
Released October 12, 2026.

- Create multiple distinct tasks from the same Work Hub email without signing out or closing the browser.
- Reject duplicate task titles for the same client/project, ignoring case and repeated whitespace.
- Keep the message and task form open after saving. Retain client, project and assignee; clear title and description for the next task.
- Prevent rapid duplicate clicks and preserve saved tasks if a subsequent refresh or message-badge update fails.

**Database:** no new migration. [Full notes](docs/releases/v0.6.81.md).

## v0.6.80 — Sign Off Document
Released October 11, 2026.

- Rename the module to Sign Off Document.
- Switch between Production Deployment Form and the supplied Go Live Sign Off Form.
- Edit retained narrative sections and add signatories beyond the initial two per side.
- Keep separate drafts and attachments while switching forms.

**Database:** schema v21 is needed for optional custom Go Live template management. Built-in generation uses the existing table. [Full notes](docs/releases/v0.6.80.md).

## v0.6.79 — FSD missing-input guidance
Released October 11, 2026.

- Name missing information and unavailable/failed sources before generation.
- Keep failed uploads visible so users can replace or retry them.
- Show contributing, partially used, skipped, irrelevant and excluded sources.
- Generate Anyway uses verified available content and retains TBD placeholders for unavailable information.

**Database:** no new migration. [Full notes](docs/releases/v0.6.79.md).

## v0.6.78 — Work Hub login and manual sync
Merged October 9, 2026.

- Sync connected integrations once at sign-in.
- Refresh now syncs all connected integrations; individual Sync buttons refresh one source.
- Remove timed/focus-driven Work Hub sync and automatic continuation.
- Preserve saved per-user pages until the relevant source is refreshed.

**Database:** no new migration for the sync change. [Full notes](docs/releases/v0.6.78.md). This supersedes the Work Hub polling described in v0.6.76/v0.6.77.

## Earlier updates

| Version | Main change | Database action |
| --- | --- | --- |
| [v0.6.77](docs/releases/v0.6.77.md) | Active-view refresh and reduced background reads | No new migration |
| [v0.6.76](docs/releases/v0.6.76.md) | GitHub / GitLab provider selection | Schema v20 for GitLab; v19 if GitHub is not installed |
| [v0.6.75](docs/releases/v0.6.75.md) | Personal GitHub Work Hub integration | Schema v19 |
| [v0.6.74](docs/releases/v0.6.74.md) | FSD custom features and supporting screenshots | No new migration |
| [v0.6.73](docs/releases/v0.6.73.md) | FSD readiness checklist and Generate Anyway | No new migration |
| [v0.6.72](docs/releases/v0.6.72.md) | DocHub native signatory reminders | No new migration |

The [release archive](docs/releases/README.md) contains the older version notes and verification reports. SMTP reminder delivery introduced in v0.6.70 was superseded by DocHub-native reminders in v0.6.72; SMTP remains applicable to password recovery.
