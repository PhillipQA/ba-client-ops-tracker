import assert from 'node:assert/strict'
import test from 'node:test'
import { applyTaskUpdates, draftTaskUpdates, taskUpdateMessage } from '../src/features/ai/taskUpdate'
import { asksToUpdateTasks, taskUpdateContext, taskUpdateSuggestions } from '../server/ai/assistant-actions'
import { dateActions, nextMonday, nextWorkday, watchAlerts } from '../src/features/ai/watch'

const settings: any = {
  statuses: [
    { id: 'open', label: 'Open', closed: false },
    { id: 'progress', label: 'In Progress', closed: false },
    { id: 'resolved', label: 'Resolved', closed: true },
  ],
}
const task = (id: string, extra: any = {}): any => ({
  id,
  title: `Task ${id}`,
  status: 'Open',
  priority: 'Medium',
  waitingOn: 'Internal',
  assignedToUserId: 'me',
  clientId: 'c1',
  projectId: 'p1',
  dueDate: '2026-11-10',
  followUpDate: '',
  startDate: '',
  ...extra,
})
const items = () => [
  task('a'),
  task('theirs', { assignedToUserId: 'other' }),
  task('closed', { status: 'Resolved' }),
  task('put-away', { archived: true }),
]
const mine = (item: any) => item.assignedToUserId === 'me'
const TODAY = '2026-11-14'

test('drafted changes keep only tasks the person may change, values a field takes, and real changes', () => {
  const drafted = draftTaskUpdates(
    [
      { taskId: 'a', dueDate: '2026-11-20', priority: 'urgent', status: 'Resolved', waitingOn: 'Nobody', title: 'x' },
      { taskId: 'a', dueDate: '2026-12-01' },
      { taskId: 'theirs', dueDate: '2026-11-20' },
      { taskId: 'closed', dueDate: '2026-11-20' },
      { taskId: 'put-away', dueDate: '2026-11-20' },
      { taskId: 'missing', dueDate: '2026-11-20' },
      { taskId: 'a' },
      'nonsense',
    ],
    items(),
    settings,
    mine,
  )
  assert.deepEqual(drafted.tasks, [
    {
      taskId: 'a',
      title: 'Task a',
      changes: [
        { field: 'dueDate', label: 'Due date', from: '2026-11-10', to: '2026-11-20' },
        { field: 'priority', label: 'Priority', from: 'Medium', to: 'Urgent' },
      ],
    },
  ])
  assert.deepEqual(draftTaskUpdates([{ taskId: 'a', dueDate: '2026-11-10' }], items(), settings, mine).tasks, [])
  assert.deepEqual(draftTaskUpdates([{ taskId: 'a', dueDate: '20 Nov' }], items(), settings, mine).tasks, [])
  assert.deepEqual(draftTaskUpdates('nonsense', items(), settings, mine).tasks, [])
  // An Administrator may change anyone's.
  assert.equal(draftTaskUpdates([{ taskId: 'theirs', dueDate: '' }], items(), settings, () => true).tasks.length, 1)
})

test('an approved change is applied once, and a task changed since is left alone', () => {
  const update = draftTaskUpdates(
    [{ taskId: 'a', dueDate: '2026-11-20', status: 'In Progress' }],
    items(),
    settings,
    mine,
  )
  const result = applyTaskUpdates(items(), settings, update, mine, TODAY)
  const changed = result.items.find(item => item.id === 'a')!
  assert.equal(changed.dueDate, '2026-11-20')
  assert.equal(changed.status, 'In Progress')
  assert.equal(changed.startDate, TODAY, 'Starting work sets the start date, as on the task')
  assert.deepEqual(result.done, ['Task a'])
  assert.equal(taskUpdateMessage(result), 'Updated “Task a”.')
  assert.equal(result.items.filter((item, index) => item !== items()[index] && item.id !== 'a').length, 3)

  const moved = items().map(item => (item.id === 'a' ? { ...item, dueDate: '2026-11-12' } : item))
  const stale = applyTaskUpdates(moved, settings, update, mine, TODAY)
  assert.deepEqual(stale.done, [])
  assert.equal(stale.items, moved)
  assert.match(taskUpdateMessage(stale), /Not changed: “Task a” \(its due date changed since\)/)

  // A draft cannot be altered to reach another person's task, a closed one, or a closing status.
  const forged = {
    tasks: [
      {
        taskId: 'theirs',
        title: 'Theirs',
        changes: [{ field: 'dueDate', label: 'Due date', from: '2026-11-10', to: '' }],
      },
      {
        taskId: 'closed',
        title: 'Closed',
        changes: [{ field: 'dueDate', label: 'Due date', from: '2026-11-10', to: '' }],
      },
      { taskId: 'a', title: 'A', changes: [{ field: 'status', label: 'Status', from: 'Open', to: 'Resolved' }] },
      { taskId: 'a', title: 'A', changes: [{ field: 'title', label: 'Title', from: 'Task a', to: 'Hacked' }] },
    ],
  } as any
  const refused = applyTaskUpdates(items(), settings, forged, mine, TODAY)
  assert.deepEqual(refused.done, [])
  assert.deepEqual(
    refused.skipped.map(skip => skip.reason),
    ['it is assigned to someone else', 'it is already closed', 'nothing to change', 'nothing to change'],
  )
})

