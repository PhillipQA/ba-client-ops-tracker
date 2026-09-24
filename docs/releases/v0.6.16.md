# Upgrade to v0.6.16 — Client Ops UI Refresh

## What changed

### New split-screen login
- Replaces the plain centered login card with the approved clean SaaS split-screen layout.
- Adds a Client Ops visual panel on desktop and a responsive form-only layout on smaller screens.
- Keeps the three required login fields: Account, User, and Password.
- Adds password show/hide.
- Adds **Remember me** for Account and User only. Passwords are never stored by this option.
- Keeps Forgot Password and existing authentication behavior.
- Displays the current application version on the login screen.

### Shared interface polish
- Refines the sidebar, top bar, navigation spacing, cards, tables, forms, panels, project statistics, client cards, buttons, and modals.
- Makes client card layouts more responsive.
- Adds subtler hover/focus behavior and more consistent rounded surfaces.
- Does not change application data, business logic, permissions, or module behavior.

### Themes remain intact
This release intentionally does **not** replace or remove the theme system. Existing themes and their assets remain available:
- Default
- Dark Geek Mode
- Light Blue Sky Beach Mode
- Green Grass with Insects
- Busy City Streets
- Calm Mountain — Bahay Kubo

The UI refresh changes shared structure and spacing while the selected theme continues to control the application's themed background, accents, and surfaces.

## Database / configuration
- No Supabase migration required.
- No new environment variables.
- No new npm dependencies.

## Suggested validation
1. Open the login page on desktop and verify the split layout.
2. Verify Account, User, Password, show/hide password, Remember me, Forgot Password, and Sign in.
3. Confirm Remember me stores only Account and User, never the password.
4. Sign in and review Action Center, Clients, Projects, Tasks, Documents, Reports, Settings, and Internal Admin for layout regressions.
5. Switch through every existing theme and confirm each theme still uses its original image/background/accent configuration.
6. Check tablet/mobile widths to confirm the login visual collapses cleanly and the app remains usable.
