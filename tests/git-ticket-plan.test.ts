import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { type GitGeneration, planGitGeneration } from '../src/features/trackers/gitGeneration'
import type { TrackerColumn } from '../src/features/trackers/trackerModel'
import { tasksFromDrafts } from '../src/features/trackers/trackerTaskDrafts'
import { entryStatusText } from '../src/features/trackers/gitTicketsApi'
import { gitEntryIds } from '../server/trackers/git-tracker-ids'
import {
  canGenerate,
  dayOf,
  entryIdOfSourceKey,
  entryOut,
  failureText,
  gitSourceKey,
  issueIds,
  mappingForTicket,
  missingWork,
  plannedIds,
  STALE_PROCESSING_MS,
  ticketSnapshot,
} from '../server/trackers/git-ticket-plan'

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

const issue = {
  id: '0b8a6f1e-3c2d-4e5f-9a8b-7c6d5e4f3a2b',
  gitlab_id: '901',
  number: 7051,
  repository: 'barter-11/bxi-backend',
  title: 'Send transaction to EIS portal',
  body: 'POS: SALE, RETURN',
  html_url: 'https://gitlab.example.com/barter-11/bxi-backend/-/issues/7051',
  state: 'opened',
  labels: ['EIS Development', ' ', 7],
  assignees: ['emonding'],
  creator: 'pcabalo',
  milestone: 'Ongoing',
  due_date: '2026-11-22T00:00:00.000Z',
  repository_id: '42',
  instance_url: 'https://gitlab.example.com',
}

test('a Work Hub ticket is read the way generation needs it', () => {
  const ticket = ticketSnapshot('gitlab', issue)
  assert.equal(ticket.number, 7051)
  assert.equal(ticket.state, 'open', 'anything but closed is open')
  assert.deepEqual(ticket.labels, ['EIS Development', '7'])
  assert.equal(ticket.author, 'pcabalo')
  assert.equal(ticket.dueDate, '2026-11-22', 'a date sent as a timestamp keeps its day')
  assert.equal(ticketSnapshot('github', issue).dueDate, null, 'GitHub tickets have no due date')
  assert.equal(dayOf(new Date('2026-11-23T00:00:00Z')), '2026-11-23')
  assert.equal(dayOf('soon'), '')
  assert.deepEqual(issueIds('gitlab', issue), { issueId: 901, repositoryId: 42 })
  assert.deepEqual(issueIds('github', { github_id: 5, repository_id: null }), { issueId: 5, repositoryId: 0 })
})

test('a ticket finds its repository mapping by id, else by path before a sync has read the id', () => {
  const mappings = [
    { provider: 'gitlab', instance_url: 'https://gitlab.example.com', repository_id: '42', repository_path: 'x/renamed' },
    { provider: 'gitlab', instance_url: 'https://gitlab.example.com', repository_id: '43', repository_path: 'barter-11/bxi' },
    { provider: 'gitlab', instance_url: 'https://gitlab.com', repository_id: '44', repository_path: 'barter-11/bxi' },
    { provider: 'github', instance_url: 'https://github.com', repository_id: '45', repository_path: 'barter-11/bxi' },
  ]
  const ticket = { provider: 'gitlab' as const, instanceUrl: 'https://gitlab.example.com', repository: 'whatever' }
  assert.equal(mappingForTicket(mappings, { ...ticket, repositoryId: 42 })?.repository_id, '42', 'renamed: by id')
  assert.equal(
    mappingForTicket(mappings, { ...ticket, repositoryId: 0, repository: 'Barter-11/BXI' })?.repository_id,
    '43',
    'no id yet: by path, same instance',
  )
  assert.equal(mappingForTicket(mappings, { ...ticket, repositoryId: 99, repository: 'nope/nope' }), null)
})

const columns: TrackerColumn[] = [
  { id: 'title', name: 'Title', type: 'text' },
  { id: 'step', name: 'Step', type: 'text' },
  { id: 'retest', name: 'QA retest', type: 'checkbox' },
]
const generation: GitGeneration = {
  version: 1,
  rows: [
    {
      key: 'ticket',
      name: 'Ticket',
      cells: { title: { from: 'ticket', field: 'title' }, retest: { from: 'fixed', value: 'true' } },
      when: [],
      work: 'task',
      task: { title: '#{ticket.number} {ticket.title}', description: '{ticket.url}', due: { from: 'ticket' } },
    },
    {
      key: 'dev',
      name: 'Development',
      cells: { step: { from: 'fixed', value: 'Development' } },
      when: [],
      work: 'subtask',
      parentKey: 'ticket',
      task: { title: 'Development', description: '', due: { from: 'none' } },
    },
  ],
  columnRules: [
    {
      key: 'retest',
      columnId: 'retest',
      rows: 'all',
      when: [],
      task: { title: '{column} for {row}', description: '', due: { from: 'none' } },
    },
  ],
}
const entryId = '6f1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'
const workspace = (items: any[] = []) => ({
  clients: [{ id: 'barter', name: 'Barter' } as any],
  projects: [{ id: 'bxi', name: 'BXI', clientId: 'barter', status: 'Active' } as any],
  items,
  accounts: [{ id: 'u1', name: 'Phillip' }],
  taskSettings: { statuses: [{ label: 'Open' }, { label: 'Done', closed: true }] } as any,
})

