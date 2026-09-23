# Upgrade to v0.6.25

Upgrade path: **v0.6.24 → v0.6.25**

This release adds multi-user activity views to the Action Center.

## Behavior

- Active Administrators and Contributors can choose **My Action Center**, **View all users**, or an individual active Administrator/Contributor.
- My Action Center includes open Tasks and Subtasks assigned to the signed-in user.
- A selected-user view includes open work assigned to that user and is read-only for Contributors. Administrators retain their existing edit access.
- View all users includes all open tenant Tasks/Subtasks, including unassigned work, across all clients.
- Follow-up tiles, the Action Center table, and workload metrics follow the chosen view.
- Viewers do not receive the cross-user selector and remain excluded from work reporting.
- Calendar and tracker schedule events remain account-shared; these records do not have an individual owner.

No npm install, new environment variable, or Supabase SQL migration is required.

## Apply the patch

```bash
npm run patch -- "path/to/ba-client-ops-patch-v0.6.25-action-center-views.zip"
npm run patch:status
npm run build
```

## Recommended validation

1. Assign active work to two different Contributors and create one unassigned task.
2. Sign in as a Contributor and confirm My Action Center shows only that user's assignments.
3. Select View all users and confirm work across clients and the unassigned task appears with assignee information.
4. Select the second Contributor and confirm only their assigned work appears and edit controls are hidden for it.
5. Sign in as an Administrator and confirm their selected-user view can open and edit a user's work.
6. Confirm Viewers do not see the cross-user selector.

## Rollback

```bash
npm run patch:rollback
```
