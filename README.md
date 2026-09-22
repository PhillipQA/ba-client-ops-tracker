# BA Client Ops Tracker

**Current release: v0.6.22**

BA Client Ops Tracker is a multi-tenant Business Analyst and client-operations workspace for managing clients, shared projects, tasks and subtasks, follow-ups, inquiries, activities, communications, evidence, reports, AI-assisted BA workflows, and document creation.

The application is built with **React, TypeScript, Vite, Express, Discord.js, Supabase, local OCR, and tenant-configured AI integrations**.

---

## Current release — v0.6.22

v0.6.22 is a focused visibility hotfix for **Task and Subtask Start Date** on top of the v0.6.21 User Work Tracking release.

### User work tracking highlights

- Tasks and Subtasks can be assigned to one specific active tenant Administrator or Contributor.
- Assignment dropdowns show each user's active and overdue workload.
- Tasks and Subtasks now include an optional **Start Date**; moving an item to In Progress fills an empty Start Date automatically.
- The system records server-verified work events with the authenticated actor, current assignee, task/subtask, client, project, change, and timestamp.
- Reassignment history preserves both who is responsible now and who acted historically.
- Contributor Action Center and report views use the signed-in user's assignments.
- Reports add user filters, factual workload metrics, contribution history, and a Task/Subtask User Gantt.
- AI context is rebuilt on the server from the authenticated tenant and user, so “I / me / my” refers to the signed-in user and app permissions are applied before data reaches the AI provider.
- Internal Admin remains outside tenant productivity reporting.
- Create and Edit forms now group Start Date, Due Date, and Follow-up Date in a clearly labeled Task/Subtask Schedule section.
- Subtask rows show Start and Due dates directly below the title, without requiring horizontal scrolling.
- Start Date remains present in the table even when an older saved column preference predates the field.

No new environment variable, npm dependency, or Supabase migration is required for v0.6.22.

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

Subtasks support activity tracking, comments, follow-up dates, reordering, and evidence uploads. Completion and archive state remain separate concepts so historical work can stay available after closure.

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

Google Calendar remains a **read-only browser OAuth integration** configured through `VITE_GOOGLE_CLIENT_ID`.

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

v0.6.12 through v0.6.22 do not add another Supabase migration beyond the migrations already required by the current build.

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

For the current release, upgrade **v0.6.21 → v0.6.22** with the matching patch package:

```bash
npm run patch -- "path/to/ba-client-ops-patch-v0.6.22-subtask-start-date-hotfix.zip"
npm run patch:status
npm run build
```

Apply patches sequentially when starting from an older release. Each `UPGRADE-v0.6.x.md` file documents its expected starting version and validation steps.

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

Tenant Discord and AI provider credentials are configured through tenant Account Settings rather than shared Render environment variables.

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

**BA Client Ops Tracker v0.6.22**
