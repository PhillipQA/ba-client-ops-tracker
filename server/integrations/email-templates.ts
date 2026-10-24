import { randomUUID } from 'node:crypto'
import type { Express, Request, RequestHandler, Response } from 'express'

/**
 * Email signatures and templates.
 * - A signature belongs to one person and follows them on every device.
 * - A template is a ready-made subject and message. Shared templates are visible to the whole account and anyone who
 *   can send email may change them; a template kept to oneself is visible and editable only by its creator.
 * Everything is plain text, as the emails are.
 */
type Deps = { db: any; requireAuth: RequestHandler; requireTenant: RequestHandler; now?: () => Date }
type User = { id: string; name: string; role: string; organizationId: string; modules?: string[]; accountType?: string }

export const EMAIL_LIMITS = { signature: 2000, name: 120, subject: 200, body: 30000, templates: 500 } as const
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

class EmailError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message)
  }
}

const clean = (value: unknown, label: string, max: number, multiline: boolean) => {
  if (value !== undefined && value !== null && typeof value !== 'string') throw new EmailError(`${label} must be text.`)
  const text = String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(
      multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g : /[\u0000-\u001f\u007f]/g,
      multiline ? '' : ' ',
    )
  const out = multiline ? text.replace(/\s+$/, '') : text.replace(/\s+/g, ' ').trim()
  if (out.length > max) throw new EmailError(`${label} can be at most ${max} characters.`)
  return out
}

