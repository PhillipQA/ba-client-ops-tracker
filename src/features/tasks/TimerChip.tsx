/**
 * The running timer, on every page: a small chip at the bottom left with the task, the clock, Pause and Stop. Stopping
 * opens the task, where the time is shown as an entry to review before anything is logged. A stopped timer whose time
 * is not logged yet shows as a reminder until it is.
 */
import { Pause, Play, Square, Timer } from 'lucide-react'
import { useState } from 'react'
import type { WorkItem } from '../../shared/types'
import { clockText, elapsedMs, forgottenTimer } from './timer'
import { timerDayOf, timersApi, useTick, useTimers, useTimerSync } from './timerStore'
import './timerChip.css'

export default function TimerChip({
  enabled,
  items,
  onOpenTask,
}: {
  enabled: boolean
  items: WorkItem[]
  onOpenTask: (taskId: string) => void
}) {
  useTimerSync(enabled)
  const { timers } = useTimers()
  const running = timers.find(timer => timer.state === 'running')
  const paused = timers.filter(timer => timer.state === 'paused')
  const stopped = timers.filter(timer => timer.state === 'stopped')
  const now = useTick(Boolean(running))
  const [busy, setBusy] = useState(false)
  if (!enabled || !timers.length) return null

  const title = (taskId: string) => items.find(item => item.id === taskId)?.title || 'A task'
  const act = async (taskId: string, action: 'start' | 'pause' | 'stop') => {
    setBusy(true)
    try {
      await timersApi.act(taskId, action)
      if (action === 'stop') onOpenTask(taskId)
    } catch {
      /* The task's own timer says what went wrong. */
    } finally {
      setBusy(false)
    }
  }
  const shown = running || paused[0]
  const late = running ? forgottenTimer(running, now, timerDayOf) : false
  return (
    <div className="timer-chip-dock" role="region" aria-label="Timers">
      {shown && (
        <div className={`timer-chip${running ? ' running' : ''}${late ? ' late' : ''}`}>
          <button
            type="button"
            className="timer-chip-main"
            onClick={() => onOpenTask(shown.taskId)}
            title="Open the task"
          >
            <Timer size={14} aria-hidden="true" />
            <span className="timer-chip-title">{title(shown.taskId)}</span>
            <span className="timer-chip-clock">
              {clockText(elapsedMs(shown, now))}
              {!running && ' · paused'}
            </span>
          </button>
          {running ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => void act(shown.taskId, 'pause')}
              aria-label="Pause the timer"
              title="Pause"
            >
              <Pause size={14} />
            </button>
          ) : (
            <button
              type="button"
              disabled={busy}
              onClick={() => void act(shown.taskId, 'start')}
              aria-label="Resume the timer"
              title="Resume"
            >
              <Play size={14} />
            </button>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={() => void act(shown.taskId, 'stop')}
            aria-label="Stop and review the time"
            title="Stop and review the time"
          >
            <Square size={13} />
          </button>
        </div>
      )}
      {late && <div className="timer-chip-note">Still working on this? The timer has been running a long time.</div>}
      {stopped.map(timer => (
        <button type="button" key={timer.taskId} className="timer-chip-todo" onClick={() => onOpenTask(timer.taskId)}>
          <Timer size={13} aria-hidden="true" /> Time to log: {title(timer.taskId)}
        </button>
      ))}
      {paused.length > (running ? 0 : 1) && (
        <span className="timer-chip-note">
          {paused.length - (running ? 0 : 1)} more paused timer{paused.length - (running ? 0 : 1) === 1 ? '' : 's'}
        </span>
      )}
    </div>
  )
}
