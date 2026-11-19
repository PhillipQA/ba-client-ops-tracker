import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeColumns, trackerProjectIds } from '../src/features/trackers/trackerModel'
import {
  contractKey,
  missingClientPatches,
  planProjectMove,
  projectForContract,
  rowContract,
  rowPlace,
  rowProjectName,
  rowProjectView,
  trackerProjectChoices,
} from '../src/features/trackers/trackerProjects'
import { bulkColumns } from '../src/features/trackers/trackerBulk'
import { planStepTasks } from '../src/features/trackers/stepTasks'

const columns = [
  { id: 'c_branch', name: 'Branch', type: 'text' as const },
  { id: 'c_site', name: 'Terminal/Site', type: 'text' as const },
  { id: 'c_slss', name: 'SLSS #', type: 'text' as const, taskField: 'contract' as const },
  { id: 'c_hw', name: 'Hardware', type: 'checkbox' as const },
]
const projects = [
  { id: 'p1', name: 'PCI Phase 1', clientId: 'c1', contractNumber: 'SLSS-2024-001' },
  { id: 'p2', name: 'PCI Phase 2', clientId: 'c1', contractNumber: 'SLSS-2025-014' },
  { id: 'p3', name: 'Other client', clientId: 'c9', contractNumber: 'SLSS-2025-099' },
  { id: 'p4', name: 'Closed', clientId: 'c1', contractNumber: 'SLSS-2020-001', seedsArchived: true },
]
const tracker = { clientId: 'c1', clientIds: ['c1'], projectId: 'p1', projectIds: ['p1'], columns }

test('contract numbers match without case, spaces or punctuation', () => {
  assert.equal(contractKey(' slss 2024/001 '), 'slss2024001')
  assert.equal(projectForContract(tracker, 'slss2024001', projects)?.id, 'p1')
  // Not one of the tracker's projects, but an open project of its client.
  assert.equal(projectForContract(tracker, 'SLSS-2025-014', projects)?.id, 'p2')
  assert.equal(projectForContract(tracker, 'SLSS-2025-099', projects), undefined, 'Another client’s project')
  assert.equal(projectForContract(tracker, 'SLSS-2020-001', projects), undefined, 'A closed project')
  assert.equal(projectForContract(tracker, '', projects), undefined)
})

test('a row goes to its task’s project, else its contract’s, else the default project', () => {
  const items = [{ id: 't1', projectId: 'p2', clientId: 'c1' }]
  assert.deepEqual(rowPlace(tracker, { cells: { c_slss: 'SLSS-2024-001' }, taskId: 't1' }, projects, items), {
    projectId: 'p2',
    clientId: 'c1',
    byContract: false,
  })
  assert.equal(rowPlace(tracker, { cells: { c_slss: 'SLSS 2025 014' }, taskId: '' }, projects).projectId, 'p2')
  assert.equal(rowPlace(tracker, { cells: { c_slss: 'unknown' }, taskId: '' }, projects).projectId, 'p1')
  assert.equal(rowContract({ taskId: 't1' }, projects, items), 'SLSS-2025-014')
  assert.equal(rowContract({ taskId: '' }, projects, items), '')
})

test('Site rollout rows are made under the project their contract names', () => {
  const plan = planStepTasks({
    columns,
    rows: [
      { id: 'r1', cells: { c_branch: 'Tarlac', c_slss: 'SLSS-2025-014' }, taskId: '' },
      { id: 'r2', cells: { c_branch: 'Davao' }, taskId: '' },
    ],
    clientId: 'c1',
    projectId: 'p1',
    assigneeId: 'u1',
    placeFor: row => rowPlace(tracker, row, projects),
  })
  assert.deepEqual(
    plan.drafts.map(draft => [draft.title, draft.projectId]),
    [
      ['Tarlac', 'p2'],
      ['Hardware', 'p2'],
      ['Davao', 'p1'],
      ['Hardware', 'p1'],
    ],
  )
})

