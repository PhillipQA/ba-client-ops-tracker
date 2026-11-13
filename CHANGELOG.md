# Changelog

**Current application release: v2.0**

From v2.0, each pull request merged into main is a build: v2.0 · B01, B02… The *Build number* workflow raises it after each merge ([src/shared/version.ts](src/shared/version.ts)). A new version (v2.1, v3.0) is set by hand in that file.

Changes are listed newest first. For installation, deployment and updates, use the [README](README.md). Older entries mention migration files, release notes, an upgrade guide and patch ZIPs that were removed in the Northflank cleanup below; they are still in the Git history.

## v2.0 — Seeds: source of truth, Before Seeds, time to Seeds
Released with pull request #110.

**No database migration.** Seeds needs one server setting: the Seeds application token from a SEEDS Admin, as the Northflank secret `SEEDS_API_TOKEN` (see [docs/setup/seeds.md](docs/setup/seeds.md)).

### Security review fixes
**No database change.**
- **Task files from Drive always download.** A file saved to a task folder (for example an email attachment that is a web page or an SVG picture) is now always sent as a download in a sandbox. Opened as a link, such a file could otherwise have run as the signed-in person. The app itself still opens these files as before.
- **AI BA Assistant limits per person:** 20 questions and 10 DRF drafts a minute. Normal use never reaches them; they stop a stuck page or script from running up the AI provider's bill.
- **Work Hub no longer stops on an inquiry without a source:** it shows *Other*.

### Code: large files split, shared helpers
**No change in how the app works, and no database change.**
- The largest files are split into parts named for their job: the tracker server routes (`server/trackers/`), the app's state (`src/app/state/`), the Work Hub message routes (`server/integrations/communications-*.ts`) and the main stylesheet (`src/styles/app/`). See [docs/architecture/REPOSITORY-STRUCTURE.md](docs/architecture/REPOSITORY-STRUCTURE.md).
- Helpers that had been copied between files now have one copy each.

### Seeds: real project fields, and completed projects
- The sync now reads Seeds' project record as Seeds actually sends it: `contractNumber`, the parent, `timeEntryRequirements` (`task`, `parent`, `product`, `remarks`) and `timeEntryDefaults`. A **Full sync** (Settings › Integrations › Seeds) fills in every linked project's contract number and time-entry rules.
- Seeds' "none" (`id: 0` on client or product) is no longer read as a product, so a required product is enforced.
- Time sent to Seeds carries the parent (client company), or Seeds' default parent when the project has no client here.
- **Projects completed in Seeds** stay on trackers (a tracker can still be on one; the picker marks it *Completed: no new tasks*), on Projects and on Tasks, and their existing work stays editable. They **take no new tasks or subtasks**: the server refuses new work in them (or moved into them), and tracker rows place new tasks in the tracker's open projects instead, or say so when there are none.
### Email: formatted signatures, like Gmail's
- The signature editor now has **fonts, sizes, bold/italic/underline, text colour, highlight, links and pictures** (a logo, up to 3 pictures of 200 KB each; wide ones are made smaller). Your existing plain signature is kept and can be formatted.
- The signature is shown **under the message as it will be sent**, with a tick box to leave it off one email. It is no longer typed into the message box.
- Emails with a signature are sent as formatted (HTML) email with a plain-text version; pictures travel inside the email, so they show in Gmail and Outlook without "download images".
- Signatures are cleaned on save and again on send: only formatting, links and embedded pictures are kept. **No database change.**

### Email: Gmail-style windows and drafts
- **New email** and **Reply** open in a window docked at the bottom right, like Gmail, instead of a full-screen dialog: you can keep working in the app while writing. Use **–** to minimize it to its title bar (click the bar to open it again), **⤢** to make it large in the middle of the screen, and **×** to discard it. Escape makes a large window normal and a normal one minimized.
- Up to **3 emails** can be open at once; opening another minimizes the rest.
- Every email is **saved as a draft** while you write (*Draft saved* shows at the bottom). Drafts come back minimized after a reload, a sign-out, or Google's *Allow sending* page. They are kept in this browser, per person; files attached from your computer are not kept in drafts (the draft says which to attach again), Drive files are.
- Sending or discarding an email deletes its draft; **Undo** after Send opens it again.

### Edit time before it goes to Seeds
- Time entries not yet in Seeds have an **edit** (pencil) button. It loads the entry into *Log time*: change the date, duration, subtask, Seeds task, Seeds product or remarks, then **Save changes** (or **Cancel**). The same rules as logging apply.
- Only the person who logged it or an Administrator can change it. Entries already in Seeds are changed in Seeds. Changing an entry that failed to send clears its error, so the next *Send to Seeds* tries it afresh.

### Notifications: *Read all* sticks, and no more endless refreshing
- Past 1,000 notifications per person, the oldest were re-made from their events on every check and trimmed again, so the workspace was re-saved constantly (the stuck *Refreshing…*). Each work event now becomes a notification once.
- *Read all*, *Mark read* and *Dismiss* were refused as out of date whenever that check had just saved, so notifications came back unread. They now save on top of the copy just written.

### Seeds: delta sync with `updatedSince`, weekly full sync
- **Delta sync every 10 minutes** (was a "quick" sync every 30): it asks Seeds only for projects created, changed or deleted since the last change it saw (`GET /projects?updatedSince=`, with 10 minutes of overlap), then reads members and tasks for just those projects. Most deltas are one request. It no longer reads /users, /parents or /statuses; a new parent is read by id.
- **Full sync once a week** (was daily) and whenever someone clicks *Full sync*: every list and every open project's members, plus the people directory and parent renames. If Seeds ever turns down `updatedSince`, that sync reads everything instead.
- A delta only replaces access on the projects it read; everyone's other Seeds access stays. Projects **deleted** in Seeds (deletion indicator) are closed here.
- Linked projects that nobody here is on any more now also follow Seeds: closed, completed or deleted there means closed here (before, they could stay open).
- Requests are paced for Seeds' **20 requests a minute** (about one every 3 seconds).
- Projects keep Seeds' **contract number, or its contract reference** when there is no number, and the project's **time-entry requirements and defaults**. Time sent to Seeds uses the project's default task and product when an entry has none, and is stopped with a clear reason when Seeds requires a product the project doesn't name.
- Members' **email and organizational role** come straight from the project members list.

