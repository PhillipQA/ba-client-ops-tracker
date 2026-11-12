import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  actionRights,
  asksForEmailDraft,
  asksForTaskPlan,
  asksToLogTime,
  asksToUpdateTracker,
  emailDraftSuggestions,
  planningContext,
  taskPlanSuggestions,
  timeLogContext,
  timeLogSuggestions,
  trackerUpdateSuggestions,
} from '../server/ai/assistant-actions'
import { plannedRefs, togglePlanned, type TaskPlan } from '../src/features/ai/ai'

const settings = {
  statuses: [
    { label: 'Not Started', closed: false },
    { label: 'In Progress', closed: false },
    { label: 'Closed', closed: true },
  ],
  waitingOn: [
    { id: 'client', label: 'Client', done: false },
    { id: 'done', label: 'Done', done: true },
  ],
}
const task = (id: string, data: Record<string, unknown> = {}) => ({
  id,
  title: id,
  status: 'In Progress',
  waitingOn: 'Client',
  clientId: 'c1',
  projectId: 'p1',
  ...data,
})
const state = (seeds = false): any => ({
  taskSettings: settings,
  accounts: [
    { id: 'u1', name: 'Phillip', role: 'Administrator', status: 'Active' },
    { id: 'u2', name: 'Ana Reyes', role: 'Contributor', status: 'Active' },
    { id: 'u3', name: 'Viewer Vic', role: 'Viewer', status: 'Active' },
    { id: 'u4', name: 'Gone', role: 'Contributor', status: 'Disabled' },
  ],
  clients: [
    { id: 'c1', name: 'Goldwing Retail' },
    { id: 'c2', name: 'Old Client', archived: true },
  ],
  projects: [
    {
      id: 'p1',
      name: 'Goldwing Rollout',
      clientId: 'c1',
      seedsTasks: [
        { id: 's-go', name: 'Go Live' },
        { id: 's-meet', name: 'Meetings' },
      ],
    },
    { id: 'p2', name: 'Goldwing Done', clientId: 'c1', seedsArchived: true },
  ],
  items: [
    task('rollout', { title: 'Makati T1 rollout', assignedToUserId: 'u1', seedsTaskId: 's-go' }),
    task('go-live', { title: 'Go Live', parentTaskId: 'rollout' }),
    task('printers', { title: 'Printer specs', assignedToUserId: 'u2' }),
    task('closed', { title: 'Old work', status: 'Closed' }),
    task('archived', { title: 'Archived work', archived: true }),
  ],
  seeds: { connected: seeds },
})

test('each action is offered only when the question asks for it', () => {
  assert.ok(asksForEmailDraft('Remind the client about the printer specs'))
  assert.ok(asksForEmailDraft('Follow up with Ana on the BIR permit'))
  assert.ok(asksForEmailDraft('Draft an email to Goldwing about go-live'))
  assert.ok(!asksForEmailDraft('What is due this week?'))
  assert.ok(asksForTaskPlan('Create tasks from these meeting notes: …'))
  assert.ok(asksForTaskPlan('Here are the minutes from today'))
  assert.ok(!asksForTaskPlan('Summarize my open tasks'))
  assert.ok(asksToUpdateTracker('Mark Makati T1 permits done and set go-live to Nov 20'))
  assert.ok(asksToLogTime('Log 2 hours on Go Live – Makati T1 today'))
  assert.ok(asksToLogTime('log 30 mins on the printer specs'))
  assert.ok(!asksToLogTime('How much time is left on the rollout?'))
})

test('actions follow the person’s rights: Viewers and read-only pages get none', () => {
  const all = () => true
  assert.deepEqual(actionRights({ role: 'Contributor' }, all), { email: true, tasks: true, trackers: true, time: true })
  assert.deepEqual(actionRights({ role: 'Viewer' }, all), { email: false, tasks: false, trackers: false, time: false })
  const readTrackers = actionRights({ role: 'Contributor', editModules: ['items'] }, all)
  assert.equal(readTrackers.trackers, false)
  assert.equal(readTrackers.tasks, true)
  const noInbox = actionRights({ role: 'Contributor' }, module => module !== 'inbox')
  assert.equal(noInbox.email, false)
})

