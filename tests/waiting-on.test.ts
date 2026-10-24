import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_WAITING_ON,
  applyWaitingOnRenames,
  defaultWaitingOn,
  doneWaitingOn,
  isWaitingOnDone,
  openWaitingOnOptions,
  planWaitingOnUpdate,
  waitingOnOptions,
  waitingOnTone,
} from '../src/features/tasks/waitingOn'
import { boardColumns } from '../src/features/tasks/taskBoardModel'
import type { TaskSettings, WaitingOnDefinition, WorkItem } from '../src/shared/types'

const custom: WaitingOnDefinition[] = [
  { id: 'me', label: 'Me', done: false },
  { id: 'developer', label: 'Dev team', done: false },
  { id: 'vendor', label: 'Vendor', done: false },
  { id: 'done', label: 'Finished', done: true },
]
const settings = (waitingOn?: WaitingOnDefinition[]): TaskSettings => ({
  statuses: [{ id: 'open', label: 'Open', closed: false }],
  visibleColumns: ['status'],
  waitingOn,
})

test('accounts without configured options get the previous built-in list', () => {
  assert.deepEqual(
    waitingOnOptions(undefined).map(o => o.label),
    ['Me', 'Developer', 'Client', 'QA', 'Design', 'Done'],
  )
  assert.deepEqual(waitingOnOptions(settings()), [...DEFAULT_WAITING_ON])
  assert.equal(defaultWaitingOn(settings()), 'Me')
  assert.equal(doneWaitingOn(settings()), 'Done')
  assert.equal(isWaitingOnDone('Done', settings()), true)
  assert.equal(isWaitingOnDone('Client', settings()), false)
})

test('unusable stored lists fall back to the defaults', () => {
  const twoDone = [
    { id: 'a', label: 'A', done: true },
    { id: 'b', label: 'B', done: true },
  ]
  const duplicate = [
    { id: 'a', label: 'Me', done: false },
    { id: 'b', label: 'me', done: false },
    { id: 'c', label: 'Done', done: true },
  ]
  assert.equal(waitingOnOptions(settings(twoDone)).length, DEFAULT_WAITING_ON.length)
  assert.equal(waitingOnOptions(settings(duplicate)).length, DEFAULT_WAITING_ON.length)
  assert.equal(waitingOnOptions({ waitingOn: 'nope' }).length, DEFAULT_WAITING_ON.length)
})

test('configured options drive defaults, completion and chip tones', () => {
  const s = settings(custom)
  assert.equal(defaultWaitingOn(s), 'Me')
  assert.equal(doneWaitingOn(s), 'Finished')
  assert.deepEqual(
    openWaitingOnOptions(s).map(o => o.label),
    ['Me', 'Dev team', 'Vendor'],
  )
  assert.equal(isWaitingOnDone('Finished', s), true)
  assert.equal(isWaitingOnDone('Vendor', s), false)
  // A leftover legacy value still counts as done.
  assert.equal(isWaitingOnDone('Done', s), true)
  assert.equal(waitingOnTone('Dev team', s), 'developer')
  assert.equal(waitingOnTone('Vendor', s), 'custom')
  assert.equal(waitingOnTone('Finished', s), 'done')
})

test('updates rename tasks, keep unused removals, and block unsafe changes', () => {
  const items = [{ waitingOn: 'Developer' }, { waitingOn: 'Developer' }, { waitingOn: 'Client' }, { waitingOn: 'Done' }]
  const rename = DEFAULT_WAITING_ON.map(o =>
    o.id === 'developer' ? { ...o, label: 'Dev team' } : o.id === 'done' ? { ...o, label: 'Finished' } : o,
  ).filter(o => o.id !== 'qa')
  const planned = planWaitingOnUpdate(rename, settings(), items)
  assert.equal(planned.ok, true)
  if (!planned.ok) return
  assert.deepEqual(
    [...planned.update.renamed],
    [
      ['Developer', 'Dev team'],
      ['Done', 'Finished'],
    ],
  )
  assert.deepEqual(
    applyWaitingOnRenames(items, planned.update.renamed).map(i => i.waitingOn),
    ['Dev team', 'Dev team', 'Client', 'Finished'],
  )

  const removeUsed = DEFAULT_WAITING_ON.filter(o => o.id !== 'client')
  const blocked = planWaitingOnUpdate(removeUsed, settings(), items)
  assert.equal(blocked.ok, false)
  if (!blocked.ok) assert.match(blocked.error, /"Client" is used by 1 task/)

  const swappedDone = DEFAULT_WAITING_ON.map(o => ({ ...o, done: o.id === 'me' }))
  assert.equal(planWaitingOnUpdate(swappedDone, settings(), items).ok, false)
  assert.equal(
    planWaitingOnUpdate([...DEFAULT_WAITING_ON, { id: 'x', label: 'client', done: false }], settings(), items).ok,
    false,
  )
  assert.equal(planWaitingOnUpdate([{ id: 'done', label: 'Done', done: true }], settings(), items).ok, false)
  assert.equal(
    planWaitingOnUpdate([...DEFAULT_WAITING_ON, { id: 'x', label: ' ', done: false }], settings(), items).ok,
    false,
  )
  assert.equal(planWaitingOnUpdate('nope', settings(), items).ok, false)
})

test('swapping two labels moves each task once', () => {
  const swapped = DEFAULT_WAITING_ON.map(o =>
    o.id === 'qa' ? { ...o, label: 'Design' } : o.id === 'design' ? { ...o, label: 'QA' } : o,
  )
  const planned = planWaitingOnUpdate(swapped, settings(), [{ waitingOn: 'QA' }])
  assert.equal(planned.ok, true)
  if (planned.ok)
    assert.deepEqual(
      applyWaitingOnRenames([{ waitingOn: 'QA' }, { waitingOn: 'Design' }], planned.update.renamed).map(
        i => i.waitingOn,
      ),
      ['Design', 'QA'],
    )
})

test('board groups by configured options and parks unknown values in a read-only column', () => {
  const item = (id: string, waitingOn: string) =>
    ({ id, status: 'Open', waitingOn, priority: 'Medium', dueDate: '', title: id, followUpDate: '' }) as WorkItem
  const columns = boardColumns(
    [item('a', 'Vendor'), item('b', 'Finished'), item('c', 'Client')],
    'waiting',
    settings(custom),
  )
  assert.deepEqual(
    columns.map(c => c.label),
    ['Me', 'Dev team', 'Vendor', 'Finished', 'Other'],
  )
  assert.equal(columns[2].items[0].id, 'a')
  assert.equal(columns[3].collapsed, true)
  assert.equal(columns[3].acceptsDrops, false)
  assert.equal(columns[4].acceptsDrops, false)
  assert.equal(columns[4].items[0].id, 'c')
})
