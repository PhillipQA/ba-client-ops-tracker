import assert from 'node:assert/strict'
import test from 'node:test'
import {
  FSD_MODULES,
  FSD_SECTIONS,
  fsdExcludedModules,
  fsdSectionsForModules,
} from '../src/features/documents/fsd-model'

const ids = (modules: Parameters<typeof fsdSectionsForModules>[0]) => fsdSectionsForModules(modules).map(([id]) => id)

test('unchecked FSD modules are omitted from the section schema', () => {
  const selected = ids(['MMS Report'])
  assert.ok(selected.includes('report'))
  assert.ok(!selected.includes('mms'))
  assert.ok(!selected.includes('lynexus'))
  assert.ok(!selected.includes('pos'))
})

test('all software feature sections may be hard-excluded', () => {
  const selected = ids([])
  for (const id of ['mms', 'report', 'lynexus', 'pos'] as const) assert.ok(!selected.includes(id))
  assert.ok(selected.includes('summary'))
  assert.ok(selected.includes('functional'))
  assert.ok(selected.includes('references'))
})

test('selecting all modules preserves the complete FSD template section set', () => {
  assert.deepEqual(
    ids(FSD_MODULES),
    FSD_SECTIONS.map(([id]) => id),
  )
  assert.deepEqual(fsdExcludedModules(FSD_MODULES), [])
})

test('excluded module list is the inverse of the selected scope', () => {
  assert.deepEqual(fsdExcludedModules(['MMS Feature', 'POS Feature']), ['MMS Report', 'Lynexus Feature'])
})
