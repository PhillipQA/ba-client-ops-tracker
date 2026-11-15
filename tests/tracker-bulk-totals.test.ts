import assert from 'node:assert/strict'
import test from 'node:test'
import { bulkColumns, bulkUndo, bulkValue, planBulk } from '../src/features/trackers/trackerBulk'
import { normalizeColumns, type TrackerColumn, type TrackerRow } from '../src/features/trackers/trackerModel'
import {
  progressColumn,
  progressLabel,
  progressOf,
  totalKindsFor,
  totalOf,
} from '../src/features/trackers/trackerTotals'

const status: TrackerColumn = {
  id: 'c_status',
  name: 'Status',
  type: 'select',
  options: [
    { id: 'o_new', label: 'Not started', color: 'gray' },
    { id: 'o_live', label: 'Live', color: 'green' },
  ],
}
const columns: TrackerColumn[] = [
  { id: 'c_site', name: 'Site', type: 'text' },
  status,
  { id: 'c_go', name: 'Go-live', type: 'date' },
  { id: 'c_cost', name: 'Cost', type: 'number' },
  { id: 'c_ok', name: 'Signed', type: 'checkbox' },
  { id: 'c_key', name: 'Password', type: 'secret' },
]
const row = (id: string, cells: TrackerRow['cells'], extra: Partial<TrackerRow> = {}): TrackerRow => ({
  id,
  position: 0,
  cells,
  secretSet: {},
  taskId: '',
  version: 1,
  updatedAt: '',
  ...extra,
})
const rows = [
  row('a', { c_site: 'Makati', c_status: 'o_live', c_go: '2026-10-28', c_cost: 100, c_ok: true }, { taskId: 't1' }),
  row('b', { c_site: 'BGC', c_status: 'o_new', c_go: '2026-11-20', c_cost: 50 }),
  row('c', { c_site: 'Festival', c_status: 'o_new', c_go: '2026-11-22' }, { sourceKey: 'Festival' }),
  row('d', { c_site: '' }),
]
const text = (column: TrackerColumn) => (item: { cells: TrackerRow['cells'] }) => {
  const value = item.cells[column.id]
  if (column.type === 'select') return column.options?.find(option => option.id === value)?.label || ''
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : ''
}

test('bulk edit plans which rows change, which already match and which are locked', () => {
  assert.deepEqual(
    bulkColumns(columns).map(column => column.id),
    ['c_site', 'c_status', 'c_go', 'c_cost', 'c_ok'],
  )
  const locked = (item: TrackerRow) => Boolean(item.sourceKey)
  const plan = planBulk(rows, status, 'o_live', locked)
  assert.deepEqual(
    plan.change.map(item => item.id),
    ['b', 'd'],
  )
  assert.equal(plan.same, 1)
  assert.deepEqual(
    plan.locked.map(item => item.id),
    ['c'],
  )
  assert.equal(plan.withTask, 0)
  // Undo puts back what each changed row had, empty included.
  assert.deepEqual(bulkUndo(plan, status), [
    { rowId: 'b', value: 'o_new' },
    { rowId: 'd', value: '' },
  ])
  // Clearing: rows already empty are not touched.
  assert.deepEqual(
    planBulk(rows, status, '', () => false).change.map(item => item.id),
    ['a', 'b', 'c'],
  )
})

test('typed values become cell values, or an error', () => {
  assert.deepEqual(bulkValue(status, 'o_live'), { value: 'o_live' })
  assert.ok('error' in bulkValue(status, 'nope'))
  assert.deepEqual(bulkValue(columns[3], '1,250.5'), { value: 1250.5 })
  assert.ok('error' in bulkValue(columns[3], 'abc'))
  assert.deepEqual(bulkValue(columns[3], ''), { value: null })
  assert.deepEqual(bulkValue(columns[2], '2026-12-01'), { value: '2026-12-01' })
  assert.ok('error' in bulkValue(columns[2], 'next week'))
  assert.deepEqual(bulkValue(columns[4], 'true'), { value: true })
  assert.deepEqual(bulkValue(columns[4], ''), { value: false })
})

test('each column type offers its own totals, and the saved total survives a column save', () => {
  assert.deepEqual(totalKindsFor(columns[3]), ['sum', 'avg', 'min', 'max', 'filled', 'empty'])
  assert.deepEqual(totalKindsFor(status), ['options', 'filled', 'empty'])
  assert.deepEqual(totalKindsFor(columns[2]), ['range', 'filled', 'empty'])
  assert.deepEqual(totalKindsFor(columns[4]), ['checked'])
  assert.deepEqual(totalKindsFor(columns[5]), [])
  const saved = normalizeColumns([
    { ...columns[0], total: 'filled' },
    { ...status, total: 'options' },
    { ...columns[2], total: 'sum' },
    { ...columns[3], total: 'avg' },
  ])
  assert.deepEqual(
    saved.map(column => column.total),
    ['filled', 'options', undefined, 'avg'],
  )
})

test('totals summarize the rows shown', () => {
  const total = (column: TrackerColumn, kind: Parameters<typeof totalOf>[1]) =>
    totalOf(column, kind, rows, columns, text(column)).text
  assert.equal(total(columns[3], 'sum'), '150')
  assert.equal(total(columns[3], 'avg'), '75')
  assert.equal(total(columns[3], 'max'), '100')
  assert.equal(total(columns[3], 'filled'), '2 of 4')
  assert.equal(total(status, 'options'), '2 Not started · 1 Live')
  assert.equal(total(status, 'empty'), '1 of 4')
  assert.equal(total(columns[2], 'range'), 'Oct 28, 2026 – Nov 22, 2026')
  assert.equal(total(columns[4], 'checked'), '1 of 4 · 25%')
  assert.equal(total(columns[0], 'filled'), '3 of 4')
  assert.equal(totalOf(columns[3], 'sum', [], columns, text(columns[3])).text, '—')
})

test('progress counts the rows whose status says done', () => {
  assert.deepEqual(progressColumn(columns), { column: status, done: 'o_live' })
  const progress = progressOf(columns, rows)
  assert.equal(progress?.done, 1)
  assert.equal(progress?.percent, 25)
  assert.equal(progressLabel(1, 4), '1 of 4 done · 25%')
  // The "done when its tasks are done" column wins over a Status column.
  const auto: TrackerColumn = {
    id: 'c_done',
    name: 'Done',
    type: 'checkbox',
    autoDone: { done: '', undone: '' } as any,
  }
  assert.equal(progressColumn([...columns, auto])?.column.id, 'c_done')
  assert.equal(progressColumn([columns[0]]), undefined)
})
