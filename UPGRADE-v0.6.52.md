# Upgrade to v0.6.52 — Settings template type hotfix

This hotfix fixes the TypeScript build error in **Settings → Templates** introduced in v0.6.51.

## Fix

- Narrows the **Restore built-in** action to the FSD and Sign Off template types before calling the restore handler.
- Prevents TypeScript from treating the DRF template type as a possible restore target.
- No document-template behavior, API contract, dependency, or database schema changes are included.

## Existing installations

1. If you already applied `database/migrations/schema-v15-document-templates.sql` for v0.6.51, do **not** run another migration.
2. Apply the v0.6.52 patch.
3. Run `npm run build`, then redeploy/restart the app.

If schema v15 has not yet been applied, apply it once before using the centralized template management introduced in v0.6.51.
