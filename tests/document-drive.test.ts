import assert from 'node:assert/strict'
import { test } from 'node:test'
import { driveFileGroups, extensionOf, fileSize, taskOptions } from '../src/documentDriveTargets'

const file = (id: string, name: string, size = 2048) => ({ id, name, url: `https://drive.google.com/file/d/${id}/view`, mimeType: 'application/pdf', size, savedAt: '2026-10-22T00:00:00Z', savedBy: 'u', savedByName: 'Una' })
const scope: any = {
  clients: [{ id: 'c1', name: 'Acme' }, { id: 'c2', name: 'Old Co', archived: true }],
  projects: [{ id: 'p1', name: 'Rollout' }, { id: 'p2', name: 'Retired', archived: true }],
  items: [
    { id: 't1', title: 'Sorsogon City', clientId: 'c1', projectId: 'p1', driveFiles: [file('f1', '133 SORSOGON CITY COR.pdf'), file('f2', 'notes.txt'), file('f3', 'big.pdf', 20 * 1024 * 1024)] },
    { id: 's1', title: 'DRF Creation', clientId: 'c1', projectId: 'p1', parentTaskId: 't1', driveFiles: [file('f4', 'signed DRF.pdf')] },
    { id: 's2', title: 'Sign-off', clientId: 'c1', projectId: 'p1', parentTaskId: 't1' },
    { id: 't2', title: 'Old work', clientId: 'c2', projectId: 'p1', driveFiles: [file('f5', 'old COR.pdf')] },
    { id: 't3', title: 'Retired project work', clientId: 'c1', projectId: 'p2', driveFiles: [file('f6', 'retired.pdf')] },
    { id: 'orphan', title: 'Lost child', clientId: 'c1', projectId: 'p1', parentTaskId: 'gone' },
  ],
}

test('Drive task choices list tasks with their subtasks and skip archived clients and projects', () => {
  assert.deepEqual(taskOptions(scope, '').map(o => o.id), ['t1', 's1', 's2', 'orphan'])
  assert.equal(taskOptions(scope, '')[0].label, 'Sorsogon City — Acme / Rollout')
  assert.match(taskOptions(scope, '')[1].label, /↳ DRF Creation/)
  assert.deepEqual(taskOptions(scope, 'c2'), [], 'An archived client offers nothing')
  assert.deepEqual(taskOptions({ ...scope, items: [] }, ''), [])
})

test('Drive file picker lists only accepted, searchable files from active work', () => {
  const allowed = new Set(['.pdf', '.jpg', '.docx'])
  const groups = (query = '', clientId = '') => driveFileGroups(scope, { allowed, clientId, query }).map(g => [g.item.id, g.files.map((f: any) => f.id)])
  assert.deepEqual(groups(), [['t1', ['f1', 'f3']], ['s1', ['f4']]], 'Text files, archived clients and archived projects are left out')
  assert.deepEqual(groups('sorsogon'), [['t1', ['f1', 'f3']]], 'Search matches the task name and the file name')
  assert.deepEqual(groups('signed'), [['s1', ['f4']]])
  assert.equal(groups('', 'c1').length, 2);assert.deepEqual(groups('', 'c2'), [])
  assert.deepEqual(groups('nothing matches'), [])
})

test('Drive picker helpers format sizes and extensions', () => {
  assert.equal(fileSize(500), '1 KB');assert.equal(fileSize(2048), '2 KB');assert.equal(fileSize(5 * 1048576), '5.0 MB')
  assert.equal(extensionOf('A.COR.PDF'), '.pdf');assert.equal(extensionOf('noextension'), '')
})

test('task pickers can leave out closed and resolved work', async () => {
  const { taskOptions } = await import('../src/documentDriveTargets')
  const scope: any = { clients: [{ id: 'c1', name: 'Acme' }], projects: [], items: [
    { id: 't1', title: 'Roll out', clientId: 'c1', status: 'Open' },
    { id: 's1', title: 'DRF', clientId: 'c1', parentTaskId: 't1', status: 'Resolved' },
    { id: 's2', title: 'Go-live', clientId: 'c1', parentTaskId: 't1', status: 'Open' },
    { id: 't2', title: 'Old', clientId: 'c1', status: 'Closed' },
    { id: 's3', title: 'Still open', clientId: 'c1', parentTaskId: 't2', status: 'Open' },
  ] }
  const closed = (status: string) => status === 'Resolved' || status === 'Closed'
  assert.deepEqual(taskOptions(scope, '', closed).map(row => row.id), ['t1', 's2', 's3'], 'closed work is left out; an open subtask of a closed task stays')
  assert.equal(taskOptions(scope, '').length, 5, 'without a rule nothing is left out')
})
