import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  Clipboard,
  ExternalLink,
  FileText,
  Link2,
  LockKeyhole,
  Search,
  Table2,
  Upload,
} from 'lucide-react'
import { COLUMN_TYPES, TRACKER_LIMITS, trackerClientIds, type ColumnType, type Tracker } from './trackerModel'
import {
  defaultMappings,
  parseTable,
  planImport,
  toSource,
  type Mapping,
  type Person,
  type Source,
} from './trackerImport'
import { trackerApi, TrackerApiError, type SheetFile } from './trackerApi'
import { checkNameColumns, sheetIdFrom } from './trackerSync'
import { rememberReview } from './trackerNav'
import { Dialog, plural } from './trackerUi'
import TrackerClientPicker from './TrackerClientPicker'
import { isClosedProject } from '../tasks/lifecycle'
import type { ReviewPreset } from './trackerReviewPlan'
import {
  HEADER_ROLES,
  type HeaderChoices,
  type HeaderRole,
  importPreview,
  roleOf,
  setRole,
  suggestedSubtasks,
} from './importHeaders'

type Props = {
  /** Importing into a tracker that exists, or into a new one made from the file or Sheet. */
  tracker?: Tracker
  clients: { id: string; name: string }[]
  projects: { id: string; name: string; archived?: boolean; seedsArchived?: boolean }[]
  people: Person[]
  today: string
  onClose: () => void
  /**
   * Called with the tracker to open once rows have been added, the new rows, and the choices for their tasks (the
   * tracker creates them, or opens the review when the person asked to go row by row).
   */
  onDone: (trackerId: string, imported: number, rowIds?: string[], preset?: ReviewPreset) => void
  /** Start on a Google Sheet (a new tracker that follows it). */
  fromSheet?: boolean
  /** Offer to link this tracker to an existing Google Sheet (it has none yet, and the person can edit it). */
  canLink?: boolean
  /** Called once this tracker follows the Sheet: rows matched by name, rows added, and the choices for their tasks. */
  onLinked?: (matched: number, added: number, preset?: ReviewPreset) => void
  /** Whether this person can create tasks: without it, rows come in as plain rows. */
  canCreateTasks?: boolean
}

type Step = 'data' | 'headers' | 'place'
const STEPS: { step: Step; label: string }[] = [
  { step: 'data', label: 'Your data' },
  { step: 'headers', label: 'Pick your headers' },
  { step: 'place', label: 'Where it goes' },
]
const MAX_FILE = 5 * 1024 * 1024
const IMPORT_TYPES = COLUMN_TYPES.filter(item => item.group === 'basic' || item.type === 'secret')
const MAPPABLE = ['text', 'longtext', 'number', 'date', 'checkbox', 'select', 'multiselect', 'person', 'link', 'secret']

/**
 * Bringing rows into a tracker in three steps, the same for a file, pasted cells and a Google Sheet:
 * 1. Your data: a CSV file, pasted cells, or a Google Sheet (kept in sync, or copied once).
 * 2. Pick your headers: the task name, the headers that give every task a subtask, and the rest as info, with a
 *    preview of what will be created. Names, types and existing columns are under Advanced.
 * 3. Where it goes: the tracker (when new), and the client and project of the new tasks.
 * The tasks and subtasks are then created by the tracker's review, from these choices, unless the person asks to go
 * row by row first.
 */
