import assert from 'node:assert/strict'
import test from 'node:test'
import { seedsTimeRule, validateTimeEntryInput } from '../src/features/tasks/effort'
import { addTimeEntry } from '../server/services/time-entries'

const state = (connected = true) => ({
  seeds: { connected },
  projects: [
    {
      id: 'p-seeds',
      seedsId: 's-1',
      seedsTasks: [
        { id: 'st-golive', name: 'GO LIVE' },
        { id: 'st-meet', name: 'MEETINGS' },
        { id: 'st-old', name: 'OLD', archived: true },
      ],
    },
    { id: 'p-before', beforeSeeds: true },
  ],
  items: [
    { id: 't-tagged', projectId: 'p-seeds', seedsTaskId: 'st-golive' },
    { id: 't-untagged', projectId: 'p-seeds' },
    { id: 't-old', projectId: 'p-before' },
  ],
})
const actor = { id: 'u1', name: 'Bea' }
const at = new Date('2026-11-09T01:00:00Z')

test('while Seeds is off, time is logged as before', () => {
  assert.equal(seedsTimeRule(state(false), { projectId: 'p-seeds' }), null)
  const result = addTimeEntry(
    { id: 't' },
    { date: '2026-11-08', hours: 1, category: 'Analysis', note: '' },
    actor,
    at,
    'e1',
  )
  assert.equal(result.ok, true)
})

test('once Seeds is on, only work tagged with a Seeds task (or under a tagged task) takes time', () => {
  const s = state()
  assert.deepEqual(seedsTimeRule(s, s.items[0]), {
    tasks: [
      { id: 'st-golive', name: 'GO LIVE' },
      { id: 'st-meet', name: 'MEETINGS' },
    ],
    taggedTaskId: 'st-golive',
  })
  assert.equal(seedsTimeRule(s, { projectId: 'p-seeds', parentTaskId: 't-tagged' })?.taggedTaskId, 'st-golive')
  assert.equal(
    seedsTimeRule(s, { projectId: 'p-seeds', parentTaskId: 't-tagged', seedsTaskId: 'st-meet' })?.taggedTaskId,
    'st-meet',
  )

  const untagged = addTimeEntry(
    s.items[1],
    { date: '2026-11-08', hours: 1 },
    actor,
    at,
    'e1',
    seedsTimeRule(s, s.items[1]),
  )
  assert.equal(untagged.ok, false)
  assert.match((untagged as any).error, /Tag a Seeds task/)
  const before = addTimeEntry(
    s.items[2],
    { date: '2026-11-08', hours: 1 },
    actor,
    at,
    'e1',
    seedsTimeRule(s, s.items[2]),
  )
  assert.equal(before.ok, false, 'Before Seeds work has no Seeds tasks, so no time once Seeds is on')
})

test('a Seeds time entry: date, 15-minute duration, Seeds task (default the tag), remarks up to 120', () => {
  const s = state()
  const rule = seedsTimeRule(s, s.items[0])
  const ok = addTimeEntry(s.items[0], { date: '2026-11-08', hours: 1.75, note: 'Cutover call' }, actor, at, 'e1', rule)
  assert.ok(ok.ok)
  assert.deepEqual(
    [ok.value.entry.hours, ok.value.entry.seedsTaskId, ok.value.entry.note, ok.value.entry.category],
    [1.75, 'st-golive', 'Cutover call', 'Other'],
  )
  const other = validateTimeEntryInput({ date: '2026-11-08', hours: 0.5, seedsTaskId: 'st-meet' }, rule)
  assert.ok(
    other.ok && other.value.seedsTaskId === 'st-meet',
    'each entry can count toward another of the project’s Seeds tasks',
  )
  // Several entries on different dates add up on the same task.
  const second = addTimeEntry(ok.value.task, { date: '2026-11-09', hours: 2 }, actor, at, 'e2', rule)
  assert.ok(second.ok && second.value.task.timeEntries.length === 2)

  assert.match((validateTimeEntryInput({ date: '2026-11-08', hours: 1.1 }, rule) as any).error, /15-minute/)
  assert.match((validateTimeEntryInput({ date: '2026-11-08', hours: 0 }, rule) as any).error, /15 minutes/)
  assert.match(
    (validateTimeEntryInput({ date: '2026-11-08', hours: 1, seedsTaskId: 'st-old' }, rule) as any).error,
    /Seeds task/,
  )
  assert.match(
    (validateTimeEntryInput({ date: '2026-11-08', hours: 1, note: 'x'.repeat(121) }, rule) as any).error,
    /120/,
  )
})
