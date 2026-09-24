# BA Client Ops Tracker

**Current release: v0.6.34**

BA Client Ops Tracker is a multi-tenant Business Analyst and client-operations workspace for managing clients, shared projects, tasks and subtasks, follow-ups, inquiries, activities, communications, evidence, reports, AI-assisted BA workflows, and document creation.

The application is built with **React, TypeScript, Vite, Express, Discord.js, Supabase, local OCR, and tenant-configured AI integrations**.

---

## Current release — v0.6.34

Login rate-limit hotfix. Failed-login counters are now isolated by **client IP + Account + User**, so unrelated users behind the same office/home public IP do not consume one another's five-attempt allowance. Only actual credential rejections (`401`) count; successful logins, aborted/network requests, validation failures, and server/configuration errors do not. The five-failed-attempt / 15-minute protection remains in place. No database migration, new dependency, or environment change is required. See `UPGRADE-v0.6.34.md`.

## Previous release — v0.6.33

DocHub signing preparation for DRF and Sign-Off forms, using a separate API key managed by each account's Administrator. Link a generated document to an existing Task/Subtask; signing changes appear in its comments and signature completion creates an in-app notification. Documents remain unsent for manual signature-field placement and review in DocHub. Task completion stays manual.

Run **`supabase/schema-v10-dochub.sql`** before enabling the integration. Setup, upgrade commands, draft behavior, webhook configuration and verification limits are in **[UPGRADE-v0.6.33.md](UPGRADE-v0.6.33.md)**. No new npm dependency. Full keys stay encrypted in the server database; no global DocHub key is needed.

## Previous release — v0.6.32

Document Creation now displays consistent processing feedback for DRF, FSD, Test Case, and Sign Off workflows: a spinner, progress stages, long-running guidance, success/error states, and safe retry actions. No database migration, new npm dependency, or environment change is required. See `UPGRADE-v0.6.32.md`.

## Previous release — v0.6.30

The login card now uses the password-recovery card's compact dimensions.

- Shared 470px maximum card width and 28px padding (20px on small screens).
- Matching 42px input/button heights, 13px form spacing, and 22px card corners.
- Height remains content-driven; the card shrinks to fit narrow screens and login options can wrap.
- The existing login colors, desktop illustration, authentication, and v0.6.29 blank-field behavior are retained.

No database migration, new npm dependency, or environment change is required. See `UPGRADE-v0.6.30.md`.

## Previous release — v0.6.29

The login screen no longer pre-fills the Account and User fields with built-in values.

- New and non-remembered login sessions open with both fields blank.
- **Remember me** continues to restore the user's own saved Account and User values.
- No database migration, dependency, or environment change is required.

## Previous release — v0.6.28

Subtasks now inherit the assignee of their main task while still supporting intentional per-subtask ownership.

- A new subtask always starts with the main task's current assignee.
- Reassigning or unassigning a main task updates subtasks that still follow it.
- Editing a subtask and selecting another user creates a persistent override.
- **Same as main task** restores inheritance after an override.
- Existing matching assignments are treated as inherited; existing differing assignments remain overrides.
- Server-side normalization keeps the rule consistent for older browser sessions.

No database migration, new npm dependency, or environment change is required. See `UPGRADE-v0.6.28.md`.

## Previous release — v0.6.27

Google Calendar now uses account-level OAuth credentials and separate, private user connections.

- Internal Admin enables Calendar for each tenant (disabled by default).
- Account administrators upload the Google OAuth Web application JSON in Settings.
- Users connect/disconnect their own Google account and select up to 10 calendars in Action Center → My Google Calendar.
- Today and This Week (Sunday–Saturday) show read-only schedules, with recurring occurrences, all-day/multi-day events, and browser-local time zones.
- Google credentials and user tokens are encrypted in Supabase, outside shared workspace data. Google schedules are not sent to AI or added to shared planner copies.
- Existing activities and v0.6.26 save fixes are retained. The old browser-only Calendar importer is removed.

