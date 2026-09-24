# Upgrade to v0.6.24

Upgrade path: **v0.6.23 → v0.6.24**

This release adds the Notifications & Escalation Center and first-class Task/Subtask comments.

## Behavior

- The header bell shows the current user's unread notification count.
- All and Unread views are available to active tenant users; Administrators also receive a Team escalation view.
- Assignment, reassignment, due-today, overdue, follow-up-today, automatic follow-up movement, completion, reopening, evidence upload, and comment events can create alerts.
- Alert visibility and read, unread, dismiss, and read-all changes are enforced per recipient by the server.
- Alerts are deduplicated and retained in tenant state without trusting browser-submitted notification data.
- Existing historical events are not replayed when notifications initialize for the first time.
- Clicking an alert opens its Task or Subtask when the user has Task/Inbox edit access.
- Task and Subtask editors now allow user comments. System rollover comments remain permanent and browser saves cannot replace either trail.

## Apply the patch

```bash
npm run patch -- "path/to/ba-client-ops-patch-v0.6.24-notifications.zip"
npm run patch:status
npm run build
```

No npm install, new environment variable, or Supabase SQL migration is required.

## Recommended validation

1. Assign a Task or Subtask to another active Contributor and confirm their bell receives an assignment alert.
2. Set assigned work due today or in the past and confirm the assignee receives the alert and an Administrator sees it under Team.
3. Mark an alert read, unread, and dismissed; confirm another user's notification state is unchanged.
4. Click an alert and confirm the related work item opens.
5. Add a comment from a different user and confirm the assignee receives a New work comment alert.
6. Allow an overdue open Subtask Follow-up Date to roll forward and confirm both the permanent System comment and follow-up-moved alert appear without duplicates.

## Rollback

```bash
npm run patch:rollback
```
