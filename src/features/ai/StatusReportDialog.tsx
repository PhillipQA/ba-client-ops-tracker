/**
 * The weekly status report for one project, as an email draft (server/ai/brief-routes.ts writes it from what the
 * person may see). For the client: done, coming up, what needs their input and watch-outs, nothing internal. For the
 * team: that plus work waiting on others, hours and notes. The person reads and edits it here, then opens it in the
 * email window (filed under a task, as every sent email is) or copies it. Nothing is sent from this dialog.
 */
import { useEffect, useMemo, useState } from 'react'
import { Copy, LoaderCircle, Mail, RefreshCw, Sparkles } from 'lucide-react'
import type { Store } from '../../app/store'
import { requestJson } from '../../shared/http'
import type { Client, Project } from '../../shared/types'
import { Dialog } from '../../shared/ui/Dialog'
import { composeEmail } from '../email/composeEvent'
import { useEmailEnabled } from '../email/EmailComposer'
import { isTaskArchived, isTaskFinished } from '../tasks/lifecycle'
import { projectClientIds, type ReportAudience, type StatusFacts } from './statusReport'

type ReportResponse = {
  facts: StatusFacts
  email: { subject: string; body: string }
  ai: boolean
  note?: string
  to?: string
}

/** A task that looks like the place for status emails, offered first. */
const REPORTISH = /status|weekly|meeting|report|update/i

/** "Done 3 · Coming up 2 · …", the counts behind the draft. */
export function reportCounts(facts: StatusFacts) {
  return [
    `Done ${facts.done.total}`,
    `Coming up ${facts.next.total}`,
    facts.overdue.total ? `Overdue ${facts.overdue.total}` : '',
    facts.needsClient.total ? `Waiting on the client ${facts.needsClient.total}` : '',
    facts.signatures.length ? `Awaiting signature ${facts.signatures.length}` : '',
    ...facts.trackers.map(tracker => `${tracker.name}: ${tracker.complete} of ${tracker.sites} sites done`),
  ]
    .filter(Boolean)
    .join(' · ')
}