test('a follow-up email is kept only for an open task the person can see', () => {
  const kept = emailDraftSuggestions(
    [
      { kind: 'email_draft', taskId: 'printers', subject: 'Printer specs', body: 'Hi, could you send the specs?' },
      { kind: 'email_draft', taskId: 'closed', body: 'Too late' },
      { kind: 'email_draft', taskId: 'nope', body: 'Unknown' },
      { kind: 'email_draft', taskId: 'printers', body: '' },
    ],
    state(),
  )
  assert.equal(kept.length, 1)
  assert.equal(kept[0].taskTitle, 'Printer specs')
  assert.equal(kept[0].draft, 'Hi, could you send the specs?')
})

test('a task plan keeps one open project, known people, valid dates and subtasks under real tasks', () => {
  const planning = planningContext(state(), 'Create tasks for Goldwing', {})
  assert.deepEqual(
    planning.people.map(person => person.id),
    ['u1', 'u2'],
    'only active Administrators and Contributors',
  )
  const [plan] = taskPlanSuggestions(
    [
      {
        kind: 'task_plan',
        clientId: 'c1',
        projectId: 'p1',
        tasks: [
          { ref: 'T1', title: 'Install printers', assigneeId: 'u2', dueDate: '2026-11-20', priority: 'High' },
          { ref: 'T2', title: 'Test receipts', parentRef: 'T1', assigneeId: 'u1' },
          { ref: 'T3', title: 'Orphan', parentRef: 'T9' },
          { ref: 'T4', title: 'Under existing', parentTaskId: 'rollout' },
          { ref: 'T5', title: 'Under closed', parentTaskId: 'closed' },
          { ref: 'T6', title: 'Bad values', assigneeId: 'u3', dueDate: 'next week', priority: 'ASAP' },
          { ref: 'T7', title: '' },
        ],
      },
    ],
    state(),
  )
  const tasks = plan.plan.tasks
  assert.deepEqual(
    tasks.map(entry => entry.ref),
    ['T1', 'T2', 'T4', 'T6'],
  )
  assert.equal(tasks[0].assigneeName, 'Ana Reyes')
  assert.equal(tasks[1].assigneeId, undefined, 'subtasks follow their task’s assignee')
  assert.equal(tasks[2].parentTitle, 'Makati T1 rollout')
  assert.deepEqual([tasks[3].assigneeId, tasks[3].dueDate, tasks[3].priority], [undefined, undefined, undefined])
  assert.equal(plan.plan.clientName, 'Goldwing Retail')
  const [moved] = taskPlanSuggestions(
    [{ kind: 'task_plan', clientId: 'c2', projectId: 'p1', tasks: [{ title: 'x' }] }],
    state(),
  )
  assert.equal(moved.plan.clientId, 'c1', 'the project decides the client')
  for (const place of [{ projectId: 'p2' }, { projectId: 'nope' }, { clientId: 'c1' }])
    assert.deepEqual(
      taskPlanSuggestions([{ kind: 'task_plan', ...place, tasks: [{ title: 'x' }] }], state()),
      [],
      JSON.stringify(place),
    )
})

test('ticking a plan: a subtask needs its task, and unticking a task unticks its subtasks', () => {
  const plan: TaskPlan = {
    clientId: 'c1',
    clientName: 'C',
    projectId: 'p1',
    projectName: 'P',
    tasks: [
      { ref: 'T1', title: 'A' },
      { ref: 'T2', title: 'A.1', parentRef: 'T1' },
      { ref: 'T3', title: 'B' },
    ],
  }
  const all = ['T1', 'T2', 'T3']
  assert.deepEqual(togglePlanned(plan, all, 'T1'), ['T3'])
  assert.deepEqual(togglePlanned(plan, ['T3'], 'T2').sort(), ['T1', 'T2', 'T3'])
  assert.deepEqual(plannedRefs(plan, ['T2', 'T3']), ['T3'], 'a subtask without its task is not created')
})

const columns = [
  { id: 'site', name: 'Site', type: 'text' },
  {
    id: 'permits',
    name: 'Permits',
    type: 'select',
    options: [
      { id: 'o-pending', label: 'Pending' },
      { id: 'o-done', label: 'Done' },
    ],
  },
  { id: 'golive', name: 'Go-live', type: 'date' },
  { id: 'ready', name: 'Ready', type: 'checkbox' },
  { id: 'pin', name: 'PIN', type: 'secret' },
] as any[]
const loaded = (canEdit = true): any[] => [
  {
    tracker: { id: 'trk', name: 'Goldwing rollout', columns, canEdit, archived: false },
    rows: [
      {
        id: 'r1',
        version: 3,
        cells: { site: 'Makati T1', permits: 'o-pending', golive: '', ready: false },
        secretSet: {},
        taskId: '',
        position: 0,
        updatedAt: '',
      },
      {
        id: 'r2',
        version: 1,
        cells: { site: 'BGC', permits: 'o-done', golive: '2026-11-01', ready: true },
        secretSet: {},
        taskId: '',
        position: 1,
        updatedAt: '',
      },
    ],
  },
]

