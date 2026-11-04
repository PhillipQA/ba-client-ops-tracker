import assert from 'node:assert/strict'
import test from 'node:test'
import { tourSteps, tourStorageKey } from '../src/features/onboarding/tourSteps'

const ALL = ['action', 'clients', 'projects', 'inbox', 'items', 'documents', 'trackers', 'reports', 'settings']
const ids = (steps: { id: string }[]) => steps.map(step => step.id)

test('Administrators set up the account first, then their own Gmail and calendar, then daily work', () => {
  const steps = ids(tourSteps({ isAdmin: true, modules: ALL, canWrite: true }))
  assert.equal(steps[0], 'welcome')
  assert.equal(steps.at(-1), 'done')
  for (const id of ['admin-settings', 'admin-integrations', 'admin-templates', 'admin-agents', 'admin-users'])
    assert.ok(steps.indexOf(id) < steps.indexOf('gmail'), id)
  assert.ok(steps.indexOf('gmail') < steps.indexOf('action'))
  assert.ok(steps.indexOf('calendar') < steps.indexOf('clients'))
})

test('others see only their own setup and the pages they can open', () => {
  const steps = ids(tourSteps({ isAdmin: false, modules: ['inbox', 'items'], canWrite: true }))
  assert.ok(!steps.some(id => id.startsWith('admin-')))
  assert.ok(steps.includes('gmail'))
  for (const id of ['calendar', 'action', 'documents', 'trackers', 'reports', 'clients'])
    assert.ok(!steps.includes(id), id)
  assert.ok(steps.includes('add-task'))
})

test('Viewers are not told to add tasks; every lit-up step names what to light up', () => {
  const steps = tourSteps({ isAdmin: false, modules: ALL, canWrite: false })
  assert.ok(!ids(steps).includes('add-task'))
  for (const step of steps) if (step.id !== 'welcome') assert.ok(step.target, step.id)
  assert.equal(new Set(ids(steps)).size, steps.length)
})

test('the tour is remembered per person and account', () => {
  assert.notEqual(tourStorageKey('org-a', 'u1'), tourStorageKey('org-b', 'u1'))
})
