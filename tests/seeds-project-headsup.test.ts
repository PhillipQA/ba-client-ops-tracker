import assert from 'node:assert/strict'
import test from 'node:test'
import { SEEDS_NEW_DAYS, trackersForProject, unplacedSeedsProjects } from '../src/features/trackers/seedsRows'
import { newProjectAlerts } from '../src/features/ai/watch'

const NOW = Date.parse('2026-11-14T02:00:00Z')
const ago = (days: number) => new Date(NOW - days * 86_400_000).toISOString()
const project = (id: string, extra: any = {}) => ({
  id,
  name: `Store ${id}`,
  seedsId: `s-${id}`,
  clientId: 'c1',
  seedsAddedAt: ago(1),
  ...extra,
})
const text = { id: 'col', name: 'Branch', type: 'text' }
const tracker = (id: string, extra: any = {}) => ({
  id,
  name: `Tracker ${id}`,
  client_id: 'c1',
  project_id: '',
  archived_at: null,
  template: '',
  columns: [text],
  ...extra,
})
const columnsOf = (row: any) => row.columns

test('only projects Seeds brought in lately, open, visible and on no tracker are offered', () => {
  const state = {
    projects: [
      project('new'),
      project('placed'),
      project('old', { seedsAddedAt: ago(SEEDS_NEW_DAYS + 1) }),
      project('undated', { seedsAddedAt: undefined }),
      project('done', { seedsArchived: true }),
      project('before', { beforeSeeds: true }),
      project('noclient', { clientId: '' }),
      project('hidden'),
      { id: 'local', name: 'Not from Seeds', clientId: 'c1', seedsAddedAt: ago(1) },
      project('newer', { seedsAddedAt: ago(0.1), contractNumber: ' C-9 ' }),
    ],
  }
  const trackers = [tracker('t1', { project_id: 'x,placed' })]
  const offered = unplacedSeedsProjects(state, trackers, NOW, entry => entry.id !== 'hidden')
  assert.deepEqual(
    offered.map(entry => entry.id),
    ['newer', 'new'],
    'Newest first',
  )
  assert.equal(offered[0].contractNumber, 'C-9')
  assert.deepEqual(unplacedSeedsProjects({}, [], NOW), [])
})

test('a project can go on its client’s trackers that can name a row, rollout trackers first', () => {
  const trackers = [
    tracker('plain'),
    tracker('rollout', { template: 'site-rollout' }),
    tracker('other-client', { client_id: 'c2' }),
    tracker('archived', { archived_at: '2026-11-01T00:00:00Z' }),
    tracker('has-it', { project_id: 'p1' }),
    tracker('no-name', { columns: [{ id: 'd', name: 'Date', type: 'date' }] }),
    tracker('two-clients', { client_id: 'c2,c1' }),
  ]
  const fits = trackersForProject(trackers, { id: 'p1', clientId: 'c1' }, columnsOf)
  assert.deepEqual(
    fits.map(entry => entry.id),
    ['rollout', 'plain', 'two-clients'],
  )
})

test('a new project is a heads-up with a button for each tracker it could go on', () => {
  const [withTrackers, without] = newProjectAlerts([
    {
      id: 'p1',
      name: 'Makati T1',
      clientName: 'Goldwing',
      contractNumber: 'C-9',
      addedAt: ago(1),
      trackers: [
        { id: 't1', name: 'Goldwing rollout' },
        { id: 't2', name: 'Goldwing issues' },
      ],
    },
    { id: 'p2', name: 'Cebu', addedAt: ago(2), trackers: [] },
  ])
  assert.equal(withTrackers.key, 'seeds-project:p1')
  assert.equal(withTrackers.title, 'New Seeds project for Goldwing: Makati T1')
  assert.match(withTrackers.detail, /Contract C-9/)
  assert.deepEqual(
    withTrackers.actions?.map(action => [action.label, action.addToTracker]),
    [
      ['Add to Goldwing rollout', { trackerId: 't1', projectId: 'p1' }],
      ['Add to Goldwing issues', { trackerId: 't2', projectId: 'p1' }],
    ],
  )
  assert.deepEqual(without.actions, [])
  assert.match(without.detail, /No tracker for this client/)
  assert.match(without.ask, /Create a Site rollout tracker/)
})
