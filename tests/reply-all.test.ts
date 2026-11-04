import assert from 'node:assert/strict'
import test from 'node:test'
import { latestLinkedEmail, replyAllPrefill } from '../src/features/email/replyAll'

const email = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  subject: 'POS registration',
  sender: 'Abegail <abegail@example.com>',
  body: 'Store details',
  received_at: '2026-11-04T09:56:02Z',
  source: 'Gmail',
  ...extra,
})

function mockFetch(routes: Record<string, unknown>) {
  const asked: string[] = []
  globalThis.fetch = (async (url: string) => {
    asked.push(url)
    const key = Object.keys(routes).find(prefix => url.startsWith(prefix))
    if (!key) return new Response(JSON.stringify({ error: 'missing' }), { status: 404 })
    return new Response(JSON.stringify(routes[key]), { status: 200 })
  }) as typeof fetch
  return asked
}

test('a file on linked work answers the latest email from someone else in that conversation', async () => {
  const asked = mockFetch({
    '/api/communications?taskIds=': { items: [email('linked')] },
    '/api/communications/linked/thread': {
      total: 3,
      items: [email('linked'), email('their-reply'), email('my-reply', { source_labels: ['SENT'] })],
    },
  })
  assert.equal((await latestLinkedEmail(['sub-1']))?.id, 'their-reply')
  assert.ok(asked[0].includes('taskIds=sub-1&family=1'))
})

test('no linked Gmail email means no reply (a new email is written instead)', async () => {
  mockFetch({ '/api/communications?taskIds=': { items: [email('discord', { source: 'Discord' })] } })
  assert.equal(await latestLinkedEmail(['task-1']), null)
  assert.equal(await latestLinkedEmail([]), null)
})

test('reply all addresses the sender and copies everyone else on the email', async () => {
  mockFetch({
    '/api/communications/their-reply/reply-recipients': { to: ['abegail@example.com'], cc: ['team@example.com'] },
  })
  const reply = await replyAllPrefill(email('their-reply'), ['task-1'])
  assert.equal(reply.replyToId, 'their-reply')
  assert.equal(reply.to, 'abegail@example.com')
  assert.equal(reply.cc, 'team@example.com')
  assert.equal(reply.subject, 'Re: POS registration')
  assert.deepEqual(reply.taskIds, ['task-1'])
})
