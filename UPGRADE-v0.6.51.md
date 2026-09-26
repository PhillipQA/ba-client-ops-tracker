# Upgrade to v0.6.51 — centralized document templates

This release moves DRF, FSD, and Sign Off template management into **Settings → Templates** and removes template upload/replacement controls from Document Creation.

## Existing installations

1. Apply `database/migrations/schema-v15-document-templates.sql` once in Supabase SQL Editor.
2. Apply the v0.6.51 patch or deploy the v0.6.51 full build.
3. Run `npm run build`, then redeploy/restart the app.

The migration is additive to template management and preserves the existing account DRF template as template type `drf`. No client, project, task, communication, document-history, or integration records are changed.

## Template behavior

- **DRF** — account-managed `.xlsx`; no built-in fallback. If removed, DRF generation is unavailable until a replacement is uploaded.
- **FSD** — built-in iRipple layout remains the default. An Administrator may upload a custom `.docx` override in Settings. Custom FSD templates must contain `{{FSD_BODY}}` in its own paragraph. Optional markers are `{{FSD_REFERENCE}}`, `{{FSD_PRODUCT}}`, `{{FSD_FEATURE}}`, and `{{FSD_CLIENT}}`. Removing the active FSD template disables export until a replacement is uploaded or **Restore built-in** is selected.
- **Sign Off** — built-in iRipple Sign Off DOCX remains the default. A replacement DOCX must retain the standard mapping placeholders. Removing the active template disables Sign Off generation until replacement or restore.

Document Creation now reads template status only. Template file bytes remain server-side and generation uses the selected account template automatically.