test('Tasks get their planned ids, so a retry makes only what is missing', () => {
  const plan = planGitGeneration({
    generation,
    columns,
    ticket: ticketSnapshot('gitlab', issue),
    clientId: 'barter',
    projectId: 'bxi',
    assigneeId: 'u1',
    idFor: gitEntryIds(entryId),
  })
  assert.deepEqual(plan.errors, [])
  assert.equal(plan.work.length, 3, 'the Ticket Task, its Development Subtask, and a retest Subtask')

  const first = missingWork(plan, new Set())
  assert.equal(first.drafts[1].parentIndex, 0, 'a Subtask made in the same batch points at its Task by index')
  const made = tasksFromDrafts(workspace(), first.drafts, {
    today: '2026-11-20',
    newId: plannedIds(first.ids, () => 'fresh'),
  })
  assert.deepEqual(
    made.made.map(item => item.id),
    plan.work.map(work => work.id),
  )
  const [task, dev, retest] = made.made
  assert.equal(task.title, '#7051 Send transaction to EIS portal')
  assert.equal(task.dueDate, '2026-11-22')
  assert.equal(task.clientId, 'barter')
  assert.equal(task.assignedToUserId, 'u1')
  assert.equal(dev.parentTaskId, task.id)
  assert.equal(retest.parentTaskId, task.id)
  assert.ok(made.activity.every(entry => entry.id === 'fresh'), 'activity entries get fresh ids')

  // Retried after the Task was saved but before the rest: only the Subtasks, under the existing Task.
  const again = missingWork(plan, new Set([task.id]))
  assert.deepEqual(again.ids, [dev.id, retest.id])
  assert.equal(again.drafts[0].parentTaskId, task.id)
  assert.equal(again.drafts[0].parentIndex, undefined)
  const second = tasksFromDrafts(workspace([task]), again.drafts, { today: '2026-11-20', newId: plannedIds(again.ids, () => 'x') })
  assert.deepEqual(
    second.made.map(item => [item.id, item.parentTaskId]),
    [
      [dev.id, task.id],
      [retest.id, task.id],
    ],
  )
  // Everything made: nothing to do.
  assert.equal(missingWork(plan, new Set(plan.work.map(work => work.id))).drafts.length, 0)
  // Planning the same entry again gives the same ids.
  assert.deepEqual(
    planGitGeneration({
      generation,
      columns,
      ticket: ticketSnapshot('gitlab', issue),
      clientId: 'barter',
      projectId: 'bxi',
      assigneeId: 'u1',
      idFor: gitEntryIds(entryId),
    }).work.map(work => work.id),
    plan.work.map(work => work.id),
  )
})

test('entries: status, retry rules, source keys and messages', () => {
  const now = Date.parse('2026-11-20T08:00:00Z')
  const entry = entryOut({
    id: entryId,
    tracker_id: 't1',
    provider: 'gitlab',
    repository_path: 'barter-11/bxi',
    issue_number: '7051',
    title_snapshot: 'Send',
    issue_url: 'u',
    client_id: 'barter',
    project_id: 'bxi',
    generation_status: 'Failed',
    generation_error: 'The client is archived.',
    attempts: 2,
    added_by: 'u1',
    added_by_name: 'Phillip',
    created_at: 'a',
    updated_at: '2026-11-20T07:59:00Z',
  })
  assert.equal(entry.number, 7051)
  assert.equal(canGenerate(entry, now), true, 'a failed entry can be retried')
  assert.equal(canGenerate({ ...entry, status: 'Completed' }, now), false)
  assert.equal(canGenerate({ ...entry, status: 'Processing' }, now), false, 'not while another attempt runs')
  assert.equal(
    canGenerate({ ...entry, status: 'Processing', updatedAt: new Date(now - STALE_PROCESSING_MS).toISOString() }, now),
    true,
    'an attempt cut off long ago can be retried',
  )
  assert.equal(entryOut({ generation_status: 'weird' }).status, 'Pending')
  assert.equal(entryIdOfSourceKey(gitSourceKey(entryId)), entryId)
  assert.equal(entryIdOfSourceKey('A-12'), '')
  assert.equal(failureText(new Error('  two\n lines ')), 'two lines')
  assert.equal(entryStatusText({ status: 'Completed', workCount: 3 }), 'Added · 3 Tasks')
  assert.equal(entryStatusText({ status: 'Completed', workCount: 1 }), 'Added · 1 Task')
  assert.equal(entryStatusText({ status: 'Failed' }), 'Failed')
})

test('Work Hub offers Add to GIT Tracker; the GIT Tracker lists its tickets with a Client filter', () => {
  const routes = read('server/trackers/tracker-git-tickets.ts')
  for (const route of [
    "'/api/tracker-git/tickets/:provider/:ticketId'",
    "'/api/trackers/:id/git-tickets'",
    "'/api/trackers/:id/git-tickets/:entryId/retry'",
    "'/api/trackers/:id/git-tickets/:entryId'",
  ])
    assert.ok(routes.includes(route), route)
  assert.match(routes, /already in that GIT Tracker/, 'a ticket is added once')
  assert.match(routes, /is not mapped to a Client and Project yet/)
  assert.match(routes, /canCreateWork\(state, user/)
  assert.match(read('server/trackers/trackers.ts'), /trackerRowRoutes\(app, core, sheetAccess, sheetWrite, automations, gitTickets\.hiddenSourceKeys\)/)
  assert.match(read('server/trackers/tracker-row-routes.ts'), /hidden\.has\(String\(entry\.source_key/)
  const hub = read('src/features/integrations/GithubHub.tsx')
  assert.match(hub, /<AddToGitTracker/)
  assert.match(read('src/features/trackers/AddToGitTracker.tsx'), /Add to GIT Tracker/)
  const screen = read('src/features/trackers/TrackerScreen.tsx')
  assert.match(screen, /<GitTicketsPanel/)
  assert.match(screen, /gitRowFilter \? rows\.filter\(row => gitRowFilter\.has\(row\.id\)\) : rows/)
  assert.doesNotMatch(screen, /comes in the next update/)
})
