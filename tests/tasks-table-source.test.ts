import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  duplicateItemId,
  itemsWritePlan,
  snapshotWithItems,
  snapshotWithoutItems,
  tablesAreSource,
  workspaceFromStored,
} from '../server/services/item-tables'

const read = (path: string) => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const item = (id: string, type = 'Task') => ({ id, title: id, type, comments: [{ id: `${id}-c` }] })
const state = {
  clients: [{ id: 'c1' }],
  items: [item('b'), item('a'), item('q', 'Inquiry')],
  notifications: [],
}

test('stored with tasks in their tables, the snapshot keeps only their order; loading puts them back in order', () => {
  const stored = snapshotWithoutItems(state)
  assert.deepEqual(stored.items, [])
  assert.deepEqual(stored.itemOrder, ['b', 'a', 'q'])
  assert.equal(stored.itemsInTables, true)
  assert.ok(JSON.stringify(stored).length < JSON.stringify(state).length)
  // The tables return rows in any order.
  const rows = [item('a'), item('q', 'Inquiry'), item('b')]
  const loaded = workspaceFromStored(JSON.parse(JSON.stringify(stored)), rows)
  assert.equal(loaded.inTables, true)
  assert.deepEqual(loaded.state, state, 'the same workspace as before, without the bookkeeping')
})

test('a snapshot that still holds its tasks loads exactly as before', () => {
  const loaded = workspaceFromStored(state, undefined)
  assert.equal(loaded.inTables, false)
  assert.deepEqual(loaded.state, state)
  assert.deepEqual(snapshotWithItems({ ...state, itemOrder: ['x'], itemsInTables: true }), state)
})

test('rows the order does not know follow the others; a failed read never becomes an empty task list', () => {
  const stored = snapshotWithoutItems(state)
  const loaded = workspaceFromStored(stored, [item('extra'), item('b'), item('a'), item('q', 'Inquiry')])
  assert.deepEqual(
    loaded.state.items.map((entry: any) => entry.id),
    ['b', 'a', 'q', 'extra'],
  )
  assert.throws(() => workspaceFromStored(stored, []), /could not be read/)
  assert.throws(() => workspaceFromStored(stored, null), /could not be read/)
  assert.deepEqual(workspaceFromStored(snapshotWithoutItems({ items: [] }), []).state.items, [], 'none listed, none')
})

test('the switch to the tables happens on a save that writes every record; account snapshots never switch', () => {
  // First save after deploying: every record is written once, and the snapshot drops its items.
  assert.deepEqual(itemsWritePlan({ wantTables: true, wasInTables: false, synchronize: true }), {
    toTables: true,
    changedRows: false,
    onlyTables: undefined,
    fullSaveKeepsTables: true,
    syncRecordsOnFullSave: true,
  })
  // From then on: only changed rows.
  const steady = itemsWritePlan({ wantTables: true, wasInTables: true, synchronize: true })
  assert.equal(steady.toTables, true)
  assert.equal(steady.changedRows, true)
  // An account snapshot (no record sync) before the switch: as before, items stay in the snapshot.
  const account = itemsWritePlan({ wantTables: true, wasInTables: false, synchronize: false })
  assert.equal(account.toTables, false)
  assert.equal(account.changedRows, false)
  // After the switch: it writes the task tables only, and if that fails the snapshot takes the items back.
  const later = itemsWritePlan({ wantTables: true, wasInTables: true, synchronize: false })
  assert.equal(later.toTables, true)
  assert.deepEqual(later.onlyTables, ['tasks', 'inquiries'])
  assert.equal(later.fullSaveKeepsTables, false)
  // TASKS_SOURCE=snapshot: the next save puts the items back into the snapshot.
  const back = itemsWritePlan({ wantTables: false, wasInTables: true, synchronize: true })
  assert.equal(back.toTables, false)
  assert.equal(back.fullSaveKeepsTables, false)
})

test('TASKS_SOURCE chooses where tasks are kept; duplicate item ids are caught', () => {
  assert.equal(tablesAreSource({}), true)
  assert.equal(tablesAreSource({ TASKS_SOURCE: 'tables' }), true)
  assert.equal(tablesAreSource({ TASKS_SOURCE: 'Snapshot' }), false)
  assert.equal(duplicateItemId(state), null)
  assert.equal(duplicateItemId({ items: [item('a'), item('a', 'Inquiry')] }), 'a')
})

test('wiring: loads read the snapshot and task rows in one statement; saves follow the plan', () => {
  const tenant = read('server/core/tenant-state.ts')
  assert.match(tenant, /const data = await readTenantSnapshot\(organizationId\)/)
  assert.match(
    tenant,
    /select raw_data from public\.tasks where organization_id = s\.organization_id and deleted_at is null/,
  )
  assert.match(
    tenant,
    /select raw_data from public\.inquiries where organization_id = s\.organization_id and deleted_at is null/,
  )
  assert.match(tenant, /itemsInTablesOf\.set\(recoveredState, stored\.inTables\)/)
  assert.match(tenant, /wantTables: tablesAreSource\(\) && Date\.now\(\) >= changedRecordSavesMissingUntil/)
  assert.match(tenant, /plan\.toTables \? snapshotWithoutItems\(state\) : snapshotWithItems\(state\)/)
  assert.match(tenant, /p_state: keepTables \? snapshotWithoutItems\(state\) : snapshotWithItems\(state\)/)
  assert.match(read('README.md'), /`TASKS_SOURCE`/)
})
