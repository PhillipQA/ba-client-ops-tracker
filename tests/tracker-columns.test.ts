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

test('a Link cell can carry a short label that is shown instead of the address', async () => {
  const { cleanCell, parseLink, linkToInput } = await import('../src/trackerModel')
  const column = { id: 'c_l', name: 'Ticket', type: 'link' as const }
  const typed = cleanCell(column, '#1234 https://git.example.com/acme/app/issues/1234')
  assert.deepEqual(typed, { ok: true, value: '[#1234](https://git.example.com/acme/app/issues/1234)' })
  assert.deepEqual(parseLink('[#1234](https://git.example.com/acme/app/issues/1234)'), { label: '#1234', href: 'https://git.example.com/acme/app/issues/1234' })
  assert.equal(linkToInput('[#1234](https://git.example.com/a)'), '#1234 https://git.example.com/a')
  // The stored form is accepted as typed, and a plain address is unchanged.
  assert.deepEqual(cleanCell(column, '[Login bug](https://git.example.com/a/1)'), { ok: true, value: '[Login bug](https://git.example.com/a/1)' })
  assert.deepEqual(cleanCell(column, 'git.example.com/a/1'), { ok: true, value: 'https://git.example.com/a/1' })
  assert.deepEqual(cleanCell(column, 'https://git.example.com/a/1'), { ok: true, value: 'https://git.example.com/a/1' })
})

test('a Link cell still rejects anything that is not a web address', async () => {
  const { cleanCell } = await import('../src/trackerModel')
  const column = { id: 'c_l', name: 'Ticket', type: 'link' as const }
  for (const bad of ['javascript:alert(1)', '#1234 javascript:alert(1)', '[x](javascript:alert(1))', '[x](data:text/html,hi)', 'just words', 'ftp://example.com/file']) {
    assert.equal(cleanCell(column, bad).ok, false, bad)
  }
})
