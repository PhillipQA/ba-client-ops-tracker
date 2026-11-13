// The BA Assistant's memory, kept per person (see src/features/ai/memory.ts for what a note is and when one is added).
// One row per person in user_assistant_memory, holding their notes as JSON: a read is one small query by primary key.
import { randomBytes } from 'node:crypto'
import type express from 'express'
import type { Express, RequestHandler } from 'express'
import rateLimit from 'express-rate-limit'
import { moduleAllowed, requireAuth, requireTenantWorkspace, type SessionUser } from '../core/auth'
import { tenantIdForUser } from '../core/tenant-state'
import { addNote, cleanNotes, type MemoryNote } from '../../src/features/ai/memory'

export type MemoryStore = {
  read: (tenant: string, userId: string) => Promise<MemoryNote[]>
  write: (tenant: string, userId: string, notes: MemoryNote[]) => Promise<void>
}

export class MemoryError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message)
  }
}
const UNAVAILABLE =
  'The assistant’s memory is unavailable. An existing database needs database/migrations/schema-v38-assistant-memory.sql.'

export const newNoteId = () => `m${randomBytes(4).toString('hex')}`

export function createMemoryStore(db: any): MemoryStore {
  const table = () => {
    if (!db) throw new MemoryError(UNAVAILABLE, 503)
    return db.from('user_assistant_memory')
  }
  return {
    async read(tenant, userId) {
      const r = await table().select('notes').eq('tenant_id', tenant).eq('user_id', userId).maybeSingle()
      if (r.error) throw new MemoryError(UNAVAILABLE, 503)
      return cleanNotes(r.data?.notes)
    },
    async write(tenant, userId, notes) {
      const r = await table().upsert(
        { tenant_id: tenant, user_id: userId, notes: cleanNotes(notes), updated_at: new Date().toISOString() },
        { onConflict: 'tenant_id,user_id' },
      )
      if (r.error) throw new MemoryError(UNAVAILABLE, 503)
    },
  }
}

/** The Memory panel: a person's own notes, to read, add to and delete from. */
export function registerMemoryRoutes(
  app: Express,
  deps: { store: MemoryStore; auth?: RequestHandler[]; now?: () => Date },
) {
  const auth = deps.auth || [requireAuth, requireTenantWorkspace]
  const now = deps.now || (() => new Date())
  const who = (req: express.Request) => (req as express.Request & { authUser: SessionUser }).authUser
  const tenantOf = (user: SessionUser) => String(tenantIdForUser(user))
  const limit = rateLimit({
    windowMs: 60_000,
    limit: 40,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: req => `${who(req)?.organizationId || ''}:${who(req)?.id || ''}`,
    message: { error: 'Too many memory changes in a minute. Wait a moment and try again.' },
  })
  const wrap =
    (handler: (req: express.Request, res: express.Response) => Promise<void>): RequestHandler =>
    async (req, res) => {
      try {
        const user = who(req)
        const askAi = (user as { askAi?: boolean }).askAi === true
        if ((user.role === 'Viewer' && !askAi) || !moduleAllowed(user, 'ai'))
          throw new MemoryError('Your account does not have the AI BA Assistant.', 403)
        await handler(req, res)
      } catch (error) {
        if (error instanceof MemoryError) return void res.status(error.status).json({ error: error.message })
        console.error('Assistant memory request failed.')
        res.status(500).json({ error: 'The assistant’s memory could not be changed. Try again.' })
      }
    }

  app.get(
    '/api/assistant/memory',
    ...auth,
    limit,
    wrap(async (req, res) => {
      const user = who(req)
      res.json({ notes: await deps.store.read(tenantOf(user), user.id) })
    }),
  )
  app.post(
    '/api/assistant/memory',
    ...auth,
    limit,
    wrap(async (req, res) => {
      const user = who(req)
      const notes = await deps.store.read(tenantOf(user), user.id)
      const result = addNote(notes, req.body?.text, 'you', now().toISOString(), newNoteId())
      if (!result.added) throw new MemoryError(result.problem || 'That could not be remembered.')
      await deps.store.write(tenantOf(user), user.id, result.notes)
      res.json({ notes: result.notes })
    }),
  )
  app.delete(
    '/api/assistant/memory/:id',
    ...auth,
    limit,
    wrap(async (req, res) => {
      const user = who(req)
      const notes = await deps.store.read(tenantOf(user), user.id)
      const kept = notes.filter(note => note.id !== req.params.id)
      if (kept.length !== notes.length) await deps.store.write(tenantOf(user), user.id, kept)
      res.json({ notes: kept })
    }),
  )
}
