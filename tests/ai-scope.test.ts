import test from 'node:test'
import assert from 'node:assert/strict'
import {
  cleanScope,
  inScope,
  projectClients,
  projectsOfClient,
  requestedScope,
  scopeKey,
  singleOf,
} from '../src/features/ai/aiScope'

const projects = [
  { id: 'p1', clientId: 'c1' },
  { id: 'p2', clientId: 'c1' },
  { id: 'p3', clientId: 'c2' },
  { id: 'old' },
]
const items = [
  { clientId: 'c2', projectId: 'old' },
  { clientId: 'c2', projectId: 'p3' },
]
const owner = projectClients(projects, items)

test('projects belong to their client; older ones take the client of their tasks', () => {
  assert.equal(owner.get('p1'), 'c1')
  assert.equal(owner.get('old'), 'c2')
  assert.deepEqual(
    projectsOfClient('c2', projects, owner).map(project => project.id),
    ['p3', 'old'],
  )
})

test('nothing chosen: everything is in scope', () => {
  const match = inScope({ clientIds: [], projectIds: [] }, owner)
  assert.equal(match({ clientId: 'c9', projectId: 'x' }), true)
})

test('several clients, one narrowed to some of its projects', () => {
  const match = inScope({ clientIds: ['c1', 'c2'], projectIds: ['p1'] }, owner)
  assert.equal(match({ clientId: 'c1', projectId: 'p1' }), true)
  assert.equal(match({ clientId: 'c1', projectId: 'p2' }), false, 'c1 is narrowed to p1')
  assert.equal(match({ clientId: 'c1' }), false)
  assert.equal(match({ clientId: 'c2', projectId: 'p3' }), true, 'c2 keeps all its projects')
  assert.equal(match({ clientId: 'c2' }), true)
  assert.equal(match({ clientId: 'c3' }), false)
})

test('several projects of one client', () => {
  const match = inScope({ clientIds: ['c1'], projectIds: ['p1', 'p2'] }, owner)
  assert.equal(match({ clientId: 'c1', projectId: 'p2' }), true)
  assert.equal(match({ clientId: 'c1' }), false)
})

test('a project is kept only under its chosen client, and brings its client in', () => {
  assert.deepEqual(cleanScope({ clientIds: ['c1'], projectIds: ['p1', 'p3'] }, owner), {
    clientIds: ['c1', 'c2'],
    projectIds: ['p1', 'p3'],
  })
  assert.deepEqual(requestedScope({ clients: [{ id: 'c2' }], projects: ['p3', 'p3'] }, owner), {
    clientIds: ['c2'],
    projectIds: ['p3'],
  })
})

test('the older single client and project still work', () => {
  assert.deepEqual(requestedScope({ client: { id: 'c1' }, project: { id: 'p2' } }, owner), {
    clientIds: ['c1'],
    projectIds: ['p2'],
  })
  assert.deepEqual(requestedScope({}, owner), { clientIds: [], projectIds: [] })
})

test('a single client and project, for placing a new task', () => {
  assert.deepEqual(singleOf({ clientIds: ['c1'], projectIds: ['p1'] }), { clientId: 'c1', projectId: 'p1' })
  assert.deepEqual(singleOf({ clientIds: ['c1', 'c2'], projectIds: ['p1'] }), { clientId: '', projectId: '' })
})

test('conversations keep their old key for one client and project', () => {
  assert.equal(scopeKey('u1', { clientIds: ['c1'], projectIds: [] }), 'u1:c1:all')
  assert.equal(scopeKey('u1', { clientIds: [], projectIds: [] }), 'u1:global:all')
  assert.equal(scopeKey('u1', { clientIds: ['c2', 'c1'], projectIds: ['p3', 'p1'] }), 'u1:c1+c2:p1+p3')
})