### Seeds products on tasks, and the contract number on DRFs
- The sync reads Seeds' **product list** (`GET /products`, `core.products.read`): in every full sync, and in a delta only when a change names a product not known yet. Without the grant, the sync still works with no products.
- Seeds tasks can **require a product** (as can a Seeds project). Each top-level task under a Seeds project has a **Seeds product** picker, marked *required by Seeds* when it is. Time carries the product picked on the task, else the Seeds project's product, else Seeds' default for that task or project.
- **Log time has a Seeds product picker** (after *Seeds task*), listing the products from the last sync. It starts with the task's product, the Seeds project's, or Seeds' default; marked *required* where Seeds requires one, and an entry can't be saved without it then.
- **Seeds task, product and remarks are optional** unless Seeds requires them on the project (its time-entry requirements), or, for a product, on the Seeds task. Log time shows *(required)* only where Seeds requires it, and *Seeds task* has a *None* choice otherwise. Time without them still goes to Seeds (without a task, product or remarks). Work not under a Seeds project still takes no time once Seeds is on.
- Entries logged before they had a product are sent with the product chosen in Log time (and keep it). Time that still has none is **not sent**: *Send to Seeds* lists it with "Choose the Seeds product in Log time".
- A DRF opened for a task under a Seeds project fills an empty **Contract Number** with the project's Seeds contract number.

### AI Assistant: several clients, and projects per client
- The assistant's Client and Project fields are now one **Clients and projects** picker. Type to add a client; add as many as you need (up to 20).
- Each chosen client lists **its own projects** only. Leave *All projects* ticked to include all of them, or tick the projects you want. Each client is narrowed on its own.
- The assistant then answers from just those clients and projects: tasks, activities, history, trackers, time logs and new-task places. With nothing chosen it looks at all clients, as before.
- Your choice is kept for next time. Opening the assistant from a task or a client still focuses on that one, and conversations saved for one client or project are still there.
- A suggested task is placed under the client (and project) only when exactly one client is chosen.

### Follow Excel files kept in Google Drive
- The Sheet picker (new tracker from a Google Sheet, and Import → Link an existing Google Sheet) now lists Excel (.xlsx) files in your Drive too, marked *Excel file · read only*. A pasted link to an .xlsx opened in Google Sheets works as well.
- An Excel file that **hasn't changed in Drive** since the last good sync is no longer downloaded and read on every automatic sync (its Drive modified time is checked first). *Sync now* still reads it.
- An Excel file is followed **one-way and read only**: it is downloaded and read on every sync, and the tracker never writes to it. Its columns can't be edited in the tracker; change them in the Excel file. You can still make tasks and subtasks from its rows. Two-way, the Gantt chart tab and done marks in the file are not offered (a done mark shows as not reaching the file).
- The first time someone picks an Excel file, Google asks once more, for permission to read Drive files (`drive.readonly`). **Setup:** add `drive.readonly` to the OAuth consent screen's scopes in Google Cloud (see [docs/setup/google.md](docs/setup/google.md)). Files over 20 MB are refused.

### Link an existing Google Sheet to a tracker
- A tracker's **Import** window has a new **Link an existing Google Sheet** button (shown when the tracker isn't following a Sheet yet). Pick the Sheet and tab, choose the task name column and what each column becomes, then **Link and sync**: the tracker follows that tab from then on, the same as a tracker made from a Sheet.
- Rows the tracker already has are not doubled: a tracker row whose task name matches a Sheet row is linked to it and updated from the Sheet. Other Sheet rows are added; tracker rows with no match stay as they are.
- Stopping the sync now points to this button for linking a Sheet again.
### Task evidence in Google Drive
**No database migration.** Needs Google Drive connected in Settings › Integrations (as for Gmail attachments).
- New evidence (screenshots and files) is saved in the task's folder in the team Drive: Client / Project / Task / Subtask, next to the email attachments and signed documents. **Open** in the app works for everyone as before; a **Drive** link opens it in Google Drive for people with access to the team folder.
- **Tasks can have evidence too**, not only subtasks.
- Removing evidence moves its Drive copy to the Drive trash (restorable for 30 days).
- **Moving older files:** Settings › Integrations › Google Drive shows how many evidence files are still in the app's database, with **Move N files to Drive**. Files move in batches; each is removed from the database only after it is saved in Drive and its task points to it. Archived work is included.
- Without Drive connected, evidence is still saved in the database, as before.
### AI BA Assistant: four approve-first actions
Each is prepared as a card; nothing happens until you approve it. They are offered only to people who may do them (not Viewers).
- **Follow-up email:** "Remind the client about the printer specs" drafts an email for the task. **Open draft** opens it in the email window, as Reply all on the task's latest email when it has one. Nothing is sent until you press Send.
- **Notes to tasks:** paste meeting notes and get tasks and subtasks under one client and project, with assignees and due dates. Untick what you don't want, then **Approve & create**. Subtasks follow their task's assignee.
- **Update a tracker:** "Mark Makati T1 permits done and set go-live to Nov 20" shows each row's change as before → after. **Approve & update** changes those rows; a row someone changed since is left as it is and reported.
- **Log time:** "Log 2 hours today on Go Live – Makati T1" prepares the entry with its Seeds task and remarks, checked by the task's own time-log rules (a problem is shown and blocks approval). Sending it to Seeds stays on the task.

