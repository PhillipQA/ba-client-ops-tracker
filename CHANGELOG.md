# Changelog

**Current application release: v0.7.1**

Changes are listed newest first. For installation, use the [README](README.md). For database requirements and update commands, use the [upgrade guide](docs/setup/upgrade.md). Older patch instructions apply only to the versions they name.

## v0.7.1 — Client field fixes
Released October 24, 2026.

No database migration and no new Google permission.

- In dialogs such as **New email**, the client list opened away from the field and pushed the dialog sideways. It now opens directly under the field (or above it near the bottom of the screen) and stays inside the dialog.
- Client fields now look like the boxes beside them. In v0.7.0 some screens' input styles, such as the email dialog's padding and outline, applied to every client field.

## v0.7.0 — Type-to-search clients and open-only task pickers
Released October 24, 2026.

No database migration and no new Google permission.

- **Type a client instead of scrolling.** Every place that asks for a client now works like the email recipient box: click or tab into it, type part of the name and the list narrows as you type. Arrow keys move, Enter picks, Escape goes back. Clients are listed A to Z (ignoring capitals, with numbers in order). This covers the Action Center AI box, the Tasks filter, New task, planner activities, Requirements and RTMs, Reports, the AI BA Assistant, Document Creation (Save to Drive and DocHub "Link to client"), New email, Work Hub task creation, Git ticket mapping and tasks, the Trackers list filter and the client choice when creating a task from a tracker. The free-text client boxes in the FSD and sign-off forms keep their suggestions, now A to Z.
- "All clients", "No client" and similar choices stay at the top of each list and show as the field's hint when nothing is chosen.
- **Only open work in task pickers.** Lists that ask you to choose a task or subtask now leave out closed and resolved work: the linked task in **New email**, **Save to Drive** in Document Creation, the DocHub task in document generation, linking a Git ticket to a task, and saving an email attachment to Drive in Work Hub. "Closed" follows your own task statuses (Settings → Task statuses); without them, Resolved and Closed count as closed.
- An open subtask of a closed task is still offered. A task already linked keeps showing as linked.

## v0.6.98 — Trackers: clients, task and subtask cells, calculations
Released October 24, 2026.

No new database migration and no new Google permission. Subtask cells use the task links table from [schema v25](database/migrations/schema-v25-tracker-task-links.sql) (v0.6.96); apply it if you have not.

- **Several clients per tracker.** Choose one or more clients when you create or import a tracker, or later under **Tracker details**. The Trackers list shows them all and its client filter matches any of them.
- **The first column holds the row's task.** Point at a row's first cell and click **+ Task** to pick an open task or create one. The title starts as the row's name; the client comes from the tracker (you choose when it has several) and the project defaults to the tracker's.
- **Every other cell can hold a subtask of that task.** Click **+** in a cell to pick one of the task's open subtasks or create a new one, titled with the column name (for example DRF or Go-Live). New subtasks go under the task, with its client and project. Each cell shows its subtask's status; a closed one stays, marked **Done ✓**.
- **Only open work is offered.** Closed or resolved tasks and subtasks never appear in the lists.
- **Create tasks for many rows.** Select rows and click **Create tasks**: a preview lists one task per row without a task, titled from its first column, and nothing is created until you confirm.
- **Calculated columns.** Add a **Calculated** column and write a formula with other Number or Calculated columns: `[Qty] * [Price]`, `([Budget] - [Spent]) / [Budget]`. Click a column name or an operator to insert it. Empty inputs count as 0, dividing by 0 shows #DIV/0, and renaming a column keeps the formula working.
- **Totals row.** Tick **Show the SUM in the totals row** on a Number or Calculated column. The row at the bottom adds up the rows shown, so it follows your search and filters.
- New tasks and subtasks appear in the Action Center with their tracker, row and cell once they have a follow-up date.

## v0.6.97 — Readable text over wallpapers
Released October 24, 2026.

No database migration and no new Google permission.

- Page introductions, filter labels (Show clients, Client, Show archived), the client's Active status line and the "Archive requirements" note now sit on a soft, dark, rounded background, so they stay readable over clouds and sea. Text inside cards and panels is unchanged.

## v0.6.96 — Trackers: move rows, change column type, task links
Released October 23, 2026.

**Optional database migration:** apply [schema v25](database/migrations/schema-v25-tracker-task-links.sql) to use task links. Everything else in this release works without it. No new Google permission.

