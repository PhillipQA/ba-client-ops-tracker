import test from 'node:test'
import assert from 'node:assert/strict'
import {
  columnTotal,
  evaluateFormula,
  formulaCycle,
  formulaFromText,
  formulaToText,
  normalizeColumns,
  splitClientIds,
  type TrackerColumn,
} from '../src/features/trackers/trackerModel'

const cols = (): TrackerColumn[] => [
  { id: 'c_name', name: 'Site', type: 'text' },
  { id: 'c_qty', name: 'Qty', type: 'number' },
  { id: 'c_price', name: 'Price', type: 'number' },
  { id: 'c_total', name: 'Total', type: 'formula', formula: '{c_qty} * {c_price}' },
]

test('a formula is typed with column names and stored with ids', () => {
  const columns = cols()
  const result = formulaFromText('= [qty] * [Price] - 2', columns, 'c_total')
  assert.deepEqual(result, { ok: true, formula: '{c_qty} * {c_price} - 2' })
  assert.equal(formulaToText('{c_qty} * {c_price}', columns), '[Qty] * [Price]')
})

test('a formula only uses known Number or Calculated columns and plain arithmetic', () => {
  const columns = cols()
  assert.equal(formulaFromText('[Site] + 1', columns, 'c_total').ok, false)
  assert.equal(formulaFromText('[Nope] + 1', columns, 'c_total').ok, false)
  assert.equal(formulaFromText('[Total] + 1', columns, 'c_total').ok, false, 'cannot use itself')
  assert.equal(formulaFromText('[Qty] ** 2', columns, 'c_total').ok, false)
  assert.equal(formulaFromText('alert(1)', columns, 'c_total').ok, false)
  assert.equal(formulaFromText('([Qty] + 1', columns, 'c_total').ok, false)
  assert.equal(formulaFromText('', columns, 'c_total').ok, false)
})

test('Calculated cells add, subtract, multiply and divide, with brackets and precedence', () => {
  const columns = cols()
  const calc = (formula: string, cells: Record<string, any>) =>
    evaluateFormula({ id: 'x', name: 'X', type: 'formula', formula }, cells, columns)
  assert.equal(calc('{c_qty} * {c_price}', { c_qty: 3, c_price: 2.5 }).value, 7.5)
  assert.equal(calc('{c_qty} + {c_price} * 2', { c_qty: 1, c_price: 2 }).value, 5)
  assert.equal(calc('({c_qty} + {c_price}) * 2', { c_qty: 1, c_price: 2 }).value, 6)
  assert.equal(calc('{c_qty} - -{c_price}', { c_qty: 1, c_price: 2 }).value, 3)
  assert.equal(calc('{c_qty} / {c_price}', { c_qty: 1, c_price: 0 }).error, 'Divide by 0')
  assert.equal(calc('0.1 + 0.2', {}).value, 0.3)
  assert.equal(calc('{c_qty} * {c_price}', {}).value, null, 'all inputs empty gives an empty cell')
  assert.equal(calc('{c_qty} + {c_price}', { c_qty: 4 }).value, 4, 'an empty input counts as 0')
  assert.equal(
    evaluateFormula(
      { id: 'y', name: 'Y', type: 'formula', formula: '{c_total} + 1' },
      { c_qty: 2, c_price: 3 },
      columns,
    ).value,
    7,
    'a formula can use another one',
  )
})

test('columns keep formulas by id, survive renames and refuse cycles', () => {
  const saved = normalizeColumns([
    { name: 'Qty', type: 'number' },
    { name: 'Price', type: 'number', total: 'sum' },
    { name: 'Total', type: 'formula', formula: '[Qty]*[Price]', total: 'sum' },
    { name: 'Note', type: 'text', total: 'sum' },
  ])
  const [qty, price, total, note] = saved
  assert.equal(total.formula, `{${qty.id}}*{${price.id}}`)
  assert.equal(total.total, 'sum')
  assert.equal(price.total, 'sum')
  assert.equal(note.total, undefined)
  const renamed = normalizeColumns(
    saved.map(column => (column.id === qty.id ? { ...column, name: 'Quantity' } : column)),
    saved,
  )
  assert.equal(formulaToText(renamed[2].formula!, renamed), '[Quantity]*[Price]')
  assert.throws(
    () =>
      normalizeColumns([
        { name: 'A', type: 'formula', formula: '[B]+1' },
        { name: 'B', type: 'formula', formula: '[A]+1' },
      ]),
    /refers back|cannot use itself/,
  )
  assert.throws(
    () =>
      normalizeColumns([
        { name: 'A', type: 'number' },
        { name: 'B', type: 'formula', formula: '[A] +* 1' },
      ]),
    /B:/,
  )
  assert.equal(formulaCycle(saved), '')
})

test('the totals row sums Number and Calculated cells and ignores empty ones', () => {
  const columns = cols()
  const rows = [{ cells: { c_qty: 2, c_price: 10 } }, { cells: { c_qty: 1 } }, { cells: {} }]
  assert.equal(columnTotal(columns[1], rows, columns), 3)
  assert.equal(columnTotal(columns[3], rows, columns), 20)
  assert.equal(columnTotal(columns[2], [{ cells: {} }], columns), null)
})

test('a tracker keeps several clients in order without duplicates', () => {
  assert.deepEqual(splitClientIds('c1, c2,,c1'), ['c1', 'c2'])
  assert.deepEqual(splitClientIds(''), [])
})
