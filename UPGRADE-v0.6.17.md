# Upgrade to v0.6.17 — Login Design Fidelity Fix

## Why this update exists
The first v0.6.16 implementation used an incorrectly cropped hero image and a login-card composition that was smaller and structurally different from the approved mockup. v0.6.17 corrects those visual mismatches without changing authentication logic or the application's theme system.

## What changed
- Corrects the desktop split to approximately **58% visual / 42% login** to match the approved reference.
- Rebuilds the hero asset from the complete intended visual side instead of the earlier half-image crop.
- Enlarges and rebalances the login card on desktop.
- Centers and stacks the app icon, product title, and workspace subtitle as shown in the reference.
- Restores the visual **OR** separator between Sign in and the security callout.
- Refines card spacing, field height, version placement, copyright spacing, and responsive behavior.
- Keeps Account, User, Password, Remember me, password visibility, Forgot Password, and authentication behavior unchanged.

## Themes
No theme definitions, theme images, theme preferences, or in-app theme behavior are changed by this patch.

## Database / configuration
- No Supabase migration required.
- No new environment variables.
- No new npm dependencies.

## Suggested validation
1. Open the login page at 100% browser zoom on a desktop display.
2. Confirm the hero is no longer cut off before the quote/laptop area.
3. Confirm the right-side card is larger and the logo/title/subtitle are stacked and centered.
4. Verify Account, User, Password, Remember me, show/hide password, Forgot Password, and Sign in still work.
5. Sign in and confirm all existing themes and application modules remain unchanged.
