import { randomUUID } from 'node:crypto'
import type { Express, Request, RequestHandler, Response } from 'express'
import { cleanName, normalizeColumns, TrackerError } from '../../src/features/trackers/trackerModel'
import { TEMPLATE_LIMITS, TRACKER_TEMPLATES } from '../../src/features/trackers/trackerTemplates'

/**
 * Tracker templates the account keeps: the columns new trackers start with.
 * - Anyone with Trackers may keep private templates. Only Administrators make, change, hide or delete the shared ones.
 * - Changing a built-in template stores the account's copy under its key (one per key); deleting the copy brings the
 *   built-in one back, and hiding it takes it out of New tracker for everyone.
 * - Trackers already made from a template keep their own columns.
 */
type Deps = { db: any; requireAuth: RequestHandler; requireTenant: RequestHandler; now?: () => Date }
type User = { id: string; name: string; role: string; organizationId: string; modules?: string[]; accountType?: string }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const TABLE = 'tenant_tracker_templates'
/** Built-in templates the account can change. Blank stays as it is. */
export const CHANGEABLE_KEYS = TRACKER_TEMPLATES.map(template => template.id).filter(id => id !== 'blank')

const about = (value: unknown) => {
  if (value !== undefined && value !== null && typeof value !== 'string')
    throw new TrackerError('The description must be text.')
  const text = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (text.length > TEMPLATE_LIMITS.about)
    throw new TrackerError(`The description can be at most ${TEMPLATE_LIMITS.about} characters.`)
  return text
}