export function registerEmailTemplateRoutes(app: Express, deps: Deps) {
  const { db } = deps
  const now = () => (deps.now ? deps.now() : new Date()).toISOString()
  const who = (req: Request) => (req as any).authUser as User
  const guard: RequestHandler = (req, res, next) => {
    const user = (req as any).authUser as User | undefined
    if (!db) return void res.status(503).json({ error: 'Database is not configured.' })
    if (
      !user?.organizationId ||
      user.accountType === 'platform' ||
      (user.role !== 'Administrator' && !user.modules?.includes('inbox'))
    )
      return void res.status(403).json({ error: 'Work Hub access is required for email.' })
    if (req.method !== 'GET' && user.role === 'Viewer')
      return void res.status(403).json({ error: 'Your role can read templates but not change them.' })
    res.setHeader('Cache-Control', 'no-store')
    next()
  }
  const scope = [deps.requireAuth, deps.requireTenant, guard]
  const missing = (error: any) => {
    if (error)
      throw new EmailError(
        'Email templates and signatures need database/migrations/schema-v26-email-templates.sql. Apply it and try again.',
        503,
      )
  }
  const route =
    (handler: (req: Request, res: Response) => Promise<void>): RequestHandler =>
    async (req, res) => {
      try {
        await handler(req, res)
      } catch (error) {
        if (error instanceof EmailError) return void res.status(error.status).json({ error: error.message })
        res.status(500).json({ error: 'Email templates are unavailable right now. Try again in a moment.' })
      }
    }
  const out = (row: any, user: User) => ({
    id: row.id,
    name: row.name,
    subject: row.subject || '',
    body: row.body || '',
    shared: Boolean(row.shared),
    createdBy: row.created_by || '',
    createdByName: row.created_by_name || '',
    updatedByName: row.updated_by_name || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    canEdit: user.role !== 'Viewer' && (Boolean(row.shared) || row.created_by === user.id),
  })
  const visible = (row: any, user: User) => row.shared || row.created_by === user.id
  async function one(user: User, id: string) {
    if (!UUID.test(id)) throw new EmailError('Template not found.', 404)
    const r = await db
      .from('tenant_email_templates')
      .select('*')
      .eq('tenant_id', user.organizationId)
      .eq('id', id)
      .maybeSingle()
    missing(r.error)
    if (!r.data || !visible(r.data, user)) throw new EmailError('Template not found. It may have been deleted.', 404)
    return r.data
  }
  const fields = (body: any, partial: boolean) => {
    const patch: Record<string, unknown> = {}
    if (!partial || body?.name !== undefined) {
      const name = clean(body?.name, 'The name', EMAIL_LIMITS.name, false)
      if (!name) throw new EmailError('Give the template a name.')
      patch.name = name
    }
    if (!partial || body?.subject !== undefined)
      patch.subject = clean(body?.subject, 'The subject', EMAIL_LIMITS.subject, false)
    if (!partial || body?.body !== undefined) patch.body = clean(body?.body, 'The message', EMAIL_LIMITS.body, true)
    if (!partial || body?.shared !== undefined) patch.shared = body?.shared !== false
    if (!partial && !patch.subject && !patch.body) throw new EmailError('Add a subject or a message.')
    return patch
  }

  app.get(
    '/api/email/signature',
    ...scope,
    route(async (req, res) => {
      const user = who(req)
      const r = await db
        .from('user_email_signatures')
        .select('*')
        .eq('tenant_id', user.organizationId)
        .eq('user_id', user.id)
        .maybeSingle()
      missing(r.error)
      res.json({ signature: r.data?.signature || '', saved: Boolean(r.data) })
    }),
  )
  app.put(
    '/api/email/signature',
    ...scope,
    route(async (req, res) => {
      const user = who(req)
      const signature = clean(req.body?.signature, 'The signature', EMAIL_LIMITS.signature, true)
      const r = await db
        .from('user_email_signatures')
        .upsert(
          { tenant_id: user.organizationId, user_id: user.id, signature, updated_at: now() },
          { onConflict: 'tenant_id,user_id' },
        )
      missing(r.error)
      res.json({ signature })
    }),
  )

  app.get(
    '/api/email/templates',
    ...scope,
    route(async (req, res) => {
      const user = who(req)
      const r = await db
        .from('tenant_email_templates')
        .select('*')
        .eq('tenant_id', user.organizationId)
        .order('name', { ascending: true })
        .limit(EMAIL_LIMITS.templates + 100)
      missing(r.error)
      const list = (r.data || [])
        .filter((row: any) => visible(row, user))
        .map((row: any) => out(row, user))
        .sort((a: any, b: any) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }))
      res.json({ templates: list })
    }),
  )
  app.post(
    '/api/email/templates',
    ...scope,
    route(async (req, res) => {
      const user = who(req)
      const patch = fields(req.body, false)
      const count = await db
        .from('tenant_email_templates')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', user.organizationId)
      missing(count.error)
      if (Number(count.count || 0) >= EMAIL_LIMITS.templates)
        throw new EmailError(`An account can have at most ${EMAIL_LIMITS.templates} templates.`, 409)
      const stamp = now()
      const row = {
        tenant_id: user.organizationId,
        id: randomUUID(),
        ...patch,
        created_by: user.id,
        created_by_name: user.name,
        updated_by_name: user.name,
        created_at: stamp,
        updated_at: stamp,
      }
      const saved = await db.from('tenant_email_templates').insert(row)
      missing(saved.error)
      res.status(201).json({ template: out(row, user) })
    }),
  )
  app.patch(
    '/api/email/templates/:id',
    ...scope,
    route(async (req, res) => {
      const user = who(req),
        current = await one(user, String(req.params.id))
      if (!current.shared && current.created_by !== user.id)
        throw new EmailError('Only the person who made this template can change it.', 403)
      const patch = fields(req.body, true)
      // Only its creator can stop sharing a template, so nobody can take a shared template away from the team.
      if (patch.shared === false && current.shared && current.created_by !== user.id)
        throw new EmailError('Only the person who made this template can stop sharing it.', 403)
      const next = { ...current, ...patch }
      if (!next.subject && !next.body) throw new EmailError('Add a subject or a message.')
      const changes = { ...patch, updated_by_name: user.name, updated_at: now() }
      const saved = await db
        .from('tenant_email_templates')
        .update(changes)
        .eq('tenant_id', user.organizationId)
        .eq('id', current.id)
      missing(saved.error)
      res.json({ template: out({ ...current, ...changes }, user) })
    }),
  )
  app.delete(
    '/api/email/templates/:id',
    ...scope,
    route(async (req, res) => {
      const user = who(req),
        current = await one(user, String(req.params.id))
      if (!current.shared && current.created_by !== user.id)
        throw new EmailError('Only the person who made this template can delete it.', 403)
      const removed = await db
        .from('tenant_email_templates')
        .delete()
        .eq('tenant_id', user.organizationId)
        .eq('id', current.id)
      missing(removed.error)
      res.json({ deleted: true })
    }),
  )
}
