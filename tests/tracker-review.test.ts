import test from 'node:test'
import assert from 'node:assert/strict'
import {
  choicesFromOrder,
  choicesFromSheet,
  reviewCounts,
  reviewGroups,
  setChoice,
  taskAbove,
  willCreate,
  type Choices,
  type PlanRow,
} from '../src/features/trackers/trackerReviewPlan'
import { sheetRowKeys } from '../src/features/trackers/trackerSync'

const rowsOf = (ids: string[]): PlanRow[] => ids.map(id => ({ id }))

test('uploaded rows group like a Sheet: a name starts a task, blank names are its subtasks', () => {
  const choices = choicesFromOrder([
    { id: 'r0', name: '' },
    { id: 'r1', name: 'EGG' },
    { id: 'r2', name: '' },
    { id: 'r3', name: ' ' },
    { id: 'r4', name: 'HAM' },
    { id: 'r5', name: '' },
  ])
  assert.equal(choices.r0, undefined, 'a row above the first name is left for later')
  assert.deepEqual(choices.r1, { kind: 'task' })
  assert.deepEqual(choices.r2, { kind: 'subtask_new', parentRowId: 'r1' })
  assert.deepEqual(choices.r3, { kind: 'subtask_new', parentRowId: 'r1' })
  assert.deepEqual(choices.r4, { kind: 'task' })
  assert.deepEqual(choices.r5, { kind: 'subtask_new', parentRowId: 'r4' })
})

test('Sheet rows: subtasks attach to a task already linked from an earlier sync', () => {
  const keys = sheetRowKeys(['EGG', '', 'HAM', ''])
  const all: PlanRow[] = [
    { id: 'a', sourceKey: keys[0], taskId: 't_egg' },
    { id: 'b', sourceKey: keys[1] },
    { id: 'c', sourceKey: keys[2] },
    { id: 'd', sourceKey: keys[3] },
  ]
  const choices = choicesFromSheet(all.slice(1), all)
  assert.deepEqual(choices.b, { kind: 'subtask', parentTaskId: 't_egg' })
  assert.deepEqual(choices.c, { kind: 'task' })
  assert.deepEqual(choices.d, { kind: 'subtask_new', parentRowId: 'c' })
})

test('groups show each task followed by its subtasks, and existing-task subtasks under one heading', () => {
  const rows = rowsOf(['a', 'b', 'c', 'd', 'e', 'f'])
  const choices: Choices = {
    a: { kind: 'subtask', parentTaskId: 't1' },
    b: { kind: 'task' },
    c: { kind: 'subtask_new', parentRowId: 'b' },
    e: { kind: 'subtask_new', parentRowId: 'b' },
    f: { kind: 'subtask', parentTaskId: 't1' },
  }
  assert.deepEqual(reviewGroups(rows, choices), [
    { kind: 'existing', taskId: 't1', children: ['a', 'f'] },
    { kind: 'new', rowId: 'b', children: ['c', 'e'] },
    { kind: 'loose', rowId: 'd' },
  ])
})

test('"the task above" passes over skipped and undecided rows', () => {
  const rows: PlanRow[] = [{ id: 'linked', taskId: 't0' }, { id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }]
  const choices: Choices = { a: { kind: 'task' }, c: { kind: 'subtask_new', parentRowId: 'a' } }
  assert.deepEqual(taskAbove(rows, 'd', choices, new Set()), { kind: 'subtask_new', parentRowId: 'a' })
  assert.deepEqual(taskAbove(rows, 'b', choices, new Set()), { kind: 'subtask_new', parentRowId: 'a' })
  assert.deepEqual(taskAbove(rows, 'b', choices, new Set(['a'])), { kind: 'subtask', parentTaskId: 't0' })
  assert.equal(taskAbove(rowsOf(['x', 'y']), 'y', {}, new Set()), null)
})

test('a row that stops being a task hands its subtasks to the task above, or leaves them for later', () => {
  const rows = rowsOf(['a', 'b', 'c', 'd'])
  let choices: Choices = {
    a: { kind: 'task' },
    b: { kind: 'subtask_new', parentRowId: 'a' },
    c: { kind: 'task' },
    d: { kind: 'subtask_new', parentRowId: 'c' },
  }
  choices = setChoice(rows, choices, 'c', null)
  assert.equal(choices.c, undefined)
  assert.deepEqual(choices.d, { kind: 'subtask_new', parentRowId: 'a' })
  choices = setChoice(rows, choices, 'a', null)
  assert.equal(choices.b, undefined)
  assert.equal(choices.d, undefined)
  assert.deepEqual(setChoice(rows, { a: { kind: 'task' } }, 'a', { kind: 'subtask_new', parentRowId: 'a' }), {})
})

test('counts: skipping a task skips nothing else by itself, but its subtasks cannot be created without it', () => {
  const rows = rowsOf(['a', 'b', 'c', 'd'])
  const choices: Choices = {
    a: { kind: 'task' },
    b: { kind: 'subtask_new', parentRowId: 'a' },
    c: { kind: 'subtask', parentTaskId: 't9' },
  }
  assert.deepEqual(reviewCounts(rows, choices, new Set()), { tasks: 1, subtasks: 2, plain: 0, later: 1 })
  assert.deepEqual(reviewCounts(rows, choices, new Set(), 2), { tasks: 1, subtasks: 4, plain: 0, later: 1 })
  assert.equal(willCreate('b', choices, new Set(['a'])), false)
  assert.deepEqual(reviewCounts(rows, choices, new Set(['a', 'b', 'd'])), { tasks: 0, subtasks: 1, plain: 3, later: 0 })
})
