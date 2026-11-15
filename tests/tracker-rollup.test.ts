import assert from 'node:assert/strict'
import { test } from 'node:test'
import { makeLookup } from '../src/features/trackers/trackerQuery'
import {
  addDays,
  defaultRollupIds,
  dueThisWeek,
  filterRollup,
  groupRollup,
  rollupCell,
  rollupColumnIds,
  rollupColumns,
  rollupCsv,
  rollupEditable,
  rollupFits,
  rollupItems,
  rollupState,
  rollupTiles,
  sortRollup,
} from '../src/features/trackers/trackerRollup'
import type { TrackerColumn, TrackerRow } from '../src/features/trackers/trackerModel'

const siteRollout: TrackerColumn[] = [
  { id: 'c_site', name: 'Terminal/Site', type: 'text' },
  { id: 'c_branch', name: 'Branch', type: 'text' },
  {
    id: 'c_status',
    name: 'Status',
    type: 'select',
    options: [
      { id: 'o_live', label: 'Live', color: 'green' },
      { id: 'o_drf', label: 'DRF Approval', color: 'blue' },
      { id: 'o_hold', label: 'On hold', color: 'amber' },
    ],
  },
  { id: 'c_bir', name: 'BIR Date of Approval', type: 'date' },
  { id: 'c_go', name: 'Go Live Date', type: 'date', taskField: 'due' },
  { id: 'c_secret', name: 'Admin login', type: 'secret' },
]

const row = (id: string, cells: TrackerRow['cells'], taskId = ''): TrackerRow => ({
  id,
  position: 0,
  cells,
  secretSet: {},
  taskId,
  version: 1,
  updatedAt: '',
})

const today = '2026-11-15'
const lookup = makeLookup(
  [{ id: 't1', title: 'SM North', assignedToUserId: 'u1', owner: '', status: 'Open' } as any],
  [{ id: 'u1', name: 'Ana Reyes', username: 'ana' }],
  today,
)

test('the four fields are matched by name first, then by type', () => {
  assert.deepEqual(rollupColumns(siteRollout), { site: 'c_site', status: 'c_status', goLive: 'c_go' })
  const other: TrackerColumn[] = [
    { id: 'a', name: 'Name', type: 'text' },
    { id: 'b', name: 'Target date', type: 'date' },
    { id: 'c', name: 'PIC', type: 'person' },
    { id: 'd', name: 'Phase', type: 'task_status' },
  ]
  assert.deepEqual(rollupColumns(other), { site: 'a', status: 'd', goLive: 'b', owner: 'c' })
  assert.ok(rollupFits(siteRollout))
  assert.ok(!rollupFits([{ id: 'x', name: 'Notes', type: 'text' }]), 'needs a Status or a Go-live column')
  assert.deepEqual(rollupColumnIds(siteRollout).sort(), ['c_go', 'c_site', 'c_status'])
  assert.ok(!rollupColumnIds(siteRollout).includes('c_secret'))
})

test('by default only Site rollout trackers that are not archived take part', () => {
  const ids = defaultRollupIds([
    { id: '1', template: 'site-rollout', archived: false, columns: siteRollout },
    { id: '2', template: 'site-rollout', archived: true, columns: siteRollout },
    { id: '3', template: 'defects', archived: false, columns: siteRollout },
  ])
  assert.deepEqual(ids, ['1'])
})

test('a row’s state: live, blocked, overdue, due soon, or open', () => {
  assert.equal(rollupState('Live', '2026-01-01', today), 'live')
  assert.equal(rollupState('On hold', '2026-11-20', today), 'blocked')
  assert.equal(rollupState('DRF Approval', '2026-11-14', today), 'overdue')
  assert.equal(rollupState('DRF Approval', '2026-11-29', today), 'due')
  assert.equal(rollupState('DRF Approval', '2026-11-30', today), 'open')
  assert.equal(rollupState('', '', today), 'open')
  assert.equal(addDays('2026-12-30', 3), '2027-01-02')
})

