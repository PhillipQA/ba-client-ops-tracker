import test from 'node:test'
import assert from 'node:assert/strict'
import {
  conditionsHold,
  normalizeGitGeneration,
  planGitGeneration,
  renderTemplate,
  resolveCell,
  type GitGeneration,
  type GitTicketSnapshot,
} from '../src/features/trackers/gitGeneration'
import type { TrackerColumn } from '../src/features/trackers/trackerModel'
import { gitEntryIds, uuidV5 } from '../server/trackers/git-tracker-ids'

const columns: TrackerColumn[] = [
  { id: 'title', name: 'Title', type: 'text' },
  { id: 'step', name: 'Step', type: 'text' },
  {
    id: 'type',
    name: 'Type',
    type: 'select',
    options: [
      { id: 'o-defect', label: 'Defect', color: 'red' },
      { id: 'o-enh', label: 'Enhancement', color: 'blue' },
    ],
  },
  { id: 'labels', name: 'Labels', type: 'multiselect', options: [{ id: 'o-bug', label: 'bug', color: 'red' }] },
  { id: 'number', name: 'Ticket #', type: 'number' },
  { id: 'due', name: 'Due', type: 'date' },
  { id: 'retest', name: 'QA retest', type: 'checkbox' },
  { id: 'owner', name: 'Owner', type: 'person' },
  { id: 'link', name: 'Git issue', type: 'link' },
]

const ticket: GitTicketSnapshot = {
  provider: 'gitlab',
  repository: 'pos/barter',
  number: 142,
  title: 'Login error on POS',
  body: 'Steps…',
  url: 'https://gitlab.com/pos/barter/-/issues/142',
  state: 'open',
  labels: ['bug', 'priority::high'],
  assignees: ['dev1'],
  author: 'qa1',
  milestone: 'Nov release',
  dueDate: '2026-11-30',
}

const mapping = (title: string, due: any = { from: 'none' }) => ({ title, description: '', due })

/** Analysis, Dev and QA rows: Analysis and Dev make Tasks, QA a Subtask of Dev; a retest Subtask for bugs. */
const generation: GitGeneration = {
  version: 1,
  rows: [
    {
      key: 'analysis',
      name: 'Analysis',
      cells: {
        title: { from: 'ticket', field: 'title' },
        step: { from: 'fixed', value: 'Analysis' },
        number: { from: 'ticket', field: 'number' },
      },
      when: [],
      work: 'task',
      task: mapping('#{ticket.number} {row}: {ticket.title}'),
    },
    {
      key: 'dev',
      name: 'Dev',
      cells: {
        step: { from: 'fixed', value: 'Dev' },
        type: { from: 'fixed', value: 'Defect' },
        labels: { from: 'ticket', field: 'labels' },
        due: { from: 'ticket', field: 'due' },
        retest: { from: 'fixed', value: 'true' },
        link: { from: 'ticket', field: 'url' },
      },
      when: [],
      work: 'task',
      task: mapping('#{ticket.number} Dev – {col:type}', { from: 'column', columnId: 'due' }),
    },
    {
      key: 'qa',
      name: 'QA',
      cells: { step: { from: 'fixed', value: 'QA' } },
      when: [],
      work: 'subtask',
      parentKey: 'dev',
      task: mapping('QA {ticket.repository}#{ticket.number}', { from: 'ticket' }),
    },
    {
      key: 'notes',
      name: 'Notes',
      cells: { step: { from: 'fixed', value: 'Notes' } },
      when: [{ on: 'ticket', field: 'state', op: 'equals', value: 'closed' }],
      work: 'none',
    },
  ],
  columnRules: [
    {
      key: 'retest',
      columnId: 'retest',
      rows: 'all',
      when: [
        { on: 'cell', columnId: 'retest', op: 'equals', value: 'true' },
        { on: 'ticket', field: 'labels', op: 'equals', value: 'BUG' },
      ],
      task: mapping('{column} for {row}'),
    },
  ],
}

const entry = '7d8c1f5e-2b9a-4c3d-8e6f-0a1b2c3d4e5f'
const plan = (overrides: Partial<Parameters<typeof planGitGeneration>[0]> = {}) =>
  planGitGeneration({
    generation,
    columns,
    ticket,
    clientId: 'client-a',
    projectId: 'project-x',
    assigneeId: 'user-1',
    idFor: gitEntryIds(entry),
    ...overrides,
  })

