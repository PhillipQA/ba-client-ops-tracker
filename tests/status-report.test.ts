import test from 'node:test'
import assert from 'node:assert/strict'
import { defaultTaskSettings } from '../src/app/data'
import {
  cleanStatusEmail,
  projectClientIds,
  reportWeek,
  statusEmail,
  statusFacts,
} from '../src/features/ai/statusReport'

const asOf = '2026-11-13' // Friday
const task = (id: string, extra: any = {}) => ({
  id,
  title: id,
  type: 'Task',
  status: 'Open',
  priority: 'Medium',
  waitingOn: 'Me',
  owner: '',
  clientId: 'c1',
  projectId: 'p1',
  dateRaised: '2026-11-01',
  followUpDate: '',
  description: '',
  resolution: '',
  source: 'Internal',
  ...extra,
})
const columns = [
  { id: 'branch', name: 'Branch', type: 'text' },
  { id: 'live', name: 'Go Live Date', type: 'date' },
  { id: 'hw', name: 'Hardware', type: 'checkbox' },
]
const workspace = {
  clients: [{ id: 'c1', name: 'Picture City', email: 'it@picturecity.ph' }],
  projects: [
    { id: 'p1', name: 'PCI - SM Tarlac', clientId: 'c1', contractNumber: 'SLSS-1' },
    { id: 'p2', name: 'Other' },
  ],
  items: [
    task('Go live', { status: 'Resolved', resolvedDate: '2026-11-11' }),
    task('Hardware', { parentTaskId: 'Go live', status: 'Resolved', resolvedDate: '2026-11-12T03:00:00.000Z' }),
    task('Last week', { status: 'Resolved', resolvedDate: '2026-11-07' }),
    task('By event', { status: 'Resolved' }),
    task('Training', { dueDate: '2026-11-18' }),
    task('Far', { dueDate: '2026-12-18' }),
    task('Late', { dueDate: '2026-11-10' }),
    task('BIR permit', { waitingOn: 'Client', followUpDate: '2026-11-14' }),
    task('API fix', { waitingOn: 'Developer' }),
    task('UAT', {
      docHubDocuments: [{ id: 'd', title: 'UAT Sign Off', status: 'PARTIALLY_SIGNED', signed: 1, total: 3 }],
    }),
    task('Elsewhere', { projectId: 'p2', status: 'Resolved', resolvedDate: '2026-11-12' }),
    task('Logged', {
      timeEntries: [
        { id: '1', date: '2026-11-10', hours: 2, userName: 'Ana' },
        { id: '2', date: '2026-11-12', hours: 1.5, userName: 'Ben' },
        { id: '3', date: '2026-11-03', hours: 9, userName: 'Ana' },
      ],
    }),
  ],
  workEvents: [{ id: 'e', taskId: 'By event', action: 'completed', date: '2026-11-13' }],
  activity: [
    { id: 'n1', projectId: 'p1', date: '2026-11-12', text: 'Client moved UAT to Monday.' },
    { id: 'n2', projectId: 'p1', date: '2026-11-02', text: 'Old note.' },
  ],
}
const trackers = [
  {
    tracker: { id: 't', name: 'Site rollout', projectId: 'p1', projectIds: ['p1'], columns } as any,
    rows: [
      { id: 'r1', cells: { branch: 'Tarlac', live: '2026-11-17' }, position: 0 },
      { id: 'r2', cells: { branch: 'Clark', live: '2026-11-05' }, position: 1 },
      { id: 'r3', cells: { branch: 'Davao', live: '2026-11-03', hw: true }, position: 2 },
    ] as any,
  },
  { tracker: { id: 'x', name: 'Other project', projectId: 'p2', projectIds: ['p2'], columns } as any, rows: [] },
]

test('the reported week is Monday to Friday, also when written on a weekend', () => {
  assert.deepEqual(reportWeek('2026-11-13'), { start: '2026-11-09', end: '2026-11-13', asOf: '2026-11-13' })
  assert.deepEqual(reportWeek('2026-11-15'), { start: '2026-11-09', end: '2026-11-13', asOf: '2026-11-15' })
  assert.deepEqual(reportWeek('2026-11-09'), { start: '2026-11-09', end: '2026-11-13', asOf: '2026-11-09' })
})

