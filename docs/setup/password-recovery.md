# Configure email password recovery

The current app includes **Forgot password?** on the login screen. Configure SMTP and a registered recovery email to enable it. The original v0.6.4 patch instructions are retained in the [historical archive](../releases/archive/email-password-recovery-v0.6.4.md).

## 1. Configure SMTP on the server

Add your provider's settings to `.env.local` locally, or to the host's environment variables:

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

Replace the placeholders with the provider's approved settings and sender. Port 587 uses STARTTLS with the settings above. For implicit TLS on port 465, set `SMTP_PORT=465` and `SMTP_SECURE=true`. Restart the app after changing configuration.

`APP_BASE_URL` must be the public HTTPS origin users can reach, with no username, password, query or fragment. Local testing can use `http://localhost:5173`.

These values belong on the server, without a `VITE_` prefix. SMTP is used for password recovery. Current DocHub signing reminders use the DocHub-native API, not this SMTP configuration.

## 2. Register recovery emails

- Workspace users: save an email in My Profile, or have an administrator update the user record.
- Internal Admin: open Security → Recovery email and save it with the current password.

The account, username and email entered in Forgot password must match the saved record. Disabled users and suspended workspaces cannot use this recovery flow.

## 3. Check delivery

1. Sign out and select Forgot password.
2. Enter the active user's Account, User and registered email.
3. Open the received reset link, choose a new password and sign in again.

Reset links expire after 30 minutes and work once. Requesting a link does not change the password; a later request replaces older links.

The acknowledgement is deliberately the same for matching and nonmatching details. If no email arrives, check the registered details, spam folder, SMTP variables, outbound SMTP access and server logs.

## Database prerequisites

A current fresh installation includes recovery-token storage/functions. Existing databases need the recovery schema from their original upgrade path. Imported PostgreSQL databases must also include the recovery functions; consult the [cutover guide](northflank-postgres-cutover.md) if they are absent.

A code rollback does not reverse a password already reset. Application sessions are currently in memory, so run one application instance.
