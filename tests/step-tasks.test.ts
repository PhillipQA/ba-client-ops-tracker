import test from 'node:test'
import assert from 'node:assert/strict'
import {
  keepsStepTasks,
  planMissingSteps,
  planStepTasks,
  siteTaskPatch,
  siteTaskTitle,
  stepChanges,
} from '../src/features/trackers/stepTasks'
import { templateById } from '../src/features/trackers/trackerTemplates'

const columns = [
  { id: 'c_branch', name: 'Branch', type: 'text' as const },
  { id: 'c_site', name: 'Terminal/Site', type: 'text' as const },
  { id: 'c_hw', name: 'Hardware', type: 'checkbox' as const },
  { id: 'c_cor', name: 'COR', type: 'checkbox' as const },
  { id: 'c_go', name: 'Go Live Date', type: 'date' as const, taskField: 'due' as const },
]

test('a Site rollout row becomes a task named Branch – Terminal/Site, with a subtask per step', () => {
  assert.equal(keepsStepTasks({ template: 'site-rollout' }), true)
  assert.equal(keepsStepTasks({ template: 'project-timeline' }), false)
  assert.equal(templateById('site-rollout')?.columns.find(c => c.name === 'Go Live Date')?.taskField, 'due')
  assert.equal(siteTaskTitle(columns, { c_branch: 'Sta Rosa', c_site: 'Terminal 1' }), 'Sta Rosa – Terminal 1')
  assert.equal(siteTaskTitle(columns, { c_branch: 'Sta Rosa' }), 'Sta Rosa')
  assert.equal(siteTaskTitle(columns, {}), '')
  const plan = planStepTasks({
    columns,
    rows: [
      { id: 'r1', cells: { c_branch: 'Sta Rosa', c_site: 'T1', c_cor: true, c_go: '2026-11-20' }, taskId: '' },
      { id: 'r2', cells: {}, taskId: '' },
      { id: 'r3', cells: { c_branch: 'Greenhills' }, taskId: 'already' },
    ],
    clientId: 'c1',
    projectId: 'p1',
    assigneeId: 'u1',
  })
  assert.deepEqual(
    plan.drafts.map(draft => [draft.title, draft.parentIndex, draft.dueDate, draft.assignedToUserId]),
    [
      ['Sta Rosa – T1', undefined, '2026-11-20', 'u1'],
      ['Hardware', 0, undefined, 'u1'],
      ['COR', 0, undefined, 'u1'],
    ],
  )
  assert.deepEqual(plan.rowTasks, [{ rowId: 'r1', draft: 0 }])
  assert.deepEqual(plan.cellTasks, [
    { rowId: 'r1', columnId: 'c_hw', draft: 1 },
    { rowId: 'r1', columnId: 'c_cor', draft: 2 },
  ])
  assert.deepEqual(plan.ticked, [2], 'COR was already ticked')
})

test('the site task follows its name and Go Live Date; ticks are found per step', () => {
  assert.deepEqual(
    siteTaskPatch(columns, 't', { c_branch: 'A' }, { c_branch: 'A', c_site: 'T2', c_go: '2026-12-01' }),
    {
      id: 't',
      title: 'A – T2',
      dueDate: '2026-12-01',
    },
  )
  assert.equal(siteTaskPatch(columns, 't', { c_branch: 'A', c_hw: true }, { c_branch: 'A' }), null)
  assert.deepEqual(stepChanges(columns, { c_hw: true }, { c_cor: true }), [
    { columnId: 'c_hw', done: false },
    { columnId: 'c_cor', done: true },
  ])
})

test('a row whose task was picked from the cell gets the missing step subtasks, reusing ones named like a step', () => {
  const plan = planMissingSteps({
    columns,
    rows: [
      { id: 'r1', cells: { c_cor: true }, taskId: 'picked' },
      { id: 'r2', cells: {}, taskId: 'old' },
      { id: 'r3', cells: {}, taskId: 'fresh' },
    ],
    links: [{ rowId: 'r2', columnId: 'c_hw', taskId: 'hw2' }],
    items: [
      { id: 'picked', title: 'Sta Rosa', clientId: 'c9', projectId: 'p9' },
      { id: 'hw1', title: 'hardware', parentTaskId: 'picked' },
      { id: 'old', title: 'Greenhills', archived: false },
      { id: 'hw2', title: 'Hardware', parentTaskId: 'old' },
    ],
    clientId: 'c1',
    projectId: 'p1',
    assigneeId: 'u1',
  })
  assert.deepEqual(plan.existing, [{ rowId: 'r1', columnId: 'c_hw', taskId: 'hw1' }])
  assert.deepEqual(
    plan.drafts.map(draft => [draft.title, draft.parentTaskId, draft.clientId]),
    [
      ['COR', 'picked', 'c9'],
      ['COR', 'old', 'c1'],
      ['Hardware', 'fresh', 'c1'],
      ['COR', 'fresh', 'c1'],
    ],
  )
  assert.deepEqual(plan.ticked, [0], 'COR was ticked on the first row')
})

test('the tracker’s own switch wins over its template', () => {
  assert.equal(keepsStepTasks({ template: 'site-rollout', stepTasks: false }), false)
  assert.equal(keepsStepTasks({ template: 'saved', stepTasks: true }), true)
  assert.equal(keepsStepTasks({ template: 'saved' }), false)
})
