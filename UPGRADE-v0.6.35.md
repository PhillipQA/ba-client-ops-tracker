# v0.6.35 — Multi-browser login hotfix

This hotfix fixes the case where one browser remains logged in but new browsers using the same valid Account/User receive `Failed to fetch` or an unexpected `429 Too Many Requests` response.

## What changed

- Login attempts are no longer provisionally counted before the password result is known.
- Only confirmed invalid account/user/password responses add a failed attempt.
- A successful login immediately clears earlier failed-attempt history for that client IP + Account + User.
- Multiple browsers can hold independent active sessions for the same valid user.
- The security policy remains five failed credential attempts in 15 minutes.
- A real lockout returns `429`, `Retry-After`, and the remaining wait time.

The deployment restart clears any stale in-memory v0.6.34 limiter state. No Supabase migration, npm install, or Render environment-variable change is required.

## Apply to v0.6.34

From the project folder:

```powershell
npm run patch -- "E:\\Playwright\\ba-client-ops-patch-v0.6.35-multi-browser-login.zip"
npm run patch:status
npm run build
```

Commit and push the patched files so Render redeploys the service.

## Verification

1. Sign in with valid credentials in Browser A.
2. Open Browser B or an Incognito window and sign in with the same valid credentials.
3. Confirm both sessions remain active and no `Failed to fetch` or `429` appears.
4. Enter a wrong password four times, then sign in correctly; the successful sign-in clears those failures.
5. Enter a wrong password five times; the next attempt should return a temporary `429` lockout.
