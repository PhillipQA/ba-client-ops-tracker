import { randomUUID } from 'node:crypto'
import type { Express, Request, RequestHandler, Response } from 'express'
import {
  cleanDefinition,
  emptyDefinition,
  REPORT_LIMITS,
  TEMPLATE_KEYS,
} from '../../src/features/reports/custom/reportModel'

/**
 * Reports: dashboards people build from widgets, kept in folders, and the templates new reports start from.
 * - A report or folder is private to the person who made it until they share it with the whole account.
 * - Its maker can change it; Administrators can also change shared ones. Everyone else can copy a shared report.
 * - Templates: anyone may keep private ones. Only Administrators make, change, hide or delete the account's shared
 *   templates. A suggested template (templateKey) is changed by storing the account's own copy; deleting that copy
 *   puts the suggested one back, and hiding it hides the template from everyone but Administrators.
 * - Saved queries (Data explorer) are for Administrators and people given the Data explorer module. They are private to
 *   whoever saved them; shared ones are the account's query templates, which only Administrators make and change.
 * - Only the widgets, filters and queries are stored. The numbers are worked out in the browser, from data the person
 *   can see.
 */
type Deps = { db: any; requireAuth: RequestHandler; requireTenant: RequestHandler; now?: () => Date }
type User = { id: string; name: string; role: string; organizationId: string; modules?: string[]; accountType?: string }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const TABLE = 'tenant_reports'

class ReportError extends Error {
  constructor(
    message: string,
    public status = 400,
    public extra: Record<string, unknown> = {},
  ) {
    super(message)
  }
}

const clean = (value: unknown, label: string, max: number) => {
  if (value !== undefined && value !== null && typeof value !== 'string')
    throw new ReportError(`${label} must be text.`)
  const out = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (out.length > max) throw new ReportError(`${label} can be at most ${max} characters.`)
  return out
}

