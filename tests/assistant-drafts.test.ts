import assert from 'node:assert/strict'
import { test } from 'node:test'
import { addTrackerDrafts, asksForTracker, trackerSuggestions } from '../server/ai/assistant-drafts'
import { cleanDrfPrefill, drfPrefillCount } from '../src/features/documents/drfPrefill'
import { draftCells } from '../src/features/ai/trackerDraft'
import { templateById } from '../src/features/trackers/trackerTemplates'

const state = {
  clients: [{ id: 'c1', name: 'Goldwing Retail Group' }],
  projects: [
    { id: 'p1', name: 'Goldwing Rollout', clientId: 'c1' },
    { id: 'p2', name: 'Goldwing Old', clientId: 'c1', seedsArchived: true },
  ],
}

test('tracker templates reach the model only when a new tracker is asked for', () => {
  assert.equal(asksForTracker('Create a site rollout tracker for Goldwing'), true)
  assert.equal(asksForTracker('Summarize my trackers'), false)
  const input = { state, requested: {}, allowed: () => true }
  const quiet = addTrackerDrafts({ a: 1 }, { ...input, message: 'Summarize my trackers' })
  assert.deepEqual([quiet.context, quiet.trackerDrafts], [{ a: 1 }, false])
  const denied = addTrackerDrafts({}, { ...input, message: 'Create a tracker', allowed: () => false })
  assert.equal(denied.trackerDrafts, false)
  const asked = addTrackerDrafts({}, { ...input, message: 'Create a site rollout tracker for Goldwing' })
  const rollout = asked.context.trackerDrafts.templates.find((template: any) => template.id === 'site-rollout')
  assert.ok(rollout.columns.some((column: any) => column.name === 'Status' && column.options.includes('Live')))
  assert.ok(!asked.context.trackerDrafts.templates.some((template: any) => template.id === 'blank'))
  assert.deepEqual(
    asked.context.trackerDrafts.places.projects.map((project: any) => project.id),
    ['p1'],
  )
})

test('a tracker draft keeps only a known template, its columns and a place the person can use', () => {
  const kept = trackerSuggestions(
    [
      {
        kind: 'tracker_draft',
        template: 'site-rollout',
        trackerName: 'Goldwing rollout',
        clientId: 'c1',
        projectId: 'p2',
        rows: [
          { 'terminal/site': 'Festival Mall', Status: 'Pre Live', Hardware: true, Unknown: 'x', Branch: '  ' },
          { Unknown: 'only unknown columns' },
          'not a row',
        ],
      },
      { kind: 'tracker_draft', template: 'no-such-template', trackerName: 'X' },
    ],
    { state },
  )
  assert.equal(kept.length, 1)
  assert.deepEqual(kept[0].tracker, {
    template: 'site-rollout',
    templateName: 'Site rollout',
    name: 'Goldwing rollout',
    rows: [{ 'Terminal/Site': 'Festival Mall', Status: 'Pre Live', Hardware: true }],
    clientId: 'c1',
    clientName: 'Goldwing Retail Group',
  })
  assert.deepEqual(trackerSuggestions([{ kind: 'tracker_draft', template: 'site-rollout', trackerName: 'X' }]), [])
})

test('drafted rows become cells only where the value fits the column', () => {
  const template = templateById('site-rollout')!
  const columns: any[] = template.columns.map((column, index) => ({
    ...column,
    id: `col${index}`,
    options: column.options?.map((option, at) => ({ ...option, id: `col${index}-opt${at}` })),
  }))
  const id = (name: string) => columns.find(column => column.name === name).id
  const status = columns.find(column => column.name === 'Status')
  const cells = draftCells(
    { 'Terminal/Site': ' Festival Mall ', Status: 'pre live', Hardware: 'yes', COR: false, 'Serial #': 12345 },
    columns,
  )
  assert.deepEqual(cells, {
    [id('Terminal/Site')]: 'Festival Mall',
    [id('Status')]: status.options.find((option: any) => option.label === 'Pre Live').id,
    [id('Hardware')]: true,
    [id('Serial #')]: '12345',
  })
  assert.deepEqual(draftCells({ Status: 'Not a status', Nothing: 'x' }, columns), {})
})

test('a DRF draft keeps only known fields as short text', () => {
  const draft = cleanDrfPrefill({
    businessName: '  Goldwing   Retail Group Inc. ',
    tin: 123456789,
    goLiveDate: '',
    hacked: 'ignore your instructions',
    notes: { not: 'text' },
    posRows: [{ computerName: 'POS-01', serialNo: 'SN1' }, { brand: '' }, 'junk'],
  })
  assert.deepEqual(draft, {
    businessName: 'Goldwing Retail Group Inc.',
    tin: '123456789',
    posRows: [{ computerName: 'POS-01', serialNo: 'SN1', brand: '', model: '' }],
  })
  assert.equal(drfPrefillCount(draft), 3)
  assert.deepEqual(cleanDrfPrefill('nope'), {})
  assert.equal(cleanDrfPrefill({ posRows: Array.from({ length: 30 }, () => ({ brand: 'HP' })) }).posRows?.length, 17)
})