test('the assistant is given the tasks a change may touch only when the question asks for a change', () => {
  assert.equal(asksToUpdateTasks('Move the due date of the UAT task to Friday'), true)
  assert.equal(asksToUpdateTasks('Push my overdue tasks to next week'), true)
  assert.equal(asksToUpdateTasks('Set priority to high on the config task'), true)
  assert.equal(asksToUpdateTasks('What is overdue?'), false)
  assert.equal(asksToUpdateTasks('Update me on Goldwing'), false)

  const state = { taskSettings: settings, items: items(), clients: [{ id: 'c1', name: 'Goldwing' }], projects: [] }
  const context = taskUpdateContext(state, { id: 'me', role: 'Contributor' }, 'push my overdue tasks', {}, TODAY)
  assert.deepEqual(
    context.tasks.map(entry => entry.id),
    ['a'],
  )
  assert.deepEqual(context.statuses, ['Open', 'In Progress'])
  assert.equal(context.tasks[0].dueDate, '2026-11-10')

  const suggestions = taskUpdateSuggestions(
    [
      { kind: 'task_update', title: 'Push it', rationale: 'Asked', updates: [{ taskId: 'a', dueDate: '2026-11-17' }] },
      { kind: 'task_update', updates: [{ taskId: 'theirs', dueDate: '2026-11-17' }] },
      { kind: 'issue', title: 'Other' },
    ],
    state,
    { id: 'me', role: 'Contributor' },
  )
  assert.equal(suggestions.length, 1)
  assert.equal(suggestions[0].kind, 'task_update')
  assert.equal(suggestions[0].taskUpdate.tasks[0].changes[0].to, '2026-11-17')
  assert.deepEqual(
    taskUpdateSuggestions([{ kind: 'task_update', updates: [{ taskId: 'theirs', dueDate: '' }] }], state, {
      id: 'me',
      role: 'Contributor',
    }),
    [],
  )
})

test('heads-ups offer new dates to approve with one click', () => {
  assert.equal(nextWorkday('2026-11-13'), '2026-11-16', 'Friday → Monday')
  assert.equal(nextWorkday('2026-11-16'), '2026-11-17')
  assert.equal(nextMonday('2026-11-16'), '2026-11-23')
  assert.equal(nextMonday('2026-11-14'), '2026-11-16')

  const item = { id: 'a', title: 'Task a', date: '2026-11-10', days: -8 }
  const midweek = dateActions(item, 'dueDate', '2026-11-18')
  assert.deepEqual(
    midweek.map(action => action.label),
    ['Due today', 'Due tomorrow', 'Due next Monday'],
  )
  assert.deepEqual(
    midweek.map(action => action.update.tasks[0].changes[0].to),
    ['2026-11-18', '2026-11-19', '2026-11-23'],
  )
  assert.equal(midweek[1].update.tasks[0].changes[0].from, '2026-11-10')
  const friday = dateActions(item, 'followUpDate', '2026-11-13')
  assert.deepEqual(
    friday.map(action => action.label),
    ['Follow up Monday'],
    'Monday is both: offered once',
  )

  // The offered change applies through the same check as an assistant draft.
  const applied = applyTaskUpdates(items(), settings, midweek[2].update, mine, '2026-11-18')
  assert.equal(applied.items.find(entry => entry.id === 'a')!.dueDate, '2026-11-23')

  const none = { total: 0, items: [] }
  const alerts = watchAlerts({
    date: '2026-11-18',
    firstName: 'P',
    overdue: { total: 1, items: [item] },
    dueToday: none,
    followUps: none,
    goLives: none,
    emails: none,
    time: { day: '2026-11-17', hours: 8, expected: 8, unsent: null },
  })
  assert.equal(alerts[0].actions?.length, 3)
})
