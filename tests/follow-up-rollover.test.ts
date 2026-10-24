import test from 'node:test'
import assert from 'node:assert/strict'
import { dateKeyInTimeZone, rollOverOpenSubtaskFollowUps } from '../server/services/follow-up-rollover'

function state(
  items: any[],
  statuses: any[] = [
    { id: 'open', label: 'Open', closed: false },
    { id: 'resolved', label: 'Resolved', closed: true },
  ],
) {
  return { items, accounts: [{ id: 'user-1', name: 'Maria' }], workEvents: [], taskSettings: { statuses } }
}

function subtask(patch: Record<string, unknown> = {}) {
  return {
    id: 'sub-1',
    parentTaskId: 'task-1',
    title: 'Review requirements',
    status: 'Open',
    waitingOn: 'Me',
    followUpDate: '2026-09-22',
    assignedToUserId: 'user-1',
    comments: [],
    ...patch,
  }
}

test('open Subtask follow-up moves once and creates an immutable System trail', () => {
  let id = 0
  const result = rollOverOpenSubtaskFollowUps(state([subtask()]), {
    today: '2026-09-23',
    occurredAt: '2026-09-22T16:05:00.000Z',
    id: () => `id-${++id}`,
  })
  assert.equal(result.changed, true)
  assert.equal(result.state.items[0].followUpDate, '2026-09-23')
  assert.equal(result.state.items[0].comments.length, 1)
  assert.equal(result.state.items[0].comments[0].kind, 'System')
  assert.match(result.state.items[0].comments[0].text, /remains open/)
  assert.equal(result.state.workEvents[0].action, 'follow_up_auto_moved')
  assert.equal(result.state.workEvents[0].actorUserId, 'system')
  assert.equal(result.state.workEvents[0].assignedToName, 'Maria')

  const repeated = rollOverOpenSubtaskFollowUps(result.state, {
    today: '2026-09-23',
    occurredAt: '2026-09-22T16:10:00.000Z',
  })
  assert.equal(repeated.changed, false)
  assert.equal(repeated.state.items[0].comments.length, 1)
  assert.equal(repeated.state.workEvents.length, 1)
})

test('open parent task follow-up rolls into today and preserves its System trail', () => {
  const parent = subtask({ id: 'parent', parentTaskId: undefined })
  const result = rollOverOpenSubtaskFollowUps(state([parent]), { today: '2026-09-23' })
  assert.equal(result.state.items[0].followUpDate, '2026-09-23')
  assert.equal(result.state.workEvents[0].itemKind, 'Task')
  assert.equal(result.state.workEvents[0].parentTaskId, undefined)
  assert.match(result.state.items[0].comments[0].text, /task remains open/)
})

test('resolved, configured closed, waiting-on Done, today and future dates do not roll', () => {
  const items = [
    subtask({ id: 'resolved', status: 'Resolved' }),
    subtask({ id: 'custom', status: 'Accepted' }),
    subtask({ id: 'waiting-done', waitingOn: 'Done' }),
    subtask({ id: 'resolved-date', resolvedDate: '2026-09-22' }),
    subtask({ id: 'today', followUpDate: '2026-09-23' }),
    subtask({ id: 'future', followUpDate: '2026-09-24' }),
  ]
  const result = rollOverOpenSubtaskFollowUps(
    state(items, [
      { id: 'open', label: 'Open', closed: false },
      { id: 'accepted', label: 'Accepted', closed: true },
    ]),
    { today: '2026-09-23' },
  )
  assert.equal(result.changed, false)
  assert.deepEqual(result.state.items, items)
})

test('downtime catch-up advances to the current tenant day with a summarized comment', () => {
  const result = rollOverOpenSubtaskFollowUps(state([subtask({ followUpDate: '2026-09-18' })]), {
    today: '2026-09-23',
    occurredAt: '2026-09-22T16:10:00.000Z',
    id: () => 'stable-id',
  })
  assert.equal(result.state.items[0].followUpDate, '2026-09-23')
  assert.equal(result.state.items[0].comments[0].daysMoved, 5)
  assert.match(result.state.items[0].comments[0].text, /caught up/)
  assert.equal(result.changes[0].daysMoved, 5)
})

test('tenant date uses Asia/Manila by default', () => {
  assert.equal(dateKeyInTimeZone(new Date('2026-09-22T16:05:00.000Z')), '2026-09-23')
})

test('a renamed completion waiting-on option counts as done', () => {
  const waitingOn = [
    { id: 'me', label: 'Me', done: false },
    { id: 'done', label: 'Finished', done: true },
  ]
  const items = [subtask({ id: 'finished', waitingOn: 'Finished' }), subtask({ id: 'open' })]
  const result = rollOverOpenSubtaskFollowUps(
    { ...state(items), taskSettings: { statuses: [{ id: 'open', label: 'Open', closed: false }], waitingOn } },
    { today: '2026-09-23' },
  )
  assert.equal(result.state.items.find((item: any) => item.id === 'finished').followUpDate, '2026-09-22')
  assert.equal(result.state.items.find((item: any) => item.id === 'open').followUpDate, '2026-09-23')
})