- **Move rows.** Select one or more rows and use **Top**, **Move up**, **Move down** or **Bottom**, or drag a row by its number. The order is saved for everyone. Moving is available only while no sort, grouping, search or filter is active, because the order you see must be the saved order.
- **Change a column's type.** In **Edit column…** choose a new type: Text, Long text, Number, Date, Link or Select. **Check the change** shows how many values convert and which would be cleared, with examples. Nothing is cleared until you tick the box and confirm, and saved views that sort or filter by the column are reset. Checkbox, Multi-select, Person, Secret and the columns that fill themselves cannot be converted.
- **Link tasks and subtasks to a row or a cell.** A row's panel has a new **Tasks and subtasks** card. Link as many tasks and subtasks as you need to the whole row or to one column's cell. The grid shows the count beside the row number and marks cells that have their own link. In the **Action Center**, each linked task and subtask shows the tracker, row and cell it came from, on its follow-up date in the Activities tiles and in the table; click it to open that row.
- **Readable footer.** The row count, legend, breadcrumb and save status sit on a solid rounded background, so they stay readable over a wallpaper.
- **More room in Full view.** Import, Export and Exit full view become small icon buttons, and the page title and spacing shrink, so the grid takes more of the window.

## v0.6.95 — Trackers: freeze, resize and align columns
Released October 23, 2026.

No database migration and no new Google permission.

- **Freeze columns.** Open a column's menu and choose **Freeze column**. Frozen columns come first and stay in view while you scroll sideways, so a long sheet keeps its Branch or Name visible. The first column stays frozen unless you unfreeze it. The frozen columns together are limited to about 700 px so the rest of the sheet stays usable.
- **Resize columns.** Drag the right edge of a column header (double-click it to reset), or choose **Narrow**, **Standard**, **Wide** or **Extra wide** in the column menu. Widths go from 60 to 800 px.
- **Align text.** Choose **Left**, **Center** or **Right** in the column menu. Numbers stay right-aligned and checkboxes centered unless you choose otherwise.
- **Labelled links.** In a Link column, type a short label before the address, such as `#1234 https://git.example.com/app/issues/1234`. The cell shows **#1234** and opens the ticket; pointing at it shows the address. Editing the cell shows the label and address again, a plain address works as before, and the CSV export writes the label and address.
- **Full text on hover.** Long text that is cut off in a cell now shows in full when you point at it.
- These settings belong to the tracker, so everyone who opens it sees the same layout. Only people who can edit the tracker can change them. Cells still show one line; the row panel shows the whole value.

## v0.6.94 — Trackers: Full view
Released October 23, 2026.

No database migration and no new Google permission.

- **Full view.** Open a tracker and click **Full view** (next to Export CSV). The top bar with Add client, Add task and the other page buttons is hidden, the left menu stays, and the grid uses the whole screen height so more rows show at once. **Exit full view** brings the top bar back. The choice is remembered in this browser, and leaving the tracker always shows the top bar again.
- **Room around the tracker.** The tracker pages sat flush against the left menu. They now have the same breathing space as other pages, and the grid height fits the screen so the page no longer scrolls just to reach the bottom.

## v0.6.93 — Collapsible left menu, colour fixes and a bundled font
Released October 23, 2026.

No database migration and no new Google permission.

### Collapsible left menu

- **More room for the page.** The panel button beside the logo collapses the left menu to a narrow strip of icons, and the same button opens it again. Hover an icon, or move to it with the keyboard, and a tooltip shows the module name. The unread count on Work Hub stays visible on its icon.
- **Remembered in this browser.** The choice is saved in the browser you used, not on your account, so a second computer starts with the menu open.
- **Still readable by screen readers.** The names stay in the page for screen readers, the current page is announced, and Escape closes a tooltip.
- **Small screens keep the existing layout.** Under 820 px wide the menu behaves as before and the button is hidden.

### Colours

- **Light and Gray looks.** Panels that stayed dark in these looks (the signed-in card, template cards, Action Center filters and activity badges, the archive note, drop-downs) now follow the chosen look, and grey helper text is darker so it can be read.
- **FSD and Test Case creators** follow the look chosen in the app instead of the computer's light or dark setting. The document paper stays white.
- **Messages.** Confirmations are blue and errors are red, so a failure no longer looks like a success.
- **Default look.** Primary buttons such as **Add task** are a clearer blue with white text.
- **Document Hub history.** The Active and Archive tabs, Row and Tile switch and the page-size drop-down were white on the dark wallpaper looks. They now match the page.
- **Smallest text.** Labels and badges that were 8 to 10 px are now 11 px. The text inside Gantt bars stays at 10 px.

