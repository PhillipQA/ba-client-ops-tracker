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
    { id: 't-go', title: 'Go-live prep', projectId: 'p-seeds', seedsTaskId: 'st-golive' },
    { id: 's-printers', title: 'Check printers', projectId: 'p-seeds', parentTaskId: 't-go' },
    {
      id: 's-call',
      title: 'Cutover call with store',
      projectId: 'p-seeds',
      parentTaskId: 't-go',
      seedsTaskId: 'st-meet',
    },
    { id: 't-untagged', title: 'Loose task', projectId: 'p-seeds' },
    { id: 't-old', title: 'Old task', projectId: 'p-before' },
  ],
})
const actor = { id: 'u1', name: 'Bea' }
const at = new Date('2026-11-09T01:00:00Z')
const task = (s: ReturnType<typeof state>, id: string) => s.items.find(item => item.id === id) as any
const log = (s: ReturnType<typeof state>, id: string, input: any) =>
  addTimeEntry(task(s, id), input, actor, at, 'e1', seedsTimeRule(s, task(s, id)))

test('while Seeds is off, time is logged as before, on tasks and subtasks', () => {
  const s = state(false)
  assert.equal(seedsTimeRule(s, task(s, 's-printers')), null)
  const result = addTimeEntry(
    task(s, 's-printers'),
    { date: '2026-11-08', hours: 1, category: 'Analysis', note: '' },
    actor,
    at,
    'e1',
  )
  assert.equal(result.ok, true)
})

test('once Seeds is on, time is logged on the task; a subtask points there', () => {
  const s = state()
  const sub = log(s, 's-printers', { date: '2026-11-08', hours: 1, note: 'x' })
  assert.equal(sub.ok, false)
  assert.match((sub as any).error, /Log time on the task/)
  assert.equal(seedsTimeRule(s, task(s, 's-printers'))?.logOnTaskId, 't-go')
  assert.match((log(s, 't-old', { date: '2026-11-08', hours: 1, note: 'x' }) as any).error, /Move this work to Seeds/)
  // A Seeds task is optional unless Seeds requires one: untagged time still goes to Seeds (without a task).
  const untagged = log(s, 't-untagged', { date: '2026-11-08', hours: 1, note: 'x' })
  assert.ok(untagged.ok && !untagged.value.entry.seedsTaskId)
})

test('an entry for a subtask takes its title as remarks, and its Seeds task tag first', () => {
  const s = state()
  const printers = log(s, 't-go', { date: '2026-11-08', hours: 1.75, subtaskId: 's-printers' })
  assert.ok(printers.ok)
  assert.deepEqual(
    [
      printers.value.entry.note,
      printers.value.entry.subtaskId,
      printers.value.entry.seedsTaskId,
      printers.value.entry.hours,
    ],
    ['Check printers – Go-live prep', 's-printers', 'st-golive', 1.75],
    'subtask – task, no date; the task’s Seeds task when the subtask has none',
  )
  const call = log(s, 't-go', { date: '2026-11-09', hours: 0.5, subtaskId: 's-call' })
  assert.ok(call.ok && call.value.entry.seedsTaskId === 'st-meet', 'the subtask’s own Seeds task wins')
  const chosen = log(s, 't-go', { date: '2026-11-09', hours: 0.5, subtaskId: 's-call', seedsTaskId: 'st-golive' })
  assert.ok(chosen.ok && chosen.value.entry.seedsTaskId === 'st-golive', 'or the one chosen for the entry')
  const note = '  Printer setup, Makati T1 '
  const typed = log(s, 't-go', { date: '2026-11-09', hours: 1, subtaskId: 's-printers', note })
  assert.ok(typed.ok && typed.value.entry.note === 'Printer setup, Makati T1', 'remarks typed for a subtask are kept')
  assert.ok(typed.ok && typed.value.entry.subtaskId === 's-printers')
  const long = {
    ...state(),
    items: [...state().items, { id: 's-long', title: 'y'.repeat(200), projectId: 'p-seeds', parentTaskId: 't-go' }],
  }
  const trimmed = log(long, 't-go', { date: '2026-11-09', hours: 0.25, subtaskId: 's-long' })
  assert.ok(trimmed.ok && trimmed.value.entry.note.length === 120)
  assert.match(
    (log(s, 't-go', { date: '2026-11-09', hours: 1, subtaskId: 't-untagged' }) as any).error,
    /not under this task/,
  )
})

test('without a subtask the remarks are typed (optional unless Seeds requires them); Seeds rules on duration', () => {
  const s = state()
  const rule = seedsTimeRule(s, task(s, 't-go'))
  assert.equal((validateTimeEntryInput({ date: '2026-11-08', hours: 1 }, rule) as any).ok, true, 'no remarks')
  assert.match(
    (validateTimeEntryInput({ date: '2026-11-08', hours: 1 }, { ...rule!, remarksRequired: true }) as any).error,
    /requires remarks/,
  )
  const ok = log(s, 't-go', { date: '2026-11-08', hours: 2, note: 'Store visit' })
  assert.ok(ok.ok && ok.value.entry.note === 'Store visit' && ok.value.entry.category === 'Other')
  const second = addTimeEntry(ok.value.task, { date: '2026-11-10', hours: 1, note: 'Follow-up' }, actor, at, 'e2', rule)
  assert.ok(second.ok && second.value.task.timeEntries.length === 2, 'many entries, any dates')
  assert.match((validateTimeEntryInput({ date: '2026-11-08', hours: 1.1, note: 'a' }, rule) as any).error, /15-minute/)
  assert.match((validateTimeEntryInput({ date: '2026-11-08', hours: 0, note: 'a' }, rule) as any).error, /15 minutes/)
  assert.match(
    (validateTimeEntryInput({ date: '2026-11-08', hours: 1, note: 'a', seedsTaskId: 'st-old' }, rule) as any).error,
    /Seeds task/,
  )
  assert.match(
    (validateTimeEntryInput({ date: '2026-11-08', hours: 1, note: 'x'.repeat(121) }, rule) as any).error,
    /120/,
  )
})

test('a tracker subtask named like a Seeds task gets it', async () => {
  const { seedsTaskNamed } = await import('../src/shared/seeds')
  const tasks = [
    { id: 'st-golive', name: 'GO LIVE' },
    { id: 'st-bir', name: 'BIR/DRF CREATION' },
    { id: 'st-x', name: 'MONITORING', archived: true },
  ]
  assert.equal(seedsTaskNamed(tasks, 'Go Live'), 'st-golive')
  assert.equal(seedsTaskNamed(tasks, 'bir drf creation'), 'st-bir')
  assert.equal(seedsTaskNamed(tasks, 'Monitoring'), undefined, 'not archived ones')
  assert.equal(seedsTaskNamed(tasks, 'Hardware'), undefined)
})

test('a task is Before Seeds work by its project, else by its client', async () => {
  const { isBeforeSeedsWork } = await import('../src/shared/seeds')
  const projects = [
    { id: 'p-old', beforeSeeds: true },
    { id: 'p-seeds', seedsId: '20' },
  ]
  const clients = [{ id: 'c-old', beforeSeeds: true }, { id: 'c-seeds' }]
  assert.equal(isBeforeSeedsWork({ projectId: 'p-old', clientId: 'c-seeds' }, projects, clients), true)
  assert.equal(isBeforeSeedsWork({ projectId: 'p-seeds', clientId: 'c-old' }, projects, clients), false)
  assert.equal(isBeforeSeedsWork({ clientId: 'c-old' }, projects, clients), true)
  assert.equal(isBeforeSeedsWork({}, projects, clients), false)
})
