# BA Client Ops Tracker v0.6.6

Restores account-level user management and makes personal/client themes easy to find. This patch requires **v0.6.5**. Existing tenant integrations, Internal Admin platform settings, email recovery, and data remain in place.

## What changes

- **Users & Permissions:** account Administrators can add users, edit names/contact details, choose Administrator / Contributor / Viewer, enable or disable users, and assign modules enabled for their account by Internal Admin. Administrators cannot disable or demote their own signed-in user. Usernames are unique within an account, ignoring case.
- **Permissions:** Contributors can modify operational records through assigned modules; Viewers remain read-only for operational data. Both can edit their own profile and themes. Account administrators cannot grant platform privileges or enable a module disabled by Internal Admin. Changed access is enforced server-side; open tabs refresh the session every 15 seconds and on focus. Disabled users are signed out. Password recovery stays available through the existing email flow and Internal Admin.
- **My Themes:** every user can choose a workspace theme and a separate override for each client. An override applies when opening that client or a project through that client. Global project views use the user's workspace theme. “Use my workspace theme” removes the client override. Preferences are scoped to tenant + user + client; changing your theme never changes another user's theme. Existing personal themes are preserved.
- Tenant **Settings** still contains Templates, Discord Integration, and AI Integration. User management and themes have separate navigation entries, so personal themes do not depend on Settings module access. Patch Updater and Supabase tools remain in Internal Admin.
- Profile/theme changes use a dedicated authenticated API and report success only after the server saves them. Changing your password signs out your active sessions.

Module assignments govern feature access and role-based writes. They are not client-by-client data restrictions inside one tenant, and this release does not add individual Create/Edit/Delete permission switches.

## Apply the patch

1. Stop the local app and run `npm run patch:status` from `E:\Playwright\ba-client-ops-tracker`. Confirm version **0.6.5**. If earlier, complete the appropriate v0.6.5 upgrade first; do not force this patch onto another version.
2. Save `ba-client-ops-patch-v0.6.6-from-v0.6.5.zip` in `E:\Playwright`.
3. From the project folder, run:

```bat
npm run patch -- "E:\Playwright\ba-client-ops-patch-v0.6.6-from-v0.6.5.zip"
npm run typecheck:server
npm run test:accounts
npm run test:integrations
npm run build
npm run patch:status
```

No new npm dependencies or SQL migration are needed when upgrading a working v0.6.5 installation. Keep all existing Supabase migrations through v8 and the encryption master key. Environment files are not changed by this patch.

Restart locally with `npm run dev`, or deploy the updated source through your existing Render-connected repository and normal build/start commands. Applying the patch locally does not update Render. Refresh existing tabs and sign in again after deployment. Continue using the existing single-instance deployment configuration.

The full-build ZIP is source for a separate installation or replacement checkout. Use the README for fresh-install setup. It contains no credentials or tenant data.

## Verify on your deployment

1. Sign in to BXI-Core as an Administrator. Open **Users & Permissions** and create a Contributor and Viewer with different usernames and registered recovery emails.
2. Assign modules, then sign in as those users in separate browser sessions. Confirm navigation and allowed actions. Verify the Viewer cannot modify tasks, and the Contributor cannot create users or manage integration credentials.
3. Change the Contributor's modules or role while they are signed in. Focus their tab or wait up to 15 seconds. Disable the user and confirm their session ends.
4. Open **My Themes** as each user. Choose different workspace themes and client overrides. Visit each client, open a project through that client, return to the global project view, and reload/sign in again. Confirm each user's choices stay separate.
5. In a second tenant, confirm user management shows only its own users and theme choices remain independent.
6. Confirm existing clients/tasks, account integration credentials, password recovery, and Internal Admin tools still work.

## Validation and limits

- Production frontend build and strict server TypeScript check passed.
- Nine account/profile/theme tests and five existing integration tests passed. They exercise authenticated HTTP routes with in-memory persistence, permission changes, tenant scoping, module ceilings, secret-free responses, Viewer profile saves, client-theme inheritance, concurrent account API changes, session invalidation, and failed saves. External provider calls are mocked.
- The release was checked with the real patch updater: apply, exact payload comparison, version guard, preserved environment files, and rollback.
- Live hosted Supabase persistence and browser interaction/visual checks were not performed in this environment. Discord/OpenAI and email delivery need deployment verification. The available browser runtime had no installed browser executable.

## Roll back

Stop the app, run `npm run patch:rollback`, rebuild, and redeploy the restored source. This restores code, not users, role changes, passwords, or preferences already saved to Supabase. No database migration needs reversing. v0.6.5 cannot display per-client overrides; preserve a database backup if returning to the older version, whose subsequent workspace saves may omit those new preference fields.
