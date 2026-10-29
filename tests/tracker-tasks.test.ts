import test from 'node:test'
import assert from 'node:assert/strict'
import { guessTimelineFields, rowTones, dayNumber } from '../src/features/trackers/timelineModel'
import { normalizeColumns, type TrackerColumn, type TrackerRow } from '../src/features/trackers/trackerModel'
import {
  applyTaskPatches,
  phaseRollup,
  planRowTasks,
  rowCellsFromTask,
  rowTaskPatch,
  taskFieldChanges,
} from '../src/features/trackers/trackerTasks'
import { TRACKER_TEMPLATES, templateRows, withDoneColumn } from '../src/features/trackers/trackerTemplates'

const template = TRACKER_TEMPLATES.find(item => item.id === 'project-timeline')!
const made: TrackerColumn[] = normalizeColumns(
  template.columns.map((column, at) => ({
    id: `c${at}`,
    name: column.name,
    type: column.type,
    taskField: column.taskField,
    options: column.options?.map((option, i) => ({ id: `o${at}_${i}`, ...option })),
  })),
  [],
)
const columns = withDoneColumn(template, made)!
const id = (name: string) => columns.find(column => column.name === name)!.id
const status = columns.find(column => column.name === 'Status')!
const option = (label: string) => status.options!.find(item => item.label === label)!.id
const fields = guessTimelineFields(columns)
let n = 0
const asRows = (list: { cells: TrackerRow['cells'] }[]): TrackerRow[] =>
  list.map(row => ({
    id: `r${++n}`,
    position: n,
    cells: row.cells,
    secretSet: {},
    taskId: '',
    version: 1,
    updatedAt: '',
  }))
const closed = (value: string) => value === 'Resolved'

test('the template mirrors the task title, start, due date and progress, and Status is the done column', () => {
  assert.deepEqual(
    columns.filter(column => column.taskField).map(column => [column.name, column.taskField]),
    [
      ['Task', 'title'],
      ['Start', 'start'],
      ['End', 'due'],
      ['% Done', 'progress'],
    ],
  )
  assert.deepEqual(status.autoDone, { done: option('Done'), undone: option('Pending') })
  const cleaned = normalizeColumns(
    [
      { id: 'a', name: 'A', type: 'text', taskField: 'title' },
      { id: 'b', name: 'B', type: 'text', taskField: 'title' },
      { id: 'c', name: 'C', type: 'number', taskField: 'start' },
    ],
    [],
  )
  assert.deepEqual(
    cleaned.map(column => column.taskField),
    ['title', undefined, undefined],
    'one column per field, of a type that fits',
  )
})

test('each phase becomes a task and each row a subtask under it, in a new project named after the tracker', () => {
  const rows = asRows(templateRows(template, columns, '2026-11-05'))
  const plan = planRowTasks({
    columns,
    rows,
    items: [],
    phaseId: fields.groupId,
    leadId: fields.leadId,
    clientId: 'client-1',
    projectId: '',
    newProjectName: 'Barter XI - Implementation',
    assigneeId: 'u1',
  })
  const phases = plan.drafts.filter(draft => draft.parentIndex === undefined && !draft.parentTaskId)
  assert.deepEqual(
    phases.map(draft => draft.title),
    [
      'Project Planning',
      'Data Build-up',
      'Hardware & BIR',
      'Training',
      'UAT',
      'Pre-Live',
      'Go Live',
      'Support Turnover',
    ],
  )
  assert.equal(plan.drafts.length, 8 + 22)
  assert.equal(plan.links.length, 22)
  const first = plan.drafts[0]
  assert.equal(first.newProjectName, 'Barter XI - Implementation')
  assert.equal(first.assignedToUserId, 'u1')
  assert.equal(first.startDate, '2026-11-05', 'a phase task spans its rows')
  assert.equal(first.dueDate, '2026-11-09')
  const kickoff = plan.drafts[plan.links[0].draft]
  assert.equal(kickoff.title, 'Formal Kickoff')
  assert.equal(kickoff.parentIndex, 0)
  assert.equal(kickoff.startDate, '2026-11-05')
  assert.equal(kickoff.description, 'Lead: iRipple & Client')
  for (const draft of plan.drafts)
    if (draft.parentIndex !== undefined) assert.ok(draft.parentIndex < plan.drafts.indexOf(draft), 'tasks come first')
  assert.deepEqual(
    planRowTasks({
      columns,
      rows,
      items: [],
      phaseId: fields.groupId,
      leadId: '',
      clientId: '',
      projectId: 'p',
      newProjectName: '',
      assigneeId: '',
    }).drafts,
    [],
    'no client, no tasks',
  )
})

test('a new row joins its phase’s task; only the rows asked for get tasks', () => {
  const rows = asRows([
    { cells: { [id('Task')]: 'Formal Kickoff', [id('Phase')]: columns.find(c => c.name === 'Phase')!.options![0].id } },
    { cells: { [id('Task')]: 'BPM Discussion', [id('Phase')]: columns.find(c => c.name === 'Phase')!.options![0].id } },
    { cells: { [id('Task')]: 'Not this one' } },
  ])
  rows[0].taskId = 'sub-1'
  const items = [
    { id: 'phase-1', title: 'Project Planning', clientId: 'client-1', projectId: 'p1', status: 'Open' },
    {
      id: 'sub-1',
      title: 'Formal Kickoff',
      clientId: 'client-1',
      projectId: 'p1',
      parentTaskId: 'phase-1',
      status: 'Open',
    },
  ]
  const plan = planRowTasks({
    columns,
    rows,
    items,
    phaseId: fields.groupId,
    leadId: '',
    clientId: 'client-1',
    projectId: 'p1',
    newProjectName: '',
    assigneeId: 'u1',
    onlyRowIds: [rows[1].id],
  })
  assert.equal(plan.drafts.length, 1)
  assert.equal(plan.drafts[0].title, 'BPM Discussion')
  assert.equal(plan.drafts[0].parentTaskId, 'phase-1')
})

