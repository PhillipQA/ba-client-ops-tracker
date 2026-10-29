import test from 'node:test'
import assert from 'node:assert/strict'
import {
  checkNameColumns,
  describeSync,
  dropdownOf,
  mergeDropdownOptions,
  convertRowsToChoice,
  parentKeyOf,
  planSync,
  sheetIdFrom,
  sheetRowKeys,
  tabRange,
  type SyncRow,
} from '../src/features/trackers/trackerSync'
import type { TrackerColumn } from '../src/features/trackers/trackerModel'

const columns: TrackerColumn[] = [
  { id: 'c_branch', name: 'Branch #', type: 'text', synced: true },
  { id: 'c_name', name: 'Branch', type: 'text', synced: true },
  { id: 'c_live', name: 'Go-live', type: 'date', synced: true },
  { id: 'c_qty', name: 'Terminals', type: 'number', synced: true },
  {
    id: 'c_status',
    name: 'Status',
    type: 'select',
    options: [{ id: 'o1', label: 'Open', color: 'gray' }],
    synced: true,
  },
  { id: 'c_notes', name: 'Our notes', type: 'longtext' },
]
const map = { 'Branch #': 'c_branch', Branch: 'c_name', 'Go-live': 'c_live', Terminals: 'c_qty', Status: 'c_status' }
const run = (grid: string[][], rows: SyncRow[] = [], capacity = 5000) =>
  planSync({ grid, keyHeader: 'Branch #', headerMap: map, columns, rows, people: [], today: '2026-10-24', capacity })

test('links and ids are read from what people paste', () => {
  assert.equal(
    sheetIdFrom('https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit#gid=0'),
    '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789',
  )
  assert.equal(sheetIdFrom('1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'), '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789')
  assert.equal(sheetIdFrom('https://example.com/not-a-sheet'), '')
  assert.equal(tabRange("Branch's list"), "'Branch''s list'")
})

test('a first sync adds every non-empty row, converting values like an import', () => {
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
  assert.equal(plan.inserts.length, 4, 'the row with no name and the repeated name come in too')
  assert.deepEqual(
    plan.inserts.map(insert => insert.key),
    ['57', '58', '58\u001e1', '57\u001f2'],
    'the blank row belongs to 58 above it; the second 57 is its own row',
  )
  assert.deepEqual(plan.inserts[0].cells, {
    c_branch: '57',
    c_name: 'Batch 5',
    c_live: '2026-11-25',
    c_qty: 3,
    c_status: 'o1',
  })
  assert.equal(plan.inserts[0].values['Go-live'], '11/25/2026', 'the raw Sheet values are kept for two-way later')
  const scheduled = plan.columns.find(c => c.id === 'c_status')!.options!.find(o => o.label === 'Scheduled')
  assert.ok(scheduled && plan.columnsChanged, 'a new Select option is added')
  assert.equal(plan.inserts[1].cells.c_status, scheduled!.id)
  assert.equal(plan.report.skippedNoKey, 0)
  assert.deepEqual(plan.report.duplicateKeys, [])
  assert.deepEqual(plan.report.newHeaders, ['Extra'])
  assert.equal(describeSync(plan.report), '4 new rows')
})

test('later syncs match rows by key, update only changed cells, and flag rows that left the Sheet', () => {
  const rows: SyncRow[] = [
    {
      id: 'r57',
      sourceKey: '57',
      data: { c_branch: '57', c_name: 'Batch 5', c_live: '2026-11-25', c_qty: 3, c_status: 'o1', c_notes: 'kept' },
      values: {},
      missing: false,
    },
    { id: 'r58', sourceKey: '58', data: { c_branch: '58', c_name: 'Sta. Rosa' }, values: {}, missing: false },
    { id: 'r59', sourceKey: '59', data: { c_branch: '59' }, values: {}, missing: true },
    { id: 'manual', sourceKey: '', data: { c_name: 'Added in the tracker' }, values: {}, missing: false },
  ]
  const plan = run(
    [
      ['Status', 'Terminals', 'Go-live', 'Branch', 'Branch #'],
      ['Open', '4', '11/25/2026', 'Batch 5', '57'],
      ['', '', '', 'Calamba', '60'],
      ['', '', '', '', '59'],
    ],
    rows,
  )
  if ('error' in plan) return assert.fail(plan.error)
  assert.deepEqual(
    plan.updates.find(u => u.id === 'r57')!.cells,
    { c_qty: 4 },
    'only the changed cell is written; columns may be reordered',
  )
  assert.equal(plan.inserts.length, 1)
  assert.equal(plan.inserts[0].key, '60')
  assert.deepEqual(
    plan.missing,
    ['r58'],
    'a row missing from the Sheet is flagged, not deleted; manual rows are left alone',
  )
  assert.deepEqual(plan.returned, ['r59'])
  assert.equal(plan.report.updated, 1)
  assert.equal(plan.report.returned, 1)
})

