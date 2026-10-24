import test from 'node:test'
import assert from 'node:assert/strict'
import { describeSync, planSync, sheetIdFrom, tabRange, type SyncRow } from '../src/trackerSync'
import type { TrackerColumn } from '../src/trackerModel'

const columns: TrackerColumn[] = [
  { id: 'c_branch', name: 'Branch #', type: 'text', synced: true },
  { id: 'c_name', name: 'Branch', type: 'text', synced: true },
  { id: 'c_live', name: 'Go-live', type: 'date', synced: true },
  { id: 'c_qty', name: 'Terminals', type: 'number', synced: true },
  { id: 'c_status', name: 'Status', type: 'select', options: [{ id: 'o1', label: 'Open', color: 'gray' }], synced: true },
  { id: 'c_notes', name: 'Our notes', type: 'longtext' },
]
const map = { 'Branch #': 'c_branch', Branch: 'c_name', 'Go-live': 'c_live', Terminals: 'c_qty', Status: 'c_status' }
const run = (grid: string[][], rows: SyncRow[] = [], capacity = 5000) => planSync({ grid, keyHeader: 'Branch #', headerMap: map, columns, rows, people: [], today: '2026-10-24', capacity })

test('links and ids are read from what people paste', () => {
  assert.equal(sheetIdFrom('https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit#gid=0'), '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789')
  assert.equal(sheetIdFrom('1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'), '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789')
  assert.equal(sheetIdFrom('https://example.com/not-a-sheet'), '')
  assert.equal(tabRange("Branch's list"), "'Branch''s list'")
})

test('a first sync adds every row with a key, converting values like an import', () => {
  const plan = run([
    ['Branch #', 'Branch', 'Go-live', 'Terminals', 'Status', 'Extra'],
    ['57', 'Batch 5', '11/25/2026', '3', 'Open', 'x'],
    ['58', 'Sta. Rosa', '2026-12-01', '2', 'Scheduled', ''],
    ['', 'No key', '', '', '', ''],
    ['57', 'Repeat', '', '', '', ''],
    ['', '', '', '', '', ''],
  ])
  assert.ok(!('error' in plan))
  if ('error' in plan) return
  assert.equal(plan.inserts.length, 2)
  assert.deepEqual(plan.inserts[0].cells, { c_branch: '57', c_name: 'Batch 5', c_live: '2026-11-25', c_qty: 3, c_status: 'o1' })
  assert.equal(plan.inserts[0].values['Go-live'], '11/25/2026', 'the raw Sheet values are kept for two-way later')
  const scheduled = plan.columns.find(c => c.id === 'c_status')!.options!.find(o => o.label === 'Scheduled')
  assert.ok(scheduled && plan.columnsChanged, 'a new Select option is added')
  assert.equal(plan.inserts[1].cells.c_status, scheduled!.id)
  assert.equal(plan.report.skippedNoKey, 1); assert.deepEqual(plan.report.duplicateKeys, ['57'])
  assert.deepEqual(plan.report.newHeaders, ['Extra'])
  assert.equal(describeSync(plan.report), '2 new rows')
})

test('later syncs match rows by key, update only changed cells, and flag rows that left the Sheet', () => {
  const rows: SyncRow[] = [
    { id: 'r57', sourceKey: '57', data: { c_branch: '57', c_name: 'Batch 5', c_live: '2026-11-25', c_qty: 3, c_status: 'o1', c_notes: 'kept' }, values: {}, missing: false },
    { id: 'r58', sourceKey: '58', data: { c_branch: '58', c_name: 'Sta. Rosa' }, values: {}, missing: false },
    { id: 'r59', sourceKey: '59', data: { c_branch: '59' }, values: {}, missing: true },
    { id: 'manual', sourceKey: '', data: { c_name: 'Added in the tracker' }, values: {}, missing: false },
  ]
  const plan = run([
    ['Status', 'Terminals', 'Go-live', 'Branch', 'Branch #'],
    ['Open', '4', '11/25/2026', 'Batch 5', '57'],
    ['', '', '', 'Calamba', '60'],
    ['', '', '', '', '59'],
  ], rows)
  if ('error' in plan) return assert.fail(plan.error)
  assert.deepEqual(plan.updates.find(u => u.id === 'r57')!.cells, { c_qty: 4 }, 'only the changed cell is written; columns may be reordered')
  assert.equal(plan.inserts.length, 1); assert.equal(plan.inserts[0].key, '60')
  assert.deepEqual(plan.missing, ['r58'], 'a row missing from the Sheet is flagged, not deleted; manual rows are left alone')
  assert.deepEqual(plan.returned, ['r59'])
  assert.equal(plan.report.updated, 1); assert.equal(plan.report.returned, 1)
})

test('a missing key column, an empty tab and the row limit are reported', () => {
  assert.match((run([['Branch', 'Status'], ['A', 'B']]) as any).error, /key column/)
  assert.match((run([]) as any).error, /empty/)
  const capped = run([['Branch #'], ['1'], ['2'], ['3']], [], 2)
  if ('error' in capped) return assert.fail(capped.error)
  assert.equal(capped.inserts.length, 2); assert.equal(capped.report.capped, 1)
  const gone = run([['Branch #', 'Branch'], ['1', 'A']])
  if ('error' in gone) return assert.fail(gone.error)
  assert.deepEqual(gone.report.missingHeaders.sort(), ['Go-live', 'Status', 'Terminals'])
})