### Font

- **Inter is now bundled with the app** (Latin letters, weights 400 to 700, SIL Open Font License) and loaded from the app itself, with no outside font service. The app already named Inter but never loaded it, so computers without Inter installed fell back to their system font. Numbers line up in table columns. Characters outside Western European languages still use the system font.

## v0.6.92 — Trackers, and recipient suggestions in the email composer and Document Creation
Released October 23, 2026.

One database migration (schema v24, for Trackers) and no new Google permission.

### Trackers (new)

A new **Trackers** page for sheets you shape yourself, for the things that never fitted a fixed screen: site rollouts, permit lists, defect logs, client ticket lists.

**Needs database migration schema v24.** Apply it before using Trackers (see the [upgrade guide](docs/setup/upgrade.md#database-requirements)). Everything else works without it, and the Trackers page says so if it is missing.

- **Your own columns and rows.** Start from a template (Site rollout, POS installation & BIR permits, Defect & enhancement log, Client ticket tracker) or a blank tracker, then add, rename, move and delete columns. Column types: text, long text, number, date, checkbox, select, multi-select, person, link, and the protected and connected types below. A column's type cannot be changed after it is made. Limits: 100 columns, 5,000 rows per tracker, 200 trackers per account.
- **A fast grid.** Click or use the arrow keys to move, Enter or typing to edit, Tab to move right, Space to tick a checkbox, Delete to clear a cell, and a panel for each row. Long lists stay quick: only the rows on screen are drawn, and a tracker at the 5,000-row limit loaded, scrolled, searched and sorted smoothly in testing.
- **Filter, sort, group and views.** Filter by any column, sort, group, hide columns, then **Save as view** to keep it as a tab. Search looks across every shown column (never Secret columns). **Export CSV** downloads exactly what is on screen.
- **Link a row to a task, optionally.** Rows stand alone, and you can link any row to a task. Connected columns then fill themselves and are never typed in: **Task status**, **Task due date**, **Task owner**, **Sign-off status** (DocHub, including subtasks) and **Drive files** (including subtasks). Unlink and they go blank. A Git issue is a plain **Link** column.
- **Secret columns for access details.** Values are encrypted with the integration master key, masked on screen, never sent back with the rows, never in the CSV export and never in the row's history. **Reveal** shows a value for 30 seconds and is recorded (who, when, which column) in the row's history. If the record cannot be saved, nothing is shown. Each Secret column is revealable by editors or by Administrators only. Deleting a Secret column deletes its stored values.
- **Import a sheet.** Paste from Excel or Google Sheets, or choose a CSV file (up to 5 MB), then check what each column becomes: it guesses dates, numbers, yes/no, links and choice lists, flags password-like headings as Secret, and reports unreadable values instead of dropping them silently. Import into an existing tracker or create a new one.
- **Safe to share.** Changes save row by row. If two people edit the same row, the second is told and sees the current values instead of overwriting. Each row has a history of who changed what. A tracker can be made private (only you), archived (read-only, restorable) and, once archived, deleted permanently.
- **Access.** Trackers is a new module. Administrators receive it after signing in again; other people need it assigned under Users & Permissions → Module access (new Contributors have it by default). Viewers can open trackers but not change them, and cannot reveal secrets.

### Recipient suggestions


- **Suggestions while you type in To, Cc and Bcc**, like Gmail. Type part of a name or address and the matching people appear. Use the arrow keys with Enter or Tab, or click, to add one. The line stays plain text, so pasting a list still works, and typing in the middle of a line only replaces the person under the cursor.
- **Where the suggestions come from:** people you have emailed (read from your Gmail Sent folder, most emailed first), people who emailed you (from the emails saved in Work Hub), the email addresses on your clients, and your active teammates. Each suggestion says where it came from. Automatic senders such as no-reply addresses are left out, and so is anyone already on the email.
- **Ready as the composer opens.** The Sent folder is read in the background when the composer opens and kept for 10 minutes, so suggestions are quick. Someone you have just emailed from the tracker is available straight away.
- **Private to you.** The list is built from your own mailbox, kept only in server memory (never saved in the database), and never shown to anyone else. It is dropped when you disconnect Gmail.

- **Emails for signatories in Document Creation.** The **Name** field of each DRF signatory and each Sign Off signatory suggests people as you type (from the same sources, including your teammates and your own name). Choosing a suggestion fills in the name and the **Email (DocHub only)** field. If you type a full name that is exactly one known person and the email is still empty, the email is filled in when you leave the field, with a note to check it. If nobody matches, the email stays empty. If the same name has two different addresses, nothing is guessed: both are offered to choose from.
- **Safe with hand-typed emails.** An email you typed yourself is never replaced. An email that was filled in for a name is removed again if you change the name to someone else, so a signing request cannot go to the wrong person by accident. Enter only takes a suggestion you picked with the arrow keys.

### Notes

- Only the recent Sent folder is read (the latest 120 sent emails), plus the last 500 saved emails. People you emailed longer ago, or Google Contacts and the company directory, are not included.
- If Gmail cannot be reached, suggestions still come from saved emails, clients and teammates, and the Sent folder is tried again after two minutes.

## v0.6.91 — Replies copy everyone on the email
Released October 23, 2026.

No database change and no new Google permission.

### Changed

- **Reply by email now works like Reply all.** The sender gets the reply, and everyone else who was on the original email is added to Cc automatically. You no longer have to type them in. Your own address, including an alias the email was delivered to, is left out, and nobody is listed twice.
- **Remove them in one click.** The composer says how many people were copied and shows **Reply to sender only**. The Cc line stays editable.
- **A "Reply-To" address is honoured.** If the sender asked for replies to go elsewhere (a help desk address, for example), the reply goes there.
- **Replying to an email you wrote** goes to the people you sent it to, not back to you.
- **Works for emails already in Work Hub.** The recipients are read from Gmail when you click Reply, so earlier emails are covered too. If Gmail cannot be reached, the reply opens with the sender only and a short note asks you to add anyone else to Cc yourself.

### Notes

- Everyone who is copied sees your reply. Blind-copy recipients of the original are not visible to you, so they are not added.
- The limit of 25 recipients per email still applies. If an email has more people on it, the composer asks you to remove some before sending.

## v0.6.90 — Send document emails from the tracker
Released October 23, 2026.

No database change. Each person who wants to send approves one extra Google permission, once.

### Added

- **Send an email from the tracker, from your own Gmail.** The email goes out from your real address and appears in your Gmail Sent folder, like any email you send yourself. Open it from **Email** on a file saved to a task or subtask, **Email signed PDF** on a fully signed document, **Reply by email** on a Work Hub message, or **New email** in Work Hub.
- **Attach from Google Drive or your computer.** The Drive list shows the files the tracker saved to tasks and subtasks (signed DRF and Sign Off PDFs, saved email attachments, generated documents), with search and a client filter. Attachments can total 12 MB, which keeps the email under Gmail's 25 MB limit. Program files such as `.exe` are refused up front, as Gmail refuses them.
- **Linked to the task or subtask.** Every email must be linked to at least one task or subtask. A private copy is kept in Work Hub, marked **Sent**, and appears in the conversation thread. A short note (recipient, subject and file names, never the message) is added to the task's activity so the team can see that the email went out. Blind-copy recipients are left out of the note.
- **10 seconds to undo.** After you press Send, a bar shows a countdown with **Undo** and **Send now**. Undo reopens the email so you can correct it. Keep the page open during the countdown; the browser asks before you close the tab while an email is waiting.
- **Replies stay in the conversation.** Replying from Work Hub keeps the email in the same Gmail thread, with the recipient, subject and quoted message filled in.
- **No double sends.** Each email carries a one-time reference, so a double click, a retry after a dropped connection, or a slow network cannot send it twice. If Google cannot confirm that an email was sent, the tracker says so and asks you to check your Gmail Sent folder rather than sending it again.
- **Optional signature.** A signature you type in the composer is added to new emails on that browser. Gmail does not add your Gmail signature to emails sent through the API.

### Setup

1. In your Google Cloud project, open **Google Auth Platform → Data Access** and add the scope `https://www.googleapis.com/auth/gmail.send`. Google lists it as a *sensitive* scope (`gmail.readonly`, which Work Hub already uses, is *restricted*).
2. Each person who will send opens **Work Hub → My integration settings** and chooses **Allow sending email**, then approves sending on Google's page and leaves every box ticked. This is needed once. Plain reconnects keep the permission.
3. People who only read email are not asked for anything new.

### Notes

- Sending uses each person's own Gmail account. There is no shared mailbox.
- It is for document emails: plain text, with attachments. There are no drafts, no scheduled sending and no HTML formatting.
- If your Google app is still in **Testing**, Google expires each connection after 7 days and people must reconnect. Publishing the app removes that limit.
- Files can only be attached if the tracker saved them to a task. A signed document with no linked task is saved to its Client / Project folder and cannot be attached from the list.

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
