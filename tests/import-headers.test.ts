import test from 'node:test'
import assert from 'node:assert/strict'
import {
  type HeaderChoices,
  importPreview,
  roleOf,
  setRole,
  suggestedSubtasks,
} from '../src/features/trackers/importHeaders'

const headers = ['Site', 'Site survey', 'Go-live', 'Notes', 'Done']
const rows = [
  ['', '', '', 'header note', ''],
  ['Makati branch', 'TRUE', '11/25/2026', '', 'FALSE'],
  ['', '', '', 'permits', ''],
  ['', '', '', 'wiring', ''],
  ['Ortigas branch', 'FALSE', '12/02/2026', '', 'FALSE'],
  ['', '', '', '', ''],
]
const start: HeaderChoices = { task: 0, subtasks: [], included: [true, true, true, true, true] }

test('every header starts as info, the first as the task name', () => {
  assert.deepEqual(
    headers.map((_, index) => roleOf(start, index)),
    ['task', 'info', 'info', 'info', 'info'],
  )
})

test('one header is the task name; choosing another moves it, and leaving one out clears its role', () => {
  let choices = setRole(start, 1, 'subtask')
  choices = setRole(choices, 2, 'subtask')
  assert.deepEqual(choices.subtasks, [1, 2])
  choices = setRole(choices, 3, 'task')
  assert.equal(choices.task, 3)
  assert.equal(roleOf(choices, 0), 'info', 'the old task name header is info')
  choices = setRole(choices, 3, 'skip')
  assert.equal(choices.task, -1, 'a header left out is not the task name')
  assert.equal(choices.included[3], false)
  choices = setRole(choices, 2, 'info')
  assert.deepEqual(choices.subtasks, [1])
  choices = setRole(choices, 1, 'task')
  assert.deepEqual(choices.subtasks, [], 'the task name header is not also a subtask')
  assert.equal(roleOf(choices, 1), 'task')
  choices = setRole(choices, 3, 'subtask')
  assert.equal(choices.included[3], true, 'a left-out header comes back in')
})

test('Checkbox headers are suggested as subtasks, never chosen for the person', () => {
  const types = ['text', 'checkbox', 'date', 'longtext', 'checkbox'] as const
  assert.deepEqual(suggestedSubtasks([...types], start), [1, 4])
  assert.deepEqual(suggestedSubtasks([...types], setRole(start, 1, 'subtask')), [4])
  assert.deepEqual(suggestedSubtasks([...types], { ...start, task: 1 }), [4])
  assert.deepEqual(start.subtasks, [])
})

test('the preview counts what the review creates: tasks, rows under them, and a subtask per header', () => {
  const choices = setRole(setRole(start, 1, 'subtask'), 2, 'subtask')
  const preview = importPreview(headers, rows, choices)
  assert.equal(preview.tasks, 2)
  assert.equal(preview.rowSubtasks, 2, 'the two rows under Makati')
  assert.equal(preview.headerSubtasks, 4, 'Site survey and Go-live for each task')
  assert.equal(preview.subtasks, 6)
  assert.equal(preview.undecided, 1, 'the row above the first name is left for the review')
  assert.deepEqual(preview.example, { task: 'Makati branch', subtasks: ['Site survey', 'Go-live'], rowsUnder: 2 })
})

test('no task name header: nothing is created', () => {
  const preview = importPreview(headers, rows, setRole(start, 0, 'info'))
  assert.deepEqual([preview.tasks, preview.subtasks, preview.example], [0, 0, null])
  const left = importPreview(headers, rows, { ...start, included: [false, true, true, true, true] })
  assert.equal(left.tasks, 0)
})