test('a missing key column, an empty tab and the row limit are reported', () => {
  assert.match(
    (
      run([
        ['Branch', 'Status'],
        ['A', 'B'],
      ]) as any
    ).error,
    /key column/,
  )
  assert.match((run([]) as any).error, /empty/)
  const capped = run([['Branch #'], ['1'], ['2'], ['3']], [], 2)
  if ('error' in capped) return assert.fail(capped.error)
  assert.equal(capped.inserts.length, 2)
  assert.equal(capped.report.capped, 1)
  const gone = run([
    ['Branch #', 'Branch'],
    ['1', 'A'],
  ])
  if ('error' in gone) return assert.fail(gone.error)
  assert.deepEqual(gone.report.missingHeaders.sort(), ['Go-live', 'Status', 'Terminals'])
})

test('row keys: names may repeat, and rows with a blank name belong to the task above', () => {
  const keys = sheetRowKeys(['', 'EGG', '', '', 'PUMA', '', 'egg', '', 'EGG\u001f2'])
  assert.deepEqual(keys, [
    '\u001e1',
    'EGG',
    'EGG\u001e1',
    'EGG\u001e2',
    'PUMA',
    'PUMA\u001e1',
    'egg\u001f2',
    'egg\u001f2\u001e1',
    'EGG\u001f2\u001f2',
  ])
  assert.equal(new Set(keys.map(key => key.toLowerCase())).size, keys.length, 'every key is unique')
  assert.equal(parentKeyOf('EGG'), null, 'a named row is a task')
  assert.equal(parentKeyOf('EGG\u001e2'), 'EGG')
  assert.equal(parentKeyOf('egg\u001f2\u001e1'), 'egg\u001f2')
  assert.equal(parentKeyOf('\u001e1'), '', 'a row above the first name has no task')
})

test('later syncs recognise each row by name and order, so other rows can be inserted or sorted', () => {
  const grid = [
    ['Branch #', 'Branch', 'Go-live', 'Terminals', 'Status'],
    ['EGG', 'First', '', '', ''],
    ['', 'Under first', '', '', ''],
    ['EGG', 'Second', '', '', ''],
  ]
  const first = run(grid)
  assert.ok(!('error' in first))
  if ('error' in first) return
  const rows: SyncRow[] = first.inserts.map((insert, at) => ({
    id: `r${at}`,
    sourceKey: insert.key,
    data: insert.cells,
    values: insert.values,
    missing: false,
  }))
  const moved = run([grid[0], ['PUMA', 'New', '', '', ''], ...grid.slice(1)], rows)
  assert.ok(!('error' in moved))
  if ('error' in moved) return
  assert.deepEqual(
    moved.inserts.map(insert => insert.key),
    ['PUMA'],
    'only the new task comes in; the EGG rows keep their tracker rows',
  )
  assert.equal(moved.updates.filter(update => Object.keys(update.cells).length).length, 0, 'no row changed')
  assert.equal(moved.report.missing, 0)
})

test('task name check: tasks, rows under them, rows above the first name, repeated names', () => {
  const headers = ['Client', 'Git #']
  const rows = [
    ['', '100'],
    ['EGG', ''],
    ['', '101'],
    ['', ''],
    ['PUMA', ''],
    ['egg', '102'],
  ]
  const [client, git] = checkNameColumns(headers, rows)
  assert.deepEqual(client, { header: 'Client', tasks: 3, under: 1, beforeFirst: 1, repeated: 1 })
  assert.deepEqual(git, { header: 'Git #', tasks: 3, under: 2, beforeFirst: 0, repeated: 0 })
})

