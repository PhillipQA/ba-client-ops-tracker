// The BA Assistant's memory, kept per person (see src/features/ai/memory.ts for what a note is and when one is added).
// One row per person in user_assistant_memory, as JSON: a read is one small query by primary key. The row's `notes`
// column held only the list of notes at first; it now holds { notes, chats } (the conversation recaps too), and a row
// still holding the plain list is read as notes with no recaps, so no database change is needed.
import { randomBytes } from 'node:crypto'
import type express from 'express'
import type { Express, RequestHandler } from 'express'
import rateLimit from 'express-rate-limit'
import { moduleAllowed, requireAuth, requireTenantWorkspace, type SessionUser } from '../core/auth'
import { tenantIdForUser } from '../core/tenant-state'
import { addNote, cleanChats, cleanNotes, type ChatRecap, type MemoryNote } from '../../src/features/ai/memory'

export type Memory = { notes: MemoryNote[]; chats: ChatRecap[] }
export type MemoryStore = {
  read: (tenant: string, userId: string) => Promise<MemoryNote[]>
  write: (tenant: string, userId: string, notes: MemoryNote[]) => Promise<void>
  /** Notes and conversation recaps together. A store without these keeps no recaps. */
  recall?: (tenant: string, userId: string) => Promise<Memory>
  keep?: (tenant: string, userId: string, memory: Memory) => Promise<void>
}
/** Everything a store holds for a person. */
export async function recallAll(store: MemoryStore, tenant: string, userId: string): Promise<Memory> {
  return store.recall ? store.recall(tenant, userId) : { notes: await store.read(tenant, userId), chats: [] }
}
export async function keepAll(store: MemoryStore, tenant: string, userId: string, memory: Memory) {
  if (store.keep) await store.keep(tenant, userId, memory)
  else await store.write(tenant, userId, memory.notes)
}
/** The stored column as memory: the first shape was the list of notes alone. */
export function memoryOf(stored: unknown): Memory {
  if (Array.isArray(stored)) return { notes: cleanNotes(stored), chats: [] }
  const held = stored && typeof stored === 'object' ? (stored as Record<string, unknown>) : {}
  return { notes: cleanNotes(held.notes), chats: cleanChats(held.chats) }
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
  const recall = async (tenant: string, userId: string) => {
    const r = await table().select('notes').eq('tenant_id', tenant).eq('user_id', userId).maybeSingle()
    if (r.error) throw new MemoryError(UNAVAILABLE, 503)
    return memoryOf(r.data?.notes)
  }
  const keep = async (tenant: string, userId: string, memory: Memory) => {
    const held = { notes: cleanNotes(memory.notes), chats: cleanChats(memory.chats) }
    const r = await table().upsert(
      { tenant_id: tenant, user_id: userId, notes: held, updated_at: new Date().toISOString() },
      { onConflict: 'tenant_id,user_id' },
    )
    if (r.error) throw new MemoryError(UNAVAILABLE, 503)
  }
  return {
    recall,
    keep,
    read: async (tenant, userId) => (await recall(tenant, userId)).notes,
    // Changing the notes leaves the conversation recaps as they are.
    write: async (tenant, userId, notes) => keep(tenant, userId, { ...(await recall(tenant, userId)), notes }),
  }
}

/** The Memory panel: a person's own notes and conversation recaps, to read, add to and delete from. */
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
      res.json(await recallAll(deps.store, tenantOf(user), user.id))
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
  // Forgets the conversation recaps: one, or all of them.
  app.delete(
    '/api/assistant/memory/chats/:id',
    ...auth,
    limit,
    wrap(async (req, res) => {
      const user = who(req)
      const memory = await recallAll(deps.store, tenantOf(user), user.id)
      const chats = req.params.id === 'all' ? [] : memory.chats.filter(chat => chat.id !== req.params.id)
      if (chats.length !== memory.chats.length) await keepAll(deps.store, tenantOf(user), user.id, { ...memory, chats })
      res.json({ notes: memory.notes, chats })
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
