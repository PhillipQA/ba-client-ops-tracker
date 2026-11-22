/**
 * A GIT Tracker's tickets: each GitLab or GitHub ticket added from Work Hub, the Client and Project its work went
 * under, and whether its rows and Tasks were made (Retry when they failed, Remove to take it out). Choosing a client
 * also narrows the grid to that client's ticket rows (`onFilter`).
 *
 * Rows follow their ticket (gitFollow.ts): Refresh syncs GitLab and GitHub in Work Hub and brings the rows up to
 * date; each ticket can stop following, and cells changed by hand are pinned until released here.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ExternalLink, Pin, RefreshCw, Trash2, X } from 'lucide-react'
import type { Client, Project } from '../../shared/types'
import { workHubSync } from '../work-hub/workHubSync'
import { entryStatusText, gitTicketsApi, refreshText } from './gitTicketsApi'
import type { GitTicketEntry } from './gitTicketModel'
import { announceRefresh, GIT_REFRESHED } from './gitRefresh'
import type { TrackerColumn } from './trackerModel'

type Props = {
  trackerId: string
  canEdit: boolean
  /** The tracker's columns, to name pinned cells. */
  columns: TrackerColumn[]
  clients: Client[]
  projects: Project[]
  /** The rows to show for the chosen client, or null for every row. */
  onFilter: (rowIds: ReadonlySet<string> | null) => void
  /** Rows or Tasks changed (a retry made them, a removal deleted rows): load the tracker again. */
  onChanged: () => Promise<void> | void
  say: (kind: 'error' | 'info', text: string) => void
}