test('client report: done this week, coming up, needs the client, risks and sites; nothing internal', () => {
  const facts = statusFacts({
    state: workspace,
    projectId: 'p1',
    audience: 'client',
    asOf,
    settings: defaultTaskSettings,
    trackers,
  })!
  assert.deepEqual(
    facts.done.items.map(item => item.title),
    ['Go live', 'Hardware', 'By event'],
  )
  assert.equal(facts.done.items[1].parentTitle, 'Go live')
  assert.deepEqual(
    facts.next.items.map(item => item.title),
    ['Training'],
  )
  assert.deepEqual(
    facts.overdue.items.map(item => item.title),
    ['Late'],
  )
  assert.deepEqual(
    facts.needsClient.items.map(item => item.title),
    ['BIR permit'],
  )
  assert.deepEqual(facts.signatures, [{ title: 'UAT Sign Off', task: 'UAT', signed: 1, total: 3 }])
  assert.equal(facts.trackers.length, 1, 'Only the project’s trackers')
  assert.deepEqual(facts.trackers[0], {
    name: 'Site rollout',
    sites: 3,
    complete: 1,
    upcoming: [{ site: 'Tarlac', date: '2026-11-17', openSteps: 1, totalSteps: 1 }],
    late: [{ site: 'Clark', date: '2026-11-05', openSteps: 1, totalSteps: 1 }],
  })
  assert.equal(facts.client?.email, 'it@picturecity.ph')
  assert.equal(facts.hours, undefined)
  assert.equal(facts.notes, undefined)
  assert.equal(facts.waitingOthers, undefined)

  const email = statusEmail(facts)
  assert.equal(email.subject, 'PCI - SM Tarlac: weekly update (Nov 9 to Nov 13)')
  assert.match(email.body, /^Hi,\n\nHere is this week's update on PCI - SM Tarlac\./)
  assert.match(email.body, /Done this week\n- Go live\n- Hardware \(Go live\)\n- By event/)
  assert.match(email.body, /Coming up\n- Training: due Nov 18/)
  assert.match(
    email.body,
    /Needs your input\n- BIR permit\n- UAT Sign Off \(UAT\): awaiting your signature, 1 of 3 signed/,
  )
  assert.match(email.body, /Watch-outs\n- Late: due Nov 10\n- Clark: go-live was Nov 5, 1 steps still open/)
  assert.doesNotMatch(email.body, /API fix|Ana|Ben|Client moved/, 'No internal work, people or notes')
})

test('team report adds who waits on others, hours by person and this week’s notes', () => {
  const facts = statusFacts({
    state: workspace,
    projectId: 'p1',
    audience: 'team',
    asOf,
    settings: defaultTaskSettings,
    trackers,
  })!
  assert.deepEqual(
    facts.waitingOthers?.items.map(item => [item.title, item.waitingOn]),
    [['API fix', 'Developer']],
  )
  assert.deepEqual(facts.hours, {
    total: 3.5,
    people: [
      { name: 'Ana', hours: 2 },
      { name: 'Ben', hours: 1.5 },
    ],
  })
  assert.deepEqual(facts.notes, ['Client moved UAT to Monday.'])
  const email = statusEmail(facts)
  assert.match(email.body, /Waiting on others\n- API fix \(Developer\)/)
  assert.match(email.body, /Time logged: 3.5 h\n- Ana: 2 h\n- Ben: 1.5 h/)
  assert.match(email.body, /Notes\n- Client moved UAT to Monday\./)
})

test('a project the person cannot see gives nothing; a quiet week still reads well', () => {
  assert.equal(
    statusFacts({ state: workspace, projectId: 'hidden', audience: 'client', asOf, settings: defaultTaskSettings }),
    null,
  )
  const quiet = statusFacts({
    state: { ...workspace, items: [] },
    projectId: 'p1',
    audience: 'client',
    asOf,
    settings: defaultTaskSettings,
  })!
  assert.match(statusEmail(quiet).body, /There were no task changes this week\./)
})

test('a project shared by two clients: a client report counts only that client’s work', () => {
  const shared = {
    clients: [
      { id: 'c1', name: 'Picture City', email: 'it@picturecity.ph' },
      { id: 'c2', name: 'Cinema Co' },
    ],
    projects: [{ id: 'p9', name: 'Release 5.2' }],
    items: [
      task('For Picture City', { projectId: 'p9', clientId: 'c1', dueDate: '2026-11-18' }),
      task('For Cinema Co', { projectId: 'p9', clientId: 'c2', dueDate: '2026-11-17' }),
    ],
    activity: [
      { id: 'a', projectId: 'p9', clientId: 'c2', date: '2026-11-12', text: 'Cinema Co note' },
      { id: 'b', projectId: 'p9', date: '2026-11-12', text: 'Shared note' },
    ],
  }
  const sharedTrackers = [
    { tracker: { id: 'a', name: 'PCI sites', projectIds: ['p9'], clientIds: ['c1'], columns } as any, rows: [] },
    { tracker: { id: 'b', name: 'Cinema sites', projectIds: ['p9'], clientIds: ['c2'], columns } as any, rows: [] },
  ]
  assert.deepEqual(projectClientIds(shared, 'p9'), ['c1', 'c2'])
  assert.deepEqual(projectClientIds(workspace, 'p1'), ['c1'], 'A project with its own client has just that one')
  const base = { state: shared, projectId: 'p9', asOf, settings: defaultTaskSettings, trackers: sharedTrackers }

  const forOne = statusFacts({ ...base, audience: 'client', clientId: 'c1' })!
  assert.deepEqual(
    forOne.next.items.map(item => item.title),
    ['For Picture City'],
  )
  assert.equal(forOne.client?.name, 'Picture City')
  assert.deepEqual(
    forOne.trackers.map(tracker => tracker.name),
    ['PCI sites'],
  )

  const everyone = statusFacts({ ...base, audience: 'team' })!
  assert.equal(everyone.next.total, 2)
  assert.equal(everyone.client, undefined, 'No single client for a shared project')
  assert.deepEqual(statusFacts({ ...base, audience: 'team', clientId: 'c1' })!.notes, ['Shared note'])
  assert.equal(statusFacts({ ...base, audience: 'client', clientId: 'nope' }), null, 'Not one of its clients')
})

test('the AI email is kept only with a subject and a body, trimmed to email size', () => {
  assert.equal(cleanStatusEmail({ subject: 'x' }), null)
  assert.deepEqual(cleanStatusEmail({ subject: ' Weekly\nupdate ', body: 'Hi\r\n\r\n\r\n\r\nThanks ' }), {
    subject: 'Weekly update',
    body: 'Hi\n\nThanks',
  })
})
