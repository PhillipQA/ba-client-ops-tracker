/**
 * Bringing a connected Sheet's rows into its tracker (runSync), and following boxes ticked in the Sheet.
 */
import { randomUUID } from 'node:crypto'
import {
  type TrackerSource,
  type SyncReport,
  TrackerError,
  normalizeColumns,
  type TrackerColumn,
  TRACKER_LIMITS,
} from '../../src/features/trackers/trackerModel'
import {
  SYNC_LIMITS,
  unchangedFile,
  planNewColumns,
  mergeDropdownOptions,
  convertRowsToChoice,
  planSync,
  describeSync,
} from '../../src/features/trackers/trackerSync'
import { type RowChange, tickChanges, cellSubtaskPatches } from '../../src/features/trackers/cellSubtasks'
import type { Deps, User } from './tracker-common'
import type { TrackerCore } from './tracker-core'
import type { TrackerSheetAccess, GanttState } from './tracker-source'
import type { TrackerSheetComments } from './tracker-sheet-comments'

export function trackerSync(
  deps: Deps,
  core: TrackerCore,
  sheetAccess: TrackerSheetAccess,
  sheetComments?: TrackerSheetComments,
) {
  const { db, now, columnsOf, check, record, workspace, mergeCells, touch } = core
  const {
    sourceRow,
    lastSync,
    sourceOut,
    googleFor,
    canReadSheets,
    sourceIsExcel,
    driveFile,
    canWriteSheets,
    ganttEditsToTab,
    sourceGrid,
    sourceCheck,
    dropdownLists,
    allRows,
    redrawGantt,
  } = sheetAccess
  /** Reads the Sheet and applies the changes. `force` skips the one-minute pause between syncs. */
  async function runSync(
    tenant: string,
    tracker: any,
    user: User,
    force: boolean,
  ): Promise<{
    source: TrackerSource
    report: SyncReport | null
    skipped?: boolean
    /** Skipped because the Excel file has not changed since the last sync. */
    unchanged?: boolean
    tasks?: number
  }> {
    const source = await sourceRow(tenant, tracker.id)
    if (!source) throw new TrackerError('This tracker is not connected to a Google Sheet.', 404)
    const key = `${tenant}:${tracker.id}`
    if (!force && Date.now() - (lastSync.get(key) || 0) < SYNC_LIMITS.minSeconds * 1000)
      return { source: sourceOut(source), report: source.last_report || null, skipped: true }
    lastSync.set(key, Date.now())
    const fail = async (message: string) => {
      await db
        .from('tenant_tracker_sources')
        .update({ last_status: 'error', last_error: message.slice(0, 500), updated_at: now() })
        .eq('tenant_id', tenant)
        .eq('tracker_id', tracker.id)
    }
    let grid: string[][]
    let token = ''
    let scope: unknown = ''
    let excel = false
    let fileVersion = ''
    let gantt: GanttState | null = null
    try {
      const access = await googleFor(tenant, source.connected_by)
      token = access.token
      scope = access.scope
      if (!canReadSheets(access.scope))
        throw new TrackerError(
          `${source.connected_by_name || 'The person who connected this Sheet'} needs to allow Google Sheets again. Anyone who can open the Sheet can reconnect it.`,
          409,
          { noAccess: true },
        )
      excel = await sourceIsExcel(access.token, source)
      // An Excel file that has not changed in Drive since the last good sync is not downloaded or read again: nothing
      // in the tracker would change. Sync now (force) still reads it.
      if (excel) {
        fileVersion = (await driveFile(access.token, source.spreadsheet_id))?.version || ''
        if (unchangedFile(source, fileVersion, force))
          return { source: sourceOut(source), report: source.last_report || null, skipped: true, unchanged: true }
      }
      // Edits made in the Gantt chart tab go to the synced tab first, so this sync brings them in. Never fails the sync.
      if (!excel && canWriteSheets(access.scope))
        gantt = await ganttEditsToTab(access.token, source, tracker).catch((error: any) => {
          console.error('Reading the Gantt chart tab failed:', error?.message || error)
          return null
        })
      grid = await sourceGrid(access.token, access.scope, source)
    } catch (error) {
      await fail(error instanceof Error ? error.message : 'The Sheet could not be read.')
      throw error
    }
    // Columns added to the Sheet since the last sync become tracker columns, followed from now on (see planNewColumns).
    const grown = planNewColumns({
      grid,
      headerMap: source.header_map || {},
      keyHeader: source.key_header,
      columns: columnsOf(tracker),
      today: now().slice(0, 10),
      firstSync: !source.last_synced_at,
    })
    if (grown.changed) {
      const stamp = now()
      if (grown.columns.length) {
        const nextColumns = normalizeColumns([...columnsOf(tracker), ...grown.columns], columnsOf(tracker))
        const savedColumns = await db
          .from('tenant_trackers')
          .update({ columns: nextColumns, revision: Number(tracker.revision || 1) + 1, updated_at: stamp })
          .eq('tenant_id', tenant)
          .eq('id', tracker.id)
        check(savedColumns.error)
        tracker = { ...tracker, columns: nextColumns, revision: Number(tracker.revision || 1) + 1 }
      }
      const savedMap = await db
        .from('tenant_tracker_sources')
        .update({ header_map: grown.headerMap, updated_at: stamp })
        .eq('tenant_id', tenant)
        .eq('tracker_id', tracker.id)
      sourceCheck(savedMap.error)
      source.header_map = grown.headerMap
      if (grown.added.length) await record(tenant, tracker.id, '', user, 'columns', { addedFromSheet: grown.added })
    }
    // The Sheet's dropdown choices, so options no row uses yet come over too. Best effort: a sync never fails on it.
    const dropdowns = mergeDropdownOptions(
      columnsOf(tracker),
      source.header_map || {},
      excel ? {} : await dropdownLists(token, source, grid, columnsOf(tracker)).catch(() => ({})),
    )
    const existing = await allRows(tenant, tracker.id)
    // Text and Checkbox columns that follow a Sheet dropdown just became Choice columns: move their values to the new options
    // first, for every row (rows only the tracker has too), so no cell is left holding plain text.
    if (dropdowns.converted.length) {
      const moved = convertRowsToChoice(
        dropdowns.columns,
        dropdowns.converted,
        existing.map(row => ({ id: row.id, data: row.data || {} })),
      )
      const stamp = now()
      // The column first: if this stops part-way, the next sync finds the leftover text and matches it again.
      // normalizeColumns refuses type changes against `previous`, so this one sync-made change is given as already made.
      const previous = columnsOf(tracker).map(column =>
        dropdowns.converted.includes(column.id)
          ? ({ ...column, type: 'select', options: [] } as TrackerColumn)
          : column,
      )
      const convertedColumns = normalizeColumns(moved.columns, previous)
      dropdowns.columns = convertedColumns
      const savedColumns = await db
        .from('tenant_trackers')
        .update({
          columns: convertedColumns,
          revision: Number(tracker.revision || 1) + 1,
          updated_at: stamp,
        })
        .eq('tenant_id', tenant)
        .eq('id', tracker.id)
      check(savedColumns.error)
      tracker = { ...tracker, columns: convertedColumns, revision: Number(tracker.revision || 1) + 1 }
      for (const row of existing) {
        const cells = moved.changes.get(row.id)
        if (!cells) continue
        row.data = { ...(row.data || {}), ...cells }
        row.version = Number(row.version || 1) + 1
        const saved = await db
          .from('tenant_tracker_rows')
          .update({ data: row.data, version: row.version, updated_at: stamp })
          .eq('tenant_id', tenant)
          .eq('tracker_id', tracker.id)
          .eq('id', row.id)
        sourceCheck(saved.error)
      }
    }
    const state = await workspace(tenant)
    const people = (Array.isArray(state.accounts) ? state.accounts : []).map((account: any) => ({
      id: String(account.id),
      name: String(account.name || ''),
      email: account.email,
      username: account.username,
    }))
    const planned = planSync({
      grid,
      keyHeader: source.key_header,
      headerMap: source.header_map || {},
      columns: dropdowns.columns,
      rows: existing.map(row => ({
        id: row.id,
        sourceKey: row.source_key || '',
        data: row.data || {},
        values: row.source_values || {},
        missing: Boolean(row.source_missing),
      })),
      people,
      today: now().slice(0, 10),
      capacity: TRACKER_LIMITS.rows - existing.length,
    })
    if ('error' in planned) {
      await fail(planned.error)
      throw new TrackerError(planned.error, 409)
    }
    const stamp = now()
    let columns = columnsOf(tracker)
    if (planned.columnsChanged || dropdowns.changed) {
      columns = normalizeColumns(planned.columns, columnsOf(tracker))
      const saved = await db
        .from('tenant_trackers')
        .update({ columns, revision: Number(tracker.revision || 1) + 1, updated_at: stamp })
        .eq('tenant_id', tenant)
        .eq('id', tracker.id)
      check(saved.error)
    }
    let position = existing.reduce((max, row) => Math.max(max, Number(row.position) || 0), 0)
    for (let at = 0; at < planned.inserts.length; at += TRACKER_LIMITS.importBatch) {
      const records = planned.inserts.slice(at, at + TRACKER_LIMITS.importBatch).map(entry => ({
        tenant_id: tenant,
        tracker_id: tracker.id,
        id: randomUUID(),
        position: ++position,
        data: mergeCells({}, columns, entry.cells),
        secrets: {},
        task_id: '',
        version: 1,
        created_by: source.connected_by,
        updated_by: source.connected_by,
        created_at: stamp,
        updated_at: stamp,
        source_key: entry.key,
        source_values: entry.values,
        source_missing: false,
        review: true,
      }))
      const saved = await db.from('tenant_tracker_rows').insert(records)
      sourceCheck(saved.error)
    }
    const byId = new Map(existing.map(row => [row.id, row]))
    const returned = new Set(planned.returned)
    const fromSheet: RowChange[] = []
    for (const update of planned.updates) {
      const current = byId.get(update.id)
      if (!current) continue
      const changed = Object.keys(update.cells).length > 0
      const patch: Record<string, unknown> = {
        source_values: update.values,
        ...(returned.has(update.id) ? { source_missing: false } : {}),
      }
      if (changed)
        Object.assign(patch, {
          data: mergeCells(current.data || {}, columns, update.cells),
          version: Number(current.version || 1) + 1,
          updated_at: stamp,
        })
      const saved = await db
        .from('tenant_tracker_rows')
        .update(patch)
        .eq('tenant_id', tenant)
        .eq('tracker_id', tracker.id)
        .eq('id', update.id)
      sourceCheck(saved.error)
      if (changed) fromSheet.push({ rowId: update.id, before: current.data || {}, after: patch.data as any })
    }
    // Boxes ticked or unticked in the Sheet complete or reopen the subtasks in those cells. Never fails the sync.
    const tasks = await followSheetTicks(tenant, tracker.id, columns, fromSheet, user).catch((error: any) => {
      console.error('Completing subtasks from Sheet ticks failed:', error?.message || error)
      return 0
    })
    for (const id of planned.returned)
      if (!planned.updates.some(update => update.id === id))
        await db
          .from('tenant_tracker_rows')
          .update({ source_missing: false })
          .eq('tenant_id', tenant)
          .eq('tracker_id', tracker.id)
          .eq('id', id)
    if (planned.missing.length) {
      const saved = await db
        .from('tenant_tracker_rows')
        .update({ source_missing: true })
        .eq('tenant_id', tenant)
        .eq('tracker_id', tracker.id)
        .in('id', planned.missing)
      sourceCheck(saved.error)
    }
    // Cell comments: the tab's comments come to the tracker's cells, and comments written in the tracker go to the
    // Sheet (Google Sheets only). Never fails the sync.
    const comments = sheetComments
      ? await sheetComments
          .syncComments({ tenant, tracker: { ...tracker, columns }, source, grid, token, scope, excel, user })
          .catch((error: any) => {
            console.error('Syncing cell comments failed:', error?.message || error)
            return null
          })
      : null
    const report = {
      ...planned.report,
      ...(comments && (comments.added || comments.updated || comments.removed)
        ? { comments: { added: comments.added, updated: comments.updated, removed: comments.removed } }
        : {}),
      ...(grown.added.length ? { addedColumns: grown.added } : {}),
      ...(fileVersion ? { fileVersion } : {}),
    }
    const done = await db
      .from('tenant_tracker_sources')
      .update({ last_synced_at: stamp, last_status: 'ok', last_error: '', last_report: report, updated_at: stamp })
      .eq('tenant_id', tenant)
      .eq('tracker_id', tracker.id)
    sourceCheck(done.error)
    if (report.added || report.updated || report.missing || report.returned) {
      await record(tenant, tracker.id, '', user, 'sheet_synced', { summary: describeSync(report), ...report })
      await touch(tenant, tracker.id)
    }
    // The Gantt tab shows the synced tab again (with fresh snapshots), including what changed in the tracker.
    if (gantt)
      await redrawGantt(token, source, gantt).catch((error: any) =>
        console.error('Redrawing the Gantt chart tab failed:', error?.message || error),
      )
    return {
      source: sourceOut({ ...source, last_synced_at: stamp, last_status: 'ok', last_error: '', last_report: report }),
      report,
      // Tasks completed or reopened from Sheet ticks: the browser reloads the workspace to show them.
      ...(tasks ? { tasks } : {}),
    }
  }

  /**
   * Checkbox cells changed by a sync: the subtask in each one is completed when the box was ticked and reopened when it
   * was unticked (see cellSubtasks), as the person who synced. Returns how many tasks changed.
   */
  async function followSheetTicks(
    tenant: string,
    trackerId: string,
    columns: TrackerColumn[],
    changes: RowChange[],
    user: User,
  ) {
    if (!deps.updateTasks || !changes.length) return 0
    const ticked = changes.filter(change => tickChanges(columns, change.before, change.after).length)
    if (!ticked.length) return 0
    const links: any[] = []
    const rowIds = ticked.map(change => change.rowId)
    for (let at = 0; at < rowIds.length; at += 200) {
      // Before schema v25 there is no links table, and no subtasks in cells.
      const found = await db
        .from('tenant_tracker_task_links')
        .select('*')
        .eq('tenant_id', tenant)
        .eq('tracker_id', trackerId)
        .in('row_id', rowIds.slice(at, at + 200))
      if (found.error) return 0
      links.push(...(found.data || []))
    }
    const patches = cellSubtaskPatches(
      columns,
      ticked,
      links.map(link => ({ rowId: String(link.row_id), columnId: link.column_id, taskId: String(link.task_id) })),
    )
    if (!patches.length) return 0
    return deps.updateTasks(tenant, patches, user, 'the Google Sheet')
  }

  return { runSync }
}

export type TrackerSyncPart = ReturnType<typeof trackerSync>
