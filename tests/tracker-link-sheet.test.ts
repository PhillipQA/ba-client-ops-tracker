import test from 'node:test'
import assert from 'node:assert/strict'
import { adoptRows, planSync, sheetRowKeys } from '../src/features/trackers/trackerSync'
import type { TrackerColumn } from '../src/features/trackers/trackerModel'

const site: TrackerColumn = { id: 'c_site', name: 'Site', type: 'text' }
const status: TrackerColumn = {
  id: 'c_status',
  name: 'Status',
  type: 'select',
  options: [
    { id: 'o_new', label: 'New', color: 'gray' },
    { id: 'o_done', label: 'Done', color: 'green' },
  ],
}

const grid = [
  ['Site', 'Status'],
  ['Makati', 'New'],
  ['', 'note under Makati'],
  ['Cebu', 'Done'],
  ['Makati', 'Done'],
  ['Davao', 'New'],
]

test('linking a Sheet matches tracker rows by name, in order', () => {
  const rows = [
    { id: 'r1', data: { c_site: 'makati ' } },
    { id: 'r2', data: { c_site: 'Cebu' } },
    { id: 'r3', data: { c_site: 'Makati' } },
    { id: 'r4', data: { c_site: 'Iloilo' } },
    { id: 'r5', data: {} },
  ]
  const matched = adoptRows({ grid, keyHeader: 'site', keyColumn: site, rows })
  const keys = sheetRowKeys(['Makati', '', 'Cebu', 'Makati', 'Davao'])
  assert.deepEqual(matched, [
    { rowId: 'r1', key: keys[0] },
    { rowId: 'r2', key: keys[2] },
    { rowId: 'r3', key: keys[3] },
  ])
})

test('rows already recognised by a Sheet are left alone', () => {
  const rows = [
    { id: 'r1', data: { c_site: 'Makati' }, sourceKey: 'Makati' },
    { id: 'r2', data: { c_site: 'Makati' } },
  ]
  const matched = adoptRows({ grid, keyHeader: 'Site', keyColumn: site, rows })
  assert.deepEqual(
    matched.map(item => item.rowId),
    ['r2'],
  )
})

test('a choice column matches by its label', () => {
  const matched = adoptRows({
    grid: [['Status'], ['Done']],
    keyHeader: 'Status',
    keyColumn: status,
    rows: [{ id: 'r1', data: { c_status: 'o_done' } }],
  })
  assert.equal(matched[0]?.rowId, 'r1')
})

test('no key column or missing header matches nothing', () => {
  const rows = [{ id: 'r1', data: { c_site: 'Makati' } }]
  assert.deepEqual(adoptRows({ grid, keyHeader: 'Branch', keyColumn: site, rows }), [])
  assert.deepEqual(adoptRows({ grid, keyHeader: 'Site', keyColumn: undefined, rows }), [])
})

test('matched rows are updated by the first sync instead of added again', () => {
  const rows = [{ id: 'r1', data: { c_site: 'Cebu' } }]
  const matched = adoptRows({ grid, keyHeader: 'Site', keyColumn: site, rows })
  const plan = planSync({
    grid,
    keyHeader: 'Site',
    headerMap: { Site: 'c_site' },
    columns: [site],
    rows: rows.map(row => ({
      ...row,
      sourceKey: matched.find(item => item.rowId === row.id)?.key || '',
      values: {},
      missing: false,
    })),
    people: [],
    today: '2026-11-13',
    capacity: 100,
  })
  assert.ok(!('error' in plan))
  if ('error' in plan) return
  assert.equal(
    plan.inserts.some(item => item.key === 'Cebu'),
    false,
  )
  assert.equal(plan.report.added, 4)
})
