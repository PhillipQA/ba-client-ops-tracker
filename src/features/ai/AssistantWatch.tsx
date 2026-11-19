/**
 * The assistant's heads-ups, beside the notification bell: go-lives at risk, emails nobody answered, work and
 * follow-ups left for days, time Seeds refused. The server picks them by fixed rules from the morning brief's facts
 * (see watch.ts), so checking uses no AI. The page asks when it opens and every so often while it is in view; a
 * dismissed heads-up stays away, in this browser, until it gets worse (or for 30 days).
 * The server sends every heads-up; the page takes out the dismissed ones, then keeps a few (pickAlerts).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, CircleAlert, Radar, RefreshCw, Sparkles, X } from 'lucide-react'
import type { AppState, SignedInUser } from '../../app/useAppState'
import { requestJson } from '../../shared/http'
import { rememberTrackerRow } from '../trackers/trackerNav'
import { rememberWorkHubMessage } from '../work-hub/workHubNav'
import {
  type Dismissal,
  type NewProject,
  newProjectAlerts,
  pickAlerts,
  readDismissals,
  type WatchAction,
  type WatchAlert,
} from './watch'
import { clockText, elapsedMs, forgottenTimer } from '../tasks/timer'
import { timerDayOf, timerNow, useTimers } from '../tasks/timerStore'

/** How often an open page checks again. The server keeps its last check for ten minutes. */
const CHECK_EVERY_MS = 20 * 60_000

/** The server's heads-ups a person sees: the hidden ones taken out first, so they hold no place. */
const shown = (alerts: WatchAlert[], hidden: Set<string>) => pickAlerts(alerts.filter(alert => !hidden.has(alert.key)))

type WatchResponse = { alerts: WatchAlert[]; checkedAt: string }

