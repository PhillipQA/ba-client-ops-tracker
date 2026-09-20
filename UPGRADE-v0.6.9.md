# BA Client Ops Tracker v0.6.9 — Client/project editor fix

Requires **v0.6.8**. No new dependencies, SQL migrations, or environment changes.

## What was wrong

The v0.6.8 editor was rendered inside a themed panel. That panel used backdrop blur and overflow clipping, trapping the fixed popup inside the panel and hiding the name field and other controls.

## What changes

- **Edit client** is visible directly on each client card and beside its detail-page title.
- **Edit project** is visible in every project row and beside its detail-page title.
- Both open a native modal dialog in the browser's top layer, outside panel clipping and stacking contexts.
- Client / Project name is the first, full-width field. Editable names receive focus with their text selected.
- The popup has an opaque, readable surface, a header with Close, a scrollable form, and a persistent footer with **Cancel** and **Save changes**. Narrow screens use one column.
- Escape and Cancel close without saving. Keyboard focus stays in the modal and returns to its opener after closing. Background scrolling is locked while the popup is open.
- The oversized archive explanation panel is replaced by a compact availability bar. Archive requirements remain expandable.

Client name changes remain Administrator-only with Clients access. Contributors with Clients access can open the editor and see the name as read-only while editing other details. Project names remain editable by Administrators/Contributors with Projects access. Viewers have no edit controls. Archive checks, saved IDs, history, tenant data, and backend permissions are unchanged.

## Install

Stop the app. Save `ba-client-ops-patch-v0.6.9-from-v0.6.8.zip` in `E:\Playwright`. From `E:\Playwright\ba-client-ops-tracker`, run:

```bat
npm run patch -- "E:\Playwright\ba-client-ops-patch-v0.6.9-from-v0.6.8.zip"
npm run build
npm run dev
```

Refresh the browser after restarting. For Render, commit the updated source to its connected repository and redeploy; a local patch alone does not update the hosted site. The full-build ZIP is an alternative source checkout; see README.md for fresh setup.

## Verify in your browser

1. With the Dark Geek theme, open Clients and click **Edit client** on a card. Confirm the name, Close, Cancel, and Save changes are visible.
2. As Administrator, rename the client and save. Confirm the name updates on its card, detail title, and linked views and survives reload.
3. Repeat for a project, using both its table-row Edit button and the button beside its title.
4. Open the editor on a narrow window. Scroll the fields and verify the Save/Cancel footer remains accessible.
5. Open the editor again, make a change, and press Escape or Cancel; confirm it was not saved. Tab through the dialog and check focus returns after closing.
6. As Contributor, confirm client name is visibly read-only and project name is editable with Projects access. Confirm Viewers cannot open an editor.

## Validation

Production build, server TypeScript check, and all 14 existing lifecycle/permission tests passed. Patch apply, exact payload comparison, environment preservation, version guard, and rollback were checked with the actual updater.

Browser rendering/interaction and live deployment were not verified in this environment because no browser executable was installed and the browser-package download endpoint was unavailable. The specific clipping cause is addressed by using a native top-layer dialog; complete the checks above on your installation.

## Roll back

Stop the app and run `npm run patch:rollback`, then rebuild/redeploy. This restores the v0.6.8 UI, including its editor clipping issue. Renames already saved remain saved.