**Apply the new `supabase/schema-v9-google-calendar.sql` migration.** No new npm dependency or Google credential environment variable is required. See `UPGRADE-v0.6.27.md` for setup and validation limits.

## Previous release — v0.6.26

v0.6.26 fixes Task and Subtask edits appearing to save in Action Center but disappearing after refresh.

- Ordinary workspace saves preserve server-managed Task configuration, even when an older workspace receives a newly displayed Start Date column.
- Task and Subtask editors wait for the server to accept the change before closing. On rejection, the editor stays open and shows the reason.
- No database migration, new dependency, or environment change is required.

## Previous release — v0.6.25

v0.6.25 adds multi-user views to the Action Center for shared tenant work.

### Action Center visibility highlights

- Active Administrators and Contributors can switch Action Center work views between **My Action Center**, **View all users**, and a selected user.
- “My” shows Tasks/Subtasks assigned to the signed-in user. Selecting another user shows only work assigned to that user.
- “View all users” shows open assigned and unassigned work across every client in the tenant.
- Follow-up tiles, Action Center rows, and the dashboard workload metrics all follow the selected view.
- Team rows show the assignee. Contributors can view other users’ assigned work without opening its edit controls; Administrators retain edit access.
- Viewers do not receive the cross-user selector and remain excluded from work reporting.
- Calendar and tracker schedule entries remain shared account-wide because those records do not have an individual owner.

No new required environment variable, npm dependency, or Supabase migration is required for v0.6.25.

---

## Previous release — v0.6.24

v0.6.24 added the Notifications & Escalation Center, per-user alert controls, and user comment trails.

---

## Previous release — v0.6.23

v0.6.23 added automatic open-Subtask follow-up rollover with permanent System comments and activity history.

---

## Previous release — v0.6.22

v0.6.22 made Task and Subtask Start Date clearly visible in create, edit, and table views.

---

## Previous release — v0.6.20

v0.6.20 adds **Document Creation → Test Case Creation (Basic Mode)**.

The Test Case Creator can combine requirement sources, apply reusable QA skills, generate an AI Test Coverage Map, create traceable and editable test cases, run an AI Coverage Review, and export the reviewed suite to **XLSX**.

### Test Case Creator highlights

- Combine up to **20 requirement sources**.
- Supported source types include BRD, FSD, User Stories, Acceptance Criteria, Change Requests, meeting notes, supporting documents, pasted/chat text, and screenshots/images.
- Supported readable file formats: **PDF, DOCX, TXT, MD, CSV, JSON, PNG, JPG/JPEG, WEBP, BMP, and TIFF**.
- Uses the AI provider already configured for the current tenant/account.
- Built-in reusable skills:
  - Functional Testing
  - UAT Testing
  - Regression Testing
  - Negative & Edge Cases
  - UI/UX Validation
  - API & Integration Testing
  - Mobile Testing
  - End-to-End Testing
- Users can create reusable custom testing skills.
- AI first generates a **Test Coverage Map** before detailed test cases are created.
- Coverage titles and planned scenarios can be reviewed and edited before generation.
- Generated test cases include:
  - TC ID
  - Module
  - Requirement Reference
  - Scenario
  - Preconditions
  - Steps
  - Expected Result
  - Priority
  - Type
  - Test Data
  - Platform
  - Automation Candidate
  - Remarks
- Test rows can be edited, added, duplicated, or removed before export.
- AI Coverage Review shows mapped coverage and remaining clarification items.
- XLSX export includes a frozen header, filters, wrapped cells, and QA-friendly column widths.

### Test Case AI guardrails

Source files are treated as evidence rather than instructions to the AI. The generator is instructed not to invent unsupported requirements or expected behavior. Missing behavior is marked **`TBD — clarification required`**, and generated cases must trace back to a mapped requirement.

No new database migration, API key, environment variable, or npm dependency is required for v0.6.20.

---

## Core modules

### Action Center

The Action Center combines activities, follow-ups, and AI-assisted assessment without merging them into a single concept.

**My Action Center**:

