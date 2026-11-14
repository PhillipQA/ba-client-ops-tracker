/**
 * The task timer: a person times their work on a task instead of typing the hours. A timer is a list of pieces
 * (start and end times); pausing closes the open piece, resuming opens a new one. Only one of a person's timers runs at
 * a time: starting another pauses it. Stopping keeps the pieces until each day's time is logged or thrown away, and the
 * time is always shown to the person as an entry to review first (they save, edit or delete it).
 *
 * Shared by the server (which keeps the timers, so a closed tab or another device loses nothing) and the browser (which
 * shows them). Nothing ticks on the server: elapsed time is worked out from the stored times when it is read.
 */
export type TimerPiece = { start: string; end?: string }
export type TimerState = 'running' | 'paused' | 'stopped'
export type TaskTimer = { taskId: string; state: TimerState; pieces: TimerPiece[]; updatedAt: string }

export const TIMER_LIMITS = {
  /** Timers one person may keep (running, paused or stopped and waiting to be logged). */
  timers: 8,
  /** Pieces one timer may keep. */
  pieces: 200,
  /** A running timer this long gets a reminder. */
  remindAfterHours: 4,
  /** Time is rounded to this many minutes. */
  roundMinutes: 15,
} as const

const time = (value: string | undefined) => (value ? Date.parse(value) : Number.NaN)
const isTime = (value: unknown): value is string => typeof value === 'string' && !Number.isNaN(Date.parse(value))

/** A stored timer, checked: well-formed pieces only, the open one last and only while running. */
export function cleanTimer(value: any): TaskTimer | null {
  const taskId = typeof value?.taskId === 'string' ? value.taskId.slice(0, 80) : ''
  const state: TimerState = ['running', 'paused', 'stopped'].includes(value?.state) ? value.state : 'paused'
  const pieces = (Array.isArray(value?.pieces) ? value.pieces : [])
    .filter((piece: any) => isTime(piece?.start) && (piece.end === undefined || isTime(piece.end)))
    .filter((piece: any) => piece.end === undefined || time(piece.end) >= time(piece.start))
    .slice(-TIMER_LIMITS.pieces)
    .map((piece: any) => (piece.end ? { start: piece.start, end: piece.end } : { start: piece.start }))
  if (!taskId || !pieces.length) return null
  // Only the last piece may be open, and only while the timer runs.
  const closed = pieces.map((piece: TimerPiece, index: number) =>
    piece.end || (state === 'running' && index === pieces.length - 1) ? piece : { ...piece, end: piece.start },
  )
  return { taskId, state, pieces: closed, updatedAt: isTime(value?.updatedAt) ? value.updatedAt : closed[0].start }
}

export function cleanTimers(value: unknown): TaskTimer[] {
  const timers: TaskTimer[] = []
  for (const entry of Array.isArray(value) ? value : []) {
    const timer = cleanTimer(entry)
    if (timer && !timers.some(other => other.taskId === timer.taskId)) timers.push(timer)
  }
  return timers.slice(0, TIMER_LIMITS.timers)
}

const closeOpen = (timer: TaskTimer, at: string): TaskTimer => ({
  ...timer,
  pieces: timer.pieces.map(piece => (piece.end ? piece : { ...piece, end: at })),
})

export type TimerChange = { timers: TaskTimer[]; problem?: string }

/** Starts (or resumes) the timer on a task; any other running timer of the person is paused. */
export function startTimer(timers: TaskTimer[], taskId: string, now: string): TimerChange {
  const current = timers.find(timer => timer.taskId === taskId)
  if (current?.state === 'running') return { timers }
  if (current?.state === 'stopped')
    return { timers, problem: 'This timer was stopped: log or delete its time before timing this task again.' }
  if (!current && timers.length >= TIMER_LIMITS.timers)
    return { timers, problem: `You have ${TIMER_LIMITS.timers} timers already. Log or delete one first.` }
  if (current && current.pieces.length >= TIMER_LIMITS.pieces)
    return { timers, problem: 'This timer has too many pauses. Stop it and log its time.' }
  const paused = timers.map(timer =>
    timer.state === 'running' && timer.taskId !== taskId
      ? { ...closeOpen(timer, now), state: 'paused' as const, updatedAt: now }
      : timer,
  )
  const started: TaskTimer = current
    ? { ...current, state: 'running', pieces: [...current.pieces, { start: now }], updatedAt: now }
    : { taskId, state: 'running', pieces: [{ start: now }], updatedAt: now }
  return { timers: current ? paused.map(timer => (timer.taskId === taskId ? started : timer)) : [...paused, started] }
}

