import test from 'node:test'
import assert from 'node:assert/strict'
import { moveToSeeds, projectTasksToMove, seedsTargetProblem } from '../src/features/seeds/moveToSeeds'
import type { Project, WorkItem } from '../src/shared/types'

const project = (fields: Partial<Project>): Project =>
  ({ id: 'p', name: 'P', status: 'Active', targetDate: '', summary: '', ...fields }) as Project
const task = (fields: Partial<WorkItem>): WorkItem => ({ status: 'Open', title: 'T', ...fields }) as WorkItem

const seeds = project({
  id: 'seeds-p',
  name: 'ALB - CITYFRONT MALL',
  seedsId: '77',
  clientId: 'seeds-c',
  seedsTasks: [
    { id: 's-golive', name: 'Go Live' },
    { id: 's-hw', name: 'Hardware' },
    { id: 's-old', name: 'Training', archived: true },
  ],
})
const items = [
  task({ id: 't1', title: 'Alberto Clark Cityfront', clientId: 'old-c', projectId: 'old-p', seedsTaskId: 'x' }),
  task({ id: 't1a', title: 'Hardware', parentTaskId: 't1', clientId: 'old-c', projectId: 'old-p' }),
  task({ id: 't1b', title: 'Training', parentTaskId: 't1' }),
  task({ id: 't2', title: 'Archived site', clientId: 'old-c', projectId: 'old-p', archived: true }),
  task({ id: 't3', title: 'Elsewhere', clientId: 'other', projectId: 'other-p' }),
]

test('a task moves with its subtasks to the Seeds project and its client', () => {
  const result = moveToSeeds(items, { taskIds: ['t1a'], project: seeds })
  assert.deepEqual(result.moved, ['t1'])
  assert.equal(result.subtasks, 2)
  const byId = new Map(result.items.map(item => [item.id, item]))
  for (const id of ['t1', 't1a', 't1b']) {
    assert.equal(byId.get(id)?.clientId, 'seeds-c')
    assert.equal(byId.get(id)?.projectId, 'seeds-p')
  }
  // Seeds tasks by name; an archived Seeds task and the old project's tag are dropped.
  assert.equal(byId.get('t1')?.seedsTaskId, undefined)
  assert.equal(byId.get('t1a')?.seedsTaskId, 's-hw')
  assert.equal(byId.get('t1b')?.seedsTaskId, undefined)
  assert.deepEqual(byId.get('t3'), items[4], 'Other work is untouched')
  assert.equal(result.items.length, items.length, 'Moved, not copied')
})

test('a chosen Seeds task tags the moved task; archived and already-moved tasks are skipped', () => {
  const result = moveToSeeds(items, { taskIds: ['t1', 't2'], project: seeds, seedsTaskId: 's-golive' })
  assert.equal(result.items.find(item => item.id === 't1')?.seedsTaskId, 's-golive')
  assert.deepEqual(
    result.skipped.map(skip => skip.id),
    ['t2'],
  )
  const again = moveToSeeds(result.items, { taskIds: ['t1'], project: seeds })
  assert.deepEqual(again.moved, [])
  assert.equal(again.skipped[0].reason, 'Already in this project.')
})

test('only an open Seeds project with a client can take work', () => {
  assert.equal(seedsTargetProblem(seeds), '')
  assert.match(seedsTargetProblem(project({ id: 'b' })), /Choose a Seeds project/)
  assert.match(seedsTargetProblem({ ...seeds, seedsArchived: true }), /closed/)
  assert.match(seedsTargetProblem({ ...seeds, clientId: undefined }), /no client/)
  assert.throws(() => moveToSeeds(items, { taskIds: ['t1'], project: project({ id: 'b' }) }))
})

test('a project offers its top-level tasks, archived last', () => {
  assert.deepEqual(
    projectTasksToMove(items, 'old-p').map(item => item.id),
    ['t1', 't2'],
  )
})
