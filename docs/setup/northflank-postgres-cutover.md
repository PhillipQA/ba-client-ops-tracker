# Move the tracker from Supabase to Northflank PostgreSQL

This release supports `DATABASE_PROVIDER=postgres`. The database connection is server side. Browser sessions and stored passwords remain in your imported PostgreSQL data. Task evidence files need a separate copy because PostgreSQL dumps of `public` do not include Supabase Storage objects.

## Prepare the database

1. Confirm that the Supabase project in the running service's `SUPABASE_URL` is the project exported to Northflank. An earlier connection string used a different project ref; compare the actual refs before cutover.
2. Stop writes to the old app during the final export and import, or repeat the restore immediately before switching. A green Northflank restore from an earlier dump is a snapshot, not continuous replication.
3. Restore the final Supabase `public` schema and data to the Northflank PostgreSQL addon. Keep a backup of the previous database and the unchanged Supabase project until the new app has been verified.
4. In a one-off secure service shell, set `PG_ADMIN_URL` to the addon's `POSTGRES_URI_ADMIN` (without saving it as a permanent service variable) and run `npm run db:prepare-postgres`. This creates the evidence table, grants the standard `POSTGRES_URI` user access, and disables imported Supabase row policies on the private destination tables. It runs in one transaction and leaves Supabase untouched. Keep `TENANT_INTEGRATION_MASTER_KEY` exactly the same so encrypted integrations remain readable.

## Check and transfer

Use a one-off secure shell or temporary Northflank job with `DATABASE_URL` set to the Northflank addon URI and `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` set to the *currently running* source project. Do not paste their values into a ticket or commit them.

```bash
npm ci
npm run db:prepare-postgres
npm run db:verify-migration
npm run db:migrate-evidence
```

The comparison checks account, workspace, integration, and Git provider row counts plus each workspace revision. It fails if the source and destination do not match. The evidence script copies every file referenced by the imported workspace to `public.tracker_evidence_files`; rerunning it updates existing copies. If either command fails, keep the old app live and resolve the mismatch or missing file first.

## Switch the service

1. Deploy this source and build with `npm ci && npm run build`; run with `npm start`.
2. In the Northflank service environment, keep its inherited `DATABASE_URL`, add `DATABASE_PROVIDER=postgres`, and redeploy. Keep the existing `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` until the verification above and the live smoke test pass. The PostgreSQL mode does not use them.
3. Sign in and check the Internal Admin account, a tenant workspace, an existing task evidence download, and saving a harmless edit. Check Gmail, GitHub/GitLab, and any configured integrations you use.
4. Remove the two Supabase variables from the Northflank service and any linked secret group only after the new service works. Then redeploy once more. Do not delete the Supabase project until you are satisfied with the backup and rollout.

If verification fails after the switch, remove `DATABASE_PROVIDER` and redeploy to resume the prior Supabase path. Writes made to PostgreSQL after the switch do not automatically copy back to Supabase, so handle those records before rolling back.
