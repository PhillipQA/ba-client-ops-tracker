import assert from 'node:assert/strict'
import { test } from 'node:test'
import express from 'express'
import { registerTimerRoutes, type TimerStore } from '../server/tasks/task-timers'
import type { TaskTimer } from '../src/features/tasks/timer'

const people: Record<string, any> = {
  ana: { id: 'ana', role: 'Contributor', organizationId: 'org' },
  ben: { id: 'ben', role: 'Contributor', organizationId: 'org' },
  viewer: { id: 'viewer', role: 'Viewer', organizationId: 'org' },
}

test('each person starts, pauses, stops and clears only their own timers, kept on the server', async () => {
  const kept = new Map<string, TaskTimer[]>()
  const store: TimerStore = {
    read: async (tenant, userId) => kept.get(`${tenant}:${userId}`) || [],
    write: async (tenant, userId, timers) => void kept.set(`${tenant}:${userId}`, timers),
  }
  let clock = new Date('2026-11-16T01:00:00Z')
  const app = express()
  app.use(express.json())
  const auth = [
    (req: any, res: any, next: any) => {
      req.authUser = people[String(req.headers['x-test-user'] || '')]
      if (!req.authUser) return void res.status(401).json({ error: 'Sign in.' })
      next()
    },
  ]
  registerTimerRoutes(app, {
    store,
    auth,
    now: () => clock,
    dayOf: ms => new Date(ms + 8 * 3600000).toISOString().slice(0, 10),
  })
  const server = app.listen(0)
  try {
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('No port')
    const ask = async (method: string, path: string, as: string, body?: any) => {
      const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
        method,
        headers: { 'content-type': 'application/json', 'x-test-user': as },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      return { status: response.status, body: await response.json().catch(() => ({})) }
    }

    const started = await ask('POST', '/api/timers/t1/start', 'ana')
    assert.equal(started.status, 200)
    assert.equal(started.body.timers[0].state, 'running')
    assert.equal(started.body.now, clock.toISOString(), 'The server says its time, so the browser clock can follow it')
    assert.deepEqual((await ask('GET', '/api/timers', 'ben')).body.timers, [], 'Ben does not see Ana’s timers')

    clock = new Date('2026-11-16T02:30:00Z')
    const stopped = await ask('POST', '/api/timers/t1/stop', 'ana')
    assert.equal(stopped.body.timers[0].state, 'stopped')
    assert.equal((await ask('POST', '/api/timers/t1/start', 'ana')).status, 409)
    assert.equal((await ask('POST', '/api/timers/t1/clear', 'ana', { date: 'soon' })).status, 400)
    assert.deepEqual((await ask('POST', '/api/timers/t1/clear', 'ana', { date: '2026-11-16' })).body.timers, [])

    await ask('POST', '/api/timers/t2/start', 'ana')
    assert.deepEqual((await ask('DELETE', '/api/timers/t2', 'ana')).body.timers, [])
    assert.equal((await ask('POST', '/api/timers/t3/start', 'viewer')).status, 403)
  } finally {
    server.close()
  }
})
