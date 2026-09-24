# Email password recovery — v0.6.4

This patch upgrades **v0.6.3 → v0.6.4**. It removes both help panels below Sign in and replaces them with **Forgot password?** Users enter their account, username and registered email, receive a reset link, and choose a new password. Links expire after 30 minutes and work once.

## Apply the patch

1. Stop the running app. From `E:\Playwright\ba-client-ops-tracker`, confirm `npm run patch:status` reports **0.6.3**.
2. Save the patch ZIP in `E:\Playwright`, then run:

```powershell
npm run patch -- "E:\Playwright\ba-client-ops-patch-v0.6.4-email-recovery.zip"
```

Keep the two dashes separate from the quoted path. The updater installs the email dependency and creates its normal file rollback backup. Your environment files are preserved.

3. In **Supabase → SQL Editor**, run the updated project's **`supabase/schema-v7-password-recovery.sql`**. Your existing v0.6.3 schema, including v6, must already be installed. This migration adds private recovery-token storage and reset functions; it does not replace existing accounts or workspace records. The patch command copies this SQL file but does not execute it.
4. Configure the email sender below, then build and restart:

```powershell
npm run build
npm run dev
```

For production, use your existing deployment process and `npm start`. Refresh open browser tabs. `npm run patch:status` should now report **0.6.4**.

## Configure the sender

Add these values to your existing `.env.local` for local use, or your hosting service's environment settings for a deployed app. Replace every example value with your provider's actual settings. No email provider or mailbox is connected by the patch itself.

```dotenv
APP_BASE_URL=https://your-client-ops-app.example.com
SMTP_HOST=smtp.your-email-provider.example
SMTP_PORT=587
SMTP_SECURE=false
SMTP_REQUIRE_TLS=true
SMTP_USER=your-smtp-username
SMTP_PASS=your-smtp-password-or-app-password
SMTP_FROM="Client Ops Tracker <no-reply@your-verified-domain.example>"
```

Use a sender address/domain approved by your email provider. Keep credentials on the server; do not use a `VITE_` prefix. Restart the server after changing these values. Your host must permit outbound connections to the provider's SMTP port.

For port **587**, use `SMTP_SECURE=false` and `SMTP_REQUIRE_TLS=true` to require STARTTLS. If your provider requires port **465**, set `SMTP_PORT=465` and `SMTP_SECURE=true`. These settings follow the [Nodemailer SMTP documentation](https://nodemailer.com/smtp).

`APP_BASE_URL` must be the URL users can open to reach this app. It must use HTTPS, except that local testing accepts an HTTP loopback address such as `http://localhost:5173`. A localhost link works only on the computer running the app. Do not include a username, password, query string or fragment in this URL.

## Register recovery email addresses

- **Workspace users:** save the user's email in **My Profile**, or have an administrator edit the user in Settings/Internal Admin. Recovery requires the same Account, User and email saved on that user record.
- **Internal Admin:** sign in, open **Security → Recovery email**, enter the address and your current password, then choose **Save recovery email**. This is separate from a tenant user's email.

Accounts with no registered email need an administrator to set one before email recovery is possible. Disabled users and suspended workspaces cannot recover a password through this flow.

## Check your email setup

Sign out, choose **Forgot password?**, and enter an active account's registered details. Open the received link and set a new password. Sign in with that password. Check the spam folder if necessary.

The request screen intentionally shows the same acknowledgement for matching and nonmatching accounts. If no email arrives, confirm the saved account details, SMTP configuration and v7 migration. The server logs a short configuration/delivery error without printing reset tokens or email credentials. Missing sender configuration shows “Email recovery is unavailable.”

Requesting a link does not change the password. The reset signs out that user's sessions on the running server. A new request replaces older links; changing the password or registered email also invalidates outstanding links. Recovery is limited to five requests per IP per 15 minutes, one email per account per minute, and five emails per account per hour.

The app retains its existing in-memory session model; run a single application instance as before. This patch does not add a shared session store across server instances.

## Rollback

The existing `npm run patch:rollback` command restores the previous code files. The additive v7 SQL can remain in place when rolling back to v0.6.3. A file rollback does not reverse passwords a user has already reset.
