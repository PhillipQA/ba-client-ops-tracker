import test from 'node:test'
import assert from 'node:assert/strict'
import { defaultTaskSettings } from '../src/app/data'
import {
  addDayKeys,
  briefFacts,
  briefIsClear,
  cleanBriefSummary,
  previousWorkday,
  waitingEmailsFrom,
} from '../src/features/ai/brief'

const today = '2026-11-13' // a Friday
const task = (id: string, extra: any = {}) => ({
  id,
  title: id,
  type: 'Task',
  status: 'Open',
  priority: 'Medium',
  waitingOn: 'Me',
  owner: '',
  assignedToUserId: 'ana',
  clientId: 'c1',
  projectId: 'p1',
  dateRaised: '2026-11-01',
  followUpDate: '',
  description: '',
  resolution: '',
  source: 'Internal',
  ...extra,
})
const state = (items: any[], extra: any = {}) => ({
  clients: [{ id: 'c1', name: 'Picture City' }],
  projects: [{ id: 'p1', name: 'PCI - SM Tarlac' }],
  items,
  ...extra,
})
const user = { id: 'ana', name: 'Ana Admin' }

test('dates: previous working day and day arithmetic', () => {
  assert.equal(previousWorkday('2026-11-16'), '2026-11-13', 'Monday looks back to Friday')
  assert.equal(previousWorkday('2026-11-15'), '2026-11-13', 'Sunday looks back to Friday')
  assert.equal(previousWorkday('2026-11-13'), '2026-11-12')
  assert.equal(addDayKeys('2026-12-31', 1), '2027-01-01')
})

test('overdue, due today and follow-ups are the person’s own open work, each listed once', () => {
  const facts = briefFacts({
    state: state([
      task('late', { dueDate: '2026-11-10', followUpDate: '2026-11-12' }),
      task('later', { dueDate: '2026-11-12' }),
      task('today', { dueDate: today }),
      task('chase', { followUpDate: today, waitingOn: 'Client' }),
      task('future', { dueDate: '2026-11-20', followUpDate: '2026-11-20' }),
      task('done', { dueDate: '2026-11-01', status: 'Resolved' }),
      task('finished by waiting-on', { dueDate: '2026-11-01', waitingOn: 'Done' }),
      task('someone else', { dueDate: '2026-11-01', assignedToUserId: 'ben' }),
      task('put away', { dueDate: '2026-11-01', archived: true }),
      task('sub', { parentTaskId: 'put away', dueDate: '2026-11-01' }),
    ]),
    user,
    today,
    settings: defaultTaskSettings,
  })
  assert.deepEqual(
    facts.overdue.items.map(item => [item.id, item.days]),
    [
      ['late', -3],
      ['later', -1],
    ],
  )
  assert.deepEqual(
    facts.dueToday.items.map(item => item.id),
    ['today'],
  )
  assert.deepEqual(
    facts.followUps.items.map(item => [item.id, item.waitingOn]),
    [['chase', 'Client']],
    'An overdue task is not listed again as a follow-up',
  )
  assert.equal(facts.overdue.items[0].client, 'Picture City')
  assert.equal(facts.overdue.items[0].project, 'PCI - SM Tarlac')
  assert.equal(facts.firstName, 'Ana')
  assert.equal(facts.emails, null, 'No Work Hub, no email section')
})

test('go-lives within the week, and passed ones only while steps are open', () => {
  const columns = [
    { id: 'branch', name: 'Branch', type: 'text' },
    { id: 'site', name: 'Terminal/Site', type: 'text' },
    { id: 'live', name: 'Go Live Date', type: 'date' },
    { id: 'hw', name: 'Hardware', type: 'checkbox' },
    { id: 'bir', name: 'BIR Permit', type: 'checkbox' },
  ]
  const row = (id: string, cells: any) => ({ id, cells, taskId: '', position: 0 })
  const facts = briefFacts({
    state: state([]),
    user,
    today,
    settings: defaultTaskSettings,
    trackers: [
      {
        tracker: { id: 't1', name: 'Rollout', columns } as any,
        rows: [
          row('soon', { branch: 'SM', site: 'Tarlac', live: '2026-11-17', hw: true }),
          row('missed', { branch: 'SM', site: 'Clark', live: '2026-11-10' }),
          row('missed but ready', { branch: 'SM', site: 'Davao', live: '2026-11-10', hw: true, bir: true }),
          row('far', { branch: 'SM', site: 'Cebu', live: '2026-12-01' }),
          row('no date', { branch: 'SM', site: 'Iloilo' }),
        ] as any,
      },
    ],
  })
  assert.deepEqual(
    facts.goLives.items.map(item => [item.site, item.days, item.openSteps, item.totalSteps]),
    [
      ['SM – Clark', -3, 2, 2],
      ['SM – Tarlac', 4, 1, 2],
    ],
  )
})

