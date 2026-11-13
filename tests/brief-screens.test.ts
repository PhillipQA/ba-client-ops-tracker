import assert from 'node:assert/strict'
import { test } from 'node:test'
import { briefCounts } from '../src/features/action-center/MorningBrief'
import { reportCounts } from '../src/features/ai/StatusReportDialog'
import { forgetWorkHubMessage, rememberWorkHubMessage, wantedWorkHubMessage } from '../src/features/work-hub/workHubNav'

const section = (total: number) => ({ total, items: [] })

test('the brief’s heading counts only what is there', () => {
  const facts: any = {
    date: '2026-11-13',
    firstName: 'Ana',
    overdue: section(7),
    dueToday: section(1),
    followUps: section(2),
    goLives: section(1),
    emails: section(1),
    time: { day: '2026-11-12', hours: 8, expected: 8, unsent: null },
  }
  assert.equal(briefCounts(facts), '7 overdue · 1 due today · 2 follow-ups · 1 go-live · 1 email waiting')
  assert.equal(
    briefCounts({
      ...facts,
      overdue: section(0),
      dueToday: section(0),
      followUps: section(0),
      goLives: section(0),
      emails: null,
    }),
    'Nothing is waiting on you',
  )
})

test('the report dialog shows the counts behind the draft', () => {
  const facts: any = {
    done: section(3),
    next: section(2),
    overdue: section(0),
    needsClient: section(1),
    signatures: [{}],
    trackers: [{ name: 'PCI rollout', sites: 12, complete: 4 }],
  }
  assert.equal(
    reportCounts(facts),
    'Done 3 · Coming up 2 · Waiting on the client 1 · Awaiting signature 1 · PCI rollout: 4 of 12 sites done',
  )
})

test('Work Hub keeps the message to open until it has opened it', () => {
  const store = new Map<string, string>()
  ;(globalThis as any).window = {
    sessionStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    },
  }
  try {
    assert.equal(wantedWorkHubMessage(), null)
    rememberWorkHubMessage('m1', 'Discord')
    assert.deepEqual(wantedWorkHubMessage(), { id: 'm1', source: 'Discord' })
    assert.deepEqual(wantedWorkHubMessage(), { id: 'm1', source: 'Discord' }, 'Reading does not use it up')
    rememberWorkHubMessage('m2', 'anything else')
    assert.deepEqual(wantedWorkHubMessage(), { id: 'm2', source: 'Gmail' })
    forgetWorkHubMessage()
    assert.equal(wantedWorkHubMessage(), null)
  } finally {
    delete (globalThis as any).window
  }
})