### Close a task together with its open subtasks
- Resolving or closing a task that still has open subtasks (Resolve button, status menu, board, or the task's edit window) no longer stops you. A window lists the open subtasks and asks you to type a word shown (for example *finish*) to confirm; then the task and those subtasks close together, with the same status.
- Subtasks already finished keep their own status and date. Cancelling leaves everything open.

### Tour follows a working day
- The tour now goes Action Center, Google Calendar, Work Hub, Gmail, Discord, GitLab/GitHub, Trackers, Document Creation, Reports, AI BA Assistant, then Settings (with account setup for Administrators last).
- Each step opens its page; the Work Hub steps show their own tab.
- Text is updated for tracker folders and layouts, voiding and removing DocHub documents, the assistant's approve-first actions, Seeds, and signing in with Google.
- The Seeds, add-task, profile and refresh steps are no longer part of the tour.

### Seeds decides who signs in
- Once Seeds is on, **every sign-in** (Google or password) needs the user's email to be an active employee in Seeds. Others are refused with a message saying so.
- Someone removed from Seeds is **signed out** after the next Seeds sync.
- **Administrators are always let in**, so the account can't be locked out. People in Seeds without a user here are still added by an Administrator.

### Sign in with Google
**No database migration, no new setting:** it uses the Google client already set for sending time to Seeds (`SEEDS_GOOGLE_CLIENT_ID`).

- The login page has **Continue with Google**. It signs in the user whose email (Users & Permissions) is that Google email; an email nobody is registered with is refused, and no user is created.
- Once Seeds is on, the email must also be an employee in Seeds.
- Password sign-in stays as it was, as the backup. Internal Admin is password only.

### Tracker folders
**Database update:** run [database/migrations/schema-v36-tracker-members.sql](database/migrations/schema-v36-tracker-members.sql) on the live database before deploying (it adds `tenant_trackers.members`). Until it runs, everything works except adding people to a tracker.

- **Every person has a folder** on the Trackers page, made from the account's people, so a new person has one from the start. Nothing to create.
- **A tracker shows in the folder of each of its users:** its creator, the people on its projects (from Seeds, or an Administrator's assignments), and anyone its creator or an Administrator adds under **Tracker details › Users**. It is the same tracker in each folder, not a copy.
- **My folder / Folders / All trackers:** the page opens on your folder; Folders lists everyone's (yours first) with how many trackers each holds; All trackers is the full list. Folders show only trackers you may open, so a private tracker stays in its creator's folder only.
- **Layouts:** trackers as **Tile**, **List** or **Table** (the previous list), and folders as **Tile** or **Row**. Your choice is remembered in this browser. Search, the client filter and Show archived apply in every view.

### Seeds time: type your own remarks
- Choosing a subtask on a time entry fills in the remarks as "subtask – task", and they can now be edited or replaced. Typed remarks are what Seeds receives; with a subtask and empty remarks, "subtask – task" is used.

### DocHub: void a request, remove a document
- **Void request:** a DRF or sign-off sent for signature but not fully signed can be voided from its details in the tracker. DocHub cancels the request, so signatories who have not signed can no longer sign it. The latest status is checked first, so a document signed in the meantime is never voided.
- **Remove from tracker:** takes a document off Document history and its task (a note is added to the task's activity). Fully signed documents are kept as the signing record; a request still out for signature has to be voided first. Nothing is deleted in DocHub.
- **Deleted in DocHub:** a document deleted directly in DocHub (DocHub answers 404) now shows as *Deleted in DocHub* instead of an error, is no longer checked in the background, and has a **Remove** button on its row.

### Type into report tables
- In a custom report, a table that comes from one tracker can be typed into: tap a cell in a column marked ✎, type, and press Enter. It saves to that row in the tracker.
- Works for text, long text, number and date columns, for people who can edit that tracker, and only when the query reads one tracker without JOIN, GROUP BY, DISTINCT, UNION or WITH. A column picked as `remarks` or `COALESCE(remarks, '') AS remarks` counts; a CASE or other worked-out value does not.

### Share a report as an image
- **Share as image** on every custom report: **Copy image** (paste into Gmail, Teams or Viber), **Download PNG**, or **Email with the image** (opens the app's email composer with the picture attached; needs Gmail connected in Work Hub).
- The picture is what you see now, drawn in your browser (cards, numbers, tables and charts, without the buttons); nothing is uploaded to make it.

### Data Explorer SQL, Metabase style
- **UNION ALL fixed:** ORDER BY and LIMIT after the last SELECT now sort and cut the whole result (they used to apply to the last SELECT only). SELECTs can be wrapped in parentheses.
- **New:** `UNION` (removes duplicates), `INTERSECT`, `EXCEPT`; `WITH` (common table expressions, with optional column names); queries inside `FROM`, `IN (SELECT …)`, `EXISTS (SELECT …)` and as a value.
- **Window functions:** `ROW_NUMBER()`, `RANK()`, `DENSE_RANK()`, `NTILE()`, `LAG()`, `LEAD()`, `FIRST_VALUE()`, `LAST_VALUE()`, and running or partition totals with `SUM/COUNT/AVG/MIN/MAX(…) OVER (PARTITION BY … ORDER BY …)`, also over grouped results (`SUM(COUNT(*)) OVER ()`).
- Still read-only, in the browser, over the tables the person may see. Queries inside another query cannot use the outer query's columns yet (use a JOIN or WITH).

### Job roles
- **Administrators see and change everything**, including every client, whatever per-person visibility says.
- **Settings › Roles:** job roles say which pages a person sees and which they can change. Starting set: Business Analyst, Project Manager, Product Owner, Developer, Quality Assurance, Support and Account Manager; each can be edited, and Administrators can add their own (for example, Business Owner). A role that changes nothing is read-only (it can still ask the AI BA Assistant).
- **Users & Permissions:** pick each person's job roles. People without a job role keep the modules picked for them, as before.
- **Seeds roles:** Seeds titles map to job roles (each role lists the titles Seeds uses, such as *Tester* or *Software Engineer*). Titles no role claims are shown in Settings › Integrations › Seeds instead of being guessed. Roles add up per client or project.
- Pages a role only reads hide their edit controls (new, edit, archive, link), while tasks stay editable from any page for roles that may change tasks. The server enforces the same: clients, projects, tasks, Action Center, requirements, trackers and Document Creation need a role that may change them.

### Workflow per account
- **Settings › Workflow** for each account's Administrator: task statuses, waiting-on options, visible task columns, and the names shown for priorities and client health. Internal Admin uses the same editor.
- **Renaming a status** now carries over to every task that uses it, archived ones included. A status still in use is removed by choosing where its tasks move. Statuses can be reordered.
- Archived work stays done: a status archived tasks use cannot be switched to not-done, and their tasks cannot move to an open status.
- Priority and health names change only what people see (for example *Urgent* → *P1*); sorting and colours stay.

### Who sees what (phase 1)
- **Per-person visibility** (Settings › Access), **off by default**. When on, each person sees only the clients and projects they are assigned to, with all the work under them: tasks, subtasks, activity, calendar entries, traceability matrices, trackers, DocHub documents, Drive files, emails linked to tasks and what the AI BA Assistant knows. Everything else never leaves the server.
- **Roles from assignments:** Business Analyst and Project Manager can work on their clients and projects; **Account Manager** sees theirs read-only and becomes a Viewer of Action Center, Reports and AI BA Assistant. Roles add up per project. **Administrators** set things up but see no client data unless they are assigned too (they always keep Settings, so visibility can be turned off again).
- **Assignments** can be entered in Settings › Access. Once a person connects their own Seeds, Seeds decides their access instead.
- A client someone is assigned to only through one project shows by name only. New clients and projects you create stay visible to you.
- Saves from a partial view never touch what you cannot see. Adding work to a client you cannot change, or moving work there, is refused with a message instead of being dropped.

### Send time to Seeds
- **Your time goes to Seeds.** A task's time list marks each entry *Not sent* or *In Seeds*. **Send to Seeds** on the task, or **Send my time** on the Seeds page, signs you in with Google (once an hour) and sends your entries. Seeds records them as you, so only your own entries are sent, and only with a Google sign-in for the same email as here.
- Each entry is sent once: a key made from its id means sending again never doubles it in Seeds. An entry Seeds turns down keeps Seeds' reason and can be sent again. An entry in Seeds is changed or removed in Seeds, not here.
- Entries carry the Seeds project, task, parent (client), the project's product (read from Seeds when it names one), minutes and remarks.
- Setup: `workforce.time_entries.create` on the Seeds token, and a Google OAuth client ID registered with SEEDS Admin in `SEEDS_GOOGLE_CLIENT_ID` ([docs/setup/seeds.md](docs/setup/seeds.md)).

### Seeds (phase 2)
- **Work Hub task pickers show Seeds work only.** Once Seeds is on, *Under task* and *Link to existing* leave out Before Seeds tasks; **Include Before Seeds tasks** under each picker brings them back, listed after the Seeds ones under their own heading.
- **Fixed: the notifications panel showed behind a tracker's column headers.** The top bar now sits above the page's sticky headers, so its panels open on top.
- **Trackers: type to find projects and Seeds tasks** when creating or picking a row's task, a subtask, or Create tasks for several rows. Seeds project, Project and Seeds task are type-to-search fields (name, contract number or client), with the tracker's own projects first. Picking from a type-to-search list inside the task picker no longer closes the picker.
- **Move to Seeds (Administrators).** A Before Seeds task's editor has **Move to Seeds…**, and each Before Seeds project on Projects has **Move to Seeds…** for its tasks (tick which; archived ones must be reopened first). The work moves, not copies: each task goes with its subtasks, comments, files, linked emails, time and tracker rows to the chosen Seeds project and its client. Subtasks take the Seeds task whose name matches; a single task can be given one. Trackers on the old project can get the Seeds project as their default. Meant for the move to Seeds; Before Seeds data is removed once everything is moved.
- **Fixed: unticking a checkbox wrote the word FALSE into the Google Sheet** instead of leaving an empty checkbox. Unticked boxes are now written so Google reads them as checkboxes. A cell already showing FALSE turns back into a box the next time it is ticked or unticked in the tracker.
- **Trackers show they are loading:** a spinner with *Loading trackers…* (or *Loading tracker…*) and grey placeholder rows, instead of an empty page while the list or a tracker loads.
- **Work Hub › Create a project task:** clients and projects are grouped *From Seeds* and *Before Seeds*; Project is now a type-to-search field (name or contract number, closed projects left out; with a Seeds client chosen, only its projects). Picking a Seeds project fills its client. The **Link this email** button is a normal button again.
- **Fixed: type-to-search lists could not be scrolled** (client, task and project pickers everywhere): scrolling the list re-measured it and jumped back to the top.
- **Fixed: Edit project on a Seeds project blanked the app.** The editor focused the Status list (a Seeds project's name is locked) and called a text-only method on it. Now it just focuses Status. If any screen fails to draw, the app shows the error with **Reload** instead of a blank page.
- **A tracker can have several projects.** In Tracker details (More › Rename, client and project) and New tracker, type part of a project's name or its contract number (SLSS #) to add it, like clients; each chip shows its contract number and ★ makes one the default. Picking a Seeds project adds its client. A Site rollout row goes to its task's project, else to the project whose contract number is in its **Contract number** column, else to the default project. Create tasks does the same per row.
- **Contract number column.** A Text column (an `SLSS #` column, say) can be set to *Fill it with the contract number of the row's project* in its column settings: each row with a task shows its project's Seeds contract number, and a row with no task yet uses the number typed there to choose its project. Numbers match without case, spaces or dashes.
- **Closed Seeds projects are hidden from project pickers.** A Seeds project whose status means it is over (closed, resolved, completed, cancelled, done, archived…, by name or through `/statuses` when the token may read it) is marked closed; it stays with its work but drops out of the Project lists for new work (task forms, Tasks and Action Center filters, Requirements, trackers, AI) and shows under **Archived** on Projects.
- **Quick and full syncs.** Every 30 minutes a quick sync reads the project list and then members and tasks only for projects that are new, created or updated in the last day, or already have someone from here; a full sync of every open project runs the first time, once a day, and on **Full sync**. The Seeds card says which ran and how many projects it checked.
- **Built on the Seeds Open API** ([reference](docs/seeds-api.md)). Seeds gives one application token per app, so the server holds it (`SEEDS_API_TOKEN`); nobody pastes a key. Read only; nothing is written to Seeds.
- **Everyone is matched to Seeds by email.** The projects Seeds lists a person on as a member decide what they see; their role on the project (or their Seeds job title) becomes their job role. Only projects someone here works on, with their clients, come in.
- **Seeds is the source of truth, and what came before is kept apart.** The first time Seeds is turned on, every existing client and project (with their tasks, subtasks, trackers and documents) moves to the **Before Seeds** folder: open to everyone, still editable, nothing deleted. Clients, Projects, **Tasks** and the **Action Center** task table get a **Folder** filter (From Seeds, Before Seeds, All); a task is in its project's folder (or its client's, when it has no project), and the task Client and Project pickers follow the folder. Seeds records are never matched to old ones by name, so nothing is merged or duplicated by guesswork; the close-match confirmations are gone.
- **Trackers bridge Before Seeds and Seeds.** A tracker keeps its Before Seeds client and its rows keep their tasks. In **Tracker details**, projects are grouped *From Seeds* / *Before Seeds*; picking a Seeds project links the tracker to Seeds and adds its client, keeping the old ones. Creating a task from a row (one or many) now asks **Where: Seeds or Before Seeds** (Seeds by default) with the Seeds project and an optional Seeds task; a row on a Before Seeds task switches to the new Seeds task, and the old task stays in Before Seeds. Its cells let go of the old task's subtasks, and on Site rollout trackers the steps are made again under the new task, so a row never points at two tasks. Subtasks made in a row go under its task. Timeline trackers on a Seeds project make their tasks under the Seeds client. Subtasks made from a tracker (step columns, timeline rows, a cell's **Create a new subtask**) get a **Seeds task**: the one picked in the cell, else the Seeds task with the same name (a *GO LIVE* step → GO LIVE), else they follow their task's.
- **Time logs follow Seeds.** Once Seeds is on, time is logged **on the task**, not on subtasks. Each entry is like the Seeds form: **Task date**, **Duration** in hrs + mins (15-minute steps), an optional **Subtask**, **Seeds task** and **Remarks** (required, up to 120 characters). Choosing a subtask makes the remarks *subtask – task* (for example *Go Live – Makati T1*, no date), so same-named steps of different sites stay apart in Seeds, and its Seeds task the default (else the task's). Without a subtask, the remarks are typed. A task needs a Seeds task tag (on itself or the chosen subtask) to take time. Log as many entries as needed, on any dates; a subtask lists the time logged for it on its task. While Seeds is off, time logs work as before.
- **A Seeds parent is a client here** (for example *Think Library, Inc.*); a Seeds project (named after a store or a title) is a project.
- **Seeds tasks are subtask-level** (Go Live, POS Reset, Meetings…): nothing is created from them. Tasks and subtasks are your own, named your way; under a Seeds project each gets a **Seeds task** dropdown with that project's Seeds tasks (a subtask without one follows its parent), ready for sending time to Seeds later. When Seeds moves a project to another parent, its tasks follow.
- An Administrator turns Seeds on in **Settings › Integrations › Seeds**. It syncs straight away and every 30 minutes; anyone can choose **Sync now**. The card shows who Seeds found, who it did not (check their email), Seeds roles no job role claims yet, and the field names Seeds sent.
- **Seeds page** in the menu, replacing Clients, Projects and Tasks: tabs for Clients, Projects, Tasks and **Sync**.
- Seeds parents and projects (with contract numbers and their client) are kept up to date by Seeds id; renames follow.
- People Seeds does not list keep their hand-entered assignments (if any).
- If Seeds cannot be reached, the last synced access stays in force and the Seeds page says so.
- Names that come from Seeds are read-only here, and Seeds-linked clients, projects and tasks cannot be deleted here.

## v1.5.1 — Reports, Data explorer, project timelines, linked emails, and a security pass
Released November 5, 2026.

**No database migration.** An existing Northflank database keeps everything it has. A new database is set up with [database/schema.sql](database/schema.sql) (see *Northflank only* below).

### Security and reliability (red-team pass)
- **Signing out waits for your changes.** Edits still being saved finish first; if they cannot be saved, you are asked before they are lost. Before, signing out straight after an edit could drop it.
- **Nothing left behind at a shared computer.** Signing out removes this browser's copy of the workspace and your AI BA Assistant conversations, so the next person cannot read them from the browser's storage. Unsaved edits kept after a save conflict stay, because they are the only copy.
- **Linking an email to a task** can no longer lose a link when two are made at once, and old Discord captures (hidden from every browser) cannot be linked.
- **Fewer Save conflict boxes.** When someone else saves at the same moment, your change is merged onto theirs and saved again; the box appears only when you both changed the same field.
- **Pinned dependencies.** Packages that were installed as "latest" now have fixed versions, so a reinstall cannot jump to a new major version unnoticed.
- **Tests that never ran now run.** The GitHub and Work Hub screen tests failed before their first test (stylesheets and JSX), and two theme tests still expected per-client themes to change the look. The full suite (618 tests) now passes and blocks a merge when it does not; each failing test is shown with its error.

### Work Hub and email
- **Link an email to an existing task or subtask** (not only create one), see what it is linked to, and unlink it. If the work is on a tracker you can open, you are told which one.
- **Reply all from a task.** *Email signed PDF* (DocHub) and *Email* on a task's Drive files answer the task's linked email, to everyone on it and in the same Gmail conversation, with the file attached. Without a linked email they start a new email as before.
- **Unread count** on Work Hub in the menu.
- Fixed: opening a new email could stay on *Loading…* until Work Hub was refreshed.

### Document Creation
- **The task's email beside the DRF.** Panel 2 shows the linked email: choose the client, then its task or subtask (DocHub signature preparation follows the same choice). The open email sits in a dock at the bottom of the window that stays in view while you scroll to the hardware details.
- **Search the Document history Archive** by title, client, task, signer or file.

### Reports and Data explorer
- **Reports**: dashboards built from widgets (charts, tables, numbers, timelines), kept in folders, shared with the account, started from templates.
- **Data explorer**: read-only SQL over your data (tasks, time, clients, projects, activity, trackers, Work Hub messages) with a query builder, saved queries and templates, table parameters, and UNION ALL.
- **Queries on reports follow the report's filters**: client, project, person and dates fill the matching parameters (including `_id` and a date column's `_from` / `_to`), and adding a query to a report no longer pins the values you tried it with.
- Fixed: report errors showing behind the dialog, a brief database hiccup locking the Reports page, and the Data explorer tab disappearing after a profile or theme change.

### Trackers
- **Project timeline** trackers with a Gantt view: phases and rows become tasks and subtasks, dates and done stay in step both ways, bars can be dragged, rows can be highlighted.
- **The Gantt chart in the synced Google Sheet**, editable by clients, with the tracker following their edits; Sheets can be created from a tracker inside the client's Drive folder.
- **Tracker templates**, site rollout steps as tasks, ticking a row closes its subtask, and the AI BA Assistant can read trackers.
- Fixes for Sheet dropdowns and checkboxes, the timeline's size and resizing, and the task picker's client.

### Getting started
- **Guided tour** at first sign-in (and from **Tour** in the top bar): what Administrators set up first (integrations, templates, AI agents, users), connecting your own Gmail and calendar, and where daily work happens.

### Northflank only, one database schema

**No database change for an existing installation.** The live database keeps everything it has; nothing needs to be run.

- **One schema file.** [database/schema.sql](database/schema.sql) sets up a new, empty PostgreSQL database at schema version 35 in one step, as the app's own database user. It replaces `database/setup.sql` (which needed Supabase) and the 35 numbered migrations. It matches what the live Northflank database has, without the Supabase-only parts (row-level security policies, Supabase roles and their grants, the unused Supabase Auth helper and the pgcrypto extension). The starting BXI-Core account now includes Data explorer.
- **Supabase removed.** The app connects only through `DATABASE_URL`. `DATABASE_PROVIDER`, `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are no longer read, and the `@supabase/supabase-js` package is gone. In the code the database client is now called `db`. Database error messages point to `database/schema.sql` instead of old migration files.
- **Removed:** the patch ZIP updater (`npm run patch*`, `payload/`), the Supabase-to-Northflank move scripts and guide, the release-notes archive (`docs/releases/`) and the upgrade guide. Platform settings no longer shows patch commands.
- **README rewritten** with quick installation and Northflank deployment steps. Google Cloud setup (APIs and scopes) is now in [docs/setup/google.md](docs/setup/google.md).

## v1.5.0 — Subtasks from emails
Released October 27, 2026.

**No database migration and no new setting.**

- **New task or subtask.** In Work Hub, the form under a message now has **New task** and **Subtask of a task**. For a subtask, type a task name in **Under task**: open, active tasks are listed with their client and project. The subtask takes that task's client and project and goes last in its list of subtasks.
- Closed and archived tasks are not offered (reopen them first), and a task cannot have two subtasks with the same name.
- As before, only the title and summary you write are shared; the email itself stays private, and the subtask is listed with the message's tasks for saving attachments to Drive.

## v1.4.0 — @mentions in emails
Released October 27, 2026.

**No database migration and no new setting.**

- **Mention someone.** In Work Hub's New email, type **@** and a few letters of a name in the message. The same suggestions as the To line appear (people you have emailed, clients, teammates). Choosing one writes **@Name** in the message and adds them to **To**, unless they are already in To, Cc or Bcc.
- **A blue link where they read it.** An email with mentions is sent as HTML with a plain-text copy: in Gmail, Outlook and Apple Mail each mention shows as a blue link to the person's address, and mail apps that only read plain text show the same words without the link. Emails without mentions are sent exactly as before.
- Deleting a mention from the message stops it being a link; the person stays in To until you remove them.

## v1.3.2 — Fix: Allow editing button and the changed-in-the-Sheet window
Released October 26, 2026.

**No database migration and no new setting.**

- **Allow editing with my Google** now appears when two-way needs your permission. The screen was not receiving the server's signal for it, so only a red message showed.
- The **Changed in the Google Sheet** window now opens when a cell you edit was changed in the Sheet since the last sync, instead of a red message.

## v1.3.1 — Two-way edits use your own Google account
Released October 26, 2026.

**No database migration and no new setting.**

- **Your account, your access.** In a two-way tracker, a change to a green column is written to the Google Sheet with the Google account of the person making it, so the Sheet's own sharing decides: someone who can edit the Sheet can edit it here, someone who can only view it gets a clear message naming their account, and nobody borrows the access of the person who connected it. Rows added in the tracker are added to the Sheet the same way.
- **Allow it from the tracker.** Sharing a Sheet with someone is not enough on its own: Google also asks each person once to let the app make changes for them. When that is missing, the tracker says so with **Allow editing with my Google**. Turning on two-way works the same way, and switches on by itself after the person allows it.
- **Done marks** are written with the account of the person who completes the task when it may edit Sheets, and otherwise with the account that connected the Sheet, as before.
- Reading the Sheet (syncing) still uses the account that connected it, so everyone who can open the tracker sees the same rows.

## v1.3.0 — Two-way sync with Google Sheets
Released October 26, 2026.

**No database migration.** Needs the Google Sheets editing scope added in v1.1.0.

- **Turn on two-way.** A tracker that follows a Google Sheet has a **Turn on two-way** button in its Sheet bar. Once on, the bar reads "Sheet ⇄ tracker (two-way)" and the green columns can be edited in the tracker. Turning it off makes the Sheet read-only again.
- **Edits go to the Sheet.** Changing a green cell writes it to the same cell in the Sheet first, then saves it here. Text and choices are written exactly as shown; numbers, dates and Yes/No are entered so Google reads them as numbers, dates and checkboxes, and a date keeps the cell's own date format. Columns that are only in the tracker never touch the Sheet.
- **Changed in both places.** If someone changed that cell in the Sheet since the last sync, nothing is written. A window shows the Sheet's value and yours: **Keep mine (update the Sheet)** or **Use the Sheet's**.
- **New rows.** A row added in the tracker is added at the bottom of the Sheet tab once it has a name in the key column (for example the Branch #), since a nameless row in the Sheet belongs to the task above it. Rows imported or pasted with a name go in straight away.
- **Deleting** a row in the tracker leaves the Sheet row alone; the next sync brings it back unless it is removed in the Sheet too.
- Writing uses the Google account that connected the Sheet. If it has not allowed editing Google Sheets, edits to green columns are refused with a banner offering **Allow editing with my Google**.

## v1.2.0 — Archive closed tasks, and reopen them
Released October 26, 2026.

**No database migration and no new setting.**

- **A task closes only when its subtasks are done.** Closing or resolving a task with any open subtask is refused, with the number of open subtasks. This was already checked in the task list; it is now also enforced when the workspace is saved, so Work Hub, the board, edits and any other route follow the same rule.
- **Archive.** A closed or resolved task whose subtasks are all closed gets an **Archive** button in Tasks. Archiving puts it away with its subtasks: it no longer shows in Tasks (table or board) or on project pages. The button explains what is still missing when a task cannot be archived yet.
- **Archived view.** Tasks has an **Active / Archived** switch. **Archived** lists archived tasks with their subtasks, read-only.
- **Reopen.** **Reopen** on an archived task brings it back to Tasks with an open status, ready to work on again. Until it is reopened, an archived task and its subtasks cannot be edited, deleted, or given new subtasks.

## v1.1.0 — Rows marked done when their tasks are done, in the tracker and in the Sheet
Released October 26, 2026.

**Database migration schema v28 (optional) and one more Google scope for writing to Sheets.** See the upgrade guide.

- **Done when its tasks are done.** Edit a Checkbox or Choice column and tick **When the linked tasks are done**. When every task and subtask linked to a row (the row's own task, or tasks linked to the row or its cells) is completed, the column is ticked, or set to the option you chose. It works wherever the task is completed: the task list, Tasks, the Action Center or Work Hub. One column per tracker.
- **Reopened goes back.** If one of those tasks is reopened, the box is unticked, or the choice goes back to the option you picked (or empty). A value someone set by hand, such as "Blocked", is left alone.
- **Written to the Google Sheet.** When that column comes from the connected Sheet, the change is written to the same cell in the Sheet, in the style the Sheet already uses (Yes/No, TRUE/FALSE, x…). The row is found the way a sync finds it, by its task name and order, so sorting the Sheet is safe.
- **The Sheet wins a disagreement.** If someone changed that cell in the Sheet since the last sync, it is not overwritten. The row says why, and a banner offers **Write them now** (sync, then overwrite) or **Dismiss**. The same banner appears when Google refuses the write.
- **Permission to edit Sheets.** Writing uses the Google account that connected the Sheet, which now needs to allow editing Google Sheets once. Until it has, the tracker says so and offers **Allow editing with my Google**, which also switches the connection to your account.
- Each automatic change appears in the row's history, with the task that caused it.
- **Every dropdown choice comes over from the Sheet.** A Choice column connected to a Sheet column now gets all the choices of that column's dropdown on each sync (in the Sheet's order), including ones no row uses yet, such as "Pending". Dropdowns that read their choices from a range work too. Options only the tracker has are kept.

## v1.0.4 — Back and Forward work, every page has its own address
Released October 24, 2026.

**No database migration and no new setting.**

- **Back stays in the app.** The browser's Back button used to leave the tracker, because changing pages never told the browser. Every page now has its own address (`/tasks`, `/work-hub`, `/trackers`…), so Back and Forward move between the pages you visited.
- **Trackers, clients and projects too.** An open tracker is `/trackers/<id>`, a client is `/clients/<id>` and a project is `/projects/<id>`. Back from a tracker returns to the tracker list, and the tracker's own Back button does the same.
- **Refresh keeps your place**, and any page or tracker can be bookmarked or sent as a link. If you are signed out, the link opens after you sign in.
- **Open in a new tab.** Ctrl/⌘-click or middle-click a sidebar item or a tracker name to open it in a new tab.
- **Tab titles name the page** (for example "Trackers · BA Client Ops Tracker"), so the history list under a long-press on Back tells pages apart.
- Opening a page you cannot use still goes to your first allowed page, without leaving a history entry that Back would bounce off.

## v1.0.3 — A simpler review of new rows
Released October 24, 2026.

**No database migration and no new setting.**

- **Tasks with their subtasks under them.** The review of new rows (from a connected Sheet or an upload) now lists each task with its subtasks indented beneath it, instead of a flat list with a "Becomes" column. Rows a sync adds under a task that already exists appear under that task's name.
- **No more tick-then-choose.** Every row has its own menu: **Task**, **Subtask of “the task above”**, **Subtask of another task…** (new tasks in the list or any open task), **Keep as a row**, or **Decide later**. Untick a task to keep it and its subtasks as plain rows; tick a subtask to bring its task back.
- **Settings first.** Client, Project (with **+ New project…** in the same list), **Task name from** and **Subtask name from** sit at the top, before the rows.
- **Uploads group like a Sheet.** Imported files open in the review already decided: a row with a name in the first column becomes a task, and the rows below it with that cell blank become its subtasks.
- **Less used options under More options:** changing several rows at once by a rule (now also "subtasks of the task above"), and giving every new task a subtask per column.
- When a row stops being a task, the rows under it move to the task above, instead of losing their choice.

## v1.0.2 — Every Sheet row comes in, grouped into tasks and subtasks
Released October 24, 2026.

**No database migration and no new setting.**

- **Every row comes in.** Before, a tracker connected to a Google Sheet matched rows by a key column and left out rows whose key was blank or repeated, so choosing a column such as Client could bring in one row per client. Now every non-empty row comes into the tracker.
- **Task name column.** When you connect, choose the **task name column** (the first column by default). A row with a name there is a task, and the same name may appear on several rows; each is its own task. A row with that cell blank belongs to the task above it. The dialog shows how the rows group, for example "3 rows have a name and become tasks. 4 rows with no name belong to the task above."
- **The review is filled in for you.** New rows from the Sheet open in the review already decided: rows with a name become **new tasks**, and the rows under them become **subtasks** of their task (a task created in the same review, or the task that row already has from an earlier sync). Change anything before you click Create. **Subtask title comes from** picks the column for subtask names (Ticket Title, for example); **Task title comes from** is the same as before.
- **How rows are recognised on later syncs.** By name and order: the 2nd "EGG" row, the 1st row under it. Adding, removing or sorting other rows is safe; inserting another row with the same name above an existing one shifts the later rows with that name.
- Trackers already connected keep working: rows they already have are matched as before, and the rows that were left out come in on the next sync, ready to review.

## v1.0.1 — Clearer Google Sheet errors
Released October 24, 2026.

**No database migration and no new setting.**

- **Excel files get their own message.** Connecting a tracker to a link that is an Excel file kept in Google Drive (not a Google Sheet) used to say the Sheet cannot be opened. It now names the file and says to open it in Google Drive and choose **File → Save as Google Sheets**, then use the new Sheet's link.
- **A switched-off API says so.** If the Google Sheets API or Google Drive API is turned off in the Google Cloud project used for Gmail, the message says an admin needs to enable it.
- A Google Sheet that is not shared with you still says it cannot be opened.

## v1.0.0 — The code, reorganised
Released October 24, 2026.

**No database migration and no new setting.** Nothing changes for users: every page looks and works as in v0.9.0. This release makes the code easier to read and change. Details in the release notes.

- **Browser code by feature.** `src/features/<area>` holds each part of the app (trackers, email, work hub, documents, tasks and so on), `src/app` the shell and its state, `src/shared` what several features use, `src/styles` the global styles.
- **Smaller main files.** `App.tsx` went from about 2,000 lines to about 300: its state lives in one hook and each screen is its own component. `server/index.ts` went from about 2,500 lines to about 140: shared server code is in `server/core` and each group of routes has its own module.
- **One UI kit and one way to call the server.** Dialogs, popovers, notices and type-to-search fields come from `src/shared/ui`; API calls go through `src/shared/http.ts`.
- **Formatting and lint.** The code is formatted with Biome (`npm run format`); CI fails on formatting or lint errors and lists warnings on each run. CI also shows the full test suite's totals.
- **Cleanup.** Dead code the linter found was removed, including an old Discord capture path that was no longer used.

## v0.9.0 — Trackers that follow a Google Sheet, and reviewing new rows
Released October 24, 2026.

**Database migration:** apply schema v27. **Google:** enable the Google Sheets API and Google Drive API, and add the Sheets and Drive metadata read-only permissions, in the Google Cloud project used for Gmail (steps in the upgrade guide).

- **New tracker from a Google Sheet.** In Trackers, click **From Google Sheet**. Search the Sheets you can open (your own, those shared with you, and shared drives) or paste a link, choose the tab, check what each column becomes, and choose the **key column** that names each row, such as a branch number. Each person allows Google Sheets once; the tracker can read Sheets but never changes them.
- **It keeps up with the Sheet (Sheet → tracker).** Click **Sync now**, or leave the tracker open: it syncs every few minutes. New rows come in, changed cells update, and a row removed from the Sheet is kept in the tracker, crossed out, rather than deleted. Rows are matched by the key column, so sorting or inserting rows in the Sheet is safe. Columns from the Sheet have green headers and are changed in the Sheet; your own columns, tasks, subtasks and Calculated columns stay editable and are never overwritten.
- **Ready for two-way.** Each row keeps its Sheet key and the values from the last sync, and each connection has a sync mode. Two-way editing is not switched on yet.
- **Who it syncs as.** The tracker reads the Sheet with the access of the person who connected it. If they lose access, the bar says so and anyone who can open the Sheet can click **Reconnect with my Google**. **More → Stop syncing with the Sheet** keeps every row and makes the columns editable.
- **Review new rows.** New rows from the Sheet, and the rows of every import, open in a review. Tick rows by hand or by a rule (for example *Type is Rollout*), then make them **new tasks** (for one of the tracker's clients, in an existing or a **new project**), **subtasks of an existing task**, **subtasks of a new task in the same list**, or **plain rows**. You can also give every new task a subtask for each chosen column (DRF, Go-Live…), which then shows its status in that cell. A summary such as "Creates 2 tasks, 5 subtasks, 1 new project" shows before anything is created. Rows you skip stay in the list for later.

## v0.8.0 — Email signatures and templates
Released October 24, 2026.

**Database migration:** apply schema v26 for signatures and templates. Until then, email works as before. No new Google permission.

- **Your signature, everywhere.** The signature in New email is now saved to your account, so it follows you to any browser or computer, and each person has their own. A signature you had typed before is moved to your account the first time you open New email. It is added under the message of each new email and stays plain text.
- **Email templates.** Ready-made subjects and messages for the emails you send to clients and teammates. In New email, type in **Template** to pick one: the subject and message fill in, your signature stays underneath, and you can still edit before sending.
- **Create, view, edit and delete templates** with **Manage templates** in New email or **Email templates** in Work Hub. **Save as template** turns the email you are writing into a template.
- **Shared or only you.** A template is shared with everyone on the account unless you choose **Only me**. Anyone who can send email can edit or delete a shared template; only its creator can make it private again. Viewers can use templates but not change them.
- **Type-to-search task fields.** The **Task or subtask** lists in New email, Save to Drive and DocHub are now fields you type into, like the client field: subtasks sit under their task, the client and project show beside each task, and only open work is listed.

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

No new database migration and no new Google permission. Subtask cells use the task links table from schema v25 (v0.6.96); apply it if you have not.

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

**Optional database migration:** apply schema v25 to use task links. Everything else in this release works without it. No new Google permission.

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

**Needs database migration schema v24.** Apply it before using Trackers (see the upgrade guide). Everything else works without it, and the Trackers page says so if it is missing.

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

**Database migration required:** apply schema v23 before connecting Google Drive. It runs on Supabase and on plain PostgreSQL (Northflank).

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

**Database:** no new migration. Full notes.

## v0.6.80 — Sign Off Document
Released October 11, 2026.

- Rename the module to Sign Off Document.
- Switch between Production Deployment Form and the supplied Go Live Sign Off Form.
- Edit retained narrative sections and add signatories beyond the initial two per side.
- Keep separate drafts and attachments while switching forms.

**Database:** schema v21 is needed for optional custom Go Live template management. Built-in generation uses the existing table. Full notes.

## v0.6.79 — FSD missing-input guidance
Released October 11, 2026.

- Name missing information and unavailable/failed sources before generation.
- Keep failed uploads visible so users can replace or retry them.
- Show contributing, partially used, skipped, irrelevant and excluded sources.
- Generate Anyway uses verified available content and retains TBD placeholders for unavailable information.

**Database:** no new migration. Full notes.

## v0.6.78 — Work Hub login and manual sync
Merged October 9, 2026.

- Sync connected integrations once at sign-in.
- Refresh now syncs all connected integrations; individual Sync buttons refresh one source.
- Remove timed/focus-driven Work Hub sync and automatic continuation.
- Preserve saved per-user pages until the relevant source is refreshed.

**Database:** no new migration for the sync change. Full notes. This supersedes the Work Hub polling described in v0.6.76/v0.6.77.

## Earlier updates

| Version | Main change | Database action |
| --- | --- | --- |
| v0.6.77 | Active-view refresh and reduced background reads | No new migration |
| v0.6.76 | GitHub / GitLab provider selection | Schema v20 for GitLab; v19 if GitHub is not installed |
| v0.6.75 | Personal GitHub Work Hub integration | Schema v19 |
| v0.6.74 | FSD custom features and supporting screenshots | No new migration |
| v0.6.73 | FSD readiness checklist and Generate Anyway | No new migration |
| v0.6.72 | DocHub native signatory reminders | No new migration |

The release archive contains the older version notes and verification reports. SMTP reminder delivery introduced in v0.6.70 was superseded by DocHub-native reminders in v0.6.72; SMTP remains applicable to password recovery.
