/**
 * Keeping trackers and tasks in step: rows marked done when their tasks finish, task fields copied into rows,
 * and cells that complete or reopen subtasks. onWorkspaceSaved runs these after every workspace save.
 */
import type { TrackerColumn, Cell } from '../../src/features/trackers/trackerModel'
import { rowCellsFromTask, taskFieldChanges } from '../../src/features/trackers/trackerTasks'
import {
  SHEET_ISSUES,
  autoDoneColumn,
  planAutoDone,
  completionChanges,
  isClosedStatus,
} from '../../src/features/trackers/trackerAutoDone'
import type { User } from './tracker-common'
import type { TrackerCore } from './tracker-core'
import type { TrackerSheetAccess } from './tracker-source'
import type { TrackerSheetWrite, SheetResult, Actor } from './tracker-sheet-write'

export function trackerFollow(core: TrackerCore, sheetAccess: TrackerSheetAccess, sheetWrite: TrackerSheetWrite) {
  const { columnsOf, db, record, shown, mergeCells, now, check, touch } = core
  const { sourceRow } = sheetAccess
  const { headerFor, issueOf, writeToSheet } = sheetWrite
  /**
   * Stores a row's new auto-done value (and, when it went to the Sheet, the Sheet text as the new baseline), or the
   * reason it could not reach the Sheet. Guarded by the row version; false when the row changed in the meantime.
   */
  async function saveAutoDone(
    tenant: string,
    tracker: any,
    column: TrackerColumn,
    row: any,
    value: Cell,
    sheet: SheetResult | undefined,
    actor: Actor,
    detail: Record<string, unknown>,
  ) {
    const columns = columnsOf(tracker)
    const header = sheet ? headerFor(await sourceRow(tenant, tracker.id), column.id) : ''
    if (sheet && !sheet.ok) {
      const saved = await db
        .from('tenant_tracker_rows')
        .update({ sheet_issue: issueOf(sheet.code, value) })
        .eq('tenant_id', tenant)
        .eq('tracker_id', tracker.id)
        .eq('id', row.id)
      if (saved.error) console.error('A Sheet problem could not be stored on the row. Check the database connection.')
      await record(tenant, tracker.id, row.id, actor as User, 'auto_done_sheet_failed', {
        ...detail,
        name: column.name,
        to: shown(column, value),
        issue: sheet.code,
        message: SHEET_ISSUES[sheet.code],
      })
      return true
    }
    const version = Number(row.version || 1)
    const patch: Record<string, unknown> = {
      data: mergeCells(row.data || {}, columns, { [column.id]: value }),
      version: version + 1,
      updated_by: actor.id,
      updated_at: now(),
    }
    if (sheet?.ok && header) patch.source_values = { ...(row.source_values || {}), [header]: sheet.text }
    if (row.sheet_issue) patch.sheet_issue = null
    const saved = await db
      .from('tenant_tracker_rows')
      .update(patch)
      .eq('tenant_id', tenant)
      .eq('tracker_id', tracker.id)
      .eq('id', row.id)
      .eq('version', version)
      .select('id')
    check(saved.error)
    if (!saved.data?.length) return false
    await record(tenant, tracker.id, row.id, actor as User, 'auto_done', {
      ...detail,
      name: column.name,
      from: shown(column, row.data?.[column.id]),
      to: shown(column, value),
      ...(sheet?.ok ? { sheet: true } : {}),
    })
    return true
  }

  async function autoDoneTracker(
    tenant: string,
    trackerId: string,
    rowIds: string[],
    changes: Map<string, boolean>,
    closed: (taskId: string) => boolean | undefined,
    titles: Map<string, string>,
    actor: Actor,
  ) {
    const found = await db.from('tenant_trackers').select('*').eq('tenant_id', tenant).eq('id', trackerId).maybeSingle()
    if (found.error || !found.data || found.data.archived_at) return
    const tracker = found.data
    const column = autoDoneColumn(columnsOf(tracker))
    if (!column) return
    const loadRows = async (ids: string[]) => {
      const rows: any[] = []
      for (let at = 0; at < ids.length; at += 200) {
        const r = await db
          .from('tenant_tracker_rows')
          .select('*')
          .eq('tenant_id', tenant)
          .eq('tracker_id', trackerId)
          .in('id', ids.slice(at, at + 200))
        check(r.error)
        rows.push(...(r.data || []))
      }
      return rows
    }
    const linksFor = new Map<string, string[]>()
    for (let at = 0; at < rowIds.length; at += 200) {
      const r = await db
        .from('tenant_tracker_task_links')
        .select('*')
        .eq('tenant_id', tenant)
        .eq('tracker_id', trackerId)
        .in('row_id', rowIds.slice(at, at + 200))
      for (const link of r.error ? [] : r.data || [])
        linksFor.set(link.row_id, [...(linksFor.get(link.row_id) || []), String(link.task_id)])
    }
    const plan = (row: any) =>
      planAutoDone({
        column,
        current: row.data?.[column.id],
        linked: [row.task_id || '', ...(linksFor.get(row.id) || [])],
        closed,
        changes,
      })
    let source: any = null
    if (column.synced) source = await sourceRow(tenant, trackerId)
    let pending = rowIds
    let changed = false
    // Twice at most: a row edited by someone at the same moment is read again and planned again.
    for (let attempt = 0; attempt < 2 && pending.length; attempt += 1) {
      const planned = (await loadRows(pending))
        .map(row => ({ row, next: plan(row) }))
        .filter((entry): entry is { row: any; next: NonNullable<ReturnType<typeof plan>> } => entry.next !== null)
      if (!planned.length) break
      const toSheet = source ? planned.filter(entry => entry.row.source_key) : []
      const sheet = toSheet.length
        ? await writeToSheet(
            tenant,
            source,
            column,
            toSheet.map(entry => ({ row: entry.row, value: entry.next.value })),
            actor.id ? actor : null,
          )
        : new Map<string, SheetResult>()
      const retry: string[] = []
      for (const { row, next } of planned) {
        const detail = {
          reason: next.reason,
          tasks: next.taskIds.map(id => titles.get(id) || 'a task').slice(0, 5),
        }
        const ok = await saveAutoDone(tenant, tracker, column, row, next.value, sheet.get(row.id), actor, detail)
        if (ok) changed = true
        else retry.push(row.id)
      }
      pending = retry
    }
    if (changed) await touch(tenant, trackerId)
  }

  /**
   * Rows that mirror a field of their task (see trackerTasks): after a save, a task's new title, start or due date is
   * copied to its row, and progress goes to 100 when the task is completed. Columns that come from a two-way Sheet are
   * written there too, as the person who saved (best effort; the next sync settles any difference).
   */
  async function followTaskFields(
    tenant: string,
    fields: Map<string, { title?: string; startDate?: string; dueDate?: string }>,
    completed: Map<string, boolean>,
    actor: Actor,
  ) {
    const ids = [...new Set([...fields.keys(), ...completed.keys()])]
    const byTracker = new Map<string, any[]>()
    for (let at = 0; at < ids.length; at += 200) {
      const found = await db
        .from('tenant_tracker_rows')
        .select('*')
        .eq('tenant_id', tenant)
        .in('task_id', ids.slice(at, at + 200))
      for (const row of found.error ? [] : found.data || [])
        byTracker.set(row.tracker_id, [...(byTracker.get(row.tracker_id) || []), row])
    }
    for (const [trackerId, rows] of byTracker) {
      const loaded = await db
        .from('tenant_trackers')
        .select('*')
        .eq('tenant_id', tenant)
        .eq('id', trackerId)
        .maybeSingle()
      const tracker = loaded.data
      if (!tracker || tracker.archived_at) continue
      const columns = columnsOf(tracker)
      if (!columns.some(column => column.taskField)) continue
      let changed = false
      const toSheet = new Map<string, { row: any; value: Cell }[]>()
      for (const row of rows) {
        const cells = rowCellsFromTask(columns, row.data || {}, fields.get(row.task_id), completed.get(row.task_id))
        if (!Object.keys(cells).length) continue
        const version = Number(row.version || 1)
        const saved = await db
          .from('tenant_tracker_rows')
          .update({
            data: mergeCells(row.data || {}, columns, cells),
            version: version + 1,
            updated_by: actor.id,
            updated_at: now(),
          })
          .eq('tenant_id', tenant)
          .eq('tracker_id', trackerId)
          .eq('id', row.id)
          .eq('version', version)
          .select('id')
        if (saved.error || !saved.data?.length) continue
        changed = true
        const byId = new Map(columns.map(column => [column.id, column]))
        await record(tenant, trackerId, row.id, actor as User, 'cells', {
          fromTask: true,
          cells: Object.keys(cells).map(columnId => ({
            columnId,
            name: byId.get(columnId)!.name,
            from: shown(byId.get(columnId)!, row.data?.[columnId]),
            to: shown(byId.get(columnId)!, cells[columnId]),
          })),
        })
        for (const [columnId, value] of Object.entries(cells))
          if (byId.get(columnId)?.synced && row.source_key)
            toSheet.set(columnId, [...(toSheet.get(columnId) || []), { row, value }])
      }
      if (toSheet.size) {
        const source = await sourceRow(tenant, trackerId)
        if (source?.mode === 'two_way')
          for (const [columnId, entries] of toSheet) {
            const column = columns.find(item => item.id === columnId)!
            await writeToSheet(tenant, source, column, entries, actor.id ? actor : null).catch(() => undefined)
          }
      }
      if (changed) await touch(tenant, trackerId)
    }
  }

  /**
   * A Checkbox cell that holds a subtask (a Site rollout step, or any cell linked to one) is ticked when the subtask is
   * completed and unticked when it is reopened. Columns that come from a two-way Sheet are written there too, as the
   * person who saved (best effort; the next sync settles any difference).
   */
  async function followCellTasks(tenant: string, completed: Map<string, boolean>, actor: Actor) {
    const ids = [...completed.keys()]
    const links: any[] = []
    for (let at = 0; at < ids.length; at += 200) {
      // Before schema v25 there is no links table, and nothing to follow.
      const found = await db
        .from('tenant_tracker_task_links')
        .select('*')
        .eq('tenant_id', tenant)
        .in('task_id', ids.slice(at, at + 200))
      if (found.error) return
      links.push(...(found.data || []).filter((link: any) => link.column_id))
    }
    const byTracker = new Map<string, any[]>()
    for (const link of links) byTracker.set(link.tracker_id, [...(byTracker.get(link.tracker_id) || []), link])
    for (const [trackerId, trackerLinks] of byTracker) {
      const loaded = await db
        .from('tenant_trackers')
        .select('*')
        .eq('tenant_id', tenant)
        .eq('id', trackerId)
        .maybeSingle()
      const tracker = loaded.data
      if (!tracker || tracker.archived_at) continue
      const columns = columnsOf(tracker)
      const byId = new Map(columns.map(column => [column.id, column]))
      const wanted = trackerLinks.filter(link => byId.get(link.column_id)?.type === 'checkbox')
      if (!wanted.length) continue
      const rowIds = [...new Set(wanted.map(link => String(link.row_id)))]
      const rows: any[] = []
      for (let at = 0; at < rowIds.length; at += 200) {
        const found = await db
          .from('tenant_tracker_rows')
          .select('*')
          .eq('tenant_id', tenant)
          .eq('tracker_id', trackerId)
          .in('id', rowIds.slice(at, at + 200))
        rows.push(...(found.error ? [] : found.data || []))
      }
      let changed = false
      const toSheet = new Map<string, { row: any; value: Cell }[]>()
      for (const row of rows) {
        const cells: Record<string, Cell> = {}
        for (const link of wanted)
          if (link.row_id === row.id) {
            const done = completed.get(String(link.task_id))
            if (done !== undefined && (row.data?.[link.column_id] === true) !== done) cells[link.column_id] = done
          }
        if (!Object.keys(cells).length) continue
        const version = Number(row.version || 1)
        const saved = await db
          .from('tenant_tracker_rows')
          .update({
            data: mergeCells(row.data || {}, columns, cells),
            version: version + 1,
            updated_by: actor.id,
            updated_at: now(),
          })
          .eq('tenant_id', tenant)
          .eq('tracker_id', trackerId)
          .eq('id', row.id)
          .eq('version', version)
          .select('id')
        if (saved.error || !saved.data?.length) continue
        changed = true
        await record(tenant, trackerId, row.id, actor as User, 'cells', {
          fromTask: true,
          cells: Object.keys(cells).map(columnId => ({
            columnId,
            name: byId.get(columnId)!.name,
            from: shown(byId.get(columnId)!, row.data?.[columnId]),
            to: shown(byId.get(columnId)!, cells[columnId]),
          })),
        })
        for (const [columnId, value] of Object.entries(cells))
          if (byId.get(columnId)?.synced && row.source_key)
            toSheet.set(columnId, [...(toSheet.get(columnId) || []), { row, value }])
      }
      if (toSheet.size) {
        const source = await sourceRow(tenant, trackerId)
        if (source?.mode === 'two_way')
          for (const [columnId, entries] of toSheet)
            await writeToSheet(tenant, source, byId.get(columnId)!, entries, actor.id ? actor : null).catch(
              () => undefined,
            )
      }
      if (changed) await touch(tenant, trackerId)
    }
  }

  /** Follows up a workspace save. Never throws: a failure here must not look like a failed save. */
  async function onWorkspaceSaved(tenant: string, before: any, after: any, actor: Actor | null) {
    if (!db || !tenant) return
    const changes = completionChanges(before, after)
    const fields = taskFieldChanges(before, after)
    if (fields.size || changes.size)
      await followTaskFields(
        tenant,
        fields,
        changes,
        actor ? { id: actor.id, name: actor.name } : { id: '', name: 'Automatic' },
      ).catch((error: any) => console.error('Updating tracker rows from their tasks failed:', error?.message || error))
    if (!changes.size) return
    await followCellTasks(
      tenant,
      changes,
      actor ? { id: actor.id, name: actor.name } : { id: '', name: 'Automatic' },
    ).catch((error: any) => console.error('Ticking tracker steps from their subtasks failed:', error?.message || error))
    const ids = [...changes.keys()]
    const touched = new Map<string, Set<string>>()
    const add = (trackerId: string, rowId: string) => {
      if (!touched.has(trackerId)) touched.set(trackerId, new Set())
      touched.get(trackerId)!.add(rowId)
    }
    for (let at = 0; at < ids.length; at += 200) {
      const chunk = ids.slice(at, at + 200)
      const direct = await db
        .from('tenant_tracker_rows')
        .select('id,tracker_id')
        .eq('tenant_id', tenant)
        .in('task_id', chunk)
      for (const row of direct.error ? [] : direct.data || []) add(row.tracker_id, row.id)
      // Before schema v25 there is no links table: only the rows' own tasks count.
      const linked = await db
        .from('tenant_tracker_task_links')
        .select('tracker_id,row_id')
        .eq('tenant_id', tenant)
        .in('task_id', chunk)
      for (const link of linked.error ? [] : linked.data || []) add(link.tracker_id, link.row_id)
    }
    if (!touched.size) return
    const statuses = Array.isArray(after?.taskSettings?.statuses) ? after.taskSettings.statuses : undefined
    const items = new Map<string, any>(
      (Array.isArray(after?.items) ? after.items : []).map((item: any) => [String(item?.id || ''), item]),
    )
    const closed = (taskId: string) => {
      const item = items.get(taskId)
      return item ? isClosedStatus(item.status, statuses) : undefined
    }
    const titles = new Map<string, string>([...items].map(([id, item]) => [id, String(item?.title || '')]))
    const who: Actor = actor ? { id: actor.id, name: actor.name } : { id: '', name: 'Automatic' }
    for (const [trackerId, rowIds] of touched) {
      try {
        await autoDoneTracker(tenant, trackerId, [...rowIds], changes, closed, titles, who)
      } catch (error: any) {
        console.error('Updating a tracker after a task was completed failed:', error?.message || error)
      }
    }
  }

  return { saveAutoDone, onWorkspaceSaved }
}

export type TrackerFollow = ReturnType<typeof trackerFollow>
