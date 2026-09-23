# Upgrade to v0.6.23

Upgrade path: **v0.6.22 → v0.6.23**

This release adds server-authoritative automatic rollover for overdue, open Subtask Follow-up Dates.

## Behavior

- A Subtask with a Follow-up Date earlier than the tenant calendar day moves to the current day.
- A normal daily rollover therefore moves yesterday's Follow-up Date to today.
- Done, Resolved, Closed, configured closed statuses, `Waiting on: Done`, and records with a Resolution Date are excluded.
- Parent Tasks are never moved by this automation.
- Each change creates a permanent System comment and a `follow_up_auto_moved` work event.
- Repeated processing on the same day does not create duplicate comments or events.
- If the service was unavailable for several days, one catch-up entry records the old date, current date, and number of missed calendar days.
- System comments are preserved by the server and cannot be forged or removed through a browser save.

The default timezone is `Asia/Manila`. To use another IANA timezone, set the optional server environment variable `FOLLOW_UP_TIME_ZONE` (for example, `America/New_York`). No value is required for the default behavior.

## Apply the patch

```bash
npm run patch -- "path/to/ba-client-ops-patch-v0.6.23-follow-up-rollover.zip"
npm run patch:status
npm run build
```

No npm install or Supabase SQL migration is required.

## Recommended validation

1. Create an open Subtask with yesterday as its Follow-up Date.
2. Restart the server or load the tenant workspace.
3. Confirm its Follow-up Date is today.
4. Edit the Subtask and confirm Follow-up History contains a System entry with the old and new dates.
5. Confirm Recent Contribution/Activity includes the automatic change.
6. Reload again on the same day and confirm no duplicate entry appears.
7. Mark a second Subtask Resolved or Waiting on Done and confirm its past Follow-up Date is not moved.

## Rollback

```bash
npm run patch:rollback
```
