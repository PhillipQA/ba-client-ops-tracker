import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, ArrowDown, ArrowLeft, ArrowUp, ChevronDown, Download, Lock, Maximize2, Minimize2, Plus, RotateCcw, Search, Upload, X } from 'lucide-react'
import {
  columnTotal, TRACKER_LIMITS, emptyCell, filterOpsFor, isEmptyCell, randomId,
  COLUMN_TYPES, type Cell, type ColumnAlign, type ColumnType, type Tracker, type TrackerColumn, type TrackerRow, type TrackerView, isFrozenColumn,
} from './trackerModel'
import { groupRows, makeLookup, rowTitle, visibleRows } from './trackerQuery'
import { exportCsv, exportFileName } from './trackerExport'
import { TrackerApiError, loadAllRows, trackerApi, type ConvertReport, type TaskLink } from './trackerApi'
import TrackerGrid, { NUMBER_COLUMN_WIDTH, widthOf, type Entry, type GridFocus } from './TrackerGrid'
import TrackerToolbar, { emptyWork, type Work } from './TrackerToolbar'
import TrackerRowPanel from './TrackerRowPanel'
import { TrackerBulkTasks, TrackerWorkPicker, trackerClients, type TaskDraft, type WorkTools } from './TrackerWork'
import TrackerColumnDialog, { type ColumnDraft } from './TrackerColumnDialog'
import TrackerImportDialog from './TrackerImportDialog'
import TrackerDetailsDialog from './TrackerDetailsDialog'
import { Notice, Popover, plural } from './trackerUi'
import { takeReview, takeTrackerRow } from './trackerNav'
import TrackerReview, { type ReviewOutcome } from './TrackerReview'
import { SYNC_LIMITS, describeSync } from './trackerSync'
import { niceTime } from './trackerUi'
import { useVisiblePolling } from './useVisiblePolling'
import type { Client, Project, UserAccount, WorkItem } from './types'

type Props = {
  trackerId: string
  isAdmin: boolean
  items: WorkItem[]
  clients: Client[]
  projects: Project[]
  accounts: UserAccount[]
  today: string
  onBack: () => void
  onOpenTask?: (taskId: string) => void
  /** True when a task status counts as closed or resolved. */
  isTaskClosed: (status: string) => boolean
  /** Present when this person may create tasks; resolves after the workspace is saved. */
  onCreateTasks?: (drafts: TaskDraft[]) => Promise<WorkItem[]>
  /** The list of trackers on the home screen needs a refresh. */
  onListChanged: () => void
}

type PanelId = 'filter' | 'sort' | 'group' | 'fields' | null
const stripWork = (work: Work) => ({ filters: work.filters, sort: work.sort, groupBy: work.groupBy, hidden: work.hidden })
const sameValue = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

