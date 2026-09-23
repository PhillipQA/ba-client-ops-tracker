# Upgrade to v0.6.29 — Blank login fields

Upgrade path: **v0.6.28 → v0.6.29**.

## What changed

- The login screen no longer supplies `BXI-Core` as the default Account.
- The login screen no longer supplies `Admin` as the default User.
- Account and User open blank unless the person previously selected **Remember me**.
- Existing remembered values continue to work as requested by the user.

## Install

From the project directory:

```powershell
npm run patch -- "E:\Playwright\ba-client-ops-patch-v0.6.29-blank-login-fields.zip"
npm run patch:status
npm run build
```

Restart or redeploy the application, then refresh the login page.

No Supabase migration, new npm dependency, or environment-variable change is required.

Rollback with `npm run patch:rollback` if needed.