export function registerTrackerTemplateRoutes(app: Express, deps: Deps) {
  const { db } = deps
  const now = () => (deps.now ? deps.now() : new Date()).toISOString()
  const who = (req: Request) => (req as any).authUser as User
  const guard: RequestHandler = (req, res, next) => {
    const user = (req as any).authUser as User | undefined
    if (!db) return void res.status(503).json({ error: 'Database is not configured.' })
    if (!user?.organizationId || user.accountType === 'platform' || !user.modules?.includes('trackers'))
      return void res.status(403).json({ error: 'Trackers access is required.' })
    if (req.method !== 'GET' && user.role === 'Viewer')
      return void res.status(403).json({ error: 'Your role can view trackers but not change them.' })
    res.setHeader('Cache-Control', 'no-store')
    next()
  }
  const scope = [deps.requireAuth, deps.requireTenant, guard]
  const missing = (error: any) => {
    if (error)
      throw new TrackerError(
        'Editable tracker templates need database/migrations/schema-v34-tracker-templates.sql. Apply it and try again. The built-in templates still work without it.',
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
        if (error instanceof TrackerError)
          return void res.status(error.status).json({ error: error.message, ...(error.extra || {}) })
        res.status(500).json({ error: 'Tracker templates are unavailable right now. Try again in a moment.' })
      }
    }

  const isAdmin = (user: User) => user.role === 'Administrator'
  const visible = (row: any, user: User) =>
    (Boolean(row.shared) || row.created_by === user.id) && !(row.hidden && !isAdmin(user))
  const canEdit = (row: any, user: User) =>
    user.role !== 'Viewer' && (row.shared ? isAdmin(user) : row.created_by === user.id)
  const out = (row: any, user: User) => ({
    id: row.id,
    name: row.name,
    about: row.about || '',
    columns: Array.isArray(row.columns) ? row.columns : [],
    shared: Boolean(row.shared),
    hidden: Boolean(row.hidden),
    templateKey: row.template_key || '',
    revision: Number(row.revision) || 1,
    createdBy: row.created_by || '',
    createdByName: row.created_by_name || '',
    updatedByName: row.updated_by_name || '',
    updatedAt: row.updated_at,
    canEdit: canEdit(row, user),
  })
  async function one(user: User, id: string) {
    if (!UUID.test(id)) throw new TrackerError('Template not found.', 404)
    const r = await db.from(TABLE).select('*').eq('tenant_id', user.organizationId).eq('id', id).maybeSingle()
    missing(r.error)
    if (!r.data || !visible(r.data, user)) throw new TrackerError('Template not found. It may have been deleted.', 404)
    return r.data
  }

  app.get(
    '/api/tracker-templates',
    ...scope,
    route(async (req, res) => {
      const user = who(req)
      const r = await db
        .from(TABLE)
        .select('*')
        .eq('tenant_id', user.organizationId)
        .order('name', { ascending: true })
        .limit(TEMPLATE_LIMITS.templates + 50)
      missing(r.error)
      res.json({ templates: (r.data || []).filter((row: any) => visible(row, user)).map((row: any) => out(row, user)) })
    }),
  )

  app.post(
    '/api/tracker-templates',
    ...scope,
    route(async (req, res) => {
      const user = who(req)
      const body = req.body || {}
      const templateKey = typeof body.templateKey === 'string' ? body.templateKey : ''
      if (templateKey && !CHANGEABLE_KEYS.includes(templateKey))
        throw new TrackerError('That built-in template does not exist.')
      const shared = Boolean(templateKey) || body.shared === true
      if (shared && !isAdmin(user))
        throw new TrackerError(
          templateKey
            ? 'Only Administrators change the built-in templates. Save your own template instead.'
            : 'Only Administrators make templates for everyone. Keep it as your own template.',
          403,
        )
      const name = cleanName(body.name, 'template name', TEMPLATE_LIMITS.name)
      const columns = normalizeColumns(body.columns)
      if (templateKey) {
        const existing = await db
          .from(TABLE)
          .select('*')
          .eq('tenant_id', user.organizationId)
          .eq('template_key', templateKey)
          .maybeSingle()
        missing(existing.error)
        if (existing.data)
          throw new TrackerError('This template was already changed for the account.', 409, {
            template: out(existing.data, user),
          })
      }
      const count = await db
        .from(TABLE)
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', user.organizationId)
      missing(count.error)
      if (Number(count.count || 0) >= TEMPLATE_LIMITS.templates)
        throw new TrackerError(`An account can have at most ${TEMPLATE_LIMITS.templates} tracker templates.`, 409)
      const stamp = now()
      const row = {
        tenant_id: user.organizationId,
        id: randomUUID(),
        name,
        about: about(body.about),
        columns,
        shared,
        hidden: shared && body.hidden === true,
        template_key: templateKey,
        revision: 1,
        created_by: user.id,
        created_by_name: user.name,
        updated_by_name: user.name,
        created_at: stamp,
        updated_at: stamp,
      }
      const saved = await db.from(TABLE).insert(row)
      missing(saved.error)
      res.status(201).json({ template: out(row, user) })
    }),
  )

  app.patch(
    '/api/tracker-templates/:id',
    ...scope,
    route(async (req, res) => {
      const user = who(req)
      const current = await one(user, String(req.params.id))
      if (!canEdit(current, user))
        throw new TrackerError(
          current.shared
            ? "Only Administrators change the account's templates. Save your own template instead."
            : 'Only the person who made this template can change it.',
          403,
        )
      const body = req.body || {}
      if (body.revision !== undefined && Number(body.revision) !== Number(current.revision))
        throw new TrackerError('Someone else changed this template. It has been reloaded with their changes.', 409, {
          template: out(current, user),
        })
      const patch: Record<string, unknown> = {}
      if (body.name !== undefined) patch.name = cleanName(body.name, 'template name', TEMPLATE_LIMITS.name)
      if (body.about !== undefined) patch.about = about(body.about)
      if (body.columns !== undefined) patch.columns = normalizeColumns(body.columns)
      if (body.shared !== undefined) {
        const shared = body.shared === true
        if (shared && !isAdmin(user)) throw new TrackerError('Only Administrators make templates for everyone.', 403)
        if (!shared && current.template_key)
          throw new TrackerError('A built-in template stays with everyone. Hide it instead.')
        patch.shared = shared
        if (!shared) patch.hidden = false
      }
      if (body.hidden !== undefined) {
        if (!isAdmin(user)) throw new TrackerError('Only Administrators hide templates.', 403)
        patch.hidden = body.hidden === true && (patch.shared ?? current.shared) === true
      }
      const changes = {
        ...patch,
        revision: (Number(current.revision) || 1) + 1,
        updated_by_name: user.name,
        updated_at: now(),
      }
      const saved = await db.from(TABLE).update(changes).eq('tenant_id', user.organizationId).eq('id', current.id)
      missing(saved.error)
      res.json({ template: out({ ...current, ...changes }, user) })
    }),
  )

  app.delete(
    '/api/tracker-templates/:id',
    ...scope,
    route(async (req, res) => {
      const user = who(req)
      const current = await one(user, String(req.params.id))
      if (!canEdit(current, user)) throw new TrackerError('Only the person who made this template can delete it.', 403)
      const removed = await db.from(TABLE).delete().eq('tenant_id', user.organizationId).eq('id', current.id)
      missing(removed.error)
      res.json({ deleted: true })
    }),
  )
}
