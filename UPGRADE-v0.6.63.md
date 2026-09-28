# BA Client Ops Tracker v0.6.63 — DRF error diagnostics

This patch upgrades v0.6.62 and records DRF failures in Supabase, including local COR reading, AI extraction, template rendering, browser download, and DocHub preparation. Each saved error has a Log ID. Open **Document Creation → DRF Creation → Recent DRF errors** to see your last 20 errors. The table stores stage, source, a short sanitized error, code, safe metadata, and time. It does not store COR text, uploaded files, template bytes, form values, or API keys.

## Existing Supabase deployment

1. In Supabase SQL Editor, run `database/migrations/schema-v18-drf-error-logs.sql` **once**. This adds the `public.drf_error_logs` table without changing existing DRFs or account data.
2. Confirm your local project is v0.6.62. Apply `ba-client-ops-patch-v0.6.63-drf-error-logs.zip` with `npm run patch -- "path-to-zip"`.
3. Run `npm run build`, restart/deploy the app, and refresh the browser.
4. Retry the DRF action. Copy the **Log ID** shown on the error, or open **Recent DRF errors** in the DRF screen.

To inspect a specific attempt in Supabase SQL Editor:

```sql
select id, created_at, tenant_id, user_id, stage, source, message, error_code, context
from public.drf_error_logs
where id = 'PASTE-LOG-ID-HERE';
```

The SQL Editor also allows `order by created_at desc limit 20` to see recent attempts. The app view is restricted to the logged-in user's tenant and user ID. If logging is unavailable, the DRF error says so; check the migration and Supabase service connection.

For a **fresh** Supabase project, use the updated `database/setup.sql` only; do not apply the migration separately. For an existing project, do not run `setup.sql`.

No npm dependencies changed.
