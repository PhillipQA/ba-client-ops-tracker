/**
 * The roll-up page (/trackers/rollup): rows across several trackers, usually every Site rollout, in one list with
 * summary tiles, filters and a progress bar per group. Rows are read live; an edit is saved to the row's own tracker
 * through the ordinary row route, so history, linked tasks, the connected Sheet and automations follow.
 */
import { ArrowLeft, Download, ExternalLink, Layers, RefreshCw, Search } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Client, UserAccount, WorkItem } from '../../shared/types'
import { type RollupData, TrackerApiError, loadRollup, trackerApi } from './trackerApi'
import { rememberRollup, rememberedRollup, rememberTrackerRow } from './trackerNav'
import { makeLookup } from './trackerQuery'
import {
  DUE_SOON_DAYS,
  type RollupField,
  type RollupFilter,
  type RollupGroupBy,
  type RollupItem,
  type RollupSet,
  type RollupState,
  STATE_LABEL,
  filterRollup,
  groupRollup,
  rollupCell,
  rollupCsv,
  rollupEditable,
  rollupItems,
  rollupTiles,
  sortRollup,
} from './trackerRollup'
import type { TrackerRow } from './trackerModel'
import { exportFileName } from './trackerExport'
import { Dialog, Notice, Pill, TrackerLoading, niceDate, plural } from './trackerUi'

type Props = {
  items: WorkItem[]
  clients: Client[]
  accounts: UserAccount[]
  today: string
  onBack: () => void
  /** Opens a row in its own tracker. */
  onOpenTracker: (trackerId: string) => void
  onTasksChanged?: () => Promise<void>
}

const STATE_TONE: Record<RollupState, 'green' | 'red' | 'amber' | 'blue' | 'gray'> = {
  live: 'green',
  overdue: 'red',
  blocked: 'amber',
  due: 'blue',
  open: 'gray',
}

