# Upgrade to v0.6.22

Upgrade path: **v0.6.21 → v0.6.22**

This focused hotfix makes Subtask Start Date clearly visible throughout the workflow.

## Included

- A dedicated Schedule section in Create Task/Subtask and Edit Task/Subtask.
- Start Date, Due Date, and Follow-up Date grouped together.
- Start and Due values shown directly beneath each Subtask title.
- Start Date forced into Task/Subtask tables when an older saved column preference does not contain it.
- Existing Start Date validation, automatic start behavior, reports, Gantt, activity tracking, and AI context remain unchanged.

## Apply the patch

```bash
npm run patch -- "path/to/ba-client-ops-patch-v0.6.22-subtask-start-date-hotfix.zip"
npm run patch:status
npm run build
```

No npm install, environment-variable change, or Supabase migration is required.

## Recommended validation

1. Open a parent Task and select Create Subtask.
2. Confirm the **Subtask schedule** section contains Start Date, Due Date, and Follow-up Date.
3. Save a Start Date and reopen Edit Subtask to confirm it persists.
4. Confirm the Subtask row shows its Start and Due values under the title.
5. Confirm the Start Date table column is present.

## Rollback

```bash
npm run patch:rollback
```
