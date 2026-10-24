import { useEffect, useRef, useState } from 'react'
import { browserPollEnvironment, pageIsActive, startActivePolling } from './activePolling'

export function usePageActive() {
  const [active, setActive] = useState(pageIsActive)
  useEffect(() => browserPollEnvironment().subscribe(() => setActive(pageIsActive())), [])
  return active
}

export function useVisiblePolling(
  work: (signal: AbortSignal) => Promise<unknown>,
  options: {
    enabled: boolean
    interval: number
    scope?: string
    immediate?: boolean
    minGap?: number
    events?: string[]
  },
) {
  const callback = useRef(work)
  callback.current = work
  const eventKey = (options.events || []).join('|')
  useEffect(() => {
    if (!options.enabled) return
    return startActivePolling(signal => callback.current(signal), {
      interval: options.interval,
      immediate: options.immediate,
      minGap: options.minGap,
      environment: browserPollEnvironment(eventKey ? eventKey.split('|') : []),
      onError: error => console.error('Active tab refresh failed:', error),
    })
  }, [options.enabled, options.interval, options.scope, options.immediate, options.minGap, eventKey])
}