const sets = [
  {
    tracker: { id: 'tA', name: 'SM rollout', clientIds: ['c1'], columns: siteRollout, canEdit: true },
    rows: [
      row('r1', { c_site: 'SM North', c_status: 'o_drf', c_go: '2026-11-18' }, 't1'),
      row('r2', { c_site: 'SM Megamall', c_status: 'o_live', c_go: '2026-10-01' }),
      row('r3', { c_site: 'SM Aura', c_status: 'o_drf', c_go: '2026-11-10' }),
    ],
  },
  {
    tracker: {
      id: 'tB',
      name: 'Ayala sites',
      clientIds: ['c2'],
      columns: [
        { id: 'n', name: 'Site', type: 'text' },
        { id: 's', name: 'Status', type: 'text' },
        { id: 'g', name: 'Go-live', type: 'date' },
        { id: 'o', name: 'Owner', type: 'text' },
      ] as TrackerColumn[],
      canEdit: false,
    },
    rows: [row('r4', { n: 'Glorietta', s: 'Blocked by lessor', g: '2026-11-16', o: 'Jun Perez' })],
  },
]

test('rows from every tracker are read through their own columns', () => {
  const items = rollupItems(sets, lookup)
  assert.deepEqual(
    items.map(item => [item.site, item.status, item.goLive, item.owner, item.state]),
    [
      ['SM North', 'DRF Approval', '2026-11-18', 'Ana Reyes', 'due'],
      ['SM Megamall', 'Live', '2026-10-01', '', 'live'],
      ['SM Aura', 'DRF Approval', '2026-11-10', '', 'overdue'],
      ['Glorietta', 'Blocked by lessor', '2026-11-16', 'Jun Perez', 'blocked'],
    ],
  )
  assert.equal(items[0].owner, 'Ana Reyes', 'with no Owner column, the linked task’s assignee')
  assert.deepEqual(rollupTiles(items), { total: 4, live: 1, due: 1, overdue: 1, blocked: 1 })
})

test('filters, sorting, groups and the week list', () => {
  const items = rollupItems(sets, lookup)
  assert.deepEqual(
    filterRollup(items, { clientId: 'c1', from: '2026-11-01' }).map(item => item.site),
    ['SM North', 'SM Aura'],
  )
  assert.deepEqual(
    filterRollup(items, { state: 'blocked' }).map(item => item.site),
    ['Glorietta'],
  )
  assert.deepEqual(
    filterRollup(items, { query: 'mega' }).map(item => item.rowId),
    ['r2'],
  )
  assert.deepEqual(
    sortRollup(items).map(item => item.site),
    ['SM Aura', 'Glorietta', 'SM North', 'SM Megamall'],
    'overdue first, then by go-live, live last',
  )
  const groups = groupRollup(items, 'tracker')
  assert.deepEqual(
    groups.map(group => [group.label, group.items.length, group.live, group.percent]),
    [
      ['SM rollout', 3, 1, 33],
      ['Ayala sites', 1, 0, 0],
    ],
  )
  const byClient = groupRollup(items, 'client', id => (id === 'c1' ? 'SM Prime' : 'Ayala'))
  assert.deepEqual(
    byClient.map(group => group.label),
    ['SM Prime', 'Ayala'],
  )
  assert.deepEqual(
    dueThisWeek(items, today).map(item => item.site),
    ['SM Aura', 'Glorietta', 'SM North'],
  )
})

test('edits: only plain columns, saved the way the column stores them', () => {
  assert.equal(rollupEditable(siteRollout, 'status')?.id, 'c_status')
  assert.equal(rollupEditable(siteRollout, 'owner'), null, 'no Owner column')
  assert.equal(rollupEditable([{ ...siteRollout[2], synced: true }], 'status'), null, 'synced from a Sheet')
  assert.equal(rollupCell(siteRollout[2], 'o_live'), 'o_live')
  assert.equal(rollupCell(siteRollout[2], 'nope'), '')
  assert.equal(rollupCell(siteRollout[4], '2026-12-01'), '2026-12-01')
  assert.equal(rollupCell(siteRollout[4], 'soon'), '')
})

test('the CSV lists rows as shown and keeps text from running as a formula', () => {
  const items = rollupItems(sets, lookup)
  items[0].site = '=HYPERLINK("x")'
  const csv = rollupCsv(items.slice(0, 1), id => (id === 'c1' ? 'SM Prime' : ''))
  const lines = csv.replace('﻿', '').trim().split('\r\n')
  assert.equal(lines[0], 'Site,Tracker,Client,Status,Go-live,Owner,State')
  assert.equal(lines[1], `"'=HYPERLINK(""x"")",SM rollout,SM Prime,DRF Approval,2026-11-18,Ana Reyes,Due in 14 days`)
})
