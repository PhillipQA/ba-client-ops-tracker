import test from 'node:test'
import assert from 'node:assert/strict'
import {
  applySubtaskAssignmentInheritance,
  normalizeSubtaskAssignmentInheritance,
  type AssignmentItem,
} from '../src/features/tasks/subtaskAssignment'

const parent = (assignedToUserId?: string): AssignmentItem => ({ id: 'task-1', assignedToUserId })
const subtask = (assignedToUserId?: string, assignmentInherited?: boolean): AssignmentItem => ({
  id: 'subtask-1',
  parentTaskId: 'task-1',
  assignedToUserId,
  assignmentInherited,
})

test('new subtasks always inherit the main task assignee', () => {
  const next = applySubtaskAssignmentInheritance([parent('user-a')], [parent('user-a'), subtask('user-b', false)])
  assert.deepEqual(next[1], subtask('user-a', true))
})

test('inherited subtasks follow main task reassignment', () => {
  const current = [parent('user-a'), subtask('user-a', true)]
  const incoming = [parent('user-b'), subtask('user-a', true)]
  assert.deepEqual(applySubtaskAssignmentInheritance(current, incoming)[1], subtask('user-b', true))
})

test('a manually reassigned subtask keeps its override', () => {
  const current = [parent('user-a'), subtask('user-b', false)]
  const incoming = [parent('user-c'), subtask('user-b', false)]
  assert.deepEqual(applySubtaskAssignmentInheritance(current, incoming)[1], subtask('user-b', false))
})

test('legacy subtasks with the parent assignee are inferred as inherited', () => {
  const normalized = normalizeSubtaskAssignmentInheritance([parent('user-a'), subtask('user-a')])
  assert.equal(normalized[1].assignmentInherited, true)
  const reassigned = applySubtaskAssignmentInheritance(normalized, [parent('user-b'), normalized[1]])
  assert.deepEqual(reassigned[1], subtask('user-b', true))
})

test('legacy subtasks with a different assignee are inferred as overrides', () => {
  const normalized = normalizeSubtaskAssignmentInheritance([parent('user-a'), subtask('user-b')])
  assert.equal(normalized[1].assignmentInherited, false)
  const reassigned = applySubtaskAssignmentInheritance(normalized, [parent('user-c'), normalized[1]])
  assert.deepEqual(reassigned[1], subtask('user-b', false))
})

test('an inherited subtask can be explicitly switched to an override', () => {
  const current = [parent('user-a'), subtask('user-a', true)]
  const incoming = [parent('user-a'), subtask('user-b', false)]
  assert.deepEqual(applySubtaskAssignmentInheritance(current, incoming)[1], subtask('user-b', false))
})

test('an override can opt back into main-task inheritance', () => {
  const current = [parent('user-a'), subtask('user-b', false)]
  const incoming = [parent('user-c'), subtask('user-b', true)]
  assert.deepEqual(applySubtaskAssignmentInheritance(current, incoming)[1], subtask('user-c', true))
})

test('unassigning the main task also unassigns inherited subtasks', () => {
  const current = [parent('user-a'), subtask('user-a', true)]
  const incoming = [parent(), subtask('user-a', true)]
  assert.deepEqual(applySubtaskAssignmentInheritance(current, incoming)[1], subtask(undefined, true))
})
