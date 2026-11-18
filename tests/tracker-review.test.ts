import test from 'node:test'
import assert from 'node:assert/strict'
import {
  choicesFromOrder,
  choicesFromSheet,
  reviewCounts,
  reviewDrafts,
  reviewGroups,
  reviewOutcome,
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

test('create makes a task per named row, a subtask per chosen header (linked to its cell), then rows under', () => {
  const open = rowsOf(['r0', 'r1', 'r2', 'r3'])
  const choices = choicesFromOrder([
    { id: 'r0', name: 'Makati' },
    { id: 'r1', name: '' },
    { id: 'r2', name: 'Ortigas' },
    { id: 'r3', name: '' },
  ])
  const titles: Record<string, string> = { r0: 'Makati', r1: 'Permits', r2: 'Ortigas', r3: 'Wiring' }
  const { drafts, links } = reviewDrafts({
    open,
    choices,
    skipped: new Set(['r3']),
    subColumns: [
      { id: 'c-survey', name: 'Site survey' },
      { id: 'c-live', name: 'Go-live' },
    ],
    titleOf: id => titles[id],
    clientId: 'client-a',
    projectId: 'project-x',
  })
  assert.deepEqual(
    drafts.map(draft => [draft.title, draft.clientId, draft.projectId, draft.parentIndex ?? null]),
    [
      ['Makati', 'client-a', 'project-x', null],
      ['Ortigas', 'client-a', 'project-x', null],
      ['Site survey', '', '', 0],
      ['Go-live', '', '', 0],
      ['Site survey', '', '', 1],
      ['Go-live', '', '', 1],
      ['Permits', '', '', 0],
    ],
    'a skipped row under a task is not made',
  )
  assert.deepEqual(links, [
    { rowId: 'r0' },
    { rowId: 'r2' },
    { rowId: 'r0', columnId: 'c-survey' },
    { rowId: 'r0', columnId: 'c-live' },
    { rowId: 'r2', columnId: 'c-survey' },
    { rowId: 'r2', columnId: 'c-live' },
    { rowId: 'r1' },
  ])
  const outcome = reviewOutcome(
    drafts.map((_, at) => ({ id: `t${at}` })),
    links,
    ['r0', 'r1', 'r2', 'r3'],
  )
  assert.deepEqual(outcome.rowTasks, [
    { rowId: 'r0', taskId: 't0' },
    { rowId: 'r2', taskId: 't1' },
    { rowId: 'r1', taskId: 't6' },
  ])
  assert.equal(outcome.cellLinks.length, 4)
  assert.deepEqual(outcome.cellLinks[0], { rowId: 'r0', columnId: 'c-survey', taskId: 't2' })
  assert.deepEqual(outcome.reviewed, ['r0', 'r1', 'r2', 'r3'])
})

test('create: a new project by name, and subtasks of tasks that already exist', () => {
  const { drafts } = reviewDrafts({
    open: rowsOf(['a', 'b']),
    choices: { a: { kind: 'task' }, b: { kind: 'subtask', parentTaskId: 'existing-1' } },
    skipped: new Set(),
    subColumns: [],
    titleOf: id => id.toUpperCase(),
    clientId: 'c1',
    projectId: '',
    newProjectName: 'Sta. Rosa roll-out',
  })
  assert.deepEqual(drafts[0], { title: 'A', clientId: 'c1', projectId: '', newProjectName: 'Sta. Rosa roll-out' })
  assert.deepEqual(drafts[1], { title: 'B', clientId: '', projectId: '', parentTaskId: 'existing-1' })
})
