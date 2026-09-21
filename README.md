# Current release — v0.6.12

FSD Creator now has Basic and Advance modes, account-configured AI generation, editable previews, Word export based on the iRipple FSD template, and draft retention across module navigation. See [UPGRADE-v0.6.12.md](UPGRADE-v0.6.12.md) for installation and usage.

# BA Client Ops Tracker

Version **0.6.9** — visible client/project Edit controls and an unclipped popup editor.

Tracks clients, shared projects, tasks/subtasks, follow-ups, inquiries, activities, evidence, communications, reports, and document creation. Built with React, TypeScript, Vite, Express, Discord.js, and Supabase.

## Upgrade an existing installation

Read [UPGRADE-v0.6.9.md](UPGRADE-v0.6.9.md) before applying the v0.6.8 → v0.6.9 patch. No new SQL migration or dependency is required for this update. Earlier installations must complete the [v0.6.8 upgrade](UPGRADE-v0.6.8.md) first.

## Fresh installation

Use Node.js 22.12+ (Node 24 recommended) and npm. Extract the full source build into a new directory, copy `.env.example` to `.env.local`, and set server infrastructure credentials.

```bash
npm ci
npm run build
npm start
```

For development: `npm run dev`.

Apply the SQL files in this exact order using Supabase SQL Editor:

1. `supabase/schema.sql`
2. `supabase/schema-v2.sql`
3. `supabase/schema-v3-multitenant.sql`
4. `supabase/schema-v4-account-login.sql`
5. `supabase/schema-v5-security-hardening.sql`
6. `supabase/schema-v6-tenant-save-integrity.sql`
7. `supabase/schema-v7-password-recovery.sql`
8. `supabase/schema-v8-tenant-integrations.sql`

Set secure `INTERNAL_ADMIN_BOOTSTRAP_PASSWORD` and `BXI_CORE_BOOTSTRAP_PASSWORD` values of at least 12 characters before first login. These are bootstrap values, not replacements for already-changed passwords. Use Account `internal_admin`, User `admin` for platform administration; use Account `BXI-Core`, User `Admin` for the first tenant. Change bootstrap passwords after signing in. No default production password is included.

## Settings ownership

| Tenant Settings | Internal Admin |
| --- | --- |
| Saved Excel DRF template | Accounts, users, roles, module access |
| Discord bot token and allowed senders | Patch Updater and rollback instructions |
| Gemini/OpenAI key, provider, and model | Selected-account Supabase sync |
| Enable/disable and test integrations | Task statuses/columns and integration health |

Account Administrators can manage their own account users, roles, status, and module assignments in **Users & Permissions**. All users, including Viewers, have **My Themes** for personal themes and per-client overrides. Each choice is saved for that user in that tenant. Personal details and passwords remain in My Profile. Each tenant’s encrypted keys are separate. No provider credential is returned to the browser after saving. Only Internal Admin can migrate/sync normalized tables manually or enable platform modules for a tenant. Account administrators can assign users only the modules enabled for their account. Normal workspace saves continue automatically.

## Render

Build command: `npm ci && npm run build`.
Start command: `npm start`.

Keep Supabase service credentials, the integration encryption key, SMTP, and other infrastructure settings in Render Environment. Discord and AI provider keys are configured in tenant Settings. Gemini is the default for new AI configurations; existing OpenAI configurations remain compatible. Follow the upgrade guide to import existing provider environment credentials into an explicitly selected tenant, verify them, then remove the old environment variables.

Use one application instance. Sessions and Discord connection ownership are currently process-local; process restarts require signing in again. Persistent data, encrypted integrations, and templates live in Supabase.

## Document creation and integrations

DRF COR extraction runs locally using browser OCR. Account Settings can save a reusable Excel template up to 5 MB; Document Creation loads it automatically. Existing ad hoc template uploads, DRF custom fields, machine rows, signatories, and FSD remain available.

Sign Off generates an editable Word approval form from the bundled iRipple template. One client field updates every client reference; six signatory slots, date, deployment/product dropdowns, and site details are editable. Uploaded images appear in Word; other supported files accompany it in a ZIP. Generation requires an Administrator or Contributor with Document Creation access. No AI service is needed. Form drafts and attachments are session-only; download before leaving or refreshing. Document numbers are manually assigned. Keep `templates/signoff-template.docx` with the deployed source.

Each enabled account runs its own Discord bot for DMs/@mentions. Bot credentials must be distinct across accounts. The bot uses that account’s AI key when available and otherwise falls back to basic inquiry capture. Enable Message Content intent in the Discord Developer Portal. Configure allowed sender IDs in Settings when capture should be limited.

The OpenAI model is configurable per account. The Assistant uses Responses API with low reasoning effort; test the chosen model with an actual request after verifying the key. See [OpenAI model documentation](https://developers.openai.com/api/docs/models).

Google Calendar remains a read-only browser OAuth integration configured through `VITE_GOOGLE_CLIENT_ID`; local activities do not write back to Google Calendar.

Email recovery setup is documented in [PASSWORD-RECOVERY-SETUP.md](PASSWORD-RECOVERY-SETUP.md).

## Validation and patches

```bash
npm run typecheck:server
npm run test:integrations
npm run build
npm run patch:status
npm run patch -- "path/to/matching-patch.zip"
npm run patch:rollback
```

The updater makes source backups and protects environment files, dependencies, Git metadata, and local patch history. Database migrations are run separately. Check [UPGRADE-v0.6.6.md](UPGRADE-v0.6.6.md) for deployment checks and validation limits.

## Client and project lifecycle

Use the visible Edit client / Edit project buttons on client cards, project rows, or beside the detail-page title. The popup opens above the page with the name first, followed by other details, and Save changes / Cancel controls. Archive / Deactivate and Activate remain in a compact availability bar on the detail page. Only Administrators with Clients access can rename existing clients. Administrators and Contributors with the corresponding module can edit other details and manage archive state. Viewers remain read-only. Client/project deletion is rejected by the server.

The Active / Archived / All filters retain access to historical records. Completion status is separate from archive state: Closed means done; Archived means inactive. Complete all tasks and subtasks, mark linked clients and projects Closed, then archive. For a shared project, every linked client must be Closed. Client completion is account-wide, including its work on other projects. The archive control lists any blockers. Activate records before resuming work; activation preserves completion status and history.

Archived work is read-only. New task/project selectors exclude archives, and API writes also enforce the restriction. Evidence remains available for viewing. Existing records default active; archive state and record versions persist in tenant snapshots and normalized raw_data, without new SQL. Keep the existing single-instance server setup for serialized saves.
