/**
 * Trackers, the base: who may do what, reading and shaping trackers and rows, history, and checking what a
 * request sends. Every other tracker module builds on this.
 */
import { randomUUID } from 'node:crypto'
import type { Request, RequestHandler, Response } from 'express'
import { encryptionKey, IntegrationError, encryptSecret } from '../integrations/tenant-integrations'
import { cleanMembers } from '../../src/features/trackers/trackerFolders'
import {
  TrackerError,
  splitClientIds,
  type Tracker,
  type TrackerColumn,
  type TrackerRow,
  type Cell,
  isBasicType,
  isEmptyCell,
  OPTION_COLORS,
  type OptionColor,
  TRACKER_CLIENTS,
  TRACKER_PROJECTS,
  cleanCell,
  cleanSecret,
} from '../../src/features/trackers/trackerModel'
import { scopeFor } from '../../src/shared/access'
import type { SheetIssue } from '../../src/features/trackers/trackerAutoDone'
import { type Deps, type User, UUID } from './tracker-common'

export function trackerCore(deps: Deps) {
  const { db } = deps
  const now = () => (deps.now ? deps.now() : new Date()).toISOString()
  const who = (req: Request) => (req as any).authUser as User
  const key = () => deps.key ?? encryptionKey()

  // Viewers, and job roles that see trackers but may not change them (shared/roles.ts), only read.
  const readOnly = (user: any) =>
    user?.role === 'Viewer' || (Array.isArray(user?.editModules) && !user.editModules.includes('trackers'))
  const guard: RequestHandler = (req, res, next) => {
    const user = (req as any).authUser
    if (!db) return void res.status(503).json({ error: 'Database is not configured.' })
    if (!user?.organizationId || user.accountType === 'platform' || !user.modules?.includes('trackers'))
      return void res.status(403).json({ error: 'Trackers access is required.' })
    if (req.method !== 'GET' && readOnly(user))
      return void res.status(403).json({ error: 'Your role can view trackers but not change them.' })
    res.setHeader('Cache-Control', 'no-store')
    next()
  }
  const scope = [deps.requireAuth, deps.requireTenant, guard]

  const check = (error: any) => {
    if (error)
      throw new TrackerError(
        'Trackers storage is unavailable. Check the database connection; a new database needs database/schema.sql.',
        503,
      )
  }
  const route =
    (handler: (req: Request, res: Response) => Promise<void>): RequestHandler =>
    async (req, res) => {
      try {
        await handler(req, res)
      } catch (error) {
        if (error instanceof TrackerError)
          return void res.status(error.status).json({ error: error.message, ...(error.extra || {}) })
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
    try {
      return (await deps.load(tenant)).data || {}
    } catch {
      throw new TrackerError('The workspace could not be read. Try again in a moment.', 503)
    }
  }
  const manageable = (user: User, row: any) => user.role === 'Administrator' || row.created_by === user.id

  /** With per-person visibility on, a tracker shows only to people who see all of its clients (or its project). */
  function trackerVisibleIn(state: any, user: User) {
    const scope = scopeFor(state, user.id)
    if (scope.all) return () => true
    return (row: any) => {
      const clients = splitClientIds(row.client_id)
      if (clients.length) return clients.every(clientId => scope.fullClients.has(clientId))
      const projects = splitClientIds(row.project_id)
      if (projects.length) return projects.some(projectId => scope.fullProjects.has(projectId))
      return row.created_by === user.id
    }
  }
  async function trackerRow(tenant: string, id: string, user: User) {
    const r = await db.from('tenant_trackers').select('*').eq('tenant_id', tenant).eq('id', id).maybeSingle()
    check(r.error)
    // A private tracker does not exist for anyone but its creator.
    if (!r.data || (r.data.private && r.data.created_by !== user.id)) throw new TrackerError('Tracker not found.', 404)
    if (!trackerVisibleIn(await workspace(tenant), user)(r.data)) throw new TrackerError('Tracker not found.', 404)
    return r.data
  }
  async function rowCount(tenant: string, trackerId: string) {
    const r = await db
      .from('tenant_tracker_rows')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenant)
      .eq('tracker_id', trackerId)
    check(r.error)
    return Number(r.count || 0)
  }
  /** users: everyone the tracker shows in the folder of (trackerFolders); worked out where the workspace is at hand. */
  const trackerOut = (row: any, user: User, count: number, users?: string[]): Tracker => ({
    id: row.id,
    name: row.name,
    clientId: splitClientIds(row.client_id)[0] || '',
    clientIds: splitClientIds(row.client_id),
    // A tracker can have several projects (comma-separated, like clients); the first is its default.
    projectId: splitClientIds(row.project_id)[0] || '',
    projectIds: splitClientIds(row.project_id),
    private: Boolean(row.private),
    template: row.template || '',
    ...(typeof row.step_tasks === 'boolean' ? { stepTasks: row.step_tasks } : {}),
    seedsRows: row.seeds_rows === true,
    columns: Array.isArray(row.columns) ? row.columns : [],
    views: Array.isArray(row.views) ? row.views : [],
    ...(row.timeline && typeof row.timeline === 'object' ? { timeline: row.timeline } : {}),
    revision: Number(row.revision || 1),
    rowCount: count,
    createdBy: row.created_by || '',
    createdByName: row.created_by_name || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archived: Boolean(row.archived_at),
    canEdit: !readOnly(user),
    canManage: manageable(user, row),
    members: cleanMembers(row.members, row.created_by || ''),
    ...(users ? { users } : {}),
  })
  const columnsOf = (row: any): TrackerColumn[] => (Array.isArray(row.columns) ? row.columns : [])

  function rowOut(row: any, columns: TrackerColumn[]): TrackerRow {
    const cells: Record<string, Cell> = {},
      secretSet: Record<string, true> = {}
    for (const column of columns) {
      if (isBasicType(column.type)) {
        const value = row.data?.[column.id]
        if (!isEmptyCell(value)) cells[column.id] = value
      } else if (column.type === 'secret' && row.secrets?.[column.id]) secretSet[column.id] = true
    }
    return {
      id: row.id,
      position: Number(row.position),
      cells,
      secretSet,
      taskId: row.task_id || '',
      version: Number(row.version || 1),
      updatedAt: row.updated_at,
      ...(row.source_key ? { sourceKey: String(row.source_key) } : {}),
      ...(row.source_missing ? { sourceMissing: true } : {}),
      ...(row.review ? { review: true } : {}),
      ...(row.sheet_issue?.code ? { sheetIssue: row.sheet_issue as SheetIssue } : {}),
      ...(OPTION_COLORS.includes(row.highlight) ? { highlight: row.highlight as OptionColor } : {}),
    }
  }

  /** What is written to the history for a value. Secrets are never included. */
  function shown(column: TrackerColumn, value: Cell | undefined) {
    if (value === undefined || isEmptyCell(value)) return ''
    if (column.type === 'checkbox') return value ? 'Yes' : 'No'
    if (column.type === 'select') return column.options?.find(option => option.id === value)?.label || ''
    if (column.type === 'multiselect')
      return (value as string[])
        .map(id => column.options?.find(option => option.id === id)?.label || '')
        .filter(Boolean)
        .join(', ')
    return String(value).slice(0, 120)
  }
  async function record(
    tenant: string,
    trackerId: string,
    rowId: string,
    user: User,
    kind: string,
    detail: Record<string, unknown>,
    required = false,
  ) {
    const r = await db.from('tenant_tracker_changes').insert({
      id: randomUUID(),
      tenant_id: tenant,
      tracker_id: trackerId,
      row_id: rowId,
      actor_id: user.id,
      actor_name: user.name,
      kind,
      detail,
      created_at: now(),
    })
    // History is best effort, except for a reveal: a secret is never shown without a record that it was.
    if (r.error && required)
      throw new TrackerError('The reveal could not be recorded, so nothing was shown. Try again.', 503)
  }
  async function touch(tenant: string, trackerId: string) {
    await db.from('tenant_trackers').update({ updated_at: now() }).eq('tenant_id', tenant).eq('id', trackerId)
  }

  function validateLinks(
    state: any,
    body: { clientId?: unknown; clientIds?: unknown; projectId?: unknown; projectIds?: unknown },
    user: User,
  ) {
    const scope = scopeFor(state, user.id)
    const pick = (value: unknown, list: any[], label: string) => {
      const id = String(value ?? '').trim()
      const open = label === 'client' ? scope.writeClients : scope.writeProjects
      if (id && (!(list || []).some((item: any) => item.id === id) || (!scope.all && !open.has(id))))
        throw new TrackerError(`That ${label} was not found in your account.`)
      return id
    }
    // A tracker can follow several clients. `clientIds` wins; a single `clientId` still works for older callers.
    let clientId: string | undefined
    if (body.clientIds !== undefined) {
      if (!Array.isArray(body.clientIds)) throw new TrackerError('clientIds must be a list.')
      const ids = [
        ...new Set(body.clientIds.map((value: unknown) => pick(value, state.clients, 'client')).filter(Boolean)),
      ]
      if (ids.length > TRACKER_CLIENTS)
        throw new TrackerError(`A tracker can follow at most ${TRACKER_CLIENTS} clients.`)
      clientId = ids.join(',')
    } else if (body.clientId !== undefined) clientId = pick(body.clientId, state.clients, 'client')
    // Several projects under the tracker's clients (each with its own contract). `projectIds` wins; its first is the
    // default. A single `projectId` still works for older callers.
    let projectId: string | undefined
    if (body.projectIds !== undefined) {
      if (!Array.isArray(body.projectIds)) throw new TrackerError('projectIds must be a list.')
      const ids = [
        ...new Set(body.projectIds.map((value: unknown) => pick(value, state.projects, 'project')).filter(Boolean)),
      ]
      if (ids.length > TRACKER_PROJECTS)
        throw new TrackerError(`A tracker can have at most ${TRACKER_PROJECTS} projects.`)
      projectId = ids.join(',')
    } else if (body.projectId !== undefined) projectId = pick(body.projectId, state.projects, 'project')
    return { clientId, projectId }
  }
  function taskIdOf(state: any, value: unknown) {
    const id = String(value ?? '').trim()
    if (!id) return ''
    if (id.length > 100 || !(state.items || []).some((item: any) => item.id === id))
      throw new TrackerError('That task was not found in your account.')
    return id
  }

  /** Cleans the cells and secrets for one row. `existing` is the row being changed, if any. */
  function cleanRowInput(columns: TrackerColumn[], input: any, label: string) {
    const byId = new Map(columns.map(column => [column.id, column]))
    const cells: Record<string, Cell> = {},
      secrets: Record<string, string | null> = {}
    const fail = (message: string): never => {
      throw new TrackerError(label ? `${label}: ${message}` : message)
    }
    if (
      input?.cells !== undefined &&
      (typeof input.cells !== 'object' || input.cells === null || Array.isArray(input.cells))
    )
      fail('cells must be an object.')
    for (const [id, raw] of Object.entries<unknown>(input?.cells || {})) {
      const column = byId.get(id)
      if (!column) fail('That column no longer exists. Reload the tracker.')
      const result = cleanCell(column!, raw)
      if (!result.ok) fail(result.error)
      else cells[id] = result.value
    }
    if (
      input?.secrets !== undefined &&
      (typeof input.secrets !== 'object' || input.secrets === null || Array.isArray(input.secrets))
    )
      fail('secrets must be an object.')
    for (const [id, raw] of Object.entries<unknown>(input?.secrets || {})) {
      const column = byId.get(id)
      if (!column) fail('That column no longer exists. Reload the tracker.')
      if (raw === null || raw === '') {
        if (column!.type !== 'secret') fail(`${column!.name} is not a Secret column.`)
        secrets[id] = null
        continue
      }
      const result = cleanSecret(column!, raw)
      if (!result.ok) fail(result.error)
      else secrets[id] = result.value
    }
    return { cells, secrets }
  }
  const mergeCells = (data: Record<string, Cell>, columns: TrackerColumn[], cells: Record<string, Cell>) => {
    // Only values for columns that still exist are kept; emptied cells are removed instead of stored as empty.
    const next: Record<string, Cell> = {}
    for (const column of columns)
      if (isBasicType(column.type)) {
        const value = column.id in cells ? cells[column.id] : data?.[column.id]
        if (!isEmptyCell(value as Cell)) next[column.id] = value as Cell
      }
    return next
  }
  const mergeSecrets = (
    current: Record<string, string>,
    columns: TrackerColumn[],
    tenant: string,
    changes: Record<string, string | null>,
  ) => {
    const next: Record<string, string> = {}
    for (const column of columns)
      if (column.type === 'secret') {
        if (column.id in changes) {
          const value = changes[column.id]
          if (value) next[column.id] = encryptSecret(value, tenant, 'tracker-secret', key())
        } else if (current?.[column.id]) next[column.id] = current[column.id]
      }
    return next
  }

  async function oneRow(tenant: string, trackerId: string, rowId: string) {
    if (!UUID.test(rowId)) throw new TrackerError('Row not found.', 404)
    const r = await db
      .from('tenant_tracker_rows')
      .select('*')
      .eq('tenant_id', tenant)
      .eq('tracker_id', trackerId)
      .eq('id', rowId)
      .maybeSingle()
    check(r.error)
    if (!r.data) throw new TrackerError('Row not found. It may have been deleted.', 404)
    return r.data
  }

  return {
    db,
    check,
    columnsOf,
    workspace,
    now,
    record,
    mergeCells,
    touch,
    rowOut,
    shown,
    scope,
    route,
    who,
    idParam,
    trackerRow,
    trackerOut,
    rowCount,
    readOnly,
    trackerVisibleIn,
    validateLinks,
    taskIdOf,
    oneRow,
    manageable,
    cleanRowInput,
    mergeSecrets,
    key,
  }
}

export type TrackerCore = ReturnType<typeof trackerCore>