- Defaults to **10 items per page**.
- Page-size options: **10, 25, or 50**.
- Previous/Next pagination and current item range are shown below the table.
- Task and subtask follow-ups can surface in today/this-week activity views.

**AI BA Assistant assessment from Action Center**:

- **Assess with AI** returns the result directly below the prompt instead of redirecting immediately.
- Responses under 200 words are shown in full.
- Responses of 200 words or more show the first 200 words and a **View in AI BA Assistant** button.
- The full prompt, response, and suggestions remain available in the AI BA Assistant conversation.

### Clients

- Maintain tenant client records and client details.
- Choose Tiles, List, or Table; search and sort the visible clients. Layout preference is saved per user and account in the browser.
- Visible edit controls are available from client cards and detail views.
- Active / Archived / All lifecycle filters preserve historical visibility.
- Archived records remain read-only until reactivated.
- Client deletion is rejected server-side; lifecycle controls are used instead.

### Projects

- Projects can be shared across clients rather than being permanently tied to one client.
- Each client sees its own tasks within a shared project.
- Project details can be edited through the visible popup editor.
- Active / Archived / All states preserve project history.

### Tasks and subtasks

Track work with configurable fields such as status, type, waiting on, priority, assigned tenant user, start date, due date, and follow-up date.

Tasks and Subtasks support activity tracking and immutable user comments. Subtasks additionally support follow-up dates, reordering, and evidence uploads. Completion and archive state remain separate concepts so historical work can stay available after closure.

### Inbox / Inquiries

Tenant Discord bots can capture supported DMs and mentions into the application. Inquiry handling remains tenant-isolated, and tenant Discord credentials are configured in Account Settings rather than globally in Render.

### Activities

Activities include manually managed work plus task/subtask follow-up visibility. Local activity changes do not write back to Google Calendar.

### Communications

Client/project communications can be logged for historical reference and follow-up.

### Reports

Reports include project/task activity plus user workload, contribution history, completed/open work, and Task/Subtask User Gantt views. Administrators can report across tracked users; Contributors are scoped to their own work.

### AI BA Assistant

The AI BA Assistant accepts client inquiries, meeting notes, problems, and other working context and returns organized assessment and suggested next actions using the tenant's configured AI provider. Its server-built context includes the authenticated user, role, permitted data, assignments, and activity history.

---

# Document Creation

Document Creation currently includes:

1. **DRF Creation**
2. **FSD Creation**
3. **Test Case Creation**
4. **Sign Off Form**

## DRF Creation

DRF Creation reads company COR information, allows the extracted data to be reviewed and edited, and writes the reviewed values into the account's approved Excel DRF template.

### Persistent standard DRF template

The DRF workbook is a **persistent standard template per tenant/account**.

- Account Administrators can upload the first standard `.xlsx` template directly from DRF Creation.
- The template is automatically loaded on future visits.
- Future DRFs continue using the saved template until it is replaced or removed.
- Replacing a template requires confirmation.
- Administrators can remove the current template.
- DRF generation is disabled when no standard template is configured.
- Non-administrator document users can use the active template but cannot replace or remove it.
- Account Settings → Templates manages the same tenant-level template.
- Maximum saved DRF template size: **5 MB**.

Templates are stored using tenant-level persistence and survive browser restarts, Render deployments, and sign-ins from another device.

### COR extraction modes

DRF Creation provides two extraction methods:

**Local Extractor — default**

- Runs OCR/text extraction and field matching in the browser.
- Does not call an AI provider.
- Does not require an AI API key.

**AI Enhanced — optional**

- Available only when the tenant has an enabled AI integration.
- The browser first reads/OCRs the COR locally.
- Only the extracted COR text is sent to the tenant AI provider for mapping/refinement.
- The COR file itself is not uploaded to the AI extraction endpoint.
- AI maps/refines:
  - Business / Registered Name
  - Trade Name
  - TIN
  - Registered Address
- AI results remain editable before DRF generation.

The extraction selector starts on **Local** for a fresh session.

## FSD Creation

