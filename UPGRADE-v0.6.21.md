# Upgrade to v0.6.21

Upgrade path: **v0.6.20 → v0.6.21**

This release adds User Work Tracking, specific Task/Subtask assignment, Start Date, user workload/activity reports, User Gantt, and authenticated user-aware AI context.

## Apply the patch

```bash
npm run patch -- "path/to/ba-client-ops-patch-v0.6.21-user-work-tracking.zip"
npm run patch:status
npm install
npm run build
```

No new environment variable or separate Supabase SQL migration is required. The existing tenant snapshot stores the new assignment, Start Date, and work-event fields. The server remains the authority for event actor identity.

## Recommended validation

1. Sign in as a tenant Administrator and create or edit a Task.
2. Confirm Assigned To lists only active Administrators and Contributors from the current tenant and shows workload counts.
3. Set Start Date and Due Date, then assign the Task to a Contributor.
4. Create a Subtask and assign it independently to another user.
5. Change a status to In Progress and confirm an empty Start Date is populated.
6. Open Reports and confirm User Work Tracking, Workload by User, Recent Contribution, and User Gantt.
7. Sign in as a Contributor and confirm My Action Center and Reports use that user's work scope.
8. Ask AI “What do I need to do?” and “What did I accomplish this week?” and confirm it uses the signed-in user.
9. Sign back in as Administrator and confirm team-level user filtering remains available.

## Rollback

```bash
npm run patch:rollback
```

Rollback restores application files. Data fields added to existing tenant snapshots are backward-compatible and can remain present.
