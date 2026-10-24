import test from 'node:test'
import assert from 'node:assert/strict'
import {
  markAllNotificationsReadForUser,
  reconcileNotifications,
  updateNotificationForUser,
} from '../server/services/notification-engine'

const accounts = [
  { id: 'admin', name: 'Phillip', role: 'Administrator', status: 'Active' },
  { id: 'maria', name: 'Maria', role: 'Contributor', status: 'Active' },
  { id: 'viewer', name: 'Viewer', role: 'Viewer', status: 'Active' },
]

function state(patch: Record<string, unknown> = {}) {
  return {
    accounts,
    items: [],
    workEvents: [],
    notifications: [],
    taskSettings: { statuses: [{ label: 'Resolved', closed: true }] },
    ...patch,
  }
}

test('first reconciliation skips historical events but creates current due alerts once', () => {
  let id = 0
  const initial = state({
    items: [
      {
        id: 'task-1',
        title: 'Prepare FSD',
        status: 'Open',
        waitingOn: 'Me',
        assignedToUserId: 'maria',
        dueDate: '2026-09-23',
        followUpDate: '',
      },
    ],
    workEvents: [
      {
        id: 'old',
        occurredAt: '2026-09-20T00:00:00Z',
        action: 'assigned',
        assignedToUserId: 'maria',
        summary: 'Old assignment',
      },
    ],
  })
  const first = reconcileNotifications(initial, {
    today: '2026-09-23',
    occurredAt: '2026-09-23T00:05:00Z',
    id: () => `n-${++id}`,
  })
  assert.equal(first.created.length, 2)
  assert.deepEqual(new Set(first.created.map(entry => entry.recipientUserId)), new Set(['maria', 'admin']))
  assert(first.created.every(entry => entry.type === 'due_today'))
  const repeated = reconcileNotifications(first.state, { today: '2026-09-23', occurredAt: '2026-09-23T00:10:00Z' })
  assert.equal(repeated.changed, false)
})

test('new assignment and rollover events notify the correct user and Admin without duplicates', () => {
  let id = 0
  const events = [
    {
      id: 'assigned-event',
      occurredAt: '2026-09-23T01:00:00Z',
      action: 'assigned',
      assignedToUserId: 'maria',
      actorUserId: 'admin',
      summary: 'Phillip assigned work.',
      taskId: 'task-1',
    },
    {
      id: 'roll-event',
      occurredAt: '2026-09-23T02:00:00Z',
      action: 'follow_up_auto_moved',
      assignedToUserId: 'maria',
      actorUserId: 'system',
      summary: 'Follow-up moved.',
      taskId: 'sub-1',
      parentTaskId: 'task-1',
    },
  ]
  const result = reconcileNotifications(
    state({ notificationState: { initializedAt: '2026-09-23T00:00:00Z' }, workEvents: events }),
    {
      today: '2026-09-23',
      occurredAt: '2026-09-23T03:00:00Z',
      newEventIds: events.map(event => event.id),
      id: () => `n-${++id}`,
    },
  )
  assert.equal(result.created.filter(entry => entry.type === 'assigned').length, 1)
  assert.equal(result.created.filter(entry => entry.type === 'follow_up_moved').length, 2)
  assert(!result.created.some(entry => entry.recipientUserId === 'viewer'))
  const repeated = reconcileNotifications(result.state, {
    today: '2026-09-23',
    occurredAt: '2026-09-23T03:05:00Z',
    newEventIds: events.map(event => event.id),
  })
  assert.equal(repeated.created.length, 0)
})

test('closed work is excluded from due and overdue alerts', () => {
  const result = reconcileNotifications(
    state({
      items: [
        {
          id: 'resolved',
          title: 'Resolved',
          status: 'Resolved',
          waitingOn: 'Me',
          assignedToUserId: 'maria',
          dueDate: '2026-09-20',
        },
        {
          id: 'done',
          title: 'Done',
          status: 'Open',
          waitingOn: 'Done',
          assignedToUserId: 'maria',
          dueDate: '2026-09-20',
        },
      ],
    }),
    { today: '2026-09-23', occurredAt: '2026-09-23T00:05:00Z' },
  )
  assert.equal(result.created.length, 0)
})

test('only the recipient can mutate a notification and mark-all-read is user scoped', () => {
  const initial = state({
    notifications: [
      { id: 'n1', recipientUserId: 'maria', dedupeKey: 'a', createdAt: '2026-09-23T00:00:00Z' },
      { id: 'n2', recipientUserId: 'admin', dedupeKey: 'b', createdAt: '2026-09-23T00:00:00Z' },
    ],
  })
  const denied = updateNotificationForUser(initial, 'n2', 'maria', 'dismiss')
  assert.equal(denied.matched, false)
  const read = updateNotificationForUser(initial, 'n1', 'maria', 'read', '2026-09-23T01:00:00Z')
  assert.equal(read.matched, true)
  assert.equal(read.state.notifications[0].readAt, '2026-09-23T01:00:00Z')
  const all = markAllNotificationsReadForUser(initial, 'maria', '2026-09-23T02:00:00Z')
  assert.equal(all.state.notifications[0].readAt, '2026-09-23T02:00:00Z')
  assert.equal(all.state.notifications[1].readAt, undefined)
})
