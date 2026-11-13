/**
 * Routes for trackers themselves and their task links: list, create, read, rename, delete, review imported
 * rows, and link rows or cells to tasks.
 */
import { randomUUID } from 'node:crypto'
import type { Express } from 'express'
import { projectUsers, trackerUsers, validateMembers } from '../../src/features/trackers/trackerFolders'
import {
  TRACKER_LIMITS,
  TrackerError,
  cleanName,
  normalizeColumns,
  type TrackerColumn,
} from '../../src/features/trackers/trackerModel'
import { autoDoneColumn } from '../../src/features/trackers/trackerAutoDone'
import { type Deps, UUID } from './tracker-common'
import type { TrackerCore } from './tracker-core'
import type { TrackerSheetAccess } from './tracker-source'

export function trackerRoutes(app: Express, deps: Deps, core: TrackerCore, sheetAccess: TrackerSheetAccess) {
  const {
    scope,
    route,
    who,
    idParam,
    trackerRow,
    db,
    check,
    workspace,
    trackerVisibleIn,
    rowCount,
    trackerOut,
    validateLinks,
    now,
    record,
    columnsOf,
    taskIdOf,
    oneRow,
    touch,
    manageable,
  } = core
  const { sourceCheck, sourceRow, canWriteSheets, sourceOut } = sheetAccess
  /** Marks rows as reviewed (made into tasks, or left as plain rows). */
  app.post(
    '/api/trackers/:id/rows/review',
    ...scope,
    route(async (req, res) => {
      const user = who(req),
        tenant = user.organizationId,
        id = idParam(req)
      await trackerRow(tenant, id, user)
      const ids = Array.isArray(req.body?.ids) ? [...new Set<string>(req.body.ids.map(String))] : []
      if (!ids.length || ids.length > TRACKER_LIMITS.rows || ids.some(value => !UUID.test(value)))
        throw new TrackerError('Choose the rows that were reviewed.')
      for (let at = 0; at < ids.length; at += TRACKER_LIMITS.importBatch) {
        const saved = await db
          .from('tenant_tracker_rows')
          .update({ review: false })
          .eq('tenant_id', tenant)
          .eq('tracker_id', id)
          .in('id', ids.slice(at, at + TRACKER_LIMITS.importBatch))
        sourceCheck(saved.error)
      }
      res.json({ reviewed: ids.length })
    }),
  )

  app.get(
    '/api/trackers',
    ...scope,
    route(async (req, res) => {
      const user = who(req),
        tenant = user.organizationId
      const r = await db
        .from('tenant_trackers')
        .select('*')
        .eq('tenant_id', tenant)
        .order('updated_at', { ascending: false })
        .limit(TRACKER_LIMITS.trackers + 100)
      check(r.error)
      const state = await workspace(tenant)
      const shown = trackerVisibleIn(state, user)
      const visible = (r.data || []).filter((row: any) => (!row.private || row.created_by === user.id) && shown(row))
      const counts = await Promise.all(visible.map((row: any) => rowCount(tenant, row.id)))
      // Each tracker's users, for the folders: its creator, the people on its projects, the people added.
      const onProjects = projectUsers(state)
      res.json({
        trackers: visible.map((row: any, index: number) =>
          trackerOut(row, user, counts[index], trackerUsers(row, state, onProjects)),
        ),
        limits: TRACKER_LIMITS,
      })
    }),
  )

  app.post(
    '/api/trackers',
    ...scope,
    route(async (req, res) => {
      const user = who(req),
        tenant = user.organizationId
      const body = req.body || {}
      const name = cleanName(body.name, 'tracker name', TRACKER_LIMITS.nameLength)
      const columns = normalizeColumns(body.columns ?? [{ name: 'Name', type: 'text' }])
      const state = await workspace(tenant)
      const links = validateLinks(state, body, user)
      const existing = await db
        .from('tenant_trackers')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', tenant)
      check(existing.error)
      if (Number(existing.count || 0) >= TRACKER_LIMITS.trackers)
        throw new TrackerError(`An account can have at most ${TRACKER_LIMITS.trackers} trackers.`, 409)
      const row = {
        tenant_id: tenant,
        id: randomUUID(),
        name,
        client_id: links.clientId || '',
        project_id: links.projectId || '',
        private: body.private === true,
        template: String(body.template || '').slice(0, 40),
        ...(typeof body.stepTasks === 'boolean' ? { step_tasks: body.stepTasks } : {}),
        columns,
        views: [],
        revision: 1,
        created_by: user.id,
        created_by_name: user.name,
        created_at: now(),
        updated_at: now(),
        archived_at: null,
      }
      let saved = await db.from('tenant_trackers').insert(row)
      // Before schema v35 there is no step_tasks column: the tracker is made without it (its template still decides).
      if (saved.error && 'step_tasks' in row) {
        const { step_tasks: _off, ...plain } = row as Record<string, unknown>
        saved = await db.from('tenant_trackers').insert(plain)
      }
      check(saved.error)
      await record(tenant, row.id, '', user, 'tracker_created', { name })
      res.status(201).json({ tracker: trackerOut(row, user, 0) })
    }),
  )

  // Task links: a row, or one cell of it, linked to any number of tasks and subtasks. The Action Center reads them
  // to say where a task came from. They have their own table, so the rest of Trackers works before it is applied.
  const LINK_LIMIT = 40
  const linkCheck = (error: any) => {
    if (error)
      throw new TrackerError(
        'Task links are unavailable. Check the database connection; a new database needs database/schema.sql.',
        503,
      )
  }
  const titleOf = (columns: TrackerColumn[], data: any) => {
    const column = columns.find(item => item.type === 'text')
    const value = column ? data?.[column.id] : ''
    return typeof value === 'string' && value ? value : 'Untitled row'
  }
  async function linksOut(tenant: string, trackers: any[], rowFilter?: string) {
    if (!trackers.length) return []
    const byTracker = new Map<string, any>(trackers.map(tracker => [tracker.id, tracker]))
    let query = db.from('tenant_tracker_task_links').select('*').eq('tenant_id', tenant)
    if (trackers.length === 1) query = query.eq('tracker_id', trackers[0].id)
    if (rowFilter) query = query.eq('row_id', rowFilter)
    const found = await query.order('created_at', { ascending: true }).limit(2000)
    linkCheck(found.error)
    const links = (found.data || []).filter((link: any) => byTracker.has(link.tracker_id))
    const rowIds = [...new Set<string>(links.map((link: any) => link.row_id))]
    const titles = new Map<string, string>()
    for (let at = 0; at < rowIds.length; at += 200) {
      const rows = await db
        .from('tenant_tracker_rows')
        .select('*')
        .eq('tenant_id', tenant)
        .in('id', rowIds.slice(at, at + 200))
      check(rows.error)
      for (const row of rows.data || [])
        titles.set(row.id, titleOf(columnsOf(byTracker.get(row.tracker_id) || {}), row.data))
    }
    return links
      .filter((link: any) => titles.has(link.row_id))
      .map((link: any) => {
        const tracker = byTracker.get(link.tracker_id),
          column = columnsOf(tracker).find(item => item.id === link.column_id)
        return {
          id: link.id,
          trackerId: link.tracker_id,
          trackerName: tracker.name,
          rowId: link.row_id,
          rowTitle: titles.get(link.row_id) || 'Untitled row',
          columnId: column ? column.id : '',
          columnName: column ? column.name : '',
          taskId: link.task_id,
          createdByName: link.created_by_name || '',
          createdAt: link.created_at,
        }
      })
  }

  app.get(
    '/api/trackers/task-links',
    ...scope,
    route(async (req, res) => {
      const user = who(req),
        tenant = user.organizationId
      const r = await db
        .from('tenant_trackers')
        .select('*')
        .eq('tenant_id', tenant)
        .limit(TRACKER_LIMITS.trackers + 100)
      check(r.error)
      const shown = trackerVisibleIn(await workspace(tenant), user)
      const visible = (r.data || []).filter((row: any) => (!row.private || row.created_by === user.id) && shown(row))
      res.json({ links: await linksOut(tenant, visible) })
    }),
  )

  app.get(
    '/api/trackers/:id/links',
    ...scope,
    route(async (req, res) => {
      const user = who(req),
        tenant = user.organizationId,
        id = idParam(req)
      const tracker = await trackerRow(tenant, id, user)
      res.json({ links: await linksOut(tenant, [tracker]) })
    }),
  )

  app.post(
    '/api/trackers/:id/links',
    ...scope,
    route(async (req, res) => {
      const user = who(req),
        tenant = user.organizationId,
        id = idParam(req)
      const tracker = await trackerRow(tenant, id, user)
      if (tracker.archived_at) throw new TrackerError('This tracker is archived. Restore it to change links.', 409)
      const rowId = String(req.body?.rowId ?? '')
      if (!UUID.test(rowId)) throw new TrackerError('Choose a row to link the task to.')
      const columnId = String(req.body?.columnId ?? '').trim()
      if (columnId && !columnsOf(tracker).some(column => column.id === columnId))
        throw new TrackerError('That column was not found in this tracker.')
      const state = await workspace(tenant)
      const taskId = taskIdOf(state, req.body?.taskId)
      if (!taskId) throw new TrackerError('Choose a task or subtask to link.')
      const row = await oneRow(tenant, id, rowId)
      if (!row) throw new TrackerError('That row was not found.', 404)
      const existing = await db
        .from('tenant_tracker_task_links')
        .select('*')
        .eq('tenant_id', tenant)
        .eq('tracker_id', id)
        .eq('row_id', rowId)
      linkCheck(existing.error)
      const here = existing.data || []
      if (here.some((link: any) => link.column_id === columnId && link.task_id === taskId))
        throw new TrackerError(
          columnId ? 'That task is already linked to this cell.' : 'That task is already linked to this row.',
          409,
        )
      if (here.length >= LINK_LIMIT) throw new TrackerError(`A row can have up to ${LINK_LIMIT} linked tasks.`)
      const made = {
        id: randomUUID(),
        tenant_id: tenant,
        tracker_id: id,
        row_id: rowId,
        column_id: columnId,
        task_id: taskId,
        created_by: user.id,
        created_by_name: user.name,
        created_at: now(),
      }
      const saved = await db.from('tenant_tracker_task_links').insert(made)
      linkCheck(saved.error)
      const title = ((state.items || []).find((item: any) => item.id === taskId) || {}).title || ''
      await record(tenant, id, rowId, user, 'subtask_linked', { taskId, title, columnId })
      await touch(tenant, id)
      const links = await linksOut(tenant, [tracker], rowId)
      res.status(201).json({ link: links.find((link: any) => link.id === made.id), links })
    }),
  )

  /** Many cell links at once, for subtasks made from a review (one subtask per chosen column). */
  app.post(
    '/api/trackers/:id/links/bulk',
    ...scope,
    route(async (req, res) => {
      const user = who(req),
        tenant = user.organizationId,
        id = idParam(req)
      const tracker = await trackerRow(tenant, id, user)
      if (tracker.archived_at) throw new TrackerError('This tracker is archived. Restore it to change links.', 409)
      const input = Array.isArray(req.body?.links) ? req.body.links : []
      if (!input.length || input.length > TRACKER_LIMITS.importBatch * 4)
        throw new TrackerError('Send between 1 and 2,000 links at a time.')
      const columns = new Set(columnsOf(tracker).map(column => column.id)),
        state = await workspace(tenant)
      const wanted = input.map((entry: any) => {
        const rowId = String(entry?.rowId ?? ''),
          columnId = String(entry?.columnId ?? '').trim()
        if (!UUID.test(rowId)) throw new TrackerError('Every link needs a row.')
        if (columnId && !columns.has(columnId))
          throw new TrackerError('A column in these links was not found in this tracker.')
        return { rowId, columnId, taskId: taskIdOf(state, entry?.taskId) }
      })
      const rowIds = [...new Set<string>(wanted.map((entry: any) => entry.rowId))]
      const found = await db
        .from('tenant_tracker_rows')
        .select('id')
        .eq('tenant_id', tenant)
        .eq('tracker_id', id)
        .in('id', rowIds)
      check(found.error)
      const known = new Set((found.data || []).map((row: any) => row.id))
      const have = await db.from('tenant_tracker_task_links').select('*').eq('tenant_id', tenant).eq('tracker_id', id)
      linkCheck(have.error)
      const taken = new Set((have.data || []).map((link: any) => `${link.row_id}|${link.column_id}|${link.task_id}`))
      const records = wanted
        .filter((entry: any) => {
          const key = `${entry.rowId}|${entry.columnId}|${entry.taskId}`
          if (!known.has(entry.rowId) || !entry.taskId || taken.has(key)) return false
          taken.add(key)
          return true
        })
        .map((entry: any) => ({
          id: randomUUID(),
          tenant_id: tenant,
          tracker_id: id,
          row_id: entry.rowId,
          column_id: entry.columnId,
          task_id: entry.taskId,
          created_by: user.id,
          created_by_name: user.name,
          created_at: now(),
        }))
      if (records.length) {
        const saved = await db.from('tenant_tracker_task_links').insert(records)
        linkCheck(saved.error)
        await touch(tenant, id)
      }
      res.json({ links: await linksOut(tenant, [tracker]) })
    }),
  )

  app.delete(
    '/api/trackers/:id/links/:linkId',
    ...scope,
    route(async (req, res) => {
      const user = who(req),
        tenant = user.organizationId,
        id = idParam(req)
      const linkId = String(req.params.linkId || '')
      if (!UUID.test(linkId)) throw new TrackerError('Link not found.', 404)
      const tracker = await trackerRow(tenant, id, user)
      if (tracker.archived_at) throw new TrackerError('This tracker is archived. Restore it to change links.', 409)
      const removed = await db
        .from('tenant_tracker_task_links')
        .delete()
        .eq('tenant_id', tenant)
        .eq('tracker_id', id)
        .eq('id', linkId)
        .select('*')
      linkCheck(removed.error)
      const gone = (removed.data || [])[0]
      if (gone) {
        await record(tenant, id, gone.row_id, user, 'subtask_unlinked', {
          taskId: gone.task_id,
          columnId: gone.column_id,
        })
        await touch(tenant, id)
      }
      res.json({ removed: gone ? 1 : 0 })
    }),
  )

  app.get(
    '/api/trackers/:id',
    ...scope,
    route(async (req, res) => {
      const user = who(req),
        id = idParam(req)
      const row = await trackerRow(user.organizationId, id, user)
      const source = await sourceRow(user.organizationId, id)
      // Only when done marks go to the Sheet: whether the person who connected it allowed editing.
      let canWrite: boolean | undefined
      if (source && autoDoneColumn(columnsOf(row))?.synced)
        canWrite = deps.googleAccess
          ? await deps
              .googleAccess(user.organizationId, source.connected_by)
              .then(access => canWriteSheets(access.scope))
              .catch(() => false)
          : false
      // Two-way: whether this person's own Google account may edit Sheets (their edits are written as them).
      let youCanWrite: boolean | undefined
      if (source?.mode === 'two_way')
        youCanWrite = deps.googleAccess
          ? await deps
              .googleAccess(user.organizationId, user.id)
              .then(access => canWriteSheets(access.scope))
              .catch(() => false)
          : false
      res.json({
        tracker: {
          ...trackerOut(
            row,
            user,
            await rowCount(user.organizationId, id),
            trackerUsers(row, await workspace(user.organizationId)),
          ),
          source: source
            ? {
                ...sourceOut(source),
                ...(canWrite === undefined ? {} : { canWrite }),
                ...(youCanWrite === undefined ? {} : { youCanWrite }),
              }
            : null,
        },
      })
    }),
  )

  app.patch(
    '/api/trackers/:id',
    ...scope,
    route(async (req, res) => {
      const user = who(req),
        tenant = user.organizationId,
        id = idParam(req)
      const row = await trackerRow(tenant, id, user)
      const body = req.body || {},
        patch: Record<string, unknown> = {}
      if (body.name !== undefined) patch.name = cleanName(body.name, 'tracker name', TRACKER_LIMITS.nameLength)
      if (
        body.clientId !== undefined ||
        body.clientIds !== undefined ||
        body.projectId !== undefined ||
        body.projectIds !== undefined
      ) {
        const links = validateLinks(await workspace(tenant), body, user)
        if (links.clientId !== undefined) patch.client_id = links.clientId
        if (links.projectId !== undefined) patch.project_id = links.projectId
      }
      if (body.private !== undefined || body.archived !== undefined) {
        if (!manageable(user, row))
          throw new TrackerError(
            'Only the creator or an Administrator can change who sees a tracker or archive it.',
            403,
          )
        if (body.private !== undefined) patch.private = body.private === true
        if (body.archived !== undefined) patch.archived_at = body.archived === true ? now() : null
      }
      if (body.stepTasks !== undefined) patch.step_tasks = body.stepTasks === true
      // People added by hand: the tracker shows in their folders. Like who sees it, the creator's or an Admin's call.
      const state = await workspace(tenant)
      if (body.members !== undefined) {
        if (!manageable(user, row))
          throw new TrackerError('Only the creator or an Administrator can add or remove a tracker’s users.', 403)
        const members = validateMembers(state, body.members, row.created_by || '')
        if (!members.ok) throw new TrackerError(members.error)
        patch.members = members.members
      }
      const usersAfter = (stored: any) => trackerUsers(stored, state)
      if (!Object.keys(patch).length)
        return void res.json({ tracker: trackerOut(row, user, await rowCount(tenant, id), usersAfter(row)) })
      patch.updated_at = now()
      const saved = await db.from('tenant_trackers').update(patch).eq('tenant_id', tenant).eq('id', id).select('*')
      if (saved.error && 'step_tasks' in patch)
        throw new TrackerError(
          'Turning tasks for rows and steps on or off is unavailable. Check the database connection; a new database needs database/schema.sql.',
          503,
        )
      if (saved.error && 'members' in patch)
        throw new TrackerError(
          'Adding people to a tracker needs the database update database/migrations/schema-v36-tracker-members.sql. Ask your administrator to run it.',
          503,
        )
      check(saved.error)
      if (body.archived !== undefined)
        await record(tenant, id, '', user, body.archived === true ? 'tracker_archived' : 'tracker_restored', {})
      res.json({
        tracker: trackerOut({ ...row, ...patch }, user, await rowCount(tenant, id), usersAfter({ ...row, ...patch })),
      })
    }),
  )

  app.delete(
    '/api/trackers/:id',
    ...scope,
    route(async (req, res) => {
      const user = who(req),
        tenant = user.organizationId,
        id = idParam(req)
      const row = await trackerRow(tenant, id, user)
      if (!manageable(user, row))
        throw new TrackerError('Only the creator or an Administrator can delete a tracker.', 403)
      if (!row.archived_at) throw new TrackerError('Archive the tracker first. Deleting is permanent.', 409)
      const removed = await db.from('tenant_trackers').delete().eq('tenant_id', tenant).eq('id', id)
      check(removed.error)
      // Rows go with it (foreign key); the history is removed explicitly because it is not tied to a row.
      await db.from('tenant_tracker_changes').delete().eq('tenant_id', tenant).eq('tracker_id', id)
      res.json({ ok: true })
    }),
  )
}
