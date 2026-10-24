import test from 'node:test'
import assert from 'node:assert/strict'
import {
  VIEW_PATHS,
  atRoute,
  opensElsewhere,
  pathForRoute,
  pathForTracker,
  routeFromLocation,
  trackerIdFromPath,
  type Route,
} from '../src/app/routes'

const page = (view: Route['view']): Route => ({ view, clientId: null, projectId: null, projectClientId: null })

test('every page has its own address, and reading it back gives the same page', () => {
  const seen = new Set<string>()
  for (const [view, path] of Object.entries(VIEW_PATHS) as [Route['view'], string][]) {
    assert.ok(!seen.has(path), `${path} is used twice`)
    seen.add(path)
    assert.equal(pathForRoute(page(view)), path)
    assert.deepEqual(routeFromLocation(path), page(view))
  }
})

test('friendly names: Work Hub and Tasks', () => {
  assert.equal(routeFromLocation('/work-hub')?.view, 'inbox')
  assert.equal(routeFromLocation('/tasks/')?.view, 'items')
  assert.equal(routeFromLocation('/TASKS')?.view, 'items')
  assert.equal(routeFromLocation('/no-such-page'), null)
})

test('client and project details', () => {
  assert.equal(pathForRoute({ ...page('clients'), clientId: 'c 1' }), '/clients/c%201')
  assert.deepEqual(routeFromLocation('/clients/c%201'), { ...page('clients'), clientId: 'c 1' })
  const project: Route = { view: 'clients', clientId: 'c1', projectId: 'p1', projectClientId: 'c1' }
  assert.equal(pathForRoute(project), '/projects/p1?client=c1', 'a project wins over its client, as on screen')
  assert.deepEqual(routeFromLocation('/projects/p1', '?client=c1'), {
    view: 'projects',
    clientId: null,
    projectId: 'p1',
    projectClientId: 'c1',
  })
  assert.equal(routeFromLocation('/projects', '?client=c1')?.projectClientId, null)
})

test('the app leaves a tracker address alone when Trackers is the page', () => {
  assert.equal(atRoute('/trackers/abc', '', '/trackers'), true)
  assert.equal(atRoute('/trackers', '', '/trackers'), true)
  assert.equal(atRoute('/tasks/', '', '/tasks'), true)
  assert.equal(atRoute('/trackers/abc', '', '/tasks'), false)
  assert.equal(atRoute('/clients', '', '/clients/c1'), false)
  assert.equal(atRoute('/projects/p1', '?client=c1', '/projects/p1?client=c1'), true)
})

test('tracker addresses', () => {
  assert.equal(pathForTracker('t/1'), '/trackers/t%2F1')
  assert.equal(trackerIdFromPath('/trackers/t%2F1'), 't/1')
  assert.equal(pathForTracker(''), '/trackers')
  assert.equal(trackerIdFromPath('/trackers'), '')
  assert.equal(trackerIdFromPath('/tasks/abc'), '')
})

test('new-tab clicks', () => {
  const click = { ctrlKey: false, metaKey: false, shiftKey: false, button: 0 }
  assert.equal(opensElsewhere(click), false)
  assert.equal(opensElsewhere({ ...click, metaKey: true }), true)
  assert.equal(opensElsewhere({ ...click, button: 1 }), true)
})
