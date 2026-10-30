import test from 'node:test'
import assert from 'node:assert/strict'
import { cellSubtaskPatches, tickChanges } from '../src/features/trackers/cellSubtasks'
import type { TrackerColumn } from '../src/features/trackers/trackerModel'
import { applyTrackerTaskPatches, trackerTaskUpdater } from '../server/trackers/tracker-task-updates'

const columns = [
  { id: 'c_site', name: 'Site', type: 'text' },
  { id: 'c_hw', name: 'Hardware', type: 'checkbox' },
  { id: 'c_drf', name: 'Signed DRF', type: 'checkbox' },
  { id: 'c_go', name: 'Go Live Date', type: 'date' },
] as TrackerColumn[]

test('ticks: only Checkbox columns count, and an empty cell is unticked', () => {
  assert.deepEqual(tickChanges(columns, { c_hw: true }, { c_drf: true, c_site: 'Batch 5' }), [
    { columnId: 'c_hw', done: false },
    { columnId: 'c_drf', done: true },
  ])
  assert.deepEqual(tickChanges(columns, { c_hw: false }, {}), [], 'false and empty are both unticked')
})

test('a tick completes the subtask in that cell, on any tracker; other cells and whole-row links are left alone', () => {
  const links = [
    { rowId: 'r1', columnId: 'c_hw', taskId: 's_hw' },
    { rowId: 'r1', columnId: 'c_drf', taskId: 's_drf' },
    { rowId: 'r1', columnId: '', taskId: 't_site' },
    { rowId: 'r2', columnId: 'c_hw', taskId: 's_other_row' },
  ]
  assert.deepEqual(cellSubtaskPatches(columns, [{ rowId: 'r1', before: {}, after: { c_hw: true } }], links), [
    { id: 's_hw', done: true },
  ])
  assert.deepEqual(
    cellSubtaskPatches(columns, [{ rowId: 'r1', before: { c_drf: true }, after: { c_go: '2026-11-02' } }], links),
    [{ id: 's_drf', done: false }],
    'unticking reopens it',
  )
  assert.deepEqual(
    cellSubtaskPatches(columns, [{ rowId: 'r1', before: {}, after: { c_site: 'Batch 5' } }], links),
    [],
    'a change to a text cell completes nothing',
  )
  assert.deepEqual(
    cellSubtaskPatches(columns, [{ rowId: 'r3', before: {}, after: { c_hw: true } }], links),
    [],
    'a box without a subtask completes nothing',
  )
  // The same subtask in two cells that changed: the last change wins, one patch.
  const shared = [
    { rowId: 'r1', columnId: 'c_hw', taskId: 's1' },
    { rowId: 'r1', columnId: 'c_drf', taskId: 's1' },
  ]
  assert.deepEqual(
    cellSubtaskPatches(columns, [{ rowId: 'r1', before: { c_drf: true }, after: { c_hw: true } }], shared),
    [{ id: 's1', done: false }],
  )
})

const workspace = () => ({
  clients: [{ id: 'c1', name: 'Card Indo' }],
  projects: [
    { id: 'p1', name: 'Rollout', clientId: 'c1' },
    { id: 'p_old', name: 'Old rollout', clientId: 'c1', archived: true },
  ],
  taskSettings: {
    statuses: [
      { id: 'open', label: 'To do', closed: false },
      { id: 'done', label: 'Done', closed: true },
      { id: 'resolved', label: 'Resolved', closed: true },
    ],
  },
  items: [
    { id: 't1', title: 'Batch 5', status: 'To do', clientId: 'c1', projectId: 'p1' },
    { id: 's1', title: 'Signed DRF', status: 'To do', parentTaskId: 't1', clientId: 'c1', projectId: 'p1' },
    { id: 's2', title: 'Hardware', status: 'To do', parentTaskId: 't1', clientId: 'c1', projectId: 'p1' },
    {
      id: 's3',
      title: 'COR',
      status: 'Done',
      waitingOn: 'Done',
      resolvedDate: '2026-10-01',
      parentTaskId: 't1',
      clientId: 'c1',
      projectId: 'p1',
    },
    { id: 's_arch', title: 'Old step', status: 'To do', parentTaskId: 't1', archived: true },
    { id: 't_old', title: 'Old site', status: 'To do', clientId: 'c1', projectId: 'p_old' },
    { id: 's_old', title: 'Old DRF', status: 'To do', parentTaskId: 't_old', clientId: 'c1', projectId: 'p_old' },
  ],
  activity: [{ id: 'a0', date: '2026-10-01', text: 'Earlier' }],
})

