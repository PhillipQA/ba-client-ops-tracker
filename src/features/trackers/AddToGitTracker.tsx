/**
 * Work Hub › a ticket › GIT Trackers: the GIT Trackers the ticket is in (with Retry when making its rows and Tasks
 * failed), and Add to GIT Tracker. The ticket's work goes under the Client and Project its repository is mapped to
 * (Settings › Integrations › Repository mapping); an unmapped repository says so instead of offering to add.
 */
import { useEffect, useState } from 'react'
import { Plus, RefreshCw } from 'lucide-react'
import type { Client, Project } from '../../shared/types'
import { entryStatusText, type GitTicketOptions, gitTicketsApi } from './gitTicketsApi'
import type { GitTicketEntry } from './gitTicketModel'

type Props = {
  provider: 'gitlab' | 'github'
  ticketId: string
  repository: string
  clients: Client[]
  projects: Project[]
  /** Called after work was made, so Tasks shows the new Tasks. */
  onWorkMade?: () => Promise<void> | void
}

const statusClass = (entry: GitTicketEntry) =>
  `github-qa ${entry.status === 'Completed' ? 'github-qa--passed' : entry.status === 'Failed' ? 'github-qa--failed' : 'github-qa--in-progress'}`

export default function AddToGitTracker({ provider, ticketId, repository, clients, projects, onWorkMade }: Props) {
  const [options, setOptions] = useState<GitTicketOptions | null>(null)
  const [hidden, setHidden] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(false)
  const [trackerId, setTrackerId] = useState('')

  useEffect(() => {
    let alive = true
    setOptions(null)
    setOpen(false)
    setError('')
    setTrackerId('')
    gitTicketsApi
      .options(provider, ticketId)
      .then(result => {
        if (alive) setOptions(result)
      })
      .catch((failure: any) => {
        if (!alive) return
        // No Trackers for this person: the section does not show.
        if (failure?.status === 403) setHidden(true)
        else setError(failure instanceof Error ? failure.message : 'GIT Trackers could not be loaded.')
      })
    return () => {
      alive = false
    }
  }, [provider, ticketId])

  if (hidden) return null
  const entries = options?.entries || []
  const inTracker = new Set(entries.map(entry => entry.trackerId))
  const choices = (options?.trackers || []).filter(tracker => !inTracker.has(tracker.id))
  const where = options?.mapping
    ? `${clients.find(client => client.id === options.mapping?.clientId)?.name || 'Its client'} › ${
        projects.find(project => project.id === options.mapping?.projectId)?.name || 'its project'
      }`
    : ''

  const settle = async (result: GitTicketEntry) => {
    setOptions(current =>
      current
        ? {
            ...current,
            entries: [...current.entries.filter(entry => entry.id !== result.id), result],
          }
        : current,
    )
    if (result.status === 'Failed') setError(`${result.trackerName || 'The GIT Tracker'}: ${result.error}`)
    else {
      setError('')
      await onWorkMade?.()
    }
  }
  const add = async () => {
    if (!trackerId) return void setError('Choose a GIT Tracker.')
    setBusy(true)
    setError('')
    try {
      const { entry } = await gitTicketsApi.add(trackerId, provider, ticketId)
      setOpen(false)
      setTrackerId('')
      await settle(entry)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The ticket could not be added.')
    } finally {
      setBusy(false)
    }
  }
  const retry = async (entry: GitTicketEntry) => {
    setBusy(true)
    setError('')
    try {
      const result = await gitTicketsApi.retry(entry.trackerId, entry.id)
      await settle({ ...result.entry, trackerName: entry.trackerName })
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'It could not be tried again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="git-ticket-trackers" aria-label="GIT Trackers">
      <h4>GIT Trackers</h4>
      {!options && !error && <p className="github-help">Loading…</p>}
      {options && !entries.length && <p>Not in a GIT Tracker yet.</p>}
      {entries.length > 0 && (
        <ul className="git-ticket-entries">
          {entries.map(entry => (
            <li key={entry.id}>
              <span className="git-ticket-entry-name">{entry.trackerName || 'GIT Tracker'}</span>
              <span className={statusClass(entry)}>{entryStatusText(entry)}</span>
              {entry.status === 'Failed' && (
                <>
                  <small className="git-ticket-entry-error">{entry.error}</small>
                  {options?.canAdd && (
                    <button type="button" className="secondary" disabled={busy} onClick={() => void retry(entry)}>
                      <RefreshCw size={14} aria-hidden="true" /> Retry
                    </button>
                  )}
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {options?.canAdd && !open && (
        <div className="integration-actions">
          {choices.length ? (
            <button type="button" className="secondary" disabled={busy} onClick={() => setOpen(true)}>
              <Plus size={14} aria-hidden="true" /> Add to GIT Tracker
            </button>
          ) : (
            <p className="github-help">
              {options.trackers.length
                ? 'It is in every GIT Tracker.'
                : 'No GIT Trackers yet. Make one in Trackers › New tracker › GIT Tracker.'}
            </p>
          )}
        </div>
      )}
      {open && options && (
        <div className="github-task-form">
          <h4>Add to GIT Tracker</h4>
          <label>
            GIT Tracker
            <select value={trackerId} onChange={event => setTrackerId(event.target.value)} disabled={busy}>
              <option value="">Choose a GIT Tracker</option>
              {choices.map(tracker => (
                <option key={tracker.id} value={tracker.id}>
                  {tracker.name}
                </option>
              ))}
            </select>
          </label>
          {options.mapping ? (
            <p className="github-help">
              Its rows and Tasks go under <strong>{where}</strong>, from the repository mapping of {repository}.
            </p>
          ) : (
            <p className="git-ticket-unmapped" role="alert">
              {repository} is not mapped to a Client and Project yet. An Administrator maps it in Settings ›
              Integrations › Repository mapping; then add it here.
            </p>
          )}
          <div className="integration-actions">
            <button type="button" className="primary" disabled={busy || !options.mapping} onClick={() => void add()}>
              {busy ? 'Adding…' : 'Add'}
            </button>
            <button type="button" className="secondary" disabled={busy} onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {error && (
        <p className="git-ticket-unmapped" role="alert">
          {error}
        </p>
      )}
    </section>
  )
}
