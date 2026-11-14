import assert from 'node:assert/strict'
import test from 'node:test'
import {
  cleanTimers,
  clearTimerDay,
  clockText,
  elapsedMs,
  forgottenTimer,
  pauseTimer,
  roundedHours,
  startTimer,
  stopTimer,
  TIMER_LIMITS,
  timerDays,
  type TaskTimer,
} from '../src/features/tasks/timer'

// Manila days: UTC+8, no daylight saving.
const dayOf = (ms: number) => new Date(ms + 8 * 3600000).toISOString().slice(0, 10)
const at = (manila: string) => new Date(`${manila}+08:00`).toISOString()
const ms = (manila: string) => Date.parse(`${manila}+08:00`)

test('one timer runs at a time: starting another pauses it, and pauses add up', () => {
  let timers: TaskTimer[] = startTimer([], 'a', at('2026-11-16T09:00:00')).timers
  timers = startTimer(timers, 'b', at('2026-11-16T09:30:00')).timers
  assert.deepEqual(
    timers.map(timer => [timer.taskId, timer.state]),
    [
      ['a', 'paused'],
      ['b', 'running'],
    ],
  )
  assert.equal(elapsedMs(timers[0], ms('2026-11-16T12:00:00')), 30 * 60000, 'A paused timer does not count on')

  timers = startTimer(timers, 'a', at('2026-11-16T10:00:00')).timers
  timers = pauseTimer(timers, 'a', at('2026-11-16T10:15:00')).timers
  assert.equal(elapsedMs(timers.find(timer => timer.taskId === 'a')!, ms('2026-11-16T12:00:00')), 45 * 60000)
  assert.equal(timers.find(timer => timer.taskId === 'b')!.state, 'paused')
  assert.equal(timers.filter(timer => timer.state === 'running').length, 0)
  assert.deepEqual(
    startTimer(timers, 'a', at('2026-11-16T10:20:00'))
      .timers.filter(t => t.state === 'running')
      .map(t => t.taskId),
    ['a'],
  )
})

test('a stopped timer waits to be logged a day at a time, split at midnight and rounded to 15 minutes', () => {
  let timers = startTimer([], 'a', at('2026-11-16T22:50:00')).timers
  timers = stopTimer(timers, 'a', at('2026-11-17T00:40:00')).timers
  const timer = timers[0]
  assert.equal(timer.state, 'stopped')
  assert.match(startTimer(timers, 'a', at('2026-11-17T01:00:00')).problem || '', /log or delete/)

  const days = timerDays(timer, ms('2026-11-17T09:00:00'), dayOf)
  assert.deepEqual(
    days.map(day => [day.date, day.hours]),
    [
      ['2026-11-16', 1.25],
      ['2026-11-17', 0.75],
    ],
    '1h10m → 1h15m, 40m → 45m',
  )

  const logged = clearTimerDay(timers, 'a', '2026-11-16', dayOf).timers
  assert.deepEqual(
    timerDays(logged[0], 0, dayOf).map(day => day.date),
    ['2026-11-17'],
  )
  assert.deepEqual(clearTimerDay(logged, 'a', '2026-11-17', dayOf).timers, [], 'No time left: the timer goes')
  assert.deepEqual(
    clearTimerDay(startTimer([], 'b', at('2026-11-16T09:00:00')).timers, 'b', '2026-11-16', dayOf).timers.length,
    1,
    'Only a stopped timer is cleared',
  )
})

test('rounding, the clock and limits', () => {
  assert.equal(roundedHours(0), 0)
  assert.equal(roundedHours(2 * 60000), 0.25, 'Any timed work is at least 15 minutes')
  assert.equal(roundedHours(22 * 60000), 0.25)
  assert.equal(roundedHours(23 * 60000), 0.5)
  assert.equal(roundedHours(97 * 60000), 1.5)
  assert.equal(clockText(3909000), '1:05:09')
  assert.equal(clockText(-5), '0:00:00')

  const full = Array.from({ length: TIMER_LIMITS.timers }, (_, index) => ({
    taskId: `t${index}`,
    state: 'paused' as const,
    pieces: [{ start: at('2026-11-16T09:00:00'), end: at('2026-11-16T09:10:00') }],
    updatedAt: at('2026-11-16T09:10:00'),
  }))
  assert.match(startTimer(full, 'new', at('2026-11-16T10:00:00')).problem || '', /timers already/)
})

test('stored timers are checked, and a long or overnight timer is flagged, never stopped', () => {
  const cleaned = cleanTimers([
    { taskId: 'a', state: 'paused', pieces: [{ start: at('2026-11-16T09:00:00') }] },
    { taskId: 'a', state: 'running', pieces: [{ start: at('2026-11-16T09:00:00') }] },
    { taskId: 'b', state: 'running', pieces: [{ start: 'nonsense' }] },
    { taskId: 'c', state: 'weird', pieces: [{ start: at('2026-11-16T10:00:00'), end: at('2026-11-16T09:00:00') }] },
    null,
  ])
  assert.deepEqual(
    cleaned.map(timer => timer.taskId),
    ['a'],
  )
  assert.equal(cleaned[0].pieces[0].end, cleaned[0].pieces[0].start, 'A paused timer has no open piece')
  assert.deepEqual(cleanTimers('nonsense'), [])

  const running = startTimer([], 'a', at('2026-11-16T09:00:00')).timers[0]
  assert.equal(forgottenTimer(running, ms('2026-11-16T12:59:00'), dayOf), false)
  assert.equal(forgottenTimer(running, ms('2026-11-16T13:00:00'), dayOf), true)
  const evening = startTimer([], 'a', at('2026-11-16T23:30:00')).timers[0]
  assert.equal(forgottenTimer(evening, ms('2026-11-17T00:10:00'), dayOf), true, 'Left running past midnight')
  assert.equal(
    forgottenTimer(pauseTimer([running], 'a', at('2026-11-16T10:00:00')).timers[0], ms('2026-11-17T09:00:00'), dayOf),
    false,
  )
})