export default function AssistantWatch({ app, currentUser }: { app: AppState; currentUser: SignedInUser }) {
  const { applyTaskUpdate, canEditActionItem, canUseAI, hasModule, openTaskEditor, setAiPrompt, setView, store } = app
  const storeKey = `ba.watch.dismissed:${currentUser.organizationId || ''}:${currentUser.id}`
  const [alerts, setAlerts] = useState<WatchAlert[]>([])
  const [dismissals, setDismissals] = useState<Dismissal[]>(() => {
    try {
      return readDismissals(JSON.parse(window.localStorage.getItem(storeKey) || '[]'), Date.now())
    } catch {
      return []
    }
  })
  const dismissed = dismissals.map(entry => entry.key)
  const [open, setOpen] = useState(false)
  const [checking, setChecking] = useState(false)
  const [fresh, setFresh] = useState(0)
  // New Seeds projects that are on no tracker yet (for people with Trackers).
  const [projectAlerts, setProjectAlerts] = useState<WatchAlert[]>([])
  const projectAlertsNow = useRef<WatchAlert[]>([])
  projectAlertsNow.current = projectAlerts
  const withTrackers = hasModule('trackers')
  // Heads-ups dealt with by a one-click change, hidden until the next check; and what that change did.
  const [handled, setHandled] = useState<string[]>([])
  const [notice, setNotice] = useState('')
  const root = useRef<HTMLDivElement>(null)
  const checkedAt = useRef(0)
  const known = useRef<Set<string> | null>(null)
  const dismissedNow = useRef(dismissals)
  dismissedNow.current = dismissals

  const keep = useCallback(
    (entries: Dismissal[]) => {
      const kept = readDismissals(entries, Date.now())
      dismissedNow.current = kept
      setDismissals(kept)
      try {
        window.localStorage.setItem(storeKey, JSON.stringify(kept))
      } catch {
        /* Dismissals then last until the page reloads. */
      }
    },
    [storeKey],
  )
  const dismiss = (key: string) => keep([{ key, at: Date.now() }, ...dismissals])

  const check = useCallback(
    async (force = false) => {
      checkedAt.current = Date.now()
      setChecking(true)
      try {
        const result = await requestJson<WatchResponse>(`/api/assistant/watch${force ? '?fresh=1' : ''}`, {
          noStore: true,
        })
        const projects = withTrackers
          ? await requestJson<{ projects: NewProject[] }>('/api/tracker-seeds-projects', { noStore: true })
              .then(body => newProjectAlerts(Array.isArray(body.projects) ? body.projects : []))
              .catch(() => projectAlertsNow.current)
          : []
        setProjectAlerts(projects)
        const server = Array.isArray(result.alerts) ? result.alerts : []
        setAlerts(server)
        setHandled([])
        const found = [...projects, ...server]
        const still = new Set(readDismissals(dismissedNow.current, Date.now()).map(entry => entry.key))
        // Heads-ups that were not there at the last check are announced, except on the first check of the page.
        const live = [...projects, ...shown(server, still)].filter(alert => !still.has(alert.key))
        if (known.current) setFresh(live.filter(alert => !known.current?.has(alert.key)).length)
        known.current = new Set(found.map(alert => alert.key))
      } catch {
        /* The watcher is a help, not a need: a failed check is tried again at the next one. */
      } finally {
        setChecking(false)
      }
    },
    [withTrackers],
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
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', away)
    document.addEventListener('keydown', onEscape)
    return () => {
      document.removeEventListener('pointerdown', away)
      document.removeEventListener('keydown', onEscape)
    }
  }, [open])

  // A timer left running for hours, or since an earlier day: a reminder only, it is never stopped for the person.
  const { timers } = useTimers()
  const nowMs = timerNow()
  const timerAlerts: WatchAlert[] = timers
    .filter(timer => forgottenTimer(timer, nowMs, timerDayOf))
    .map(timer => ({
      key: `timer:${timer.taskId}:${timer.pieces[timer.pieces.length - 1]?.start}`,
      severity: 'warning' as const,
      title: `Timer still running: ${store.items.find(item => item.id === timer.taskId)?.title || 'a task'}`,
      detail: `${clockText(elapsedMs(timer, nowMs))} so far. Still working on it? Stop it to log the time.`,
      open: { kind: 'task' as const, id: timer.taskId },
      ask: '',
    }))
  const hidden = new Set([...dismissed, ...handled])
  const live = [...timerAlerts, ...projectAlerts, ...shown(alerts, hidden)].filter(alert => !hidden.has(alert.key))
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
  /** The one-click changes of a heads-up, when this person may change its task. */
  const actionsOf = (alert: WatchAlert) => {
    const target = alert.open
    if (!alert.actions?.length) return []
    if (alert.actions[0].addToTracker) return alert.actions
    if (target.kind !== 'task') return []
    const item = store.items.find(entry => entry.id === target.id)
    return item && canEditActionItem(item) ? alert.actions : []
  }
  /** Adds a new Seeds project to the chosen tracker: a row with its task, as when a person names a site. */
  const addProject = async (alert: WatchAlert, action: WatchAction) => {
    const target = action.addToTracker
    if (!target) return
    setChecking(true)
    try {
      const done = await requestJson<{ tracker: { name: string } }>(
        `/api/trackers/${encodeURIComponent(target.trackerId)}/seeds-project`,
        { body: { projectId: target.projectId }, fallback: 'The project could not be added to the tracker.' },
      )
      setNotice(`Added to ${done.tracker?.name || 'the tracker'}, with its task.`)
      setHandled(keys => [...keys, alert.key])
      await app.refreshWorkspace(true).catch(() => undefined)
    } catch (failure) {
      setNotice(failure instanceof Error ? failure.message : 'The project could not be added to the tracker.')
    } finally {
      setChecking(false)
    }
  }
  const approve = (alert: WatchAlert, action: WatchAction) => {
    if (action.addToTracker) return void addProject(alert, action)
    if (!action.update) return
    const result = applyTaskUpdate(action.update)
    setNotice(result.message)
    if (!result.ok) return
    setHandled(keys => [...keys, alert.key])
    // Count again once the change is saved, so the heads-up goes for good.
    window.setTimeout(() => void check(true), 5000)
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
          {notice && (
            <p className="watch-notice" role="status">
              {notice}
            </p>
          )}
          <div className="notification-list">
            {live.map(alert => {
              const go = opener(alert)
              const actions = actionsOf(alert)
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
                    {canUseAI && alert.ask && (
                      <button type="button" title="Ask the BA Assistant about this" onClick={() => ask(alert)}>
                        <Sparkles size={14} />
                      </button>
                    )}
                    <button
                      type="button"
                      title="Dismiss until it gets worse"
                      onClick={() => dismiss(alert.key)}
                    >
                      <X size={14} />
                    </button>
                  </div>
                  {actions.length > 0 && (
                    <div className="watch-actions">
                      {actions.map(action => (
                        <button
                          type="button"
                          key={action.label}
                          disabled={checking}
                          title={
                            action.update
                              ? `${action.update.tasks[0].changes[0].label}: ${action.update.tasks[0].changes[0].to}`
                              : 'Adds a row for this project, with its task'
                          }
                          onClick={() => approve(alert, action)}
                        >
                          {action.label}
                        </button>
                      ))}
                    </div>
                  )}
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