test('a ticked box completes its subtask the way the app does: first closed status, Done, resolved today', () => {
  const state = workspace()
  const result = applyTrackerTaskPatches(state, [{ id: 's1', done: true }], {
    today: '2026-10-30',
    from: 'the Google Sheet',
  })
  assert.deepEqual(result.changed, [{ id: 's1', title: 'Signed DRF', done: true }])
  const s1 = result.state.items.find((item: any) => item.id === 's1')
  assert.equal(s1.status, 'Done', 'the workspace’s first closed status, not a fixed label')
  assert.equal(s1.waitingOn, 'Done')
  assert.equal(s1.resolvedDate, '2026-10-30')
  assert.equal(result.state.items.find((item: any) => item.id === 't1').status, 'To do', 'its task still has open work')
  assert.equal(result.state.activity[0].text, 'Completed subtask from the Google Sheet: Signed DRF')
  assert.equal(result.state.activity[1].id, 'a0')
  assert.equal(state.items[1].status, 'To do', 'the input is not changed')
})

test('an unticked box reopens its subtask with the first open status', () => {
  const result = applyTrackerTaskPatches(workspace(), [{ id: 's3', done: false }], {
    today: '2026-10-30',
    from: 'the Google Sheet',
  })
  const s3 = result.state.items.find((item: any) => item.id === 's3')
  assert.equal(s3.status, 'To do')
  assert.equal(s3.waitingOn, 'Me')
  assert.equal(s3.resolvedDate, undefined)
  assert.match(result.state.activity[0].text, /^Reopened subtask/)
})

test('archived work, work of archived projects, and tasks already in that state are left alone', () => {
  const state = workspace()
  const result = applyTrackerTaskPatches(
    state,
    [
      { id: 's_arch', done: true },
      { id: 's_old', done: true },
      { id: 's3', done: true },
      { id: 'missing', done: true },
    ],
    { today: '2026-10-30', from: 'the Google Sheet' },
  )
  assert.deepEqual(result.changed, [])
  assert.equal(result.state, state, 'nothing to save')
})

test('completing every subtask completes the task too, as in Tasks', () => {
  const result = applyTrackerTaskPatches(
    workspace(),
    [
      { id: 's1', done: true },
      { id: 's2', done: true },
    ],
    { today: '2026-10-30', from: 'the Google Sheet' },
  )
  assert.equal(result.state.items.find((item: any) => item.id === 't1').status, 'Done')
  assert.deepEqual(result.changed.map(entry => entry.id).sort(), ['s1', 's2', 't1'])
})

test('the server saves once, retries once when the workspace changed meanwhile, and skips saves with no change', async () => {
  const saves: any[] = []
  let failures = 1
  const loaded: any[] = []
  const update = trackerTaskUpdater({
    load: async () => {
      const data = workspace()
      loaded.push(data)
      return { data }
    },
    commit: async (tenant, next, actor, reason, current) => {
      if (failures-- > 0) throw Object.assign(new Error('changed'), { retry: true })
      saves.push({ tenant, next, actor, reason, current })
    },
    today: () => '2026-10-30',
    retryable: error => Boolean((error as any).retry),
  })
  const actor = { id: 'u1', name: 'Ana Reyes', role: 'Contributor' }
  assert.equal(await update('org', [{ id: 's1', done: true }], actor, 'the Google Sheet'), 1)
  assert.equal(loaded.length, 2, 'loaded again after the first save lost the race')
  assert.equal(saves.length, 1)
  assert.equal(saves[0].current, loaded[1], 'compared against what was loaded')
  assert.equal(saves[0].reason, 'tracker-cell-tick')
  assert.equal(saves[0].actor, actor)
  assert.equal(await update('org', [{ id: 's3', done: true }], actor, 'the Google Sheet'), 0)
  assert.equal(saves.length, 1, 'already done: nothing saved')
  assert.equal(await update('org', [], actor, 'the Google Sheet'), 0)

  failures = 5
  await assert.rejects(update('org', [{ id: 's1', done: true }], actor, 'the Google Sheet'), /changed/)
})
