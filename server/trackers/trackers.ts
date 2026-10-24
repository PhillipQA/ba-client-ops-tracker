import { randomUUID } from 'node:crypto'
import rateLimit from 'express-rate-limit'
import type { Express, Request, RequestHandler, Response } from 'express'
import { decryptSecret, encryptSecret, encryptionKey, IntegrationError } from '../integrations/tenant-integrations'
import {
  TRACKER_LIMITS, TrackerError, TRACKER_CLIENTS, canConvertType, cleanCell, splitClientIds, cleanName, cleanSecret, isBasicType, isColumnType, isEmptyCell, normalizeColumns, normalizeViews, planConversion,
  type Cell, type Tracker, type TrackerColumn, type TrackerRow,
} from '../../src/trackerModel'

/**
 * Trackers: user-defined sheets. A tracker owns its columns and views; its rows live in their own table so one
 * edit saves one row instead of the whole workspace. Secret columns are encrypted before they are stored, are
 * never sent back to the browser, and can only be read through a logged reveal.
 */
type Deps = {
  db: any
  requireAuth: RequestHandler
  requireTenant: RequestHandler
  /** The tenant workspace, used to check that a linked task, client or project exists. */
  load: (tenantId: string) => Promise<{ data: any }>
  /** Encryption key override for tests. */
  key?: Buffer
  now?: () => Date
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const PAGE = 1000
const HISTORY = 50

type User = { id: string; name: string; role: string; organizationId: string }

export function registerTrackerRoutes(app: Express, deps: Deps) {
  const { db } = deps
  const now = () => (deps.now ? deps.now() : new Date()).toISOString()
  const who = (req: Request) => (req as any).authUser as User
  const key = () => deps.key ?? encryptionKey()

  const guard: RequestHandler = (req, res, next) => {
    const user = (req as any).authUser
    if (!db) return void res.status(503).json({ error: 'Database is not configured.' })
    if (!user?.organizationId || user.accountType === 'platform' || !user.modules?.includes('trackers')) return void res.status(403).json({ error: 'Trackers access is required.' })
    if (req.method !== 'GET' && user.role === 'Viewer') return void res.status(403).json({ error: 'Your role can view trackers but not change them.' })
    res.setHeader('Cache-Control', 'no-store')
    next()
  }
  const scope = [deps.requireAuth, deps.requireTenant, guard]

  const check = (error: any) => { if (error) throw new TrackerError('Trackers storage is unavailable. Apply database/migrations/schema-v24-trackers.sql and check the database connection.', 503) }
  const route = (handler: (req: Request, res: Response) => Promise<void>): RequestHandler => async (req, res) => {
    try { await handler(req, res) } catch (error) {
      if (error instanceof TrackerError) return void res.status(error.status).json({ error: error.message, ...(error.extra || {}) })
      if (error instanceof IntegrationError) return void res.status(error.status).json({ error: error.message })
      res.status(500).json({ error: 'Trackers are unavailable right now. Try again in a moment.' })
    }
  }
  const idParam = (req: Request, name = 'id') => {
    const value = String(req.params[name] || '')
    if (!UUID.test(value)) throw new TrackerError('Tracker not found.', 404)
    return value
  }

  async function workspace(tenant: string) {
    try { return (await deps.load(tenant)).data || {} } catch { throw new TrackerError('The workspace could not be read. Try again in a moment.', 503) }
  }
  const manageable = (user: User, row: any) => user.role === 'Administrator' || row.created_by === user.id

  async function trackerRow(tenant: string, id: string, user: User) {
    const r = await db.from('tenant_trackers').select('*').eq('tenant_id', tenant).eq('id', id).maybeSingle()
    check(r.error)
    // A private tracker does not exist for anyone but its creator.
    if (!r.data || (r.data.private && r.data.created_by !== user.id)) throw new TrackerError('Tracker not found.', 404)
    return r.data
  }
  async function rowCount(tenant: string, trackerId: string) {
    const r = await db.from('tenant_tracker_rows').select('id', { count: 'exact', head: true }).eq('tenant_id', tenant).eq('tracker_id', trackerId)
    check(r.error)
    return Number(r.count || 0)
  }
  const trackerOut = (row: any, user: User, count: number): Tracker => ({
    id: row.id, name: row.name, clientId: splitClientIds(row.client_id)[0] || '', clientIds: splitClientIds(row.client_id), projectId: row.project_id || '', private: Boolean(row.private), template: row.template || '',
    columns: Array.isArray(row.columns) ? row.columns : [], views: Array.isArray(row.views) ? row.views : [], revision: Number(row.revision || 1), rowCount: count,
    createdBy: row.created_by || '', createdByName: row.created_by_name || '', createdAt: row.created_at, updatedAt: row.updated_at, archived: Boolean(row.archived_at),
    canEdit: user.role !== 'Viewer', canManage: manageable(user, row),
  })
  const columnsOf = (row: any): TrackerColumn[] => Array.isArray(row.columns) ? row.columns : []

  function rowOut(row: any, columns: TrackerColumn[]): TrackerRow {
    const cells: Record<string, Cell> = {}, secretSet: Record<string, true> = {}
    for (const column of columns) {
      if (isBasicType(column.type)) { const value = row.data?.[column.id]; if (!isEmptyCell(value)) cells[column.id] = value }
      else if (column.type === 'secret' && row.secrets?.[column.id]) secretSet[column.id] = true
    }
    return { id: row.id, position: Number(row.position), cells, secretSet, taskId: row.task_id || '', version: Number(row.version || 1), updatedAt: row.updated_at }
  }

  /** What is written to the history for a value. Secrets are never included. */
  function shown(column: TrackerColumn, value: Cell | undefined) {
    if (value === undefined || isEmptyCell(value)) return ''
    if (column.type === 'checkbox') return value ? 'Yes' : 'No'
    if (column.type === 'select') return column.options?.find(option => option.id === value)?.label || ''
    if (column.type === 'multiselect') return (value as string[]).map(id => column.options?.find(option => option.id === id)?.label || '').filter(Boolean).join(', ')
    return String(value).slice(0, 120)
  }
  async function record(tenant: string, trackerId: string, rowId: string, user: User, kind: string, detail: Record<string, unknown>, required = false) {
    const r = await db.from('tenant_tracker_changes').insert({ id: randomUUID(), tenant_id: tenant, tracker_id: trackerId, row_id: rowId, actor_id: user.id, actor_name: user.name, kind, detail, created_at: now() })
    // History is best effort, except for a reveal: a secret is never shown without a record that it was.
    if (r.error && required) throw new TrackerError('The reveal could not be recorded, so nothing was shown. Try again.', 503)
  }
  async function touch(tenant: string, trackerId: string) {
    await db.from('tenant_trackers').update({ updated_at: now() }).eq('tenant_id', tenant).eq('id', trackerId)
  }

  function validateLinks(state: any, body: { clientId?: unknown; clientIds?: unknown; projectId?: unknown }) {
    const pick = (value: unknown, list: any[], label: string) => {
      const id = String(value ?? '').trim()
      if (id && !(list || []).some((item: any) => item.id === id)) throw new TrackerError(`That ${label} was not found in your account.`)
      return id
    }
    // A tracker can follow several clients. `clientIds` wins; a single `clientId` still works for older callers.
    let clientId: string | undefined
    if (body.clientIds !== undefined) {
      if (!Array.isArray(body.clientIds)) throw new TrackerError('clientIds must be a list.')
      const ids = [...new Set(body.clientIds.map((value: unknown) => pick(value, state.clients, 'client')).filter(Boolean))]
      if (ids.length > TRACKER_CLIENTS) throw new TrackerError(`A tracker can follow at most ${TRACKER_CLIENTS} clients.`)
      clientId = ids.join(',')
    } else if (body.clientId !== undefined) clientId = pick(body.clientId, state.clients, 'client')
    return { clientId, projectId: body.projectId === undefined ? undefined : pick(body.projectId, state.projects, 'project') }
  }
  function taskIdOf(state: any, value: unknown) {
    const id = String(value ?? '').trim()
    if (!id) return ''
    if (id.length > 100 || !(state.items || []).some((item: any) => item.id === id)) throw new TrackerError('That task was not found in your account.')
    return id
  }

  /** Cleans the cells and secrets for one row. `existing` is the row being changed, if any. */
  function cleanRowInput(columns: TrackerColumn[], input: any, label: string) {
    const byId = new Map(columns.map(column => [column.id, column]))
    const cells: Record<string, Cell> = {}, secrets: Record<string, string | null> = {}
    const fail = (message: string): never => { throw new TrackerError(label ? `${label}: ${message}` : message) }
    if (input?.cells !== undefined && (typeof input.cells !== 'object' || input.cells === null || Array.isArray(input.cells))) fail('cells must be an object.')
    for (const [id, raw] of Object.entries<unknown>(input?.cells || {})) {
      const column = byId.get(id)
      if (!column) fail('That column no longer exists. Reload the tracker.')
      const result = cleanCell(column!, raw)
      if (!result.ok) fail(result.error)
      else cells[id] = result.value
    }
    if (input?.secrets !== undefined && (typeof input.secrets !== 'object' || input.secrets === null || Array.isArray(input.secrets))) fail('secrets must be an object.')
    for (const [id, raw] of Object.entries<unknown>(input?.secrets || {})) {
      const column = byId.get(id)
      if (!column) fail('That column no longer exists. Reload the tracker.')
      if (raw === null || raw === '') { if (column!.type !== 'secret') fail(`${column!.name} is not a Secret column.`); secrets[id] = null; continue }
      const result = cleanSecret(column!, raw)
      if (!result.ok) fail(result.error)
      else secrets[id] = result.value
    }
    return { cells, secrets }
  }
  const mergeCells = (data: Record<string, Cell>, columns: TrackerColumn[], cells: Record<string, Cell>) => {
    // Only values for columns that still exist are kept; emptied cells are removed instead of stored as empty.
    const next: Record<string, Cell> = {}
    for (const column of columns) if (isBasicType(column.type)) {
      const value = column.id in cells ? cells[column.id] : data?.[column.id]
      if (!isEmptyCell(value as Cell)) next[column.id] = value as Cell
    }
    return next
  }
  const mergeSecrets = (current: Record<string, string>, columns: TrackerColumn[], tenant: string, changes: Record<string, string | null>) => {
    const next: Record<string, string> = {}
    for (const column of columns) if (column.type === 'secret') {
      if (column.id in changes) { const value = changes[column.id]; if (value) next[column.id] = encryptSecret(value, tenant, 'tracker-secret', key()) }
      else if (current?.[column.id]) next[column.id] = current[column.id]
    }
    return next
  }

  // ---- trackers ----
  app.get('/api/trackers', ...scope, route(async (req, res) => {
    const user = who(req), tenant = user.organizationId
    const r = await db.from('tenant_trackers').select('*').eq('tenant_id', tenant).order('updated_at', { ascending: false }).limit(TRACKER_LIMITS.trackers + 100)
    check(r.error)
    const visible = (r.data || []).filter((row: any) => !row.private || row.created_by === user.id)
    const counts = await Promise.all(visible.map((row: any) => rowCount(tenant, row.id)))
    res.json({ trackers: visible.map((row: any, index: number) => trackerOut(row, user, counts[index])), limits: TRACKER_LIMITS })
  }))

  app.post('/api/trackers', ...scope, route(async (req, res) => {
    const user = who(req), tenant = user.organizationId
    const body = req.body || {}
    const name = cleanName(body.name, 'tracker name', TRACKER_LIMITS.nameLength)
    const columns = normalizeColumns(body.columns ?? [{ name: 'Name', type: 'text' }])
    const state = await workspace(tenant)
    const links = validateLinks(state, body)
    const existing = await db.from('tenant_trackers').select('id', { count: 'exact', head: true }).eq('tenant_id', tenant)
    check(existing.error)
    if (Number(existing.count || 0) >= TRACKER_LIMITS.trackers) throw new TrackerError(`An account can have at most ${TRACKER_LIMITS.trackers} trackers.`, 409)
    const row = {
      tenant_id: tenant, id: randomUUID(), name, client_id: links.clientId || '', project_id: links.projectId || '', private: body.private === true,
      template: String(body.template || '').slice(0, 40), columns, views: [], revision: 1, created_by: user.id, created_by_name: user.name, created_at: now(), updated_at: now(), archived_at: null,
    }
    const saved = await db.from('tenant_trackers').insert(row)
    check(saved.error)
    await record(tenant, row.id, '', user, 'tracker_created', { name })
    res.status(201).json({ tracker: trackerOut(row, user, 0) })
  }))

  // Task links: a row, or one cell of it, linked to any number of tasks and subtasks. The Action Center reads them
  // to say where a task came from. They have their own table, so the rest of Trackers works before it is applied.
  const LINK_LIMIT = 40
  const linkCheck = (error: any) => { if (error) throw new TrackerError('Task links need database/migrations/schema-v25-tracker-task-links.sql. Apply it and try again.', 503) }
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
      const rows = await db.from('tenant_tracker_rows').select('*').eq('tenant_id', tenant).in('id', rowIds.slice(at, at + 200))
      check(rows.error)
      for (const row of rows.data || []) titles.set(row.id, titleOf(columnsOf(byTracker.get(row.tracker_id) || {}), row.data))
    }
    return links.filter((link: any) => titles.has(link.row_id)).map((link: any) => {
      const tracker = byTracker.get(link.tracker_id), column = columnsOf(tracker).find(item => item.id === link.column_id)
      return {
        id: link.id, trackerId: link.tracker_id, trackerName: tracker.name, rowId: link.row_id, rowTitle: titles.get(link.row_id) || 'Untitled row',
        columnId: column ? column.id : '', columnName: column ? column.name : '', taskId: link.task_id, createdByName: link.created_by_name || '', createdAt: link.created_at,
      }
    })
  }

  app.get('/api/trackers/task-links', ...scope, route(async (req, res) => {
    const user = who(req), tenant = user.organizationId
    const r = await db.from('tenant_trackers').select('*').eq('tenant_id', tenant).limit(TRACKER_LIMITS.trackers + 100)
    check(r.error)
    const visible = (r.data || []).filter((row: any) => !row.private || row.created_by === user.id)
    res.json({ links: await linksOut(tenant, visible) })
  }))

  app.get('/api/trackers/:id/links', ...scope, route(async (req, res) => {
    const user = who(req), tenant = user.organizationId, id = idParam(req)
    const tracker = await trackerRow(tenant, id, user)
    res.json({ links: await linksOut(tenant, [tracker]) })
  }))

  app.post('/api/trackers/:id/links', ...scope, route(async (req, res) => {
    const user = who(req), tenant = user.organizationId, id = idParam(req)
    const tracker = await trackerRow(tenant, id, user)
    if (tracker.archived_at) throw new TrackerError('This tracker is archived. Restore it to change links.', 409)
    const rowId = String(req.body?.rowId ?? '')
    if (!UUID.test(rowId)) throw new TrackerError('Choose a row to link the task to.')
    const columnId = String(req.body?.columnId ?? '').trim()
    if (columnId && !columnsOf(tracker).some(column => column.id === columnId)) throw new TrackerError('That column was not found in this tracker.')
    const state = await workspace(tenant)
    const taskId = taskIdOf(state, req.body?.taskId)
    if (!taskId) throw new TrackerError('Choose a task or subtask to link.')
    const row = await oneRow(tenant, id, rowId)
    if (!row) throw new TrackerError('That row was not found.', 404)
    const existing = await db.from('tenant_tracker_task_links').select('*').eq('tenant_id', tenant).eq('tracker_id', id).eq('row_id', rowId)
    linkCheck(existing.error)
    const here = existing.data || []
    if (here.some((link: any) => link.column_id === columnId && link.task_id === taskId)) throw new TrackerError(columnId ? 'That task is already linked to this cell.' : 'That task is already linked to this row.', 409)
    if (here.length >= LINK_LIMIT) throw new TrackerError(`A row can have up to ${LINK_LIMIT} linked tasks.`)
    const made = { id: randomUUID(), tenant_id: tenant, tracker_id: id, row_id: rowId, column_id: columnId, task_id: taskId, created_by: user.id, created_by_name: user.name, created_at: now() }
    const saved = await db.from('tenant_tracker_task_links').insert(made)
    linkCheck(saved.error)
    const title = ((state.items || []).find((item: any) => item.id === taskId) || {}).title || ''
    await record(tenant, id, rowId, user, 'subtask_linked', { taskId, title, columnId })
    await touch(tenant, id)
    const links = await linksOut(tenant, [tracker], rowId)
    res.status(201).json({ link: links.find((link: any) => link.id === made.id), links })
  }))

  app.delete('/api/trackers/:id/links/:linkId', ...scope, route(async (req, res) => {
    const user = who(req), tenant = user.organizationId, id = idParam(req)
    const linkId = String(req.params.linkId || '')
    if (!UUID.test(linkId)) throw new TrackerError('Link not found.', 404)
    const tracker = await trackerRow(tenant, id, user)
    if (tracker.archived_at) throw new TrackerError('This tracker is archived. Restore it to change links.', 409)
    const removed = await db.from('tenant_tracker_task_links').delete().eq('tenant_id', tenant).eq('tracker_id', id).eq('id', linkId).select('*')
    linkCheck(removed.error)
    const gone = (removed.data || [])[0]
    if (gone) { await record(tenant, id, gone.row_id, user, 'subtask_unlinked', { taskId: gone.task_id, columnId: gone.column_id }); await touch(tenant, id) }
    res.json({ removed: gone ? 1 : 0 })
  }))

  app.get('/api/trackers/:id', ...scope, route(async (req, res) => {
    const user = who(req), id = idParam(req)
    const row = await trackerRow(user.organizationId, id, user)
    res.json({ tracker: trackerOut(row, user, await rowCount(user.organizationId, id)) })
  }))

  app.patch('/api/trackers/:id', ...scope, route(async (req, res) => {
    const user = who(req), tenant = user.organizationId, id = idParam(req)
    const row = await trackerRow(tenant, id, user)
    const body = req.body || {}, patch: Record<string, unknown> = {}
    if (body.name !== undefined) patch.name = cleanName(body.name, 'tracker name', TRACKER_LIMITS.nameLength)
    if (body.clientId !== undefined || body.clientIds !== undefined || body.projectId !== undefined) {
      const links = validateLinks(await workspace(tenant), body)
      if (links.clientId !== undefined) patch.client_id = links.clientId
      if (links.projectId !== undefined) patch.project_id = links.projectId
    }
    if (body.private !== undefined || body.archived !== undefined) {
      if (!manageable(user, row)) throw new TrackerError('Only the creator or an Administrator can change who sees a tracker or archive it.', 403)
      if (body.private !== undefined) patch.private = body.private === true
      if (body.archived !== undefined) patch.archived_at = body.archived === true ? now() : null
    }
    if (!Object.keys(patch).length) return void res.json({ tracker: trackerOut(row, user, await rowCount(tenant, id)) })
    patch.updated_at = now()
    const saved = await db.from('tenant_trackers').update(patch).eq('tenant_id', tenant).eq('id', id).select('*')
    check(saved.error)
    if (body.archived !== undefined) await record(tenant, id, '', user, body.archived === true ? 'tracker_archived' : 'tracker_restored', {})
    res.json({ tracker: trackerOut({ ...row, ...patch }, user, await rowCount(tenant, id)) })
  }))

  app.delete('/api/trackers/:id', ...scope, route(async (req, res) => {
    const user = who(req), tenant = user.organizationId, id = idParam(req)
    const row = await trackerRow(tenant, id, user)
    if (!manageable(user, row)) throw new TrackerError('Only the creator or an Administrator can delete a tracker.', 403)
    if (!row.archived_at) throw new TrackerError('Archive the tracker first. Deleting is permanent.', 409)
    const removed = await db.from('tenant_trackers').delete().eq('tenant_id', tenant).eq('id', id)
    check(removed.error)
    // Rows go with it (foreign key); the history is removed explicitly because it is not tied to a row.
    await db.from('tenant_tracker_changes').delete().eq('tenant_id', tenant).eq('tracker_id', id)
    res.json({ ok: true })
  }))

  // ---- columns and views ----
  async function replaceTracker(tenant: string, row: any, patch: Record<string, unknown>, user: User) {
    const saved = await db.from('tenant_trackers').update({ ...patch, revision: Number(row.revision || 1) + 1, updated_at: now() })
      .eq('tenant_id', tenant).eq('id', row.id).eq('revision', Number(row.revision || 1)).select('id')
    check(saved.error)
    if (!saved.data?.length) {
      const current = await trackerRow(tenant, row.id, user)
      throw new TrackerError('Someone else changed this tracker. It was reloaded; review it and try again.', 409, { tracker: trackerOut(current, user, await rowCount(tenant, row.id)) })
    }
    const fresh = await trackerRow(tenant, row.id, user)
    return trackerOut(fresh, user, await rowCount(tenant, row.id))
  }
  async function requireRevision(tenant: string, row: any, body: any, user: User) {
    if (Number(body?.revision) === Number(row.revision || 1)) return
    throw new TrackerError('Someone else changed this tracker. It was reloaded; review it and try again.', 409, { tracker: trackerOut(row, user, await rowCount(tenant, row.id)) })
  }

  app.put('/api/trackers/:id/columns', ...scope, route(async (req, res) => {
    const user = who(req), tenant = user.organizationId, id = idParam(req)
    const row = await trackerRow(tenant, id, user)
    if (row.archived_at) throw new TrackerError('This tracker is archived. Restore it to change its columns.', 409)
    await requireRevision(tenant, row, req.body, user)
    const before = columnsOf(row)
    const columns = normalizeColumns(req.body?.columns, before)
    const views = normalizeViews(row.views, columns)
    const tracker = await replaceTracker(tenant, row, { columns, views }, user)
    const kept = new Set(columns.map(column => column.id))
    const removed = before.filter(column => !kept.has(column.id)), added = columns.filter(column => !before.some(old => old.id === column.id))
    const renamed = columns.filter(column => before.some(old => old.id === column.id && old.name !== column.name))
    if (removed.length || added.length || renamed.length) await record(tenant, id, '', user, 'columns', { added: added.map(c => c.name), removed: removed.map(c => c.name), renamed: renamed.map(c => c.name) })
    // A deleted Secret column takes its encrypted values with it.
    const gone = removed.filter(column => column.type === 'secret').map(column => column.id)
    if (gone.length) {
      const rows = await db.from('tenant_tracker_rows').select('id,secrets').eq('tenant_id', tenant).eq('tracker_id', id).limit(TRACKER_LIMITS.rows + 100)
      for (const entry of rows.data || []) {
        if (!gone.some(columnId => entry.secrets?.[columnId])) continue
        const next = { ...entry.secrets }; for (const columnId of gone) delete next[columnId]
        await db.from('tenant_tracker_rows').update({ secrets: next }).eq('tenant_id', tenant).eq('tracker_id', id).eq('id', entry.id)
      }
    }
    res.json({ tracker })
  }))

  /** Changes a column to another basic type. Without `confirm`, nothing is changed and the answer says how many values would be cleared. */
  app.post('/api/trackers/:id/columns/:columnId/convert', ...scope, route(async (req, res) => {
    const user = who(req), tenant = user.organizationId, id = idParam(req)
    const row = await trackerRow(tenant, id, user)
    if (row.archived_at) throw new TrackerError('This tracker is archived. Restore it to change its columns.', 409)
    const before = columnsOf(row)
    const column = before.find(item => item.id === String(req.params.columnId))
    if (!column) throw new TrackerError('That column no longer exists.', 404)
    const toType = req.body?.type
    if (!isColumnType(toType) || !canConvertType(toType) || !canConvertType(column.type) || toType === column.type) throw new TrackerError('This column cannot be changed to that type.')
    const loaded = await db.from('tenant_tracker_rows').select('id,data,version,position').eq('tenant_id', tenant).eq('tracker_id', id).order('position').order('created_at').limit(TRACKER_LIMITS.rows + 100)
    check(loaded.error)
    const entries: any[] = loaded.data || []
    const plan = planConversion(column, toType, entries.map(entry => entry.data?.[column.id]))
    const samples = entries.flatMap((entry, at) => plan.cells[at].ok ? [] : [{ row: at + 1, value: plan.cells[at].before.slice(0, 80) }]).slice(0, 8)
    if (req.body?.confirm !== true) return void res.json({ applied: false, rows: entries.length, filled: plan.cells.filter(cell => cell.before).length, failed: plan.failed, samples })
    await requireRevision(tenant, row, req.body, user)
    if (plan.failed && req.body?.clearUnfit !== true) throw new TrackerError(`${plan.failed} value${plan.failed === 1 ? '' : 's'} cannot be converted. Confirm that they will be cleared, or fix them first.`, 409)
    // Rows first, then the column: if this stops part-way, the values are still all here and the change can simply be run again.
    const stamp = now()
    const todo = entries.map((entry, at) => ({ entry, cell: plan.cells[at] })).filter(({ entry, cell }) => JSON.stringify(entry.data?.[column.id] ?? null) !== JSON.stringify(cell.value))
    for (let i = 0; i < todo.length; i += 25) {
      await Promise.all(todo.slice(i, i + 25).map(async ({ entry, cell }) => {
        const saved = await db.from('tenant_tracker_rows').update({ data: { ...(entry.data || {}), [column.id]: cell.value }, version: Number(entry.version || 1) + 1, updated_at: stamp, updated_by: user.id })
          .eq('tenant_id', tenant).eq('tracker_id', id).eq('id', entry.id)
        check(saved.error)
      }))
    }
    const columns = before.map(item => {
      if (item.id !== column.id) return item
      const { options: _options, ...rest } = item
      return { ...rest, type: toType, ...(plan.options ? { options: plan.options } : {}) } as TrackerColumn
    })
    // Saved views that filter, sort or group by this column are cleaned of it, since the old settings may not fit the new type.
    const views = normalizeViews(row.views, columns).map(view => ({ ...view, filters: view.filters.filter(filter => filter.columnId !== column.id), sort: view.sort?.columnId === column.id ? null : view.sort, groupBy: view.groupBy === column.id ? '' : view.groupBy }))
    const tracker = await replaceTracker(tenant, row, { columns, views }, user)
    await record(tenant, id, '', user, 'columns', { converted: column.name, from: column.type, to: toType, cleared: plan.failed })
    res.json({ applied: true, tracker, failed: plan.failed })
  }))

  /** Moves rows to just before another row, or to the end. The rest keep their order. */
  app.post('/api/trackers/:id/rows/move', ...scope, route(async (req, res) => {
    const user = who(req), tenant = user.organizationId, id = idParam(req)
    const tracker = await trackerRow(tenant, id, user)
    if (tracker.archived_at) throw new TrackerError('This tracker is archived. Restore it to move rows.', 409)
    const ids = Array.isArray(req.body?.ids) ? [...new Set<string>(req.body.ids.map(String))] : []
    if (!ids.length || ids.length > TRACKER_LIMITS.importBatch || ids.some(value => !UUID.test(value))) throw new TrackerError(`Choose between 1 and ${TRACKER_LIMITS.importBatch} rows to move.`)
    const target = req.body?.before
    if (target !== null && target !== undefined && target !== 'start' && !UUID.test(String(target))) throw new TrackerError('Choose where to move the rows.')
    const all = await db.from('tenant_tracker_rows').select('id,position').eq('tenant_id', tenant).eq('tracker_id', id).order('position').order('created_at').limit(TRACKER_LIMITS.rows + 100)
    check(all.error)
    const current: { id: string; position: number }[] = (all.data || []).map((entry: any) => ({ id: entry.id, position: Number(entry.position) }))
    const wanted = new Set(ids)
    const moving = current.filter(entry => wanted.has(entry.id)).map(entry => entry.id)
    if (!moving.length) throw new TrackerError('Those rows no longer exist.', 404)
    const rest = current.filter(entry => !wanted.has(entry.id)).map(entry => entry.id)
    let at = rest.length
    if (target === 'start') at = 0
    else if (typeof target === 'string') {
      at = rest.indexOf(target)
      if (at < 0) throw new TrackerError(wanted.has(target) ? 'Choose a row that is not being moved.' : 'That row no longer exists. Refresh and try again.', wanted.has(target) ? 400 : 404)
    }
    const order = [...rest.slice(0, at), ...moving, ...rest.slice(at)]
    const sorted = current.map(entry => entry.position)
    const distinct = new Set(sorted).size === sorted.length
    const slots = distinct ? sorted : order.map((_, index) => index + 1)
    const old = new Map(current.map(entry => [entry.id, entry.position]))
    const changes = order.map((rowId, index) => ({ rowId, position: slots[index] })).filter(item => old.get(item.rowId) !== item.position)
    for (let i = 0; i < changes.length; i += 25) {
      await Promise.all(changes.slice(i, i + 25).map(async item => {
        const saved = await db.from('tenant_tracker_rows').update({ position: item.position }).eq('tenant_id', tenant).eq('tracker_id', id).eq('id', item.rowId)
        check(saved.error)
      }))
    }
    if (changes.length) { await record(tenant, id, moving.length === 1 ? moving[0] : '', user, 'rows_moved', { count: moving.length }); await touch(tenant, id) }
    res.json({ moved: moving.length, positions: Object.fromEntries(changes.map(item => [item.rowId, item.position])) })
  }))

  app.put('/api/trackers/:id/views', ...scope, route(async (req, res) => {
    const user = who(req), tenant = user.organizationId, id = idParam(req)
    const row = await trackerRow(tenant, id, user)
    if (row.archived_at) throw new TrackerError('This tracker is archived. Restore it to change its views.', 409)
    await requireRevision(tenant, row, req.body, user)
    const views = normalizeViews(req.body?.views ?? [], columnsOf(row))
    res.json({ tracker: await replaceTracker(tenant, row, { views }, user) })
  }))

  // ---- rows ----
  app.get('/api/trackers/:id/rows', ...scope, route(async (req, res) => {
    const user = who(req), tenant = user.organizationId, id = idParam(req)
    const tracker = await trackerRow(tenant, id, user)
    const offset = Math.max(0, Math.floor(Number(req.query.offset) || 0))
    const limit = Math.max(1, Math.min(PAGE, Math.floor(Number(req.query.limit) || 500)))
    const r = await db.from('tenant_tracker_rows').select('*').eq('tenant_id', tenant).eq('tracker_id', id).order('position').order('created_at').range(offset, offset + limit - 1)
    check(r.error)
    const columns = columnsOf(tracker)
    res.json({ rows: (r.data || []).map((entry: any) => rowOut(entry, columns)), total: await rowCount(tenant, id), offset })
  }))

  app.post('/api/trackers/:id/rows', ...scope, route(async (req, res) => {
    const user = who(req), tenant = user.organizationId, id = idParam(req)
    const tracker = await trackerRow(tenant, id, user)
    if (tracker.archived_at) throw new TrackerError('This tracker is archived. Restore it to add rows.', 409)
    const input = req.body?.rows
    if (!Array.isArray(input) || !input.length) throw new TrackerError('Add at least one row.')
    if (input.length > TRACKER_LIMITS.importBatch) throw new TrackerError(`Add at most ${TRACKER_LIMITS.importBatch} rows at a time.`)
    const columns = columnsOf(tracker)
    const state = input.some((entry: any) => entry?.taskId) ? await workspace(tenant) : {}
    const cleaned = input.map((entry: any, index: number) => ({ ...cleanRowInput(columns, entry, input.length > 1 ? `Row ${index + 1}` : ''), taskId: taskIdOf(state, entry?.taskId) }))
    const total = await rowCount(tenant, id)
    if (total + cleaned.length > TRACKER_LIMITS.rows) throw new TrackerError(`A tracker can have at most ${TRACKER_LIMITS.rows.toLocaleString('en')} rows. This one has ${total.toLocaleString('en')}.`, 409)
    const last = await db.from('tenant_tracker_rows').select('position').eq('tenant_id', tenant).eq('tracker_id', id).order('position', { ascending: false }).limit(1)
    check(last.error)
    let position = Number(last.data?.[0]?.position ?? 0)
    const stamp = now()
    const records = cleaned.map(entry => ({
      tenant_id: tenant, tracker_id: id, id: randomUUID(), position: ++position,
      data: mergeCells({}, columns, entry.cells), secrets: mergeSecrets({}, columns, tenant, entry.secrets), task_id: entry.taskId,
      version: 1, created_by: user.id, updated_by: user.id, created_at: stamp, updated_at: stamp,
    }))
    const saved = await db.from('tenant_tracker_rows').insert(records)
    check(saved.error)
    if (records.length === 1) await record(tenant, id, records[0].id, user, 'row_created', {})
    else await record(tenant, id, '', user, 'rows_added', { count: records.length })
    await touch(tenant, id)
    res.status(201).json({ rows: records.map(entry => rowOut(entry, columns)) })
  }))

  async function oneRow(tenant: string, trackerId: string, rowId: string) {
    if (!UUID.test(rowId)) throw new TrackerError('Row not found.', 404)
    const r = await db.from('tenant_tracker_rows').select('*').eq('tenant_id', tenant).eq('tracker_id', trackerId).eq('id', rowId).maybeSingle()
    check(r.error)
    if (!r.data) throw new TrackerError('Row not found. It may have been deleted.', 404)
    return r.data
  }

  app.patch('/api/trackers/:id/rows/:rowId', ...scope, route(async (req, res) => {
    const user = who(req), tenant = user.organizationId, id = idParam(req)
    const tracker = await trackerRow(tenant, id, user)
    if (tracker.archived_at) throw new TrackerError('This tracker is archived. Restore it to edit rows.', 409)
    const columns = columnsOf(tracker), byId = new Map(columns.map(column => [column.id, column]))
    const current = await oneRow(tenant, id, String(req.params.rowId))
    const body = req.body || {}
    if (!Number.isInteger(body.version)) throw new TrackerError('The row version is required.')
    if (body.version !== Number(current.version || 1)) throw new TrackerError('Someone else changed this row. It was reloaded; review it and try again.', 409, { row: rowOut(current, columns) })
    const cleaned = cleanRowInput(columns, body, '')
    let taskId = current.task_id || ''
    if (body.taskId !== undefined) taskId = body.taskId === null || body.taskId === '' ? '' : taskIdOf(await workspace(tenant), body.taskId)
    const data = mergeCells(current.data || {}, columns, cleaned.cells)
    const secrets = mergeSecrets(current.secrets || {}, columns, tenant, cleaned.secrets)
    const changed = Object.keys(cleaned.cells).filter(columnId => JSON.stringify(current.data?.[columnId] ?? emptyOf(byId.get(columnId)!)) !== JSON.stringify(cleaned.cells[columnId]))
    const secretsChanged = Object.keys(cleaned.secrets).filter(columnId => Boolean(current.secrets?.[columnId]) !== Boolean(cleaned.secrets[columnId]) || cleaned.secrets[columnId])
    if (!changed.length && !secretsChanged.length && taskId === (current.task_id || '')) return void res.json({ row: rowOut(current, columns) })
    const stamp = now()
    const saved = await db.from('tenant_tracker_rows').update({ data, secrets, task_id: taskId, version: body.version + 1, updated_by: user.id, updated_at: stamp })
      .eq('tenant_id', tenant).eq('tracker_id', id).eq('id', current.id).eq('version', body.version).select('id')
    check(saved.error)
    if (!saved.data?.length) {
      const latest = await oneRow(tenant, id, current.id)
      throw new TrackerError('Someone else changed this row. It was reloaded; review it and try again.', 409, { row: rowOut(latest, columns) })
    }
    const next = { ...current, data, secrets, task_id: taskId, version: body.version + 1, updated_at: stamp }
    if (changed.length) await record(tenant, id, current.id, user, 'cells', { cells: changed.map(columnId => ({ columnId, name: byId.get(columnId)!.name, from: shown(byId.get(columnId)!, current.data?.[columnId]), to: shown(byId.get(columnId)!, cleaned.cells[columnId]) })) })
    if (secretsChanged.length) await record(tenant, id, current.id, user, 'secrets', { cells: secretsChanged.map(columnId => ({ columnId, name: byId.get(columnId)!.name, action: cleaned.secrets[columnId] ? 'set' : 'cleared' })) })
    if (taskId !== (current.task_id || '')) {
      const title = taskId ? ((await workspace(tenant)).items || []).find((item: any) => item.id === taskId)?.title || '' : ''
      await record(tenant, id, current.id, user, taskId ? 'task_linked' : 'task_unlinked', { taskId, title })
    }
    await touch(tenant, id)
    res.json({ row: rowOut(next, columns) })
  }))

  // Links many rows to their tasks at once, for example right after the tasks were created for an import.
  app.post('/api/trackers/:id/rows/tasks', ...scope, route(async (req, res) => {
    const user = who(req), tenant = user.organizationId, id = idParam(req)
    const tracker = await trackerRow(tenant, id, user)
    if (tracker.archived_at) throw new TrackerError('This tracker is archived. Restore it to change rows.', 409)
    const input = Array.isArray(req.body?.links) ? req.body.links : []
    if (!input.length || input.length > TRACKER_LIMITS.importBatch) throw new TrackerError(`Link between 1 and ${TRACKER_LIMITS.importBatch} rows at a time.`)
    const state = await workspace(tenant)
    const wanted = new Map<string, string>()
    for (const entry of input) {
      const rowId = String(entry?.rowId ?? '')
      if (!UUID.test(rowId)) throw new TrackerError('Every link needs a row.')
      wanted.set(rowId, taskIdOf(state, entry?.taskId))
    }
    const found = await db.from('tenant_tracker_rows').select('*').eq('tenant_id', tenant).eq('tracker_id', id).in('id', [...wanted.keys()])
    check(found.error)
    const titles = new Map<string, string>((state.items || []).map((item: any) => [item.id, item.title || '']))
    const columns = columnsOf(tracker), stamp = now(), rows: TrackerRow[] = []
    for (const current of found.data || []) {
      const taskId = wanted.get(current.id) || ''
      if (taskId === (current.task_id || '')) { rows.push(rowOut(current, columns)); continue }
      const version = Number(current.version || 1) + 1
      const saved = await db.from('tenant_tracker_rows').update({ task_id: taskId, version, updated_by: user.id, updated_at: stamp }).eq('tenant_id', tenant).eq('tracker_id', id).eq('id', current.id)
      check(saved.error)
      await record(tenant, id, current.id, user, taskId ? 'task_linked' : 'task_unlinked', { taskId, title: titles.get(taskId) || '' })
      rows.push(rowOut({ ...current, task_id: taskId, version, updated_at: stamp }, columns))
    }
    if (rows.length) await touch(tenant, id)
    res.json({ rows })
  }))

  app.post('/api/trackers/:id/rows/delete', ...scope, route(async (req, res) => {
    const user = who(req), tenant = user.organizationId, id = idParam(req)
    const tracker = await trackerRow(tenant, id, user)
    if (tracker.archived_at) throw new TrackerError('This tracker is archived. Restore it to delete rows.', 409)
    const ids = Array.isArray(req.body?.ids) ? [...new Set<string>(req.body.ids.map(String))] : []
    if (!ids.length || ids.length > TRACKER_LIMITS.importBatch || ids.some(value => !UUID.test(value))) throw new TrackerError(`Choose between 1 and ${TRACKER_LIMITS.importBatch} rows to delete.`)
    const removed = await db.from('tenant_tracker_rows').delete().eq('tenant_id', tenant).eq('tracker_id', id).in('id', ids).select('id')
    check(removed.error)
    // Links are best effort: before the links table exists there is nothing to clean up.
    if (removed.data?.length) await db.from('tenant_tracker_task_links').delete().eq('tenant_id', tenant).eq('tracker_id', id).in('row_id', ids)
    const count = removed.data?.length ?? 0
    if (count) { await record(tenant, id, ids.length === 1 ? ids[0] : '', user, 'rows_deleted', { count }); await touch(tenant, id) }
    res.json({ deleted: count })
  }))

  const revealLimit = rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many reveals. Wait a minute and try again.' } })
  app.post('/api/trackers/:id/rows/:rowId/reveal', ...scope, revealLimit, route(async (req, res) => {
    const user = who(req), tenant = user.organizationId, id = idParam(req)
    const tracker = await trackerRow(tenant, id, user)
    const column = columnsOf(tracker).find(item => item.id === req.body?.columnId)
    if (!column || column.type !== 'secret') throw new TrackerError('That is not a Secret column.', 404)
    if (column.revealBy === 'admins' && user.role !== 'Administrator') throw new TrackerError('Only an Administrator can reveal this column.', 403)
    const current = await oneRow(tenant, id, String(req.params.rowId))
    const stored = current.secrets?.[column.id]
    if (!stored) throw new TrackerError('Nothing is stored in this cell.', 404)
    // Record first: if the record cannot be written, nothing is revealed.
    await record(tenant, id, current.id, user, 'reveal', { columnId: column.id, name: column.name }, true)
    const value = decryptSecret(stored, tenant, 'tracker-secret', key())
    res.json({ value, seconds: 30 })
  }))

  app.get('/api/trackers/:id/rows/:rowId/history', ...scope, route(async (req, res) => {
    const user = who(req), tenant = user.organizationId, id = idParam(req)
    await trackerRow(tenant, id, user)
    const rowId = String(req.params.rowId)
    if (!UUID.test(rowId)) throw new TrackerError('Row not found.', 404)
    const r = await db.from('tenant_tracker_changes').select('id,actor_name,kind,detail,created_at').eq('tenant_id', tenant).eq('tracker_id', id).eq('row_id', rowId).order('created_at', { ascending: false }).limit(HISTORY)
    check(r.error)
    res.json({ changes: (r.data || []).map((entry: any) => ({ id: entry.id, actorName: entry.actor_name || '', kind: entry.kind, detail: entry.detail || {}, at: entry.created_at })) })
  }))
}

const emptyOf = (column: TrackerColumn): Cell => column.type === 'number' ? null : column.type === 'checkbox' ? false : column.type === 'multiselect' ? [] : ''