export function StatusReportDialog({
  project,
  store,
  clientId: shownClientId,
  onClose,
}: {
  project: Project
  store: Store
  /** The client the screen was showing, if any: the report starts with that client. */
  clientId?: string | null
  onClose: () => void
}) {
  const canEmail = useEmailEnabled()
  const clientIds = useMemo(() => projectClientIds(store, project.id), [store, project.id])
  const clients = clientIds
    .map(id => store.clients.find(client => client.id === id))
    .filter((client): client is Client => Boolean(client))
  const [audience, setAudience] = useState<ReportAudience>('client')
  const [clientId, setClientId] = useState(() =>
    shownClientId && clientIds.includes(shownClientId) ? shownClientId : clientIds.length === 1 ? clientIds[0] : '',
  )
  // A client email on a project shared by several clients waits until the client is chosen.
  const needsClient = audience === 'client' && clientIds.length > 1 && !clientId
  const [report, setReport] = useState<ReportResponse | null>(null)
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [again, setAgain] = useState(0)
  const [copied, setCopied] = useState('')

  // again is the trigger for Write again.
  // biome-ignore lint/correctness/useExhaustiveDependencies: again only asks for a new draft
  useEffect(() => {
    setCopied('')
    if (needsClient) {
      setReport(null)
      setError('')
      return
    }
    const controller = new AbortController()
    setLoading(true)
    setError('')
    requestJson<ReportResponse>('/api/assistant/status-report', {
      method: 'POST',
      body: { projectId: project.id, audience, ...(clientId ? { clientId } : {}) },
      signal: controller.signal,
      fallback: 'The status report could not be written.',
    })
      .then(result => {
        setReport(result)
        setSubject(result.email.subject)
        setBody(result.email.body)
        setLoading(false)
      })
      .catch(failure => {
        if (controller.signal.aborted) return
        setError(failure instanceof Error ? failure.message : 'The status report could not be written.')
        setLoading(false)
      })
    return () => controller.abort()
  }, [project.id, audience, clientId, needsClient, again])

  // The task the email is kept on: the one chosen last time for this project, else one that looks like the place.
  const fileKey = `ba.statusReport.task:${project.id}`
  const candidates = useMemo(
    () =>
      store.items
        .filter(
          item =>
            item.projectId === project.id &&
            !item.parentTaskId &&
            (!clientId || item.clientId === clientId) &&
            !isTaskArchived(store.items, item) &&
            !isTaskFinished(item, store.taskSettings),
        )
        .sort(
          (a, b) => Number(REPORTISH.test(b.title)) - Number(REPORTISH.test(a.title)) || a.title.localeCompare(b.title),
        ),
    [store.items, store.taskSettings, project.id, clientId],
  )
  const remembered = useMemo(() => {
    try {
      return window.localStorage.getItem(fileKey) || ''
    } catch {
      return ''
    }
  }, [fileKey])
  const [chosen, setChosen] = useState<string | null>(null)
  const guess = candidates.find(task => task.id === remembered) || candidates.find(task => REPORTISH.test(task.title))
  const fileUnder =
    chosen !== null && (chosen === '' || candidates.some(task => task.id === chosen)) ? chosen : guess?.id || ''

  const openEmail = () => {
    try {
      if (fileUnder) window.localStorage.setItem(fileKey, fileUnder)
    } catch {
      /* The choice is offered again next time. */
    }
    composeEmail({
      // A team update never goes to the client, so the client's address is not filled in.
      ...(audience === 'team' ? { to: '' } : report?.to ? { to: report.to } : {}),
      subject: subject.trim(),
      message: body,
      taskIds: fileUnder ? [fileUnder] : [],
      notice: `${report?.ai ? 'Written with AI from' : 'Written from'} this week’s facts. Read it over before you send it.`,
    })
    onClose()
  }
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(`${subject.trim()}\n\n${body}`)
      setCopied('Copied.')
    } catch {
      setCopied('Copying did not work here. Select the text and copy it.')
    }
  }

  return (
    <Dialog title="Weekly status report" eyebrow={project.name} onClose={onClose} size="medium">
      <div className="status-report">
        <div className="status-report-options">
          <fieldset className="status-report-audience">
            <legend>Who the report is for</legend>
            {(['client', 'team'] as const).map(value => (
              <button
                key={value}
                type="button"
                className={audience === value ? 'secondary active-tab' : 'secondary'}
                aria-pressed={audience === value}
                onClick={() => setAudience(value)}
              >
                {value === 'client' ? 'For the client' : 'For the team'}
              </button>
            ))}
          </fieldset>
          {clients.length > 1 && (
            <label>
              Client
              <select value={clientId} onChange={event => setClientId(event.target.value)}>
                <option value="">{audience === 'team' ? 'All clients' : 'Choose the client'}</option>
                {clients.map(client => (
                  <option key={client.id} value={client.id}>
                    {client.name}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        <p className="status-report-hint">
          {audience === 'client'
            ? 'Done this week, coming up, what needs their input and watch-outs. Nothing internal: no hours, notes or work waiting on your team.'
            : 'Adds work waiting on others, hours by person and this week’s project notes.'}
        </p>
        {needsClient && (
          <p className="status-report-hint" role="status">
            This project has work for more than one client. Choose the client this update is for.
          </p>
        )}
        {loading && (
          <p className="status-report-hint" role="status">
            <LoaderCircle size={14} className="spin" aria-hidden="true" /> Writing the report…
          </p>
        )}
        {error && (
          <p className="status-report-error" role="alert">
            {error}
          </p>
        )}
        {report && !loading && !needsClient && (
          <>
            <p className="status-report-meta">
              <Sparkles size={14} aria-hidden="true" />{' '}
              {report.ai
                ? 'Written with AI from this week’s facts. Read it over before you send it.'
                : 'Written from this week’s facts.'}
              {report.note ? ` ${report.note}` : ''}
            </p>
            <p className="status-report-counts">{reportCounts(report.facts)}</p>
            <label className="status-report-field">
              Subject
              <input value={subject} maxLength={200} onChange={event => setSubject(event.target.value)} />
            </label>
            <label className="status-report-field">
              Email
              <textarea value={body} rows={14} maxLength={8000} onChange={event => setBody(event.target.value)} />
            </label>
            <label className="status-report-field">
              File under task
              <select value={fileUnder} onChange={event => setChosen(event.target.value)}>
                <option value="">Choose in the email window</option>
                {candidates.map(task => (
                  <option key={task.id} value={task.id}>
                    {task.title}
                  </option>
                ))}
              </select>
              <small>A sent email is kept on its task.</small>
            </label>
            <div className="k-dialog-actions">
              {canEmail && (
                <button
                  type="button"
                  className="primary"
                  onClick={openEmail}
                  disabled={!subject.trim() || !body.trim()}
                >
                  <Mail size={16} aria-hidden="true" /> Open in email
                </button>
              )}
              <button type="button" className="secondary" onClick={() => void copy()}>
                <Copy size={16} aria-hidden="true" /> Copy
              </button>
              <button type="button" className="secondary" onClick={() => setAgain(value => value + 1)}>
                <RefreshCw size={16} aria-hidden="true" /> Write again
              </button>
              {copied && (
                <span className="status-report-hint" role="status">
                  {copied}
                </span>
              )}
            </div>
            {!canEmail && (
              <p className="status-report-hint">To send it from here, allow sending for your Gmail in Work Hub.</p>
            )}
          </>
        )}
      </div>
    </Dialog>
  )
}
