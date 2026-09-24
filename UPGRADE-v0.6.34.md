# v0.6.34 — Login rate-limit hotfix

This hotfix fixes false or shared login lockouts while preserving brute-force protection.

## What changed

- Login failures are now counted per **client IP + Account + User** instead of only per IP.
- Only `401 Unauthorized` responses from `/api/auth/login` count as failed login attempts.
- Successful logins, cancelled/network-aborted requests, malformed requests (`400`), setup/configuration responses (`409`/`503`), and server errors (`500`) do not consume the failed-login allowance.
- The security policy remains **5 failed credential attempts in 15 minutes**; the next attempt is temporarily rejected with `429 Too Many Requests`.
- Existing session handling, password hashing, multi-tenant authentication, Internal Admin authentication, password recovery, Supabase data, and DocHub integration are unchanged.

## Apply to v0.6.33

From the project folder:

```powershell
npm run patch -- "E:\\Playwright\\ba-client-ops-patch-v0.6.34-login-rate-limit-hotfix.zip"
```

Then build and restart:

```powershell
npm run build
npm run dev
```

For Render, commit/deploy the patched source using the existing deployment process. No Supabase migration or new environment variable is required.

## Verification

1. Sign in once with valid credentials: login should succeed.
2. Enter an incorrect password up to five times for the same Account/User/IP: each attempt should return `401`.
3. The next attempt within the 15-minute window should return `429`.
4. A different user on the same public IP should still be able to sign in.
5. A server/configuration error or interrupted request should not consume the failed-login allowance.

If an old v0.6.33 in-memory IP-only limit is currently active on Render, deploying/restarting v0.6.34 clears that old in-memory limiter state.