export default function GitTicketsPanel({
  trackerId,
  canEdit,
  columns,
  clients,
  projects,
  onFilter,
  onChanged,
  say,
}: Props) {
  const [entries, setEntries] = useState<GitTicketEntry[] | null>(null)
  const [clientId, setClientId] = useState('')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    try {
      const result = await gitTicketsApi.list(trackerId)
      setEntries(result.entries)
      setError('')
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The tickets could not be loaded.')
    }
  }, [trackerId])
  useEffect(() => {
    void load()
  }, [load])
  // Rows were brought up to date (sign-in, a Work Hub sync): show the new values.
  const changedRef = useRef(onChanged)
  changedRef.current = onChanged
  useEffect(() => {
    const changed = () => {
      void load()
      void changedRef.current()
    }
    window.addEventListener(GIT_REFRESHED, changed)
    return () => window.removeEventListener(GIT_REFRESHED, changed)
  }, [load])
  const columnName = (id: string) => columns.find(column => column.id === id)?.name || 'A removed column'

  const clientName = (id: string) => clients.find(client => client.id === id)?.name || 'A client you can’t see'
  const projectName = (id: string) => projects.find(project => project.id === id)?.name || 'a project'
  const clientIds = useMemo(() => [...new Set((entries || []).map(entry => entry.clientId))], [entries])
  const shown = (entries || []).filter(entry => !clientId || entry.clientId === clientId)

  // The grid follows the chosen client: only the rows its tickets made.
  useEffect(() => {
    if (!clientId || !entries) return onFilter(null)
    onFilter(new Set(entries.filter(entry => entry.clientId === clientId).flatMap(entry => entry.rowIds || [])))
  }, [clientId, entries, onFilter])
  useEffect(() => () => onFilter(null), [onFilter])

  const retry = async (entry: GitTicketEntry) => {
    setBusy(entry.id)
    try {
      const { entry: result } = await gitTicketsApi.retry(trackerId, entry.id)
      if (result.status === 'Failed') say('error', `#${entry.number}: ${result.error}`)
      else say('info', `#${entry.number} was added: its rows and Tasks are made.`)
      await load()
      await onChanged()
    } catch (failure) {
      say('error', failure instanceof Error ? failure.message : 'It could not be tried again.')
    } finally {
      setBusy('')
    }
  }
  /** Refresh: sync GitLab and GitHub in Work Hub, then bring this tracker's ticket rows up to date. */
  const refreshRows = async () => {
    setBusy('refresh')
    try {
      await Promise.all([workHubSync.syncOne('gitlab'), workHubSync.syncOne('github')])
      const failed = (['gitlab', 'github'] as const)
        .map(id => workHubSync.getSnapshot().integrations[id])
        .filter(status => status.phase === 'error')
        .map(status => status.message)
      const result = await gitTicketsApi.refresh(trackerId)
      announceRefresh(result)
      const text = refreshText(result)
      if (result.needsUpgrade) say('error', text)
      else say(failed.length ? 'error' : 'info', [...failed, text || 'Every ticket row is up to date.'].join(' '))
      await load()
    } catch (failure) {
      say('error', failure instanceof Error ? failure.message : 'The rows could not be refreshed.')
    } finally {
      setBusy('')
    }
  }
  const follow = async (entry: GitTicketEntry, change: { follows?: boolean; unpin?: string[] | 'all' }) => {
    setBusy(entry.id)
    try {
      const { refreshed } = await gitTicketsApi.follow(trackerId, entry.id, change)
      if (refreshed) {
        announceRefresh(refreshed)
        const text = refreshText(refreshed)
        if (text) say('info', `#${entry.number}: ${text}`)
      }
      if (change.follows === false) say('info', `#${entry.number} no longer follows its ticket.`)
      await load()
    } catch (failure) {
      say('error', failure instanceof Error ? failure.message : 'It could not be changed.')
    } finally {
      setBusy('')
    }
  }
  const remove = async (entry: GitTicketEntry) => {
    if (
      !window.confirm(
        `Take #${entry.number} ${entry.title} out of this GIT Tracker? Its ${entry.rowIds?.length || 0} row(s) are deleted; its Tasks stay in Tasks.`,
      )
    )
      return
    setBusy(entry.id)
    try {
      const result = await gitTicketsApi.remove(trackerId, entry.id)
      say('info', `#${entry.number} was taken out (${result.rows} row${result.rows === 1 ? '' : 's'} deleted).`)
      await load()
      await onChanged()
    } catch (failure) {
      say('error', failure instanceof Error ? failure.message : 'It could not be taken out.')
    } finally {
      setBusy('')
    }
  }

  return (
    <details className="trk-git-tickets">
      <summary>
        <span>Tickets ({entries ? entries.length : '…'})</span>
        {entries?.some(entry => entry.status === 'Failed') && (
          <span className="trk-git-failed">{entries.filter(entry => entry.status === 'Failed').length} failed</span>
        )}
      </summary>
      <div className="trk-git-tickets-body">
        <p className="trk-git-help">
          Add GitLab and GitHub tickets from Work Hub (open a ticket › Add to GIT Tracker). Each ticket’s rows, Tasks
          and Subtasks go under the Client and Project its repository is mapped to.
        </p>
        <p className="trk-git-help">
          Columns named after a ticket field (Title, Labels, Assignees, Milestone, Due date, State…) or a label group
          (Priority takes High from <code>priority::high</code>) fill themselves. They follow the ticket at sign-in,
          on Sync in Work Hub, and on Refresh. Cells you change by hand are pinned and keep your value.
        </p>
        <div className="trk-git-refresh">
          <button type="button" className="secondary" disabled={Boolean(busy)} onClick={() => void refreshRows()}>
            <RefreshCw size={13} aria-hidden="true" /> {busy === 'refresh' ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
        {clientIds.length > 0 && (
          <label className="trk-git-client">
            Client
            <select value={clientId} onChange={event => setClientId(event.target.value)}>
              <option value="">All clients</option>
              {clientIds.map(id => (
                <option key={id} value={id}>
                  {clientName(id)}
                </option>
              ))}
            </select>
          </label>
        )}
        {error && (
          <p className="trk-git-error" role="alert">
            {error}
          </p>
        )}
        {entries && !entries.length && <p className="trk-git-help">No tickets yet.</p>}
        {shown.length > 0 && (
          <table className="trk-git-table">
            <thead>
              <tr>
                <th>Ticket</th>
                <th>Client › Project</th>
                <th>Status</th>
                <th>Follows ticket</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {shown.map(entry => (
                <tr key={entry.id}>
                  <td>
                    <a href={entry.url} target="_blank" rel="noopener noreferrer">
                      #{entry.number} {entry.title} <ExternalLink size={12} aria-hidden="true" />
                    </a>
                    <small>
                      {entry.repository} · added by {entry.addedByName || 'someone'}
                    </small>
                  </td>
                  <td>
                    {clientName(entry.clientId)} › {projectName(entry.projectId)}
                  </td>
                  <td>
                    <span className={`trk-git-status trk-git-status--${entry.status.toLowerCase()}`}>
                      {entryStatusText(entry)}
                    </span>
                    {entry.status === 'Failed' && <small>{entry.error}</small>}
                  </td>
                  <td className="trk-git-follow">
                    <label>
                      <input
                        type="checkbox"
                        checked={entry.follows}
                        disabled={!canEdit || Boolean(busy)}
                        onChange={event => void follow(entry, { follows: event.target.checked })}
                      />
                      {entry.follows ? 'On' : 'Off'}
                    </label>
                    {entry.pinnedColumns.length > 0 && (
                      <ul className="trk-git-pins" aria-label="Pinned cells">
                        {entry.pinnedColumns.map(id => (
                          <li key={id} title="Changed by hand, so it keeps your value">
                            <Pin size={11} aria-hidden="true" /> {columnName(id)}
                            {canEdit && (
                              <button
                                type="button"
                                className="trk-git-unpin"
                                disabled={Boolean(busy)}
                                aria-label={`Release ${columnName(id)}: follow the ticket again`}
                                title="Follow the ticket again"
                                onClick={() => void follow(entry, { unpin: [id] })}
                              >
                                <X size={11} aria-hidden="true" />
                              </button>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                  </td>
                  <td className="trk-git-actions">
                    {canEdit && entry.status === 'Failed' && (
                      <button
                        type="button"
                        className="secondary"
                        disabled={Boolean(busy)}
                        onClick={() => void retry(entry)}
                      >
                        <RefreshCw size={13} aria-hidden="true" /> Retry
                      </button>
                    )}
                    {canEdit && (
                      <button
                        type="button"
                        className="secondary"
                        disabled={Boolean(busy)}
                        aria-label={`Take #${entry.number} out of this GIT Tracker`}
                        title="Take it out of this GIT Tracker"
                        onClick={() => void remove(entry)}
                      >
                        <Trash2 size={13} aria-hidden="true" />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </details>
  )
}