test('Sheet dropdowns: lists and ranges are read, and their choices merged into Choice columns', () => {
  assert.deepEqual(
    dropdownOf({
      condition: { type: 'ONE_OF_LIST', values: [{ userEnteredValue: 'Pending' }, { userEnteredValue: ' ' }] },
    }),
    { list: ['Pending'] },
  )
  assert.deepEqual(
    dropdownOf({ condition: { type: 'ONE_OF_RANGE', values: [{ userEnteredValue: '=Lists!$A$1:$A$9' }] } }),
    {
      range: 'Lists!A1:A9',
    },
  )
  assert.equal(dropdownOf({ condition: { type: 'BOOLEAN' } }), null)
  assert.equal(dropdownOf(undefined), null)
  const merged = mergeDropdownOptions(columns, map, { Status: ['Pending', 'open', 'Done'], Branch: ['x'] })
  assert.equal(merged.changed, true)
  const status = merged.columns.find(column => column.id === 'c_status')!
  assert.deepEqual(
    status.options!.map(option => option.label),
    ['Pending', 'Open', 'Done'],
    'an existing option keeps its own label and id',
  )
  assert.equal(status.options![1].id, 'o1')
  const branch = merged.columns.find(column => column.id === 'c_name')!
  assert.equal(branch.type, 'select', 'a text column that follows a Sheet dropdown becomes a Choice column')
  assert.deepEqual(
    branch.options!.map(option => option.label),
    ['x'],
  )
  assert.deepEqual(merged.converted, ['c_name'])
  assert.equal(
    mergeDropdownOptions(columns, map, { Status: ['Open'] }).columns.find(column => column.id === 'c_name'),
    columns[1],
    'text columns without a dropdown are left alone',
  )
  const again = mergeDropdownOptions(merged.columns, map, { Status: ['Pending', 'Open', 'Done'], Branch: ['x'] })
  assert.equal(again.changed, false, 'nothing changes when the options already match')
})

test('values already in a text column move to the dropdown options when it becomes a Choice column', () => {
  const merged = mergeDropdownOptions(columns, map, { Branch: ['Pending', 'Ongoing', 'Done'] })
  const moved = convertRowsToChoice(merged.columns, merged.converted, [
    { id: 'r1', data: { c_name: 'done' } },
    { id: 'r2', data: { c_name: 'Blocked' } },
    { id: 'r3', data: { c_name: '' } },
  ])
  const options = moved.columns.find(column => column.id === 'c_name')!.options!
  assert.deepEqual(
    options.map(option => option.label),
    ['Pending', 'Ongoing', 'Done', 'Blocked'],
  )
  assert.equal(moved.changes.get('r1')!.c_name, options[2].id)
  assert.equal(moved.changes.get('r2')!.c_name, options[3].id, 'a value the dropdown lacks is kept as a new option')
  assert.equal(moved.changes.get('r3')!.c_name, '')
})

test('a Checkbox column that follows a Sheet dropdown becomes a Choice column, ticked boxes become Done', () => {
  const boxes: TrackerColumn[] = [
    { id: 'c_key', name: 'Branch #', type: 'text', synced: true },
    { id: 'c_cor', name: 'COR', type: 'checkbox', synced: true, autoDone: {} },
    { id: 'c_drf', name: 'DRF', type: 'checkbox', synced: true },
  ]
  const lists = { COR: ['Pending', 'Ongoing', 'Done'], DRF: ['Pending', 'Ongoing', 'Done'] }
  const merged = mergeDropdownOptions(boxes, { 'Branch #': 'c_key', COR: 'c_cor', DRF: 'c_drf' }, lists)
  assert.deepEqual(merged.converted, ['c_cor', 'c_drf'])
  const cor = merged.columns.find(column => column.id === 'c_cor')!
  assert.equal(cor.type, 'select')
  const id = (label: string) => cor.options!.find(option => option.label === label)!.id
  assert.deepEqual(cor.autoDone, { done: id('Done'), undone: id('Pending') }, 'done-when-tasks-done keeps working')
  assert.equal(merged.columns.find(column => column.id === 'c_drf')!.autoDone, undefined)
  const moved = convertRowsToChoice(merged.columns, merged.converted, [
    { id: 'r1', data: { c_cor: true, c_drf: false } },
  ])
  const drf = moved.columns.find(column => column.id === 'c_drf')!
  assert.deepEqual(moved.changes.get('r1'), {
    c_cor: id('Done'),
    c_drf: '',
  })
  assert.equal(drf.options!.length, 3, 'no options are added for ticked or unticked boxes')
})
