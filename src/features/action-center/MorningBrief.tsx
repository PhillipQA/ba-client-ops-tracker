/**
 * The morning brief at the top of the Action Center: the person's overdue work, what is due today, follow-ups,
 * go-lives this week, emails waiting on them and yesterday's time, counted by the server from what they may see
 * (server/ai/brief-routes.ts). With the BA Assistant on, a short AI summary is written only when the person asks for
 * it, at most once a day (the server keeps it for the day); it only words the facts. Every item opens where the work is; nothing is changed from here.
 */
import { type ReactNode, useEffect, useState } from 'react'
import { ChevronDown, ChevronUp, Clock, ListTodo, LoaderCircle, RefreshCw, Sparkles } from 'lucide-react'
import type { AppState, SignedInUser } from '../../app/useAppState'
import { requestJson } from '../../shared/http'
import type { BriefEmail, BriefFacts, BriefGoLive, BriefItem, BriefSection, BriefSummary } from '../ai/brief'
import { reportDate } from '../ai/statusReport'
import { rememberTrackerRow } from '../trackers/trackerNav'
import { rememberWorkHubMessage } from '../work-hub/workHubNav'

type BriefResponse = { facts: BriefFacts; summary: BriefSummary | null; ai: { available: boolean } }

const plural = (count: number, word: string, many = `${word}s`) => `${count} ${count === 1 ? word : many}`
const hours = (value: number) => `${Math.round(value * 10) / 10} h`
/** The time a summary was written, in the person's own clock: it may be older than the counts after a change. */
const writtenAt = (iso: string) => {
  const at = new Date(iso)
  return Number.isNaN(at.getTime()) ? '' : at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}
/** The later of two summaries: a reload that started before a rewrite must not bring back the old one. */
const newer = (a: BriefSummary | null | undefined, b: BriefSummary | null) =>
  !a ? b : !b ? a : a.generatedAt >= b.generatedAt ? a : b

/** "2 overdue · 1 due today · 3 follow-ups", or that nothing waits. */
export function briefCounts(facts: BriefFacts) {
  const parts = [
    facts.overdue.total ? `${facts.overdue.total} overdue` : '',
    facts.dueToday.total ? `${facts.dueToday.total} due today` : '',
    facts.followUps.total ? plural(facts.followUps.total, 'follow-up') : '',
    facts.goLives.total ? plural(facts.goLives.total, 'go-live') : '',
    facts.emails?.total ? `${plural(facts.emails.total, 'email')} waiting` : '',
  ].filter(Boolean)
  return parts.length ? parts.join(' · ') : 'Nothing is waiting on you'
}
const late = (days = 0) => (days < 0 ? `${plural(-days, 'day')} late` : days === 0 ? 'due today' : '')
const goLiveWhen = (days: number) =>
  days === 0
    ? 'Go-live today'
    : days > 0
      ? `Go-live in ${plural(days, 'day')}`
      : `Go-live was ${plural(-days, 'day')} ago`
const waited = (days: number) => (days === 0 ? 'today' : `waiting ${plural(days, 'day')}`)
const itemMeta = (item: BriefItem, when: string) =>
  [item.parentTitle ? `in ${item.parentTitle}` : '', item.client, item.project, when].filter(Boolean).join(' · ')

function Section<T>({
  title,
  tone,
  section,
  onMore,
  children,
}: {
  title: string
  tone?: 'danger' | 'warning'
  section: BriefSection<T> | null
  onMore?: () => void
  children: (item: T) => ReactNode
}) {
  if (!section?.total) return null
  const more = section.total - section.items.length
  return (
    <section className={`brief-section${tone ? ` ${tone}` : ''}`} aria-label={title}>
      <h3>
        {title} <span className="brief-count">{section.total}</span>
      </h3>
      <ul>{section.items.map(children)}</ul>
      {more > 0 &&
        (onMore ? (
          <button type="button" className="brief-link" onClick={onMore}>
            +{more} more
          </button>
        ) : (
          <small className="brief-muted">+{more} more</small>
        ))}
    </section>
  )
}

/** One line: opens where the work is when it can. */
function Row({ title, meta, onOpen, extra }: { title: string; meta: string; onOpen?: () => void; extra?: ReactNode }) {
  const body = (
    <>
      <strong>{title}</strong>
      {meta && <small>{meta}</small>}
    </>
  )
  return (
    <li className="brief-row">
      {onOpen ? (
        <button type="button" className="brief-row-main" onClick={onOpen}>
          {body}
        </button>
      ) : (
        <div className="brief-row-main">{body}</div>
      )}
      {extra}
    </li>
  )
}

