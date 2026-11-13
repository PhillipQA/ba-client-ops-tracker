import assert from 'node:assert/strict'
import { test } from 'node:test'
import express from 'express'
import { registerMemoryRoutes, type MemoryStore } from '../server/ai/assistant-memory'
import type { MemoryNote } from '../src/features/ai/memory'

const people: Record<string, any> = {
  ana: { id: 'ana', name: 'Ana', role: 'Contributor', organizationId: 'org', modules: ['ai'] },
  ben: { id: 'ben', name: 'Ben', role: 'Contributor', organizationId: 'org', modules: ['ai'] },
  noai: { id: 'noai', name: 'Noa', role: 'Contributor', organizationId: 'org', modules: ['items'] },
}

async function withRoutes(
  store: MemoryStore,
  run: (
    ask: (method: string, path: string, as: string, body?: any) => Promise<{ status: number; body: any }>,
  ) => Promise<void>,
) {
  const app = express()
  app.use(express.json())
  const auth = [
    (req: any, res: any, next: any) => {
      const user = people[String(req.headers['x-test-user'] || '')]
      if (!user) return void res.status(401).json({ error: 'Sign in.' })
      req.authUser = user
      next()
    },
  ]
  registerMemoryRoutes(app, { store, auth, now: () => new Date('2026-11-14T01:00:00Z') })
  const server = app.listen(0)
  try {
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('No port')
    await run(async (method, path, as, body) => {
      const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
        method,
        headers: { 'content-type': 'application/json', 'x-test-user': as },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      return { status: response.status, body: await response.json().catch(() => ({})) }
    })
  } finally {
    server.close()
  }
}

test('each person reads, adds to and deletes from their own memory only', async () => {
  const kept = new Map<string, MemoryNote[]>()
  const store: MemoryStore = {
    read: async (tenant, userId) => kept.get(`${tenant}:${userId}`) || [],
    write: async (tenant, userId, notes) => void kept.set(`${tenant}:${userId}`, notes),
  }
  await withRoutes(store, async ask => {
    const added = await ask('POST', '/api/assistant/memory', 'ana', { text: ' Goldwing needs  Product POS ' })
    assert.equal(added.status, 200)
    assert.equal(added.body.notes[0].text, 'Goldwing needs Product POS')
    assert.equal(added.body.notes[0].source, 'you')
    assert.equal(
      (await ask('POST', '/api/assistant/memory', 'ana', { text: 'goldwing needs product pos' })).status,
      400,
    )
    assert.equal((await ask('POST', '/api/assistant/memory', 'ana', {})).status, 400)

    assert.deepEqual((await ask('GET', '/api/assistant/memory', 'ben')).body.notes, [], 'Ben does not see Ana’s notes')
    const id = added.body.notes[0].id
    assert.equal((await ask('DELETE', `/api/assistant/memory/${id}`, 'ben')).status, 200)
    assert.equal((await ask('GET', '/api/assistant/memory', 'ana')).body.notes.length, 1, 'Ben cannot delete them')
    assert.deepEqual((await ask('DELETE', `/api/assistant/memory/${id}`, 'ana')).body.notes, [])

    assert.equal((await ask('GET', '/api/assistant/memory', 'noai')).status, 403)
  })
})

test('a database without the memory table says what to run', async () => {
  const { createMemoryStore } = await import('../server/ai/assistant-memory')
  const failing = {
    from: () => ({
      select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ error: { message: 'no table' } }) }) }) }),
    }),
  }
  await withRoutes(createMemoryStore(failing), async ask => {
    const answer = await ask('GET', '/api/assistant/memory', 'ana')
    assert.equal(answer.status, 503)
    assert.match(answer.body.error, /schema-v38-assistant-memory/)
  })
})