test('tracker changes keep known rows and typed columns, map choices to options and skip non-changes', () => {
  const [update] = trackerUpdateSuggestions(
    [
      {
        kind: 'tracker_update',
        trackerId: 'trk',
        changes: [
          { row: 1, column: 'permits', value: 'done' },
          { row: 1, column: 'Go-live', value: '2026-11-20' },
          { row: 1, column: 'PIN', value: '1234' },
          { row: 2, column: 'Permits', value: 'Done' },
          { row: 2, column: 'Ready', value: 'maybe' },
          { row: 9, column: 'Site', value: 'Nowhere' },
          { row: 1, column: 'Permits', value: 'Rejected' },
        ],
      },
    ],
    loaded(),
  )
  const rows = update.trackerChange.rows
  assert.equal(rows.length, 1)
  assert.deepEqual(rows[0].cells, { permits: 'o-done', golive: '2026-11-20' })
  assert.equal(rows[0].version, 3)
  assert.equal(rows[0].label, 'Makati T1')
  assert.deepEqual(rows[0].changes, [
    { column: 'Permits', from: 'Pending', to: 'Done' },
    { column: 'Go-live', from: '—', to: '2026-11-20' },
  ])
  const change = { kind: 'tracker_update', trackerId: 'trk', changes: [{ row: 1, column: 'Ready', value: true }] }
  assert.deepEqual(trackerUpdateSuggestions([change], loaded(false)), [], 'the person cannot edit it')
  assert.deepEqual(trackerUpdateSuggestions([{ ...change, trackerId: 'other' }], loaded()), [], 'not read for this')
})

test('time logs: only matching open tasks are offered, and entries follow the task’s time-log rules', () => {
  const context = timeLogContext(state(true), { id: 'u1' }, 'Log 2 hours on Go Live – Makati T1', {})
  assert.equal(context.seedsOn, true)
  assert.equal(context.tasks[0].id, 'rollout')
  assert.deepEqual(context.tasks[0].subtasks, [{ id: 'go-live', title: 'Go Live' }])
  assert.equal(context.tasks[0].seedsTaskId, 's-go')
  assert.ok(!context.tasks.some(entry => ['closed', 'archived', 'go-live'].includes(entry.id)))

  const today = '2026-11-13'
  const [onSubtask] = timeLogSuggestions(
    [{ kind: 'time_log', taskId: 'go-live', date: 'today', hours: 2, note: '' }],
    state(true),
    today,
  )
  assert.equal(onSubtask.timeLog.taskId, 'rollout', 'a subtask named as the task logs on its task')
  assert.equal(onSubtask.timeLog.subtaskId, 'go-live')
  assert.equal(onSubtask.timeLog.note, 'Go Live – Makati T1 rollout')
  assert.equal(onSubtask.timeLog.seedsTaskName, 'Go Live')
  assert.equal(onSubtask.timeLog.problem, undefined)

  const [odd] = timeLogSuggestions(
    [{ kind: 'time_log', taskId: 'rollout', date: today, hours: 1.1, note: 'x' }],
    state(true),
    today,
  )
  assert.match(odd.timeLog.problem || '', /15-minute/)
  const [future] = timeLogSuggestions(
    [{ kind: 'time_log', taskId: 'rollout', date: '2026-12-01', hours: 1, note: 'x' }],
    state(true),
    today,
  )
  assert.match(future.timeLog.problem || '', /future/)
  const [untagged] = timeLogSuggestions(
    [{ kind: 'time_log', taskId: 'printers', date: today, hours: 1, note: 'Specs call' }],
    state(true),
    today,
  )
  assert.match(untagged.timeLog.problem || '', /Seeds task/)
  const [plain] = timeLogSuggestions(
    [{ kind: 'time_log', taskId: 'printers', date: today, hours: 0.5, category: 'Meeting' }],
    state(false),
    today,
  )
  assert.deepEqual([plain.timeLog.seeds, plain.timeLog.category, plain.timeLog.problem], [false, 'Meeting', undefined])
  assert.deepEqual(
    timeLogSuggestions([{ kind: 'time_log', taskId: 'closed', date: today, hours: 1 }], state(), today),
    [],
  )
})
