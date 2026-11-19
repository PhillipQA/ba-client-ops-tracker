import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  BellRing,
  CalendarDays,
  CalendarRange,
  ChevronDown,
  Columns3,
  Palette,
  Download,
  Lock,
  Maximize2,
  Minimize2,
  Plus,
  RotateCcw,
  Search,
  Table2,
  Upload,
  X,
  Zap,
} from 'lucide-react'
import {
  TRACKER_LIMITS,
  emptyCell,
  filterOpsFor,
  isEmptyCell,
  randomId,
  COLUMN_TYPES,
  type Cell,
  type ColumnAlign,
  type ColumnType,
  type OptionColor,
  type Tracker,
  type TrackerColumn,
  type TrackerRow,
  type TrackerView,
  isFrozenColumn,
  taskFieldColumn,
  trackerProjectIds,
  trackerClientIds,
} from './trackerModel'
import { rowTones, settleTimelineFields, todayNumber } from './timelineModel'
import { isClosedProject } from '../tasks/lifecycle'
import { cellText, keepsTasks, phaseRollup, rowTaskPatch, type TaskPatch } from './trackerTasks'
import { createRowTasks } from './trackerTaskActions'
import { groupRows, makeLookup, rowTitle, shown, visibleRows } from './trackerQuery'
import { TOTAL_LABELS, type TotalKind, type TotalShown, progressOf, totalKindsFor, totalOf } from './trackerTotals'
import { type BulkPlan, bulkColumns, bulkUndo } from './trackerBulk'
import TrackerBulkSet from './TrackerBulkSet'
import TrackerBoard from './TrackerBoard'
import TrackerCalendar from './TrackerCalendar'
import TrackerHighlightRules from './TrackerHighlightRules'
import TrackerRemindersDialog from './TrackerRemindersDialog'
import TrackerAutomationsDialog from './TrackerAutomationsDialog'
import type { Automation } from './trackerAutomations'
import { describeReminder, type TrackerReminder } from './trackerReminders'
import { describeRule, type HighlightRule, ruleTones } from './highlightRules'
import { exportCsv, exportFileName } from './trackerExport'
import {
  type AutomationSummary,
  TrackerApiError,
  loadAllRows,
  trackerApi,
  type ConvertReport,
  type TaskLink,
} from './trackerApi'
import TrackerTimeline from './TrackerTimeline'
import TrackerColumnSubtasks from './TrackerColumnSubtasks'
import TrackerGrid, { NUMBER_COLUMN_WIDTH, widthOf, type Entry, type GridFocus } from './TrackerGrid'
import TrackerToolbar, { emptyWork, type Work } from './TrackerToolbar'
import TrackerRowPanel from './TrackerRowPanel'
import { TrackerBulkTasks, TrackerWorkPicker, type TaskDraft, type WorkTools } from './TrackerWork'
import TrackerColumnDialog, { type ColumnDraft } from './TrackerColumnDialog'
import TrackerImportDialog from './TrackerImportDialog'
import TrackerDetailsDialog from './TrackerDetailsDialog'
import { Dialog, HighlightSwatches, Notice, Popover, TrackerLoading, plural } from './trackerUi'
import type { Conflict } from './trackerTwoWay'
import { rememberSheetEdits, takeReview, takeSheetEdits, takeTrackerRow, type SheetEditsFor } from './trackerNav'
import { autoDoneColumn } from './trackerAutoDone'
import TrackerReview, { type ReviewOutcome, type ReviewPreset } from './TrackerReview'
import { SYNC_LIMITS, describeSync } from './trackerSync'
import { niceTime } from './trackerUi'
import { SaveAsTemplateDialog } from './TemplateManager'
import { sheetHasGantt } from './sheetGantt'
import { keepsStepTasks, planMissingSteps, planStepTasks, siteTaskPatch, siteTaskTitle, stepColumns } from './stepTasks'
import { missingClientPatches, rowContract, rowPlace } from './trackerProjects'
import { cellSubtaskPatches, tickedCellPatches } from './cellSubtasks'
import { waitForCloudSaves } from '../../app/cloudStore'
import { useVisiblePolling } from '../../app/useVisiblePolling'
import type { Client, Project, UserAccount, WorkItem } from '../../shared/types'

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
  /** Changes tasks from this tracker (title, dates, phase, done). */
  onUpdateTasks?: (patches: TaskPatch[]) => Promise<boolean>
  /** The server changed tasks (boxes ticked in the connected Sheet): load the workspace again to show them. */
  onTasksChanged?: () => Promise<void>
  /** The person using the tracker: new tasks are assigned to them. */
  currentUserId?: string
  /** Said once when the tracker opens, such as how many tasks were made with it. */
  startNote?: string
  /** The list of trackers on the home screen needs a refresh. */
  onListChanged: () => void
  /** Back from Google's permission page: what happened (`write-enabled`, `write-denied`…). */
  googleReturn?: string
}

type PanelId = 'filter' | 'sort' | 'group' | 'fields' | null
const stripWork = (work: Work) => ({
  filters: work.filters,
  sort: work.sort,
  groupBy: work.groupBy,
  hidden: work.hidden,
})
const sameValue = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

