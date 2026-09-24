# Upgrade to v0.6.19

## Login panel edge-to-edge width fix

This release makes one focused correction to the v0.6.18 sign-in layout.

- `main.auth-login-panel` now uses the full width of the right-side grid column on desktop.
- Removes the desktop left/right padding that was visibly narrowing the inspected login panel.
- Keeps a small margin around the white login card itself so the form does not sit directly against the column edges.
- Applies the same full-width panel behavior through the <=1100 px desktop/tablet breakpoint.
- Keeps the mobile <=820 px spacing unchanged.
- Keeps the left hero/image panel and its desktop split unchanged.
- Keeps authentication logic, Remember me, Forgot password, Themes, theme assets, tenant data, integrations, and database schema unchanged.

No npm install, environment-variable change, or database migration is required.

After applying the patch, run `npm run build` and verify the login page at 100% browser zoom.