test('one Contract number column per tracker, Text only; several project ids', () => {
  const kept = normalizeColumns([
    { id: 'a1x', name: 'SLSS #', type: 'text', taskField: 'contract' },
    { id: 'b2x', name: 'Contract', type: 'text', taskField: 'contract' },
    { id: 'c3x', name: 'Count', type: 'number', taskField: 'contract' },
  ] as any)
  assert.deepEqual(
    kept.map(column => column.taskField),
    ['contract', undefined, undefined],
  )
  assert.deepEqual(trackerProjectIds({ projectId: 'p1', projectIds: ['p1', 'p2'] }), ['p1', 'p2'])
  assert.deepEqual(trackerProjectIds({ projectId: 'p1' }), ['p1'])
  assert.deepEqual(trackerProjectIds({ projectId: '' }), [])
})

test('a tracker keeps a project completed in Seeds, but its rows get new tasks only in open projects', async () => {
  const { rowPlace, projectForContract } = await import('../src/features/trackers/trackerProjects')
  const projects = [
    {
      id: 'done',
      name: 'GOLDWING BALABALA',
      clientId: 'c1',
      contractNumber: 'CONTRACT-2026-04-1660',
      seedsArchived: true,
    },
    { id: 'open', name: 'Makati rollout', clientId: 'c1', contractNumber: 'CN-2' },
  ]
  const tracker: any = { projectId: 'done', projectIds: ['done', 'open'], clientIds: ['c1'], columns: [] }
  assert.equal(rowPlace(tracker, { cells: {} }, projects).projectId, 'open', 'the first open project')
  assert.equal(projectForContract(tracker, 'CONTRACT-2026-04-1660', projects), undefined, 'not by its contract')
  assert.equal(projectForContract(tracker, 'CN-2', projects)?.id, 'open')
  assert.equal(
    rowPlace({ ...tracker, projectIds: ['done'] }, { cells: {} }, projects).projectId,
    '',
    'only completed projects: no place for new tasks',
  )
  // A row already linked to a task there keeps it.
  assert.equal(
    rowPlace(tracker, { cells: {}, taskId: 't' }, projects, [{ id: 't', projectId: 'done' }]).projectId,
    'done',
  )
})

test('tasks a sync left with no client get the tracker’s one client back, never a guess', () => {
  const projects = [{ id: 'shared' }, { id: 'own', clientId: 'acme' }]
  const items = [
    { id: 't1', projectId: 'shared' },
    { id: 's1', projectId: 'shared', parentTaskId: 't1' },
    { id: 't2', projectId: 'shared', clientId: 'bolt' },
    { id: 't3', projectId: 'own' },
    { id: 't4', projectId: 'shared' },
  ]
  assert.deepEqual(missingClientPatches({ clientIds: ['emp'] }, ['t1', 't2', 't3'], items, projects), [
    { id: 't1', clientId: 'emp' },
    { id: 's1', clientId: 'emp' },
  ])
  assert.deepEqual(missingClientPatches({ clientIds: ['emp', 'bolt'] }, ['t1'], items, projects), [], 'two clients')
})

test('the Project chip offers the tracker’s projects, the default first, completed ones marked', () => {
  const linked = { projectId: 'p2', projectIds: ['p1', 'p4', 'p2'] }
  const choices = trackerProjectChoices(linked, projects, [{ id: 'c1', name: 'Acme' }])
  assert.deepEqual(
    choices.map(choice => [choice.id, choice.isDefault, choice.completed]),
    [
      ['p2', true, false],
      ['p4', false, true],
      ['p1', false, false],
    ],
    'default first, then by name: Closed before PCI Phase 1',
  )
  assert.equal(choices[0].contractNumber, 'SLSS-2025-014')
  assert.equal(choices[0].clientName, 'Acme')
  // A project no longer in the workspace is left out; with no projectId the first linked one is the default.
  const missing = trackerProjectChoices({ projectIds: ['gone', 'p1'] }, projects, [])
  assert.deepEqual(
    missing.map(choice => choice.id),
    ['p1'],
  )
})

