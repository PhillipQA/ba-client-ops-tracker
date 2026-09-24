# Upgrade to v0.6.30 — Login card dimensions

Upgrade path: **v0.6.29 → v0.6.30**.

## What changed

The login card uses the same 470px maximum width as the password-recovery card. Both share 28px card padding, reduced to 20px at viewport widths of 560px or below. Login fields and the submit button are 42px tall, form rows use 13px gaps, and the card corners use the recovery screen's 22px radius.

The login card no longer expands across its entire desktop panel or uses the old 560px mobile width. It still shrinks to fit the available space. Height stays automatic so error messages, text wrapping, and browser zoom cannot be clipped by a fixed card height.

The existing login colors, desktop illustration, Remember me, Forgot password, password visibility toggle, and v0.6.29 blank Account/User defaults are unchanged. No accounts, credentials, or workspace data are modified.

## Install

Back up the project, then run from `E:\Playwright\ba-client-ops-tracker`:

```powershell
npm run patch -- "E:\Playwright\ba-client-ops-patch-v0.6.30-login-card-dimensions.zip"
npm run patch:status
npm run build
```

Restart locally or deploy the updated code using the normal process, then refresh the login page. No Supabase migration, environment-variable change, or new npm dependency is required. The patch does not require `npm install`; a fresh full-build installation still needs `npm ci`.

## Verification

- `npm run test:auth-layout` checks the shared CSS sizing, responsive overrides, and wrapping rules. These are source-level regression checks, not rendered-browser tests.
- `npm run typecheck:server` and `npm run build` check compilation.
- After deploying, confirm the login card is compact at desktop width; reduce the window to a phone-sized width and check that all fields and links remain visible. Open Forgot password and return to login to compare the card width.

The local preview browser could not connect in the build environment, so rendered desktop/mobile appearance needs the post-deployment smoke check above.

Rollback with `npm run patch:rollback`. This restores code only; no database rollback is needed.
