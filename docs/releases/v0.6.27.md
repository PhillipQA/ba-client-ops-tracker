# Upgrade to v0.6.27 — Google Calendar

Upgrade path: **v0.6.26 → v0.6.27**. Includes the v0.6.26 Action Center save hotfix.

## 1. Install and migrate

Back up your project and Supabase database. From `E:\Playwright\ba-client-ops-tracker`:

```powershell
npm run patch -- "E:\Playwright\ba-client-ops-patch-v0.6.27-google-calendar.zip"
npm run patch:status
npm run build
```

In **Supabase → SQL Editor**, run `supabase/schema-v9-google-calendar.sql` from the updated project. This additive, rerunnable migration adds Calendar tables; it does not change tasks, accounts, or existing activities. The npm patch command copies SQL files but does not execute them. Do not rerun earlier migrations on an existing database.

Restart locally or commit/deploy the updated project to Render using your normal deployment process. Refresh the browser. No new dependency or `npm install` is needed for the patch; a fresh full-build installation still needs `npm ci`.

## 2. Internal Admin enables each tenant

Sign in to Internal Admin, select the tenant under **Tenant accounts → Manage**, and enable **Google Calendar integration → Allow Google Calendar**. It is disabled by default. This is separate from Action Center module access, which users also need.

The server must already have the same `TENANT_INTEGRATION_MASTER_KEY` used by Discord/AI integration storage (64 hex characters). Keep and back up that key; changing it makes previously encrypted credentials unreadable. If integration encryption was never configured, Internal Admin must configure it once on the server. This is an infrastructure encryption key, not a Google credential.

## 3. Account administrator saves the OAuth JSON

Sign in as an Administrator of the tenant and open **Settings → Google Calendar — account setup**.

1. Copy the **Authorized redirect URI** shown there to the Google Cloud OAuth Web client. It ends in `/api/integrations/google-calendar/callback`. It must use the public HTTPS address people use for the tracker; local development may use HTTP localhost. If the app already has `APP_BASE_URL` set, it determines the canonical callback origin.
2. Enable Google Calendar API in the Google Cloud project. Configure these scopes: `openid`, `email` (shown as `userinfo.email` in the console), `https://www.googleapis.com/auth/calendar.events.readonly`, and `https://www.googleapis.com/auth/calendar.calendarlist.readonly`. No write scope or profile/photo permission is needed.
3. Upload the downloaded **Web application** JSON, leave **Enable Calendar for this account** checked, then choose **Save Calendar settings**. Alternatively enter both Client ID and Client Secret.
4. For an External app in Testing, add each connecting Google email as a test user. Google Workspace organizational policy may require approval from your Workspace administrator. Respect any blocked/denied policy; ask that administrator for access.

Do **not** put the OAuth JSON in the project repository, frontend code, or Render Environment. No `GOOGLE_CALENDAR_CLIENT_ID`, `GOOGLE_CALENDAR_CLIENT_SECRET`, or `GOOGLE_CALENDAR_REDIRECT_URI` environment variables are used. The old `VITE_GOOGLE_CLIENT_ID` is also unused. Account secrets are encrypted in Supabase and never returned to the browser after saving.

## 4. Each user connects separately

Open **Action Center → My Google Calendar → Connect Google Calendar**. Select the intended Google account and grant both read-only Calendar permissions. After returning, use **Choose calendars**, select up to 10 accessible calendars, and save your selection. The primary calendar is selected initially.

- **Today** and **This Week** use your browser's time zone; the week starts Sunday.
- Recurring occurrences, overlapping multi-day events and all-day exclusive end dates are handled.
- Opening the panel, changing its date range or choosing **Refresh** retrieves current schedules. This build does not background-poll Google or send Calendar notifications.
- Google events are read-only in the tracker. No event create/update/delete API exists in this integration.
- New schedules are private to the signed-in tenant/user, not added to shared planner data, not included in shared reports, and not sent to AI. Changing the Action Center team work filter does not change whose Google schedules are shown.
- Existing legacy imported calendar copies remain shared tracker activities with their existing local editing behavior. The upgrade does not delete, reassign, or alter them.
- **Disconnect** removes only your stored connection and attempts to revoke Google's grant. If Google cannot be reached, the UI reports that manual removal in Google Account permissions is still needed. Revoking a Google project's grant can also invalidate other connections using the same Google account and Cloud project.
- Changing/removing account credentials invalidates all that account's connections until users reconnect. Old encrypted tokens remain removable through each user's Disconnect action. Disabling Calendar prevents reads and new connects without deleting credentials.
- Google External/Testing refresh tokens generally expire after seven days, so reconnect as needed. For broader rollout, follow Google's production/verification process; production tokens can still be revoked or expire under policy.

## Security and operational notes

Credentials use AES-256-GCM authenticated encryption, bound to tenant and (for tokens) user. Calendar tables are service-role-only with RLS and a tenant/user foreign key. Requests use the current authenticated tenant/user, not browser-supplied IDs. Mutations require same-origin JSON. OAuth uses short-lived, single-use state, PKCE, and a separate HttpOnly callback cookie; the existing Strict session cookie is unchanged. Authorization codes and tokens are not logged by the application or returned to the frontend. Configure any external proxy/access logging to redact callback query strings.

Use one server instance, as required by the app's existing in-memory sessions. An in-progress OAuth connection must be restarted after a deploy or server restart. Saved encrypted connections survive restarts; users sign back in to the tracker and refresh. Requests time out and return actionable errors instead of exposing provider response bodies. Large selections are bounded to avoid runaway API fetching.

## Validation and deployment smoke check

Run `npm run typecheck:server`, `npm run test:calendar`, and `npm run build` for repeatable local checks. Calendar tests exercise actual HTTP routes with mocked Google responses and an in-memory database adapter: encryption context, per-tenant/user isolation, permissions, same-origin checks, state/PKCE/replay/expiry, cancellation, partial consent, refresh, revocation failure, pagination, calendar selection, date mapping and credential rotation.

Before using live schedules, connect one test user on your deployment; check Today/This Week, select a shared calendar, refresh after editing an event in Google, sign in as a second tracker user and confirm no first-user schedules appear, then disconnect. Also confirm the v0.6.26 Task/Subtask save remains after refresh. Live Google, hosted Supabase, Render and browser end-to-end authorization require this deployment smoke check; no user credentials were used to build the release.

Rollback: `npm run patch:rollback` restores code only. The additive v9 tables may remain; no workspace data was rewritten. Disconnect Google before rolling back if you also want to revoke granted access.

## Google documentation

- [Calendar scopes](https://developers.google.com/workspace/calendar/api/auth)
- [Web-server OAuth](https://developers.google.com/identity/protocols/oauth2/web-server)
- [Refresh-token expiration](https://developers.google.com/identity/protocols/oauth2)
- [Calendar events listing](https://developers.google.com/workspace/calendar/api/v3/reference/events/list)