FSD Creation supports **Basic Mode** and **Advance Mode** and uses the tenant's configured AI integration.

Typical workflow:

1. Choose Basic or Advance Mode.
2. Enter document metadata such as client, feature, product, author, date, revision, and signatories.
3. Upload a BRD and supporting requirement sources or paste meeting/chat requirements.
4. Review extracted source text.
5. Select a preset, edit its instructions, or save a custom preset.
6. Generate an AI preview.
7. Review/edit generated sections, tables, missing information, and source conflicts.
8. Confirm review and generate the final editable `.docx`.

### FSD Basic Mode

- Multiple requirement uploads.
- Optional pasted requirements.
- Common preset dropdown.
- Editable preset instructions.
- AI determines applicable content from the evidence.
- Editable preview before Word generation.

### FSD Advance Mode

Includes Basic Mode capabilities plus:

- Source-to-section mapping.
- Explicit module scope controls.
- Additional skills/guidance.
- Per-section instructions.

Changing source content, metadata, mode, or generation instructions marks the previous preview as outdated. Unknown information remains marked for review rather than being silently invented.

FSD custom presets are retained for the current account/user browser profile. Draft inputs and preview data can be restored in the same browser tab/session; original uploaded file bytes are not stored as part of the draft.

The FSD Creator UI follows the browser/system light or dark color scheme while the generated-document preview remains white to represent the exported document.

## Test Case Creation

Test Case Creation uses the staged workflow:

**Sources → Skills → AI Coverage Map → Generate Test Cases → Editable Preview → Coverage Review → XLSX**

Custom skills are retained for future sessions for the current account/user browser profile. Draft sources, coverage, generated cases, and edits are retained in the current browser tab while the draft is active.

## Sign Off Form

Sign Off generates an editable Word approval form from the bundled iRipple template.

- Client details can update the corresponding references in the generated form.
- Six signatory slots are supported.
- Date, deployment/product selections, and site details are editable.
- Uploaded images can be included in the Word output.
- Other supported attachments accompany the generated output package.
- Generation requires an Administrator or Contributor with Document Creation access.
- No AI service is required.
- Draft form data and attachments are session-only; download the package before leaving or refreshing.
- Document numbers are assigned manually.

Keep `templates/signoff-template.docx` with the deployed source.

---

## Multi-tenant login and administration

The application uses a three-field login:

- **Account**
- **User**
- **Password**

The current login screen uses the refreshed split-screen Client Ops design on supported desktop widths and a responsive form-focused layout on smaller screens.

Login capabilities include:

- Password show/hide.
- **Remember me** for Account and User only.
- Passwords are never stored by Remember me.
- Forgot Password / email recovery.
- Application version display.

### Internal Admin

Platform-level administration remains separate from tenant Account Settings. Internal Admin is responsible for platform/account controls such as account creation, module enablement, selected-account platform operations, and system-level configuration.

### Account users and permissions

Account Administrators can manage users, roles, status, and module assignments within the modules enabled for their tenant.

The application uses role-based access, including Administrator, Contributor, and Viewer behaviors. Write actions remain permission-controlled; Viewer access remains read-only where applicable.

---

## Themes

The UI refresh does **not** replace or remove the theme system. Existing theme choices and theme assets remain available, including:

- Default
- Dark Geek Mode
- Light Blue Sky Beach Mode
- Green Grass with Insects
- Busy City Streets
- Calm Mountain — Bahay Kubo

Themes remain user-selectable and continue to control the application's themed backgrounds, accents, and surfaces. Shared UI refinements are designed to work on top of the selected theme.

---

## Settings ownership

| Tenant / Account Settings | Internal Admin |
| --- | --- |
| Saved Excel DRF template | Accounts, users, roles, and enabled modules |
| Discord bot token and allowed senders | Patch Updater / rollback controls |
| AI provider, model, and API credentials | Selected-account platform sync/administration |
| Enable/disable and test tenant integrations | Platform/system settings |
| User/theme preferences where applicable | Cross-tenant administration |