test('uuidV5 matches the RFC 4122 example and stays stable', () => {
  assert.equal(uuidV5('www.example.com', '6ba7b810-9dad-11d1-80b4-00c04fd430c8'), '2ed6657d-e927-568b-95e1-2665a8aea6a2')
  assert.equal(gitEntryIds(entry)('work', 'row:dev'), gitEntryIds(entry)('work', 'row:dev'))
  assert.notEqual(gitEntryIds(entry)('work', 'row:dev'), gitEntryIds(entry)('row', 'dev'))
  assert.throws(() => uuidV5('x', 'not-a-uuid'))
})

test('A valid template is kept as written', () => {
  const { generation: clean, errors } = normalizeGitGeneration(generation, columns)
  assert.deepEqual(errors, [])
  assert.equal(clean.rows.length, 4)
  assert.equal(clean.columnRules.length, 1)
})

test('Template mistakes are reported in plain words', () => {
  const broken = {
    rows: [
      { key: 'Bad Key', name: '', cells: { owner: { from: 'fixed', value: 'x' } }, work: 'task', task: { title: '' } },
      { key: 'dup', name: 'A', cells: { number: { from: 'fixed', value: 'abc' } }, work: 'none' },
      { key: 'dup', name: 'B', cells: { due: { from: 'ticket', field: 'title' } }, work: 'subtask', parentKey: 'nope', task: { title: '{ticket.nope}' } },
      { key: 'c', name: 'C', cells: { type: { from: 'fixed', value: 'Bug' }, gone: { from: 'fixed', value: '1' } }, when: [{ on: 'cell', columnId: 'gone', op: 'equals', value: 'x' }], work: 'none' },
    ],
    columnRules: [{ key: 'r', columnId: 'missing', task: { title: 'x' } }],
  }
  const { errors } = normalizeGitGeneration(broken, columns)
  const text = errors.join('\n')
  for (const expected of [
    /key must be lowercase/,
    /enter a name/,
    /Owner cannot be filled/,
    /enter how its title is made/,
    /already uses the key "dup"/,
    /"abc" does not fit Ticket #/,
    /ticket's title cannot go in Due/,
    /\{ticket\.nope\} is not a field/,
    /must belong under a row that makes a Task/,
    /"Bug" does not fit Type/,
    /column that is not in the template/,
    /condition refers to a ticket field or column that does not exist/,
    /choose a column of the template/,
  ])
    assert.match(text, expected)
  assert.match(normalizeGitGeneration({ rows: [] }, columns).errors.join('\n'), /at least one row/)
  assert.match(
    normalizeGitGeneration({ rows: [{ key: 'a', name: 'A', work: 'none' }] }, columns).errors.join('\n'),
    /makes no Tasks/,
  )
})

test('One ticket makes several rows, Tasks and Subtasks under the mapped Client and Project', () => {
  const result = plan()
  assert.deepEqual(result.errors, [])
  assert.deepEqual(
    result.rows.map(row => row.key),
    ['analysis', 'dev', 'qa'],
    'the Notes row only applies to closed tickets',
  )
  assert.deepEqual(
    result.work.map(item => [item.ruleKey, item.type, item.title]),
    [
      ['row:analysis', 'Task', '#142 Analysis: Login error on POS'],
      ['row:dev', 'Task', '#142 Dev – Defect'],
      ['row:qa', 'Subtask', 'QA pos/barter#142'],
      ['col:retest:dev', 'Subtask', 'QA retest for Dev'],
    ],
  )
  const dev = result.work.find(item => item.ruleKey === 'row:dev')!
  for (const item of result.work) {
    assert.equal(item.clientId, 'client-a')
    assert.equal(item.projectId, 'project-x')
    assert.equal(item.assignedToUserId, 'user-1')
    if (item.type === 'Subtask') assert.equal(item.parentId, dev.id, `${item.ruleKey} sits under the Dev Task`)
    else assert.equal(item.parentId, null)
  }
  assert.equal(dev.dueDate, '2026-11-30')
  assert.equal(result.work.find(item => item.ruleKey === 'col:retest:dev')!.columnId, 'retest')
  const devRow = result.rows.find(row => row.key === 'dev')!
  assert.deepEqual(devRow.cells, {
    step: 'Dev',
    type: 'o-defect',
    labels: ['o-bug'],
    due: '2026-11-30',
    retest: true,
    link: 'https://gitlab.com/pos/barter/-/issues/142',
  })
  assert.ok(result.skipped.some(skip => skip.ruleKey === 'row:notes'))
  assert.ok(result.skipped.some(skip => skip.ruleKey === 'col:retest:analysis'), 'Analysis has no retest tick')
})

