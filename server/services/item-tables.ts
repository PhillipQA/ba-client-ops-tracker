/**
 * Phase 4C: the tasks and inquiries tables are where tasks live. The workspace snapshot (tenant_state.data) no longer
 * holds them: it keeps `itemsInTables: true` and `itemOrder` (their ids, in order), and every load puts the items back
 * from public.tasks and public.inquiries (raw_data), read in the same statement as the snapshot. Everything else in the
 * server sees the same workspace as before.
 *
 * TASKS_SOURCE=snapshot switches back: the next save puts every item into the snapshot again, so even an older version
 * of the app reads it (see the CHANGELOG). Pure functions, so the rules can be tested without a database.
 */

export const ITEMS_IN_TABLES = 'itemsInTables'
export const ITEM_ORDER = 'itemOrder'

/** Whether saves keep tasks in their tables (the default) or in the snapshot (TASKS_SOURCE=snapshot). */
export function tablesAreSource(env: Record<string, string | undefined> = process.env) {
  return String(env.TASKS_SOURCE || 'tables').toLowerCase() !== 'snapshot'
}

const itemId = (item: any) => String(item?.id ?? '')

/** The snapshot as stored with tasks in their tables: no items, only their order. */
export function snapshotWithoutItems(state: any) {
  const items = Array.isArray(state?.items) ? state.items : []
  return { ...state, items: [], [ITEM_ORDER]: items.map(itemId), [ITEMS_IN_TABLES]: true }
}

/** The snapshot as stored with tasks inside it (as before Phase 4C, or after switching back). */
export function snapshotWithItems(state: any) {
  const { [ITEM_ORDER]: _order, [ITEMS_IN_TABLES]: _flag, ...rest } = state || {}
  return rest
}

/**
 * The workspace from a stored snapshot and, when it says its tasks are in their tables, the rows read from them. Items
 * keep the stored order; any not in it (none, unless a row was written elsewhere) follow. Refuses to return a
 * workspace with no tasks when the snapshot lists some, so a failed read can never be saved over them.
 */
export function workspaceFromStored(snapshot: any, tableItems: unknown) {
  const inTables = snapshot?.[ITEMS_IN_TABLES] === true
  const state = snapshotWithItems(snapshot)
  if (!inTables) return { state, inTables }
  const order: string[] = Array.isArray(snapshot?.[ITEM_ORDER]) ? snapshot[ITEM_ORDER].map(String) : []
  const rows = (Array.isArray(tableItems) ? tableItems : []).filter(row => row && typeof row === 'object')
  if (order.length && !rows.length)
    throw new Error('The tasks could not be read from their tables. Nothing was changed; try again.')
  const position = new Map(order.map((id, index) => [id, index]))
  const items = rows
    .map((row, index) => ({ row, at: position.get(itemId(row)) ?? order.length + index }))
    .sort((a, b) => a.at - b.at)
    .map(entry => entry.row)
  return { state: { ...state, items }, inTables }
}

/**
 * How a save writes tasks, from where they are now (`wasInTables`), where they should be (`wantTables`), and whether
 * the caller syncs the record tables (`synchronize`; account snapshots do not):
 * - `toTables`: the snapshot is stored without items. Moving them there takes a full write of every record, which only
 *   a synchronizing save does, so the switch happens on one of those.
 * - `changedRows`: try the changed-rows save (schema v46); `onlyTables` limits it to the task tables when the caller
 *   does not sync the others.
 * - When that is not possible and the full save runs instead, items stay in the tables only if every record is
 *   written (`synchronize`); otherwise they go back into the snapshot, which is then complete on its own.
 */
export function itemsWritePlan(options: { wantTables: boolean; wasInTables: boolean; synchronize: boolean }) {
  const toTables = options.wantTables && (options.wasInTables || options.synchronize)
  const switching = toTables && !options.wasInTables
  return {
    toTables,
    changedRows: !switching && (options.synchronize || options.wasInTables),
    onlyTables: options.synchronize ? undefined : (['tasks', 'inquiries'] as const),
    fullSaveKeepsTables: toTables && options.synchronize,
    syncRecordsOnFullSave: options.synchronize,
  }
}

/** Two items with one id would land in different tables (a task and an inquiry) without the snapshot check. */
export function duplicateItemId(state: any) {
  const seen = new Set<string>()
  for (const item of Array.isArray(state?.items) ? state.items : []) {
    const id = itemId(item)
    if (seen.has(id)) return id
    seen.add(id)
  }
  return null
}
