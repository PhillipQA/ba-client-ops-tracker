import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isFrozenColumn, normalizeColumns } from '../src/trackerModel'

const base = [{ name: 'Branch', type: 'text' }, { name: 'Address', type: 'text' }, { name: 'Units', type: 'number' }]

test('width, alignment and freezing are kept when columns are saved', () => {
  const first = normalizeColumns(base)
  const next = normalizeColumns(first.map(column => column.name === 'Address' ? { ...column, width: 520, align: 'center', frozen: true } : column), first)
  const address = next.find(column => column.name === 'Address')!
  assert.equal(address.width, 520)
  assert.equal(address.align, 'center')
  assert.equal(address.frozen, true)
})

test('unknown alignment is dropped and width stays within limits', () => {
  const columns = normalizeColumns([{ name: 'A', type: 'text', align: 'justify', width: 5000 }, { name: 'B', type: 'text', width: 10 }])
  assert.equal(columns[0].align, undefined)
  assert.equal(columns[0].width, 800)
  assert.equal(columns[1].width, 60)
})

test('only the first column is frozen until someone chooses otherwise', () => {
  const columns = normalizeColumns(base)
  assert.deepEqual(columns.map(column => isFrozenColumn(column, columns)), [true, false, false])
  const changed = normalizeColumns(columns.map((column, at) => at === 0 ? { ...column, frozen: false } : at === 2 ? { ...column, frozen: true } : column), columns)
  assert.deepEqual(changed.map(column => isFrozenColumn(column, changed)), [false, false, true])
})
