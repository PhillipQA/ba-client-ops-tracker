# BA Client Ops Tracker v0.6.69 — Activity comment pagination

This patch upgrades v0.6.68. Task and subtask **Activity comments** no longer render the entire activity history at once.

The activity trail is still sorted newest first, but it now shows **3 entries by default**. Users can choose **2, 3, or 5** entries per page and use **Previous / Next** to browse older comments. The total-count badge continues to show the complete number of comments. Adding a new comment returns the list to page 1 so the newly added entry is immediately visible.

This keeps the task/subtask editor substantially shorter when DocHub signing updates, follow-up rollover entries, and user comments accumulate, making the Save changes / completion controls easier to reach.

## Upgrade

1. Confirm `package.json` shows v0.6.68.
2. Run `npm run patch -- "path-to-ba-client-ops-patch-v0.6.69-activity-comments-pagination.zip"` from the project directory.
3. Run `npm run build`, restart the app, redeploy the updated source, and refresh the browser.
4. Open a task/subtask with more than five Activity comments. Confirm the newest 3 appear first, switch between 2 / 3 / 5, and verify Previous / Next changes pages without altering or deleting any history.

No database migration or dependency install is required.