test('editing a row changes its task: title, dates, and done or reopened from Status', () => {
  const before = { [id('Task')]: 'DRF', [id('Start')]: '2026-11-05', [status.id]: option('Pending') }
  assert.deepEqual(
    rowTaskPatch(columns, 't', before, { ...before, [id('Start')]: '2026-11-10', [id('End')]: '2026-11-12' }),
    { id: 't', startDate: '2026-11-10', dueDate: '2026-11-12' },
  )
  assert.deepEqual(rowTaskPatch(columns, 't', before, { ...before, [status.id]: option('Done') }), {
    id: 't',
    done: true,
  })
  const finished = { ...before, [status.id]: option('Done') }
  assert.deepEqual(rowTaskPatch(columns, 't', finished, { ...finished, [status.id]: option('Ongoing') }), {
    id: 't',
    done: false,
  })
  assert.equal(rowTaskPatch(columns, 't', before, { ...before, [id('Remarks')]: 'note' }), null)
  assert.equal(rowTaskPatch(columns, '', before, { ...before, [id('Task')]: 'x' }), null, 'no task, nothing to change')
})

test('a phase task spans its subtasks and is done when all of them are', () => {
  const items = [
    { id: 'p', title: 'Phase', status: 'Open', startDate: '', dueDate: '' },
    { id: 'a', title: 'A', parentTaskId: 'p', status: 'Resolved', startDate: '2026-11-05', dueDate: '2026-11-06' },
    { id: 'b', title: 'B', parentTaskId: 'p', status: 'Open', startDate: '2026-11-09', dueDate: '2026-11-20' },
  ]
  assert.deepEqual(phaseRollup(items, ['p'], closed), [{ id: 'p', startDate: '2026-11-05', dueDate: '2026-11-20' }])
  const rules = {
    isClosed: closed,
    close: () => ({ status: 'Resolved' }),
    open: () => ({ status: 'Open' }),
  }
  const done = applyTaskPatches(items, [{ id: 'b', done: true }], rules)
  assert.equal(done.items.find(item => item.id === 'p')!.status, 'Resolved', 'the last subtask closes the phase')
  assert.equal(done.items.find(item => item.id === 'p')!.dueDate, '2026-11-20')
  const reopened = applyTaskPatches(done.items, [{ id: 'a', done: false }], rules)
  assert.equal(reopened.items.find(item => item.id === 'p')!.status, 'Open', 'and reopening one reopens it')
  const early = applyTaskPatches(items, [{ id: 'p', done: true }], rules)
  assert.equal(early.items.find(item => item.id === 'p')!.status, 'Open', 'a task with open subtasks stays open')
  const moved = applyTaskPatches(
    [...items, { id: 'q', title: 'Other phase', status: 'Open' }],
    [{ id: 'b', parentTaskId: 'q' }],
    rules,
  )
  assert.equal(moved.items.find(item => item.id === 'b')!.parentTaskId, 'q')
  assert.equal(moved.items.find(item => item.id === 'p')!.status, 'Resolved', 'the phase it left is now all done')
})

test('a task’s changes reach its row', () => {
  const changes = taskFieldChanges(
    {
      items: [
        { id: 's', title: 'DRF', startDate: '2026-11-05' },
        { id: 'x', title: 'Same' },
      ],
    },
    {
      items: [
        { id: 's', title: 'DRF form', startDate: '2026-11-06', dueDate: '2026-11-09' },
        { id: 'x', title: 'Same' },
        { id: 'new', title: 'New' },
      ],
    },
  )
  assert.deepEqual([...changes], [['s', { title: 'DRF form', startDate: '2026-11-06', dueDate: '2026-11-09' }]])
  assert.deepEqual(rowCellsFromTask(columns, { [id('Task')]: 'DRF', [id('% Done')]: 40 }, changes.get('s'), true), {
    [id('Task')]: 'DRF form',
    [id('Start')]: '2026-11-06',
    [id('End')]: '2026-11-09',
    [id('% Done')]: 100,
  })
  assert.deepEqual(rowCellsFromTask(columns, { [id('% Done')]: 100 }, undefined, false), { [id('% Done')]: 0 })
  assert.deepEqual(rowCellsFromTask(columns, { [id('% Done')]: 60 }, undefined, false), {}, 'partial progress stays')
})

test('rows are tinted by their highlight, or by their state when colouring by status', () => {
  const rows = asRows([
    { cells: { [id('Start')]: '2026-11-02', [id('End')]: '2026-11-03', [id('% Done')]: 100 } },
    { cells: { [id('Start')]: '2026-11-02', [id('End')]: '2026-11-03', [id('% Done')]: 50 } },
    { cells: { [id('Start')]: '2026-11-20', [id('End')]: '2026-11-25', [id('% Done')]: 20 } },
    { cells: { [id('Start')]: '2026-11-20', [id('End')]: '2026-11-25', [id('% Done')]: 0 } },
    { cells: { [id('Start')]: '2026-11-02', [id('End')]: '2026-11-03', [id('% Done')]: 100 } },
  ])
  rows[4].highlight = 'purple'
  const today = dayNumber('2026-11-10')!
  const tones = rowTones(rows, columns, fields, true, today)
  assert.deepEqual(
    rows.map(row => tones.get(row.id) || ''),
    ['green', 'red', 'blue', '', 'purple'],
  )
  assert.deepEqual([...rowTones(rows, columns, fields, false, today).values()], ['purple'], 'only highlights')
})
