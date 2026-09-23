# Upgrade to v0.6.31 — Client layout options

Upgrade path: **v0.6.30 → v0.6.31**.

## What changed

- Clients can be viewed as Tiles (the existing layout), List, or Table.
- Search matches client names, contacts, email addresses, and notes. The Active / Archived / All filter still applies.
- Sort by name A–Z, name Z–A, most open tasks, or next follow-up. Clients without a follow-up appear last in that sort.
- Each signed-in user's layout choice is saved for that account in the current browser. Search and sort reset on refresh.
- Opening and editing clients remains available in all three layouts. The Table scrolls horizontally on narrow screens.

No database migration, environment change, or new npm dependency is required. Client data is unchanged.

## Install

From `E:\Playwright\ba-client-ops-tracker`, run:

```powershell
npm run patch -- "E:\Playwright\ba-client-ops-patch-v0.6.31-client-layouts.zip"
npm run patch:status
npm run build
```

Restart locally or deploy the updated code through your normal process. A fresh full-build installation still needs `npm ci`.

## Check

Open Clients, switch between Tiles, List, and Table, then search and sort clients. Confirm each layout opens a client and exposes Edit where your role allows it. Refresh to confirm the layout choice remains selected. Check the Table on a narrow screen by scrolling horizontally.

The production build compiled with `npm run build`. Roll back the patch with `npm run patch:rollback` if needed.
