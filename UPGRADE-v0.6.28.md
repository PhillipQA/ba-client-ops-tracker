# Upgrade to v0.6.28 — Subtask assignment inheritance

Upgrade path: **v0.6.27 → v0.6.28**.

## What changed

- Every newly created subtask automatically receives its main task's assignee, including an unassigned main task.
- Subtasks that still follow their main task are reassigned automatically when the main task's assignee changes.
- Editing a subtask and choosing another user creates a persistent assignee override. Later main-task changes do not replace that override.
- The subtask editor includes **Same as main task** so an overridden subtask can opt back into inheritance.
- Existing subtasks are migrated safely: a subtask currently matching its main task is treated as inherited; one with a different assignee is treated as an override.
- The server enforces the creation rule and normalizes inheritance, so the behavior is consistent across current and stale browser sessions.

## Install

Back up the project and workspace data, then apply the patch from the project directory:

```powershell
npm run patch -- "E:\Playwright\ba-client-ops-patch-v0.6.28-subtask-assignment-inheritance.zip"
npm run patch:status
npm run test:subtask-assignment
npm run typecheck:server
npm run build
```

Restart locally or commit/deploy the updated project using the normal process, then refresh the browser.

No Supabase migration, new npm dependency, or environment-variable change is required.

## Smoke check

1. Create a main task assigned to User A.
2. Create a subtask and confirm User A is shown as its inherited assignee.
3. Reassign the main task to User B and confirm the subtask follows.
4. Edit the subtask, assign it to User C, then reassign the main task again; confirm the subtask remains with User C.
5. Edit the subtask and choose **Same as main task**; confirm it follows the main task again.

Rollback with `npm run patch:rollback`. No database rollback is needed.
