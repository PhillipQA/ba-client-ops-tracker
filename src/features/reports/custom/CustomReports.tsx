// Custom reports: reports people build themselves, in folders. Each report is a page of widgets (number tiles,
// charts, tables, timelines) that are dragged into place. Reports are private until shared with the whole account.
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type FormEvent,
  type ReactNode,
} from 'react'
import {
  BarChart3,
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  FileText,
  Folder,
  FolderPlus,
  Heading,
  LineChart,
  Lock,
  MoreHorizontal,
  PieChart,
  Plus,
  Printer,
  Search,
  Settings2,
  Table2,
  Trash2,
  Type,
  Users,
  Hash,
  GanttChartSquare,
  BarChartHorizontal,
  Pencil,
} from 'lucide-react'
import { businessDateKey, useBusinessDate } from '../../../shared/businessDate'
import type {
  Client,
  PlannerActivity,
  Project,
  TaskSettings,
  UserAccount,
  WorkActivityEvent,
  WorkItem,
} from '../../../shared/types'
import { Dialog, Notice, Popover } from '../../../shared/ui'
import { loadAllRows, trackerApi } from '../../trackers/trackerApi'
import type { Tracker, TrackerRow } from '../../trackers/trackerModel'
import { conflictItem, needsUpgrade, reportApi } from './reportApi'
import {
  computeWidget,
  RANGE_LABELS,
  rangeDates,
  niceDate,
  SOURCES,
  sourceFields,
  sourceRecords,
  widgetCsv,
  type Field,
  type Rec,
  type ReportData,
} from './reportData'
import {
  emptyDefinition,
  freeSpot,
  newId,
  newWidget,
  placeWidget,
  RANGE_PRESETS,
  REPORT_TEMPLATES,
  WIDGET_LABELS,
  WIDGET_SIZES,
  type RangePreset,
  type ReportDefinition,
  type ReportFilters,
  type ReportItem,
  type SourceId,
  type Widget,
  type WidgetKind,
} from './reportModel'
import { ReportCanvas, WIDGET_TYPE } from './ReportCanvas'
import { WidgetBody } from './ReportWidgets'
import { WidgetEditor } from './WidgetEditor'
import './customReports.css'

const SELECTED_KEY = 'ba.reports.custom.selected'
const COLLAPSED_KEY = 'ba.reports.custom.collapsed'
const readStore = (key: string, fallback: string) => {
  try {
    return localStorage.getItem(key) ?? fallback
  } catch {
    return fallback
  }
}
const writeStore = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Private windows and full storage: the choice is simply not remembered.
  }
}

const PALETTE: { kind: WidgetKind; icon: ReactNode }[] = [
  { kind: 'metric', icon: <Hash size={16} /> },
  { kind: 'bar', icon: <BarChartHorizontal size={16} /> },
  { kind: 'column', icon: <BarChart3 size={16} /> },
  { kind: 'line', icon: <LineChart size={16} /> },
  { kind: 'pie', icon: <PieChart size={16} /> },
  { kind: 'table', icon: <Table2 size={16} /> },
  { kind: 'gantt', icon: <GanttChartSquare size={16} /> },
  { kind: 'heading', icon: <Heading size={16} /> },
  { kind: 'note', icon: <Type size={16} /> },
]

