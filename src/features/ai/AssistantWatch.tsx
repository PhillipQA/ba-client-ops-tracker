/**
 * The assistant's heads-ups, beside the notification bell: go-lives at risk, emails nobody answered, work and
 * follow-ups left for days, time Seeds refused. The server picks them by fixed rules from the morning brief's facts
 * (see watch.ts), so checking uses no AI. The page asks when it opens and every so often while it is in view; a
 * dismissed heads-up stays away, in this browser, until it gets worse.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, CircleAlert, Radar, RefreshCw, Sparkles, X } from 'lucide-react'
import type { AppState, SignedInUser } from '../../app/useAppState'
import { requestJson } from '../../shared/http'
import { rememberTrackerRow } from '../trackers/trackerNav'
import { rememberWorkHubMessage } from '../work-hub/workHubNav'
import { keptDismissals, type WatchAlert } from './watch'

/** How often an open page checks again. The server keeps its last check for ten minutes. */
const CHECK_EVERY_MS = 20 * 60_000

type WatchResponse = { alerts: WatchAlert[]; checkedAt: string }

export default function AssistantWatch({ app, currentUser }: { app: AppState; currentUser: SignedInUser }) {
  const { canEditActionItem, canUseAI, hasModule, openTaskEditor, setAiPrompt, setView, store } = app
  const storeKey = `ba.watch.dismissed:${currentUser.organizationId || ''}:${currentUser.id}`
  const [alerts, setAlerts] = useState<WatchAlert[]>([])
  const [dismissed, setDismissed] = useState<string[]>(() => {
    try {
      const saved = JSON.parse(window.localStorage.getItem(storeKey) || '[]')
      return Array.isArray(saved) ? saved.filter(key => typeof key === 'string') : []
    } catch {
      return []
    }
  })
  const [open, setOpen] = useState(false)
  const [checking, setChecking] = useState(false)
  const [fresh, setFresh] = useState(0)
  const root = useRef<HTMLDivElement>(null)
  const checkedAt = useRef(0)
  const known = useRef<Set<string> | null>(null)
  const dismissedNow = useRef(dismissed)
  dismissedNow.current = dismissed

  const keep = useCallback(
    (keys: string[]) => {
      setDismissed(keys)
      try {
        window.localStorage.setItem(storeKey, JSON.stringify(keys))
      } catch {
        /* Dismissals then last until the page reloads. */
      }
    },
    [storeKey],
  )

  const check = useCallback(
    async (force = false) => {
      checkedAt.current = Date.now()
      setChecking(true)
      try {
        const result = await requestJson<WatchResponse>(`/api/assistant/watch${force ? '?fresh=1' : ''}`, {
          noStore: true,
        })
        const found = Array.isArray(result.alerts) ? result.alerts : []
        setAlerts(found)
        const still = keptDismissals(dismissedNow.current, found)
        if (still.length !== dismissedNow.current.length) keep(still)
        // Heads-ups that were not there at the last check are announced, except on the first check of the page.
        const live = found.filter(alert => !still.includes(alert.key))
        if (known.current) setFresh(live.filter(alert => !known.current?.has(alert.key)).length)
        known.current = new Set(found.map(alert => alert.key))
      } catch {
        /* The watcher is a help, not a need: a failed check is tried again at the next one. */
      } finally {
        setChecking(false)
      }
    },
    [keep],
  )

  useEffect(() => {
    void check()
    const again = () => {
      if (document.visibilityState === 'visible' && Date.now() - checkedAt.current >= CHECK_EVERY_MS) void check()
    }
    const timer = window.setInterval(again, 60_000)
    document.addEventListener('visibilitychange', again)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', again)
    }
  }, [check])

  useEffect(() => {
    if (!open) return
    const away = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', away)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('pointerdown', away)
      document.removeEventListener('keydown', escape)
    }
  }, [open])

  const live = alerts.filter(alert => !dismissed.includes(alert.key))
  const urgent = live.some(alert => alert.severity === 'urgent')

  /** Where a heads-up opens, when this person may go there. */
  const opener = (alert: WatchAlert) => {
    const target = alert.open
    if (target.kind === 'task') {
      const item = store.items.find(entry => entry.id === target.id)
      return item && canEditActionItem(item) ? () => openTaskEditor(target.id) : undefined
    }
    if (target.kind === 'email' && hasModule('inbox'))
      return () => {
        rememberWorkHubMessage(target.id, target.source)
        setView('inbox')
      }
    if (target.kind === 'tracker' && hasModule('trackers'))
      return () => {
        rememberTrackerRow(target.trackerId, target.rowId)
        setView('trackers')
      }
    return undefined
  }
  const ask = (alert: WatchAlert) => {
    setAiPrompt(alert.ask)
    setView('ai')
    setOpen(false)
  }

  return (
    <div className="notification-center assistant-watch" ref={root}>
      <button
        className={`notification-bell${open ? ' active' : ''}${urgent ? ' watch-urgent' : ''}`}
        type="button"
        title="Heads-ups from the assistant: what is at risk today"
        aria-label={`${live.length} heads-ups`}
        aria-expanded={open}
        onClick={() => {
          setFresh(0)
          setOpen(value => !value)
        }}
      >
        <Radar size={18} />
        {live.length > 0 && <span>{live.length}</span>}
      </button>
      {fresh > 0 && !open && (
        <button
          type="button"
          className="watch-bubble"
          onClick={() => {
            setFresh(0)
            setOpen(true)
          }}
        >
          {fresh} new heads-up{fresh === 1 ? '' : 's'}
        </button>
      )}
      {open && (
        <div className="notification-popover" role="dialog" aria-label="Heads-ups">
          <div className="notification-head">
            <div>
              <strong>Heads-ups</strong>
              <span>{live.length ? 'What is at risk today' : 'Nothing is at risk right now'}</span>
            </div>
            <button
              className="icon-button"
              type="button"
              title="Check again (does not use the AI)"
              aria-label="Check again"
              disabled={checking}
              onClick={() => void check(true)}
            >
              <RefreshCw size={16} className={checking ? 'spin' : undefined} />
            </button>
            <button className="icon-button" type="button" aria-label="Close heads-ups" onClick={() => setOpen(false)}>
              <X size={17} />
            </button>
          </div>
          <div className="notification-list">
            {live.map(alert => {
              const go = opener(alert)
              return (
                <article className={`notification-row severity-${alert.severity} unread`} key={alert.key}>
                  <button
                    className="notification-main"
                    type="button"
                    disabled={!go}
                    onClick={() => {
                      go?.()
                      setOpen(false)
                    }}
                  >
                    <span className="notification-icon">
                      {alert.severity === 'urgent' ? <CircleAlert size={17} /> : <AlertTriangle size={17} />}
                    </span>
                    <span className="notification-copy">
                      <span className="notification-title-line">
                        <strong>{alert.title}</strong>
                      </span>
                      {alert.detail && <span className="notification-message">{alert.detail}</span>}
                    </span>
                  </button>
                  <div className="notification-actions">
                    {canUseAI && (
                      <button type="button" title="Ask the BA Assistant about this" onClick={() => ask(alert)}>
                        <Sparkles size={14} />
                      </button>
                    )}
                    <button
                      type="button"
                      title="Dismiss until it gets worse"
                      onClick={() => keep([...dismissed, alert.key])}
                    >
                      <X size={14} />
                    </button>
                  </div>
                </article>
              )
            })}
            {!live.length && (
              <div className="notification-empty">
                <Radar size={24} />
                <strong>All clear</strong>
                <span>Go-lives at risk, unanswered emails and work left for days will show here.</span>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
