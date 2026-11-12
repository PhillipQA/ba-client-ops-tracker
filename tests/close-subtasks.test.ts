import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CONFIRM_WORDS,
  closeOpenSubtasks,
  confirmMatches,
  confirmWord,
  openSubtasks,
} from '../src/features/tasks/closeSubtasks'
import { assertLifecycleMutation } from '../src/features/tasks/lifecycle'

const settings: any = {
  statuses: [
    { label: 'Not Started', closed: false },
    { label: 'In Progress', closed: false },
    { label: 'Resolved', closed: true },
    { label: 'Closed', closed: true },
  ],
  waitingOn: [
    { id: 'client', label: 'Client', done: false },
    { id: 'done', label: 'Done', done: true },
  ],
}
const item = (id: string, data: Record<string, unknown> = {}): any => ({
  id,
  title: id,
  status: 'In Progress',
  waitingOn: 'Client',
  followUpDate: '2026-11-20',
  clientId: 'c',
  projectId: 'p',
  ...data,
})
const items = () => [
  item('task'),
  item('s-open', { parentTaskId: 'task' }),
  item('s-waiting-done', { parentTaskId: 'task', waitingOn: 'Done' }),
  item('s-resolved', { parentTaskId: 'task', status: 'Resolved', resolvedDate: '2026-11-01' }),
  item('other-open', { parentTaskId: 'other' }),
]

test('only the task’s unfinished subtasks count as open', () => {
  assert.deepEqual(
    openSubtasks(items(), 'task', settings).map(subtask => subtask.id),
    ['s-open'],
  )
})

test('closing the task closes its open subtasks with the same status; finished ones keep theirs', () => {
  const after = closeOpenSubtasks(items(), 'task', 'Resolved', settings, '2026-11-13')
  const find = (id: string) => after.find(entry => entry.id === id)
  assert.deepEqual(
    { status: find('s-open').status, waitingOn: find('s-open').waitingOn, followUpDate: find('s-open').followUpDate },
    { status: 'Resolved', waitingOn: 'Done', followUpDate: '' },
  )
  assert.equal(find('s-open').resolvedDate, '2026-11-13')
  assert.equal(find('s-resolved').resolvedDate, '2026-11-01')
  assert.equal(find('s-waiting-done').status, 'In Progress', 'already finished: left alone')
  assert.equal(find('other-open').status, 'In Progress', 'another task’s subtask')
  assert.equal(find('task').status, 'In Progress', 'the task itself is closed by the caller')
  assert.equal(closeOpenSubtasks(after, 'task', 'Resolved', settings, '2026-11-13'), after, 'nothing left to close')
})

test('the task rules accept a task closed together with its subtasks, and still refuse it alone', () => {
  const current: any = {
    clients: [{ id: 'c', name: 'Client', status: 'Active' }],
    projects: [{ id: 'p', name: 'Project', clientId: 'c', status: 'Active' }],
    items: items().filter(entry => entry.parentTaskId !== 'other'),
    taskSettings: settings,
  }
  const close = (list: any[]) =>
    list.map(entry => (entry.id === 'task' ? { ...entry, status: 'Closed', waitingOn: 'Done' } : entry))
  const admin: any = { id: 'u', role: 'Administrator', modules: ['items'] }
  assert.throws(() => assertLifecycleMutation(current, { ...current, items: close(items()) }, admin), /open subtask/)
  const together = close(closeOpenSubtasks(current.items, 'task', 'Closed', settings, '2026-11-13'))
  assert.doesNotThrow(() => assertLifecycleMutation(current, { ...current, items: together }, admin))
})

test('the confirm word is one of the list and is matched loosely', () => {
  assert.ok(CONFIRM_WORDS.includes(confirmWord()))
  assert.equal(
    confirmWord(() => 0),
    'close',
  )
  assert.equal(
    confirmWord(() => 0.999),
    CONFIRM_WORDS.at(-1),
  )
  assert.equal(confirmMatches('  Wrap   Up ', 'wrap up'), true)
  assert.equal(confirmMatches('wrapup', 'wrap up'), false)
  assert.equal(confirmMatches('', 'close'), false)
})