Tenant integration credentials are stored separately per account. Provider credentials are handled server-side and the full saved secret is not returned to the browser after saving.

---

## AI integrations

FSD Creator, Test Case Creator, AI BA Assistant, optional DRF AI Enhanced extraction, and supported Discord inquiry assessment reuse the **enabled AI integration for the current tenant/account**.

Supported provider integrations in the current project include:

- Gemini
- OpenAI
- Claude / Anthropic
- DeepSeek

Provider availability and model access depend on the tenant's own provider account and configured credentials.

AI keys belong to the tenant/account rather than being shared globally across all tenants.

---

## Discord integration

Each enabled tenant can run its own Discord bot for supported DMs and @mentions.

- Bot credentials must be configured for the correct tenant.
- Bot credentials should be distinct when multiple tenant bots are used.
- Enable **Message Content Intent** in the Discord Developer Portal.
- Allowed sender IDs can be configured when capture should be restricted.
- When tenant AI is available, supported inquiry assessment can use that tenant's AI integration; otherwise inquiry capture can continue without AI enhancement where supported.

---

## Google Calendar

Google Calendar uses **read-only server-side OAuth**, configured separately for each account. Internal Admin must enable the integration, then a tenant Administrator uploads its OAuth Web application JSON in Settings → Google Calendar. Each user connects from Action Center → My Google Calendar.

The account setup screen shows the exact callback address: `https://YOUR-APP/api/integrations/google-calendar/callback`. Register that address on the Google OAuth Web client. The Client ID and Client Secret belong in the account configuration, **not Render environment variables**. `VITE_GOOGLE_CLIENT_ID` is no longer used.

The existing server-side `TENANT_INTEGRATION_MASTER_KEY` encrypts both account credentials and user tokens. Do not replace an existing key or expose it to the browser. Tables are restricted to Supabase's service role, and every Calendar request checks current tenant/user permissions. Like the existing session system, OAuth pending states are in memory: run one application instance and restart the Connect flow after a deployment.

New Google schedules remain private to the signed-in user even in team work views. They are fetched on opening the panel, changing date range, or choosing Refresh, and are not stored in shared planner state or sent to AI. Legacy imported planner copies remain shared as before; no ownership is guessed and no historical records are removed.

Activities managed inside BA Client Ops Tracker do **not** write changes back to Google Calendar.

---

## Password recovery

Email recovery setup is documented in:

`PASSWORD-RECOVERY-SETUP.md`

---

# Installation

## Requirements

- Node.js **22.12+**
- Node.js 24 recommended
- npm
- Supabase project

## Fresh installation

Extract the full source build into a new directory, restore/create the required environment configuration, then run:

```bash
npm ci
npm run build
npm start
```

For development:

```bash
npm run dev
```

## Supabase migrations

Apply the SQL files in this order for a fresh environment:

1. `supabase/schema.sql`
2. `supabase/schema-v2.sql`
3. `supabase/schema-v3-multitenant.sql`
4. `supabase/schema-v4-account-login.sql`
5. `supabase/schema-v5-security-hardening.sql`
6. `supabase/schema-v6-tenant-save-integrity.sql`
7. `supabase/schema-v7-password-recovery.sql`
8. `supabase/schema-v8-tenant-integrations.sql`
9. `supabase/schema-v9-google-calendar.sql`

For an existing v0.6.26 installation, run only the new v9 migration for this upgrade. Do not rerun old data migrations on an existing tenant database.

### Bootstrap credentials

Set secure values for:

- `INTERNAL_ADMIN_BOOTSTRAP_PASSWORD`
- `BXI_CORE_BOOTSTRAP_PASSWORD`

Use values of at least 12 characters before first login. Bootstrap values are not replacements for passwords that have already been changed. Change bootstrap passwords after initial setup. No default production password is included in the repository documentation.

---

# Upgrade an existing installation

Always check the current version first:

```bash
npm run patch:status
```

For the current release, upgrade **v0.6.26 → v0.6.27** with the matching patch package:

