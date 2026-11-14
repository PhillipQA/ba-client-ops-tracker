/**
 * The signed-in person's task timers in the browser: one copy shared by the task editor and the running chip, read
 * from the server when the app opens, when the page comes back into view and every few minutes, and after each change.
 * The clock that shows elapsed time ticks only in the browser.
 */
import { useEffect, useState, useSyncExternalStore } from 'react'
import { requestJson } from '../../shared/http'
import { businessDateKey } from '../../shared/businessDate'
import { cleanTimers, type TaskTimer } from './timer'

type Snapshot = { timers: TaskTimer[]; loaded: boolean; unavailable: string; offsetMs: number }
let snapshot: Snapshot = { timers: [], loaded: false, unavailable: '', offsetMs: 0 }
const listeners = new Set<() => void>()
const emit = (next: Partial<Snapshot>) => {
  snapshot = { ...snapshot, ...next }
  for (const listener of listeners) listener()
}

/** Keeps the browser's clock in step with the server's, so elapsed time is right even when the PC clock is off. */
const take = (body: { timers?: unknown; now?: string }) => {
  const serverNow = body.now ? Date.parse(body.now) : Number.NaN
  emit({
    timers: cleanTimers(body.timers),
    loaded: true,
    unavailable: '',
    offsetMs: Number.isNaN(serverNow) ? snapshot.offsetMs : serverNow - Date.now(),
  })
  return snapshot.timers
}

export const timerNow = () => Date.now() + snapshot.offsetMs
/** The business date of a moment, as the rest of the app counts days. */
export const timerDayOf = (ms: number) => businessDateKey(new Date(ms))

export const timersApi = {
  refresh: async () => {
    try {
      return take(await requestJson('/api/timers', { noStore: true }))
    } catch (error) {
      emit({ loaded: true, unavailable: error instanceof Error ? error.message : 'Timers are unavailable.' })
      return snapshot.timers
    }
  },
  act: async (taskId: string, action: 'start' | 'pause' | 'stop') =>
    take(
      await requestJson(`/api/timers/${encodeURIComponent(taskId)}/${action}`, {
        method: 'POST',
        fallback: 'The timer could not be changed.',
      }),
    ),
  /** Takes a day's time out of a stopped timer, once it is logged or thrown away. */
  clearDay: async (taskId: string, date: string) =>
    take(
      await requestJson(`/api/timers/${encodeURIComponent(taskId)}/clear`, {
        body: { date },
        fallback: 'The timer could not be changed.',
      }),
    ),
  discard: async (taskId: string) =>
    take(
      await requestJson(`/api/timers/${encodeURIComponent(taskId)}`, {
        method: 'DELETE',
        fallback: 'The timer could not be deleted.',
      }),
    ),
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
export function useTimers() {
  return useSyncExternalStore(subscribe, () => snapshot)
}

/** Reads the timers when the app opens and keeps them fresh (mounted once, by the running chip). */
export function useTimerSync(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return
    void timersApi.refresh()
    const again = () => {
      if (document.visibilityState === 'visible') void timersApi.refresh()
    }
    const timer = window.setInterval(again, 5 * 60_000)
    document.addEventListener('visibilitychange', again)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', again)
    }
  }, [enabled])
}

/** The current time, every second while `on` (for a running clock). */
export function useTick(on: boolean) {
  const [now, setNow] = useState(() => timerNow())
  useEffect(() => {
    if (!on) return
    setNow(timerNow())
    const timer = window.setInterval(() => setNow(timerNow()), 1000)
    return () => window.clearInterval(timer)
  }, [on])
  return now
}
