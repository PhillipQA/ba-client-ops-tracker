import assert from 'node:assert/strict'
import test from 'node:test'
import { evidenceInDatabase, evidenceInDrive, moveEvidenceToDrive } from '../server/tasks/evidence-storage'
import { assertLifecycleMutation } from '../src/features/tasks/lifecycle'

const settings: any = {
  statuses: [
    { label: 'In Progress', closed: false },
    { label: 'Closed', closed: true },
  ],
  waitingOn: [
    { id: 'client', label: 'Client', done: false },
    { id: 'done', label: 'Done', done: true },
  ],
}
const inDatabase = (id: string) => ({
  id,
  fileName: `${id}.png`,
  mimeType: 'image/png',
  fileSize: 10,
  storagePath: `organizations/o/subtasks/t/${id}-${id}.png`,
  uploadedAt: '2026-11-01T00:00:00Z',
  uploadedBy: 'u1',
  uploadedByName: 'Phillip',
  kind: 'Screenshot',
})
const state = (): any => ({
  clients: [{ id: 'c', name: 'Client' }],
  projects: [{ id: 'p', name: 'Project', clientId: 'c' }],
  taskSettings: settings,
  items: [
    {
      id: 'task',
      title: 'Rollout',
      status: 'In Progress',
      clientId: 'c',
      projectId: 'p',
      evidence: [inDatabase('e1')],
    },
    {
      id: 'sub',
      title: 'Go Live',
      status: 'Closed',
      waitingOn: 'Done',
      parentTaskId: 'task',
      clientId: 'c',
      projectId: 'p',
      archived: false,
      evidence: [inDatabase('e2'), { ...inDatabase('e3'), storagePath: '', driveFileId: 'f3', driveUrl: 'u3' }],
    },
  ],
})

test('evidence still in the database is found, top-level tasks included; Drive files are counted', () => {
  const found = evidenceInDatabase(state())
  assert.deepEqual(
    found.map(({ task, entry }) => `${task.id}:${entry.id}`),
    ['task:e1', 'sub:e2'],
  )
  assert.equal(evidenceInDrive(state()), 1)
})

test('moved evidence points to its Drive copy and leaves the database path empty; nothing else changes', () => {
  const before = state()
  const after = moveEvidenceToDrive(before, [{ taskId: 'sub', id: 'e2', fileId: 'f2', url: 'https://drive/f2' }])
  const moved = after.items[1].evidence[0]
  assert.deepEqual([moved.storagePath, moved.driveFileId, moved.driveUrl], ['', 'f2', 'https://drive/f2'])
  assert.equal(moved.fileName, 'e2.png', 'name, size and uploader are kept')
  assert.deepEqual(after.items[0], before.items[0], 'other tasks are untouched')
  assert.deepEqual(after.items[1].evidence[1], before.items[1].evidence[1])
  assert.deepEqual(evidenceInDatabase(after).length, 1)
})

test('only the system may repoint evidence on archived work; a person still cannot change archived work', () => {
  const current = state()
  current.items[0].status = 'Closed'
  current.items[0].waitingOn = 'Done'
  current.items[0].archived = true
  const next = moveEvidenceToDrive(current, [
    { taskId: 'task', id: 'e1', fileId: 'f1', url: 'u1' },
    { taskId: 'sub', id: 'e2', fileId: 'f2', url: 'u2' },
  ])
  assert.doesNotThrow(() => assertLifecycleMutation(current, next, null))
  const person: any = { id: 'u1', role: 'Administrator', modules: ['items'] }
  assert.throws(() => assertLifecycleMutation(current, next, person), /Reopen|archived/i)
  const renamed = { ...next, items: next.items.map((item: any) => ({ ...item, title: `${item.title}!` })) }
  assert.throws(() => assertLifecycleMutation(current, renamed, null), 'other changes stay refused for the system')
})

test('the app keeps evidence stored in Drive when it loads the workspace', async () => {
  const { normalizeStore, seedStore } = await import('../src/app/store')
  const loaded = normalizeStore(state(), seedStore())
  const evidence = loaded.items.find(item => item.id === 'sub')?.evidence || []
  assert.deepEqual(
    evidence.map(entry => [entry.id, entry.storagePath ? 'database' : 'drive', entry.driveFileId || '']),
    [
      ['e2', 'database', ''],
      ['e3', 'drive', 'f3'],
    ],
  )
  assert.equal(evidence[1].driveUrl, 'u3')
})
