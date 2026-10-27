import test from 'node:test'
import assert from 'node:assert/strict'
import {
  findSubtaskDuplicate,
  nextSubtaskOrder,
  subtaskParentProblem,
} from '../src/features/work-hub/communicationTasks'

const closed = (status: string) => ['Resolved', 'Closed'].includes(status)
const task = (id: string, extra: Record<string, unknown> = {}) =>
  ({ id, title: id, type: 'Task', status: 'Open', clientId: 'c', projectId: 'p', ...extra }) as any

test('a subtask from an email goes only under an open, active top-level task', () => {
  assert.equal(subtaskParentProblem(task('T'), closed), '')
  assert.match(subtaskParentProblem(undefined, closed), /no longer exists/)
  assert.match(subtaskParentProblem(task('S', { parentTaskId: 'T' }), closed), /not a subtask/)
  assert.match(subtaskParentProblem(task('T', { archived: true }), closed), /archived\. Reopen it/)
  assert.match(subtaskParentProblem(task('T', { status: 'Resolved' }), closed), /closed\. Reopen it/)
})

test('subtask names are unique under their task, and new ones go last', () => {
  const items = [
    task('T'),
    task('a', { parentTaskId: 'T', title: 'Send  DRF', subtaskOrder: 1 }),
    task('b', { parentTaskId: 'T', subtaskOrder: 4 }),
    task('c', { parentTaskId: 'U', title: 'Other' }),
  ]
  assert.equal(findSubtaskDuplicate(items, 'T', 'send drf')?.id, 'a', 'case and spacing do not matter')
  assert.equal(findSubtaskDuplicate(items, 'U', 'send drf'), undefined, 'another task may use the name')
  assert.equal(nextSubtaskOrder(items, 'T'), 5)
  assert.equal(nextSubtaskOrder(items, 'none'), 1)
})