function downloadCsv(name: string, rows: string[][]) {
  const quote = (value: string) => `"${String(value ?? '').replace(/"/g, '""')}"`
  const blob = new Blob([rows.map(row => row.map(quote).join(',')).join('\n')], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `${name.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'report'}.csv`
  link.click()
  URL.revokeObjectURL(url)
}

/** Trackers for the "Tracker rows" source: the list, and each tracker's rows once a widget needs them. */
function useTrackerData(enabled: boolean) {
  const [list, setList] = useState<Tracker[] | null>(null)
  const [loaded, setLoaded] = useState<Record<string, { tracker: Tracker; rows: TrackerRow[] } | undefined>>({})
  const [failed, setFailed] = useState<Record<string, string>>({})
  const asked = useRef(new Set<string>())
  const loadList = useCallback(() => {
    if (!enabled || asked.current.has('__list')) return
    asked.current.add('__list')
    trackerApi
      .list()
      .then(result => setList(result.trackers.filter(tracker => !tracker.archived)))
      .catch(() => setList([]))
  }, [enabled])
  const ensure = useCallback(
    (id: string | undefined) => {
      if (!enabled || !id || asked.current.has(id)) return
      asked.current.add(id)
      Promise.all([trackerApi.get(id), loadAllRows(id)])
        .then(([result, rows]) => setLoaded(current => ({ ...current, [id]: { tracker: result.tracker, rows } })))
        .catch(error =>
          setFailed(current => ({ ...current, [id]: error?.message || 'This tracker could not be loaded.' })),
        )
    },
    [enabled],
  )
  return { list, loaded, failed, loadList, ensure }
}

type Props = {
  clients: Client[]
  projects: Project[]
  items: WorkItem[]
  planner: PlannerActivity[]
  taskSettings: TaskSettings
  accounts: UserAccount[]
  workEvents: WorkActivityEvent[]
  currentUser: UserAccount
  canUseTrackers: boolean
}

export default function CustomReports(props: Props) {
  const { currentUser, canUseTrackers } = props
  const today = useBusinessDate()
  const canChange = currentUser.role !== 'Viewer'
  const [items, setItems] = useState<ReportItem[] | null>(null)
  const [problem, setProblem] = useState<{ message: string; upgrade?: boolean } | null>(null)
  const [notice, setNotice] = useState('')
  const [selectedId, setSelectedId] = useState(() => readStore(SELECTED_KEY, ''))
  const [draft, setDraft] = useState<ReportDefinition | null>(null)
  const [viewFilters, setViewFilters] = useState<ReportFilters | null>(null)
  const [editingWidget, setEditingWidget] = useState<Widget | null>(null)
  const [selectedWidget, setSelectedWidget] = useState('')
  const [newKind, setNewKind] = useState<WidgetKind | null>(null)
  const [dialog, setDialog] = useState<
    | { kind: 'new-report' }
    | { kind: 'new-folder' }
    | { kind: 'rename'; item: ReportItem }
    | { kind: 'delete'; item: ReportItem }
    | null
  >(null)
  const [busy, setBusy] = useState(false)
  const [search, setSearch] = useState('')
  const [collapsed, setCollapsed] = useState<string[]>(() => readStore(COLLAPSED_KEY, '').split(',').filter(Boolean))
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const menuAnchor = useRef<HTMLButtonElement>(null)
  const trackers = useTrackerData(canUseTrackers)

  const load = useCallback(() => {
    const controller = new AbortController()
    reportApi
      .list(controller.signal)
      .then(result => {
        setItems(result.items)
        setProblem(null)
      })
      .catch(error => {
        if ((error as Error)?.name === 'AbortError') return
        setItems([])
        setProblem({ message: (error as Error).message, upgrade: needsUpgrade(error) })
      })
    return () => controller.abort()
  }, [])
  useEffect(load, [load])

  const folders = useMemo(() => (items || []).filter(item => item.kind === 'folder'), [items])
  const reports = useMemo(() => (items || []).filter(item => item.kind === 'report'), [items])
  const report = reports.find(item => item.id === selectedId) || null
  useEffect(() => {
    if (items && !report && reports.length) setSelectedId(reports[0].id)
  }, [items, report, reports])
  useEffect(() => writeStore(SELECTED_KEY, selectedId), [selectedId])
  const [shownId, setShownId] = useState(selectedId)
  if (shownId !== selectedId) {
    // Another report: its own saved filters, nothing selected.
    setShownId(selectedId)
    setViewFilters(null)
    setSelectedWidget('')
  }

  const editing = Boolean(draft && report)
  const definition = (editing ? draft : report?.definition) || emptyDefinition()
  const filters = editing ? definition.filters : viewFilters || definition.filters
  const dirty = editing && report && JSON.stringify(draft) !== JSON.stringify(report.definition)

  // Load the trackers this report's widgets read.
  useEffect(() => {
    for (const widget of definition.widgets) if (widget.source === 'tracker') trackers.ensure(widget.trackerId)
  }, [definition.widgets, trackers.ensure])

  const data: ReportData = useMemo(
    () => ({
      clients: props.clients,
      projects: props.projects,
      items: props.items,
      planner: props.planner,
      workEvents: props.workEvents,
      accounts: props.accounts,
      taskSettings: props.taskSettings,
      today,
      currentUser,
      trackers: trackers.loaded,
      dateOf: iso => businessDateKey(iso),
    }),
    [
      props.clients,
      props.projects,
      props.items,
      props.planner,
      props.workEvents,
      props.accounts,
      props.taskSettings,
      today,
      currentUser,
      trackers.loaded,
    ],
  )
  // Each source's records are worked out once per change of data, then shared by every widget that reads them.
  const recordsFor = useMemo(() => {
    const cache = new Map<string, Rec[]>()
    return (source: SourceId, trackerId = '') => {
      const key = `${source}:${source === 'tracker' ? trackerId : ''}`
      let records = cache.get(key)
      if (!records) {
        records = sourceRecords(source, data, trackerId)
        cache.set(key, records)
      }
      return records
    }
  }, [data])
  const fieldsFor = useMemo(() => {
    const cache = new Map<string, Field[]>()
    return (source: SourceId, trackerId?: string) => {
      const key = `${source}:${source === 'tracker' ? trackerId || '' : ''}`
      let fields = cache.get(key)
      if (!fields) {
        const tracker = trackerId
          ? trackers.loaded[trackerId]?.tracker || trackers.list?.find(item => item.id === trackerId)
          : undefined
        fields = sourceFields(source, tracker)
        cache.set(key, fields)
      }
      return fields
    }
  }, [trackers.loaded, trackers.list])

  // --- Changing reports ---

  const replace = (item: ReportItem) =>
    setItems(current => (current || []).map(existing => (existing.id === item.id ? item : existing)))
  const fail = (error: unknown) => {
    if (needsUpgrade(error)) setProblem({ message: (error as Error).message, upgrade: true })
    else setNotice((error as Error)?.message || 'That did not work. Try again.')
  }
  const update = async (item: ReportItem, patch: Parameters<typeof reportApi.update>[1]) => {
    setBusy(true)
    try {
      const result = await reportApi.update(item.id, patch)
      replace(result.item)
      return result.item
    } catch (error) {
      const theirs = conflictItem(error)
      if (theirs) {
        replace(theirs)
        setDraft(null)
      }
      fail(error)
      return null
    } finally {
      setBusy(false)
    }
  }
  const create = async (body: Parameters<typeof reportApi.create>[0]) => {
    setBusy(true)
    try {
      const result = await reportApi.create(body)
      setItems(current => [...(current || []), result.item])
      return result.item
    } catch (error) {
      fail(error)
      return null
    } finally {
      setBusy(false)
    }
  }
  const remove = async (item: ReportItem) => {
    setBusy(true)
    try {
      await reportApi.remove(item.id)
      setItems(current =>
        (current || [])
          .filter(existing => existing.id !== item.id)
          .map(existing => (existing.folderId === item.id ? { ...existing, folderId: '' } : existing)),
      )
      if (item.id === selectedId) {
        setDraft(null)
        setSelectedId('')
      }
      setDialog(null)
    } catch (error) {
      fail(error)
    } finally {
      setBusy(false)
    }
  }
  const save = async () => {
    if (!report || !draft) return
    const saved = await update(report, { definition: draft, revision: report.revision })
    if (saved) {
      setDraft(null)
      setNotice('')
    }
  }
  const copy = async (item: ReportItem) => {
    const made = await create({
      kind: 'report',
      name: `${item.name} (copy)`.slice(0, 120),
      description: item.description,
      folderId: folders.some(folder => folder.id === item.folderId && folder.canEdit) ? item.folderId : '',
      definition: item.definition,
    })
    if (made) setSelectedId(made.id)
  }
  const choose = (id: string) => {
    if (dirty && !window.confirm('Leave without saving your changes to this report?')) return
    setDraft(null)
    setSelectedId(id)
  }

  // --- Widgets while editing ---

  const setWidgets = (widgets: Widget[]) => setDraft(current => (current ? { ...current, widgets } : current))
  const addWidget = (kind: WidgetKind, at?: { x: number; y: number }) => {
    if (!draft) return
    const size = WIDGET_SIZES[kind]
    const spot = at || freeSpot(draft.widgets, size.w, size.h)
    const widget = newWidget(kind, spot)
    const placed = placeWidget([...draft.widgets, widget], widget.id, { ...spot, ...size })
    setWidgets(placed)
    setSelectedWidget(widget.id)
    setEditingWidget(widget)
  }
  const duplicateWidget = (widget: Widget) => {
    if (!draft) return
    const copyOf = { ...widget, id: newId(), y: widget.y + widget.h }
    setWidgets(placeWidget([...draft.widgets, copyOf], copyOf.id, copyOf))
  }

  // --- Printing: only the report is printed ---

  const print = () => {
    document.body.classList.add('crp-printing')
    const done = () => {
      document.body.classList.remove('crp-printing')
      window.removeEventListener('afterprint', done)
    }
    window.addEventListener('afterprint', done)
    window.print()
    setTimeout(done, 1000)
  }

  // --- The sidebar ---

  const term = search.trim().toLowerCase()
  const visibleReports = reports.filter(
    item => !term || item.name.toLowerCase().includes(term) || item.description.toLowerCase().includes(term),
  )
  const folderIds = new Set(folders.map(folder => folder.id))
  const inFolder = (id: string) =>
    visibleReports
      .filter(item => (id ? item.folderId === id : !folderIds.has(item.folderId)))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))
  const toggleFolder = (id: string) =>
    setCollapsed(current => {
      const next = current.includes(id) ? current.filter(item => item !== id) : [...current, id]
      writeStore(COLLAPSED_KEY, next.join(','))
      return next
    })
  const moveTo = async (reportId: string, folderId: string) => {
    const item = reports.find(entry => entry.id === reportId)
    if (!item?.canEdit || item.folderId === folderId) return
    replace({ ...item, folderId })
    const saved = await update(item, { folderId })
    if (!saved) replace(item)
  }
  const dropProps = (folderId: string) => ({
    onDragOver: (event: DragEvent) => {
      if (!event.dataTransfer.types.includes('text/x-report')) return
      event.preventDefault()
      setDropTarget(folderId)
    },
    onDragLeave: () => setDropTarget(current => (current === folderId ? null : current)),
    onDrop: (event: DragEvent) => {
      const id = event.dataTransfer.getData('text/x-report')
      setDropTarget(null)
      if (id) {
        event.preventDefault()
        moveTo(id, folderId)
      }
    },
  })
  const reportLink = (item: ReportItem) => (
    <button
      type="button"
      key={item.id}
      className={`crp-side-report${item.id === selectedId ? ' on' : ''}`}
      draggable={item.canEdit}
      onDragStart={event => {
        event.dataTransfer.setData('text/x-report', item.id)
        event.dataTransfer.effectAllowed = 'move'
      }}
      onClick={() => choose(item.id)}
      title={item.description || item.name}
    >
      <FileText size={14} />
      <span>{item.name}</span>
      {item.shared ? (
        <Users size={12} aria-label="Shared" />
      ) : (
        <Lock size={12} aria-label="Private" className="crp-faint" />
      )}
    </button>
  )

  // --- The page ---

  if (problem?.upgrade)
    return (
      <section className="crp-page">
        <Notice kind="info">
          Custom reports need a database upgrade: apply <code>database/migrations/schema-v31-custom-reports.sql</code>,
          then reload. The Overview tab works as before.
        </Notice>
      </section>
    )

  const range = rangeDates(filters, today)
  const setFilters = (next: ReportFilters) => {
    if (editing) setDraft(current => (current ? { ...current, filters: next } : current))
    else setViewFilters(next)
  }
  const isAdmin = currentUser.role === 'Administrator'
  const trackedUsers = props.accounts.filter(account => account.status === 'Active')

  return (
    <section className={`crp-page${editing ? ' is-editing' : ''}`}>
      <aside className="crp-side" aria-label="Your reports">
        <div className="crp-side-actions">
          {canChange && (
            <>
              <button type="button" className="crp-btn primary" onClick={() => setDialog({ kind: 'new-report' })}>
                <Plus size={15} /> New report
              </button>
              <button
                type="button"
                className="crp-icon"
                aria-label="New folder"
                title="New folder"
                onClick={() => setDialog({ kind: 'new-folder' })}
              >
                <FolderPlus size={16} />
              </button>
            </>
          )}
        </div>
        <label className="crp-search">
          <Search size={14} />
          <input
            type="search"
            placeholder="Find a report"
            value={search}
            onChange={event => setSearch(event.target.value)}
            aria-label="Find a report"
          />
        </label>
        {items === null && <p className="crp-muted">Loading reports…</p>}
        {items && !reports.length && !folders.length && (
          <p className="crp-muted">No reports yet. Make one from a ready-made start, or a blank page.</p>
        )}
        <nav className="crp-tree">
          {folders
            .slice()
            .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))
            .map(folder => {
              const inside = inFolder(folder.id)
              const closed = collapsed.includes(folder.id) && !term
              return (
                <div
                  key={folder.id}
                  className={`crp-folder${dropTarget === folder.id ? ' drop' : ''}`}
                  {...dropProps(folder.id)}
                >
                  <div className="crp-folder-head">
                    <button
                      type="button"
                      className="crp-folder-toggle"
                      aria-expanded={!closed}
                      onClick={() => toggleFolder(folder.id)}
                    >
                      {closed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                      <Folder size={14} />
                      <span>{folder.name}</span>
                      <em>{inside.length}</em>
                    </button>
                    {folder.shared && <Users size={12} aria-label="Shared folder" className="crp-faint" />}
                    {folder.canEdit && (
                      <FolderMenu
                        folder={folder}
                        onRename={() => setDialog({ kind: 'rename', item: folder })}
                        onShare={() => update(folder, { shared: !folder.shared })}
                        onDelete={() => setDialog({ kind: 'delete', item: folder })}
                      />
                    )}
                  </div>
                  {!closed && (
                    <div className="crp-folder-items">
                      {inside.map(reportLink)}
                      {!inside.length && <p className="crp-faint crp-small">Drag reports here.</p>}
                    </div>
                  )}
                </div>
              )
            })}
          <div className={`crp-folder loose${dropTarget === '' ? ' drop' : ''}`} {...dropProps('')}>
            {folders.length > 0 && <p className="crp-tree-label">Not in a folder</p>}
            {inFolder('').map(reportLink)}
          </div>
        </nav>
      </aside>

      <div className="crp-main">
        {notice && (
          <Notice kind="error" onClose={() => setNotice('')}>
            {notice}
          </Notice>
        )}
        {problem && !problem.upgrade && <Notice kind="error">{problem.message}</Notice>}
        {!report && items && (
          <div className="crp-welcome">
            <h2>Build your own reports</h2>
            <p>
              Pick what to measure, drag charts, tables, number tiles and timelines where you want them, and keep
              reports in folders. Reports are private until you share them.
            </p>
            {canChange && (
              <button type="button" className="crp-btn primary" onClick={() => setDialog({ kind: 'new-report' })}>
                <Plus size={15} /> New report
              </button>
            )}
          </div>
        )}
        {report && (
          <div className="crp-print-area">
            <header className="crp-head">
              <div className="crp-title">
                <h2>{report.name}</h2>
                <p>
                  {report.shared ? 'Shared with everyone' : 'Only you'} · by {report.createdByName || 'someone'}
                  {report.updatedByName && report.updatedAt
                    ? ` · updated ${niceDate(report.updatedAt.slice(0, 10))}`
                    : ''}
                </p>
                {report.description && <p className="crp-description">{report.description}</p>}
              </div>
              <div className="crp-head-actions no-print">
                {editing ? (
                  <>
                    <span className="crp-muted">{dirty ? 'Unsaved changes' : 'No changes yet'}</span>
                    <button
                      type="button"
                      className="crp-btn"
                      disabled={busy}
                      onClick={() => {
                        if (!dirty || window.confirm('Throw away your changes to this report?')) setDraft(null)
                      }}
                    >
                      Cancel
                    </button>
                    <button type="button" className="crp-btn primary" disabled={busy || !dirty} onClick={save}>
                      {busy ? 'Saving…' : 'Save report'}
                    </button>
                  </>
                ) : (
                  <>
                    {report.canEdit && (
                      <button
                        type="button"
                        className="crp-btn primary"
                        onClick={() => {
                          setDraft(JSON.parse(JSON.stringify(report.definition)))
                          if (canUseTrackers) trackers.loadList()
                        }}
                      >
                        <Pencil size={14} /> Edit
                      </button>
                    )}
                    <button type="button" className="crp-btn" onClick={print}>
                      <Printer size={14} /> PDF / Print
                    </button>
                    {canChange && (
                      <button type="button" className="crp-btn" disabled={busy} onClick={() => copy(report)}>
                        <Copy size={14} /> Make a copy
                      </button>
                    )}
                    {report.canEdit && (
                      <>
                        <button
                          type="button"
                          ref={menuAnchor}
                          className="crp-icon"
                          aria-label="More"
                          aria-expanded={menuOpen}
                          onClick={() => setMenuOpen(open => !open)}
                        >
                          <MoreHorizontal size={16} />
                        </button>
                        {menuOpen && (
                          <Popover anchor={menuAnchor} onClose={() => setMenuOpen(false)} label="Report" minWidth={240}>
                            <div className="crp-menu">
                              <button
                                type="button"
                                onClick={() => {
                                  setMenuOpen(false)
                                  setDialog({ kind: 'rename', item: report })
                                }}
                              >
                                <Pencil size={14} /> Rename and describe
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  setMenuOpen(false)
                                  update(report, { shared: !report.shared })
                                }}
                              >
                                {report.shared ? <Lock size={14} /> : <Users size={14} />}
                                {report.shared ? 'Make private' : 'Share with everyone'}
                              </button>
                              <label className="crp-menu-field">
                                <span>
                                  <Folder size={14} /> Folder
                                </span>
                                <select
                                  value={folderIds.has(report.folderId) ? report.folderId : ''}
                                  onChange={event => {
                                    setMenuOpen(false)
                                    moveTo(report.id, event.target.value)
                                  }}
                                >
                                  <option value="">Not in a folder</option>
                                  {folders
                                    .filter(folder => folder.canEdit || folder.shared)
                                    .map(folder => (
                                      <option key={folder.id} value={folder.id}>
                                        {folder.name}
                                      </option>
                                    ))}
                                </select>
                              </label>
                              <button
                                type="button"
                                className="danger"
                                onClick={() => {
                                  setMenuOpen(false)
                                  setDialog({ kind: 'delete', item: report })
                                }}
                              >
                                <Trash2 size={14} /> Delete report
                              </button>
                            </div>
                          </Popover>
                        )}
                      </>
                    )}
                  </>
                )}
              </div>
            </header>

            <div className="crp-filters">
              <label>
                <span>Dates</span>
                <select
                  value={filters.range}
                  onChange={event => setFilters({ ...filters, range: event.target.value as RangePreset })}
                >
                  {RANGE_PRESETS.map(preset => (
                    <option key={preset} value={preset}>
                      {RANGE_LABELS[preset]}
                    </option>
                  ))}
                </select>
              </label>
              {filters.range === 'custom' && (
                <>
                  <label>
                    <span>From</span>
                    <input
                      type="date"
                      value={filters.from || ''}
                      onChange={event => setFilters({ ...filters, from: event.target.value || undefined })}
                    />
                  </label>
                  <label>
                    <span>To</span>
                    <input
                      type="date"
                      value={filters.to || ''}
                      onChange={event => setFilters({ ...filters, to: event.target.value || undefined })}
                    />
                  </label>
                </>
              )}
              <label>
                <span>Client</span>
                <select
                  value={filters.clientId || ''}
                  onChange={event => setFilters({ ...filters, clientId: event.target.value || undefined })}
                >
                  <option value="">All clients</option>
                  {props.clients
                    .filter(client => !client.archived || client.id === filters.clientId)
                    .map(client => (
                      <option key={client.id} value={client.id}>
                        {client.name}
                      </option>
                    ))}
                </select>
              </label>
              <label>
                <span>Project</span>
                <select
                  value={filters.projectId || ''}
                  onChange={event => setFilters({ ...filters, projectId: event.target.value || undefined })}
                >
                  <option value="">All projects</option>
                  {props.projects
                    .filter(project => !project.archived || project.id === filters.projectId)
                    .map(project => (
                      <option key={project.id} value={project.id}>
                        {project.name}
                      </option>
                    ))}
                </select>
              </label>
              {isAdmin && (
                <label>
                  <span>Person</span>
                  <select
                    value={filters.userId || ''}
                    onChange={event => setFilters({ ...filters, userId: event.target.value || undefined })}
                  >
                    <option value="">Everyone</option>
                    {trackedUsers.map(user => (
                      <option key={user.id} value={user.id}>
                        {user.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <p className="crp-print-only">
                {[
                  RANGE_LABELS[filters.range],
                  props.clients.find(client => client.id === filters.clientId)?.name || 'All clients',
                  props.projects.find(project => project.id === filters.projectId)?.name || 'All projects',
                  filters.userId ? props.accounts.find(account => account.id === filters.userId)?.name : '',
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </p>
              <p className="crp-range">
                {range ? `${niceDate(range.from)} – ${niceDate(range.to)}` : 'All dates'}
                {!editing && viewFilters && (
                  <button type="button" className="crp-link no-print" onClick={() => setViewFilters(null)}>
                    Reset to saved filters
                  </button>
                )}
                {editing && <span className="crp-muted"> · saved with the report</span>}
              </p>
            </div>

            <div className="crp-board">
              {editing && (
                <aside className="crp-palette no-print" aria-label="Widgets">
                  <p className="crp-tree-label">Drag onto the page</p>
                  {PALETTE.map(entry => (
                    <button
                      type="button"
                      key={entry.kind}
                      draggable
                      onDragStart={event => {
                        event.dataTransfer.setData(WIDGET_TYPE, entry.kind)
                        event.dataTransfer.effectAllowed = 'copy'
                        setNewKind(entry.kind)
                      }}
                      onDragEnd={() => setNewKind(null)}
                      onClick={() => addWidget(entry.kind)}
                      title={`Drag onto the page, or click to add a ${WIDGET_LABELS[entry.kind].toLowerCase()}`}
                    >
                      {entry.icon}
                      <span>{WIDGET_LABELS[entry.kind]}</span>
                    </button>
                  ))}
                </aside>
              )}
              <div className="crp-canvas-wrap">
                {!editing && !definition.widgets.length && (
                  <div className="crp-welcome small">
                    <p>This report has no widgets yet.</p>
                    {report.canEdit && (
                      <button
                        type="button"
                        className="crp-btn primary"
                        onClick={() => {
                          setDraft(JSON.parse(JSON.stringify(report.definition)))
                          if (canUseTrackers) trackers.loadList()
                        }}
                      >
                        <Pencil size={14} /> Add widgets
                      </button>
                    )}
                  </div>
                )}
                <ReportCanvas
                  widgets={definition.widgets}
                  editing={editing}
                  selectedId={selectedWidget}
                  newKind={newKind}
                  onChange={setWidgets}
                  onSelect={setSelectedWidget}
                  onDropNew={(kind, at) => {
                    setNewKind(null)
                    addWidget(kind, at)
                  }}
                  renderWidget={widget => (
                    <WidgetCard
                      widget={widget}
                      filters={filters}
                      editing={editing}
                      today={today}
                      fieldsFor={fieldsFor}
                      recordsFor={recordsFor}
                      trackerProblem={
                        widget.source === 'tracker'
                          ? !widget.trackerId
                            ? 'Choose a tracker in this widget’s settings.'
                            : trackers.failed[widget.trackerId] ||
                              (trackers.loaded[widget.trackerId] ? '' : 'Loading the tracker…')
                          : ''
                      }
                      onEdit={() => setEditingWidget(widget)}
                      onDuplicate={() => duplicateWidget(widget)}
                      onRemove={() => setWidgets(definition.widgets.filter(item => item.id !== widget.id))}
                    />
                  )}
                />
              </div>
            </div>
          </div>
        )}
      </div>

      {editingWidget && (
        <WidgetEditor
          widget={editingWidget}
          trackers={trackers.list}
          canUseTrackers={canUseTrackers}
          fieldsFor={(source, trackerId) => {
            if (source === 'tracker') trackers.ensure(trackerId)
            return fieldsFor(source, trackerId)
          }}
          recordsFor={recordsFor}
          preview={widget => (
            <WidgetCard
              widget={widget}
              filters={filters}
              editing={false}
              today={today}
              fieldsFor={fieldsFor}
              recordsFor={recordsFor}
              trackerProblem={
                widget.source === 'tracker'
                  ? !widget.trackerId
                    ? 'Choose a tracker.'
                    : trackers.failed[widget.trackerId] ||
                      (trackers.loaded[widget.trackerId] ? '' : 'Loading the tracker…')
                  : ''
              }
            />
          )}
          onClose={() => setEditingWidget(null)}
          onSave={widget => {
            setDraft(current =>
              current
                ? { ...current, widgets: current.widgets.map(item => (item.id === widget.id ? widget : item)) }
                : current,
            )
            setEditingWidget(null)
          }}
        />
      )}

      {dialog?.kind === 'new-report' && (
        <NewReportDialog
          folders={folders.filter(folder => folder.canEdit || folder.shared)}
          busy={busy}
          onClose={() => setDialog(null)}
          onCreate={async (body, template) => {
            const made = await create({ kind: 'report', ...body, definition: template })
            if (!made) return
            setDialog(null)
            setSelectedId(made.id)
            if (!template.widgets.length) {
              setDraft(JSON.parse(JSON.stringify(made.definition)))
              if (canUseTrackers) trackers.loadList()
            }
          }}
        />
      )}
      {(dialog?.kind === 'new-folder' || dialog?.kind === 'rename') && (
        <NameDialog
          item={dialog.kind === 'rename' ? dialog.item : null}
          busy={busy}
          onClose={() => setDialog(null)}
          onSave={async (name, description, shared) => {
            const done =
              dialog.kind === 'rename'
                ? await update(dialog.item, { name, description })
                : await create({ kind: 'folder', name, shared })
            if (done) setDialog(null)
          }}
        />
      )}
      {dialog?.kind === 'delete' && (
        <Dialog title={`Delete ${dialog.item.name}?`} onClose={() => setDialog(null)} busy={busy}>
          <div className="crp-dialog-body">
            <p>
              {dialog.item.kind === 'folder'
                ? 'The folder is deleted. Reports in it are kept, out of any folder.'
                : dialog.item.shared
                  ? 'This report is shared, so it is deleted for everyone. The tasks, time and trackers it reads are not touched.'
                  : 'The report is deleted. The tasks, time and trackers it reads are not touched.'}
            </p>
            <div className="k-dialog-actions">
              <span className="crp-spacer" />
              <button type="button" className="crp-btn" disabled={busy} onClick={() => setDialog(null)}>
                Cancel
              </button>
              <button type="button" className="crp-btn danger" disabled={busy} onClick={() => remove(dialog.item)}>
                {busy ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </Dialog>
      )}
    </section>
  )
}

function FolderMenu({
  folder,
  onRename,
  onShare,
  onDelete,
}: {
  folder: ReportItem
  onRename: () => void
  onShare: () => void
  onDelete: () => void
}) {
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLButtonElement>(null)
  return (
    <>
      <button
        type="button"
        ref={anchor}
        className="crp-icon small"
        aria-label={`${folder.name} options`}
        aria-expanded={open}
        onClick={() => setOpen(value => !value)}
      >
        <MoreHorizontal size={14} />
      </button>
      {open && (
        <Popover anchor={anchor} onClose={() => setOpen(false)} label="Folder" minWidth={210}>
          <div className="crp-menu">
            <button
              type="button"
              onClick={() => {
                setOpen(false)
                onRename()
              }}
            >
              <Pencil size={14} /> Rename
            </button>
            <button
              type="button"
              onClick={() => {
                setOpen(false)
                onShare()
              }}
            >
              {folder.shared ? <Lock size={14} /> : <Users size={14} />}
              {folder.shared ? 'Make private' : 'Share folder with everyone'}
            </button>
            <button
              type="button"
              className="danger"
              onClick={() => {
                setOpen(false)
                onDelete()
              }}
            >
              <Trash2 size={14} /> Delete folder
            </button>
          </div>
        </Popover>
      )}
    </>
  )
}

/** One widget on the page: its title, its actions, and what it shows. */
function WidgetCard({
  widget,
  filters,
  editing,
  today,
  fieldsFor,
  recordsFor,
  trackerProblem,
  onEdit,
  onDuplicate,
  onRemove,
}: {
  widget: Widget
  filters: ReportFilters
  editing: boolean
  today: string
  fieldsFor: (source: SourceId, trackerId?: string) => Field[]
  recordsFor: (source: SourceId, trackerId?: string) => Rec[]
  trackerProblem: string
  onEdit?: () => void
  onDuplicate?: () => void
  onRemove?: () => void
}) {
  const fields = fieldsFor(widget.source, widget.trackerId)
  const records = recordsFor(widget.source, widget.trackerId)
  // Moving or resizing a widget does not change its numbers, so they are kept while it is dragged.
  const settings = JSON.stringify({ ...widget, x: 0, y: 0, w: 0, h: 0 })
  const computed = useMemo(
    () => (trackerProblem ? null : computeWidget(widget, records, fields, filters, today)),
    [settings, records, fields, filters, today, trackerProblem],
  )
  const isText = widget.kind === 'heading' || widget.kind === 'note'
  const title = widget.title || (isText ? '' : WIDGET_LABELS[widget.kind])
  const source = SOURCES.find(item => item.id === widget.source)?.label
  return (
    <>
      {(title || editing) && (
        <div className="crp-card-head">
          <h3 title={title}>{title}</h3>
          {!isText && !editing && computed && (
            <button
              type="button"
              className="crp-icon small no-print"
              aria-label={`Download ${title} as CSV`}
              title="Download as CSV"
              onClick={() => downloadCsv(title || 'widget', widgetCsv(widget, computed, fields))}
            >
              <Download size={13} />
            </button>
          )}
          {editing && (
            <span className="crp-card-tools">
              <button
                type="button"
                className="crp-icon small"
                aria-label="Settings"
                title={isText ? 'Settings' : `Settings · from ${source}`}
                onClick={onEdit}
              >
                <Settings2 size={14} />
              </button>
              <button
                type="button"
                className="crp-icon small"
                aria-label="Duplicate"
                title="Duplicate"
                onClick={onDuplicate}
              >
                <Copy size={13} />
              </button>
              <button type="button" className="crp-icon small" aria-label="Remove" title="Remove" onClick={onRemove}>
                <Trash2 size={13} />
              </button>
            </span>
          )}
        </div>
      )}
      <div className="crp-card-body" onDoubleClick={editing ? onEdit : undefined}>
        <WidgetBody widget={widget} computed={computed} fields={fields} today={today} problem={trackerProblem} />
      </div>
    </>
  )
}

function NewReportDialog({
  folders,
  busy,
  onClose,
  onCreate,
}: {
  folders: ReportItem[]
  busy: boolean
  onClose: () => void
  onCreate: (
    body: { name: string; description: string; folderId: string; shared: boolean },
    template: ReportDefinition,
  ) => void
}) {
  const [template, setTemplate] = useState('blank')
  const [name, setName] = useState('')
  const [folderId, setFolderId] = useState('')
  const [shared, setShared] = useState(false)
  const chosen = REPORT_TEMPLATES.find(item => item.id === template) || REPORT_TEMPLATES[0]
  const submit = (event: FormEvent) => {
    event.preventDefault()
    const title = name.trim() || (chosen.id === 'blank' ? 'Untitled report' : chosen.name)
    onCreate({ name: title, description: '', folderId, shared }, chosen.build())
  }
  return (
    <Dialog title="New report" onClose={onClose} busy={busy} size="medium">
      <form className="crp-dialog-body" onSubmit={submit}>
        <p className="crp-tree-label">Start from</p>
        <div className="crp-templates">
          {REPORT_TEMPLATES.map(item => (
            <button
              type="button"
              key={item.id}
              className={item.id === template ? 'on' : ''}
              aria-pressed={item.id === template}
              onClick={() => setTemplate(item.id)}
            >
              <strong>{item.name}</strong>
              <span>{item.about}</span>
            </button>
          ))}
        </div>
        <label className="crp-form-row">
          <span>Name</span>
          <input
            value={name}
            maxLength={120}
            placeholder={chosen.id === 'blank' ? 'Untitled report' : chosen.name}
            onChange={event => setName(event.target.value)}
          />
        </label>
        <label className="crp-form-row">
          <span>Folder</span>
          <select value={folderId} onChange={event => setFolderId(event.target.value)}>
            <option value="">Not in a folder</option>
            {folders.map(folder => (
              <option key={folder.id} value={folder.id}>
                {folder.name}
              </option>
            ))}
          </select>
        </label>
        <label className="crp-check">
          <input type="checkbox" checked={shared} onChange={event => setShared(event.target.checked)} />
          Share with everyone on the account (they see it with their own data access)
        </label>
        <div className="k-dialog-actions">
          <span className="crp-spacer" />
          <button type="button" className="crp-btn" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="crp-btn primary" disabled={busy}>
            {busy ? 'Creating…' : 'Create report'}
          </button>
        </div>
      </form>
    </Dialog>
  )
}

function NameDialog({
  item,
  busy,
  onClose,
  onSave,
}: {
  /** The report or folder to rename; none for a new folder. */
  item: ReportItem | null
  busy: boolean
  onClose: () => void
  onSave: (name: string, description: string, shared: boolean) => void
}) {
  const [name, setName] = useState(item?.name || '')
  const [description, setDescription] = useState(item?.description || '')
  const [shared, setShared] = useState(false)
  const isReport = item?.kind === 'report'
  return (
    <Dialog title={item ? `Rename ${item.kind}` : 'New folder'} onClose={onClose} busy={busy}>
      <form
        className="crp-dialog-body"
        onSubmit={event => {
          event.preventDefault()
          if (name.trim()) onSave(name.trim(), description.trim(), shared)
        }}
      >
        <label className="crp-form-row">
          <span>Name</span>
          <input value={name} maxLength={120} autoFocus required onChange={event => setName(event.target.value)} />
        </label>
        {isReport && (
          <label className="crp-form-row">
            <span>Description</span>
            <textarea
              rows={3}
              maxLength={500}
              value={description}
              onChange={event => setDescription(event.target.value)}
            />
          </label>
        )}
        {!item && (
          <label className="crp-check">
            <input type="checkbox" checked={shared} onChange={event => setShared(event.target.checked)} />
            Share the folder with everyone (each report in it is still shared on its own)
          </label>
        )}
        <div className="k-dialog-actions">
          <span className="crp-spacer" />
          <button type="button" className="crp-btn" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="crp-btn primary" disabled={busy || !name.trim()}>
            {busy ? 'Saving…' : item ? 'Save' : 'Create folder'}
          </button>
        </div>
      </form>
    </Dialog>
  )
}