export default function TrackerScreen(props: Props) {
  const { trackerId } = props
  const [tracker, setTrackerState] = useState<Tracker | null>(null)
  const trackerRef = useRef<Tracker | null>(null)
  const setTracker = (next: Tracker | null) => { trackerRef.current = next; setTrackerState(next) }
  const [rows, setRowsState] = useState<TrackerRow[]>([])
  const rowsRef = useRef<TrackerRow[]>([])
  const setRows = (next: TrackerRow[]) => { rowsRef.current = next; setRowsState(next) }
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [loadError, setLoadError] = useState('')
  const [notice, setNotice] = useState<{ kind: 'error' | 'info'; text: string } | null>(null)
  const [saving, setSaving] = useState(0)
  const [work, setWork] = useState<Work>(emptyWork)
  const [activeViewId, setActiveViewId] = useState('')
  const [panel, setPanel] = useState<PanelId>(null)
  const [drawerId, setDrawerId] = useState('')
  const [links, setLinks] = useState<TaskLink[]>([])
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [focus, setFocus] = useState<GridFocus | null>(null)
  const [columnDialog, setColumnDialog] = useState<{ mode: 'add' } | { mode: 'edit'; id: string } | null>(null)
  const [importing, setImporting] = useState(false)
  const [details, setDetails] = useState(false)
  const [headerMenu, setHeaderMenu] = useState<TrackerColumn | null>(null)
  const [moreOpen, setMoreOpen] = useState(false)
  const [saveViewOpen, setSaveViewOpen] = useState(false)
  const [viewName, setViewName] = useState('')
  const headerAnchor = useRef<HTMLElement | null>(null)
  const moreButton = useRef<HTMLButtonElement>(null)
  const workAnchor = useRef<HTMLElement | null>(null)
  const [workCell, setWorkCell] = useState<{ rowId: string; columnId: string } | null>(null)
  const [bulkOpen, setBulkOpen] = useState(false)
  const [review, setReview] = useState<{ origin: 'sheet' | 'import'; ids: string[] | 'flagged' } | null>(null)
  const [syncing, setSyncing] = useState(false)
  // Full-width view: the page header (Add client, Add task…) is hidden so the grid gets the whole height. The left menu stays.
  const [expanded, setExpanded] = useState(() => { try { return localStorage.getItem('ba.tracker.expanded') === '1' } catch { return false } })
  const toggleExpanded = () => setExpanded(current => { const next = !current; try { localStorage.setItem('ba.tracker.expanded', next ? '1' : '0') } catch { /* not remembered */ } return next })
  useEffect(() => {
    const shell = document.querySelector('.app-shell')
    if (!shell || !expanded) return
    shell.classList.add('trk-expanded')
    return () => shell.classList.remove('trk-expanded')
  }, [expanded])
  const saveViewButton = useRef<HTMLButtonElement>(null)
  const queues = useRef(new Map<string, { tail: Promise<void>; pending: number }>())
  const focusNonce = useRef(0)
  const needsRefresh = useRef(false)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])

  const say = useCallback((kind: 'error' | 'info', text: string) => setNotice({ kind, text }), [])
  useEffect(() => {
    if (!notice || notice.kind === 'error') return
    const timer = window.setTimeout(() => setNotice(null), 7000)
    return () => window.clearTimeout(timer)
  }, [notice])

  // ---- loading ----
  const load = useCallback(async (signal?: AbortSignal) => {
    const [meta, all] = await Promise.all([trackerApi.get(trackerId, signal), loadAllRows(trackerId, signal)])
    return { tracker: meta.tracker, rows: all }
  }, [trackerId])

  useEffect(() => {
    const controller = new AbortController()
    setStatus('loading'); setTracker(null); setRows([]); setDrawerId(''); setSelected(new Set()); setWork(emptyWork); setActiveViewId('')
    setLinks([])
    // Links have their own table. If it is missing the tracker still opens, just without them.
    trackerApi.links(trackerId, controller.signal).then(result => setLinks(result.links)).catch(() => undefined)
    load(controller.signal).then(result => { setTracker(result.tracker); setRows(result.rows); setStatus('ready') })
      .catch(error => { if (error?.name === 'AbortError') return; setLoadError(error instanceof Error ? error.message : 'The tracker could not be loaded.'); setStatus('error') })
    return () => controller.abort()
  }, [trackerId, load])

  // Arriving from a task's tracker link opens that row's details.
  useEffect(() => {
    if (status !== 'ready') return
    const wanted = takeTrackerRow(trackerId)
    if (wanted && rowsRef.current.some(row => row.id === wanted)) setDrawerId(wanted)
    // Arriving straight from an import or a new Sheet connection opens the review of the new rows.
    const pending = takeReview(trackerId)
    if (pending) setReview({ origin: pending === 'flagged' ? 'sheet' : 'import', ids: pending })
  }, [status, trackerId])

  // Connected Google Sheet: Sync now, and an automatic sync every few minutes while the tracker is open.
  const syncNow = async (force: boolean) => {
    const current = trackerRef.current
    if (!current?.source || syncing) return
    setSyncing(true)
    try {
      const result = await trackerApi.syncSource(trackerId, force)
      if (!alive.current) return
      if (!result.skipped) await refresh()
      else if (trackerRef.current) setTracker({ ...trackerRef.current, source: result.source })
      if (force) say('info', result.report ? `Synced. ${describeSync(result.report)}.` : 'Synced.')
    } catch (error) {
      if (force) say('error', error instanceof Error ? error.message : 'The Sheet could not be synced.')
      await refresh().catch(() => undefined)
    } finally { if (alive.current) setSyncing(false) }
  }
  const allowSheets = async () => {
    try {
      const response = await fetch('/api/communications/gmail/connect?sheets=1', { credentials: 'same-origin' })
      const result = await response.json().catch(() => ({}))
      if (!response.ok || !result.url) throw new Error(result.error || 'Could not start the Google permission step.')
      window.location.assign(result.url)
    } catch (error) { say('error', error instanceof Error ? error.message : 'Could not start the Google permission step.') }
  }
  const reconnect = async () => {
    setSyncing(true)
    try { const result = await trackerApi.reconnectSource(trackerId); await refresh(); say('info', `Reconnected with your Google account. ${result.report ? describeSync(result.report) : ''}`) }
    catch (error) { if (error instanceof TrackerApiError && error.body.needsGoogle) { if (window.confirm('Allow the tracker to read your Google Sheets first? You will come back here after Google asks.')) void allowSheets() } else say('error', error instanceof Error ? error.message : 'Could not reconnect.') }
    finally { if (alive.current) setSyncing(false) }
  }
  const stopSyncing = async () => {
    if (!window.confirm('Stop syncing with the Google Sheet? Every row stays in the tracker and its columns become editable here. You can connect a Sheet again later by making a new tracker from it.')) return
    try { const result = await trackerApi.disconnectSource(trackerId); setTracker(result.tracker); await refresh(); say('info', 'This tracker no longer follows the Sheet.') }
    catch (error) { say('error', error instanceof Error ? error.message : 'Could not stop syncing.') }
  }
  const applyReview = async (outcome: ReviewOutcome) => {
    if (outcome.rowTasks.length) await linkRowTasks(outcome.rowTasks)
    if (outcome.cellLinks.length) { const result = await trackerApi.bulkLinks(trackerId, outcome.cellLinks); setLinks(result.links) }
    if (outcome.reviewed.length) await trackerApi.reviewed(trackerId, outcome.reviewed).catch(() => undefined)
    await refresh()
  }

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const result = await load(signal)
    // Never replace rows underneath an edit that is still being saved.
    if (!alive.current || queues.current.size) return
    setTracker(result.tracker); setRows(result.rows)
    trackerApi.links(trackerId, signal).then(found => { if (alive.current) setLinks(found.links) }).catch(() => undefined)
  }, [load, trackerId])
  // While a connected tracker is open and visible, it syncs when the last sync is older than a few minutes.
  useEffect(() => {
    if (status !== 'ready' || !tracker?.source || !canEditSource) return
    const due = () => {
      const last = Date.parse(trackerRef.current?.source?.lastSyncedAt || '') || 0
      if (document.visibilityState === 'visible' && Date.now() - last > SYNC_LIMITS.autoMinutes * 60_000) void syncNow(false)
    }
    due()
    const timer = window.setInterval(due, 60_000)
    return () => window.clearInterval(timer)
  }, [status, tracker?.source?.spreadsheetId, trackerId])
  useVisiblePolling(refresh, { enabled: status === 'ready' && saving === 0 && !columnDialog && !importing && !details, interval: 60_000, scope: trackerId, immediate: false })

  // Keep the working view pointing at columns that exist.
  const columns = tracker?.columns ?? []
  useEffect(() => {
    if (!tracker) return
    const known = new Set(tracker.columns.map(column => column.id))
    setWork(current => {
      const next: Work = {
        ...current, filters: current.filters.filter(filter => known.has(filter.columnId)), hidden: current.hidden.filter(id => known.has(id)),
        sort: current.sort && known.has(current.sort.columnId) ? current.sort : null, groupBy: known.has(current.groupBy) ? current.groupBy : '',
      }
      return sameValue(next, current) ? current : next
    })
    if (activeViewId && !tracker.views.some(view => view.id === activeViewId)) setActiveViewId('')
  }, [tracker, activeViewId])
  useEffect(() => { setSelected(current => { const ids = new Set(rows.map(row => row.id)); const next = [...current].filter(id => ids.has(id)); return next.length === current.size ? current : new Set(next) }) }, [rows])

  // ---- derived ----
  const lookup = useMemo(() => ({ ...makeLookup(props.items, props.accounts, props.today), columns: tracker?.columns ?? [] }), [props.items, props.accounts, props.today, tracker?.columns])
  const people = useMemo(() => props.accounts.filter(account => account.status === 'Active').map(account => ({ id: account.id, name: account.name || account.username })), [props.accounts])
  const search = useDeferredValue(work.search)
  // Rows can be moved only while the grid shows them in their saved order.
  const moveRows = async (ids: string[], before: string | 'start' | null) => {
    if (!canEdit || !ids.length) return
    const moving = new Set(ids), current = rowsRef.current
    const rest = current.filter(row => !moving.has(row.id))
    const at = before === 'start' ? 0 : before === null ? rest.length : rest.findIndex(row => row.id === before)
    if (at < 0) return
    const next = [...rest.slice(0, at), ...current.filter(row => moving.has(row.id)), ...rest.slice(at)]
    if (next.every((row, index) => row.id === current[index].id)) return
    setRows(next)
    try { await trackerApi.moveRows(trackerId, ids, before) }
    catch (error) { say('error', error instanceof Error ? error.message : 'The rows could not be moved.'); void refresh().catch(() => undefined) }
  }
  /** Where the selected rows go for a one-step move: the row they should end up just before. */
  const stepTarget = (direction: -1 | 1): string | null => {
    const current = rowsRef.current
    const rest = current.filter(row => !selected.has(row.id))
    const first = current.findIndex(row => selected.has(row.id))
    const unselectedAbove = current.slice(0, first).filter(row => !selected.has(row.id)).length
    const at = Math.max(0, Math.min(rest.length, unselectedAbove + direction))
    return rest[at]?.id ?? null
  }
  const convertColumn = async (column: TrackerColumn, type: ColumnType, confirm: boolean, clearUnfit: boolean): Promise<ConvertReport> => {
    const current = trackerRef.current!
    try {
      const result = await trackerApi.convertColumn(trackerId, column.id, { type, revision: current.revision, confirm, clearUnfit })
      if (result.applied && alive.current) {
        setTracker(result.tracker)
        setWork(w => ({ ...w, filters: w.filters.filter(filter => filter.columnId !== column.id), sort: w.sort?.columnId === column.id ? null : w.sort, groupBy: w.groupBy === column.id ? '' : w.groupBy }))
        await refresh().catch(() => undefined)
        say('info', `“${column.name}” is now a ${COLUMN_TYPES.find(item => item.type === type)?.label || type} column.`)
      }
      return result
    } catch (error) {
      if (error instanceof TrackerApiError && error.body.tracker && alive.current) setTracker(error.body.tracker)
      throw error
    }
  }

  // Frozen columns come first, in their own order, so they can stay in view while the rest scrolls.
  const shownColumns = useMemo(() => {
    const list = columns.filter(column => !work.hidden.includes(column.id))
    const shown = list.length ? list : columns.slice(0, 1)
    return [...shown.filter(column => isFrozenColumn(column, columns)), ...shown.filter(column => !isFrozenColumn(column, columns))]
  }, [columns, work.hidden])
  const frozenIds = useMemo(() => new Set(shownColumns.filter(column => isFrozenColumn(column, columns)).map(column => column.id)), [shownColumns, columns])
  const visible = useMemo(() => visibleRows(rows, columns, { search, filters: work.filters, sort: work.sort, hidden: work.hidden }, lookup), [rows, columns, search, work.filters, work.sort, work.hidden, lookup])
  const entries = useMemo<Entry[]>(() => {
    const groupColumn = work.groupBy ? columns.find(column => column.id === work.groupBy) : undefined
    if (!groupColumn) return visible.map((row, index) => ({ kind: 'row', row, n: index + 1 }))
    const out: Entry[] = []
    let n = 0
    for (const group of groupRows(visible, groupColumn, lookup)) {
      out.push({ kind: 'group', key: group.key, label: group.label, count: group.rows.length })
      for (const row of group.rows) out.push({ kind: 'row', row, n: ++n })
    }
    return out
  }, [visible, columns, work.groupBy, lookup])
  const canEdit = Boolean(tracker?.canEdit && !tracker.archived)
  const canEditSource = canEdit
  const orderable = canEdit && !work.sort && !work.groupBy && work.filters.length === 0 && !work.search.trim()
  const activeView = tracker?.views.find(view => view.id === activeViewId)
  const baseline = activeView ? stripWork({ ...emptyWork, ...activeView }) : stripWork(emptyWork)
  const dirty = !sameValue(stripWork(work), baseline)
  const drawerRow = drawerId ? rows.find(row => row.id === drawerId) : undefined
  useEffect(() => { if (drawerId && status === 'ready' && !rows.some(row => row.id === drawerId)) { setDrawerId(''); say('info', 'That row was deleted.') } }, [drawerId, rows, status, say])
  // Escape closes the row panel from anywhere, unless something on top of it (a menu, a dialog, a cell being edited) used the key.
  useEffect(() => {
    if (!drawerId) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      if (document.querySelector('dialog[open], .trk-popover')) return
      setDrawerId('')
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [drawerId])
  const clientName = useCallback((id: string) => props.clients.find(client => client.id === id)?.name || '', [props.clients])
  const projectName = (id: string) => props.projects.find(project => project.id === id)?.name || ''

  // ---- saving rows ----
  const enqueue = (rowId: string, task: (pendingBehind: () => boolean) => Promise<void>) => {
    const queue = queues.current.get(rowId) || { tail: Promise.resolve(), pending: 0 }
    queue.pending++
    queues.current.set(rowId, queue)
    setSaving(count => count + 1)
    queue.tail = queue.tail.then(() => task(() => queue.pending > 1)).catch(() => undefined).finally(() => {
      queue.pending--
      if (queue.pending === 0) queues.current.delete(rowId)
      if (alive.current) setSaving(count => count - 1)
      // A failed save leaves an unsaved edit on screen; once nothing else is saving, reload the true rows.
      if (!queues.current.size && needsRefresh.current && alive.current) { needsRefresh.current = false; void refresh().catch(() => undefined) }
    })
  }
  const replaceRow = (next: TrackerRow, keepCells: boolean) => setRows(rowsRef.current.map(row => row.id === next.id ? (keepCells ? { ...next, cells: row.cells, taskId: row.taskId } : next) : row))
  const rowFailed = (error: unknown, rowId: string) => {
    if (!alive.current) return
    if (error instanceof TrackerApiError) {
      if (error.body.tracker) setTracker(error.body.tracker)
      if (error.status === 404) { setRows(rowsRef.current.filter(row => row.id !== rowId)); return say('error', 'That row no longer exists. It may have been deleted by someone else.') }
      if (error.body.row) replaceRow(error.body.row, false)
      else needsRefresh.current = true
      return say('error', error.status === 409 ? `${error.message} Your change was not saved.` : error.message)
    }
    needsRefresh.current = true
    say('error', error instanceof Error ? error.message : 'The change could not be saved.')
  }
  const patchRow = (rowId: string, body: { cells?: Record<string, Cell>; secrets?: Record<string, string | null>; taskId?: string | null }) => {
    enqueue(rowId, async behind => {
      const latest = rowsRef.current.find(row => row.id === rowId)
      if (!latest) return
      try {
        const { row } = await trackerApi.updateRow(trackerId, rowId, { version: latest.version, ...body })
        if (alive.current) replaceRow(row, behind())
      } catch (error) { rowFailed(error, rowId) }
    })
  }

  const editCell = (row: TrackerRow, column: TrackerColumn, value: Cell) => {
    if (!canEdit) return
    const current = rowsRef.current.find(item => item.id === row.id)
    if (!current) return
    const before = current.cells[column.id] ?? emptyCell(column.type)
    if (sameValue(before, isEmptyCell(value) ? emptyCell(column.type) : value)) return
    const cells = { ...current.cells }
    if (isEmptyCell(value)) delete cells[column.id]; else cells[column.id] = value
    setRows(rowsRef.current.map(item => item.id === row.id ? { ...item, cells } : item))
    patchRow(row.id, { cells: { [column.id]: value } })
  }
  const linkTask = (row: TrackerRow, taskId: string | null) => {
    if (!canEdit) return
    setRows(rowsRef.current.map(item => item.id === row.id ? { ...item, taskId: taskId || '' } : item))
    patchRow(row.id, { taskId })
  }
  const addLink = async (row: TrackerRow, taskId: string, columnId: string) => {
    if (!canEdit) return
    const result = await trackerApi.addLink(trackerId, { rowId: row.id, taskId, columnId })
    setLinks(current => [...current.filter(link => link.rowId !== row.id), ...result.links])
  }
  // A subtask in a cell is a task link with that column. One per cell: picking another replaces it.
  const cellLinks = useMemo(() => {
    const map = new Map<string, Map<string, TaskLink>>()
    for (const link of links) if (link.columnId) {
      const row = map.get(link.rowId) || new Map<string, TaskLink>()
      if (!row.has(link.columnId)) row.set(link.columnId, link)
      map.set(link.rowId, row)
    }
    return map
  }, [links])
  const setCellSubtask = async (row: TrackerRow, columnId: string, taskId: string | null) => {
    const old = links.filter(link => link.rowId === row.id && link.columnId === columnId)
    if (taskId && old.some(link => link.taskId === taskId)) return
    for (const link of old) await removeLink(link)
    if (taskId) await addLink(row, taskId, columnId)
  }
  const workTools: WorkTools = useMemo(() => ({ items: props.items, clients: props.clients, projects: props.projects, isClosed: props.isTaskClosed, onCreate: canEdit ? props.onCreateTasks : undefined, onOpenTask: props.onOpenTask }),
    [props.items, props.clients, props.projects, props.isTaskClosed, props.onCreateTasks, props.onOpenTask, canEdit])
  const linkRowTasks = async (pairs: { rowId: string; taskId: string }[]) => {
    for (let at = 0; at < pairs.length; at += TRACKER_LIMITS.importBatch) {
      const result = await trackerApi.linkRowTasks(trackerId, pairs.slice(at, at + TRACKER_LIMITS.importBatch))
      const byId = new Map(result.rows.map(row => [row.id, row]))
      setRows(rowsRef.current.map(row => byId.get(row.id) || row))
    }
    say('info', `${plural(pairs.length, 'task')} created and linked.`)
  }
  const removeLink = async (link: TaskLink) => {
    if (!canEdit) return
    await trackerApi.removeLink(trackerId, link.id)
    setLinks(current => current.filter(item => item.id !== link.id))
  }
  // The totals row adds up the rows shown (after search and filters), like a SUM over a filtered range.
  const totals = useMemo(() => {
    const summed = shownColumns.filter(column => column.total === 'sum' && (column.type === 'number' || column.type === 'formula'))
    if (!summed.length) return undefined
    const shownRows = entries.flatMap(entry => entry.kind === 'row' ? [entry.row] : [])
    return new Map(summed.map(column => [column.id, columnTotal(column, shownRows, columns)]))
  }, [shownColumns, entries, columns])
  const linkMap = useMemo(() => {
    const map = new Map<string, { count: number; cells: Set<string> }>()
    for (const link of links) {
      const entry = map.get(link.rowId) || { count: 0, cells: new Set<string>() }
      entry.count += 1; if (link.columnId) entry.cells.add(link.columnId)
      map.set(link.rowId, entry)
    }
    return map
  }, [links])
  const setSecret = (row: TrackerRow, column: TrackerColumn, value: string | null) => {
    if (!canEdit) return
    patchRow(row.id, { secrets: { [column.id]: value } })
  }
  const reveal = async (row: TrackerRow, column: TrackerColumn) => {
    try { return (await trackerApi.reveal(trackerId, row.id, column.id)).value }
    catch (error) { throw new Error(error instanceof Error ? error.message : 'Could not reveal this value.') }
  }

  const addRow = async () => {
    if (!canEdit || !tracker) return
    if (rowsRef.current.length >= TRACKER_LIMITS.rows) return say('error', `A tracker can have at most ${TRACKER_LIMITS.rows.toLocaleString('en')} rows.`)
    try {
      const { rows: created } = await trackerApi.addRows(trackerId, [{}])
      if (!alive.current) return
      setRows([...rowsRef.current, ...created])
      setTracker({ ...trackerRef.current!, rowCount: trackerRef.current!.rowCount + created.length })
      props.onListChanged()
      const hiddenByFilters = work.filters.length > 0 || work.search.trim() !== ''
      const stillShown = visibleRows(created, columns, { search: work.search, filters: work.filters, sort: null, hidden: work.hidden }, lookup).length > 0
      if (hiddenByFilters && !stillShown) say('info', 'Row added. It is hidden by the current filters or search, so clear them to see it.')
      else setFocus({ rowId: created[0].id, columnId: shownColumns[0].id, edit: true, nonce: ++focusNonce.current })
    } catch (error) { say('error', error instanceof Error ? error.message : 'The row could not be added.') }
  }

  const removeRows = async (ids: string[]) => {
    if (!canEdit || !ids.length) return
    if (!window.confirm(`Delete ${plural(ids.length, 'row')}? This cannot be undone.`)) return
    try {
      for (let at = 0; at < ids.length; at += TRACKER_LIMITS.importBatch) await trackerApi.deleteRows(trackerId, ids.slice(at, at + TRACKER_LIMITS.importBatch))
      if (!alive.current) return
      const gone = new Set(ids)
      setRows(rowsRef.current.filter(row => !gone.has(row.id)))
      setTracker({ ...trackerRef.current!, rowCount: Math.max(0, trackerRef.current!.rowCount - ids.length) })
      setSelected(new Set()); if (gone.has(drawerId)) setDrawerId('')
      props.onListChanged()
      say('info', `${plural(ids.length, 'row')} deleted.`)
    } catch (error) { say('error', error instanceof Error ? error.message : 'The rows could not be deleted.'); void refresh().catch(() => undefined) }
  }

  // ---- columns ----
  const applyColumns = async (next: TrackerColumn[]) => {
    const current = trackerRef.current!
    try {
      const result = await trackerApi.saveColumns(trackerId, next, current.revision)
      if (alive.current) setTracker(result.tracker)
    } catch (error) {
      if (error instanceof TrackerApiError && error.body.tracker && alive.current) { setTracker(error.body.tracker); throw new Error('Someone else changed this tracker’s columns. It was reloaded; review it and try again.') }
      throw error
    }
  }
  const saveColumn = async (draft: ColumnDraft, existing?: TrackerColumn) => {
    const extra = (column: TrackerColumn): TrackerColumn => {
      const copy: TrackerColumn = { ...column }
      if (draft.formula !== undefined) copy.formula = draft.formula
      if (draft.total === null) delete copy.total; else if (draft.total) copy.total = draft.total
      return copy
    }
    const next: TrackerColumn[] = existing
      ? columns.map(column => column.id === existing.id ? extra({ ...column, name: draft.name, ...(draft.options ? { options: draft.options } : {}), ...(draft.revealBy ? { revealBy: draft.revealBy } : {}) }) : column)
      : [...columns, extra({ id: randomId('c_'), name: draft.name, type: draft.type, ...(draft.options ? { options: draft.options } : {}), ...(draft.revealBy ? { revealBy: draft.revealBy } : {}) })]
    await applyColumns(next)
  }
  const deleteColumn = async (column: TrackerColumn) => {
    await applyColumns(columns.filter(item => item.id !== column.id))
    if (column.type === 'secret') void refresh().catch(() => undefined)
  }
  const moveColumn = async (column: TrackerColumn, direction: -1 | 1) => {
    const at = columns.findIndex(item => item.id === column.id), to = at + direction
    if (at < 0 || to < 0 || to >= columns.length) return
    const next = [...columns]; [next[at], next[to]] = [next[to], next[at]]
    try { await applyColumns(next) } catch (error) { say('error', error instanceof Error ? error.message : 'The column could not be moved.') }
  }

  /** Changes how one column looks (frozen, aligned, wider). It is saved with the tracker, so everyone sees it. */
  const styleColumn = async (column: TrackerColumn, patch: Partial<Pick<TrackerColumn, 'frozen' | 'align' | 'width'>>) => {
    const next = columns.map(item => {
      if (item.id !== column.id) return item
      const copy: TrackerColumn = { ...item, ...patch }
      if (patch.width === undefined && 'width' in patch) delete copy.width
      return copy
    })
    const widthNow = (item: TrackerColumn) => item.id === column.id && patch.width !== undefined ? patch.width : widthOf(item, item.id === columns[0]?.id)
    if (patch.frozen === true || patch.width !== undefined) {
      const used = next.filter(item => isFrozenColumn(item, next)).reduce((sum, item) => sum + widthNow(item), NUMBER_COLUMN_WIDTH)
      if (used > 700 && (patch.frozen === true || isFrozenColumn(column, columns))) { say('error', 'The frozen columns would take up too much of the screen. Make them narrower, or unfreeze one first.'); return }
    }
    try { await applyColumns(next) } catch (error) { say('error', error instanceof Error ? error.message : 'The column could not be changed.') }
  }

  // ---- views ----
  const applyView = (view?: TrackerView) => {
    setActiveViewId(view?.id || '')
    setWork(current => ({ ...current, ...stripWork(view ? { ...emptyWork, ...view } : emptyWork) }))
  }
  const saveViews = async (views: TrackerView[]) => {
    const current = trackerRef.current!
    try { const result = await trackerApi.saveViews(trackerId, views, current.revision); if (alive.current) setTracker(result.tracker); return result.tracker }
    catch (error) {
      if (error instanceof TrackerApiError && error.body.tracker && alive.current) setTracker(error.body.tracker)
      say('error', error instanceof Error ? error.message : 'The view could not be saved.')
      return null
    }
  }
  const createView = async () => {
    const name = viewName.trim()
    if (!name) return
    const saved = await saveViews([...(tracker?.views || []), { id: '', name, ...stripWork(work) }])
    if (!saved) return
    setSaveViewOpen(false); setViewName('')
    const created = saved.views.find(view => view.name.toLowerCase() === name.toLowerCase())
    if (created) setActiveViewId(created.id)
  }
  const updateView = async () => {
    if (!activeView || !tracker) return
    const saved = await saveViews(tracker.views.map(view => view.id === activeView.id ? { ...view, ...stripWork(work) } : view))
    if (saved) say('info', `View “${activeView.name}” updated.`)
  }
  const deleteView = async (view: TrackerView) => {
    if (!tracker || !window.confirm(`Delete the view “${view.name}”? The rows are not affected.`)) return
    const saved = await saveViews(tracker.views.filter(item => item.id !== view.id))
    if (saved && view.id === activeViewId) applyView(undefined)
  }

  // ---- tracker-level actions ----
  const patchTracker = async (body: Parameters<typeof trackerApi.update>[1], done?: string) => {
    try { const result = await trackerApi.update(trackerId, body); if (alive.current) { setTracker(result.tracker); props.onListChanged(); if (done) say('info', done) } return true }
    catch (error) { say('error', error instanceof Error ? error.message : 'The tracker could not be updated.'); return false }
  }
  const archive = async () => {
    if (!window.confirm('Archive this tracker? It becomes read-only and moves out of the main list. You can restore it later.')) return
    await patchTracker({ archived: true }, 'Tracker archived.')
  }
  const destroy = async () => {
    if (!window.confirm(`Permanently delete “${tracker?.name}” and all ${plural(tracker?.rowCount || 0, 'row')} in it? This cannot be undone.`)) return
    try { await trackerApi.remove(trackerId); props.onListChanged(); props.onBack() } catch (error) { say('error', error instanceof Error ? error.message : 'The tracker could not be deleted.') }
  }
  const download = () => {
    if (!tracker) return
    const body = exportCsv(shownColumns, visible, lookup)
    const url = URL.createObjectURL(new Blob([body], { type: 'text/csv;charset=utf-8' }))
    const link = document.createElement('a')
    link.href = url; link.download = exportFileName(tracker.name, props.today)
    document.body.appendChild(link); link.click(); link.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
    say('info', `Exported ${plural(visible.length, 'row')} as you see them. Secret columns are never exported.`)
  }

  if (status === 'loading') return <div className="trk-page"><p className="trk-muted-text" role="status">Loading tracker…</p></div>
  if (status === 'error' || !tracker) return <div className="trk-page">
    <button type="button" className="trk-text-button" onClick={props.onBack}><ArrowLeft size={14} aria-hidden="true" /> Trackers</button>
    <Notice kind="error">{loadError || 'The tracker could not be loaded.'}</Notice>
  </div>

  const editingColumn = columnDialog?.mode === 'edit' ? columns.find(column => column.id === columnDialog.id) : undefined
  const savingText = saving > 0 ? 'Saving…' : 'All changes saved'
  const filtered = work.filters.length > 0 || work.search.trim() !== ''
  const menuColumn = headerMenu ? columns.find(column => column.id === headerMenu.id) : undefined
  const menuIndex = menuColumn ? columns.findIndex(column => column.id === menuColumn.id) : -1

  return <div className="trk-page trk-screen">
    <nav className="trk-crumbs" aria-label="Breadcrumb">
      <button type="button" className="trk-text-button" onClick={props.onBack}><ArrowLeft size={14} aria-hidden="true" /> Trackers</button>
      <span aria-hidden="true">/</span><span>{tracker.name}</span>
    </nav>
    <header className="trk-header">
      <div className="trk-title">
        <h2>{tracker.name}</h2>
        {(trackerClients(tracker).length > 0 || tracker.projectId) && <span className="trk-chip" title={trackerClients(tracker).map(clientName).join(', ')}>{[trackerClients(tracker).length > 2 ? `${clientName(trackerClients(tracker)[0])} +${trackerClients(tracker).length - 1} clients` : trackerClients(tracker).map(clientName).join(', '), projectName(tracker.projectId)].filter(Boolean).join(' · ')}</span>}
        {tracker.private && <span className="trk-chip"><Lock size={12} aria-hidden="true" /> Only you</span>}
        {tracker.archived && <span className="trk-chip warn">Archived</span>}
      </div>
      <div className="trk-header-actions">
        {canEdit && <button type="button" className="trk-button" onClick={() => setImporting(true)} title="Import a sheet" aria-label="Import a sheet"><Upload size={14} aria-hidden="true" /><span className="trk-label">Import</span></button>}
        <button type="button" className="trk-button" onClick={download} title="Export CSV: the rows and columns you see now" aria-label="Export CSV"><Download size={14} aria-hidden="true" /><span className="trk-label">Export CSV</span></button>
        <button type="button" className="trk-button" aria-pressed={expanded} onClick={toggleExpanded} title={expanded ? 'Exit full view: show the page header again' : 'Full view: hide the page header to give the grid the whole screen'} aria-label={expanded ? 'Exit full view' : 'Full view'}>{expanded ? <Minimize2 size={14} aria-hidden="true" /> : <Maximize2 size={14} aria-hidden="true" />}<span className="trk-label">{expanded ? 'Exit full view' : 'Full view'}</span></button>
        <button type="button" className="trk-button" ref={moreButton} aria-haspopup="menu" aria-expanded={moreOpen} aria-label="More" title="More options" onClick={() => setMoreOpen(open => !open)}><span className="trk-label">More</span><ChevronDown size={14} aria-hidden="true" /></button>
      </div>
    </header>
    {moreOpen && <Popover anchor={moreButton} onClose={() => setMoreOpen(false)} className="trk-menu" label="Tracker options" minWidth={240}>
      <div role="menu">
        {tracker.canEdit && !tracker.archived && <button type="button" role="menuitem" onClick={() => { setMoreOpen(false); setDetails(true) }}>Rename, client and project…</button>}
        {tracker.canManage && !tracker.archived && <button type="button" role="menuitem" onClick={() => { setMoreOpen(false); void patchTracker({ private: !tracker.private }, tracker.private ? 'Everyone in the account can now see this tracker.' : 'Only you can see this tracker now.') }}>{tracker.private ? 'Share with the account' : 'Make private (only me)'}</button>}
        {tracker.canManage && !tracker.archived && <button type="button" role="menuitem" onClick={() => { setMoreOpen(false); void archive() }}>Archive tracker</button>}
        {tracker.canManage && tracker.archived && <button type="button" role="menuitem" onClick={() => { setMoreOpen(false); void patchTracker({ archived: false }, 'Tracker restored.') }}>Restore tracker</button>}
        {tracker.canManage && tracker.archived && <button type="button" role="menuitem" className="danger" onClick={() => { setMoreOpen(false); void destroy() }}>Delete permanently…</button>}
        {tracker.source && canEdit && <button type="button" role="menuitem" onClick={() => { setMoreOpen(false); void stopSyncing() }}>Stop syncing with the Sheet…</button>}
        <button type="button" role="menuitem" onClick={() => { setMoreOpen(false); void refresh().then(() => say('info', 'Up to date.')).catch(error => say('error', error instanceof Error ? error.message : 'Could not refresh.')) }}>Refresh now</button>
      </div>
    </Popover>}

    {tracker.archived && <div className="trk-banner"><AlertTriangle size={15} aria-hidden="true" /> This tracker is archived and read-only.{tracker.canManage && <button type="button" className="trk-text-button strong" onClick={() => void patchTracker({ archived: false }, 'Tracker restored.')}><RotateCcw size={13} aria-hidden="true" /> Restore</button>}</div>}
    {!tracker.canEdit && !tracker.archived && <div className="trk-banner">Your role can view this tracker but not change it.</div>}
    {tracker.source && <div className={`trk-source-bar${tracker.source.lastStatus === 'error' ? ' error' : ''}`} role="status">
      <span className="trk-source-name">Synced from <a href={`https://docs.google.com/spreadsheets/d/${tracker.source.spreadsheetId}/edit`} target="_blank" rel="noopener noreferrer">{tracker.source.spreadsheetName || 'Google Sheet'} › {tracker.source.tab}</a></span>
      <span className="trk-muted">Sheet → tracker · connected by {tracker.source.connectedByName || 'someone'}{tracker.source.lastSyncedAt ? ` · synced ${niceTime(tracker.source.lastSyncedAt)}` : ' · not synced yet'}{tracker.source.lastReport && tracker.source.lastStatus === 'ok' ? ` · ${describeSync(tracker.source.lastReport)}` : ''}</span>
      {tracker.source.lastStatus === 'error' && <span className="trk-source-error">{tracker.source.lastError}</span>}
      {tracker.source.lastReport?.newHeaders?.length ? <span className="trk-muted" title={tracker.source.lastReport.newHeaders.join(', ')}>{plural(tracker.source.lastReport.newHeaders.length, 'Sheet column')} not followed</span> : null}
      <span className="trk-spacer" />
      {canEdit && tracker.source.lastStatus === 'error' && <button type="button" className="trk-button" disabled={syncing} onClick={() => void reconnect()} title="Use your own Google account to read the Sheet">Reconnect with my Google</button>}
      {canEdit && <button type="button" className="trk-button" disabled={syncing} onClick={() => void syncNow(true)}>{syncing ? 'Syncing…' : 'Sync now'}</button>}
    </div>}
    {rows.some(row => row.review && !row.taskId) && !review && <div className="trk-banner trk-review-banner">
      <strong>{plural(rows.filter(row => row.review && !row.taskId).length, 'new row')}{tracker.source ? ' from the Sheet' : ''}</strong> waiting for review: make them tasks, subtasks, or leave them as plain rows.
      {canEdit && <button type="button" className="trk-text-button strong" onClick={() => setReview({ origin: tracker.source ? 'sheet' : 'import', ids: 'flagged' })}>Review</button>}
    </div>}
    {notice && <Notice kind={notice.kind} onClose={() => setNotice(null)}>{notice.text}</Notice>}

    <div className="trk-views" role="group" aria-label="Saved views">
      <button type="button" className={`trk-view${activeViewId === '' ? ' on' : ''}`} aria-pressed={activeViewId === ''} onClick={() => applyView(undefined)}>All rows{activeViewId === '' ? ` · ${visible.length.toLocaleString('en')}` : ''}</button>
      {tracker.views.map(view => <span key={view.id} className={`trk-view-wrap${activeViewId === view.id ? ' on' : ''}`}>
        <button type="button" className={`trk-view${activeViewId === view.id ? ' on' : ''}`} aria-pressed={activeViewId === view.id} onClick={() => applyView(view)}>{view.name}{activeViewId === view.id ? ` · ${visible.length.toLocaleString('en')}` : ''}</button>
        {tracker.canEdit && !tracker.archived && activeViewId === view.id && <button type="button" className="trk-icon-button small" aria-label={`Delete the view ${view.name}`} onClick={() => void deleteView(view)}><X size={13} /></button>}
      </span>)}
      {tracker.canEdit && !tracker.archived && dirty && activeView && <button type="button" className="trk-view dashed" onClick={() => void updateView()}>Save changes to “{activeView.name}”</button>}
      {tracker.canEdit && !tracker.archived && dirty && <button type="button" className="trk-view dashed" ref={saveViewButton} aria-haspopup="dialog" onClick={() => setSaveViewOpen(open => !open)}>Save as view</button>}
      {dirty && <button type="button" className="trk-view plain" onClick={() => applyView(activeView)}>Reset</button>}
    </div>
    {saveViewOpen && <Popover anchor={saveViewButton} onClose={() => setSaveViewOpen(false)} className="trk-panel-pop" label="Save as a view" minWidth={300}>
      <form className="trk-pop-body" onSubmit={event => { event.preventDefault(); void createView() }}>
        <label className="trk-field-block">View name<input autoFocus value={viewName} maxLength={TRACKER_LIMITS.viewName} onChange={event => setViewName(event.target.value)} placeholder="For example, Delayed sites" /></label>
        <p className="trk-muted-text">Saves the current filters, sort, grouping and visible columns for everyone who can open this tracker.</p>
        <div className="trk-pop-actions"><button type="submit" className="trk-button primary" disabled={!viewName.trim()}>Save view</button></div>
      </form>
    </Popover>}

    <div className="trk-toolbar">
      <label className="trk-search"><Search size={14} aria-hidden="true" /><input type="search" placeholder="Search this tracker" value={work.search} aria-label="Search this tracker" onChange={event => setWork({ ...work, search: event.target.value })} /></label>
      <TrackerToolbar columns={columns} work={work} people={people} open={panel} onOpen={setPanel} onChange={setWork} />
      <span className="trk-spacer" />
      <span className="trk-save-state" role="status"><span className={`trk-dot${saving > 0 ? ' busy' : ''}`} aria-hidden="true" />{savingText}</span>
      {canEdit && <button type="button" className="trk-button primary" onClick={() => void addRow()}><Plus size={14} aria-hidden="true" /> Add row</button>}
    </div>
    {selected.size > 0 && <div className="trk-selection" role="status">
      <strong>{plural(selected.size, 'row')} selected</strong>
      {canEdit && <span className="trk-move-group" role="group" aria-label="Move the selected rows">
        <button type="button" className="trk-button" disabled={!orderable} onClick={() => void moveRows([...selected], 'start')} title={orderable ? 'Move to the top' : 'Clear the sort, grouping, search and filters to move rows'}>Top</button>
        <button type="button" className="trk-button" disabled={!orderable} onClick={() => void moveRows([...selected], stepTarget(-1))} title={orderable ? 'Move up one row' : 'Clear the sort, grouping, search and filters to move rows'} aria-label="Move up"><ArrowUp size={14} aria-hidden="true" /></button>
        <button type="button" className="trk-button" disabled={!orderable} onClick={() => void moveRows([...selected], stepTarget(1))} title={orderable ? 'Move down one row' : 'Clear the sort, grouping, search and filters to move rows'} aria-label="Move down"><ArrowDown size={14} aria-hidden="true" /></button>
        <button type="button" className="trk-button" disabled={!orderable} onClick={() => void moveRows([...selected], null)} title={orderable ? 'Move to the bottom' : 'Clear the sort, grouping, search and filters to move rows'}>Bottom</button>
      </span>}
      {canEdit && props.onCreateTasks && <button type="button" className="trk-button" onClick={() => setBulkOpen(true)} title="Create a task for each selected row that has none">Create tasks</button>}
      {canEdit && <button type="button" className="trk-button danger" onClick={() => void removeRows([...selected])}>Delete</button>}
      <button type="button" className="trk-text-button" onClick={() => setSelected(new Set())}>Clear selection</button>
    </div>}

    <section className="trk-grid-panel" aria-label={`${tracker.name} rows`}>
      <TrackerGrid
        columns={shownColumns} frozen={frozenIds} primaryId={columns[0]?.id || ''} entries={entries} lookup={lookup} people={people} canEdit={canEdit} sort={work.sort} selected={selected} focus={focus}
        taskTitle={row => lookup.task(row.taskId)?.title || 'a deleted task'} links={linkMap} totals={totals} onWork={(row, column, element) => { workAnchor.current = element; setWorkCell({ rowId: row.id, columnId: column.id }) }}
        cellWork={(row, column) => {
          if (column.id === columns[0]?.id) { const task = row.taskId ? lookup.task(row.taskId) : undefined; return row.taskId ? { title: task ? `Task: ${task.title} (${task.status})` : 'The linked task was deleted', label: task ? task.status : 'Removed', done: Boolean(task && props.isTaskClosed(task.status)), task: true } : null }
          const link = cellLinks.get(row.id)?.get(column.id); if (!link) return null
          const sub = lookup.task(link.taskId)
          return { title: sub ? `Subtask: ${sub.title} (${sub.status})` : 'The linked subtask was deleted', label: sub ? (props.isTaskClosed(sub.status) ? 'Done' : sub.status) : 'Removed', done: Boolean(sub && props.isTaskClosed(sub.status)), task: false }
        }} allColumns={columns} rowName={row => rowTitle(columns, row)}
        onEdit={editCell} onOpenRow={row => setDrawerId(row.id)} onInvalid={message => say('error', message)}
        onHeader={(column, button) => { headerAnchor.current = button; setHeaderMenu(column) }}
        onAddColumn={canEdit ? () => setColumnDialog({ mode: 'add' }) : undefined}
        onMove={orderable ? (ids, before) => void moveRows(ids, before) : undefined}
        onResize={canEdit ? (column, width) => void styleColumn(column, { width: width ?? undefined }) : undefined}
        onToggleRow={(rowId, on) => setSelected(current => { const next = new Set(current); if (on) next.add(rowId); else next.delete(rowId); return next })}
        onToggleAll={on => setSelected(on ? new Set(entries.flatMap(entry => entry.kind === 'row' ? [entry.row.id] : [])) : new Set())} />
      {rows.length === 0 && <div className="trk-empty"><p><strong>No rows yet.</strong></p><p className="trk-muted-text">{canEdit ? 'Add a row, or bring in a sheet you already keep.' : 'Nothing has been added to this tracker.'}</p>
        {canEdit && <div className="trk-card-actions"><button type="button" className="trk-button primary" onClick={() => void addRow()}><Plus size={14} aria-hidden="true" /> Add row</button><button type="button" className="trk-button" onClick={() => setImporting(true)}><Upload size={14} aria-hidden="true" /> Import a sheet</button></div>}</div>}
      {rows.length > 0 && visible.length === 0 && <div className="trk-empty"><p><strong>No rows match.</strong></p>
        <div className="trk-card-actions"><button type="button" className="trk-button" onClick={() => setWork({ ...work, search: '', filters: [] })}>Clear search and filters</button></div></div>}
    </section>

    <footer className="trk-legend">
      <span>{filtered ? `Showing ${visible.length.toLocaleString('en')} of ${plural(rows.length, 'row')}` : plural(rows.length, 'row')} · {plural(columns.length, 'column')}</span>
      <span><i className="trk-key connected" aria-hidden="true" /> Blue headers fill themselves from the linked task</span>
      <span><i className="trk-key secret" aria-hidden="true" /> Amber headers are protected</span>
      {columns.some(column => column.type === 'formula') && <span><i className="trk-key computed" aria-hidden="true" /> Purple headers are calculated</span>}
      {tracker.source && <span><i className="trk-key synced" aria-hidden="true" /> Green headers come from the Google Sheet; change those cells there</span>}
      {props.onCreateTasks && canEdit && <span>Point at a cell: + Task in the first column, + for a subtask in the others</span>}
    </footer>

    {menuColumn && <Popover anchor={headerAnchor} onClose={() => setHeaderMenu(null)} className="trk-menu" label={`${menuColumn.name} options`} minWidth={230}>
      <div role="menu">
        {menuColumn.type !== 'secret' && <button type="button" role="menuitem" onClick={() => { setWork({ ...work, sort: { columnId: menuColumn.id, dir: 'asc' } }); setHeaderMenu(null) }}>Sort ascending</button>}
        {menuColumn.type !== 'secret' && <button type="button" role="menuitem" onClick={() => { setWork({ ...work, sort: { columnId: menuColumn.id, dir: 'desc' } }); setHeaderMenu(null) }}>Sort descending</button>}
        {work.sort?.columnId === menuColumn.id && <button type="button" role="menuitem" onClick={() => { setWork({ ...work, sort: null }); setHeaderMenu(null) }}>Clear sort</button>}
        <button type="button" role="menuitem" onClick={() => { if (work.filters.length < TRACKER_LIMITS.filtersPerView) setWork({ ...work, filters: [...work.filters, { columnId: menuColumn.id, op: filterOpsFor(menuColumn.type)[0], value: '' }] }); setHeaderMenu(null); setPanel('filter') }}>Filter by this column</button>
        {menuColumn.type !== 'secret' && menuColumn.type !== 'longtext' && <button type="button" role="menuitem" onClick={() => { setWork({ ...work, groupBy: menuColumn.id }); setHeaderMenu(null) }}>Group by this column</button>}
        {shownColumns.length > 1 && <button type="button" role="menuitem" onClick={() => { setWork({ ...work, hidden: [...work.hidden, menuColumn.id] }); setHeaderMenu(null) }}>Hide in this view</button>}
        {canEdit && <hr />}
        {canEdit && <button type="button" role="menuitem" onClick={() => { setHeaderMenu(null); void styleColumn(menuColumn, { frozen: !isFrozenColumn(menuColumn, columns) }) }}>{isFrozenColumn(menuColumn, columns) ? 'Unfreeze column' : 'Freeze column'}</button>}
        {canEdit && <div className="trk-menu-label" id="trk-align-label">Align text</div>}
        {canEdit && <div className="trk-seg" role="group" aria-labelledby="trk-align-label">
          {(['left', 'center', 'right'] as ColumnAlign[]).map(side => <button key={side} type="button" aria-pressed={(menuColumn.align || (menuColumn.type === 'number' ? 'right' : menuColumn.type === 'checkbox' ? 'center' : 'left')) === side}
            onClick={() => { setHeaderMenu(null); void styleColumn(menuColumn, { align: side }) }}>{side[0].toUpperCase() + side.slice(1)}</button>)}
        </div>}
        {canEdit && <div className="trk-menu-label" id="trk-width-label">Width <small>(or drag the header edge)</small></div>}
        {canEdit && <div className="trk-seg" role="group" aria-labelledby="trk-width-label">
          {([['Narrow', 120], ['Standard', 0], ['Wide', 360], ['Extra wide', 560]] as const).map(([label, width]) => {
            const now = menuColumn.width || 0
            return <button key={label} type="button" aria-pressed={width === 0 ? now === 0 : now === width} onClick={() => { setHeaderMenu(null); void styleColumn(menuColumn, { width: width || undefined }) }}>{label}</button>
          })}
        </div>}
        {canEdit && <hr />}
        {canEdit && <button type="button" role="menuitem" onClick={() => { setHeaderMenu(null); setColumnDialog({ mode: 'edit', id: menuColumn.id }) }}>Edit column…</button>}
        {canEdit && menuIndex > 0 && <button type="button" role="menuitem" onClick={() => { setHeaderMenu(null); void moveColumn(menuColumn, -1) }}>Move left</button>}
        {canEdit && menuIndex < columns.length - 1 && <button type="button" role="menuitem" onClick={() => { setHeaderMenu(null); void moveColumn(menuColumn, 1) }}>Move right</button>}
      </div>
    </Popover>}

    {workCell && (() => {
      const row = rows.find(item => item.id === workCell.rowId), column = columns.find(item => item.id === workCell.columnId)
      if (!row || !column) return null
      const first = column.id === columns[0]?.id
      return <TrackerWorkPicker key={`${row.id}:${column.id}`} anchor={workAnchor} tracker={tracker} row={row} column={column} mode={first ? 'task' : 'subtask'} rowTitle={rowTitle(columns, row)}
        current={cellLinks.get(row.id)?.get(column.id)?.taskId} tools={workTools} onClose={() => setWorkCell(null)}
        onPickTask={async taskId => { linkTask(row, taskId) }}
        onPickSubtask={taskId => setCellSubtask(row, column.id, taskId)}
        onSwitchToTask={() => setWorkCell({ rowId: row.id, columnId: columns[0].id })} />
    })()}
    {review && <TrackerReview tracker={tracker} lookup={lookup} tools={workTools} origin={review.origin}
      rows={review.ids === 'flagged' ? rows.filter(row => row.review) : rows.filter(row => (review.ids as string[]).includes(row.id))}
      onClose={() => setReview(null)} onApply={applyReview} />}
    {bulkOpen && <TrackerBulkTasks tracker={tracker} rows={rows.filter(row => selected.has(row.id))} titleOf={row => rowTitle(columns, row)} tools={workTools} onClose={() => setBulkOpen(false)} onDone={linkRowTasks} />}
    {drawerRow && <TrackerRowPanel tracker={tracker} row={drawerRow} lookup={lookup} people={people} items={props.items} clientName={clientName} canEdit={canEdit} isAdmin={props.isAdmin}
      onClose={() => setDrawerId('')} onEdit={editCell} onSecret={setSecret} onLink={linkTask} links={links} onAddLink={addLink} onRemoveLink={removeLink} onDelete={row => void removeRows([row.id])} onOpenTask={props.onOpenTask} onReveal={reveal} />}

    {columnDialog && (columnDialog.mode === 'add' || editingColumn) && <TrackerColumnDialog mode={columnDialog.mode} columns={columns} column={editingColumn} onClose={() => setColumnDialog(null)}
      onSave={draft => saveColumn(draft, editingColumn)} onDelete={editingColumn ? () => deleteColumn(editingColumn) : undefined}
      onConvert={editingColumn ? (type, confirm, clearUnfit) => convertColumn(editingColumn, type, confirm, clearUnfit) : undefined} />}
    {importing && <TrackerImportDialog tracker={tracker} clients={props.clients} projects={props.projects} people={people} today={props.today} onClose={() => setImporting(false)}
      onDone={(_, imported, ids) => { setImporting(false); props.onListChanged(); void refresh().then(() => { say('info', `${plural(imported, 'row')} imported.`); if (ids?.length && props.onCreateTasks && canEdit) setReview({ origin: 'import', ids }) }).catch(error => say('error', error instanceof Error ? error.message : 'Imported, but the tracker could not be refreshed.')) }} />}
    {details && <TrackerDetailsDialog tracker={tracker} clients={props.clients} projects={props.projects} onClose={() => setDetails(false)}
      onSave={async body => { const result = await trackerApi.update(trackerId, body); setTracker(result.tracker); props.onListChanged() }} />}
  </div>
}
