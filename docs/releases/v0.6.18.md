# Upgrade to v0.6.18

## Login width refinement

This release makes one focused visual correction to the v0.6.17 sign-in screen.

- Keeps the left hero/image panel and its 58.3% desktop width unchanged.
- Widens the right-side login card to use the available content width.
- Keeps approximately 48 px (about half an inch at CSS 96 dpi) of left and right panel spacing on standard desktop layouts.
- Keeps the existing centered branding, fields, Remember me, Forgot password, OR divider, security note, version label, and authentication behavior.
- Does not change the Themes system, theme assets, tenant data, integrations, or database schema.

No npm install, environment-variable change, or database migration is required.

After applying the patch, run `npm run build` and verify the login page at 100% browser zoom.
