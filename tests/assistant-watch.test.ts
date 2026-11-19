import assert from 'node:assert/strict'
import test from 'node:test'
import type { BriefFacts } from '../src/features/ai/brief'
import { pickAlerts, readDismissals, WATCH_RULES, watchAlerts, watchCandidates } from '../src/features/ai/watch'

const none = { total: 0, items: [] }
const facts = (extra: Partial<BriefFacts> = {}): BriefFacts => ({
  date: '2026-11-14',
  firstName: 'Phillip',
  overdue: none,
  dueToday: none,
  followUps: none,
  goLives: none,
  emails: none,
  time: { day: '2026-11-13', hours: 8, expected: 8, unsent: null },
  ...extra,
})
const list = <T>(items: T[]) => ({ total: items.length, items })
const site = (rowId: string, days: number, openSteps: number) => ({
  trackerId: 't1',
  trackerName: 'Rollout',
  rowId,
  site: `Site ${rowId}`,
  date: '2026-11-15',
  days,
  openSteps,
  totalSteps: 6,
})
const email = (id: string, days: number) => ({
  id,
  source: 'Gmail',
  subject: `Subject ${id}`,
  from: 'Juan',
  receivedAt: '2026-11-10T01:00:00.000Z',
  days,
  unread: true,
})
const item = (id: string, days: number) => ({ id, title: `Task ${id}`, client: 'Goldwing', date: '2026-11-01', days })

test('a quiet day raises nothing', () => {
  assert.deepEqual(watchAlerts(facts()), [])
  // Things the brief lists but that are not at risk yet.
  const calm = facts({
    goLives: list([site('far', 5, 3), site('ready', 1, 0)]),
    emails: list([email('new', 1)]),
    overdue: list([item('just', -1)]),
    followUps: list([item('today', 0)]),
    time: { day: '2026-11-13', hours: 2, expected: 8, unsent: { count: 2, hours: 3, failed: 0, tasks: [] } },
  })
  assert.deepEqual(watchAlerts(calm), [])
})

test('what is at risk is raised, the urgent first, each opening where the work is', () => {
  const alerts = watchAlerts(
    facts({
      goLives: list([site('late', -2, 2), site('soon', 3, 4)]),
      emails: list([email('old', 6), email('waiting', 2)]),
      overdue: list([item('stuck', -9), item('slipping', -3)]),
      followUps: list([item('chase', -4)]),
      time: {
        day: '2026-11-13',
        hours: 8,
        expected: 8,
        unsent: { count: 2, hours: 3, failed: 1, tasks: [{ id: 'x', title: 'Config' }] },
      },
    }),
  )
  const urgent = alerts.filter(alert => alert.severity === 'urgent').map(alert => alert.key)
  assert.deepEqual(urgent, ['golive:t1:late:urgent', 'email:old:urgent', 'overdue:stuck:urgent'])
  assert.deepEqual(
    alerts.slice(0, 3).map(alert => alert.severity),
    ['urgent', 'urgent', 'urgent'],
  )
  const byKey = new Map(alerts.map(alert => [alert.key, alert]))
  assert.match(byKey.get('golive:t1:late:urgent')!.title, /Site late: go-live was 2 days ago/)
  assert.deepEqual(byKey.get('golive:t1:soon:warning')!.open, { kind: 'tracker', trackerId: 't1', rowId: 'soon' })
  assert.match(byKey.get('email:waiting:warning')!.title, /No reply for 2 days/)
  assert.deepEqual(byKey.get('email:old:urgent')!.open, { kind: 'email', id: 'old', source: 'Gmail' })
  assert.match(byKey.get('overdue:slipping:warning')!.title, /3 days overdue/)
  assert.match(byKey.get('followup:chase:2026-11-01')!.ask, /follow-up about "Task chase" for Goldwing/)
  assert.deepEqual(byKey.get('seeds-failed:2026-11-14')!.open, { kind: 'task', id: 'x' })
  assert.equal(alerts.length, 8)
})

test('heads-ups are few, and a dismissed one comes back only when it gets worse', () => {
  const many = watchAlerts(
    facts({
      emails: list([email('a', 9), email('b', 8), email('c', 7), email('d', 6)]),
      overdue: list([item('1', -9), item('2', -9), item('3', -9), item('4', -9)]),
      goLives: list([site('x', 0, 1), site('y', 0, 1), site('z', 0, 1), site('w', 0, 1)]),
    }),
  )
  assert.equal(many.length, WATCH_RULES.total)
  assert.equal(many.filter(alert => alert.key.startsWith('email:')).length <= WATCH_RULES.perKind, true)

  const warning = watchAlerts(facts({ emails: list([email('m', 3)]) }))
  const worse = watchAlerts(facts({ emails: list([email('m', 5)]) }))
  assert.notEqual(warning[0].key, worse[0].key, 'Now urgent: a new key, so it shows again')
})

test('a dismissed heads-up stays away while it is missing from a check, for 30 days', () => {
  const day = 86_400_000
  const now = Date.parse('2026-11-19T08:00:00.000Z')
  const kept = readDismissals(
    [
      'email:old-version:urgent',
      { key: 'golive:t1:a:urgent', at: now - 2 * day },
      { key: 'golive:t1:a:urgent', at: now - 5 * day },
      { key: 'overdue:1:warning', at: now - (WATCH_RULES.dismissDays + 1) * day },
      { key: '', at: now },
      { at: now },
      42,
    ],
    now,
  )
  assert.deepEqual(kept, [
    { key: 'email:old-version:urgent', at: now },
    { key: 'golive:t1:a:urgent', at: now - 2 * day },
  ])
  assert.deepEqual(readDismissals('nonsense', now), [])
  const lots = Array.from({ length: WATCH_RULES.dismissKept + 5 }, (_, i) => ({ key: `email:${i}:x`, at: now - i }))
  assert.equal(readDismissals(lots, now).length, WATCH_RULES.dismissKept, 'the newest are kept')
})

test('dismissed heads-ups hold no place: the next ones of that kind show instead', () => {
  const today = facts({ emails: list([email('a', 9), email('b', 8), email('c', 7), email('d', 6), email('e', 6)]) })
  const all = watchCandidates(today)
  assert.equal(all.length, 5, 'the server sends every one')
  const shown = (hidden: string[]) => pickAlerts(all.filter(alert => !hidden.includes(alert.key))).map(a => a.key)
  assert.deepEqual(shown([]), ['email:a:urgent', 'email:b:urgent', 'email:c:urgent'])
  assert.deepEqual(shown(['email:a:urgent', 'email:b:urgent']), ['email:c:urgent', 'email:d:urgent', 'email:e:urgent'])
  assert.deepEqual(pickAlerts(all), watchAlerts(today), 'with nothing dismissed, the same few as before')
})