test('a row’s chip: its task can move, a subtask follows its task, a row with no task is automatic', () => {
  const items = [
    { id: 't1', title: 'Closing', projectId: 'p2' },
    { id: 's1', title: 'AP ledger', projectId: 'p2', parentTaskId: 't1' },
    { id: 's2', title: 'Old one', projectId: 'p2', parentTaskId: 't1', archived: true },
  ]
  assert.deepEqual(rowProjectView(tracker, { cells: {}, taskId: 't1' }, projects, items), {
    kind: 'task',
    projectId: 'p2',
    taskId: 't1',
    subtasks: 1,
  })
  assert.deepEqual(rowProjectView(tracker, { cells: {}, taskId: 's1' }, projects, items), {
    kind: 'subtask',
    projectId: 'p2',
    parentTitle: 'Closing',
  })
  assert.deepEqual(
    rowProjectView(tracker, { cells: { c_slss: 'SLSS-2025-014' }, taskId: '' }, projects, items),
    { kind: 'none', projectId: 'p2' },
    'by its contract number',
  )
  assert.deepEqual(rowProjectView(tracker, { cells: {}, taskId: '' }, projects, items), {
    kind: 'none',
    projectId: 'p1',
  })
  assert.equal(rowProjectName({ taskId: 's1' }, projects, items), 'PCI Phase 2')
  assert.equal(rowProjectName({ taskId: '' }, projects, items), '')
})

test('moving tasks to a project takes their subtasks, the project’s client, and only Seeds tasks it has', () => {
  const items = [
    { id: 't1', title: 'Closing', projectId: 'p1', clientId: 'c1', seedsTaskId: 'golive' },
    { id: 's1', title: 'AP', projectId: 'p1', clientId: 'c1', parentTaskId: 't1', seedsTaskId: 'meetings' },
    { id: 't2', title: 'Already there', projectId: 'p2', clientId: 'c1' },
    { id: 't3', title: 'Archived', projectId: 'p1', archived: true },
    { id: 'other', title: 'Not chosen', projectId: 'p1' },
  ]
  const target = { id: 'p2', clientId: 'c2', seedsTasks: [{ id: 'meetings' }] }
  const plan = planProjectMove(items, ['t1', 's1', 't2', 't3', 'missing', 't1'], target)
  assert.equal(plan.tasks, 1)
  assert.equal(plan.subtasks, 1)
  assert.equal(plan.skipped, 4, 'the subtask, the one already there, the archived one, the missing one')
  const byId = new Map(plan.items.map(item => [item.id, item]))
  assert.deepEqual(byId.get('t1'), { id: 't1', title: 'Closing', projectId: 'p2', clientId: 'c2' })
  assert.deepEqual(byId.get('s1'), {
    id: 's1',
    title: 'AP',
    projectId: 'p2',
    clientId: 'c2',
    parentTaskId: 't1',
    seedsTaskId: 'meetings',
  })
  assert.equal(byId.get('other'), items[4], 'untouched')
  assert.deepEqual(
    plan.moved.map(item => item.id),
    ['t1', 's1'],
  )
  // A project shared by several clients (no client of its own) keeps each task's client.
  const shared = planProjectMove(items, ['t1'], { id: 'shared' })
  assert.equal(shared.items[0].clientId, 'c1')
  assert.equal(shared.items[0].seedsTaskId, undefined)
})

test('a Project column is Text, one per tracker, and not set in bulk', () => {
  const [column] = normalizeColumns([
    { id: 'c_p', name: 'Project', type: 'text', taskField: 'project' },
    { id: 'c_q', name: 'Second', type: 'text', taskField: 'project' },
  ])
  assert.equal(column.taskField, 'project')
  const all = normalizeColumns([
    { id: 'c_p', name: 'Project', type: 'text', taskField: 'project' },
    { id: 'c_q', name: 'Second', type: 'text', taskField: 'project' },
    { id: 'c_n', name: 'Number', type: 'number', taskField: 'project' },
  ])
  assert.deepEqual(
    all.map(item => item.taskField),
    ['project', undefined, undefined],
    'one per tracker, Text only',
  )
  assert.deepEqual(
    bulkColumns(all).map(item => item.id),
    ['c_q', 'c_n'],
  )
})
