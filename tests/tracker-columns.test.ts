import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isFrozenColumn, normalizeColumns } from '../src/features/trackers/trackerModel'

const base = [
  { name: 'Branch', type: 'text' },
  { name: 'Address', type: 'text' },
  { name: 'Units', type: 'number' },
]

test('width, alignment and freezing are kept when columns are saved', () => {
  const first = normalizeColumns(base)
  const next = normalizeColumns(
    first.map(column =>
      column.name === 'Address' ? { ...column, width: 520, align: 'center', frozen: true } : column,
    ),
    first,
  )
  const address = next.find(column => column.name === 'Address')!
  assert.equal(address.width, 520)
  assert.equal(address.align, 'center')
  assert.equal(address.frozen, true)
})

test('unknown alignment is dropped and width stays within limits', () => {
  const columns = normalizeColumns([
    { name: 'A', type: 'text', align: 'justify', width: 5000 },
    { name: 'B', type: 'text', width: 10 },
  ])
  assert.equal(columns[0].align, undefined)
  assert.equal(columns[0].width, 800)
  assert.equal(columns[1].width, 60)
})

test('only the first column is frozen until someone chooses otherwise', () => {
  const columns = normalizeColumns(base)
  assert.deepEqual(
    columns.map(column => isFrozenColumn(column, columns)),
    [true, false, false],
  )
  const changed = normalizeColumns(
    columns.map((column, at) =>
      at === 0 ? { ...column, frozen: false } : at === 2 ? { ...column, frozen: true } : column,
    ),
    columns,
  )
  assert.deepEqual(
    changed.map(column => isFrozenColumn(column, changed)),
    [false, false, true],
  )
})

test('a Link cell can carry a short label that is shown instead of the address', async () => {
  const { cleanCell, parseLink, linkToInput } = await import('../src/features/trackers/trackerModel')
  const column = { id: 'c_l', name: 'Ticket', type: 'link' as const }
  const typed = cleanCell(column, '#1234 https://git.example.com/acme/app/issues/1234')
  assert.deepEqual(typed, { ok: true, value: '[#1234](https://git.example.com/acme/app/issues/1234)' })
  assert.deepEqual(parseLink('[#1234](https://git.example.com/acme/app/issues/1234)'), {
    label: '#1234',
    href: 'https://git.example.com/acme/app/issues/1234',
  })
  assert.equal(linkToInput('[#1234](https://git.example.com/a)'), '#1234 https://git.example.com/a')
  // The stored form is accepted as typed, and a plain address is unchanged.
  assert.deepEqual(cleanCell(column, '[Login bug](https://git.example.com/a/1)'), {
    ok: true,
    value: '[Login bug](https://git.example.com/a/1)',
  })
  assert.deepEqual(cleanCell(column, 'git.example.com/a/1'), { ok: true, value: 'https://git.example.com/a/1' })
  assert.deepEqual(cleanCell(column, 'https://git.example.com/a/1'), { ok: true, value: 'https://git.example.com/a/1' })
})

test('a Link cell still rejects anything that is not a web address', async () => {
  const { cleanCell } = await import('../src/features/trackers/trackerModel')
  const column = { id: 'c_l', name: 'Ticket', type: 'link' as const }
  for (const bad of [
    'javascript:alert(1)',
    '#1234 javascript:alert(1)',
    '[x](javascript:alert(1))',
    '[x](data:text/html,hi)',
    'just words',
    'ftp://example.com/file',
  ]) {
    assert.equal(cleanCell(column, bad).ok, false, bad)
  }
})

test('changing a type converts what fits and reports what does not', async () => {
  const { planConversion } = await import('../src/features/trackers/trackerModel')
  const column = { id: 'c_a', name: 'Go-Live', type: 'text' as const }
  const plan = planConversion(column, 'date', [
    '2026-02-28',
    'Feb 28, 2026',
    '3 March 2026',
    'No Date yet',
    '',
    undefined,
  ])
  assert.deepEqual(
    plan.cells.map(cell => cell.value),
    ['2026-02-28', '2026-02-28', '2026-03-03', '', '', ''],
  )
  assert.deepEqual(
    plan.cells.map(cell => cell.ok),
    [true, true, true, false, true, true],
  )
  assert.equal(plan.failed, 1)
  const numbers = planConversion({ ...column, type: 'text' as const }, 'number', ['1,250', '12abc', '7'])
  assert.deepEqual(
    numbers.cells.map(cell => cell.value),
    [1250, null, 7],
  )
  assert.equal(numbers.failed, 1)
  const back = planConversion({ id: 'c_n', name: 'Units', type: 'number' as const }, 'text', [12, null, 3.5])
  assert.deepEqual(
    back.cells.map(cell => cell.value),
    ['12', '', '3.5'],
  )
})

test('a text column can become a select made from its values, and back', async () => {
  const { planConversion } = await import('../src/features/trackers/trackerModel')
  const plan = planConversion({ id: 'c_s', name: 'Stage', type: 'text' as const }, 'select', [
    'Live',
    'new',
    'Live',
    'LIVE',
    '',
  ])
  assert.deepEqual(
    plan.options?.map(option => option.label),
    ['Live', 'new'],
  )
  const live = plan.options![0].id
  assert.deepEqual(
    plan.cells.map(cell => cell.value),
    [live, plan.options![1].id, live, live, ''],
  )
  const back = planConversion(
    { id: 'c_s', name: 'Stage', type: 'select' as const, options: plan.options },
    'text',
    plan.cells.map(cell => cell.value),
  )
  assert.deepEqual(
    back.cells.map(cell => cell.value),
    ['Live', 'new', 'Live', 'Live', ''],
  )
})

test('only basic text-like types can be converted', async () => {
  const { planConversion } = await import('../src/features/trackers/trackerModel')
  assert.throws(() => planConversion({ id: 'c_x', name: 'Secret', type: 'secret' as const }, 'text', []))
  assert.throws(() => planConversion({ id: 'c_x', name: 'Done', type: 'checkbox' as const }, 'text', []))
  assert.throws(() => planConversion({ id: 'c_x', name: 'Name', type: 'text' as const }, 'text', []))
})
