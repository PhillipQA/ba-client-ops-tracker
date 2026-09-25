# v0.6.42 verification

Validation was performed locally on 25 September 2026, using v0.6.41 as the release baseline.

## Build and automated checks

- `npm run build`: passed, including frontend TypeScript compilation and production bundling.
- `npm run typecheck:server`: passed.
- `node --import tsx --test tests/account-users.test.ts tests/auth-transport.test.ts tests/tenant-save-settings.test.ts`: 22 tests passed.
- Existing Vite warnings about bundle size and dependency `use client` directives remain non-blocking.

Preference tests cover all three account roles, Dark/Light/Gray saves and explicit reset, session refresh, account/user isolation, background and client-theme preservation, unchanged work records, invalid values, rejected privilege/target changes, failed writes, and stale workspace snapshot protection. A missing preference preserves the original appearance.

## Browser checks

Chromium with mocked account/integration responses was used for 31 captured views, at desktop and 390-pixel phone widths:

- Settings tabs, appearance cards, AI Agent forms, integration forms, and template controls.
- Selection persistence after reload; reset persistence; unchanged selection after a failed save.
- Keyboard tab navigation and retained unsaved form values when switching Settings sections.
- Viewer access through My Themes without account-administration permissions.
- Unchanged wallpaper CSS when changing interface mode; retained client-specific wallpaper; independent background selection.
- Dark, Light, and Gray with the default background as well as illustrated backgrounds.
- Action Center, client views, Tasks and task comments, Reports, AI Assistant, account users, RTM library and creation dialog, and document editors.
- FSD paper text, white background, heading colors, table colors, and font remained identical between Light and Dark, including a change to the operating system color preference.
- No page errors, unintended template/work mutations, or horizontal page overflow on the tested Settings phone layouts.
- A text-contrast scan of sampled visible interface text found no remaining values below 4.5:1 after corrections. This is a focused local check, not a full accessibility audit.

## Release artifacts

The release packaging check compares the full source against v0.6.41. It requires background images, theme preset definitions, template assets, document models, and server document generators to be byte-identical. Dependencies remain unchanged.

The patch includes a root `patch-manifest.json`, targets v0.6.41 → v0.6.42, and contains only changed source, tests, and documentation. It is applied to a clean extracted v0.6.41 copy and every resulting source file is compared with the v0.6.42 full build. Environment-file sentinels must remain unchanged and patch status must report 0.6.42.

## Limits

Live Render deployment, live Supabase persistence, provider API calls, and Windows PowerShell execution were not performed. Backend route tests use an in-memory tenant fixture; browser checks use simulated responses. Existing integration behavior and document generators were preserved rather than revalidated against live services.
