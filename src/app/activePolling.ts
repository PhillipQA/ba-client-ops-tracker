export type PollEnvironment = {
  active: () => boolean
  now: () => number
  setTimer: (callback: () => void, delay: number) => unknown
  clearTimer: (timer: unknown) => void
  subscribe: (callback: () => void) => () => void
}

export function pageIsActive() {
  return (
    typeof document !== 'undefined' &&
    document.visibilityState === 'visible' &&
    (typeof navigator === 'undefined' || navigator.onLine !== false)
  )
}

export function browserPollEnvironment(events: string[] = []): PollEnvironment {
  return {
    active: pageIsActive,
    now: Date.now,
    setTimer: (callback, delay) => window.setTimeout(callback, delay),
    clearTimer: timer => window.clearTimeout(timer as number),
    subscribe: callback => {
      const windowEvents = ['focus', 'online', 'offline', ...events]
      document.addEventListener('visibilitychange', callback)
      windowEvents.forEach(event => window.addEventListener(event, callback))
      return () => {
        document.removeEventListener('visibilitychange', callback)
        windowEvents.forEach(event => window.removeEventListener(event, callback))
      }
    },
  }
}

// One request at a time. Hidden/offline pages cancel work and have no timer.
export function startActivePolling(
  work: (signal: AbortSignal) => Promise<unknown>,
  options: {
    interval: number
    immediate?: boolean
    minGap?: number
    environment?: PollEnvironment
    onError?: (error: unknown) => void
  },
) {
  const environment = options.environment || browserPollEnvironment()
  const minGap = options.minGap ?? 10_000
  let stopped = false,
    busy = false,
    lastStarted = -Infinity
  let timer: unknown, controller: AbortController | undefined
  const clear = () => {
    if (timer !== undefined) environment.clearTimer(timer)
    timer = undefined
  }
  const schedule = (delay: number) => {
    clear()
    if (!stopped && environment.active())
      timer = environment.setTimer(() => {
        timer = undefined
        void run()
      }, delay)
  }
  const run = async () => {
    if (stopped || busy || !environment.active()) return
    const remaining = minGap - (environment.now() - lastStarted)
    if (remaining > 0) {
      schedule(remaining)
      return
    }
    clear()
    busy = true
    lastStarted = environment.now()
    controller = new AbortController()
    try {
      await work(controller.signal)
    } catch (error) {
      if (!controller.signal.aborted && !stopped) options.onError?.(error)
    } finally {
      const cancelled = controller.signal.aborted
      busy = false
      controller = undefined
      // If the page returned before the cancelled request settled, resume as
      // soon as the throttle allows instead of waiting an entire interval.
      schedule(cancelled ? Math.max(0, minGap - (environment.now() - lastStarted)) : options.interval)
    }
  }
  const onActivity = () => {
    if (!environment.active()) {
      clear()
      controller?.abort()
      return
    }
    if (!busy) void run()
  }
  const unsubscribe = environment.subscribe(onActivity)
  if (options.immediate !== false) void run()
  else schedule(options.interval)
  return () => {
    stopped = true
    clear()
    controller?.abort()
    unsubscribe()
  }
}

export function workspaceAutoRefreshAllowed(view: string, clientId?: string | null, projectId?: string | null) {
  // Work Hub has one login sync and explicit refresh controls.
  if (view === 'inbox') return false
  if (clientId || projectId) return true
  // The All Items / Tasks overview is deliberately cache-only until Refresh now.
  return ['action', 'clients', 'projects', 'requirements', 'trackers', 'documents', 'reports', 'ai'].includes(view)
}
