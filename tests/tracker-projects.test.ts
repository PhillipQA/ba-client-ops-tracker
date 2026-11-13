import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeColumns, trackerProjectIds } from '../src/features/trackers/trackerModel'
import { contractKey, projectForContract, rowContract, rowPlace } from '../src/features/trackers/trackerProjects'
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
