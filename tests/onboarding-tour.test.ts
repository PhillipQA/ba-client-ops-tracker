import assert from 'node:assert/strict'
import test from 'node:test'
import { tourSteps, tourStorageKey } from '../src/features/onboarding/tourSteps'

const ALL = ['action', 'clients', 'projects', 'inbox', 'items', 'documents', 'trackers', 'reports', 'ai', 'settings']
const ids = (steps: { id: string }[]) => steps.map(step => step.id)

test('the tour follows a working day: Action Center to Settings, with account setup last for Administrators', () => {
  const steps = ids(tourSteps({ isAdmin: true, modules: ALL, canWrite: true }))
  assert.deepEqual(steps, [
    'welcome',
    'action',
    'action-customize',
    'calendar',
    'workhub',
    'gmail',
    'discord',
    'gitlab',
    'trackers',
    'documents',
    'reports',
    'reports-jarvis',
    'ai',
    'settings',
    'admin-integrations',
    'admin-templates',
    'admin-users',
    'done',
  ])
})

test('others see only the pages they can open, and no account setup', () => {
  const steps = ids(tourSteps({ isAdmin: false, modules: ['inbox', 'items', 'trackers'], canWrite: true }))
  assert.deepEqual(steps, ['welcome', 'workhub', 'gmail', 'discord', 'gitlab', 'trackers', 'done'])
  const withSettings = ids(tourSteps({ isAdmin: false, modules: ['settings'], canWrite: true }))
  assert.deepEqual(withSettings, ['welcome', 'settings', 'done'])
})

test('Viewers are not told to add, send or void; every lit-up step names what to light up', () => {
  const steps = tourSteps({ isAdmin: false, modules: ALL, canWrite: false })
  const text = JSON.stringify(steps)
  for (const phrase of ['turn it into a new one', 'Allow sending email', 'Void a request', 'Draft a tracker'])
    assert.ok(!text.includes(phrase), phrase)
  for (const step of steps) if (step.id !== 'welcome') assert.ok(step.target, step.id)
  assert.equal(new Set(ids(steps)).size, steps.length)
})

test('each page step opens its page; Work Hub steps show their own tab', () => {
  const steps = tourSteps({ isAdmin: true, modules: ALL, canWrite: true })
  const step = (id: string) => steps.find(candidate => candidate.id === id)!
  for (const [id, view] of [
    ['action', 'action'],
    ['workhub', 'inbox'],
    ['trackers', 'trackers'],
    ['documents', 'documents'],
    ['reports', 'reports'],
    ['ai', 'ai'],
    ['settings', 'settings'],
  ])
    assert.equal(step(id).view, view, id)
  assert.equal(step('gmail').click, '[data-tour="workhub-tab-Gmail"]')
  assert.equal(step('discord').click, '[data-tour="workhub-tab-Discord"]')
  assert.equal(step('gitlab').click, '[data-tour="workhub-tab-GitHub"]')
})

test('the tour is remembered per person and account', () => {
  assert.notEqual(tourStorageKey('org-a', 'u1'), tourStorageKey('org-b', 'u1'))
})

test('Jarvis in Reports is shown to people who can use it; Viewers are not told to build', () => {
  const viewer = ids(tourSteps({ isAdmin: false, modules: ALL, canWrite: false }))
  assert.ok(!viewer.includes('reports-jarvis'))
  assert.ok(viewer.includes('action-customize'))
  const noAi = ids(tourSteps({ isAdmin: false, modules: ['reports'], canWrite: true }))
  assert.deepEqual(noAi, ['welcome', 'reports', 'done'])
})