export default function TrackerImportDialog({
  tracker,
  clients,
  projects,
  people,
  today,
  onClose,
  onDone,
  fromSheet = false,
  canLink = false,
  onLinked,
  canCreateTasks = true,
}: Props) {
  const [step, setStep] = useState<Step>('data')
  // Where the rows come from. A Sheet can be followed (kept in sync, Sheet → tracker) or copied once.
  const sheetsOffered = !tracker || canLink
  const [kind, setKind] = useState<'file' | 'sheet'>(fromSheet && sheetsOffered ? 'sheet' : 'file')
  const [keepSync, setKeepSync] = useState(true)
  const following = kind === 'sheet' && keepSync
  // Linking this tracker to a Sheet: the same steps as a new tracker from a Sheet, without making one.
  const linking = Boolean(tracker) && following
  // Google Sheet source: who is signed in, the Sheets they can open, the chosen Sheet and tab.
  const [google, setGoogle] = useState<{ available: boolean; connected: boolean; email: string } | null>(null)
  const [query, setQuery] = useState('')
  const [files, setFiles] = useState<SheetFile[] | null>(null)
  const [sheet, setSheet] = useState<{
    id: string
    name: string
    excel?: boolean
    tabs: { title: string; rows: number }[]
  } | null>(null)
  // An Excel file was chosen, but Google has not yet let the tracker download Drive files.
  const [excelAllow, setExcelAllow] = useState(false)
  const [tab, setTab] = useState('')
  const [looking, setLooking] = useState(false)
  const [text, setText] = useState('')
  const [fileName, setFileName] = useState('')
  const [header, setHeader] = useState(true)
  const [source, setSource] = useState<Source | null>(null)
  const [mappings, setMappings] = useState<Mapping[]>([])
  // Step 2: the task name header and the headers that give every task a subtask.
  const [task, setTask] = useState(-1)
  const [subtasks, setSubtasks] = useState<number[]>([])
  // Step 3: the tracker (when new), and where its tasks go.
  const [name, setName] = useState('')
  const [clientIds, setClientIds] = useState<string[]>([])
  const [projectId, setProjectId] = useState('')
  const [onlyMe, setOnlyMe] = useState(false)
  const [taskClientId, setTaskClientId] = useState('')
  const [taskProjectId, setTaskProjectId] = useState(tracker?.projectId || '')
  const [reviewFirst, setReviewFirst] = useState(false)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState('')
  const [error, setError] = useState('')
  const [partial, setPartial] = useState<{ trackerId: string; imported: number; ids: string[] } | null>(null)
  const file = useRef<HTMLInputElement>(null)
  const existing = useMemo(() => tracker?.columns || [], [tracker])
  const capacity = TRACKER_LIMITS.rows - (tracker?.rowCount || 0)

  useEffect(() => {
    if (kind !== 'sheet') return
    trackerApi
      .sheetsStatus()
      .then(setGoogle)
      .catch(() => setGoogle({ available: false, connected: false, email: '' }))
  }, [kind])
  useEffect(() => {
    if (kind !== 'sheet' || !google?.connected) return
    const timer = window.setTimeout(
      () => {
        trackerApi
          .sheetFiles(query)
          .then(result => setFiles(result.files))
          .catch(e => setError(e instanceof Error ? e.message : 'Your Sheets could not be listed.'))
      },
      query ? 300 : 0,
    )
    return () => window.clearTimeout(timer)
  }, [kind, google?.connected, query])
  const allowSheets = async (excel = false) => {
    try {
      const response = await fetch(`/api/communications/gmail/connect?sheets=1${excel ? '&excel=1' : ''}`, {
        credentials: 'same-origin',
      })
      const result = await response.json().catch(() => ({}))
      if (!response.ok || !result.url) throw new Error(result.error || 'Could not start the Google permission step.')
      window.location.assign(result.url)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start the Google permission step.')
    }
  }
  const openSheet = async (idOrLink: string) => {
    const id = sheetIdFrom(idOrLink)
    if (!id) return setError('That is not a Google Sheets link. Copy the address of the Sheet from your browser.')
    setLooking(true)
    setError('')
    setExcelAllow(false)
    try {
      const result = await trackerApi.sheetTabs(id)
      setSheet({ id: result.id, name: result.name, excel: result.excel, tabs: result.tabs })
      setTab(result.tabs[0]?.title || '')
      if (!name.trim()) setName(result.name.replace(/\.xlsx$/i, '').slice(0, TRACKER_LIMITS.nameLength))
    } catch (e) {
      if (e instanceof TrackerApiError && e.body.needsExcel) setExcelAllow(true)
      setError(e instanceof Error ? e.message : 'That Sheet could not be opened.')
    } finally {
      setLooking(false)
    }
  }

  /** The rows are in: every header starts as info, the first as the task name. */
  const start = (parsed: Source, sheetSource: boolean) => {
    setSource(parsed)
    setMappings(
      defaultMappings(parsed, existing, today).map(mapping =>
        sheetSource && mapping.type === 'secret' ? { ...mapping, type: 'text' } : mapping,
      ),
    )
    setTask(parsed.headers.length ? 0 : -1)
    setSubtasks([])
    setStep('headers')
  }
  const readSheet = async () => {
    if (!sheet || !tab) return
    setLooking(true)
    setError('')
    try {
      const result = await trackerApi.sheetValues(sheet.id, tab)
      const parsed = toSource(result.grid, true)
      if (!parsed.ok) throw new Error(parsed.error)
      setHeader(true)
      start(parsed.source, true)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The Sheet could not be read.')
    } finally {
      setLooking(false)
    }
  }
  const read = () => {
    setError('')
    const parsed = toSource(parseTable(text), header)
    if (!parsed.ok) return setError(parsed.error)
    if (!name.trim() && fileName) setName(fileName.replace(/\.(csv|tsv|txt)$/i, '').slice(0, TRACKER_LIMITS.nameLength))
    start(parsed.source, false)
  }
  const choose = async (list: FileList | null) => {
    const picked = list?.[0]
    if (!picked) return
    if (picked.size > MAX_FILE)
      return setError('That file is larger than 5 MB. Split it and import the parts one at a time.')
    try {
      setText(await picked.text())
      setFileName(picked.name)
      setError('')
    } catch {
      setError('That file could not be read.')
    }
  }

  const plan = useMemo(
    () =>
      source ? planImport(source, mappings, existing, { today, people, capacity, firstRowIsHeader: header }) : null,
    [source, mappings, existing, today, people, capacity, header],
  )

  // ---- Step 2: headers ----

  const choices: HeaderChoices = {
    task,
    subtasks,
    included: (source?.headers || []).map((_, index) => Boolean(mappings.find(item => item.index === index)?.include)),
  }
  const apply = (next: HeaderChoices) => {
    setTask(next.task)
    setSubtasks(next.subtasks)
    setMappings(list => list.map(item => ({ ...item, include: next.included[item.index] ?? item.include })))
  }
  const giveRole = (index: number, role: HeaderRole) => apply(setRole(choices, index, role))
  const change = (index: number, patch: Partial<Mapping>) => {
    setMappings(list => list.map(item => (item.index === index ? { ...item, ...patch } : item)))
    // Unticking a header under Advanced leaves it out: it is no longer the task name or a subtask.
    if (patch.include === false) {
      setSubtasks(list => list.filter(at => at !== index))
      if (task === index) setTask(-1)
    }
  }
  const types = (source?.headers || []).map(
    (_, index) => mappings.find(item => item.index === index)?.type || ('text' as ColumnType),
  )
  const suggested = suggestedSubtasks(types, choices)
  const preview = source ? importPreview(source.headers, source.rows, choices) : null
  const keyHeader = source && task >= 0 ? source.headers[task] : ''
  const nameCheck = useMemo(
    () => (source && following && task >= 0 ? checkNameColumns(source.headers, source.rows)[task] : undefined),
    [source, following, task],
  )
  const sample = (index: number) =>
    (
      source?.rows
        .slice(0, 3)
        .map(row => row[index])
        .filter(Boolean)
        .join(' · ') || ''
    ).slice(0, 70)

  // ---- Step 3: where the tasks go ----

  // The clients the new tasks can go under: the tracker's (when it has some), else every client.
  const trackerClients = tracker ? trackerClientIds(tracker) : clientIds
  const taskClients = trackerClients.length ? clients.filter(client => trackerClients.includes(client.id)) : clients
  const tasksClient = taskClients.length === 1 ? taskClients[0].id : taskClientId
  // A new tracker's tasks go to its project; an existing tracker's to the project chosen here.
  const tasksProject = tracker ? taskProjectId : projectId
  const makesTasks = canCreateTasks && task >= 0 && Boolean(preview?.tasks)
  const openProjects = (current: string) =>
    projects.filter(project => !isClosedProject(project) || project.id === current)

  /** Where each header ends up in the tracker: an existing column, or the new one made for it. */
  const columnOf = (index: number) => {
    if (!plan) return undefined
    let added = 0
    for (const mapping of mappings) {
      if (!mapping.include) continue
      const column =
        mapping.target === 'new' ? plan.added[added++] : plan.columns.find(item => item.id === mapping.target)
      if (mapping.index === index) return column
    }
    return undefined
  }
  /** The choices the tracker's review starts from (and, unless the person goes row by row, creates at once). */
  const preset = (): ReviewPreset | undefined => {
    if (!canCreateTasks || task < 0) return undefined
    const ref = (index: number) => {
      const column = columnOf(index)
      return column ? { id: column.id, name: column.name } : undefined
    }
    return {
      nameColumn: ref(task),
      subColumns: subtasks.map(ref).filter((item): item is { id: string; name: string } => Boolean(item)),
      clientId: tasksClient || undefined,
      projectId: tasksProject,
      auto: !reviewFirst,
    }
  }

  // ---- Moving between steps ----

  const toPlace = () => {
    setError('')
    if (following && task < 0)
      return setError('Choose the Task name header. It is how each row is recognised on every sync.')
    if (!plan || plan.fatal) return
    setStep('place')
  }
  const finish = () => {
    if (!tracker && !name.trim()) return setError('Enter a name for the new tracker.')
    if (makesTasks && !reviewFirst && !tasksClient)
      return setError('Choose the client for the new tasks, or tick “Review row by row first”.')
    if (following && sheet) return void connect()
    void run()
  }

  const run = async () => {
    if (!plan || plan.fatal || busy) return
    setBusy(true)
    setError('')
    setPartial(null)
    let trackerId = tracker?.id || '',
      imported = 0
    const ids: string[] = []
    const choicesForTasks = preset()
    try {
      if (tracker) {
        if (JSON.stringify(plan.columns) !== JSON.stringify(tracker.columns)) {
          setProgress('Adding columns…')
          await trackerApi.saveColumns(tracker.id, plan.columns, tracker.revision)
        }
      } else {
        setProgress('Creating the tracker…')
        const created = await trackerApi.create({
          name: name.trim(),
          columns: plan.columns,
          template: 'sheet',
          clientIds,
          projectId,
          private: onlyMe,
        })
        trackerId = created.tracker.id
      }
      for (let at = 0; at < plan.rows.length; at += TRACKER_LIMITS.importBatch) {
        const batch = plan.rows.slice(at, at + TRACKER_LIMITS.importBatch)
        setProgress(
          `Importing ${Math.min(at + batch.length, plan.rows.length).toLocaleString('en')} of ${plan.rows.length.toLocaleString('en')} rows…`,
        )
        const added = await trackerApi.addRows(
          trackerId,
          batch.map(row => ({ cells: row.cells, secrets: row.secrets })),
        )
        ids.push(...added.rows.map(row => row.id))
        imported += batch.length
      }
      // A new tracker opens with its tasks being created (or the review); an existing one does it from onDone.
      if (!tracker && ids.length) rememberReview(trackerId, ids, choicesForTasks)
      onDone(trackerId, imported, ids, choicesForTasks)
    } catch (e) {
      const message =
        e instanceof TrackerApiError && e.status === 409 && e.body.tracker
          ? 'Someone else changed this tracker while you were importing. Close this window, review the tracker, and import again.'
          : e instanceof Error
            ? e.message
            : 'The import could not finish.'
      setError(imported ? `${message} ${plural(imported, 'row')} had already been added.` : message)
      if (trackerId && (imported || !tracker)) setPartial({ trackerId, imported, ids })
      setBusy(false)
      setProgress('')
    }
  }

  /**
   * A tracker that follows the Sheet: columns from the mapping (a new tracker, or new columns on this one), then the
   * connection, then the first sync.
   */
  const connect = async () => {
    if (!plan || !sheet || busy) return
    const chosen = mappings.filter(mapping => mapping.include)
    if (!chosen.length) return setError('Choose at least one header to bring in.')
    if (!keyHeader || !chosen.some(mapping => source?.headers[mapping.index] === keyHeader))
      return setError('Choose the Task name header. It is how each row is recognised on every sync.')
    setBusy(true)
    setError('')
    const choicesForTasks = preset()
    try {
      let created: { tracker: Tracker }
      if (tracker) {
        created = { tracker }
        if (JSON.stringify(plan.columns) !== JSON.stringify(tracker.columns)) {
          setProgress('Adding columns…')
          created = await trackerApi.saveColumns(tracker.id, plan.columns, tracker.revision)
        }
      } else {
        setProgress('Creating the tracker…')
        created = await trackerApi.create({
          name: name.trim(),
          columns: plan.columns,
          template: 'sheet',
          clientIds,
          projectId,
          private: onlyMe,
        })
      }
      // Each chosen Sheet column goes to the tracker column made for it (new columns are made in the same order).
      const headerMap: Record<string, string> = {}
      let added = 0
      for (const mapping of chosen) {
        const column =
          mapping.target === 'new' ? plan.added[added++] : plan.columns.find(item => item.id === mapping.target)
        const saved =
          created.tracker.columns.find(item => item.id === column?.id) ||
          created.tracker.columns.find(item => item.name === column?.name)
        if (saved && source) headerMap[source.headers[mapping.index]] = saved.id
      }
      setProgress('Reading the Sheet…')
      const result = await trackerApi.connectSource(created.tracker.id, {
        spreadsheetId: sheet.id,
        spreadsheetName: sheet.name,
        tab,
        keyHeader,
        headerMap,
      })
      if (tracker && onLinked) onLinked(result.adopted || 0, result.report?.added || 0, choicesForTasks)
      else {
        rememberReview(created.tracker.id, 'flagged', choicesForTasks)
        onDone(created.tracker.id, result.report?.added || 0, undefined, choicesForTasks)
      }
    } catch (e) {
      setError(
        e instanceof TrackerApiError && e.body.needsGoogle
          ? 'Allow Google Sheets first (button above), then try again.'
          : e instanceof TrackerApiError && e.status === 409 && e.body.tracker
            ? 'Someone else changed this tracker while you were linking it. Close this window and try again.'
            : e instanceof Error
              ? e.message
              : 'The Sheet could not be connected.',
      )
      setBusy(false)
      setProgress('')
    }
  }

  // ---- What the last button says ----

  const rowCount = plan?.rows.length || 0
  const making = makesTasks
    ? [plural(preview?.tasks || 0, 'task'), preview?.subtasks ? plural(preview.subtasks, 'subtask') : '']
        .filter(Boolean)
        .join(' and ')
    : ''
  const finishLabel = busy
    ? following
      ? 'Connecting…'
      : 'Importing…'
    : linking
      ? making && !reviewFirst
        ? `Link, sync and create ${making}`
        : 'Link and sync'
      : !tracker
        ? making && !reviewFirst
          ? `Create tracker, ${making}`
          : `Create tracker with ${plural(rowCount, 'row')}`
        : making && !reviewFirst
          ? `Import ${plural(rowCount, 'row')} and create ${making}`
          : `Import ${plural(rowCount, 'row')}`

  const title = linking
    ? `Link “${tracker?.name}” to a Google Sheet`
    : tracker
      ? `Import into “${tracker.name}”`
      : kind === 'sheet'
        ? 'New tracker from a Google Sheet'
        : 'New tracker from a file'

  return (
    <Dialog title={title} eyebrow={following ? 'Connect' : 'Import'} onClose={onClose} wide busy={busy}>
      <div className="trk-import">
        <ol className="trk-steps" aria-label="Steps">
          {STEPS.map((item, at) => (
            <li
              key={item.step}
              className={item.step === step ? 'on' : STEPS.findIndex(entry => entry.step === step) > at ? 'done' : ''}
              aria-current={item.step === step ? 'step' : undefined}
            >
              <span>{at + 1}</span> {item.label}
            </li>
          ))}
        </ol>

        {step === 'data' && (
          <>
            {sheetsOffered && (
              <div className="trk-segmented trk-source-kind" role="group" aria-label="Where the rows come from">
                <button
                  type="button"
                  className={kind === 'file' ? 'on' : ''}
                  aria-pressed={kind === 'file'}
                  onClick={() => {
                    setKind('file')
                    setError('')
                  }}
                >
                  <FileText size={14} aria-hidden="true" /> File or pasted cells
                </button>
                <button
                  type="button"
                  className={kind === 'sheet' ? 'on' : ''}
                  aria-pressed={kind === 'sheet'}
                  onClick={() => {
                    setKind('sheet')
                    setError('')
                  }}
                >
                  <Table2 size={14} aria-hidden="true" /> Google Sheet
                </button>
              </div>
            )}

            {kind === 'file' && (
              <>
                <div className="trk-import-row">
                  <input
                    ref={file}
                    type="file"
                    accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values,text/plain"
                    hidden
                    onChange={event => {
                      void choose(event.target.files)
                      event.target.value = ''
                    }}
                  />
                  <button type="button" className="trk-button primary" onClick={() => file.current?.click()}>
                    <Upload size={14} aria-hidden="true" /> Choose a CSV file
                  </button>
                  {fileName && <span className="trk-muted-text">{fileName}</span>}
                  <label className="trk-checkline">
                    <input type="checkbox" checked={header} onChange={event => setHeader(event.target.checked)} /> First
                    row has the headers
                  </label>
                </div>
                <label className="trk-field-block">
                  <span>
                    <Clipboard size={13} aria-hidden="true" /> Or paste cells from Google Sheets or Excel
                  </span>
                  <textarea
                    rows={8}
                    value={text}
                    spellCheck={false}
                    placeholder={'Site\tSite survey\tGo-live\nMakati branch\tTRUE\t11/25/2026'}
                    onChange={event => {
                      setText(event.target.value)
                      setFileName('')
                      setError('')
                    }}
                  />
                </label>
              </>
            )}

            {kind === 'sheet' && (
              <div className="trk-sheet-pick">
                <label className="trk-checkline trk-keep-sync">
                  <input type="checkbox" checked={keepSync} onChange={event => setKeepSync(event.target.checked)} />{' '}
                  <span>
                    <strong>Keep this tracker in sync with the Sheet</strong>
                    <small>
                      {keepSync
                        ? 'New and changed rows come in on every sync (Sheet → tracker). The Sheet itself is not changed.'
                        : 'The rows are copied once. Later changes to the Sheet do not come in.'}
                    </small>
                  </span>
                </label>
                {linking && tracker && (tracker.rowCount || 0) > 0 && (
                  <p className="trk-muted-text">
                    This tracker already has {plural(tracker.rowCount || 0, 'row')}. A row whose task name matches a
                    Sheet row is linked to it and updated from the Sheet; other Sheet rows are added.
                  </p>
                )}
                {google === null && (
                  <p role="status" className="trk-muted-text">
                    Checking your Google account…
                  </p>
                )}
                {google && !google.available && (
                  <p className="trk-field-error">
                    Google is not set up for this account yet. An Administrator connects it in Settings → Integrations
                    (the same setup as Gmail in Work Hub).
                  </p>
                )}
                {google?.available && !google.connected && (
                  <div className="k-notice k-notice-info">
                    <div>
                      <strong>Allow the tracker to read your Google Sheets</strong>
                      <p>
                        Google asks you once. The tracker can then list the Sheets you can open, including ones shared
                        with you and shared drives, and read the one you choose. It cannot change them.
                      </p>
                      <button type="button" className="trk-button primary" onClick={() => void allowSheets(false)}>
                        Allow Google Sheets
                      </button>
                    </div>
                  </div>
                )}
                {google?.connected && (
                  <>
                    <p className="trk-muted-text">
                      Signed in to Google as <strong>{google.email}</strong>.
                    </p>
                    <label className="trk-picker-find">
                      <Search size={14} aria-hidden="true" />
                      <input
                        value={query}
                        onChange={event => setQuery(event.target.value)}
                        placeholder="Search your Sheets and Excel files, or paste a link"
                        aria-label="Search your Sheets or paste a link"
                        onKeyDown={event => {
                          if (event.key === 'Enter' && sheetIdFrom(query)) {
                            event.preventDefault()
                            void openSheet(query)
                          }
                        }}
                      />
                    </label>
                    {sheetIdFrom(query) && (
                      <button
                        type="button"
                        className="trk-button"
                        disabled={looking}
                        onClick={() => void openSheet(query)}
                      >
                        <Link2 size={14} aria-hidden="true" /> Open this link
                      </button>
                    )}
                    {!sheetIdFrom(query) && (
                      <div className="trk-sheet-list" role="list" aria-label="Your Sheets">
                        {files === null && <p className="trk-muted-text">Loading your Sheets…</p>}
                        {files?.map(item => (
                          <button
                            type="button"
                            role="listitem"
                            key={item.id}
                            className={sheet?.id === item.id ? 'selected' : ''}
                            disabled={looking}
                            onClick={() => void openSheet(item.id)}
                          >
                            <strong>{item.name}</strong>
                            <small>
                              {[
                                item.excel ? 'Excel file · read only' : '',
                                item.sharedDrive ? 'Shared drive' : item.shared ? 'Shared' : 'My Drive',
                                item.owner,
                                item.modifiedTime
                                  ? `changed ${new Date(item.modifiedTime).toLocaleDateString('en', { month: 'short', day: 'numeric', year: 'numeric' })}`
                                  : '',
                              ]
                                .filter(Boolean)
                                .join(' · ')}
                            </small>
                          </button>
                        ))}
                        {files && !files.length && (
                          <p className="trk-muted-text">
                            {query
                              ? 'No Sheet matches. Paste the Sheet link instead.'
                              : 'No Sheets found for this Google account.'}
                          </p>
                        )}
                      </div>
                    )}
                    {excelAllow && (
                      <div className="k-notice k-notice-info">
                        <div>
                          <strong>Allow the tracker to read Excel files in your Google Drive</strong>
                          <p>
                            An Excel file is read by downloading it, so Google asks once more. The tracker only reads it
                            and never changes it.
                          </p>
                          <button type="button" className="trk-button primary" onClick={() => void allowSheets(true)}>
                            Allow reading Excel files
                          </button>
                        </div>
                      </div>
                    )}
                    {sheet?.excel && keepSync && (
                      <p className="trk-muted-text">
                        <strong>This is an Excel file.</strong> The tracker follows it read only: change its rows in the
                        Excel file and they come in on each sync. You can still make tasks and subtasks from them.
                      </p>
                    )}
                    {sheet && (
                      <div className="trk-sheet-chosen">
                        <span>
                          <strong>{sheet.name}</strong>{' '}
                          <a
                            href={`https://docs.google.com/spreadsheets/d/${sheet.id}/edit`}
                            target="_blank"
                            rel="noopener noreferrer"
                            aria-label="Open the Sheet"
                          >
                            <ExternalLink size={12} />
                          </a>
                        </span>
                        <label className="trk-field-block">
                          Tab
                          <select value={tab} onChange={event => setTab(event.target.value)}>
                            {sheet.tabs.map(item => (
                              <option key={item.title} value={item.title}>
                                {item.title}
                              </option>
                            ))}
                          </select>
                        </label>
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
          </>
        )}

        {step === 'headers' && source && plan && (
          <>
            <p className="trk-strip">
              Found <strong>{plural(source.rows.length, 'row')}</strong>. Tell us what each header is: the{' '}
              <strong>task name</strong>, a <strong>subtask</strong> every task gets, or just <strong>info</strong>.
            </p>
            {!canCreateTasks && (
              <p className="trk-muted-text">
                Your role cannot create tasks, so the rows come in as plain rows. The task name still groups them.
              </p>
            )}
            <div className="trk-map-scroll">
              <table className="trk-map trk-roles">
                <thead>
                  <tr>
                    <th scope="col">Header</th>
                    <th scope="col">Becomes</th>
                  </tr>
                </thead>
                <tbody>
                  {source.headers.map((headerName, index) => {
                    const role = roleOf(choices, index)
                    return (
                      // biome-ignore lint/suspicious/noArrayIndexKey: headers can repeat; their place is their identity
                      <tr key={index} className={role === 'skip' ? 'off' : ''}>
                        <td>
                          <strong>{headerName || `Column ${index + 1}`}</strong>
                          {suggested.includes(index) && <span className="trk-suggest">Suggested subtask</span>}
                          <small>{sample(index)}</small>
                        </td>
                        <td>
                          <div className="trk-segmented" role="group" aria-label={`What ${headerName} becomes`}>
                            {HEADER_ROLES.map(item => (
                              <button
                                type="button"
                                key={item.role}
                                className={role === item.role ? 'on' : ''}
                                aria-pressed={role === item.role}
                                title={item.about}
                                onClick={() => giveRole(index, item.role)}
                              >
                                {item.label}
                              </button>
                            ))}
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            {suggested.length > 0 && (
              <p className="trk-muted-text">
                {plural(suggested.length, 'header')} look like steps of work.{' '}
                <button
                  type="button"
                  className="trk-link-button"
                  onClick={() => apply(suggested.reduce((next, index) => setRole(next, index, 'subtask'), choices))}
                >
                  Make {suggested.length === 1 ? 'it a subtask' : 'them subtasks'}
                </button>
              </p>
            )}

            <div className="trk-import-preview" aria-live="polite">
              {task < 0 ? (
                <p>
                  <AlertTriangle size={14} aria-hidden="true" />{' '}
                  {following
                    ? 'Choose the Task name header: it is how each row is recognised on every sync.'
                    : 'No Task name header: the rows come in as plain rows, and you can make tasks from them later.'}
                </p>
              ) : (
                <>
                  {preview?.example && (
                    <p>
                      For example, <strong>{preview.example.task}</strong> becomes a task
                      {preview.example.subtasks.length > 0 && (
                        <>
                          {' '}
                          with subtasks <strong>{preview.example.subtasks.join(' · ')}</strong>
                        </>
                      )}
                      {preview.example.rowsUnder > 0 && (
                        <>
                          {preview.example.subtasks.length ? ', plus' : ' with'}{' '}
                          {plural(preview.example.rowsUnder, 'row')} under it as subtasks
                        </>
                      )}
                      .
                    </p>
                  )}
                  <p className="trk-import-totals">
                    {canCreateTasks ? (
                      <>
                        <strong>{plural(preview?.tasks || 0, 'task')}</strong>
                        {' · '}
                        <strong>{plural(preview?.subtasks || 0, 'subtask')}</strong>
                      </>
                    ) : (
                      <strong>{plural(rowCount, 'row')}</strong>
                    )}
                    {preview?.undecided ? ` · ${plural(preview.undecided, 'row')} above the first task name` : ''}
                  </p>
                  {nameCheck && nameCheck.repeated > 0 && (
                    <p className="trk-muted-text">
                      {plural(nameCheck.repeated, 'row')} {nameCheck.repeated === 1 ? 'uses a name' : 'use names'} from
                      a row above; each is still its own task.
                    </p>
                  )}
                </>
              )}
            </div>

            <details className="trk-advanced">
              <summary>Advanced: column names, types and existing columns</summary>
              <div className="trk-map-scroll">
                <table className="trk-map">
                  <thead>
                    <tr>
                      <th scope="col">Use</th>
                      <th scope="col">Header</th>
                      <th scope="col">Goes to</th>
                      <th scope="col">Name and type</th>
                    </tr>
                  </thead>
                  <tbody>
                    {mappings.map(mapping => {
                      const target = existing.find(column => column.id === mapping.target)
                      const looksSecret = mapping.type === 'secret'
                      return (
                        <tr key={mapping.index} className={mapping.include ? '' : 'off'}>
                          <td>
                            <input
                              type="checkbox"
                              checked={mapping.include}
                              aria-label={`Bring in ${source.headers[mapping.index]}`}
                              onChange={event => change(mapping.index, { include: event.target.checked })}
                            />
                          </td>
                          <td>
                            <strong>{source.headers[mapping.index]}</strong>
                          </td>
                          <td>
                            <select
                              aria-label={`Where ${source.headers[mapping.index]} goes`}
                              value={mapping.target}
                              disabled={!mapping.include}
                              onChange={event => {
                                const column = existing.find(item => item.id === event.target.value)
                                change(
                                  mapping.index,
                                  column
                                    ? { target: column.id, name: column.name, type: column.type }
                                    : { target: 'new' },
                                )
                              }}
                            >
                              <option value="new">A new column</option>
                              {existing
                                .filter(column => MAPPABLE.includes(column.type))
                                .map(column => (
                                  <option key={column.id} value={column.id}>
                                    {column.name}
                                  </option>
                                ))}
                            </select>
                          </td>
                          <td>
                            {target ? (
                              <span className="trk-muted-text">
                                {COLUMN_TYPES.find(item => item.type === target.type)?.label}
                              </span>
                            ) : (
                              <div className="trk-map-new">
                                <input
                                  aria-label={`Name for ${source.headers[mapping.index]}`}
                                  value={mapping.name}
                                  maxLength={TRACKER_LIMITS.columnName}
                                  disabled={!mapping.include}
                                  onChange={event => change(mapping.index, { name: event.target.value })}
                                />
                                <select
                                  aria-label={`Type for ${source.headers[mapping.index]}`}
                                  value={mapping.type}
                                  disabled={!mapping.include}
                                  onChange={event => change(mapping.index, { type: event.target.value as ColumnType })}
                                >
                                  {IMPORT_TYPES.filter(item => !following || item.type !== 'secret').map(item => (
                                    <option key={item.type} value={item.type}>
                                      {item.label}
                                    </option>
                                  ))}
                                </select>
                              </div>
                            )}
                            {mapping.include && looksSecret && (
                              <small className="trk-secret-note">
                                <LockKeyhole size={12} aria-hidden="true" /> Stored encrypted, hidden in the grid, left
                                out of exports.
                              </small>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </details>

            {plan.fatal && (
              <p className="trk-field-error" role="alert">
                <AlertTriangle size={14} aria-hidden="true" /> {plan.fatal}
              </p>
            )}
            {plan.warnings.length > 0 && (
              <ul className="trk-issues">
                {plan.warnings.slice(0, 6).map(warning => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            )}
            {plan.problems.length > 0 && (
              <details className="trk-issues">
                <summary>{plural(plan.problems.length, 'cell')} could not be read and will be left empty</summary>
                <ul>
                  {plan.problems.slice(0, 20).map((problem, at) => (
                    <li key={at}>
                      Row {problem.row}, {problem.column}: “{problem.value}” — {problem.message}
                    </li>
                  ))}
                  {plan.problems.length > 20 && <li>…and {plan.problems.length - 20} more.</li>}
                </ul>
              </details>
            )}
          </>
        )}

        {step === 'place' && source && plan && (
          <>
            {!tracker && (
              <div className="trk-import-new">
                <label className="trk-field-block">
                  Tracker name
                  <input
                    value={name}
                    maxLength={TRACKER_LIMITS.nameLength}
                    onChange={event => setName(event.target.value)}
                    autoFocus
                  />
                </label>
                <TrackerClientPicker clients={clients} value={clientIds} onChange={setClientIds} />
                <label className="trk-field-block">
                  Project
                  <select value={projectId} onChange={event => setProjectId(event.target.value)}>
                    <option value="">None</option>
                    {openProjects(projectId).map(project => (
                      <option key={project.id} value={project.id}>
                        {project.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="trk-checkline">
                  <input type="checkbox" checked={onlyMe} onChange={event => setOnlyMe(event.target.checked)} /> Only I
                  can see this tracker
                </label>
              </div>
            )}

            {makesTasks && (
              <fieldset className="trk-task-place">
                <legend>
                  The {plural(preview?.tasks || 0, 'task')} and {plural(preview?.subtasks || 0, 'subtask')} go under
                </legend>
                <div className="trk-import-new">
                  {taskClients.length === 1 ? (
                    <p className="trk-field-block">
                      Client
                      <strong>{taskClients[0].name}</strong>
                    </p>
                  ) : (
                    <label className="trk-field-block">
                      Client
                      <select value={taskClientId} onChange={event => setTaskClientId(event.target.value)}>
                        <option value="">Choose the client</option>
                        {[...taskClients]
                          .sort((a, b) => a.name.localeCompare(b.name))
                          .map(client => (
                            <option key={client.id} value={client.id}>
                              {client.name}
                            </option>
                          ))}
                      </select>
                    </label>
                  )}
                  {tracker ? (
                    <label className="trk-field-block">
                      Project
                      <select value={taskProjectId} onChange={event => setTaskProjectId(event.target.value)}>
                        <option value="">No project</option>
                        {openProjects(taskProjectId).map(project => (
                          <option key={project.id} value={project.id}>
                            {project.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : (
                    <p className="trk-field-block">
                      Project
                      <strong>{projects.find(project => project.id === projectId)?.name || 'No project'}</strong>
                      <small className="trk-muted-text">The tracker’s project, above.</small>
                    </p>
                  )}
                </div>
                <label className="trk-checkline">
                  <input
                    type="checkbox"
                    checked={reviewFirst}
                    onChange={event => setReviewFirst(event.target.checked)}
                  />{' '}
                  Review row by row first (untick rows, move a row under another task)
                </label>
              </fieldset>
            )}
            {!makesTasks && (
              <p className="trk-muted-text">
                {plural(rowCount, 'row')} come in as plain rows
                {canCreateTasks ? '. You can make tasks from them later.' : '.'}
              </p>
            )}
          </>
        )}

        {error && (
          <p className="trk-field-error" role="alert">
            {error}
          </p>
        )}
        <div className="k-dialog-actions">
          {step !== 'data' && (
            <button
              type="button"
              className="trk-button"
              disabled={busy}
              onClick={() => {
                setStep(step === 'place' ? 'headers' : 'data')
                setError('')
              }}
            >
              Back
            </button>
          )}
          <span className="trk-spacer" />
          {(progress || looking) && (
            <span className="trk-muted-text" role="status">
              {progress || 'Opening…'}
            </span>
          )}
          {partial && (
            <button
              type="button"
              className="trk-button"
              onClick={() => onDone(partial.trackerId, partial.imported, partial.ids)}
            >
              Open what was imported
            </button>
          )}
          <button type="button" className="trk-button" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          {step === 'data' && (
            <button
              type="button"
              className="trk-button primary"
              disabled={kind === 'file' ? !text.trim() : !sheet || !tab || looking}
              onClick={() => (kind === 'file' ? read() : void readSheet())}
            >
              Next
            </button>
          )}
          {step === 'headers' && (
            <button
              type="button"
              className="trk-button primary"
              disabled={Boolean(plan?.fatal) || (following && task < 0)}
              onClick={toPlace}
            >
              Next
            </button>
          )}
          {step === 'place' && (
            <button
              type="button"
              className="trk-button primary"
              disabled={busy || Boolean(plan?.fatal)}
              onClick={finish}
            >
              {finishLabel}
            </button>
          )}
        </div>
      </div>
    </Dialog>
  )
}