export default function TrackerRollup(props: Props) {
  const [chosen, setChosen] = useState<string[]>(rememberedRollup)
  const [data, setData] = useState<RollupData | null>(null)
  const [error, setError] = useState('')
  const [note, setNote] = useState<{ kind: 'info' | 'error'; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [picking, setPicking] = useState(false)
  const [filter, setFilter] = useState<RollupFilter>({ state: 'all' })
  const [groupBy, setGroupBy] = useState<RollupGroupBy>('tracker')
  const [saving, setSaving] = useState('')
  const alive = useRef(true)
  useEffect(
    () => () => {
      alive.current = false
    },
    [],
  )

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setBusy(true)
      try {
        const result = await loadRollup(chosen, signal)
        if (!alive.current) return
        setData(result)
        setError('')
      } catch (failure) {
        if ((failure as Error)?.name === 'AbortError' || !alive.current) return
        setError(failure instanceof Error ? failure.message : 'The roll-up could not be loaded.')
      } finally {
        if (alive.current) setBusy(false)
      }
    },
    [chosen],
  )
  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
    return () => controller.abort()
  }, [load])

  const lookup = useMemo(
    () => makeLookup(props.items, props.accounts, props.today),
    [props.items, props.accounts, props.today],
  )
  const all = useMemo(() => (data ? rollupItems(data.sets, lookup) : []), [data, lookup])
  const shown = useMemo(() => sortRollup(filterRollup(all, filter)), [all, filter])
  const tiles = useMemo(() => rollupTiles(filterRollup(all, { ...filter, state: 'all' })), [all, filter])
  const clientName = useCallback(
    (id: string) => props.clients.find(client => client.id === id)?.name || '',
    [props.clients],
  )
  const groups = useMemo(() => groupRollup(shown, groupBy, clientName), [shown, groupBy, clientName])
  const setsById = useMemo(() => new Map((data?.sets || []).map(set => [set.tracker.id, set])), [data])
  const statuses = useMemo(() => [...new Set(all.map(item => item.status).filter(Boolean))].sort(), [all])
  const owners = useMemo(() => [...new Set(all.map(item => item.owner).filter(Boolean))].sort(), [all])
  const clientIds = useMemo(() => [...new Set(all.flatMap(item => item.clientIds))], [all])
  const people = useMemo(
    () =>
      props.accounts
        .filter(account => account.status === 'Active')
        .map(account => ({ id: account.id, name: account.name || account.username })),
    [props.accounts],
  )
  const patch = (next: Partial<RollupFilter>) => setFilter(current => ({ ...current, ...next }))

  const replaceRow = (trackerId: string, row: TrackerRow) =>
    setData(current =>
      current
        ? {
            ...current,
            sets: current.sets.map(set =>
              set.tracker.id === trackerId
                ? {
                    ...set,
                    rows: set.rows.map(entry => (entry.id === row.id ? { ...entry, ...row, secretSet: {} } : entry)),
                  }
                : set,
            ),
          }
        : current,
    )

  async function save(item: RollupItem, field: RollupField, value: string) {
    const set = setsById.get(item.trackerId)
    const column = set ? rollupEditable(set.tracker.columns, field) : null
    if (!set || !column) return
    const key = `${item.rowId}:${field}`
    setSaving(key)
    try {
      const result = await trackerApi.updateRow(item.trackerId, item.rowId, {
        version: item.version,
        cells: { [column.id]: rollupCell(column, value) },
      })
      if (!alive.current) return
      replaceRow(item.trackerId, result.row)
      const automation = result.automation
      if (automation) {
        const done = automation.done.join(', ')
        setNote({
          kind: 'info',
          text: done ? `Saved to ${item.trackerName}. Automation: ${done}.` : `Saved to ${item.trackerName}.`,
        })
        if (automation.taskMade) void props.onTasksChanged?.()
      } else setNote({ kind: 'info', text: `Saved to ${item.trackerName}.` })
    } catch (failure) {
      if (!alive.current) return
      const conflict = failure instanceof TrackerApiError && failure.status === 409
      setNote({
        kind: 'error',
        text: conflict
          ? 'Someone changed this row in the meantime. The roll-up was reloaded; try again.'
          : failure instanceof Error
            ? failure.message
            : 'The change could not be saved.',
      })
      void load()
    } finally {
      if (alive.current) setSaving('')
    }
  }

  const openRow = (item: RollupItem) => {
    rememberTrackerRow(item.trackerId, item.rowId)
    props.onOpenTracker(item.trackerId)
  }

  const download = () => {
    const body = rollupCsv(shown, clientName)
    const url = URL.createObjectURL(new Blob([body], { type: 'text/csv;charset=utf-8' }))
    const link = document.createElement('a')
    link.href = url
    link.download = exportFileName('Roll-up', props.today)
    document.body.appendChild(link)
    link.click()
    link.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
    setNote({ kind: 'info', text: `Exported ${plural(shown.length, 'row')} as you see them.` })
  }

  const chooseTrackers = (ids: string[]) => {
    rememberRollup(ids)
    setChosen(ids)
    setPicking(false)
  }

  const showTracker = groupBy !== 'tracker'
  return (
    <div className="trk-page trk-rollup">
      <nav className="trk-crumbs" aria-label="Breadcrumb">
        <button type="button" className="trk-text-button" onClick={props.onBack}>
          <ArrowLeft size={14} aria-hidden="true" /> Trackers
        </button>
        <span aria-hidden="true">/</span>
        <span>Roll-up</span>
      </nav>
      <header className="trk-header">
        <div className="trk-title">
          <div>
            <h2>Roll-up</h2>
            <p className="trk-muted-text">
              {data
                ? `${plural(data.sets.length, 'tracker')} · ${chosen.length ? 'your choice' : 'every Site rollout tracker'}. Rows are read live, and changes save to each row's own tracker.`
                : 'Rows across your rollout trackers, read live.'}
            </p>
          </div>
        </div>
        <div className="trk-header-actions">
          <button type="button" className="trk-button" onClick={() => setPicking(true)} disabled={!data}>
            <Layers size={14} aria-hidden="true" /> Choose trackers
          </button>
          <button type="button" className="trk-button" onClick={download} disabled={!shown.length}>
            <Download size={14} aria-hidden="true" /> Export CSV
          </button>
          <button
            type="button"
            className="trk-icon-button"
            aria-label="Refresh the roll-up"
            onClick={() => void load()}
            disabled={busy}
          >
            <RefreshCw size={15} aria-hidden="true" />
          </button>
        </div>
      </header>

      {error && <Notice kind="error">{error}</Notice>}
      {data?.warning && <Notice kind="info">{data.warning}</Notice>}
      {note && (
        <Notice kind={note.kind} onClose={() => setNote(null)}>
          {note.text}
        </Notice>
      )}

      {!data && !error ? (
        <TrackerLoading label="Loading the roll-up…" rows={6} />
      ) : data && !data.sets.length ? (
        <div className="trk-empty">
          <p>
            {data.trackers.length
              ? 'No trackers are chosen. Choose the trackers to roll up.'
              : 'No trackers can be rolled up yet. A tracker needs a Status or a Go-live column; Site rollout trackers have both.'}
          </p>
          {data.trackers.length > 0 && (
            <button type="button" className="trk-button primary" onClick={() => setPicking(true)}>
              Choose trackers
            </button>
          )}
        </div>
      ) : data ? (
        <>
          <div className="trk-rollup-tiles" role="group" aria-label="Summary">
            {(
              [
                ['all', 'Total', tiles.total],
                ['live', 'Live', tiles.live],
                ['due', `Due in ${DUE_SOON_DAYS} days`, tiles.due],
                ['overdue', 'Overdue', tiles.overdue],
                ['blocked', 'Blocked', tiles.blocked],
              ] as [RollupState | 'all', string, number][]
            ).map(([state, label, count]) => (
              <button
                key={state}
                type="button"
                className={`trk-rollup-tile${filter.state === state ? ' active' : ''}${state === 'all' ? '' : ` trk-tone-${STATE_TONE[state]}`}`}
                aria-pressed={filter.state === state}
                onClick={() => patch({ state: filter.state === state ? 'all' : state })}
              >
                <strong>{count.toLocaleString('en')}</strong>
                <span>{label}</span>
              </button>
            ))}
          </div>

          <div className="trk-toolbar trk-rollup-filters">
            <label className="trk-search">
              <Search size={14} aria-hidden="true" />
              <input
                type="search"
                placeholder="Search sites"
                aria-label="Search sites"
                value={filter.query || ''}
                onChange={event => patch({ query: event.target.value })}
              />
            </label>
            <select
              aria-label="Client"
              value={filter.clientId || ''}
              onChange={event => patch({ clientId: event.target.value })}
            >
              <option value="">All clients</option>
              {clientIds.map(id => (
                <option key={id} value={id}>
                  {clientName(id) || 'Unknown client'}
                </option>
              ))}
            </select>
            <select
              aria-label="Status"
              value={filter.status || ''}
              onChange={event => patch({ status: event.target.value })}
            >
              <option value="">All statuses</option>
              {statuses.map(status => (
                <option key={status} value={status}>
                  {status}
                </option>
              ))}
            </select>
            <select
              aria-label="Owner"
              value={filter.owner || ''}
              onChange={event => patch({ owner: event.target.value })}
            >
              <option value="">All owners</option>
              {owners.map(owner => (
                <option key={owner} value={owner}>
                  {owner}
                </option>
              ))}
            </select>
            <label className="trk-tool">
              <span className="trk-muted-text">Go-live</span>
              <input
                type="date"
                aria-label="Go-live from"
                value={filter.from || ''}
                onChange={event => patch({ from: event.target.value })}
              />
              <span aria-hidden="true">–</span>
              <input
                type="date"
                aria-label="Go-live to"
                value={filter.to || ''}
                onChange={event => patch({ to: event.target.value })}
              />
            </label>
            <select
              aria-label="Group by"
              value={groupBy}
              onChange={event => setGroupBy(event.target.value as RollupGroupBy)}
            >
              <option value="tracker">Group by tracker</option>
              <option value="client">Group by client</option>
              <option value="none">No groups</option>
            </select>
          </div>

          {!shown.length ? (
            <div className="trk-empty">
              <p>No rows match these filters.</p>
              <button type="button" className="trk-button" onClick={() => setFilter({ state: 'all' })}>
                Clear filters
              </button>
            </div>
          ) : (
            groups.map(group => (
              <section key={group.key} className="trk-rollup-group">
                {groupBy !== 'none' && (
                  <header>
                    <h3>{group.label}</h3>
                    <span className="trk-progress" title={`${group.live} of ${group.items.length} live`}>
                      <i>
                        <b style={{ width: `${group.percent}%` }} />
                      </i>
                      <span className="trk-muted-text">
                        {group.live} of {group.items.length} live · {group.percent}%
                      </span>
                    </span>
                  </header>
                )}
                <div className="trk-rollup-table-wrap">
                  <table className="trk-rollup-table">
                    <thead>
                      <tr>
                        <th scope="col">Site</th>
                        {showTracker && <th scope="col">Tracker</th>}
                        <th scope="col">Status</th>
                        <th scope="col">Go-live</th>
                        <th scope="col">Owner</th>
                        <th scope="col" aria-label="Open" />
                      </tr>
                    </thead>
                    <tbody>
                      {group.items.map(item => (
                        <RollupLine
                          key={`${group.key}:${item.rowId}`}
                          item={item}
                          set={setsById.get(item.trackerId)}
                          showTracker={showTracker}
                          saving={saving}
                          people={people}
                          onSave={save}
                          onOpen={openRow}
                        />
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            ))
          )}
        </>
      ) : null}

      {picking && data && (
        <ChooseTrackers
          trackers={data.trackers}
          chosen={data.chosen}
          clientName={clientName}
          onCancel={() => setPicking(false)}
          onSave={chooseTrackers}
        />
      )}
    </div>
  )
}

function RollupLine({
  item,
  set,
  showTracker,
  saving,
  people,
  onSave,
  onOpen,
}: {
  item: RollupItem
  set?: RollupSet
  showTracker: boolean
  saving: string
  people: { id: string; name: string }[]
  onSave: (item: RollupItem, field: RollupField, value: string) => void
  onOpen: (item: RollupItem) => void
}) {
  const canEdit = Boolean(set?.tracker.canEdit)
  const editable = (field: RollupField) => (canEdit && set ? rollupEditable(set.tracker.columns, field) : null)
  const status = editable('status'),
    goLive = editable('goLive'),
    owner = editable('owner')
  const busy = (field: RollupField) => saving === `${item.rowId}:${field}`
  const row = set?.rows.find(entry => entry.id === item.rowId)
  const stored = (columnId: string) => {
    const value = row?.cells[columnId]
    return typeof value === 'string' ? value : ''
  }
  return (
    <tr className={`trk-rollup-${item.state}`}>
      <td>
        <button type="button" className="trk-text-button strong" onClick={() => onOpen(item)}>
          {item.site || 'Untitled row'}
        </button>
      </td>
      {showTracker && <td className="trk-muted-text">{item.trackerName}</td>}
      <td>
        {status?.type === 'select' ? (
          <select
            aria-label={`Status of ${item.site || 'row'}`}
            value={stored(status.id)}
            disabled={busy('status')}
            onChange={event => onSave(item, 'status', event.target.value)}
          >
            <option value="">—</option>
            {(status.options || []).map(option => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        ) : item.status ? (
          <Pill tone={item.statusTone || 'gray'}>{item.status}</Pill>
        ) : (
          <span className="trk-muted-text">—</span>
        )}
      </td>
      <td>
        <span className="trk-rollup-date">
          {goLive ? (
            <input
              type="date"
              aria-label={`Go-live of ${item.site || 'row'}`}
              defaultValue={item.goLive}
              key={`${item.rowId}:${item.version}`}
              disabled={busy('goLive')}
              onBlur={event => {
                if (event.target.value !== item.goLive) onSave(item, 'goLive', event.target.value)
              }}
            />
          ) : (
            <span>{item.goLive ? niceDate(item.goLive) : '—'}</span>
          )}
          {item.state !== 'open' && <Pill tone={STATE_TONE[item.state]}>{STATE_LABEL[item.state]}</Pill>}
        </span>
      </td>
      <td>
        {owner?.type === 'person' ? (
          <select
            aria-label={`Owner of ${item.site || 'row'}`}
            value={stored(owner.id)}
            disabled={busy('owner')}
            onChange={event => onSave(item, 'owner', event.target.value)}
          >
            <option value="">Nobody</option>
            {people.map(person => (
              <option key={person.id} value={person.id}>
                {person.name}
              </option>
            ))}
          </select>
        ) : (
          <span>{item.owner || <span className="trk-muted-text">—</span>}</span>
        )}
      </td>
      <td>
        <button
          type="button"
          className="trk-icon-button small"
          aria-label={`Open ${item.site || 'row'} in ${item.trackerName}`}
          title={`Open in ${item.trackerName}`}
          onClick={() => onOpen(item)}
        >
          <ExternalLink size={14} aria-hidden="true" />
        </button>
      </td>
    </tr>
  )
}

function ChooseTrackers({
  trackers,
  chosen,
  clientName,
  onCancel,
  onSave,
}: {
  trackers: RollupData['trackers']
  chosen: string[]
  clientName: (id: string) => string
  onCancel: () => void
  onSave: (ids: string[]) => void
}) {
  const [picked, setPicked] = useState<Set<string>>(() => new Set(chosen))
  const toggle = (id: string) =>
    setPicked(current => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  return (
    <Dialog title="Choose trackers" eyebrow="Roll-up" onClose={onCancel}>
      <p className="trk-muted-text">
        Trackers with a Status or a Go-live column can be rolled up. Your choice is kept in this browser.
      </p>
      <ul className="trk-rollup-choices">
        {trackers.map(tracker => (
          <li key={tracker.id}>
            <label>
              <input type="checkbox" checked={picked.has(tracker.id)} onChange={() => toggle(tracker.id)} />
              <span>
                <strong>{tracker.name}</strong>
                <span className="trk-muted-text">
                  {[tracker.template === 'site-rollout' ? 'Site rollout' : '', ...tracker.clientIds.map(clientName)]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </span>
            </label>
          </li>
        ))}
      </ul>
      <div className="k-dialog-actions">
        <button type="button" className="trk-text-button" onClick={() => onSave([])}>
          Use every Site rollout tracker
        </button>
        <span className="trk-spacer" />
        <button type="button" className="trk-button" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="trk-button primary"
          disabled={!picked.size}
          onClick={() => onSave(trackers.filter(tracker => picked.has(tracker.id)).map(tracker => tracker.id))}
        >
          Show {plural(picked.size, 'tracker')}
        </button>
      </div>
    </Dialog>
  )
}