/** Pauses a running timer. */
export function pauseTimer(timers: TaskTimer[], taskId: string, now: string): TimerChange {
  return {
    timers: timers.map(timer =>
      timer.taskId === taskId && timer.state === 'running'
        ? { ...closeOpen(timer, now), state: 'paused', updatedAt: now }
        : timer,
    ),
  }
}

/** Stops a timer: its time then waits to be logged (or thrown away), a day at a time. */
export function stopTimer(timers: TaskTimer[], taskId: string, now: string): TimerChange {
  return {
    timers: timers.map(timer =>
      timer.taskId === taskId && timer.state !== 'stopped'
        ? { ...closeOpen(timer, now), state: 'stopped', updatedAt: now }
        : timer,
    ),
  }
}

/**
 * Takes one day's time out of a stopped timer, once it is logged or thrown away. The timer goes when no time is left.
 * `dayOf` gives the business date of a moment.
 */
export function clearTimerDay(
  timers: TaskTimer[],
  taskId: string,
  date: string,
  dayOf: (ms: number) => string,
): TimerChange {
  const next: TaskTimer[] = []
  for (const timer of timers) {
    if (timer.taskId !== taskId || timer.state !== 'stopped') {
      next.push(timer)
      continue
    }
    const kept = splitPieces(timer.pieces, Date.now(), dayOf).filter(piece => piece.date !== date)
    if (kept.some(piece => piece.ms > 0))
      next.push({ ...timer, pieces: kept.map(piece => ({ start: piece.start, end: piece.end })) })
  }
  return { timers: next }
}

/** Time on the timer so far, in milliseconds (a running piece counts up to now). */
export function elapsedMs(timer: Pick<TaskTimer, 'pieces'>, now: number) {
  return timer.pieces.reduce((sum, piece) => {
    const end = piece.end ? time(piece.end) : now
    return sum + Math.max(0, end - time(piece.start))
  }, 0)
}

/** The first moment after `from` (and not after `to`) that falls on another day; `to` when none does. */
function nextDayStart(from: number, to: number, dayOf: (ms: number) => string) {
  const day = dayOf(from)
  if (dayOf(to) === day) return to
  let low = from
  let high = Math.min(to, from + 26 * 3600000)
  if (dayOf(high) === day) return high
  // To the minute, then the second: enough to put each piece on its day.
  while (high - low > 1000) {
    const middle = Math.floor((low + high) / 2)
    if (dayOf(middle) === day) low = middle
    else high = middle
  }
  return high
}

/** The pieces cut at midnight (in the business time zone), each with its date and length. */
export function splitPieces(pieces: TimerPiece[], now: number, dayOf: (ms: number) => string) {
  const out: { start: string; end: string; date: string; ms: number }[] = []
  for (const piece of pieces) {
    let from = time(piece.start)
    const to = piece.end ? time(piece.end) : now
    while (from < to) {
      const cut = nextDayStart(from, to, dayOf)
      out.push({
        start: new Date(from).toISOString(),
        end: new Date(cut).toISOString(),
        date: dayOf(from),
        ms: cut - from,
      })
      from = cut
    }
  }
  return out
}

/** Hours rounded to the nearest 15 minutes, never below 15 minutes for time that was timed at all. */
export function roundedHours(ms: number) {
  if (ms <= 0) return 0
  const step = TIMER_LIMITS.roundMinutes
  return Math.max(step, Math.round(ms / 60000 / step) * step) / 60
}

/** A stopped timer's time, a day at a time, oldest first: what is offered to log. */
export function timerDays(timer: Pick<TaskTimer, 'pieces'>, now: number, dayOf: (ms: number) => string) {
  const byDate = new Map<string, number>()
  for (const piece of splitPieces(timer.pieces, now, dayOf))
    byDate.set(piece.date, (byDate.get(piece.date) || 0) + piece.ms)
  return [...byDate.entries()]
    .filter(([, ms]) => ms > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, ms]) => ({ date, ms, hours: roundedHours(ms) }))
}

/** "1:05:09", for a running clock. */
export function clockText(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
}

/**
 * Whether a running timer looks forgotten: running for hours, or since an earlier day. Only reminds: it never stops.
 */
export function forgottenTimer(timer: TaskTimer, now: number, dayOf: (ms: number) => string) {
  if (timer.state !== 'running') return false
  const open = timer.pieces[timer.pieces.length - 1]
  const startedAt = time(open?.start)
  if (Number.isNaN(startedAt)) return false
  return now - startedAt >= TIMER_LIMITS.remindAfterHours * 3600000 || dayOf(startedAt) !== dayOf(now)
}
