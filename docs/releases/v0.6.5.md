# BA Client Ops Tracker v0.6.5 — account integrations

## What changed

- Tenant Settings contains Templates, Discord Integration, and AI Integration only.
- Each account stores its own Discord bot token, sender allowlist, OpenAI key, and model.
- Credentials are encrypted with AES-256-GCM, bound to their tenant/provider, and stored in server-only Supabase tables. Browsers receive only a masked suffix.
- Account administrators can save, replace, remove, enable/disable, and test their own credentials. Other tenant roles cannot manage credentials.
- Each enabled account starts its own Discord bot connection. Saving/removing a token reconnects/stops that account’s bot. Active connections reload after server restarts. One bot identity cannot belong to two accounts.
- The BA Assistant and Discord inquiry assessment use the current account’s OpenAI key. COR OCR remains local.
- Internal Admin holds Patch Updater instructions, Supabase sync, integration health, per-account task workflow/columns, user management, and module access. Backend permissions enforce these boundaries.
- Personal themes remain in My Profile.
- Account administrators can save one Excel DRF template per account. Document Creation loads it automatically; ad hoc template upload remains available.
- Password recovery from v0.6.4 is included and retained.

## 1. Pick the matching patch

From your existing project folder:

```bat
cd /d E:\Playwright\ba-client-ops-tracker
npm run patch:status
```

| Installed version | Patch to use |
| --- | --- |
| 0.6.4 | ba-client-ops-patch-v0.6.5-from-v0.6.4.zip |
| 0.6.3 | ba-client-ops-patch-v0.6.5-from-v0.6.3.zip |
| Any other version | Do not force these patches. Use a matching upgrade first or the included complete source build in a separate folder. |

Stop the local app. Make a database backup before applying migrations. The updater backs up source files; it does not back up the database.

Example if installed version is **0.6.4** and the patch is saved under E:\Playwright:

```bat
npm run patch -- "E:\Playwright\ba-client-ops-patch-v0.6.5-from-v0.6.4.zip"
```

For **0.6.3**:

```bat
npm run patch -- "E:\Playwright\ba-client-ops-patch-v0.6.5-from-v0.6.3.zip"
```

Use two hyphens followed by a space before the ZIP path. Do not use `--force`.
The 0.6.3 patch includes v0.6.4 and installs its email dependency.
Both patches include the release lockfile. The v0.6.4 patch does not need new dependencies; the v0.6.3 patch runs npm install automatically.

## 2. Apply the database migration

In Supabase SQL Editor:

- If starting from 0.6.3, run `supabase/schema-v7-password-recovery.sql` first.
- Run `supabase/schema-v8-tenant-integrations.sql`.

Schemas v1 through v6 must already be installed. Patches copy SQL files but do not execute them. The v8 migration adds private integration/template tables and retains existing client, project, task, user, and recovery data. It is rerunnable.

## 3. Configure the encryption master key

Generate a random key locally:

```bat
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Add the output to Render Environment as **TENANT_INTEGRATION_MASTER_KEY**. For local development use `.env.local`.
Keep this key stable and retain a secure backup. Replacing it makes saved integration credentials unreadable; they must then be restored with the old key or entered again.

Keep these infrastructure settings server-side:

- SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY
- TENANT_INTEGRATION_MASTER_KEY
- Existing SMTP/password recovery settings, APP_BASE_URL, and bootstrap settings where still required

Provider tokens are entered per account. Never use a `VITE_` variable for a secret.
The patch intentionally does not overwrite `.env`, `.env.local`, or `.env.example`.

## 4. Build and deploy

```bat
npm run typecheck:server
npm run test:integrations
npm run build
npm run patch:status
```

Commit/push the updated source to the repository connected to Render, then deploy using your existing build/start settings (`npm ci && npm run build`, `npm start`). Applying a local patch does not deploy to Render.

Run one Node application instance for this release. Discord gateway connections and existing login sessions are process-local; multi-instance gateway ownership is not implemented.

## 5. Move existing credentials to the correct account

The new build does **not** use global OPENAI_API_KEY or DISCORD_BOT_TOKEN for normal operation. Plan a short integration pause while configuring account credentials.

1. Sign in using the `internal_admin` account and your existing administrator credentials.
2. Select the account that owns the existing integrations, such as BXI-Core.
3. Under Platform settings, import the old Discord and AI environment credentials. The target account is displayed before import. Existing account credentials are never overwritten.
4. Imported credentials start **disabled**. Sign out and sign in to that tenant as its Administrator.
5. Open Settings. Review the Discord sender allowlist and AI model; use **Test saved connection**, enable the integration, and **Save settings**.
6. Refresh status until the Discord Gateway is online. Send a test DM and @mention, and verify each appears in that account’s Inbox. Run a BA Assistant request.
7. After both work, remove OPENAI_API_KEY, OPENAI_MODEL, DISCORD_BOT_TOKEN, DISCORD_ALLOWED_USER_IDS, and DISCORD_ORGANIZATION_SLUG from Render, then redeploy. Account settings now own their replacements.

Alternatively, skip import and enter new credentials directly in each tenant’s Settings.
The Discord bot needs Message Content intent enabled and access to the intended server/channels. Empty sender allowlist permits anyone who can reach the bot. The AI test verifies key/model access; an actual Assistant request verifies generation quota and model compatibility. Select a model compatible with Responses API and low reasoning effort.

## 6. Verify after deployment

- Tenant Settings shows only Templates, Discord Integration, and AI Integration. My Profile still offers themes.
- Internal Admin displays platform settings, selected-account sync, and task configuration.
- Tenant administrators cannot call Internal Admin or old migration endpoints.
- Save distinct keys for two accounts; each sees only its own masked key/configuration.
- Disable/remove Account A’s integration; Account B remains configured.
- Restart the app; encrypted credentials and template remain, and enabled bots reconnect.
- Save an Excel DRF template and open Document Creation; it loads for the correct account.
- Check existing clients/tasks, account logins, and password recovery.
- After platform task-setting changes, reload any open tenant tabs before saving; stale task settings are rejected.

## Validation performed for this release

- Production TypeScript/Vite build passed.
- Strict server TypeScript checks passed.
- Five automated tests passed covering authenticated HTTP permissions, tenant scoping, masked output, encrypted storage, cross-tenant/provider decryption rejection, tampering, disable/removal, storage reload, duplicate Discord bot identity, template isolation, and Internal Admin authorization.
- Patch application, version guards, protected environment preservation, and rollback are checked during release packaging.
- External calls were mocked in automated tests. Real Supabase SQL execution, Discord Gateway, OpenAI billing/model access, SMTP, and production migration were not tested against your accounts.
- Browser visual inspection was unavailable in this environment because the browser executable was absent.

## Rollback

Stop the app and run:

```bat
npm run patch:rollback
npm run build
```

Redeploy the restored source. If returning to global integrations in the old version, restore its old provider environment variables. Keep the additive v8 tables and encryption master key so the next upgrade can reuse saved credentials. Do not drop tenant tables as a rollback step.
