import assert from 'node:assert/strict'
import { test } from 'node:test'
import { defaultTaskSettings } from '../src/app/data'
import { nameColumn, newSeedsProjects, projectsForTracker, seedsRowCells } from '../src/features/trackers/seedsRows'
import { tasksFromDrafts } from '../src/features/trackers/trackerTaskDrafts'

test('only projects a save brought in from Seeds count as new', () => {
  const before = { projects: [{ id: 'p1', seedsId: '1', clientId: 'c1', name: 'Old' }] }
  const after = {
    projects: [
      { id: 'p1', seedsId: '1', clientId: 'c1', name: 'Old, renamed' },
      { id: 'p2', seedsId: '2', clientId: 'c1', name: ' SM Tarlac ', contractNumber: ' SLSS-2 ' },
      { id: 'p3', seedsId: '3', clientId: '', name: 'Internal' },
      { id: 'p4', clientId: 'c1', name: 'Made here' },
      { id: 'p5', seedsId: '5', clientId: 'c1', name: 'Closed', seedsArchived: true },
      { id: 'p6', seedsId: '6', clientId: 'c1', name: 'Moved', beforeSeeds: true },
    ],
  }
  assert.deepEqual(newSeedsProjects(before, after), [
    { id: 'p2', name: 'SM Tarlac', clientId: 'c1', contractNumber: 'SLSS-2' },
  ])
  assert.deepEqual(newSeedsProjects(after, after), [])
})

test('a tracker takes new projects of its own clients only when switched on and open', () => {
  const fresh = [
    { id: 'p2', name: 'A', clientId: 'c1' },
    { id: 'p3', name: 'B', clientId: 'c2' },
    { id: 'p4', name: 'C', clientId: 'c1' },
  ]
  const tracker = { client_id: 'c1,c9', project_id: 'p1,p4', seeds_rows: true, archived_at: null }
  assert.deepEqual(
    projectsForTracker(tracker, fresh).map(project => project.id),
    ['p2'],
    'Not another client’s, and not one it has already',
  )
  assert.deepEqual(projectsForTracker({ ...tracker, seeds_rows: false }, fresh), [])
  assert.deepEqual(projectsForTracker({ ...tracker, archived_at: '2026-11-01' }, fresh), [])
})

test('the row is named in Branch, else Terminal/Site, else the first plain text column; with its contract', () => {
  const col = (id: string, name: string, type = 'text', extra: any = {}) => ({ id, name, type, ...extra }) as any
  const contract = col('k', 'SLSS #', 'text', { taskField: 'contract' })
  const project = { id: 'p', name: 'SM Tarlac', clientId: 'c', contractNumber: 'SLSS-2' }
  assert.equal(nameColumn([contract, col('s', 'Terminal/Site'), col('b', 'Branch')])?.id, 'b')
  assert.equal(nameColumn([contract, col('n', 'Notes'), col('s', 'Terminal / Site')])?.id, 's')
  assert.equal(nameColumn([contract, col('n', 'Notes')])?.id, 'n')
  assert.equal(nameColumn([contract, col('d', 'Go Live', 'date')]), undefined)
  assert.deepEqual(seedsRowCells([col('b', 'Branch'), contract], project), { b: 'SM Tarlac', k: 'SLSS-2' })
  assert.equal(seedsRowCells([col('d', 'Go Live', 'date')], project), null)
})

test('tracker task drafts become tasks and subtasks, with the project’s Seeds task by name', () => {
  let n = 0
  const workspace = {
    clients: [{ id: 'c1' }],
    projects: [
      {
        id: 'p9',
        name: 'SM Tarlac',
        status: 'Active',
        targetDate: '',
        summary: '',
        seedsTasks: [{ id: 's1', name: 'Hardware' }],
      },
    ],
    items: [],
    accounts: [{ id: 'u1', name: 'Ana' }],
    taskSettings: defaultTaskSettings,
  } as any
  const { made, activity } = tasksFromDrafts(
    workspace,
    [
      { title: 'SM Tarlac', clientId: 'c1', projectId: 'p9', assignedToUserId: 'u1' },
      { title: 'Hardware', clientId: 'c1', projectId: 'p9', parentIndex: 0 },
    ],
    { today: '2026-11-13', newId: () => `id${n++}` },
  )
  assert.deepEqual(
    made.map(item => [item.id, item.title, item.parentTaskId, item.projectId, item.assignedToUserId, item.seedsTaskId]),
    [
      ['id0', 'SM Tarlac', undefined, 'p9', 'u1', undefined],
      ['id1', 'Hardware', 'id0', 'p9', 'u1', 's1'],
    ],
  )
  assert.equal(made[1].owner, 'Ana')
  assert.equal(activity.length, 2)
  assert.throws(
    () =>
      tasksFromDrafts(workspace, [{ title: 'X', clientId: 'nope', projectId: 'p9' }], { today: '', newId: () => 'x' }),
    /client was not found/,
  )
})

test('Tracker details offers the Seeds switch only when one of its clients comes from Seeds', async () => {
  const { renderToStaticMarkup } = await import('react-dom/server')
  const { createElement } = await import('react')
  const { default: TrackerDetailsDialog } = await import('../src/features/trackers/TrackerDetailsDialog')
  const tracker: any = {
    id: 't',
    name: 'PCI rollout',
    clientId: 'c1',
    clientIds: ['c1'],
    projectId: 'p1',
    projectIds: ['p1'],
    template: 'site-rollout',
    columns: [],
    members: [],
    canManage: true,
    createdBy: 'u1',
  }
  const render = (projects: any[]) =>
    renderToStaticMarkup(
      createElement(TrackerDetailsDialog, {
        tracker,
        clients: [{ id: 'c1', name: 'Picture City' }],
        projects,
        people: [],
        onClose: () => {},
        onSave: async () => {},
      }),
    )
  const seeds = render([{ id: 'p1', name: 'SM Tarlac', clientId: 'c1', seedsId: '77' }])
  assert.match(seeds, /Add new Seeds projects as rows/)
  assert.match(seeds, /and a subtask for each step/)
  assert.doesNotMatch(render([{ id: 'p1', name: 'Old', clientId: 'c1' }]), /Add new Seeds projects/)
})