```bash
npm run patch -- "path/to/ba-client-ops-patch-v0.6.27-google-calendar.zip"
npm run patch:status
npm run build
```

Apply `supabase/schema-v9-google-calendar.sql` before using Calendar, then restart/redeploy the server. Apply patches sequentially when starting from an older release. Each `UPGRADE-v0.6.x.md` file documents its expected starting version and validation steps.

The patch updater creates rollback backups and protects environment files, dependencies, Git metadata, and local patch history.

Rollback command:

```bash
npm run patch:rollback
```

---

# Render deployment

Recommended commands:

**Build command**

```bash
npm ci && npm run build
```

**Start command**

```bash
npm start
```

Keep infrastructure/server secrets such as Supabase service credentials, the integration encryption key, SMTP configuration, and other platform-level environment values in Render Environment.

Tenant Discord, AI provider and Google Calendar OAuth credentials are configured through tenant Account Settings rather than shared Render environment variables.

Use one application instance unless the process-local session/Discord ownership behavior has been redesigned for multi-instance operation. Persistent tenant data, encrypted integrations, and saved templates live in Supabase; process restarts can still affect process-local sessions and connection ownership.

---

# Validation commands

Useful validation commands include:

```bash
npm run typecheck:server
npm run test:integrations
npm run test:accounts
npm run test:signoff
npm run test:lifecycle
npm run build
npm run patch:status
```

Patch operations:

```bash
npm run patch -- "path/to/matching-patch.zip"
npm run patch:rollback
```

---

# Client and project lifecycle

Active / Archived / All filters retain access to historical records.

**Completion** and **Archive** are separate states:

- **Closed** means the work is completed.
- **Archived** means the record is inactive.

Archived work is read-only until reactivated. Existing history and evidence remain available for review. New task/project selectors exclude archived records, and server-side write rules enforce lifecycle restrictions.

For shared projects, linked client/project completion rules are validated before archive actions are allowed. Lifecycle controls identify blockers where applicable.

---

# Recent release highlights

| Version | Highlight |
| --- | --- |
| **0.6.32** | Document Creation processing panel, stages, long-running guidance, and retry feedback |
| **0.6.31** | Client Tiles, List, and Table views with search and sorting |
| **0.6.30** | Login card width and form dimensions match password recovery |
| **0.6.29** | Blank Account and User fields by default on the login screen |
| **0.6.28** | Main-task assignee inheritance for subtasks with persistent per-subtask overrides |
| **0.6.27** | Account-level Google OAuth credentials, private user connections and read-only schedules |
| **0.6.26** | Confirmed Task/Subtask saves and server-managed Task settings compatibility |
| **0.6.25** | Action Center views for My work, all tenant users, or a selected user |
| **0.6.24** | Per-user notifications, Admin team escalations, unread controls, deep links, and user comments |
| **0.6.23** | Automatic open-Subtask follow-up rollover with permanent System comments and activity history |
| **0.6.22** | Subtask Start Date visibility hotfix for create, edit, inline rows, and legacy column preferences |
| **0.6.21** | Tenant-user Task/Subtask assignment, Start Date, authenticated work history, user reports, User Gantt, and user-aware AI |
| **0.6.20** | AI Test Case Creator with Skills, Coverage Map, editable cases, Coverage Review, and XLSX export |
| **0.6.19** | Login panel edge-to-edge width correction |
| **0.6.18** | Login card width refinement |
| **0.6.17** | Login design fidelity correction |
| **0.6.16** | Split-screen login and shared SaaS UI refresh while preserving Themes |
| **0.6.15** | Local / AI Enhanced COR extraction selector |
| **0.6.14** | Persistent per-tenant standard DRF Excel template |
| **0.6.13** | Action Center pagination, inline AI assessment, adaptive FSD styling |
| **0.6.12** | FSD Creator with Basic and Advance modes |

For detailed release-specific instructions, see the matching `UPGRADE-v0.6.x.md` file included with the build.

---

## Current version

**BA Client Ops Tracker v0.6.27**