export function registerCustomReportRoutes(app: Express, deps: Deps) {
  const { db } = deps
  const now = () => (deps.now ? deps.now() : new Date()).toISOString()
  const who = (req: Request) => (req as any).authUser as User
  const guard: RequestHandler = (req, res, next) => {
    const user = (req as any).authUser as User | undefined
    if (!db) return void res.status(503).json({ error: 'Database is not configured.' })
    if (
      !user?.organizationId ||
      user.accountType === 'platform' ||
      (user.role !== 'Administrator' && !user.modules?.includes('reports'))
    )
      return void res.status(403).json({ error: 'Reports access is required.' })
    if (req.method !== 'GET' && user.role === 'Viewer')
      return void res.status(403).json({ error: 'Your role can view reports but not change them.' })
    res.setHeader('Cache-Control', 'no-store')
    next()
  }
  const scope = [deps.requireAuth, deps.requireTenant, guard]
  const missing = (error: any) => {
    if (error)
      throw new ReportError(
        'Custom reports are unavailable. Check the database connection; a new database needs database/schema.sql.',
        503,
        { needsUpgrade: true },
      )
  }
  const route =
    (handler: (req: Request, res: Response) => Promise<void>): RequestHandler =>
    async (req, res) => {
      try {
        await handler(req, res)
      } catch (error) {
        if (error instanceof ReportError)
          return void res.status(error.status).json({ error: error.message, ...error.extra })
        res.status(500).json({ error: 'Custom reports are unavailable right now. Try again in a moment.' })
      }
    }

  const isAdmin = (user: User) => user.role === 'Administrator'
  /** The Data explorer: people given its module. Administrators have every module the account has. */
  const explores = (user: User) => Boolean(user.modules?.includes('explorer'))
  const visible = (row: any, user: User) =>
    (Boolean(row.shared) || row.created_by === user.id) &&
    !(row.kind === 'template' && row.hidden && !isAdmin(user)) &&
    (row.kind !== 'query' || explores(user))
  const canEdit = (row: any, user: User) => {
    if (user.role === 'Viewer') return false
    if (row.kind === 'query' && !explores(user)) return false
    if (row.kind === 'template' || row.kind === 'query') return row.shared ? isAdmin(user) : row.created_by === user.id
    return row.created_by === user.id || (Boolean(row.shared) && isAdmin(user))
  }
  const kindOf = (value: unknown): 'report' | 'folder' | 'template' | 'query' =>
    value === 'folder' || value === 'template' || value === 'query' ? value : 'report'
  /** Saving a query before the Data explorer's database upgrade: the rest of Reports keeps working. */
  const missingQueries = (error: any) => {
    if (error)
      throw new ReportError(
        'Saved queries are unavailable (queries still run). Check the database connection; a new database needs database/schema.sql.',
        503,
      )
  }
  const out = (row: any, user: User) => ({
    id: row.id,
    kind: kindOf(row.kind),
    name: row.name,
    description: row.description || '',
    folderId: row.folder_id || '',
    shared: Boolean(row.shared),
    position: Number(row.position) || 0,
    definition: row.kind === 'folder' ? emptyDefinition() : cleanDefinition(row.definition),
    revision: Number(row.revision) || 1,
    createdBy: row.created_by || '',
    createdByName: row.created_by_name || '',
    updatedByName: row.updated_by_name || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    canEdit: canEdit(row, user),
    templateKey: row.template_key || '',
    hidden: Boolean(row.hidden),
  })
  async function one(user: User, id: string) {
    if (!UUID.test(id)) throw new ReportError('Report not found.', 404)
    const r = await db.from(TABLE).select('*').eq('tenant_id', user.organizationId).eq('id', id).maybeSingle()
    missing(r.error)
    if (!r.data || !visible(r.data, user)) throw new ReportError('Report not found. It may have been deleted.', 404)
    return r.data
  }
  const definition = (raw: unknown) => {
    const cleaned = cleanDefinition(raw)
    if (JSON.stringify(cleaned).length > REPORT_LIMITS.definitionBytes)
      throw new ReportError('This report is too big to save. Remove some widgets and try again.', 413)
    return cleaned
  }
  /** A folder to put something in: one the person can see. Empty means no folder. */
  async function folder(user: User, raw: unknown, self = '') {
    const id = typeof raw === 'string' ? raw : ''
    if (!id) return ''
    if (id === self) throw new ReportError('A folder cannot go inside itself.')
    const target = await one(user, id).catch(() => null)
    if (target?.kind !== 'folder') throw new ReportError('That folder was not found. It may have been deleted.')
    return target.id as string
  }

  app.get(
    '/api/reports/custom',
    ...scope,
    route(async (req, res) => {
      const user = who(req)
      const r = await db
        .from(TABLE)
        .select('*')
        .eq('tenant_id', user.organizationId)
        .order('position', { ascending: true })
        .limit(REPORT_LIMITS.items + 100)
      missing(r.error)
      const items = (r.data || [])
        .filter((row: any) => visible(row, user))
        .map((row: any) => out(row, user))
        .sort(
          (a: any, b: any) =>
            a.position - b.position || a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }),
        )
      res.json({ items })
    }),
  )

  app.post(
    '/api/reports/custom',
    ...scope,
    route(async (req, res) => {
      const user = who(req)
      const kind = kindOf(req.body?.kind)
      const name = clean(req.body?.name, 'The name', REPORT_LIMITS.name)
      if (kind === 'query' && !explores(user)) throw new ReportError('Data explorer access is required.', 403)
      if (!name)
        throw new ReportError(
          kind === 'folder'
            ? 'Give the folder a name.'
            : kind === 'template'
              ? 'Give the template a name.'
              : kind === 'query'
                ? 'Give the query a name.'
                : 'Give the report a name.',
        )
      let shared = req.body?.shared === true
      if (kind === 'query' && shared && !isAdmin(user))
        throw new ReportError('Only Administrators make query templates for everyone. Keep it as your own query.', 403)
      const cleaned = kind === 'folder' ? {} : definition(req.body?.definition)
      if (kind === 'query' && !(cleaned as any).query?.sql?.trim())
        throw new ReportError('Write a query before saving it.')
      let templateKey = ''
      if (kind === 'template') {
        templateKey = typeof req.body?.templateKey === 'string' ? req.body.templateKey : ''
        if (templateKey && !TEMPLATE_KEYS.includes(templateKey))
          throw new ReportError('That suggested template does not exist.')
        if (templateKey) shared = true
        if (shared && !isAdmin(user))
          throw new ReportError('Only Administrators make templates for everyone. Keep it as your own template.', 403)
        if (templateKey) {
          const existing = await db
            .from(TABLE)
            .select('*')
            .eq('tenant_id', user.organizationId)
            .eq('template_key', templateKey)
            .maybeSingle()
          missing(existing.error)
          if (existing.data)
            throw new ReportError('This template was already changed for the account.', 409, {
              item: out(existing.data, user),
            })
        }
      }
      const count = await db
        .from(TABLE)
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', user.organizationId)
      missing(count.error)
      if (Number(count.count || 0) >= REPORT_LIMITS.items)
        throw new ReportError(`An account can have at most ${REPORT_LIMITS.items} reports, folders and templates.`, 409)
      const stamp = now()
      const row: Record<string, unknown> = {
        tenant_id: user.organizationId,
        id: randomUUID(),
        kind,
        name,
        description: clean(req.body?.description, 'The description', REPORT_LIMITS.description),
        folder_id: kind === 'report' ? await folder(user, req.body?.folderId) : '',
        shared,
        position: Math.max(0, Math.min(1_000_000, Math.round(Number(req.body?.position) || 0))),
        definition: cleaned,
        revision: 1,
        created_by: user.id,
        created_by_name: user.name,
        updated_by_name: user.name,
        created_at: stamp,
        updated_at: stamp,
      }
      if (kind === 'template') {
        row.template_key = templateKey
        row.hidden = shared && req.body?.hidden === true
      }
      const saved = await db.from(TABLE).insert(row)
      // Before v33 the table refuses the 'query' kind; everything else about reports still works.
      if (kind === 'query') missingQueries(saved.error)
      missing(saved.error)
      res.status(201).json({ item: out(row, user) })
    }),
  )

  app.patch(
    '/api/reports/custom/:id',
    ...scope,
    route(async (req, res) => {
      const user = who(req)
      const current = await one(user, String(req.params.id))
      if (!canEdit(current, user))
        throw new ReportError(
          current.kind === 'query'
            ? current.shared && explores(user)
              ? "Only Administrators change the account's query templates. Save your own copy to change it."
              : 'Only the person who saved this query can change it.'
            : current.kind === 'template' && current.shared
              ? "Only Administrators change the account's templates. Start a report from it, or save your own template."
              : current.shared
                ? 'Only the person who made this report, or an Administrator, can change it. Make a copy to change your own.'
                : 'Only the person who made this can change it.',
          403,
        )
      const body = req.body || {}
      const patch: Record<string, unknown> = {}
      if (body.name !== undefined) {
        const name = clean(body.name, 'The name', REPORT_LIMITS.name)
        if (!name) throw new ReportError('Give it a name.')
        patch.name = name
      }
      if (body.description !== undefined)
        patch.description = clean(body.description, 'The description', REPORT_LIMITS.description)
      if (body.shared !== undefined) {
        const shared = body.shared === true
        if (current.kind === 'query' && shared && !isAdmin(user))
          throw new ReportError('Only Administrators make query templates for everyone.', 403)
        if (current.kind === 'template') {
          if (shared && !isAdmin(user)) throw new ReportError('Only Administrators make templates for everyone.', 403)
          if (!shared && current.template_key)
            throw new ReportError('A suggested template stays with everyone. Hide it instead.')
          if (!shared) patch.hidden = false
        }
        patch.shared = shared
      }
      if (body.hidden !== undefined) {
        if (current.kind !== 'template' || !isAdmin(user))
          throw new ReportError('Only Administrators hide templates.', 403)
        patch.hidden = body.hidden === true && (patch.shared ?? current.shared) === true
      }
      if (body.position !== undefined)
        patch.position = Math.max(0, Math.min(1_000_000, Math.round(Number(body.position) || 0)))
      if (body.folderId !== undefined && current.kind === 'report')
        patch.folder_id = await folder(user, body.folderId, current.id)
      if (body.definition !== undefined && current.kind !== 'folder') {
        // Two people editing one shared report: the second save is refused rather than overwriting the first.
        if (body.revision !== undefined && Number(body.revision) !== Number(current.revision))
          throw new ReportError('Someone else changed this report. It has been reloaded with their changes.', 409, {
            item: out(current, user),
          })
        patch.definition = definition(body.definition)
        if (current.kind === 'query' && !(patch.definition as any).query?.sql?.trim())
          throw new ReportError('Write a query before saving it.')
      }
      const changes = {
        ...patch,
        revision: (Number(current.revision) || 1) + 1,
        updated_by_name: user.name,
        updated_at: now(),
      }
      const saved = await db.from(TABLE).update(changes).eq('tenant_id', user.organizationId).eq('id', current.id)
      missing(saved.error)
      res.json({ item: out({ ...current, ...changes }, user) })
    }),
  )

  app.delete(
    '/api/reports/custom/:id',
    ...scope,
    route(async (req, res) => {
      const user = who(req)
      const current = await one(user, String(req.params.id))
      if (!canEdit(current, user)) throw new ReportError('Only the person who made this can delete it.', 403)
      // Reports in a deleted folder are kept, out of any folder. Deleting the account's copy of a suggested template
      // brings the suggested one back.
      if (current.kind === 'folder') {
        const moved = await db
          .from(TABLE)
          .update({ folder_id: '' })
          .eq('tenant_id', user.organizationId)
          .eq('folder_id', current.id)
        missing(moved.error)
      }
      const removed = await db.from(TABLE).delete().eq('tenant_id', user.organizationId).eq('id', current.id)
      missing(removed.error)
      res.json({ deleted: true })
    }),
  )
}
