# Upgrade to v0.6.14 — Persistent Standard DRF Template

Upgrade path: **v0.6.13 → v0.6.14**.

## What changed

- Document Creation → DRF Creation now treats the account DRF workbook as a **persistent standard template** rather than a temporary per-session upload.
- An Account Administrator can upload the first standard `.xlsx` template directly from DRF Creation.
- Once saved, the template is automatically loaded whenever DRF Creation opens and is used for future DRF generation.
- Uploading another workbook asks for confirmation before replacing the current standard template.
- The current template name and last-updated time are shown in DRF Creation.
- Administrators can remove the standard template. DRF generation is disabled until another template is uploaded.
- Non-administrator document users can use the active standard template but cannot replace or remove it.
- The existing Account Settings → Templates control continues to manage the same tenant-level template.

## Storage and tenancy

This release reuses the existing `tenant_templates` storage introduced by `supabase/schema-v8-tenant-integrations.sql`. Templates remain isolated by tenant/account and survive browser restarts, Render deployments, and logins from another device.

**No new SQL migration is required** if schema v8 has already been applied.

## Template requirements

- File type: `.xlsx`
- Maximum saved template size: **5 MB**
- The workbook must be a valid Excel ZIP workbook and contain the expected iRipple DRF worksheet/cells used by the current mapper.

## Apply patch

From the existing v0.6.13 project folder:

```bat
npm run patch -- "C:\Downloads\ba-client-ops-patch-v0.6.14-persistent-drf-template.zip"
```

Then verify:

```bat
npm run patch:status
npm run build
```

Expected patch status: **0.6.14**.

## Smoke test

1. Sign in as an Account Administrator with Document Creation access.
2. Open Document Creation → DRF Creation.
3. Upload an approved `.xlsx` standard template.
4. Leave Document Creation and return; confirm the same template is still active.
5. Generate a DRF and confirm the saved template is used.
6. Upload another template and confirm the replacement prompt appears.
7. Remove the template and confirm Generate DRF is disabled until a new template is saved.
8. Sign in as a non-administrator document user and confirm the active template can be used but cannot be replaced or removed.
