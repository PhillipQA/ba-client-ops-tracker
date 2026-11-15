/**
 * Built-in Action Center widgets: my time this week (against a weekly target the person sets; 40 hours unless
 * changed), follow-ups due, recent tracker changes, and the person's own links and note.
 */
import { CalendarCheck, Clock3, ExternalLink, History, Link2, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { LINK_LIMITS, type QuickLink, cleanLink } from '../../shared/actionCenterSettings'
import { requestJson } from '../../shared/http'
import type { Client, WorkItem } from '../../shared/types'
import { rememberTrackerRow } from '../trackers/trackerNav'
import { followUpsDue, lateness, timeThisWeek } from './widgetData'

type View = (view: any) => void
const hours = (value: number) => `${value % 1 ? value.toFixed(1).replace(/\.0$/, '') : value}h`

export function TimeWidget({
  items,
  meId,
  today,
  weeklyHours,
  onTarget,
  setView,
}: {
  items: WorkItem[]
  meId: string
  today: string
  weeklyHours: number
  /** Saves the person's weekly target; undefined while customizing (it is saved with the layout). */
  onTarget: (hours: number) => void
  setView: View
}) {
  const week = timeThisWeek(items, meId, today, weeklyHours)
  const [editing, setEditing] = useState(false)
  const [target, setTarget] = useState(String(weeklyHours))
  const top = Math.max(week.daily, ...week.days.map(day => day.hours), 1)
  const percent = Math.min(100, Math.round((week.total / Math.max(week.target, 1)) * 100))
  return (
    <div className="panel dashboard-panel ac-time">
      <div className="panel-heading dashboard-panel-heading">
        <div>
          <h2>
            <Clock3 size={17} /> My time this week
          </h2>
          <p>
            {hours(week.total)} of {hours(week.target)} · {percent}%
            {week.unsentEntries
              ? ` · ${week.unsentEntries} ${week.unsentEntries === 1 ? 'entry' : 'entries'} not sent to Seeds`
              : ''}
          </p>
        </div>
        <div className="dashboard-panel-actions">
          <button type="button" className="secondary" onClick={() => setEditing(value => !value)}>
            <Pencil size={14} /> Target
          </button>
          {week.unsentEntries > 0 && (
            <button type="button" className="secondary" onClick={() => setView('seeds')}>
              Send to Seeds
            </button>
          )}
        </div>
      </div>
      {editing && (
        <form
          className="ac-inline-form"
          onSubmit={event => {
            event.preventDefault()
            const value = Number(target)
            if (!Number.isFinite(value) || value < 1 || value > 100) return
            onTarget(Math.round(value * 2) / 2)
            setEditing(false)
          }}
        >
          <label>
            Weekly target (hours)
            <input
              type="number"
              min={1}
              max={100}
              step={0.5}
              value={target}
              onChange={event => setTarget(event.target.value)}
            />
          </label>
          <button type="submit" className="primary">
            Save
          </button>
          <button type="button" className="link-button" onClick={() => onTarget(40)}>
            Back to 40
          </button>
        </form>
      )}
      <div className="ac-time-bar" aria-hidden="true">
        <span style={{ width: `${percent}%` }} />
      </div>
      <ol className="ac-time-days" aria-label="Hours by day">
        {week.days.map((day, index) => (
          <li key={day.date} className={day.date === today ? 'today' : ''}>
            <span className="ac-time-value">{day.hours ? hours(day.hours) : ''}</span>
            <span className="ac-time-column">
              {index < 5 && (
                <i className="ac-time-target" style={{ bottom: `${(week.daily / top) * 100}%` }} title="Daily target" />
              )}
              <b
                className={index < 5 && day.hours >= week.daily ? 'met' : ''}
                style={{ height: `${(day.hours / top) * 100}%` }}
              />
            </span>
            <span className="ac-time-label" title={day.date}>
              {day.label}
            </span>
          </li>
        ))}
      </ol>
      <p className="ac-widget-note">Daily target: {hours(week.daily)} on working days.</p>
    </div>
  )
}

export function FollowUpsWidget({
  open,
  today,
  clients,
  canDone,
  onDone,
  onOpenTask,
}: {
  open: WorkItem[]
  today: string
  clients: Client[]
  canDone: (item: WorkItem) => boolean
  onDone: (item: WorkItem) => void
  onOpenTask: (item: WorkItem) => void
}) {
  const due = followUpsDue(open, today)
  const overdue = due.filter(item => item.followUpDate < today).length
  const clientName = (id?: string) => clients.find(client => client.id === id)?.name || ''
  return (
    <div className="panel dashboard-panel ac-widget-list">
      <div className="panel-heading dashboard-panel-heading">
        <div>
          <h2>
            <CalendarCheck size={17} /> Follow-ups due
          </h2>
          <p>{due.length ? `${overdue} overdue · ${due.length - overdue} today` : 'Nothing to follow up today'}</p>
        </div>
      </div>
      {!due.length ? (
        <p className="ac-widget-note">You’re all caught up.</p>
      ) : (
        <ul>
          {due.slice(0, 8).map(item => (
            <li key={item.id} className="ac-check-row">
              {canDone(item) && (
                <input
                  type="checkbox"
                  aria-label={`Mark the follow-up on ${item.title} done`}
                  title="Done: clears the follow-up date"
                  onChange={() => onDone(item)}
                />
              )}
              <button
                type="button"
                className={item.followUpDate < today ? 'unread' : ''}
                onClick={() => onOpenTask(item)}
              >
                <span className="ac-row-main">
                  <strong>{item.title}</strong>
                  <span>
                    {[clientName(item.clientId), item.waitingOn && `Waiting on ${item.waitingOn}`]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </span>
                <span className="ac-row-side">
                  <time className={item.followUpDate < today ? 'overdue-date' : ''}>
                    {lateness(item.followUpDate, today)}
                  </time>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

type Change = {
  id: string
  trackerId: string
  trackerName: string
  rowId: string
  row: string
  by: string
  kind: string
  text: string
  at: string
}
const when = (value: string) => {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toDateString() === new Date().toDateString()
    ? date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : date.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

export function TrackerChangesWidget({ setView }: { setView: View }) {
  const [changes, setChanges] = useState<Change[] | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const load = useCallback(() => {
    setBusy(true)
    setError('')
    requestJson<{ changes: Change[] }>('/api/tracker-changes/recent', {
      noStore: true,
      fallback: 'Recent tracker changes could not be loaded.',
    })
      .then(result => setChanges(result.changes || []))
      .catch(failure => setError(failure instanceof Error ? failure.message : 'Could not load.'))
      .finally(() => setBusy(false))
  }, [])
  useEffect(load, [load])
  return (
    <div className="panel dashboard-panel ac-widget-list">
      <div className="panel-heading dashboard-panel-heading">
        <div>
          <h2>
            <History size={17} /> Recent tracker changes
          </h2>
          <p>On the trackers you can open</p>
        </div>
        <div className="dashboard-panel-actions">
          <button
            type="button"
            className="secondary icon-only"
            aria-label="Refresh changes"
            onClick={load}
            disabled={busy}
          >
            <RefreshCw size={15} />
          </button>
          <button type="button" className="secondary" onClick={() => setView('trackers')}>
            Open Trackers
          </button>
        </div>
      </div>
      {error ? (
        <p className="ac-widget-note">{error}</p>
      ) : !changes ? (
        <p className="ac-widget-note">Loading…</p>
      ) : !changes.length ? (
        <p className="ac-widget-note">No changes yet.</p>
      ) : (
        <ul>
          {changes.slice(0, 8).map(change => (
            <li key={change.id}>
              <button
                type="button"
                onClick={() => {
                  if (change.rowId) rememberTrackerRow(change.trackerId, change.rowId)
                  setView('trackers')
                }}
              >
                <span className="ac-row-main">
                  <strong>
                    {change.row ? `${change.row}: ` : ''}
                    {change.text}
                  </strong>
                  <span>
                    {change.trackerName}
                    {change.by ? ` · ${change.by}` : ''}
                  </span>
                </span>
                <span className="ac-row-side">
                  <time>{when(change.at)}</time>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export function LinksWidget({
  links,
  note,
  onSave,
}: {
  links: QuickLink[]
  note: string
  onSave: (settings: { links: QuickLink[]; note: string } | undefined) => void
}) {
  const [editing, setEditing] = useState(false)
  const [rows, setRows] = useState<QuickLink[]>(links)
  const [text, setText] = useState(note)
  const [problem, setProblem] = useState('')
  const start = () => {
    setRows(links.length ? links : [{ label: '', url: '' }])
    setText(note)
    setProblem('')
    setEditing(true)
  }
  const save = () => {
    const kept = rows.filter(row => row.url.trim())
    const cleaned = kept.map(cleanLink)
    if (cleaned.some(item => !item)) {
      setProblem('Each link needs a web address starting with http or https.')
      return
    }
    const clean = cleaned as QuickLink[]
    onSave(clean.length || text.trim() ? { links: clean, note: text.trim() } : undefined)
    setEditing(false)
  }
  return (
    <div className="panel dashboard-panel ac-links">
      <div className="panel-heading dashboard-panel-heading">
        <div>
          <h2>
            <Link2 size={17} /> Quick links and note
          </h2>
          <p>Only you see these</p>
        </div>
        {!editing && (
          <div className="dashboard-panel-actions">
            <button type="button" className="secondary" onClick={start}>
              <Pencil size={14} /> Edit
            </button>
          </div>
        )}
      </div>
      {editing ? (
        <div className="ac-links-editor">
          {rows.map((row, index) => (
            <div key={index} className="ac-link-row">
              <input
                aria-label="Label"
                placeholder="Label"
                maxLength={LINK_LIMITS.label}
                value={row.label}
                onChange={event =>
                  setRows(current =>
                    current.map((item, at) => (at === index ? { ...item, label: event.target.value } : item)),
                  )
                }
              />
              <input
                aria-label="Web address"
                placeholder="https://"
                maxLength={LINK_LIMITS.url}
                value={row.url}
                onChange={event =>
                  setRows(current =>
                    current.map((item, at) => (at === index ? { ...item, url: event.target.value } : item)),
                  )
                }
              />
              <button
                type="button"
                className="secondary icon-only"
                aria-label="Remove link"
                onClick={() => setRows(current => current.filter((_item, at) => at !== index))}
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
          {rows.length < LINK_LIMITS.links && (
            <button
              type="button"
              className="link-button"
              onClick={() => setRows(current => [...current, { label: '', url: '' }])}
            >
              <Plus size={13} /> Add a link
            </button>
          )}
          <label className="ac-field">
            <span>Note</span>
            <textarea
              rows={4}
              maxLength={LINK_LIMITS.note}
              value={text}
              onChange={event => setText(event.target.value)}
            />
          </label>
          {problem && <p className="ac-widget-note">{problem}</p>}
          <div className="ac-inline-actions">
            <button type="button" className="secondary" onClick={() => setEditing(false)}>
              Cancel
            </button>
            <button type="button" className="primary" onClick={save}>
              Save
            </button>
          </div>
        </div>
      ) : (
        <>
          {links.length > 0 ? (
            <ul className="ac-link-list">
              {links.map(link => (
                <li key={`${link.label}:${link.url}`}>
                  <a href={link.url} target="_blank" rel="noreferrer noopener">
                    <ExternalLink size={13} /> {link.label}
                  </a>
                </li>
              ))}
            </ul>
          ) : (
            !note && <p className="ac-widget-note">Add links you open often, and a note to yourself.</p>
          )}
          {note && <p className="ac-note">{note}</p>}
        </>
      )}
    </div>
  )
}
