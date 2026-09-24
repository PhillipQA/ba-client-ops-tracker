# Upgrade to v0.6.26

Upgrade path: **v0.6.25 → v0.6.26**

This hotfix corrects a Task/Subtask edit that appeared to save from Action Center but was rejected by the server and lost after refresh. Older tenant Task configuration can omit the Start Date display column, while the client automatically inserts it. Regular saves now retain the server's authoritative configuration. Changes to statuses and columns still belong to Internal Admin.

The Task/Subtask editor now waits for Supabase confirmation before closing. If the server rejects a save, the editor stays open and displays the error; the unsaved change is not presented as committed.

Apply to v0.6.25:

```bash
npm run patch -- "path/to/ba-client-ops-patch-v0.6.26-action-center-save-hotfix.zip"
npm run patch:status
npm run build
```

Test a Task and a Subtask edit from My Action Center and View all users, refresh the page, and confirm each change remains. For a failure-path check, temporarily disconnect the server from storage in a nonproduction environment and confirm the editor stays open with an error.

No `npm install`, environment change, or Supabase migration is required. Restart/redeploy the server as well as refreshing the browser because the fix spans server and client code.

Rollback: `npm run patch:rollback`. Rollback restores code, not Task data already saved after upgrading.
