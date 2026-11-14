/**
 * The timer in a task's Effort section: start, pause, resume and stop, with the clock. A stopped timer lists its time a
 * day at a time (rounded to 15 minutes); "Use" puts a day's time into Log time to review and save, "Delete" throws it
 * away. Nothing is logged until the person saves the entry.
 */
import { useState } from 'react'
import { Pause, Play, Square, Timer, Trash2 } from 'lucide-react'
import { clockText, elapsedMs, timerDays } from './timer'
import { formatHours } from './effort'
import { timerDayOf, timersApi, useTick, useTimers } from './timerStore'

export type TimerDay = { date: string; hours: number }

export default function TaskTimerBar({
  taskId,
  usedDate,
  onUse,
}: {
  taskId: string
  /** The day whose time is in Log time now, if any. */
  usedDate: string
  onUse: (day: TimerDay) => void
}) {
  const { timers, unavailable } = useTimers()
  const timer = timers.find(entry => entry.taskId === taskId)
  const running = timer?.state === 'running'
  const now = useTick(running)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState('')
  const other = timers.find(entry => entry.state === 'running' && entry.taskId !== taskId)

  const act = async (work: () => Promise<unknown>) => {
    setBusy(true)
    setProblem('')
    try {
      await work()
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'The timer could not be changed.')
    } finally {
      setBusy(false)
    }
  }

  if (unavailable && !timer) return null
  const days = timer?.state === 'stopped' ? timerDays(timer, now, timerDayOf) : []
  return (
    <div className="effort-timer">
      <div className="effort-timer-row">
        <strong>
          <Timer size={14} aria-hidden="true" /> Timer
        </strong>
        {timer && timer.state !== 'stopped' && (
          <span className={`effort-timer-clock${running ? ' running' : ''}`} aria-live="off">
            {clockText(elapsedMs(timer, now))}
            {!running && ' · paused'}
          </span>
        )}
        <span className="effort-timer-actions">
          {!timer && (
            <button
              type="button"
              className="secondary compact"
              disabled={busy}
              onClick={() => void act(() => timersApi.act(taskId, 'start'))}
              title={other ? 'Starting this pauses your other running timer' : 'Time your work on this task'}
            >
              <Play size={13} /> Start timer
            </button>
          )}
          {timer?.state === 'paused' && (
            <button
              type="button"
              className="secondary compact"
              disabled={busy}
              onClick={() => void act(() => timersApi.act(taskId, 'start'))}
            >
              <Play size={13} /> Resume
            </button>
          )}
          {running && (
            <button
              type="button"
              className="secondary compact"
              disabled={busy}
              onClick={() => void act(() => timersApi.act(taskId, 'pause'))}
            >
              <Pause size={13} /> Pause
            </button>
          )}
          {timer && timer.state !== 'stopped' && (
            <button
              type="button"
              className="secondary compact"
              disabled={busy}
              onClick={() => void act(() => timersApi.act(taskId, 'stop'))}
              title="Stop and review the time before it is logged"
            >
              <Square size={12} /> Stop
            </button>
          )}
        </span>
      </div>
      {!timer && other && (
        <small className="effort-timer-hint">Another task’s timer is running: starting this pauses it.</small>
      )}
      {days.length > 0 && (
        <div className="effort-timer-days">
          <small>
            Timed, rounded to 15 minutes. Use a day’s time to log it (you can change it before saving), or delete it.
          </small>
          <ul>
            {days.map(day => (
              <li key={day.date} className={day.date === usedDate ? 'active' : ''}>
                <span>
                  {day.date} · <b>{formatHours(day.hours)}</b>
                </span>
                <button type="button" className="secondary compact" disabled={busy} onClick={() => onUse(day)}>
                  {day.date === usedDate ? 'In Log time' : 'Use'}
                </button>
                <button
                  type="button"
                  className="effort-timer-delete"
                  disabled={busy}
                  aria-label={`Delete the time timed on ${day.date}`}
                  title="Delete this time (nothing is logged)"
                  onClick={() => {
                    if (
                      window.confirm(`Delete ${formatHours(day.hours)} timed on ${day.date}? Nothing will be logged.`)
                    )
                      void act(() => timersApi.clearDay(taskId, day.date))
                  }}
                >
                  <Trash2 size={13} />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {problem && (
        <small className="effort-timer-problem" role="alert">
          {problem}
        </small>
      )}
    </div>
  )
}