test('Planning the same entry twice gives the same ids; another entry gives new ones', () => {
  const first = plan()
  const again = plan()
  assert.deepEqual(
    again.work.map(item => item.id),
    first.work.map(item => item.id),
  )
  assert.deepEqual(
    again.rows.map(row => row.id),
    first.rows.map(row => row.id),
  )
  const other = plan({ idFor: gitEntryIds('11111111-2222-4333-8444-555555555555') })
  assert.ok(other.work.every(item => !first.work.some(previous => previous.id === item.id)))
  assert.equal(new Set(first.work.map(item => item.id)).size, first.work.length)
})

test('A Subtask row whose Task row did not apply is skipped, never left without a parent', () => {
  const gated: GitGeneration = {
    ...generation,
    rows: generation.rows.map(row =>
      row.key === 'dev' ? { ...row, when: [{ on: 'ticket', field: 'labels', op: 'contains', value: 'enhancement' }] } : row,
    ),
  }
  const result = plan({ generation: gated })
  assert.deepEqual(result.errors, [])
  assert.ok(!result.work.some(item => item.ruleKey === 'row:qa'))
  assert.ok(result.skipped.some(skip => skip.ruleKey === 'row:qa' && /no parent Task/.test(skip.reason)))
  assert.ok(result.work.every(item => item.type === 'Task' || result.work.some(task => task.id === item.parentId)))
})

test('Nothing is planned without a mapped Client and Project, or with a broken template', () => {
  assert.match(plan({ clientId: '' }).errors.join(), /repository must be mapped/)
  assert.match(plan({ projectId: '' }).errors.join(), /repository must be mapped/)
  const broken = plan({ generation: { ...generation, rows: [{ ...generation.rows[2], parentKey: 'missing' }] } })
  assert.ok(broken.errors.length > 0)
  assert.deepEqual(broken.work, [])
  assert.deepEqual(broken.rows, [])
})

test('Too many Tasks for one ticket stops generation', () => {
  const many: GitGeneration = {
    version: 1,
    rows: Array.from({ length: 20 }, (_, at) => ({
      key: `r${at}`,
      name: `R${at}`,
      cells: { retest: { from: 'fixed' as const, value: 'true' } },
      when: [],
      work: 'task' as const,
      task: mapping('{row}'),
    })),
    columnRules: [1, 2, 3].map(n => ({ key: `c${n}`, columnId: 'retest', rows: 'all' as const, when: [], task: mapping('{row}') })),
  }
  assert.match(plan({ generation: many }).errors.join(), /make 80 Tasks and Subtasks; the most is 60/)
  const atLimit = { ...many, columnRules: many.columnRules.slice(0, 2) }
  assert.deepEqual(plan({ generation: atLimit }).errors, [], '60 is still allowed')
})

test('Conditions: case-insensitive text, any item of a list, and checkbox ticks', () => {
  const hold = (condition: any, cells = {}) => conditionsHold([condition], ticket, cells, columns)
  assert.equal(hold({ on: 'ticket', field: 'title', op: 'contains', value: 'LOGIN' }), true)
  assert.equal(hold({ on: 'ticket', field: 'labels', op: 'equals', value: 'priority::high' }), true)
  assert.equal(hold({ on: 'ticket', field: 'labels', op: 'not_contains', value: 'wontfix' }), true)
  assert.equal(hold({ on: 'ticket', field: 'milestone', op: 'is_empty', value: '' }), false)
  assert.equal(hold({ on: 'ticket', field: 'state', op: 'not_equals', value: 'closed' }), true)
  assert.equal(hold({ on: 'cell', columnId: 'retest', op: 'equals', value: 'false' }, { retest: false }), true)
  assert.equal(hold({ on: 'cell', columnId: 'retest', op: 'equals', value: 'true' }, { retest: false }), false)
  assert.equal(hold({ on: 'cell', columnId: 'type', op: 'equals', value: 'defect' }, { type: 'o-defect' }), true)
  assert.equal(hold({ on: 'cell', columnId: 'step', op: 'equals', value: 'false' }, { step: 'false' }), true)
  assert.equal(conditionsHold([], ticket, {}, columns), true)
})

test('Values that do not fit a column are left empty', () => {
  const byId = (id: string) => columns.find(column => column.id === id)!
  assert.equal(resolveCell(byId('due'), { from: 'ticket', field: 'due' }, { ...ticket, dueDate: null }), '')
  assert.equal(resolveCell(byId('number'), { from: 'fixed', value: '' }, ticket), null)
  assert.equal(resolveCell(byId('type'), { from: 'fixed', value: 'enhancement' }, ticket), 'o-enh')
  assert.equal(resolveCell(byId('title'), { from: 'fixed', value: 'a\nb' }, ticket), 'a b')
  assert.equal(
    renderTemplate('{ticket.nope} {row}', ticket, { rowName: 'Dev', cells: {}, columns }),
    '{ticket.nope} Dev',
  )
})
