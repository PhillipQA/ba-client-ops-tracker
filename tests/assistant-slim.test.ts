import assert from 'node:assert/strict'
import test from 'node:test'
import { buildAssistantContext, slimAssistantContext } from '../server/ai/assistant-context'
import { aiUsage } from '../server/ai/ai-usage'
import { cleanUsage, usageLabel, usageTotal } from '../src/features/ai/ai'

test('agent mode starts from an overview that is far smaller than the full context', () => {
  const items = Array.from({ length: 60 }, (_, index) => ({
    id: `t${index}`,
    title: `Task ${index}`,
    status: 'Open',
    priority: 'Medium',
    waitingOn: 'Internal',
    assignedToUserId: 'u1',
    clientId: 'c1',
    projectId: 'p1',
    description: 'A long description of the work. '.repeat(30),
  }))
  const state = {
    taskSettings: { statuses: [{ id: 'open', label: 'Open', closed: false }] },
    accounts: [{ id: 'u1', name: 'Phillip' }],
    clients: [{ id: 'c1', name: 'Goldwing', notes: 'private notes' }],
    projects: [{ id: 'p1', name: 'Rollout', clientId: 'c1' }],
    items,
    workEvents: [],
    planner: [],
  }
  const user = { id: 'u1', name: 'Phillip', role: 'BA', modules: [] }
  const full = buildAssistantContext(
    state,
    user,
    { clientId: 'c1' },
    'what is open?',
    '2026-11-14',
    'Asia/Manila',
    () => true,
  )
  const slim: any = slimAssistantContext(full)

  assert.equal(slim.totals.open, 60, 'Totals stay exact')
  assert.equal(slim.myAssignments.length, 8)
  assert.equal('description' in slim.myAssignments[0], false)
  assert.equal(slim.openItems, undefined)
  assert.equal(slim.recentItems, undefined)
  assert.equal(slim.myRecentActivity, undefined)
  assert.deepEqual(slim.client, { id: 'c1', name: 'Goldwing' })
  assert.deepEqual(slim.coverage, full.coverage)
  const size = (value: unknown) => JSON.stringify(value).length
  assert.ok(size(slim) * 10 < size(full), `slim ${size(slim)} against full ${size(full)}`)
})

test('token use comes from the provider, or is estimated from the text when it gives none', () => {
  assert.deepEqual(aiUsage(1200, 80, 'x', 'y'), { input: 1200, output: 80 })
  assert.deepEqual(aiUsage(undefined, undefined, 'a'.repeat(400), 'b'.repeat(40)), {
    input: 100,
    output: 10,
    estimated: true,
  })
})

test('the chat shows what an answer cost and adds a chat up', () => {
  assert.equal(usageLabel({ input: 3000, output: 412, calls: 2 }), '3,412 tokens · 2 AI calls')
  assert.equal(usageLabel({ input: 90, output: 10, calls: 1, estimated: true }), 'About 100 tokens')
  assert.deepEqual(cleanUsage({ input: '250', output: 5.4, calls: 1, extra: 'x' }), { input: 250, output: 5, calls: 1 })
  assert.equal(cleanUsage({ input: -1 }), undefined)
  assert.equal(cleanUsage(null), undefined)
  const message = (usage?: any) => ({ id: 'm', role: 'assistant' as const, content: '', createdAt: '', usage })
  assert.equal(
    usageTotal([message({ input: 10, output: 5, calls: 1 }), message(), message({ input: 1, output: 1, calls: 1 })]),
    17,
  )
})