export function MorningBrief({ app, currentUser }: { app: AppState; currentUser: SignedInUser }) {
  const {
    canEditActionItem,
    canUseAI,
    canWriteTasks,
    hasModule,
    openTaskEditor,
    setAiClientId,
    setAiProjectId,
    setAiPrompt,
    setView,
    store,
  } = app
  const openKey = `ba.brief.open:${currentUser.organizationId || ''}:${currentUser.id}`
  const [open, setOpen] = useState(() => {
    try {
      return window.localStorage.getItem(openKey) !== 'closed'
    } catch {
      return true
    }
  })
  const [data, setData] = useState<BriefResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [reload, setReload] = useState(0)
  const [writing, setWriting] = useState(false)
  const [summaryError, setSummaryError] = useState('')
  // reload is the trigger: each Refresh counts the brief again.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reload only asks for a new count
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError('')
    requestJson<BriefResponse>('/api/assistant/brief', {
      signal: controller.signal,
      noStore: true,
      fallback: 'Your brief could not be loaded.',
    })
      .then(result => {
        setData(current => ({ ...result, summary: newer(current?.summary, result.summary) }))
        setLoading(false)
      })
      .catch(failure => {
        if (controller.signal.aborted) return
        setError(failure instanceof Error ? failure.message : 'Your brief could not be loaded.')
        setLoading(false)
      })
    return () => controller.abort()
  }, [reload])

  const writeSummary = async () => {
    setWriting(true)
    setSummaryError('')
    try {
      const result = await requestJson<{ summary: BriefSummary }>('/api/assistant/brief/summary', {
        method: 'POST',
        body: {},
        fallback: 'The summary could not be written.',
      })
      setData(current => (current ? { ...current, summary: newer(current.summary, result.summary) } : current))
    } catch (failure) {
      setSummaryError(failure instanceof Error ? failure.message : 'The summary could not be written.')
    } finally {
      setWriting(false)
    }
  }

  const toggle = () => {
    const next = !open
    setOpen(next)
    try {
      window.localStorage.setItem(openKey, next ? 'open' : 'closed')
    } catch {
      /* The choice lasts until the page reloads. */
    }
  }
  // Refresh only counts again: the AI summary is never rewritten on its own, so it costs no tokens.
  const refresh = () => setReload(value => value + 1)

  const facts = data?.facts
  const workItem = (id: string) => store.items.find(item => item.id === id)
  /** Opens the task editor when this person may edit the task. */
  const openTask = (id: string) => {
    const item = workItem(id)
    return item && canEditActionItem(item) ? () => openTaskEditor(id) : undefined
  }
  const toTasks = hasModule('items') ? () => setView('items') : undefined
  const draftFollowUp = (entry: BriefItem) => {
    const item = workItem(entry.id)
    setAiClientId(item?.clientId || '')
    setAiProjectId(item?.projectId || '')
    setAiPrompt(
      `Draft a short, polite follow-up message about "${entry.title}"${entry.client ? ` for ${entry.client}` : ''}.` +
        `${entry.waitingOn ? ` It is waiting on ${entry.waitingOn}` : ''}` +
        `${entry.date ? ` (follow-up date ${reportDate(entry.date)})` : ''}. Use the task's details and keep it brief.`,
    )
    setView('ai')
  }
  const taskRow = (when: (item: BriefItem) => string, extra?: (item: BriefItem) => ReactNode) => (item: BriefItem) => (
    <Row
      key={item.id}
      title={item.title}
      meta={itemMeta(item, when(item))}
      onOpen={openTask(item.id)}
      extra={extra?.(item)}
    />
  )
  const goLiveRow = (site: BriefGoLive) => (
    <Row
      key={`${site.trackerId}:${site.rowId}`}
      title={site.site}
      meta={[
        site.trackerName,
        goLiveWhen(site.days),
        site.openSteps ? `${site.openSteps} of ${plural(site.totalSteps, 'step')} open` : 'all steps done',
      ].join(' · ')}
      onOpen={
        hasModule('trackers')
          ? () => {
              rememberTrackerRow(site.trackerId, site.rowId)
              setView('trackers')
            }
          : undefined
      }
    />
  )
  const emailRow = (email: BriefEmail) => (
    <Row
      key={email.id}
      title={email.subject}
      meta={[email.unread ? 'Unread' : '', email.from, email.source === 'Discord' ? 'Discord' : '', waited(email.days)]
        .filter(Boolean)
        .join(' · ')}
      onOpen={() => {
        rememberWorkHubMessage(email.id, email.source)
        setView('inbox')
      }}
    />
  )
  const clear =
    facts &&
    !facts.overdue.total &&
    !facts.dueToday.total &&
    !facts.followUps.total &&
    !facts.goLives.total &&
    !facts.emails?.total
  const time = facts?.time
  // Time is for people who log it on tasks.
  const showTime = Boolean(time && canWriteTasks)

  return (
    <div className="panel dashboard-panel morning-brief" aria-busy={loading}>
      <div className="panel-heading dashboard-panel-heading">
        <div>
          <div className="ai-title-line">
            <ListTodo size={18} aria-hidden="true" />
            <h2>Morning brief</h2>
          </div>
          <p>
            {facts ? `${reportDate(facts.date)} · ${briefCounts(facts)}` : loading ? 'Counting your day…' : 'Your day'}
          </p>
        </div>
        <div className="dashboard-panel-actions">
          <button
            type="button"
            className="secondary compact"
            onClick={refresh}
            disabled={loading || writing}
            title="Count your day again (does not use the AI)"
          >
            <RefreshCw size={14} aria-hidden="true" /> Refresh
          </button>
          <button type="button" className="secondary compact" onClick={toggle} aria-expanded={open}>
            {open ? <ChevronUp size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}
            {open ? 'Hide' : 'Show'}
          </button>
        </div>
      </div>
      {open && (
        <div className="brief-body">
          {error && (
            <p className="brief-error" role="alert">
              {error}{' '}
              <button type="button" className="brief-link" onClick={() => setReload(value => value + 1)}>
                Try again
              </button>
            </p>
          )}
          {!facts && loading && (
            <p className="brief-muted" role="status">
              <LoaderCircle size={14} className="spin" aria-hidden="true" /> Getting your brief…
            </p>
          )}
          {facts && data?.ai.available && (
            <div className="brief-summary" aria-live="polite">
              <Sparkles size={16} aria-hidden="true" />
              {data.summary ? (
                <div>
                  <p>{data.summary.summary}</p>
                  {data.summary.focus.length > 0 && (
                    <ol>
                      {data.summary.focus.map(line => (
                        <li key={line}>{line}</li>
                      ))}
                    </ol>
                  )}
                  <small className="brief-muted">Written at {writtenAt(data.summary.generatedAt)}</small>
                </div>
              ) : writing ? (
                <p className="brief-muted">
                  <LoaderCircle size={14} className="spin" aria-hidden="true" /> Writing your summary…
                </p>
              ) : summaryError ? (
                <p className="brief-muted">
                  {summaryError}{' '}
                  <button type="button" className="brief-link" onClick={() => void writeSummary()}>
                    Try again
                  </button>
                </p>
              ) : (
                <p className="brief-muted">
                  Would you like your morning brief?{' '}
                  <button type="button" className="brief-link" onClick={() => void writeSummary()}>
                    Write my morning brief
                  </button>{' '}
                  It uses the AI once and is kept for the rest of the day.
                </p>
              )}
            </div>
          )}
          {facts && clear && <p className="brief-clear">Nothing needs you right now.</p>}
          {facts && !clear && (
            <div className="brief-sections">
              <Section title="Overdue" tone="danger" section={facts.overdue} onMore={toTasks}>
                {taskRow(item => late(item.days))}
              </Section>
              <Section title="Due today" tone="warning" section={facts.dueToday} onMore={toTasks}>
                {taskRow(() => '')}
              </Section>
              <Section title="Follow-ups" section={facts.followUps} onMore={toTasks}>
                {taskRow(
                  item =>
                    [
                      item.waitingOn ? `waiting on ${item.waitingOn}` : '',
                      item.date ? `follow-up ${reportDate(item.date)}` : '',
                    ]
                      .filter(Boolean)
                      .join(', '),
                  item =>
                    canUseAI ? (
                      <button
                        type="button"
                        className="brief-link"
                        onClick={() => draftFollowUp(item)}
                        aria-label={`Draft a follow-up for ${item.title}`}
                      >
                        Draft follow-up
                      </button>
                    ) : null,
                )}
              </Section>
              <Section
                title="Go-lives this week"
                section={facts.goLives}
                onMore={hasModule('trackers') ? () => setView('trackers') : undefined}
              >
                {goLiveRow}
              </Section>
              <Section
                title="Emails waiting on you"
                section={facts.emails}
                onMore={hasModule('inbox') ? () => setView('inbox') : undefined}
              >
                {emailRow}
              </Section>
            </div>
          )}
          {facts && time && showTime && (
            <div className={`brief-time${time.hours < time.expected ? ' short' : ''}`}>
              <Clock size={15} aria-hidden="true" />
              <span>
                {reportDate(time.day)}: {hours(time.hours)} of {hours(time.expected)} logged
                {time.unsent && time.unsent.count > 0 && (
                  <>
                    {' · '}
                    {plural(time.unsent.count, 'entry', 'entries')} ({hours(time.unsent.hours)}) not sent to Seeds
                    {time.unsent.failed > 0 ? `, ${time.unsent.failed} failed` : ''}
                  </>
                )}
              </span>
              {time.unsent?.tasks.map(task => {
                const openIt = openTask(task.id)
                return openIt ? (
                  <button key={task.id} type="button" className="brief-link" onClick={openIt}>
                    Open {task.title}
                  </button>
                ) : null
              })}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