test('emails waiting: the latest message is not mine, and the conversation is not resolved', () => {
  const now = new Date('2026-11-13T02:00:00Z')
  const mail = (id: string, thread: string, at: string, extra: any = {}) => ({
    id,
    source: 'Gmail',
    thread_id: thread,
    subject: `Subject ${thread}`,
    sender: 'Juan Cruz <juan@client.ph>',
    status: 'New',
    received_at: at,
    source_labels: ['INBOX'],
    read_at: null,
    ...extra,
  })
  const waiting = waitingEmailsFrom(
    [
      mail('a1', 'A', '2026-11-10T01:00:00Z'),
      mail('a2', 'A', '2026-11-11T01:00:00Z', { read_at: '2026-11-11T02:00:00Z' }),
      mail('b1', 'B', '2026-11-11T01:00:00Z'),
      mail('b2', 'B', '2026-11-12T01:00:00Z', { source_labels: ['SENT'], status: 'Resolved' }),
      mail('c1', 'C', '2026-11-12T01:00:00Z', { status: 'Resolved' }),
      mail('d1', 'D', '2026-10-01T01:00:00Z'),
    ],
    now,
  )
  assert.deepEqual(
    waiting.map(email => [email.id, email.days, email.unread, email.from]),
    [['a2', 2, false, 'Juan Cruz']],
    'B was answered, C resolved, D too old; A waits from its latest message',
  )
})

test('time: hours on the last working day, and what is not sent to Seeds yet', () => {
  const entry = (date: string, hours: number, extra: any = {}) => ({
    id: `${date}-${hours}`,
    date,
    hours,
    category: 'Analysis',
    note: '',
    userId: 'ana',
    userName: 'Ana',
    createdAt: '',
    ...extra,
  })
  const items = [
    task('t', {
      timeEntries: [
        entry('2026-11-12', 3, { forSeeds: true }),
        entry('2026-11-12', 2.5, { forSeeds: true, seedsEntryId: '9' }),
        entry('2026-11-12', 4, { userId: 'ben' }),
        entry('2026-11-11', 1, { forSeeds: true, seedsError: 'Product required' }),
      ],
    }),
  ]
  const off = briefFacts({ state: state(items), user, today, settings: defaultTaskSettings })
  assert.deepEqual(off.time, { day: '2026-11-12', hours: 5.5, expected: 8, unsent: null })
  const on = briefFacts({
    state: state(items, { seeds: { connected: true } }),
    user,
    today,
    settings: defaultTaskSettings,
  })
  assert.deepEqual(on.time.unsent, { count: 2, hours: 4, failed: 1, tasks: [{ id: 't', title: 't' }] })
})

test('a clear day says so; the AI summary is cleaned to short plain text', () => {
  const entries = [{ id: 'e', date: '2026-11-12', hours: 8, userId: 'ana', category: 'Analysis', note: '' }]
  const clear = briefFacts({
    state: state([task('t', { timeEntries: entries })]),
    user,
    today,
    settings: defaultTaskSettings,
    emails: [],
  })
  assert.equal(briefIsClear(clear), true)
  assert.equal(cleanBriefSummary({ summary: '  ' }, 'x'), null)
  const summary = cleanBriefSummary(
    { summary: ' Two  things\nfirst. ', focus: ['a', '', ' a', 'b', 'c', 'd', 'e', 5] },
    'at',
  )
  assert.deepEqual(summary, { summary: 'Two things first.', focus: ['a', 'b', 'c', 'd'], generatedAt: 'at' })
})