export default function TrackerScreen(props: Props) {
  const { trackerId } = props
  const [tracker, setTrackerState] = useState<Tracker | null>(null)
  const trackerRef = useRef<Tracker | null>(null)
  const setTracker = (next: Tracker | null) => {
    // Only some answers carry the tracker's users (they need the workspace); the others keep the last known list.
    const previous = trackerRef.current
    const kept =
      next && !next.users && previous?.id === next.id && previous.users ? { ...next, users: previous.users } : next
    trackerRef.current = kept
    setTrackerState(kept)
  }
  const [rows, setRowsState] = useState<TrackerRow[]>([])
  const rowsRef = useRef<TrackerRow[]>([])
  const setRows = (next: TrackerRow[]) => {
    rowsRef.current = next
    setRowsState(next)
  }
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [loadError, setLoadError] = useState('')
  const [notice, setNotice] = useState<{ kind: 'error' | 'info'; text: string; undo?: () => void } | null>(null)
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
  const [savingTemplate, setSavingTemplate] = useState(false)
  const [headerMenu, setHeaderMenu] = useState<TrackerColumn | null>(null)
  const [moreOpen, setMoreOpen] = useState(false)
  const [saveViewOpen, setSaveViewOpen] = useState(false)
  const [viewName, setViewName] = useState('')
  const headerAnchor = useRef<HTMLElement | null>(null)
  const moreButton = useRef<HTMLButtonElement>(null)
  const workAnchor = useRef<HTMLElement | null>(null)
  const [workCell, setWorkCell] = useState<{ rowId: string; columnId: string } | null>(null)
  const [bulkOpen, setBulkOpen] = useState(false)
  const [review, setReview] = useState<{
    origin: 'sheet' | 'import'
    ids: string[] | 'flagged'
    /** Choices made on import: the review starts from them, and may create the tasks at once. */
    preset?: ReviewPreset
  } | null>(null)
  /** Two-way: an edit whose Sheet cell changed since the last sync, waiting for the person to choose. */
  const [conflict, setConflict] = useState<{
    rowId: string
    cells: Record<string, Cell>
    conflicts: Conflict[]
  } | null>(null)
  const [modeBusy, setModeBusy] = useState(false)
  /** Turning on two-way was refused because this person has not let the app edit Google Sheets. */
  const [twoWayNeedsWrite, setTwoWayNeedsWrite] = useState(false)
  const [syncing, setSyncing] = useState(false)
  // Full-width view: the page header (Add client, Add task…) is hidden so the grid gets the whole height. The left menu stays.
  const [expanded, setExpanded] = useState(() => {
    try {
      return localStorage.getItem('ba.tracker.expanded') === '1'
    } catch {
      return false
    }
  })
  // Grid, Board, Calendar or Timeline, remembered per tracker on this device.
  type Layout = 'grid' | 'board' | 'calendar' | 'timeline'
  const [layout, setLayoutState] = useState<Layout>('grid')
  const layoutKey = `ba.tracker.layout.${props.trackerId}`
  // A tracker made from the Project timeline template opens on the timeline until someone picks the grid.
  const timelineFirst = tracker?.template === 'project-timeline'
  useEffect(() => {
    try {
      const chosen = localStorage.getItem(layoutKey)
      setLayoutState(
        chosen === 'board' || chosen === 'calendar'
          ? chosen
          : chosen === 'timeline' || (!chosen && timelineFirst)
            ? 'timeline'
            : 'grid',
      )
    } catch {
      setLayoutState(timelineFirst ? 'timeline' : 'grid')
    }
  }, [layoutKey, timelineFirst])
  const setLayout = (next: Layout) => {
    setLayoutState(next)
    try {
      localStorage.setItem(layoutKey, next)
    } catch {
      /* not remembered */
    }
  }
  const toggleExpanded = () =>
    setExpanded(current => {
      const next = !current
      try {
        localStorage.setItem('ba.tracker.expanded', next ? '1' : '0')
      } catch {
        /* not remembered */
      }
      return next
    })
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
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const say = useCallback((kind: 'error' | 'info', text: string) => setNotice({ kind, text }), [])
  // Said once, when the tracker opens.
  useEffect(() => {
    if (props.startNote) say('info', props.startNote)
  }, [])
  useEffect(() => {
    if (!notice || notice.kind === 'error') return
    // A notice with Undo stays a little longer, so there is time to press it.
    const timer = window.setTimeout(() => setNotice(null), notice.undo ? 12000 : 7000)
    return () => window.clearTimeout(timer)
  }, [notice])

  // ---- loading ----
  const load = useCallback(
    async (signal?: AbortSignal) => {
      const [meta, all] = await Promise.all([trackerApi.get(trackerId, signal), loadAllRows(trackerId, signal)])
      return { tracker: meta.tracker, rows: all }
    },
    [trackerId],
  )

  useEffect(() => {
    const controller = new AbortController()
    setStatus('loading')
    setTracker(null)
    setRows([])
    setDrawerId('')
    setSelected(new Set())
    setWork(emptyWork)
    setActiveViewId('')
    setLinks([])
    // Links have their own table. If it is missing the tracker still opens, just without them.
    trackerApi
      .links(trackerId, controller.signal)
      .then(result => setLinks(result.links))
      .catch(() => undefined)
    load(controller.signal)
      .then(result => {
        setTracker(result.tracker)
        setRows(result.rows)
        setStatus('ready')
      })
      .catch(error => {
        if (error?.name === 'AbortError') return
        setLoadError(error instanceof Error ? error.message : 'The tracker could not be loaded.')
        setStatus('error')
      })
    return () => controller.abort()
  }, [trackerId, load])

  // Arriving from a task's tracker link opens that row's details.
  useEffect(() => {
    if (status !== 'ready') return
    const wanted = takeTrackerRow(trackerId)
    if (wanted && rowsRef.current.some(row => row.id === wanted)) setDrawerId(wanted)
    // Arriving straight from an import or a new Sheet connection opens the review of the new rows.
    const pending = takeReview(trackerId)
    if (pending)
      setReview({ origin: pending.rows === 'flagged' ? 'sheet' : 'import', ids: pending.rows, preset: pending.preset })
    // Back from allowing Google Sheets edits: carry on with what the person was doing.
    const purpose = takeSheetEdits(trackerId)
    if (purpose) {
      if (props.googleReturn === 'write-denied')
        say(
          'error',
          purpose === 'done'
            ? 'Editing Google Sheets was not allowed, so done marks still stay in the tracker only.'
            : 'Editing Google Sheets was not allowed, so your changes to the green columns cannot reach the Sheet.',
        )
      else if (props.googleReturn === 'write-enabled') {
        if (purpose === 'create') void createSheet()
        else if (purpose === 'gantt') void addGantt()
        else if (purpose === 'two_way') void switchMode('two_way')
        else if (purpose === 'edit')
          say(
            'info',
            'Editing Google Sheets is allowed. Your changes to the green columns are now written to the Sheet.',
          )
        else if (trackerRef.current?.source && trackerRef.current.source.canWrite === false) void reconnect()
        else say('info', 'Editing Google Sheets is allowed. Done marks are now written to the Sheet.')
      }
    }
  }, [status, trackerId])

  /**
   * Boxes ticked or unticked in the Sheet completed or reopened their subtasks on the server during a sync: the
   * workspace is loaded again so they show as done here and in Tasks.
   */
  const followServerTasks = (result: { tasks?: number }) => {
    if (result.tasks && props.onTasksChanged) void props.onTasksChanged().catch(() => undefined)
  }
  // Connected Google Sheet: Sync now, and an automatic sync every few minutes while the tracker is open.
  const syncNow = async (force: boolean) => {
    const current = trackerRef.current
    if (!current?.source || syncing) return
    setSyncing(true)
    try {
      // Task edits still saving go first: a sync can complete subtasks, and those must not collide with them.
      await waitForCloudSaves().catch(() => undefined)
      const result = await trackerApi.syncSource(trackerId, force)
      if (!alive.current) return
      followServerTasks(result)
      if (!result.skipped) await refresh()
      // Keep what was learnt about write permission; a sync result does not carry it.
      else if (trackerRef.current)
        setTracker({ ...trackerRef.current, source: { ...trackerRef.current.source, ...result.source } })
      if (force) say('info', result.report ? `Synced. ${describeSync(result.report)}.` : 'Synced.')
    } catch (error) {
      if (force) say('error', error instanceof Error ? error.message : 'The Sheet could not be synced.')
      await refresh().catch(() => undefined)
    } finally {
      if (alive.current) setSyncing(false)
    }
  }
  const allowSheets = async () => {
    try {
      // An Excel file is downloaded to be read, which needs Google's permission to read Drive files too.
      const response = await fetch(
        `/api/communications/gmail/connect?sheets=1${tracker?.source?.excel ? '&excel=1' : ''}`,
        { credentials: 'same-origin' },
      )
      const result = await response.json().catch(() => ({}))
      if (!response.ok || !result.url) throw new Error(result.error || 'Could not start the Google permission step.')
      window.location.assign(result.url)
    } catch (error) {
      say('error', error instanceof Error ? error.message : 'Could not start the Google permission step.')
    }
  }
  const allowSheetEdits = async (purpose: SheetEditsFor = 'done') => {
    try {
      const response = await fetch('/api/communications/gmail/connect?sheets=write', { credentials: 'same-origin' })
      const result = await response.json().catch(() => ({}))
      if (!response.ok || !result.url) throw new Error(result.error || 'Could not start the Google permission step.')
      rememberSheetEdits(trackerId, purpose)
      window.location.assign(result.url)
    } catch (error) {
      say('error', error instanceof Error ? error.message : 'Could not start the Google permission step.')
    }
  }
  /** Makes a Google Sheet from this tracker and connects it two-way; asks for Google permission first when needed. */
  const [creatingSheet, setCreatingSheet] = useState(false)
  const createSheet = async () => {
    const current = trackerRef.current
    if (!current || current.source) return
    setCreatingSheet(true)
    try {
      const result = await trackerApi.createSheet(current.id, current.name)
      if (alive.current) setTracker(result.tracker)
      await refresh()
      say(
        'info',
        `Google Sheet “${result.tracker.source?.spreadsheetName || current.name}” made ${result.folder?.length ? `in the account Google Drive, in ${result.folder.join(' › ')},` : 'in your Google Drive'} with ${plural(result.rows, 'row')}${result.emptyRows ? ` (${plural(result.emptyRows, 'empty row')} left out)` : ''}${result.gantt ? ' and a Gantt chart tab' : ''}, and synced both ways. Open it from the Sheet bar above${result.folder?.length ? '' : '; share it from Google Sheets'}.${result.folder?.length ? '' : ' Once an Administrator connects the account Google Drive in Settings, new Sheets go to Client › Project folders there.'}`,
      )
    } catch (error) {
      if (error instanceof TrackerApiError && error.body.needsWrite) {
        void allowSheetEdits('create')
        return
      }
      say('error', error instanceof Error ? error.message : 'The Google Sheet could not be made.')
    } finally {
      if (alive.current) setCreatingSheet(false)
    }
  }
  /** Adds (or draws again) the Gantt chart tab in the connected Sheet. */
  const [ganttBusy, setGanttBusy] = useState(false)
  const addGantt = async () => {
    const current = trackerRef.current
    if (!current?.source) return
    setGanttBusy(true)
    try {
      const result = await trackerApi.addGantt(current.id)
      say(
        'info',
        result.replaced
          ? 'The Gantt chart tab in the Google Sheet was drawn again. Open the Sheet from the bar above.'
          : 'A Gantt chart tab was added to the Google Sheet. It follows every sync; open the Sheet from the bar above.',
      )
    } catch (error) {
      if (error instanceof TrackerApiError && error.body.needsWrite) {
        void allowSheetEdits('gantt')
        return
      }
      say('error', error instanceof Error ? error.message : 'The Gantt chart could not be added to the Sheet.')
    } finally {
      if (alive.current) setGanttBusy(false)
    }
  }
  const retrySheetIssues = async () => {
    setSyncing(true)
    try {
      const result = await trackerApi.retrySheetIssues(trackerId)
      await refresh()
      if (result.failed)
        say(
          'error',
          `${result.written ? `${plural(result.written, 'row')} written to the Sheet; ` : ''}${plural(result.failed, 'row')} still could not be. Open a row to see why.`,
        )
      else say('info', `${plural(result.written, 'row')} marked in the Sheet.`)
    } catch (error) {
      say('error', error instanceof Error ? error.message : 'The Sheet could not be updated.')
    } finally {
      if (alive.current) setSyncing(false)
    }
  }
  const dismissSheetIssues = async (ids: string[] = []) => {
    try {
      await trackerApi.dismissSheetIssues(trackerId, ids)
      await refresh()
    } catch (error) {
      say('error', error instanceof Error ? error.message : 'That could not be cleared.')
    }
  }
  const reconnect = async () => {
    setSyncing(true)
    try {
      await waitForCloudSaves().catch(() => undefined)
      const result = await trackerApi.reconnectSource(trackerId)
      followServerTasks(result)
      await refresh()
      say('info', `Reconnected with your Google account. ${result.report ? describeSync(result.report) : ''}`)
    } catch (error) {
      if (error instanceof TrackerApiError && error.body.needsGoogle) {
        if (
          window.confirm(
            'Allow the tracker to read your Google Sheets first? You will come back here after Google asks.',
          )
        )
          void allowSheets()
      } else say('error', error instanceof Error ? error.message : 'Could not reconnect.')
    } finally {
      if (alive.current) setSyncing(false)
    }
  }
  const stopSyncing = async () => {
    if (
      !window.confirm(
        'Stop syncing with the Google Sheet? Every row stays in the tracker and its columns become editable here. You can link a Sheet again later from Import → Link an existing Google Sheet.',
      )
    )
      return
    try {
      const result = await trackerApi.disconnectSource(trackerId)
      setTracker(result.tracker)
      await refresh()
      say('info', 'This tracker no longer follows the Sheet.')
    } catch (error) {
      say('error', error instanceof Error ? error.message : 'Could not stop syncing.')
    }
  }
  const applyReview = async (outcome: ReviewOutcome) => {
    if (outcome.rowTasks.length) await linkRowTasks(outcome.rowTasks)
    if (outcome.cellLinks.length) {
      const result = await trackerApi.bulkLinks(trackerId, outcome.cellLinks)
      setLinks(result.links)
      // A subtask made for a box that is already ticked is done from the start, like ticking it.
      const ticks = tickedCellPatches(columns, rowsRef.current, outcome.cellLinks, () => true)
      if (ticks.length && props.onUpdateTasks) await props.onUpdateTasks(ticks).catch(taskFailed)
    }
    if (outcome.reviewed.length) await trackerApi.reviewed(trackerId, outcome.reviewed).catch(() => undefined)
    await refresh()
    const made = outcome.rowTasks.length + outcome.cellLinks.length
    if (made)
      say(
        'info',
        made === 1
          ? 'Created 1 task from the rows.'
          : `Created ${made.toLocaleString('en')} tasks and subtasks from the rows.`,
      )
  }

  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      const result = await load(signal)
      // Never replace rows underneath an edit that is still being saved.
      if (!alive.current || queues.current.size) return
      setTracker(result.tracker)
      setRows(result.rows)
      trackerApi
        .links(trackerId, signal)
        .then(found => {
          if (alive.current) setLinks(found.links)
        })
        .catch(() => undefined)
    },
    [load, trackerId],
  )
  // While a connected tracker is open and visible, it syncs when the last sync is older than a few minutes.
  useEffect(() => {
    if (status !== 'ready' || !tracker?.source || !canEditSource) return
    const due = () => {
      const last = Date.parse(trackerRef.current?.source?.lastSyncedAt || '') || 0
      if (document.visibilityState === 'visible' && Date.now() - last > SYNC_LIMITS.autoMinutes * 60_000)
        void syncNow(false)
    }
    due()
    const timer = window.setInterval(due, 60_000)
    return () => window.clearInterval(timer)
  }, [status, tracker?.source?.spreadsheetId, trackerId])
  useVisiblePolling(refresh, {
    enabled: status === 'ready' && saving === 0 && !columnDialog && !importing && !details,
    interval: 60_000,
    scope: trackerId,
    immediate: false,
  })

  // Keep the working view pointing at columns that exist.
  const columns = tracker?.columns ?? []
  useEffect(() => {
    if (!tracker) return
    const known = new Set(tracker.columns.map(column => column.id))
    setWork(current => {
      const next: Work = {
        ...current,
        filters: current.filters.filter(filter => known.has(filter.columnId)),
        hidden: current.hidden.filter(id => known.has(id)),
        sort: current.sort && known.has(current.sort.columnId) ? current.sort : null,
        groupBy: known.has(current.groupBy) ? current.groupBy : '',
      }
      return sameValue(next, current) ? current : next
    })
    if (activeViewId && !tracker.views.some(view => view.id === activeViewId)) setActiveViewId('')
  }, [tracker, activeViewId])
  useEffect(() => {
    setSelected(current => {
      const ids = new Set(rows.map(row => row.id))
      const next = [...current].filter(id => ids.has(id))
      return next.length === current.size ? current : new Set(next)
    })
  }, [rows])

  // ---- derived ----
  const lookup = useMemo(
    () => ({ ...makeLookup(props.items, props.accounts, props.today), columns: tracker?.columns ?? [] }),
    [props.items, props.accounts, props.today, tracker?.columns],
  )
  const people = useMemo(
    () =>
      props.accounts
        .filter(account => account.status === 'Active')
        .map(account => ({ id: account.id, name: account.name || account.username })),
    [props.accounts],
  )
  const search = useDeferredValue(work.search)
  // Rows can be moved only while the grid shows them in their saved order.
  const moveRows = async (ids: string[], before: string | 'start' | null) => {
    if (!canEdit || !ids.length) return
    const moving = new Set(ids),
      current = rowsRef.current
    const rest = current.filter(row => !moving.has(row.id))
    const at = before === 'start' ? 0 : before === null ? rest.length : rest.findIndex(row => row.id === before)
    if (at < 0) return
    const next = [...rest.slice(0, at), ...current.filter(row => moving.has(row.id)), ...rest.slice(at)]
    if (next.every((row, index) => row.id === current[index].id)) return
    setRows(next)
    try {
      await trackerApi.moveRows(trackerId, ids, before)
    } catch (error) {
      say('error', error instanceof Error ? error.message : 'The rows could not be moved.')
      void refresh().catch(() => undefined)
    }
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
  const convertColumn = async (
    column: TrackerColumn,
    type: ColumnType,
    confirm: boolean,
    clearUnfit: boolean,
  ): Promise<ConvertReport> => {
    const current = trackerRef.current!
    try {
      const result = await trackerApi.convertColumn(trackerId, column.id, {
        type,
        revision: current.revision,
        confirm,
        clearUnfit,
      })
      if (result.applied && alive.current) {
        setTracker(result.tracker)
        setWork(w => ({
          ...w,
          filters: w.filters.filter(filter => filter.columnId !== column.id),
          sort: w.sort?.columnId === column.id ? null : w.sort,
          groupBy: w.groupBy === column.id ? '' : w.groupBy,
        }))
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
    return [
      ...shown.filter(column => isFrozenColumn(column, columns)),
      ...shown.filter(column => !isFrozenColumn(column, columns)),
    ]
  }, [columns, work.hidden])
  const frozenIds = useMemo(
    () => new Set(shownColumns.filter(column => isFrozenColumn(column, columns)).map(column => column.id)),
    [shownColumns, columns],
  )
  const visible = useMemo(
    () => visibleRows(rows, columns, { search, filters: work.filters, sort: work.sort, hidden: work.hidden }, lookup),
    [rows, columns, search, work.filters, work.sort, work.hidden, lookup],
  )
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
  useEffect(() => {
    if (drawerId && status === 'ready' && !rows.some(row => row.id === drawerId)) {
      setDrawerId('')
      say('info', 'That row was deleted.')
    }
  }, [drawerId, rows, status, say])
  // Escape closes the row panel from anywhere, unless something on top of it (a menu, a dialog, a cell being edited) used the key.
  useEffect(() => {
    if (!drawerId) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      if (document.querySelector('dialog[open], .k-popover')) return
      setDrawerId('')
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [drawerId])
  const clientName = useCallback(
    (id: string) => props.clients.find(client => client.id === id)?.name || '',
    [props.clients],
  )
  const projectName = (id: string) => props.projects.find(project => project.id === id)?.name || ''

  // ---- saving rows ----
  const enqueue = (rowId: string, task: (pendingBehind: () => boolean) => Promise<void>) => {
    const queue = queues.current.get(rowId) || { tail: Promise.resolve(), pending: 0 }
    queue.pending++
    queues.current.set(rowId, queue)
    setSaving(count => count + 1)
    queue.tail = queue.tail
      .then(() => task(() => queue.pending > 1))
      .catch(() => undefined)
      .finally(() => {
        queue.pending--
        if (queue.pending === 0) queues.current.delete(rowId)
        if (alive.current) setSaving(count => count - 1)
        // A failed save leaves an unsaved edit on screen; once nothing else is saving, reload the true rows.
        if (!queues.current.size && needsRefresh.current && alive.current) {
          needsRefresh.current = false
          void refresh().catch(() => undefined)
        }
      })
  }
  /** Says what the tracker's automations did after a save, and picks up a task one of them made. */
  const tellAutomation = (automation: AutomationSummary) => {
    if (!alive.current) return
    const done = automation.done.join(', ')
    const skipped = automation.skipped.length ? ` Skipped: ${automation.skipped.join('; ')}.` : ''
    say('info', `${done ? `Automation: ${done}.` : 'Automation ran.'}${skipped}`)
    if (automation.taskMade) void props.onTasksChanged?.()
  }
  const replaceRow = (next: TrackerRow, keepCells: boolean) =>
    setRows(
      rowsRef.current.map(row =>
        row.id === next.id ? (keepCells ? { ...next, cells: row.cells, taskId: row.taskId } : next) : row,
      ),
    )
  const rowFailed = (error: unknown, rowId: string) => {
    if (!alive.current) return
    if (error instanceof TrackerApiError) {
      if (error.body.tracker) setTracker(error.body.tracker)
      if (error.status === 404) {
        setRows(rowsRef.current.filter(row => row.id !== rowId))
        return say('error', 'That row no longer exists. It may have been deleted by someone else.')
      }
      if (error.body.row) replaceRow(error.body.row, false)
      else needsRefresh.current = true
      return say('error', error.status === 409 ? `${error.message} Your change was not saved.` : error.message)
    }
    needsRefresh.current = true
    say('error', error instanceof Error ? error.message : 'The change could not be saved.')
  }
  const patchRow = (
    rowId: string,
    body: {
      cells?: Record<string, Cell>
      secrets?: Record<string, string | null>
      taskId?: string | null
      overwrite?: boolean
    },
    /** Runs once the row is saved, for work that must not happen when the save fails. */
    onSaved?: () => void,
  ) => {
    enqueue(rowId, async behind => {
      const latest = rowsRef.current.find(row => row.id === rowId)
      if (!latest) return
      try {
        const { row, automation } = await trackerApi.updateRow(trackerId, rowId, { version: latest.version, ...body })
        if (alive.current) replaceRow(row, behind())
        onSaved?.()
        if (automation) tellAutomation(automation)
      } catch (error) {
        // Two-way: the Sheet cell changed since the last sync. Show both values and let the person choose.
        if (error instanceof TrackerApiError && Array.isArray(error.body.conflicts) && alive.current) {
          if (error.body.row) replaceRow(error.body.row, false)
          setConflict({ rowId, cells: body.cells || {}, conflicts: error.body.conflicts })
          return
        }
        if (error instanceof TrackerApiError && error.body.needsWrite && trackerRef.current?.source)
          setTracker({ ...trackerRef.current, source: { ...trackerRef.current.source, youCanWrite: false } })
        rowFailed(error, rowId)
      }
    })
  }
  /** Keeps the person's edit: written to the Sheet over what is there now. */
  const keepMine = () => {
    if (!conflict) return
    const { rowId, cells } = conflict
    setConflict(null)
    const before = rowsRef.current.find(row => row.id === rowId)?.cells || {}
    const after = { ...before }
    for (const [columnId, value] of Object.entries(cells))
      if (isEmptyCell(value)) delete after[columnId]
      else after[columnId] = value
    setRows(rowsRef.current.map(row => (row.id === rowId ? { ...row, cells: after } : row)))
    patchRow(rowId, { cells, overwrite: true }, () => followTicks(rowId, before, after))
  }
  /** Takes the Sheet's values: a sync brings them in. */
  const takeSheets = async () => {
    setConflict(null)
    await syncNow(true)
    await refresh().catch(() => undefined)
  }
  const switchMode = async (mode: 'one_way' | 'two_way') => {
    setModeBusy(true)
    try {
      const result = await trackerApi.setSourceMode(trackerId, mode)
      if (alive.current && trackerRef.current) setTracker({ ...trackerRef.current, source: result.source })
      setTwoWayNeedsWrite(false)
      say(
        'info',
        mode === 'two_way'
          ? 'Two-way sync is on. Edits to the green columns are now written to the Google Sheet, and new rows are added there once they have a name.'
          : 'Two-way sync is off. The Google Sheet is read only; change the green columns there.',
      )
    } catch (error) {
      // Turning on two-way needs this person's own permission to edit Sheets: offer it right here.
      if (error instanceof TrackerApiError && error.body.needsWrite) {
        setTwoWayNeedsWrite(true)
        return
      }
      say('error', error instanceof Error ? error.message : 'The sync mode could not be changed.')
    } finally {
      if (alive.current) setModeBusy(false)
    }
  }

  /** Rows from a one-way Sheet keep the Sheet's values in synced columns; everything else can be edited. */
  const cellLocked = (row: TrackerRow, column: TrackerColumn) =>
    Boolean(column.synced && row.sourceKey && tracker?.source?.mode !== 'two_way')
  const canEditDates = (row: TrackerRow) =>
    canEdit && !columns.some(column => column.type === 'date' && cellLocked(row, column))
  /** The % done a Status change implies: 100 when set to Done, 0 when it leaves Done from 100. */
  const progressFor = (row: TrackerRow, column: TrackerColumn, value: Cell): Record<string, Cell> | null => {
    if (!tracker || column.type !== 'select') return null
    const fields = settleTimelineFields(columns, tracker.timeline?.fields || null)
    const doneColumn = autoDoneColumn(columns)
    if (column.id !== fields.statusId && column.id !== doneColumn?.id) return null
    const progress = columns.find(item => item.id === (taskFieldColumn(columns, 'progress')?.id || fields.progressId))
    if (!progress || progress.type !== 'number') return null
    const isDone = (cell: Cell | undefined) =>
      doneColumn?.id === column.id && doneColumn.autoDone?.done
        ? cell === doneColumn.autoDone.done
        : /^(done|completed?|finished|closed)$/i.test(column.options?.find(option => option.id === cell)?.label || '')
    const current = row.cells[progress.id]
    const scale = rowsRef.current.some(
      item => typeof item.cells[progress.id] === 'number' && (item.cells[progress.id] as number) > 1,
    )
      ? 100
      : rowsRef.current.some(
            item => typeof item.cells[progress.id] === 'number' && (item.cells[progress.id] as number) > 0,
          )
        ? 1
        : 100
    if (isDone(value) && current !== scale) return { [progress.id]: scale }
    if (!isDone(value) && isDone(row.cells[column.id]) && current === scale) return { [progress.id]: 0 }
    return null
  }
  /** Several cells of one row in one save, such as the Start and End of a dragged bar. */
  const editCells = (row: TrackerRow, values: Record<string, Cell>) => {
    if (!canEdit) return
    const current = rowsRef.current.find(item => item.id === row.id)
    if (!current) return
    const changed: Record<string, Cell> = {}
    const cells = { ...current.cells }
    for (const [id, value] of Object.entries(values)) {
      const column = columns.find(item => item.id === id)
      if (!column || cellLocked(current, column)) continue
      if (sameValue(current.cells[id] ?? emptyCell(column.type), value)) continue
      changed[id] = value
      if (isEmptyCell(value)) delete cells[id]
      else cells[id] = value
    }
    if (!Object.keys(changed).length) return
    setRows(rowsRef.current.map(item => (item.id === row.id ? { ...item, cells } : item)))
    patchRow(row.id, { cells: changed }, () => followTicks(row.id, current.cells, cells))
    followTasks(current, cells)
  }
  const editCell = (row: TrackerRow, column: TrackerColumn, value: Cell) => {
    if (!canEdit) return
    // Status → Done also sets % done to 100; leaving Done puts 100 back to 0. One save for both.
    const extra = progressFor(row, column, value)
    if (extra) return editCells(row, { [column.id]: value, ...extra })
    const current = rowsRef.current.find(item => item.id === row.id)
    if (!current) return
    const before = current.cells[column.id] ?? emptyCell(column.type)
    if (sameValue(before, isEmptyCell(value) ? emptyCell(column.type) : value)) return
    const cells = { ...current.cells }
    if (isEmptyCell(value)) delete cells[column.id]
    else cells[column.id] = value
    setRows(rowsRef.current.map(item => (item.id === row.id ? { ...item, cells } : item)))
    patchRow(row.id, { cells: { [column.id]: value } }, () => followTicks(row.id, current.cells, cells))
    followTasks(current, cells)
  }

  // ---- the tasks behind a project timeline: each phase a task, each row a subtask (see trackerTasks) ----
  const tasksKept = keepsTasks(columns)
  const phaseColumnId = useMemo(
    () => (tracker ? settleTimelineFields(columns, tracker.timeline?.fields || null).groupId : ''),
    [columns, tracker],
  )
  const taskFailed = (error: unknown) =>
    say('error', `The task could not be updated: ${error instanceof Error ? error.message : 'try again.'}`)
  /** Puts newly linked rows on screen without losing edits made meanwhile. */
  const takeLinked = (linked: TrackerRow[]) => {
    if (!linked.length || !alive.current) return
    const byId = new Map(linked.map(row => [row.id, row]))
    setRows(
      rowsRef.current.map(row => {
        const next = byId.get(row.id)
        return next ? { ...row, taskId: next.taskId, version: Math.max(row.version, next.version) } : row
      }),
    )
  }
  // The latest tasks, for work that runs after other saves have finished.
  const itemsRef = useRef(props.items)
  itemsRef.current = props.items
  /** Rows with a name and no task get their subtask (under their phase's task), after their own save. */
  const makeRowTasks = (rowIds: string[]) => {
    const current = trackerRef.current
    if (!current || !canEdit || !tasksKept || !props.onCreateTasks) return
    const create = props.onCreateTasks
    const last = rowIds[rowIds.length - 1]
    enqueue(last, async () => {
      // Read now, not when the edit was made: an earlier run may have linked the row already.
      const wanted = rowsRef.current.filter(row => rowIds.includes(row.id) && !row.taskId)
      if (!wanted.length) return
      const result = await createRowTasks({
        tracker: trackerRef.current || current,
        rows: rowsRef.current,
        onlyRowIds: wanted.map(row => row.id),
        items: itemsRef.current,
        currentUserId: props.currentUserId || '',
        onCreateTasks: create,
        projects: props.projects,
      })
      if (result.error) say('error', result.error)
      takeLinked(result.rows)
      if (result.projectId && trackerRef.current) setTracker({ ...trackerRef.current, projectId: result.projectId })
    })
  }
  // ---- Site rollout: a task for each site and a subtask for each step (see stepTasks) ----
  const stepTasks = keepsStepTasks(tracker)
  const linksRef = useRef(links)
  linksRef.current = links
  const noClientSaid = useRef(false)
  // Once per tracker opened by someone who can edit it: subtasks in boxes that were already ticked when they were made
  // (imports before this was fixed, Sheet rows) are completed, so the box and its subtask agree.
  const ticksChecked = useRef('')
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per tracker, when its rows and links are in
  useEffect(() => {
    const update = props.onUpdateTasks
    if (status !== 'ready' || !canEdit || !update || !links.length || ticksChecked.current === trackerId) return
    ticksChecked.current = trackerId
    const patches = tickedCellPatches(columns, rowsRef.current, links, id => {
      const item = itemsRef.current.find(entry => entry.id === id)
      return Boolean(item && !props.isTaskClosed(item.status))
    })
    // Tasks a Seeds sync left with no client (a project with no client of its own) get the tracker's one client back.
    const linkedTasks = links.map(link => link.taskId).filter((id): id is string => Boolean(id))
    const current = trackerRef.current
    const clients = current ? missingClientPatches(current, linkedTasks, itemsRef.current, props.projects) : []
    if (patches.length || clients.length) void update([...patches, ...clients]).catch(taskFailed)
  }, [status, canEdit, links, trackerId])
  const linkCells = async (cellLinks: { rowId: string; columnId: string; taskId: string }[]) => {
    for (let at = 0; at < cellLinks.length; at += TRACKER_LIMITS.importBatch) {
      const result = await trackerApi.bulkLinks(trackerId, cellLinks.slice(at, at + TRACKER_LIMITS.importBatch))
      if (alive.current) setLinks(result.links)
      linksRef.current = result.links
    }
  }
  /** Step-cell links to a subtask of a task other than the row's own (left from the row's earlier task). */
  const staleStepLinks = (rowsToCheck: TrackerRow[]) => {
    const stepIds = new Set(stepColumns(trackerRef.current?.columns || []).map(column => column.id))
    return linksRef.current.filter(link => {
      if (!link.columnId || !stepIds.has(link.columnId)) return false
      const row = rowsToCheck.find(candidate => candidate.id === link.rowId)
      const linked = itemsRef.current.find(item => item.id === link.taskId)
      return Boolean(row?.taskId && linked?.parentTaskId && linked.parentTaskId !== row.taskId)
    })
  }
  /** Named rows without a task get one, with a subtask in each step cell. Null: every such row. */
  const makeStepTasks = (rowIds: string[] | null) => {
    const current = trackerRef.current
    if (!current || !canEdit || !keepsStepTasks(current)) return
    if (!props.onCreateTasks) {
      if (!noClientSaid.current || rowIds === null)
        say('error', 'Your role cannot create tasks, so this site’s task and subtasks were not made.')
      noClientSaid.current = true
      return
    }
    // On a Seeds project, sites go under that project's client (the Seeds parent), whichever Before Seeds clients the
    // tracker also follows. A row whose contract number names another of the tracker's projects goes there.
    const seedsClient = props.projects.find(project => project.id === current.projectId && project.seedsId)?.clientId
    const clientId = seedsClient || trackerClientIds(current)[0] || ''
    const placeFor = (row: Pick<TrackerRow, 'cells' | 'taskId'>) => rowPlace(current, row, props.projects)
    // A tracker whose projects are all completed in Seeds keeps them, but its rows get no new tasks there.
    const own = trackerProjectIds(current)
    const completed = own.length
      ? own.every(id => isClosedProject(props.projects.find(project => project.id === id)))
      : false
    if (completed && !current.columns.some(column => column.taskField === 'contract')) {
      if (!noClientSaid.current || rowIds === null)
        say(
          'error',
          'This tracker’s project is completed in Seeds, so its rows get no new tasks. Choose an open project (More › Rename, client and project).',
        )
      noClientSaid.current = true
      return
    }
    if (!clientId && !current.columns.some(column => column.taskField === 'contract')) {
      if (!noClientSaid.current || rowIds === null)
        say(
          'error',
          'Choose a client for this tracker (More › Rename, client and project) so each site gets its task and subtasks.',
        )
      noClientSaid.current = true
      return
    }
    const create = props.onCreateTasks
    const update = props.onUpdateTasks
    const run = async () => {
      // Read now, not when the edit was made: an earlier run may have made the task already.
      const wanted = rowsRef.current.filter(row => !row.taskId && (rowIds === null || rowIds.includes(row.id)))
      const plan = planStepTasks({
        columns: current.columns,
        rows: wanted,
        clientId,
        projectId: current.projectId,
        assigneeId: props.currentUserId || '',
        placeFor,
      })
      try {
        let sites = 0
        if (plan.drafts.length) {
          const made = await create(plan.drafts)
          const rowLinks = plan.rowTasks.flatMap(link =>
            made[link.draft] ? [{ rowId: link.rowId, taskId: made[link.draft].id }] : [],
          )
          for (let at = 0; at < rowLinks.length; at += TRACKER_LIMITS.importBatch)
            takeLinked(
              (await trackerApi.linkRowTasks(trackerId, rowLinks.slice(at, at + TRACKER_LIMITS.importBatch))).rows,
            )
          sites = rowLinks.length
          const cellLinks = plan.cellTasks.flatMap(link =>
            made[link.draft] ? [{ rowId: link.rowId, columnId: link.columnId, taskId: made[link.draft].id }] : [],
          )
          await linkCells(cellLinks)
          const ticked = plan.ticked.flatMap(at => (made[at] ? [{ id: made[at].id, done: true }] : []))
          if (ticked.length && update) await update(ticked)
        }
        // A step cell still on a subtask of another task (the row moved to a new task, say from Before Seeds to
        // Seeds) lets go of it, so the step is made again under the row's task. The old subtask stays where it is.
        const stale = staleStepLinks(
          rowsRef.current.filter(row => row.taskId && (rowIds === null || rowIds.includes(row.id))),
        )
        for (const link of stale) await trackerApi.removeLink(trackerId, link.id)
        if (stale.length) {
          linksRef.current = linksRef.current.filter(link => !stale.includes(link))
          if (alive.current) setLinks(linksRef.current)
        }
        // Rows whose task was picked or made from the cell, or that lack a step added later: their missing subtasks.
        const missing = planMissingSteps({
          columns: current.columns,
          rows: rowsRef.current.filter(row => row.taskId && (rowIds === null || rowIds.includes(row.id))),
          links: linksRef.current,
          items: itemsRef.current,
          clientId,
          projectId: current.projectId,
          assigneeId: props.currentUserId || '',
        })
        let subtasks = 0
        if (missing.drafts.length || missing.existing.length) {
          const made = missing.drafts.length ? await create(missing.drafts) : []
          const cellLinks = [
            ...missing.existing,
            ...missing.cellTasks.flatMap(link =>
              made[link.draft] ? [{ rowId: link.rowId, columnId: link.columnId, taskId: made[link.draft].id }] : [],
            ),
          ]
          await linkCells(cellLinks)
          const ticked = missing.ticked.flatMap(at => (made[at] ? [{ id: made[at].id, done: true }] : []))
          if (ticked.length && update) await update(ticked)
          subtasks = cellLinks.length
        }
        if (sites)
          say(
            'info',
            `${plural(sites, 'site')} now ${sites === 1 ? 'has a task' : 'have tasks'}, with subtasks for the steps.`,
          )
        else if (subtasks)
          say('info', `${plural(subtasks, 'step')} now ${subtasks === 1 ? 'has its subtask' : 'have subtasks'}.`)
      } catch (error) {
        taskFailed(error)
      }
    }
    if (rowIds?.length) enqueue(rowIds[rowIds.length - 1], run)
    else void run()
  }
  /** After a row edit on a Site rollout tracker: a named row gets its task; the task follows its name and Go Live Date. */
  const followStepTasks = (before: TrackerRow, cells: Record<string, Cell>) => {
    const task = before.taskId ? props.items.find(entry => entry.id === before.taskId) : undefined
    if (!task) {
      if (siteTaskTitle(columns, cells)) makeStepTasks([before.id])
      return
    }
    const patch = siteTaskPatch(columns, task.id, before.cells, cells)
    if (patch && props.onUpdateTasks) void props.onUpdateTasks([patch]).catch(taskFailed)
  }
  /**
   * A box the person ticked or unticked here completes or reopens the subtask in that cell, on any tracker, once the row
   * is saved (see cellSubtasks). Ticks from the Google Sheet are followed on the server during the sync, and completing
   * a subtask in Tasks ticks its box on the server, so neither is followed here.
   */
  const followTicks = (rowId: string, before: Record<string, Cell>, after: Record<string, Cell>) => {
    const update = props.onUpdateTasks
    if (!canEdit || !update) return
    const patches = cellSubtaskPatches(columns, [{ rowId, before, after }], linksRef.current).filter(patch => {
      const subtask = itemsRef.current.find(item => item.id === patch.id)
      return subtask && props.isTaskClosed(subtask.status) !== patch.done
    })
    if (patches.length) void update(patches).catch(taskFailed)
  }
  const stepCount = stepTasks ? stepColumns(columns).length : 0
  // A step counts as made when its cell is on a subtask of the row's own task (or one not loaded yet).
  const sitesWithoutTask = stepTasks
    ? rows.filter(row => {
        if (!row.taskId) return siteTaskTitle(columns, row.cells)
        const own = links.filter(link => {
          if (link.rowId !== row.id || !link.columnId) return false
          const linked = props.items.find(item => item.id === link.taskId)
          return !linked?.parentTaskId || linked.parentTaskId === row.taskId
        })
        return new Set(own.map(link => link.columnId)).size < stepCount
      }).length
    : 0

  /** After a row edit: its task follows (title, dates, done, phase), or a named row gets its task. */
  const followTasks = (before: TrackerRow, cells: Record<string, Cell>) => {
    if (stepTasks && canEdit) return followStepTasks(before, cells)
    if (!tasksKept || !canEdit) return
    const item = before.taskId ? props.items.find(entry => entry.id === before.taskId) : undefined
    if (!item) {
      const title = taskFieldColumn(columns, 'title')
      if (title && cellText(title, cells[title.id])) makeRowTasks([before.id])
      return
    }
    if (!props.onUpdateTasks) return
    const update = props.onUpdateTasks
    const patch = rowTaskPatch(columns, item.id, before.cells, cells)
    const phaseColumn = columns.find(column => column.id === phaseColumnId)
    const phaseBefore = cellText(phaseColumn, phaseColumn ? before.cells[phaseColumn.id] : undefined)
    const phaseAfter = cellText(phaseColumn, phaseColumn ? cells[phaseColumn.id] : undefined)
    if (phaseColumn && phaseAfter && phaseAfter !== phaseBefore && item.parentTaskId !== undefined) {
      // Moved to another phase: under that phase's task (made when there is none yet).
      const sibling = rowsRef.current.find(
        row =>
          row.id !== before.id &&
          row.taskId &&
          cellText(phaseColumn, row.cells[phaseColumn.id]).toLowerCase() === phaseAfter.toLowerCase(),
      )
      const parentId = sibling ? props.items.find(entry => entry.id === sibling.taskId)?.parentTaskId : undefined
      const named = props.items.find(
        entry =>
          !entry.parentTaskId &&
          !entry.archived &&
          entry.projectId === item.projectId &&
          entry.title.trim().toLowerCase() === phaseAfter.toLowerCase(),
      )
      const target = parentId || named?.id
      if (target) {
        void update([{ ...(patch || { id: item.id }), parentTaskId: target }]).catch(taskFailed)
        return
      }
      if (props.onCreateTasks) {
        const create = props.onCreateTasks
        void create([
          {
            title: phaseAfter,
            clientId: item.clientId || '',
            projectId: item.projectId || '',
            description: 'Phase of a project timeline tracker.',
            assignedToUserId: props.currentUserId,
          },
        ])
          .then(([phase]) => update([{ ...(patch || { id: item.id }), parentTaskId: phase.id }]))
          .catch(taskFailed)
        return
      }
    }
    if (patch) void update([patch]).catch(taskFailed)
  }
  // Phase tasks span their subtasks and are done when all of them are: kept so even when subtasks change in Tasks.
  const rolledUp = useRef('')
  useEffect(() => {
    if (!tasksKept || !canEdit || !props.onUpdateTasks || status !== 'ready') return
    const linked = new Set(rows.map(row => row.taskId).filter(Boolean))
    const parents = props.items
      .filter(item => linked.has(item.id) && item.parentTaskId)
      .map(item => item.parentTaskId as string)
    const patches = phaseRollup(props.items, parents, props.isTaskClosed)
    const key = JSON.stringify(patches)
    if (!patches.length || key === rolledUp.current) return
    rolledUp.current = key
    const update = props.onUpdateTasks
    const timer = window.setTimeout(() => void update(patches).catch(() => undefined), 800)
    return () => window.clearTimeout(timer)
  }, [props.items, rows, tasksKept, canEdit, props.onUpdateTasks, props.isTaskClosed, status])

  // The Contract number column (an "SLSS #" column, say) shows the contract of each row's task's project, from Seeds.
  const contractFilled = useRef(new Set<string>())
  useEffect(() => {
    const column = taskFieldColumn(columns, 'contract')
    if (!column || column.synced || !canEdit || status !== 'ready') return
    for (const row of rows) {
      const contract = rowContract(row, props.projects, props.items)
      const key = `${row.id}|${contract}`
      if (!contract || contractFilled.current.has(key)) continue
      if (cellText(column, row.cells[column.id]).trim() === contract) continue
      contractFilled.current.add(key)
      patchRow(row.id, { cells: { [column.id]: contract } })
    }
  }, [rows, columns, props.projects, props.items, canEdit, status])

  // ---- row highlights, and colouring rows by their state ----
  const [statusColorsHere, setStatusColorsHere] = useState(() => {
    try {
      return localStorage.getItem(`ba.tracker.statusColors.${props.trackerId}`) === '1'
    } catch {
      return false
    }
  })
  // Shared on the tracker once schema v29 is in; until then each browser keeps its own choice.
  const statusColors = tracker?.timeline ? Boolean(tracker.timeline.statusColors) : statusColorsHere
  const toggleStatusColors = () => {
    const next = !statusColors
    setStatusColorsHere(next)
    try {
      localStorage.setItem(`ba.tracker.statusColors.${props.trackerId}`, next ? '1' : '0')
    } catch {
      /* not remembered */
    }
    const current = trackerRef.current
    if (current?.timeline && canEdit) {
      const settings = { ...current.timeline, statusColors: next || undefined }
      setTracker({ ...current, timeline: settings })
      void trackerApi.saveTimeline(current.id, settings).catch(() => undefined)
    }
  }
  // A row's colour: its own highlight, else the first highlight rule that matches, else Colour by status.
  const rules = useMemo(() => tracker?.timeline?.rules || [], [tracker?.timeline?.rules])
  const [rulesOpen, setRulesOpen] = useState(false)
  const reminders = useMemo(() => tracker?.timeline?.reminders || [], [tracker?.timeline?.reminders])
  const [remindersOpen, setRemindersOpen] = useState(false)
  const automationList = useMemo(() => tracker?.timeline?.automations || [], [tracker?.timeline?.automations])
  const [automationsOpen, setAutomationsOpen] = useState(false)
  const saveAutomations = async (next: Automation[]) => {
    const current = trackerRef.current
    if (!current) return
    const settings = { ...(current.timeline || {}), automations: next.length ? next : undefined }
    const result = await trackerApi.saveTimeline(current.id, settings)
    if (alive.current && trackerRef.current) setTracker({ ...trackerRef.current, timeline: result.timeline })
  }
  const saveReminders = async (next: TrackerReminder[]) => {
    const current = trackerRef.current
    if (!current) return
    const settings = { ...(current.timeline || {}), reminders: next.length ? next : undefined }
    const result = await trackerApi.saveTimeline(current.id, settings)
    if (alive.current && trackerRef.current) setTracker({ ...trackerRef.current, timeline: result.timeline })
  }
  const saveRules = async (next: HighlightRule[]) => {
    const current = trackerRef.current
    if (!current) return
    const settings = { ...(current.timeline || {}), rules: next.length ? next : undefined }
    const result = await trackerApi.saveTimeline(current.id, settings)
    if (alive.current && trackerRef.current) setTracker({ ...trackerRef.current, timeline: result.timeline })
  }
  const tones = useMemo(() => {
    if (!tracker) return new Map<string, OptionColor>()
    const tones = rowTones(
      rows,
      columns,
      settleTimelineFields(columns, tracker.timeline?.fields || null),
      statusColors,
      todayNumber(),
    )
    const byRule = ruleTones(rules, rows, columns, lookup, props.today)
    for (const row of rows) {
      const tone = byRule.get(row.id)
      if (tone && !row.highlight) tones.set(row.id, tone)
    }
    return tones
  }, [rows, columns, tracker, statusColors, rules, lookup, props.today])
  // ---- columns that came over from the Sheet: offer a subtask per column under each row's task ----
  const newColumnsKey = `ba.tracker.newColumns.${props.trackerId}`
  const [newColumnIds, setNewColumnIds] = useState<string[]>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(newColumnsKey) || '{}')
      return Array.isArray(saved?.ids) ? saved.ids.map(String) : []
    } catch {
      return []
    }
  })
  const [columnSubtasksOpen, setColumnSubtasksOpen] = useState(false)
  const keepNewColumns = (ids: string[], seen?: string) => {
    setNewColumnIds(ids)
    try {
      const saved = JSON.parse(localStorage.getItem(newColumnsKey) || '{}')
      localStorage.setItem(newColumnsKey, JSON.stringify({ ids, seen: seen ?? saved?.seen ?? '' }))
    } catch {
      /* not remembered */
    }
  }
  const lastReport = tracker?.source?.lastReport
  const lastSyncedAt = tracker?.source?.lastSyncedAt || ''
  // Once per sync that added columns.
  useEffect(() => {
    if (!lastReport?.addedColumns?.length || !lastSyncedAt) return
    let seen = ''
    try {
      seen = JSON.parse(localStorage.getItem(newColumnsKey) || '{}')?.seen || ''
    } catch {
      /* nothing seen */
    }
    if (seen === lastSyncedAt) return
    const names = new Set(lastReport.addedColumns.map(name => name.toLowerCase()))
    const ids = columns.filter(column => names.has(column.name.toLowerCase())).map(column => column.id)
    keepNewColumns([...new Set([...newColumnIds, ...ids])], lastSyncedAt)
  }, [lastSyncedAt, lastReport, columns])
  const newColumns = columns.filter(column => newColumnIds.includes(column.id))
  const highlightButton = useRef<HTMLButtonElement>(null)
  const [highlightOpen, setHighlightOpen] = useState(false)
  const highlight = async (ids: string[], color: string) => {
    if (!canEdit || !ids.length) return
    const before = new Map<string, string | undefined>(
      rowsRef.current.filter(row => ids.includes(row.id)).map(row => [row.id, row.highlight]),
    )
    const paint = (pick: (id: string) => string | undefined) =>
      setRows(
        rowsRef.current.map(row => {
          if (!before.has(row.id)) return row
          const next = pick(row.id)
          const { highlight: _old, ...rest } = row
          return next ? { ...rest, highlight: next as TrackerRow['highlight'] } : rest
        }),
      )
    paint(() => color || undefined)
    try {
      await trackerApi.highlightRows(props.trackerId, ids, color)
    } catch (error) {
      if (alive.current) paint(id => before.get(id))
      say('error', error instanceof Error ? error.message : 'The rows could not be highlighted.')
    }
  }
  const linkTask = (row: TrackerRow, taskId: string | null) => {
    if (!canEdit) return
    setRows(rowsRef.current.map(item => (item.id === row.id ? { ...item, taskId: taskId || '' } : item)))
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
    for (const link of links)
      if (link.columnId) {
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
  const workTools: WorkTools = useMemo(
    () => ({
      items: props.items,
      clients: props.clients,
      projects: props.projects,
      isClosed: props.isTaskClosed,
      onCreate: canEdit ? props.onCreateTasks : undefined,
      onOpenTask: props.onOpenTask,
    }),
    [props.items, props.clients, props.projects, props.isTaskClosed, props.onCreateTasks, props.onOpenTask, canEdit],
  )
  const linkRowTasks = async (pairs: { rowId: string; taskId: string }[]) => {
    // Rows switching to another task (Before Seeds → Seeds) let go of the old task's subtasks in their cells.
    const switched = pairs.filter(pair => {
      const before = rowsRef.current.find(row => row.id === pair.rowId)?.taskId
      return before && before !== pair.taskId
    })
    const stale = linksRef.current.filter(link =>
      switched.some(
        pair =>
          link.rowId === pair.rowId &&
          link.columnId &&
          itemsRef.current.find(item => item.id === link.taskId)?.parentTaskId !== pair.taskId,
      ),
    )
    for (const link of stale) await removeLink(link)
    if (stale.length) linksRef.current = linksRef.current.filter(link => !stale.includes(link))
    for (let at = 0; at < pairs.length; at += TRACKER_LIMITS.importBatch) {
      const result = await trackerApi.linkRowTasks(trackerId, pairs.slice(at, at + TRACKER_LIMITS.importBatch))
      const byId = new Map(result.rows.map(row => [row.id, row]))
      setRows(rowsRef.current.map(row => byId.get(row.id) || row))
    }
    say('info', `${plural(pairs.length, 'task')} created and linked.`)
    // Site rollout: every row given a task here gets its step subtasks (not only rows that switched).
    if (pairs.length && stepTasks) makeStepTasks(pairs.map(pair => pair.rowId))
  }
  const removeLink = async (link: TaskLink) => {
    if (!canEdit) return
    await trackerApi.removeLink(trackerId, link.id)
    setLinks(current => current.filter(item => item.id !== link.id))
  }
  // The totals row summarizes the rows shown (after search and filters), like a SUM over a filtered range.
  const totals = useMemo(() => {
    const shownRows = entries.flatMap(entry => (entry.kind === 'row' ? [entry.row] : []))
    // Shown when a column has a total, or (for people who can set one) whenever there are rows to total.
    if (!shownColumns.some(column => column.total) && !(canEdit && shownRows.length)) return undefined
    const map = new Map<string, TotalShown>()
    for (const column of shownColumns) {
      const kind = column.total && totalKindsFor(column).includes(column.total) ? column.total : undefined
      if (kind)
        map.set(
          column.id,
          totalOf(column, kind, shownRows, columns, row => shown(column, row as TrackerRow, lookup).text),
        )
    }
    return map
  }, [shownColumns, entries, columns, lookup, canEdit])
  const progress = useMemo(() => progressOf(columns, rows), [columns, rows])
  // How many comments each row has, shown beside the row number. Loaded once; kept up to date as comments are added.
  const [commentCounts, setCommentCounts] = useState<Record<string, number>>({})
  useEffect(() => {
    const controller = new AbortController()
    setCommentCounts({})
    trackerApi
      .commentCounts(trackerId, controller.signal)
      .then(result => setCommentCounts(result.counts || {}))
      .catch(() => undefined)
    return () => controller.abort()
  }, [trackerId])
  const totalAnchor = useRef<HTMLElement | null>(null)
  const [totalFor, setTotalFor] = useState('')
  const setTotal = async (column: TrackerColumn, kind: TotalKind | null) => {
    setTotalFor('')
    try {
      await applyColumns(
        columns.map(item => {
          if (item.id !== column.id) return item
          const { total: _old, ...rest } = item
          return kind ? { ...rest, total: kind } : rest
        }),
      )
    } catch (error) {
      say('error', error instanceof Error ? error.message : 'The total could not be saved.')
    }
  }
  // ---- bulk edit: one value for every selected row ----
  const [bulkSetOpen, setBulkSetOpen] = useState(false)
  const bulkSetButton = useRef<HTMLButtonElement>(null)
  const applyBulk = (column: TrackerColumn, value: Cell, plan: BulkPlan) => {
    setBulkSetOpen(false)
    const before = bulkUndo(plan, column)
    for (const row of plan.change) editCell(row, column, value)
    setNotice({
      kind: 'info',
      text: `${column.name} set for ${plural(plan.change.length, 'row')}${plan.locked.length ? `; ${plural(plan.locked.length, 'row')} skipped (from the Google Sheet)` : ''}.`,
      undo: () => {
        for (const item of before) {
          const row = rowsRef.current.find(current => current.id === item.rowId)
          if (row) editCell(row, column, item.value)
        }
      },
    })
  }
  const linkMap = useMemo(() => {
    const map = new Map<string, { count: number; cells: Set<string> }>()
    for (const link of links) {
      const entry = map.get(link.rowId) || { count: 0, cells: new Set<string>() }
      entry.count += 1
      if (link.columnId) entry.cells.add(link.columnId)
      map.set(link.rowId, entry)
    }
    return map
  }, [links])
  const setSecret = (row: TrackerRow, column: TrackerColumn, value: string | null) => {
    if (!canEdit) return
    patchRow(row.id, { secrets: { [column.id]: value } })
  }
  const reveal = async (row: TrackerRow, column: TrackerColumn) => {
    try {
      return (await trackerApi.reveal(trackerId, row.id, column.id)).value
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : 'Could not reveal this value.')
    }
  }

  /** Adds a row. With cells (a calendar day, say), the row opens so it can be named. */
  const addRow = async (cells?: Record<string, Cell>) => {
    if (!canEdit || !tracker) return
    if (rowsRef.current.length >= TRACKER_LIMITS.rows)
      return say('error', `A tracker can have at most ${TRACKER_LIMITS.rows.toLocaleString('en')} rows.`)
    try {
      const { rows: created, warning, automation } = await trackerApi.addRows(trackerId, [cells ? { cells } : {}])
      if (!alive.current) return
      if (warning) say('error', warning)
      else if (automation) tellAutomation(automation)
      setRows([...rowsRef.current, ...created])
      setTracker({ ...trackerRef.current!, rowCount: trackerRef.current!.rowCount + created.length })
      props.onListChanged()
      const hiddenByFilters = work.filters.length > 0 || work.search.trim() !== ''
      const stillShown =
        visibleRows(
          created,
          columns,
          { search: work.search, filters: work.filters, sort: null, hidden: work.hidden },
          lookup,
        ).length > 0
      if (cells) setDrawerId(created[0].id)
      else if (hiddenByFilters && !stillShown)
        say('info', 'Row added. It is hidden by the current filters or search, so clear them to see it.')
      else setFocus({ rowId: created[0].id, columnId: shownColumns[0].id, edit: true, nonce: ++focusNonce.current })
    } catch (error) {
      say('error', error instanceof Error ? error.message : 'The row could not be added.')
    }
  }

  const removeRows = async (ids: string[]) => {
    if (!canEdit || !ids.length) return
    if (!window.confirm(`Delete ${plural(ids.length, 'row')}? This cannot be undone.`)) return
    try {
      for (let at = 0; at < ids.length; at += TRACKER_LIMITS.importBatch)
        await trackerApi.deleteRows(trackerId, ids.slice(at, at + TRACKER_LIMITS.importBatch))
      if (!alive.current) return
      const gone = new Set(ids)
      setRows(rowsRef.current.filter(row => !gone.has(row.id)))
      setTracker({ ...trackerRef.current!, rowCount: Math.max(0, trackerRef.current!.rowCount - ids.length) })
      setSelected(new Set())
      if (gone.has(drawerId)) setDrawerId('')
      props.onListChanged()
      say('info', `${plural(ids.length, 'row')} deleted.`)
    } catch (error) {
      say('error', error instanceof Error ? error.message : 'The rows could not be deleted.')
      void refresh().catch(() => undefined)
    }
  }

  // ---- columns ----
  const applyColumns = async (next: TrackerColumn[]) => {
    const current = trackerRef.current!
    try {
      const result = await trackerApi.saveColumns(trackerId, next, current.revision)
      // The column list comes back without the Sheet connection; keep the one already loaded.
      if (alive.current) setTracker({ ...result.tracker, source: result.tracker.source ?? current.source })
    } catch (error) {
      if (error instanceof TrackerApiError && error.body.tracker && alive.current) {
        setTracker(error.body.tracker)
        throw new Error('Someone else changed this tracker’s columns. It was reloaded; review it and try again.')
      }
      throw error
    }
  }
  const saveColumn = async (draft: ColumnDraft, existing?: TrackerColumn) => {
    const extra = (column: TrackerColumn): TrackerColumn => {
      const copy: TrackerColumn = { ...column }
      if (draft.formula !== undefined) copy.formula = draft.formula
      if (draft.total === null) delete copy.total
      else if (draft.total) copy.total = draft.total
      if (draft.autoDone === null) delete copy.autoDone
      else if (draft.autoDone) copy.autoDone = draft.autoDone
      if (draft.contract === true) copy.taskField = 'contract'
      else if (draft.contract === false && copy.taskField === 'contract') delete copy.taskField
      return copy
    }
    // Only one column marks rows done (or shows the contract): turning it on here turns it off elsewhere.
    const others = (column: TrackerColumn): TrackerColumn => {
      let result = column
      if (draft.autoDone && result.autoDone) {
        const { autoDone: _off, ...rest } = result
        result = rest
      }
      if (draft.contract === true && result.taskField === 'contract') {
        const { taskField: _field, ...rest } = result
        result = rest
      }
      return result
    }
    const next: TrackerColumn[] = existing
      ? columns.map(column =>
          column.id === existing.id
            ? extra({
                ...column,
                name: draft.name,
                ...(draft.options ? { options: draft.options } : {}),
                ...(draft.revealBy ? { revealBy: draft.revealBy } : {}),
              })
            : others(column),
        )
      : [
          ...columns.map(others),
          extra({
            id: randomId('c_'),
            name: draft.name,
            type: draft.type,
            ...(draft.options ? { options: draft.options } : {}),
            ...(draft.revealBy ? { revealBy: draft.revealBy } : {}),
          }),
        ]
    await applyColumns(next)
  }
  const deleteColumn = async (column: TrackerColumn) => {
    await applyColumns(columns.filter(item => item.id !== column.id))
    if (column.type === 'secret') void refresh().catch(() => undefined)
  }
  const moveColumn = async (column: TrackerColumn, direction: -1 | 1) => {
    const at = columns.findIndex(item => item.id === column.id),
      to = at + direction
    if (at < 0 || to < 0 || to >= columns.length) return
    const next = [...columns]
    ;[next[at], next[to]] = [next[to], next[at]]
    try {
      await applyColumns(next)
    } catch (error) {
      say('error', error instanceof Error ? error.message : 'The column could not be moved.')
    }
  }

  /** Changes how one column looks (frozen, aligned, wider). It is saved with the tracker, so everyone sees it. */
  const styleColumn = async (
    column: TrackerColumn,
    patch: Partial<Pick<TrackerColumn, 'frozen' | 'align' | 'width'>>,
  ) => {
    const next = columns.map(item => {
      if (item.id !== column.id) return item
      const copy: TrackerColumn = { ...item, ...patch }
      if (patch.width === undefined && 'width' in patch) delete copy.width
      return copy
    })
    const widthNow = (item: TrackerColumn) =>
      item.id === column.id && patch.width !== undefined ? patch.width : widthOf(item, item.id === columns[0]?.id)
    if (patch.frozen === true || patch.width !== undefined) {
      const used = next
        .filter(item => isFrozenColumn(item, next))
        .reduce((sum, item) => sum + widthNow(item), NUMBER_COLUMN_WIDTH)
      if (used > 700 && (patch.frozen === true || isFrozenColumn(column, columns))) {
        say(
          'error',
          'The frozen columns would take up too much of the screen. Make them narrower, or unfreeze one first.',
        )
        return
      }
    }
    try {
      await applyColumns(next)
    } catch (error) {
      say('error', error instanceof Error ? error.message : 'The column could not be changed.')
    }
  }

  // ---- views ----
  const applyView = (view?: TrackerView) => {
    setActiveViewId(view?.id || '')
    setWork(current => ({ ...current, ...stripWork(view ? { ...emptyWork, ...view } : emptyWork) }))
  }
  const saveViews = async (views: TrackerView[]) => {
    const current = trackerRef.current!
    try {
      const result = await trackerApi.saveViews(trackerId, views, current.revision)
      if (alive.current) setTracker(result.tracker)
      return result.tracker
    } catch (error) {
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
    setSaveViewOpen(false)
    setViewName('')
    const created = saved.views.find(view => view.name.toLowerCase() === name.toLowerCase())
    if (created) setActiveViewId(created.id)
  }
  const updateView = async () => {
    if (!activeView || !tracker) return
    const saved = await saveViews(
      tracker.views.map(view => (view.id === activeView.id ? { ...view, ...stripWork(work) } : view)),
    )
    if (saved) say('info', `View “${activeView.name}” updated.`)
  }
  const deleteView = async (view: TrackerView) => {
    if (!tracker || !window.confirm(`Delete the view “${view.name}”? The rows are not affected.`)) return
    const saved = await saveViews(tracker.views.filter(item => item.id !== view.id))
    if (saved && view.id === activeViewId) applyView(undefined)
  }

  // ---- tracker-level actions ----
  const patchTracker = async (body: Parameters<typeof trackerApi.update>[1], done?: string) => {
    try {
      const result = await trackerApi.update(trackerId, body)
      if (alive.current) {
        setTracker(result.tracker)
        props.onListChanged()
        if (done) say('info', done)
      }
      return true
    } catch (error) {
      say('error', error instanceof Error ? error.message : 'The tracker could not be updated.')
      return false
    }
  }
  const archive = async () => {
    if (
      !window.confirm(
        'Archive this tracker? It becomes read-only and moves out of the main list. You can restore it later.',
      )
    )
      return
    await patchTracker({ archived: true }, 'Tracker archived.')
  }
  const destroy = async () => {
    if (
      !window.confirm(
        `Permanently delete “${tracker?.name}” and all ${plural(tracker?.rowCount || 0, 'row')} in it? This cannot be undone.`,
      )
    )
      return
    try {
      await trackerApi.remove(trackerId)
      props.onListChanged()
      props.onBack()
    } catch (error) {
      say('error', error instanceof Error ? error.message : 'The tracker could not be deleted.')
    }
  }
  const download = () => {
    if (!tracker) return
    const body = exportCsv(shownColumns, visible, lookup)
    const url = URL.createObjectURL(new Blob([body], { type: 'text/csv;charset=utf-8' }))
    const link = document.createElement('a')
    link.href = url
    link.download = exportFileName(tracker.name, props.today)
    document.body.appendChild(link)
    link.click()
    link.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
    say('info', `Exported ${plural(visible.length, 'row')} as you see them. Secret columns are never exported.`)
  }

  if (status === 'loading')
    return (
      <div className="trk-page">
        <TrackerLoading label="Loading tracker…" rows={8} />
      </div>
    )
  if (status === 'error' || !tracker)
    return (
      <div className="trk-page">
        <button type="button" className="trk-text-button" onClick={props.onBack}>
          <ArrowLeft size={14} aria-hidden="true" /> Trackers
        </button>
        <Notice kind="error">{loadError || 'The tracker could not be loaded.'}</Notice>
      </div>
    )

  const editingColumn =
    columnDialog?.mode === 'edit' ? columns.find(column => column.id === columnDialog.id) : undefined
  const savingText = saving > 0 ? 'Saving…' : 'All changes saved'
  const filtered = work.filters.length > 0 || work.search.trim() !== ''
  const menuColumn = headerMenu ? columns.find(column => column.id === headerMenu.id) : undefined
  const menuIndex = menuColumn ? columns.findIndex(column => column.id === menuColumn.id) : -1

  return (
    <div className="trk-page trk-screen">
      <nav className="trk-crumbs" aria-label="Breadcrumb">
        <button type="button" className="trk-text-button" onClick={props.onBack}>
          <ArrowLeft size={14} aria-hidden="true" /> Trackers
        </button>
        <span aria-hidden="true">/</span>
        <span>{tracker.name}</span>
      </nav>
      <header className="trk-header">
        <div className="trk-title">
          <h2>{tracker.name}</h2>
          {(trackerClientIds(tracker).length > 0 || tracker.projectId) && (
            <span
              className="trk-chip"
              title={[
                trackerClientIds(tracker).map(clientName).join(', '),
                trackerProjectIds(tracker).map(projectName).filter(Boolean).join(', '),
              ]
                .filter(Boolean)
                .join(' · ')}
            >
              {[
                trackerClientIds(tracker).length > 2
                  ? `${clientName(trackerClientIds(tracker)[0])} +${trackerClientIds(tracker).length - 1} clients`
                  : trackerClientIds(tracker).map(clientName).join(', '),
                trackerProjectIds(tracker).length > 1
                  ? `${projectName(tracker.projectId)} +${trackerProjectIds(tracker).length - 1} projects`
                  : projectName(tracker.projectId),
              ]
                .filter(Boolean)
                .join(' · ')}
            </span>
          )}
          {tracker.private && (
            <span className="trk-chip">
              <Lock size={12} aria-hidden="true" /> Only you
            </span>
          )}
          {tracker.archived && <span className="trk-chip warn">Archived</span>}
          {stepTasks && (
            <span
              className="trk-chip"
              title="Each row with a name becomes a task, and each Checkbox column a subtask of it. Ticking a box completes its subtask."
            >
              Rows → tasks · checkboxes → subtasks
            </span>
          )}
        </div>
        <div className="trk-header-actions">
          {canEdit && !tracker.source && (
            <button
              type="button"
              className="trk-button"
              disabled={creatingSheet}
              onClick={() => void createSheet()}
              title="Make a new Google Sheet from this tracker, in your Google Drive, and keep the two in sync both ways"
              aria-label="Create a Google Sheet from this tracker"
            >
              <Table2 size={14} aria-hidden="true" />
              <span className="trk-label">{creatingSheet ? 'Making Sheet…' : 'Create Google Sheet'}</span>
            </button>
          )}
          {canEdit && (
            <button
              type="button"
              className="trk-button"
              onClick={() => setImporting(true)}
              title="Import a sheet"
              aria-label="Import a sheet"
            >
              <Upload size={14} aria-hidden="true" />
              <span className="trk-label">Import</span>
            </button>
          )}
          <button
            type="button"
            className="trk-button"
            onClick={download}
            title="Export CSV: the rows and columns you see now"
            aria-label="Export CSV"
          >
            <Download size={14} aria-hidden="true" />
            <span className="trk-label">Export CSV</span>
          </button>
          <button
            type="button"
            className="trk-button"
            aria-pressed={expanded}
            onClick={toggleExpanded}
            title={
              expanded
                ? 'Exit full view: show the page header again'
                : 'Full view: hide the page header to give the grid the whole screen'
            }
            aria-label={expanded ? 'Exit full view' : 'Full view'}
          >
            {expanded ? <Minimize2 size={14} aria-hidden="true" /> : <Maximize2 size={14} aria-hidden="true" />}
            <span className="trk-label">{expanded ? 'Exit full view' : 'Full view'}</span>
          </button>
          <button
            type="button"
            className="trk-button"
            ref={moreButton}
            aria-haspopup="menu"
            aria-expanded={moreOpen}
            aria-label="More"
            title="More options"
            onClick={() => setMoreOpen(open => !open)}
          >
            <span className="trk-label">More</span>
            <ChevronDown size={14} aria-hidden="true" />
          </button>
        </div>
      </header>
      {moreOpen && (
        <Popover
          anchor={moreButton}
          onClose={() => setMoreOpen(false)}
          className="trk-menu"
          label="Tracker options"
          minWidth={240}
        >
          <div role="menu">
            {tracker.canEdit && !tracker.archived && (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMoreOpen(false)
                  setDetails(true)
                }}
              >
                Rename, client and project…
              </button>
            )}
            {tracker.canEdit && !tracker.archived && (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMoreOpen(false)
                  void patchTracker(
                    { stepTasks: !stepTasks },
                    stepTasks
                      ? 'Rows no longer become tasks here. Tasks already made stay in Tasks.'
                      : 'Each row with a name now becomes a task, with a subtask for each Checkbox column.',
                  )
                }}
              >
                {stepTasks ? 'Stop making tasks for rows' : 'Make each row a task, checkboxes subtasks'}
              </button>
            )}
            {canEdit && !tracker.archived && (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMoreOpen(false)
                  setSavingTemplate(true)
                }}
              >
                Save as template…
              </button>
            )}
            {tracker.canManage && !tracker.archived && (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMoreOpen(false)
                  void patchTracker(
                    { private: !tracker.private },
                    tracker.private
                      ? 'Everyone in the account can now see this tracker.'
                      : 'Only you can see this tracker now.',
                  )
                }}
              >
                {tracker.private ? 'Share with the account' : 'Make private (only me)'}
              </button>
            )}
            {tracker.canManage && !tracker.archived && (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMoreOpen(false)
                  void archive()
                }}
              >
                Archive tracker
              </button>
            )}
            {tracker.canManage && tracker.archived && (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMoreOpen(false)
                  void patchTracker({ archived: false }, 'Tracker restored.')
                }}
              >
                Restore tracker
              </button>
            )}
            {tracker.canManage && tracker.archived && (
              <button
                type="button"
                role="menuitem"
                className="danger"
                onClick={() => {
                  setMoreOpen(false)
                  void destroy()
                }}
              >
                Delete permanently…
              </button>
            )}
            {tracker.source && canEdit && (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMoreOpen(false)
                  void stopSyncing()
                }}
              >
                Stop syncing with the Sheet…
              </button>
            )}
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setMoreOpen(false)
                void refresh()
                  .then(() => say('info', 'Up to date.'))
                  .catch(error => say('error', error instanceof Error ? error.message : 'Could not refresh.'))
              }}
            >
              Refresh now
            </button>
          </div>
        </Popover>
      )}

      {tracker.archived && (
        <div className="trk-banner">
          <AlertTriangle size={15} aria-hidden="true" /> This tracker is archived and read-only.
          {tracker.canManage && (
            <button
              type="button"
              className="trk-text-button strong"
              onClick={() => void patchTracker({ archived: false }, 'Tracker restored.')}
            >
              <RotateCcw size={13} aria-hidden="true" /> Restore
            </button>
          )}
        </div>
      )}
      {!tracker.canEdit && !tracker.archived && (
        <div className="trk-banner">Your role can view this tracker but not change it.</div>
      )}
      {tracker.source && (
        <div className={`trk-source-bar${tracker.source.lastStatus === 'error' ? ' error' : ''}`} role="status">
          <span className="trk-source-name">
            Synced from{' '}
            <a
              href={`https://docs.google.com/spreadsheets/d/${tracker.source.spreadsheetId}/edit`}
              target="_blank"
              rel="noopener noreferrer"
            >
              {tracker.source.spreadsheetName || 'Google Sheet'} › {tracker.source.tab}
            </a>
          </span>
          <span className="trk-muted">
            {tracker.source.excel
              ? 'Excel file → tracker (read only)'
              : tracker.source.mode === 'two_way'
                ? 'Sheet ⇄ tracker (two-way)'
                : 'Sheet → tracker'}{' '}
            · connected by {tracker.source.connectedByName || 'someone'}
            {tracker.source.lastSyncedAt ? ` · synced ${niceTime(tracker.source.lastSyncedAt)}` : ' · not synced yet'}
            {tracker.source.lastReport && tracker.source.lastStatus === 'ok'
              ? ` · ${describeSync(tracker.source.lastReport)}`
              : ''}
          </span>
          {tracker.source.lastStatus === 'error' && (
            <span className="trk-source-error">{tracker.source.lastError}</span>
          )}
          {tracker.source.lastReport?.newHeaders?.length ? (
            <span className="trk-muted" title={tracker.source.lastReport.newHeaders.join(', ')}>
              {plural(tracker.source.lastReport.newHeaders.length, 'Sheet column')} not followed
            </span>
          ) : null}
          <span className="trk-spacer" />
          {canEdit &&
            !tracker.source.excel &&
            sheetHasGantt(tracker.template) &&
            columns.some(column => column.type === 'date' && column.synced) && (
              <button
                type="button"
                className="trk-button"
                disabled={ganttBusy}
                onClick={() => void addGantt()}
                title="Add a Gantt chart tab to the Google Sheet, drawn from the synced tab (an existing one is drawn again)"
              >
                <CalendarRange size={14} aria-hidden="true" /> {ganttBusy ? 'Adding chart…' : 'Gantt chart in Sheet'}
              </button>
            )}
          {canEdit && tracker.source.lastStatus === 'error' && (
            <button
              type="button"
              className="trk-button"
              disabled={syncing}
              onClick={() => void reconnect()}
              title="Use your own Google account to read the Sheet"
            >
              Reconnect with my Google
            </button>
          )}
          {canEdit && !tracker.source.excel && (
            <button
              type="button"
              className="trk-button"
              disabled={modeBusy || syncing}
              aria-pressed={tracker.source.mode === 'two_way'}
              onClick={() => void switchMode(tracker.source?.mode === 'two_way' ? 'one_way' : 'two_way')}
              title={
                tracker.source.mode === 'two_way'
                  ? 'Stop writing tracker edits to the Google Sheet'
                  : 'Write edits to the green columns, and new rows, to the Google Sheet'
              }
            >
              {modeBusy ? 'Working…' : tracker.source.mode === 'two_way' ? 'Two-way: on' : 'Turn on two-way'}
            </button>
          )}
          {canEdit && (
            <button type="button" className="trk-button" disabled={syncing} onClick={() => void syncNow(true)}>
              {syncing ? 'Syncing…' : 'Sync now'}
            </button>
          )}
        </div>
      )}
      {canEdit && newColumns.length > 0 && (
        <div className="trk-banner trk-review-banner" role="status">
          <strong>
            {newColumns.length === 1 ? 'New column' : 'New columns'} from the Google Sheet:{' '}
            {newColumns.map(column => column.name).join(', ')}.
          </strong>{' '}
          {props.onCreateTasks
            ? 'Choose whether each row’s task gets a subtask for it.'
            : 'They are in the tracker now and follow the Sheet.'}
          {props.onCreateTasks && (
            <button type="button" className="trk-text-button strong" onClick={() => setColumnSubtasksOpen(true)}>
              Choose subtasks
            </button>
          )}
          <button type="button" className="trk-text-button" onClick={() => keepNewColumns([])}>
            Dismiss
          </button>
        </div>
      )}
      {columnSubtasksOpen && props.onCreateTasks && newColumns.length > 0 && (
        <TrackerColumnSubtasks
          columns={newColumns}
          rows={rows}
          items={props.items}
          links={links}
          rowTitle={row => rowTitle(columns, row)}
          onCreate={props.onCreateTasks}
          onLinks={async cellLinks => {
            if (cellLinks.length) await applyReview({ rowTasks: [], cellLinks, reviewed: [] })
          }}
          onDone={ids => keepNewColumns(newColumnIds.filter(id => !ids.includes(id)))}
          onClose={() => setColumnSubtasksOpen(false)}
        />
      )}
      {canEdit && sitesWithoutTask > 0 && props.onCreateTasks && (
        <div className="trk-banner trk-review-banner" role="status">
          <strong>
            {plural(sitesWithoutTask, 'site')} {sitesWithoutTask === 1 ? 'is' : 'are'} missing tasks or step subtasks.
          </strong>{' '}
          {trackerClientIds(tracker).length
            ? 'Each site gets a task, with a subtask for each step; ticking a step completes its subtask.'
            : 'Choose a client for this tracker first, so its tasks have a client.'}
          {trackerClientIds(tracker).length ? (
            <button type="button" className="trk-text-button strong" onClick={() => makeStepTasks(null)}>
              Make tasks
            </button>
          ) : (
            <button type="button" className="trk-text-button strong" onClick={() => setDetails(true)}>
              Choose a client
            </button>
          )}
        </div>
      )}
      {tracker.source &&
        canEdit &&
        !tracker.source.excel &&
        (twoWayNeedsWrite || (tracker.source.mode === 'two_way' && tracker.source.youCanWrite === false)) && (
          <div className="trk-banner trk-review-banner" role="status">
            <strong>
              {twoWayNeedsWrite && tracker.source.mode !== 'two_way'
                ? 'Two-way needs your permission first.'
                : 'Your edits to the green columns cannot reach the Sheet yet.'}
            </strong>{' '}
            Changes are written to the Sheet with your own Google account, so Google’s sharing decides what you may do.
            Your account has not yet let this app edit Google Sheets; Google asks once.
            <button
              type="button"
              className="trk-text-button strong"
              onClick={() =>
                void allowSheetEdits(twoWayNeedsWrite && tracker.source?.mode !== 'two_way' ? 'two_way' : 'edit')
              }
            >
              Allow editing with my Google
            </button>
          </div>
        )}
      {tracker.source &&
        !tracker.source.excel &&
        tracker.source.canWrite === false &&
        autoDoneColumn(columns)?.synced && (
          <div className="trk-banner trk-review-banner" role="status">
            <strong>Done marks may not reach the Sheet.</strong> They are written with the Google account of the person
            who completes the task, or else {tracker.source.connectedByName || 'the person who connected the Sheet'}’s,
            which has not allowed editing Google Sheets.
            <button type="button" className="trk-text-button strong" onClick={() => void allowSheetEdits('done')}>
              Allow editing with my Google
            </button>
          </div>
        )}
      {rows.some(row => row.sheetIssue) && (
        <div className="trk-banner trk-review-banner" role="status">
          <strong>{plural(rows.filter(row => row.sheetIssue).length, 'row')} not marked done in the Sheet.</strong>{' '}
          {(() => {
            const reasons = [...new Set(rows.flatMap(row => (row.sheetIssue ? [row.sheetIssue.message] : [])))]
            return reasons.length === 1 ? reasons[0] : 'Open a row to see why.'
          })()}
          {canEdit && (
            <>
              <button
                type="button"
                className="trk-text-button strong"
                disabled={syncing}
                onClick={() => void retrySheetIssues()}
                title="Sync, then write the done marks to the Sheet, overwriting what is there"
              >
                {syncing ? 'Working…' : 'Write them now'}
              </button>
              <button type="button" className="trk-text-button" onClick={() => void dismissSheetIssues()}>
                Dismiss
              </button>
            </>
          )}
        </div>
      )}
      {rows.some(row => row.review && !row.taskId) && !review && (
        <div className="trk-banner trk-review-banner">
          <strong>
            {plural(rows.filter(row => row.review && !row.taskId).length, 'new row')}
            {tracker.source ? ' from the Sheet' : ''}
          </strong>{' '}
          waiting for review: make them tasks, subtasks, or leave them as plain rows.
          {canEdit && (
            <button
              type="button"
              className="trk-text-button strong"
              onClick={() => setReview({ origin: tracker.source ? 'sheet' : 'import', ids: 'flagged' })}
            >
              Review
            </button>
          )}
        </div>
      )}
      {notice && (
        <Notice kind={notice.kind} onClose={() => setNotice(null)}>
          {notice.text}
          {notice.undo && (
            <button
              type="button"
              className="trk-text-button trk-undo"
              onClick={() => {
                notice.undo?.()
                setNotice(null)
              }}
            >
              Undo
            </button>
          )}
        </Notice>
      )}

      <div className="trk-views" role="group" aria-label="Saved views">
        <button
          type="button"
          className={`trk-view${activeViewId === '' ? ' on' : ''}`}
          aria-pressed={activeViewId === ''}
          onClick={() => applyView(undefined)}
        >
          All rows{activeViewId === '' ? ` · ${visible.length.toLocaleString('en')}` : ''}
        </button>
        {tracker.views.map(view => (
          <span key={view.id} className={`trk-view-wrap${activeViewId === view.id ? ' on' : ''}`}>
            <button
              type="button"
              className={`trk-view${activeViewId === view.id ? ' on' : ''}`}
              aria-pressed={activeViewId === view.id}
              onClick={() => applyView(view)}
            >
              {view.name}
              {activeViewId === view.id ? ` · ${visible.length.toLocaleString('en')}` : ''}
            </button>
            {tracker.canEdit && !tracker.archived && activeViewId === view.id && (
              <button
                type="button"
                className="trk-icon-button small"
                aria-label={`Delete the view ${view.name}`}
                onClick={() => void deleteView(view)}
              >
                <X size={13} />
              </button>
            )}
          </span>
        ))}
        {tracker.canEdit && !tracker.archived && dirty && activeView && (
          <button type="button" className="trk-view dashed" onClick={() => void updateView()}>
            Save changes to “{activeView.name}”
          </button>
        )}
        {tracker.canEdit && !tracker.archived && dirty && (
          <button
            type="button"
            className="trk-view dashed"
            ref={saveViewButton}
            aria-haspopup="dialog"
            onClick={() => setSaveViewOpen(open => !open)}
          >
            Save as view
          </button>
        )}
        {dirty && (
          <button type="button" className="trk-view plain" onClick={() => applyView(activeView)}>
            Reset
          </button>
        )}
      </div>
      {saveViewOpen && (
        <Popover
          anchor={saveViewButton}
          onClose={() => setSaveViewOpen(false)}
          className="trk-panel-pop"
          label="Save as a view"
          minWidth={300}
        >
          <form
            className="trk-pop-body"
            onSubmit={event => {
              event.preventDefault()
              void createView()
            }}
          >
            <label className="trk-field-block">
              View name
              <input
                autoFocus
                value={viewName}
                maxLength={TRACKER_LIMITS.viewName}
                onChange={event => setViewName(event.target.value)}
                placeholder="For example, Delayed sites"
              />
            </label>
            <p className="trk-muted-text">
              Saves the current filters, sort, grouping and visible columns for everyone who can open this tracker.
            </p>
            <div className="trk-pop-actions">
              <button type="submit" className="trk-button primary" disabled={!viewName.trim()}>
                Save view
              </button>
            </div>
          </form>
        </Popover>
      )}

      <div className="trk-toolbar">
        <label className="trk-search">
          <Search size={14} aria-hidden="true" />
          <input
            type="search"
            placeholder="Search this tracker"
            value={work.search}
            aria-label="Search this tracker"
            onChange={event => setWork({ ...work, search: event.target.value })}
          />
        </label>
        <TrackerToolbar
          columns={columns}
          work={work}
          people={people}
          open={panel}
          onOpen={setPanel}
          onChange={setWork}
        />
        <div className="trk-segmented" role="group" aria-label="Layout">
          <button
            type="button"
            className={layout === 'grid' ? 'on' : ''}
            aria-pressed={layout === 'grid'}
            onClick={() => setLayout('grid')}
          >
            <Table2 size={14} aria-hidden="true" /> Grid
          </button>
          <button
            type="button"
            className={layout === 'board' ? 'on' : ''}
            aria-pressed={layout === 'board'}
            onClick={() => setLayout('board')}
          >
            <Columns3 size={14} aria-hidden="true" /> Board
          </button>
          <button
            type="button"
            className={layout === 'calendar' ? 'on' : ''}
            aria-pressed={layout === 'calendar'}
            onClick={() => setLayout('calendar')}
          >
            <CalendarDays size={14} aria-hidden="true" /> Calendar
          </button>
          <button
            type="button"
            className={layout === 'timeline' ? 'on' : ''}
            aria-pressed={layout === 'timeline'}
            onClick={() => setLayout('timeline')}
          >
            <CalendarRange size={14} aria-hidden="true" /> Timeline
          </button>
        </div>
        <button
          type="button"
          className={`trk-button${statusColors ? ' on' : ''}`}
          aria-pressed={statusColors}
          onClick={toggleStatusColors}
          title="Tint rows by their state: done green, past their end red, under way blue. A highlight colour wins."
        >
          <Palette size={14} aria-hidden="true" /> Colour by status
        </button>
        {(canEdit || rules.length > 0) && (
          <button
            type="button"
            className={`trk-button${rules.some(rule => !rule.off) ? ' on' : ''}`}
            onClick={() => setRulesOpen(true)}
            disabled={!canEdit}
            title={
              canEdit
                ? 'Colour rows by their values, such as a date that has passed'
                : 'Rows are coloured by this tracker’s highlight rules'
            }
          >
            <Palette size={14} aria-hidden="true" /> Highlight rules{rules.length ? ` · ${rules.length}` : ''}
          </button>
        )}
        {(canEdit || reminders.length > 0) && (
          <button
            type="button"
            className={`trk-button${reminders.some(item => !item.off) ? ' on' : ''}`}
            onClick={() => setRemindersOpen(true)}
            disabled={!canEdit}
            title={
              canEdit
                ? 'Remind people before, on or after a row’s date'
                : reminders
                    .map(item =>
                      describeReminder(item, columns, id => people.find(person => person.id === id)?.name || ''),
                    )
                    .join('\n')
            }
          >
            <BellRing size={14} aria-hidden="true" /> Reminders{reminders.length ? ` · ${reminders.length}` : ''}
          </button>
        )}
        {canEdit && (
          <button
            type="button"
            className={`trk-button${automationList.some(item => !item.off) ? ' on' : ''}`}
            onClick={() => setAutomationsOpen(true)}
            title="When → then: let the tracker do the routine step after a row is saved"
          >
            <Zap size={14} aria-hidden="true" /> Automations{automationList.length ? ` · ${automationList.length}` : ''}
          </button>
        )}
        <span className="trk-spacer" />
        <span className="trk-save-state" role="status">
          <span className={`trk-dot${saving > 0 ? ' busy' : ''}`} aria-hidden="true" />
          {savingText}
        </span>
        {canEdit && (
          <button type="button" className="trk-button primary" onClick={() => void addRow()}>
            <Plus size={14} aria-hidden="true" /> Add row
          </button>
        )}
      </div>
      {layout === 'grid' && selected.size > 0 && (
        <div className="trk-selection" role="status">
          <strong>{plural(selected.size, 'row')} selected</strong>
          {canEdit && (
            <span className="trk-move-group" role="group" aria-label="Move the selected rows">
              <button
                type="button"
                className="trk-button"
                disabled={!orderable}
                onClick={() => void moveRows([...selected], 'start')}
                title={orderable ? 'Move to the top' : 'Clear the sort, grouping, search and filters to move rows'}
              >
                Top
              </button>
              <button
                type="button"
                className="trk-button"
                disabled={!orderable}
                onClick={() => void moveRows([...selected], stepTarget(-1))}
                title={orderable ? 'Move up one row' : 'Clear the sort, grouping, search and filters to move rows'}
                aria-label="Move up"
              >
                <ArrowUp size={14} aria-hidden="true" />
              </button>
              <button
                type="button"
                className="trk-button"
                disabled={!orderable}
                onClick={() => void moveRows([...selected], stepTarget(1))}
                title={orderable ? 'Move down one row' : 'Clear the sort, grouping, search and filters to move rows'}
                aria-label="Move down"
              >
                <ArrowDown size={14} aria-hidden="true" />
              </button>
              <button
                type="button"
                className="trk-button"
                disabled={!orderable}
                onClick={() => void moveRows([...selected], null)}
                title={orderable ? 'Move to the bottom' : 'Clear the sort, grouping, search and filters to move rows'}
              >
                Bottom
              </button>
            </span>
          )}
          {canEdit && bulkColumns(columns).length > 0 && (
            <button
              ref={bulkSetButton}
              type="button"
              className="trk-button primary"
              aria-expanded={bulkSetOpen}
              onClick={() => setBulkSetOpen(open => !open)}
              title="Set one column to the same value for every selected row"
            >
              Set value
            </button>
          )}
          {bulkSetOpen && canEdit && (
            <Popover
              anchor={bulkSetButton}
              onClose={() => setBulkSetOpen(false)}
              className="trk-panel-pop"
              minWidth={320}
            >
              <TrackerBulkSet
                rows={rows.filter(row => selected.has(row.id))}
                columns={columns}
                people={people}
                isLocked={cellLocked}
                onApply={applyBulk}
                onClose={() => setBulkSetOpen(false)}
              />
            </Popover>
          )}
          {canEdit && props.onCreateTasks && (
            <button
              type="button"
              className="trk-button"
              onClick={() => setBulkOpen(true)}
              title="Create a task for each selected row that has none"
            >
              Create tasks
            </button>
          )}
          {canEdit && (
            <button
              ref={highlightButton}
              type="button"
              className="trk-button"
              aria-expanded={highlightOpen}
              onClick={() => setHighlightOpen(open => !open)}
            >
              Highlight
            </button>
          )}
          {highlightOpen && canEdit && (
            <Popover anchor={highlightButton} onClose={() => setHighlightOpen(false)} className="trk-panel-pop">
              <p className="trk-muted-text">Colour for the {plural(selected.size, 'selected row')}:</p>
              <HighlightSwatches
                onPick={color => {
                  setHighlightOpen(false)
                  void highlight([...selected], color)
                }}
              />
            </Popover>
          )}
          {canEdit && (
            <button type="button" className="trk-button danger" onClick={() => void removeRows([...selected])}>
              Delete
            </button>
          )}
          <button type="button" className="trk-text-button" onClick={() => setSelected(new Set())}>
            Clear selection
          </button>
        </div>
      )}

      {layout === 'timeline' && (
        <section aria-label={`${tracker.name} timeline`}>
          <TrackerTimeline
            trackerId={tracker.id}
            columns={columns}
            rows={visible}
            people={people}
            groupBy={work.groupBy}
            onOpenRow={row => setDrawerId(row.id)}
            shared={tracker.timeline}
            onShare={
              canEdit && tracker.timeline
                ? async settings => {
                    // Shown at once; the saved copy comes back the same.
                    if (trackerRef.current) setTracker({ ...trackerRef.current, timeline: settings })
                    await trackerApi.saveTimeline(tracker.id, settings)
                  }
                : undefined
            }
            canDrag={row => canEditDates(row)}
            tones={tones}
            onDates={editCells}
          />
        </section>
      )}
      {layout === 'board' && (
        <section aria-label={`${tracker.name} board`}>
          <TrackerBoard
            trackerId={tracker.id}
            columns={columns}
            rows={visible}
            lookup={lookup}
            tones={tones}
            canEdit={canEdit}
            isLocked={cellLocked}
            onEdit={editCell}
            onOpenRow={row => setDrawerId(row.id)}
            commentCounts={commentCounts}
          />
        </section>
      )}
      {layout === 'calendar' && (
        <section aria-label={`${tracker.name} calendar`}>
          <TrackerCalendar
            trackerId={tracker.id}
            columns={columns}
            rows={visible}
            tones={tones}
            today={props.today}
            canEdit={canEdit}
            isLocked={cellLocked}
            onEdit={editCell}
            onOpenRow={row => setDrawerId(row.id)}
            onAdd={(column, day) => void addRow({ [column.id]: day })}
          />
        </section>
      )}
      <section className="trk-grid-panel" aria-label={`${tracker.name} rows`} hidden={layout !== 'grid'}>
        <TrackerGrid
          columns={shownColumns}
          frozen={frozenIds}
          primaryId={columns[0]?.id || ''}
          entries={entries}
          lookup={lookup}
          people={people}
          tones={tones}
          canEdit={canEdit}
          twoWay={tracker.source?.mode === 'two_way'}
          sort={work.sort}
          selected={selected}
          focus={focus}
          taskTitle={row => lookup.task(row.taskId)?.title || 'a deleted task'}
          links={linkMap}
          totals={totals}
          commentCounts={commentCounts}
          onPickTotal={
            canEdit
              ? (column, anchor) => {
                  totalAnchor.current = anchor
                  setTotalFor(column.id)
                }
              : undefined
          }
          onWork={(row, column, element) => {
            workAnchor.current = element
            setWorkCell({ rowId: row.id, columnId: column.id })
          }}
          cellWork={(row, column) => {
            if (column.id === columns[0]?.id) {
              const task = row.taskId ? lookup.task(row.taskId) : undefined
              return row.taskId
                ? {
                    title: task ? `Task: ${task.title} (${task.status})` : 'The linked task was deleted',
                    label: task ? task.status : 'Removed',
                    done: Boolean(task && props.isTaskClosed(task.status)),
                    task: true,
                  }
                : null
            }
            const link = cellLinks.get(row.id)?.get(column.id)
            if (!link) return null
            const sub = lookup.task(link.taskId)
            return {
              title: sub ? `Subtask: ${sub.title} (${sub.status})` : 'The linked subtask was deleted',
              label: sub ? (props.isTaskClosed(sub.status) ? 'Done' : sub.status) : 'Removed',
              done: Boolean(sub && props.isTaskClosed(sub.status)),
              task: false,
            }
          }}
          allColumns={columns}
          rowName={row => rowTitle(columns, row)}
          onEdit={editCell}
          onOpenRow={row => setDrawerId(row.id)}
          onInvalid={message => say('error', message)}
          onHeader={(column, button) => {
            headerAnchor.current = button
            setHeaderMenu(column)
          }}
          onAddColumn={canEdit ? () => setColumnDialog({ mode: 'add' }) : undefined}
          onMove={orderable ? (ids, before) => void moveRows(ids, before) : undefined}
          onResize={canEdit ? (column, width) => void styleColumn(column, { width: width ?? undefined }) : undefined}
          onToggleRow={(rowId, on) =>
            setSelected(current => {
              const next = new Set(current)
              if (on) next.add(rowId)
              else next.delete(rowId)
              return next
            })
          }
          onToggleAll={on =>
            setSelected(
              on ? new Set(entries.flatMap(entry => (entry.kind === 'row' ? [entry.row.id] : []))) : new Set(),
            )
          }
        />
        {rows.length === 0 && (
          <div className="trk-empty">
            <p>
              <strong>No rows yet.</strong>
            </p>
            <p className="trk-muted-text">
              {canEdit ? 'Add a row, or bring in a sheet you already keep.' : 'Nothing has been added to this tracker.'}
            </p>
            {canEdit && (
              <div className="trk-card-actions">
                <button type="button" className="trk-button primary" onClick={() => void addRow()}>
                  <Plus size={14} aria-hidden="true" /> Add row
                </button>
                <button type="button" className="trk-button" onClick={() => setImporting(true)}>
                  <Upload size={14} aria-hidden="true" /> Import a sheet
                </button>
              </div>
            )}
          </div>
        )}
        {rows.length > 0 && visible.length === 0 && (
          <div className="trk-empty">
            <p>
              <strong>No rows match.</strong>
            </p>
            <div className="trk-card-actions">
              <button
                type="button"
                className="trk-button"
                onClick={() => setWork({ ...work, search: '', filters: [] })}
              >
                Clear search and filters
              </button>
            </div>
          </div>
        )}
      </section>

      {totalFor &&
        (() => {
          const column = columns.find(item => item.id === totalFor)
          if (!column) return null
          return (
            <Popover anchor={totalAnchor} onClose={() => setTotalFor('')} className="trk-panel-pop" label="Total">
              <p className="trk-muted-text">Total for {column.name}, over the rows shown:</p>
              <div className="trk-total-kinds">
                {totalKindsFor(column).map(kind => (
                  <button
                    type="button"
                    key={kind}
                    className={`trk-button${column.total === kind ? ' primary' : ''}`}
                    aria-pressed={column.total === kind}
                    onClick={() => void setTotal(column, kind)}
                  >
                    {TOTAL_LABELS[kind]}
                  </button>
                ))}
                {column.total && (
                  <button type="button" className="trk-button" onClick={() => void setTotal(column, null)}>
                    None
                  </button>
                )}
              </div>
            </Popover>
          )
        })()}

      {automationsOpen && tracker && (
        <TrackerAutomationsDialog
          trackerId={tracker.id}
          columns={columns}
          people={people}
          automations={automationList}
          tasksByTemplate={keepsTasks(columns) || keepsStepTasks(tracker)}
          onSave={saveAutomations}
          onClose={() => setAutomationsOpen(false)}
        />
      )}
      {remindersOpen && tracker && (
        <TrackerRemindersDialog
          columns={columns}
          people={people}
          reminders={reminders}
          onSave={saveReminders}
          onClose={() => setRemindersOpen(false)}
        />
      )}
      {rulesOpen && tracker && (
        <TrackerHighlightRules
          columns={columns}
          people={people}
          rules={rules}
          onSave={saveRules}
          onClose={() => setRulesOpen(false)}
        />
      )}

      <footer className="trk-legend">
        <span>
          {filtered
            ? `Showing ${visible.length.toLocaleString('en')} of ${plural(rows.length, 'row')}`
            : plural(rows.length, 'row')}{' '}
          · {plural(columns.length, 'column')}
        </span>
        {progress && progress.total > 0 && (
          <span className="trk-progress" title={`Rows where ${progress.column.name} says done`}>
            <i aria-hidden="true">
              <b style={{ width: `${progress.percent}%` }} />
            </i>
            {progress.done} of {progress.total} done · {progress.percent}%
          </span>
        )}
        <span>
          <i className="trk-key connected" aria-hidden="true" /> Blue headers fill themselves from the linked task
        </span>
        <span>
          <i className="trk-key secret" aria-hidden="true" /> Amber headers are protected
        </span>
        {rules
          .filter(rule => !rule.off)
          .map(rule => (
            <span key={rule.id}>
              <i className={`trk-key trk-tone-${rule.color}`} aria-hidden="true" />{' '}
              {describeRule(rule, columns, id => people.find(person => person.id === id)?.name || '')}
            </span>
          ))}
        {columns.some(column => column.type === 'formula') && (
          <span>
            <i className="trk-key computed" aria-hidden="true" /> Purple headers are calculated
          </span>
        )}
        {tracker.source && (
          <span>
            <i className="trk-key synced" aria-hidden="true" />{' '}
            {tracker.source.mode === 'two_way'
              ? 'Green headers sync with the Google Sheet both ways'
              : 'Green headers come from the Google Sheet; change those cells there'}
          </span>
        )}
        {props.onCreateTasks && canEdit && (
          <span>Point at a cell: + Task in the first column, + for a subtask in the others</span>
        )}
      </footer>

      {menuColumn && (
        <Popover
          anchor={headerAnchor}
          onClose={() => setHeaderMenu(null)}
          className="trk-menu"
          label={`${menuColumn.name} options`}
          minWidth={230}
        >
          <div role="menu">
            {menuColumn.type !== 'secret' && (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setWork({ ...work, sort: { columnId: menuColumn.id, dir: 'asc' } })
                  setHeaderMenu(null)
                }}
              >
                Sort ascending
              </button>
            )}
            {menuColumn.type !== 'secret' && (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setWork({ ...work, sort: { columnId: menuColumn.id, dir: 'desc' } })
                  setHeaderMenu(null)
                }}
              >
                Sort descending
              </button>
            )}
            {work.sort?.columnId === menuColumn.id && (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setWork({ ...work, sort: null })
                  setHeaderMenu(null)
                }}
              >
                Clear sort
              </button>
            )}
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                if (work.filters.length < TRACKER_LIMITS.filtersPerView)
                  setWork({
                    ...work,
                    filters: [
                      ...work.filters,
                      { columnId: menuColumn.id, op: filterOpsFor(menuColumn.type)[0], value: '' },
                    ],
                  })
                setHeaderMenu(null)
                setPanel('filter')
              }}
            >
              Filter by this column
            </button>
            {menuColumn.type !== 'secret' && menuColumn.type !== 'longtext' && (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setWork({ ...work, groupBy: menuColumn.id })
                  setHeaderMenu(null)
                }}
              >
                Group by this column
              </button>
            )}
            {shownColumns.length > 1 && (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setWork({ ...work, hidden: [...work.hidden, menuColumn.id] })
                  setHeaderMenu(null)
                }}
              >
                Hide in this view
              </button>
            )}
            {canEdit && <hr />}
            {canEdit && (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setHeaderMenu(null)
                  void styleColumn(menuColumn, { frozen: !isFrozenColumn(menuColumn, columns) })
                }}
              >
                {isFrozenColumn(menuColumn, columns) ? 'Unfreeze column' : 'Freeze column'}
              </button>
            )}
            {canEdit && (
              <div className="trk-menu-label" id="trk-align-label">
                Align text
              </div>
            )}
            {canEdit && (
              <div className="trk-seg" role="group" aria-labelledby="trk-align-label">
                {(['left', 'center', 'right'] as ColumnAlign[]).map(side => (
                  <button
                    key={side}
                    type="button"
                    aria-pressed={
                      (menuColumn.align ||
                        (menuColumn.type === 'number'
                          ? 'right'
                          : menuColumn.type === 'checkbox'
                            ? 'center'
                            : 'left')) === side
                    }
                    onClick={() => {
                      setHeaderMenu(null)
                      void styleColumn(menuColumn, { align: side })
                    }}
                  >
                    {side[0].toUpperCase() + side.slice(1)}
                  </button>
                ))}
              </div>
            )}
            {canEdit && (
              <div className="trk-menu-label" id="trk-width-label">
                Width <small>(or drag the header edge)</small>
              </div>
            )}
            {canEdit && (
              <div className="trk-seg" role="group" aria-labelledby="trk-width-label">
                {(
                  [
                    ['Narrow', 120],
                    ['Standard', 0],
                    ['Wide', 360],
                    ['Extra wide', 560],
                  ] as const
                ).map(([label, width]) => {
                  const now = menuColumn.width || 0
                  return (
                    <button
                      key={label}
                      type="button"
                      aria-pressed={width === 0 ? now === 0 : now === width}
                      onClick={() => {
                        setHeaderMenu(null)
                        void styleColumn(menuColumn, { width: width || undefined })
                      }}
                    >
                      {label}
                    </button>
                  )
                })}
              </div>
            )}
            {canEdit && <hr />}
            {canEdit && (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setHeaderMenu(null)
                  setColumnDialog({ mode: 'edit', id: menuColumn.id })
                }}
              >
                Edit column…
              </button>
            )}
            {canEdit && menuIndex > 0 && (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setHeaderMenu(null)
                  void moveColumn(menuColumn, -1)
                }}
              >
                Move left
              </button>
            )}
            {canEdit && menuIndex < columns.length - 1 && (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setHeaderMenu(null)
                  void moveColumn(menuColumn, 1)
                }}
              >
                Move right
              </button>
            )}
          </div>
        </Popover>
      )}

      {workCell &&
        (() => {
          const row = rows.find(item => item.id === workCell.rowId),
            column = columns.find(item => item.id === workCell.columnId)
          if (!row || !column) return null
          const first = column.id === columns[0]?.id
          return (
            <TrackerWorkPicker
              key={`${row.id}:${column.id}`}
              anchor={workAnchor}
              tracker={tracker}
              row={row}
              column={column}
              mode={first ? 'task' : 'subtask'}
              rowTitle={rowTitle(columns, row)}
              current={cellLinks.get(row.id)?.get(column.id)?.taskId}
              tools={workTools}
              onClose={() => setWorkCell(null)}
              onPickTask={async taskId => {
                // Switching the row to another task (say, from a Before Seeds task to a Seeds one): its cells let go
                // of the old task's subtasks, which stay where they are, so the steps are made again under the new
                // task instead of one row pointing at two tasks.
                const stale =
                  taskId && row.taskId && row.taskId !== taskId
                    ? linksRef.current.filter(
                        link =>
                          link.rowId === row.id &&
                          link.columnId &&
                          itemsRef.current.find(item => item.id === link.taskId)?.parentTaskId !== taskId,
                      )
                    : []
                linkTask(row, taskId)
                for (const link of stale) await removeLink(link)
                if (stale.length) linksRef.current = linksRef.current.filter(link => !stale.includes(link))
                // A Site rollout row's task, however it was picked or made, gets a subtask for each step.
                if (taskId && stepTasks) makeStepTasks([row.id])
              }}
              onPickSubtask={taskId => setCellSubtask(row, column.id, taskId)}
              onSwitchToTask={() => setWorkCell({ rowId: row.id, columnId: columns[0].id })}
            />
          )
        })()}
      {review && (
        <TrackerReview
          tracker={tracker}
          lookup={lookup}
          tools={workTools}
          origin={review.origin}
          allRows={rows}
          rows={
            review.ids === 'flagged'
              ? rows.filter(row => row.review)
              : rows.filter(row => (review.ids as string[]).includes(row.id))
          }
          onClose={() => setReview(null)}
          onApply={applyReview}
          preset={review.preset}
        />
      )}
      {bulkOpen && (
        <TrackerBulkTasks
          tracker={tracker}
          rows={rows.filter(row => selected.has(row.id))}
          titleOf={row => rowTitle(columns, row)}
          tools={workTools}
          onClose={() => setBulkOpen(false)}
          onDone={linkRowTasks}
        />
      )}
      {drawerRow && (
        <TrackerRowPanel
          tracker={tracker}
          row={drawerRow}
          lookup={lookup}
          people={people}
          items={props.items}
          clientName={clientName}
          canEdit={canEdit}
          isAdmin={props.isAdmin}
          onClose={() => setDrawerId('')}
          onEdit={editCell}
          onSecret={setSecret}
          onLink={linkTask}
          links={links}
          onAddLink={addLink}
          onRemoveLink={removeLink}
          onDelete={row => void removeRows([row.id])}
          onOpenTask={props.onOpenTask}
          onReveal={reveal}
          onDismissSheetIssue={row => void dismissSheetIssues([row.id])}
          onHighlight={(row, color) => void highlight([row.id], color)}
          currentUserId={props.currentUserId}
          onCommentCount={(rowId, count) => setCommentCounts(current => ({ ...current, [rowId]: count }))}
        />
      )}

      {conflict && (
        <Dialog title="Changed in the Google Sheet" eyebrow="Two-way sync" onClose={() => setConflict(null)}>
          <div className="trk-config">
            <p>
              Since the last sync, someone changed {conflict.conflicts.length === 1 ? 'this cell' : 'these cells'} in
              the Sheet:
            </p>
            <ul className="trk-conflicts">
              {conflict.conflicts.map(item => (
                <li key={item.columnId}>
                  <strong>{item.name}</strong>: the Sheet has “{item.sheet || 'empty'}”, you entered “
                  {item.mine || 'empty'}”.
                </li>
              ))}
            </ul>
            <div className="k-dialog-actions">
              <span className="trk-spacer" />
              <button type="button" className="trk-button" onClick={() => void takeSheets()}>
                Use the Sheet’s
              </button>
              <button type="button" className="trk-button primary" onClick={keepMine}>
                Keep mine (update the Sheet)
              </button>
            </div>
          </div>
        </Dialog>
      )}
      {columnDialog && (columnDialog.mode === 'add' || editingColumn) && (
        <TrackerColumnDialog
          mode={columnDialog.mode}
          columns={columns}
          column={editingColumn}
          onClose={() => setColumnDialog(null)}
          onSave={draft => saveColumn(draft, editingColumn)}
          onDelete={
            // Deleting a Secret column erases every stored value: only for the tracker's owner or an Administrator.
            editingColumn && (editingColumn.type !== 'secret' || tracker.canManage)
              ? () => deleteColumn(editingColumn)
              : undefined
          }
          canManageSecrets={tracker.canManage}
          onConvert={
            editingColumn
              ? (type, confirm, clearUnfit) => convertColumn(editingColumn, type, confirm, clearUnfit)
              : undefined
          }
          sheetName={tracker.source ? tracker.source.spreadsheetName || 'the Google Sheet' : undefined}
        />
      )}
      {importing && (
        <TrackerImportDialog
          tracker={tracker}
          canLink={canEdit && !tracker.source}
          canCreateTasks={Boolean(props.onCreateTasks && canEdit)}
          onLinked={(matched, added, preset) => {
            setImporting(false)
            props.onListChanged()
            void refresh().then(() => {
              say(
                'info',
                `Linked to the Google Sheet: ${plural(matched, 'row')} matched, ${plural(added, 'row')} added.`,
              )
              if (preset && props.onCreateTasks && canEdit) setReview({ origin: 'sheet', ids: 'flagged', preset })
            })
          }}
          clients={props.clients}
          projects={props.projects}
          people={people}
          today={props.today}
          onClose={() => setImporting(false)}
          onDone={(_, imported, ids, preset) => {
            setImporting(false)
            props.onListChanged()
            void refresh()
              .then(() => {
                say('info', `${plural(imported, 'row')} imported.`)
                if (ids?.length && props.onCreateTasks && canEdit) setReview({ origin: 'import', ids, preset })
              })
              .catch(error =>
                say(
                  'error',
                  error instanceof Error ? error.message : 'Imported, but the tracker could not be refreshed.',
                ),
              )
          }}
        />
      )}
      {savingTemplate && (
        <SaveAsTemplateDialog
          tracker={tracker}
          isAdmin={props.isAdmin}
          onClose={() => setSavingTemplate(false)}
          onDone={message => {
            setSavingTemplate(false)
            say('info', message)
          }}
        />
      )}
      {details && (
        <TrackerDetailsDialog
          tracker={tracker}
          clients={props.clients}
          projects={props.projects}
          people={props.accounts
            .filter(account => account.status === 'Active')
            .map(account => ({ id: account.id, name: account.name || account.username }))}
          onClose={() => setDetails(false)}
          onSave={async body => {
            const result = await trackerApi.update(trackerId, body)
            setTracker(result.tracker)
            props.onListChanged()
          }}
        />
      )}
    </div>
  )
}
