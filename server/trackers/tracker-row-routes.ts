/**
 * Routes for rows: read, add, edit, link tasks, delete, reveal a Secret cell, and a row's history.
 */
import { AUTOMATION_LIMITS } from '../../src/features/trackers/trackerAutomations'
import type { AutomationResult, TrackerAutomations } from './tracker-automations'
import { randomUUID } from 'node:crypto'
import rateLimit from 'express-rate-limit'
import type { Express } from 'express'
import { decryptSecret } from '../integrations/tenant-integrations'
import { TrackerError, TRACKER_LIMITS, type TrackerRow } from '../../src/features/trackers/trackerModel'
import { emptyOf, HISTORY, PAGE, UUID } from './tracker-common'
import type { TrackerCore } from './tracker-core'
import type { TrackerSheetAccess } from './tracker-source'
import type { TrackerSheetWrite } from './tracker-sheet-write'

/** What the automations did, for the person who saved: one line each, and whether a task was made. */
const summarize = (results: AutomationResult[]) => ({
  done: [...new Set(results.flatMap(result => result.done))],
  skipped: [...new Set(results.flatMap(result => result.skipped))],
  taskMade: results.some(result => Boolean(result.taskId)),
})

export function trackerRowRoutes(
  app: Express,
  core: TrackerCore,
  sheetAccess: TrackerSheetAccess,
  sheetWrite: TrackerSheetWrite,
  automations?: TrackerAutomations,
) {
  const {
    scope,
    route,
    who,
    idParam,
    trackerRow,
    db,
    check,
    columnsOf,
    rowOut,
    rowCount,
    workspace,
    cleanRowInput,
    taskIdOf,
    now,
    mergeCells,
    mergeSecrets,
    record,
    touch,
    oneRow,
    shown,
    key,
  } = core
  const { sourceRow } = sheetAccess
  const { appendRowsToSheet, writeRowToSheet } = sheetWrite
  // ---- rows ----
  app.get(
    '/api/trackers/:id/rows',
    ...scope,
    route(async (req, res) => {
      const user = who(req),
        tenant = user.organizationId,
        id = idParam(req)
      const tracker = await trackerRow(tenant, id, user)
      const offset = Math.max(0, Math.floor(Number(req.query.offset) || 0))
      const limit = Math.max(1, Math.min(PAGE, Math.floor(Number(req.query.limit) || 500)))
      const r = await db
        .from('tenant_tracker_rows')
        .select('*')
        .eq('tenant_id', tenant)
        .eq('tracker_id', id)
        .order('position')
        .order('created_at')
        .range(offset, offset + limit - 1)
      check(r.error)
      const columns = columnsOf(tracker)
      res.json({
        rows: (r.data || []).map((entry: any) => rowOut(entry, columns)),
        total: await rowCount(tenant, id),
        offset,
      })
    }),
  )

  app.post(
    '/api/trackers/:id/rows',
    ...scope,
    route(async (req, res) => {
      const user = who(req),
        tenant = user.organizationId,
        id = idParam(req)
      const tracker = await trackerRow(tenant, id, user)
      if (tracker.archived_at) throw new TrackerError('This tracker is archived. Restore it to add rows.', 409)
      const input = req.body?.rows
      if (!Array.isArray(input) || !input.length) throw new TrackerError('Add at least one row.')
      if (input.length > TRACKER_LIMITS.importBatch)
        throw new TrackerError(`Add at most ${TRACKER_LIMITS.importBatch} rows at a time.`)
      const columns = columnsOf(tracker)
      const state = input.some((entry: any) => entry?.taskId) ? await workspace(tenant) : {}
      const cleaned = input.map((entry: any, index: number) => ({
        ...cleanRowInput(columns, entry, input.length > 1 ? `Row ${index + 1}` : ''),
        taskId: taskIdOf(state, entry?.taskId),
      }))
      const total = await rowCount(tenant, id)
      if (total + cleaned.length > TRACKER_LIMITS.rows)
        throw new TrackerError(
          `A tracker can have at most ${TRACKER_LIMITS.rows.toLocaleString('en')} rows. This one has ${total.toLocaleString('en')}.`,
          409,
        )
      const last = await db
        .from('tenant_tracker_rows')
        .select('position')
        .eq('tenant_id', tenant)
        .eq('tracker_id', id)
        .order('position', { ascending: false })
        .limit(1)
      check(last.error)
      let position = Number(last.data?.[0]?.position ?? 0)
      const stamp = now()
      const records = cleaned.map(entry => ({
        tenant_id: tenant,
        tracker_id: id,
        id: randomUUID(),
        position: ++position,
        data: mergeCells({}, columns, entry.cells),
        secrets: mergeSecrets({}, columns, tenant, entry.secrets),
        task_id: entry.taskId,
        version: 1,
        created_by: user.id,
        updated_by: user.id,
        created_at: stamp,
        updated_at: stamp,
      }))
      const saved = await db.from('tenant_tracker_rows').insert(records)
      check(saved.error)
      if (records.length === 1) await record(tenant, id, records[0].id, user, 'row_created', {})
      else await record(tenant, id, '', user, 'rows_added', { count: records.length })
      // Two-way: rows that already have a task name go to the Sheet too. The rest go when they get one.
      let warning = ''
      const source = await sourceRow(tenant, id)
      if (source?.mode === 'two_way') {
        const added = await appendRowsToSheet(tenant, tracker, source, records, user).catch((error: unknown) => {
          warning = `The rows were added here but not to the Google Sheet: ${error instanceof Error ? error.message : 'the Sheet could not be updated.'}`
          return new Map<string, Record<string, unknown>>()
        })
        for (const entry of records) Object.assign(entry, added.get(entry.id) || {})
      }
      // Automations for new rows: small batches only, so a big import never makes hundreds of tasks at once.
      const ran: AutomationResult[] = []
      if (automations && records.length <= AUTOMATION_LIMITS.rowsAdded)
        for (let at = 0; at < records.length; at++) {
          const result = await automations.run(tenant, tracker, user, null, records[at]).catch((error: any) => {
            console.error('Tracker automation failed:', error?.message || error)
            return null
          })
          if (!result) continue
          records[at] = result.record
          if (result.done.length || result.skipped.length) ran.push(result)
        }
      await touch(tenant, id)
      res.status(201).json({
        rows: records.map(entry => rowOut(entry, columns)),
        ...(warning ? { warning } : {}),
        ...(ran.length ? { automation: summarize(ran) } : {}),
      })
    }),
  )

  app.patch(
    '/api/trackers/:id/rows/:rowId',
    ...scope,
    route(async (req, res) => {
      const user = who(req),
        tenant = user.organizationId,
        id = idParam(req)
      const tracker = await trackerRow(tenant, id, user)
      if (tracker.archived_at) throw new TrackerError('This tracker is archived. Restore it to edit rows.', 409)
      const columns = columnsOf(tracker),
        byId = new Map(columns.map(column => [column.id, column]))
      const current = await oneRow(tenant, id, String(req.params.rowId))
      const body = req.body || {}
      if (!Number.isInteger(body.version)) throw new TrackerError('The row version is required.')
      if (body.version !== Number(current.version || 1))
        throw new TrackerError('Someone else changed this row. It was reloaded; review it and try again.', 409, {
          row: rowOut(current, columns),
        })
      const cleaned = cleanRowInput(columns, body, '')
      // Sheet columns: read-only for Sheet rows in one-way; in two-way the edit goes to the Sheet first.
      let sheetPatch: Record<string, unknown> = {}
      const sheetEdits = Object.keys(cleaned.cells).filter(
        columnId =>
          byId.get(columnId)?.synced &&
          JSON.stringify(current.data?.[columnId] ?? emptyOf(byId.get(columnId)!)) !==
            JSON.stringify(cleaned.cells[columnId]),
      )
      if (sheetEdits.length) {
        const source = await sourceRow(tenant, id)
        if (source?.mode === 'two_way')
          sheetPatch = await writeRowToSheet(
            tenant,
            tracker,
            source,
            current,
            Object.fromEntries(sheetEdits.map(columnId => [columnId, cleaned.cells[columnId]])),
            mergeCells(current.data || {}, columns, cleaned.cells),
            body.overwrite === true,
            user,
          )
        else if (current.source_key) {
          const locked = byId.get(sheetEdits[0])!
          throw new TrackerError(
            `${locked.name} comes from the connected Google Sheet. Change it in the Sheet; the tracker picks it up on the next sync.`,
            409,
          )
        }
      }
      let taskId = current.task_id || ''
      if (body.taskId !== undefined)
        taskId = body.taskId === null || body.taskId === '' ? '' : taskIdOf(await workspace(tenant), body.taskId)
      const data = mergeCells(current.data || {}, columns, cleaned.cells)
      const secrets = mergeSecrets(current.secrets || {}, columns, tenant, cleaned.secrets)
      const changed = Object.keys(cleaned.cells).filter(
        columnId =>
          JSON.stringify(current.data?.[columnId] ?? emptyOf(byId.get(columnId)!)) !==
          JSON.stringify(cleaned.cells[columnId]),
      )
      const secretsChanged = Object.keys(cleaned.secrets).filter(
        columnId =>
          Boolean(current.secrets?.[columnId]) !== Boolean(cleaned.secrets[columnId]) || cleaned.secrets[columnId],
      )
      if (!changed.length && !secretsChanged.length && taskId === (current.task_id || ''))
        return void res.json({ row: rowOut(current, columns) })
      const stamp = now()
      const saved = await db
        .from('tenant_tracker_rows')
        .update({
          data,
          secrets,
          task_id: taskId,
          version: body.version + 1,
          updated_by: user.id,
          updated_at: stamp,
          ...sheetPatch,
        })
        .eq('tenant_id', tenant)
        .eq('tracker_id', id)
        .eq('id', current.id)
        .eq('version', body.version)
        .select('id')
      check(saved.error)
      if (!saved.data?.length) {
        const latest = await oneRow(tenant, id, current.id)
        throw new TrackerError('Someone else changed this row. It was reloaded; review it and try again.', 409, {
          row: rowOut(latest, columns),
        })
      }
      const next = {
        ...current,
        data,
        secrets,
        task_id: taskId,
        version: body.version + 1,
        updated_at: stamp,
        ...sheetPatch,
      }
      if (changed.length)
        await record(tenant, id, current.id, user, 'cells', {
          cells: changed.map(columnId => ({
            columnId,
            name: byId.get(columnId)!.name,
            from: shown(byId.get(columnId)!, current.data?.[columnId]),
            to: shown(byId.get(columnId)!, cleaned.cells[columnId]),
          })),
        })
      if (secretsChanged.length)
        await record(tenant, id, current.id, user, 'secrets', {
          cells: secretsChanged.map(columnId => ({
            columnId,
            name: byId.get(columnId)!.name,
            action: cleaned.secrets[columnId] ? 'set' : 'cleared',
          })),
        })
      if (taskId !== (current.task_id || '')) {
        const title = taskId
          ? ((await workspace(tenant)).items || []).find((item: any) => item.id === taskId)?.title || ''
          : ''
        await record(tenant, id, current.id, user, taskId ? 'task_linked' : 'task_unlinked', { taskId, title })
      }
      // Automations run after the person's own change is saved; they never fail it.
      let finalRow = next
      let automation: ReturnType<typeof summarize> | undefined
      if (automations && changed.length) {
        const result = await automations.run(tenant, tracker, user, current, next).catch((error: any) => {
          console.error('Tracker automation failed:', error?.message || error)
          return null
        })
        if (result) {
          finalRow = result.record
          if (result.done.length || result.skipped.length) automation = summarize([result])
        }
      }
      await touch(tenant, id)
      res.json({ row: rowOut(finalRow, columns), ...(automation ? { automation } : {}) })
    }),
  )

  // Links many rows to their tasks at once, for example right after the tasks were created for an import.
  app.post(
    '/api/trackers/:id/rows/tasks',
    ...scope,
    route(async (req, res) => {
      const user = who(req),
        tenant = user.organizationId,
        id = idParam(req)
      const tracker = await trackerRow(tenant, id, user)
      if (tracker.archived_at) throw new TrackerError('This tracker is archived. Restore it to change rows.', 409)
      const input = Array.isArray(req.body?.links) ? req.body.links : []
      if (!input.length || input.length > TRACKER_LIMITS.importBatch)
        throw new TrackerError(`Link between 1 and ${TRACKER_LIMITS.importBatch} rows at a time.`)
      const state = await workspace(tenant)
      const wanted = new Map<string, string>()
      for (const entry of input) {
        const rowId = String(entry?.rowId ?? '')
        if (!UUID.test(rowId)) throw new TrackerError('Every link needs a row.')
        wanted.set(rowId, taskIdOf(state, entry?.taskId))
      }
      const found = await db
        .from('tenant_tracker_rows')
        .select('*')
        .eq('tenant_id', tenant)
        .eq('tracker_id', id)
        .in('id', [...wanted.keys()])
      check(found.error)
      const titles = new Map<string, string>((state.items || []).map((item: any) => [item.id, item.title || '']))
      const columns = columnsOf(tracker),
        stamp = now(),
        rows: TrackerRow[] = []
      for (const current of found.data || []) {
        const taskId = wanted.get(current.id) || ''
        if (taskId === (current.task_id || '')) {
          rows.push(rowOut(current, columns))
          continue
        }
        const version = Number(current.version || 1) + 1
        const saved = await db
          .from('tenant_tracker_rows')
          .update({ task_id: taskId, version, updated_by: user.id, updated_at: stamp })
          .eq('tenant_id', tenant)
          .eq('tracker_id', id)
          .eq('id', current.id)
        check(saved.error)
        await record(tenant, id, current.id, user, taskId ? 'task_linked' : 'task_unlinked', {
          taskId,
          title: titles.get(taskId) || '',
        })
        rows.push(rowOut({ ...current, task_id: taskId, version, updated_at: stamp }, columns))
      }
      if (rows.length) await touch(tenant, id)
      res.json({ rows })
    }),
  )

  app.post(
    '/api/trackers/:id/rows/delete',
    ...scope,
    route(async (req, res) => {
      const user = who(req),
        tenant = user.organizationId,
        id = idParam(req)
      const tracker = await trackerRow(tenant, id, user)
      if (tracker.archived_at) throw new TrackerError('This tracker is archived. Restore it to delete rows.', 409)
      const ids = Array.isArray(req.body?.ids) ? [...new Set<string>(req.body.ids.map(String))] : []
      if (!ids.length || ids.length > TRACKER_LIMITS.importBatch || ids.some(value => !UUID.test(value)))
        throw new TrackerError(`Choose between 1 and ${TRACKER_LIMITS.importBatch} rows to delete.`)
      const removed = await db
        .from('tenant_tracker_rows')
        .delete()
        .eq('tenant_id', tenant)
        .eq('tracker_id', id)
        .in('id', ids)
        .select('id')
      check(removed.error)
      // Links are best effort: before the links table exists there is nothing to clean up.
      if (removed.data?.length)
        await db
          .from('tenant_tracker_task_links')
          .delete()
          .eq('tenant_id', tenant)
          .eq('tracker_id', id)
          .in('row_id', ids)
      const count = removed.data?.length ?? 0
      if (count) {
        await record(tenant, id, ids.length === 1 ? ids[0] : '', user, 'rows_deleted', { count })
        await touch(tenant, id)
      }
      res.json({ deleted: count })
    }),
  )

  const revealLimit = rateLimit({
    windowMs: 60_000,
    limit: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many reveals. Wait a minute and try again.' },
  })
  app.post(
    '/api/trackers/:id/rows/:rowId/reveal',
    ...scope,
    revealLimit,
    route(async (req, res) => {
      const user = who(req),
        tenant = user.organizationId,
        id = idParam(req)
      const tracker = await trackerRow(tenant, id, user)
      const column = columnsOf(tracker).find(item => item.id === req.body?.columnId)
      if (!column || column.type !== 'secret') throw new TrackerError('That is not a Secret column.', 404)
      if (column.revealBy === 'admins' && user.role !== 'Administrator')
        throw new TrackerError('Only an Administrator can reveal this column.', 403)
      const current = await oneRow(tenant, id, String(req.params.rowId))
      const stored = current.secrets?.[column.id]
      if (!stored) throw new TrackerError('Nothing is stored in this cell.', 404)
      // Record first: if the record cannot be written, nothing is revealed.
      await record(tenant, id, current.id, user, 'reveal', { columnId: column.id, name: column.name }, true)
      const value = decryptSecret(stored, tenant, 'tracker-secret', key())
      res.json({ value, seconds: 30 })
    }),
  )

  app.get(
    '/api/trackers/:id/rows/:rowId/history',
    ...scope,
    route(async (req, res) => {
      const user = who(req),
        tenant = user.organizationId,
        id = idParam(req)
      await trackerRow(tenant, id, user)
      const rowId = String(req.params.rowId)
      if (!UUID.test(rowId)) throw new TrackerError('Row not found.', 404)
      const r = await db
        .from('tenant_tracker_changes')
        .select('id,actor_name,kind,detail,created_at')
        .eq('tenant_id', tenant)
        .eq('tracker_id', id)
        .eq('row_id', rowId)
        .order('created_at', { ascending: false })
        .limit(HISTORY + 200)
      check(r.error)
      res.json({
        // Comments are kept in the same table and have their own list.
        changes: (r.data || [])
          .filter((entry: any) => entry.kind !== 'comment')
          .slice(0, HISTORY)
          .map((entry: any) => ({
            id: entry.id,
            actorName: entry.actor_name || '',
            kind: entry.kind,
            detail: entry.detail || {},
            at: entry.created_at,
          })),
      })
    }),
  )
}
