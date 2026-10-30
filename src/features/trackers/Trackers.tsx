import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { LayoutTemplate, Link2, Lock, Plus, Search, Table2, Upload } from 'lucide-react'
import { TRACKER_LIMITS, columnTypeLabel, type Tracker } from './trackerModel'
import { templateChoices, templateRows, withDoneColumn, type TemplateChoice } from './trackerTemplates'
import { TemplatesDialog, TemplateTag, useTrackerTemplates } from './TemplateManager'
import { createRowTasks } from './trackerTaskActions'
import type { TaskPatch } from './trackerTasks'
import { trackerApi } from './trackerApi'
import { rememberTracker, rememberedTracker } from './trackerNav'
import { VIEW_PATHS, opensElsewhere, pathForTracker, trackerIdFromPath } from '../../app/routes'
import TrackerClientPicker from './TrackerClientPicker'
import type { TaskDraft } from './TrackerWork'

const clientsOf = (tracker: Tracker) =>
  tracker.clientIds?.length ? tracker.clientIds : tracker.clientId ? [tracker.clientId] : []
import TrackerScreen from './TrackerScreen'
import TrackerImportDialog from './TrackerImportDialog'
import { Dialog, Notice, niceTime, plural } from './trackerUi'
import type { Client, Project, UserAccount, WorkItem } from '../../shared/types'
import './trackers.css'
import ClientSelect from '../../shared/ui/SearchSelect'

type Props = {
  isAdmin: boolean
  canCreate: boolean
  items: WorkItem[]
  clients: Client[]
  projects: Project[]
  accounts: UserAccount[]
  today: string
  onOpenTask?: (taskId: string) => void
  isTaskClosed: (status: string) => boolean
  onCreateTasks?: (drafts: TaskDraft[]) => Promise<WorkItem[]>
  /** Changes tasks from a tracker (dates, titles, done); see trackerTasks. */
  onUpdateTasks?: (patches: TaskPatch[]) => Promise<boolean>
  currentUserId?: string
}

const remembered = rememberedTracker
const remember = rememberTracker

function NewTrackerDialog({
  initialTemplate,
  choices,
  clients,
  projects,
  items,
  currentUserId,
  onCreateTasks,
  onClose,
  onCreated,
}: {
  initialTemplate: string
  /** The templates to start from: built-in ones, changed or not, and the account's own. */
  choices: TemplateChoice[]
  clients: Client[]
  projects: Project[]
  items: WorkItem[]
  currentUserId: string
  onCreateTasks?: (drafts: TaskDraft[]) => Promise<WorkItem[]>
  onClose: () => void
  onCreated: (tracker: Tracker, note?: string) => void
}) {
  const templateById = (id: string) => choices.find(choice => choice.id === id)
  const [templateId, setTemplateId] = useState(templateById(initialTemplate) ? initialTemplate : 'blank')
  const [name, setName] = useState(initialTemplate === 'blank' ? '' : templateById(initialTemplate)?.name || '')
  const [touched, setTouched] = useState(false)
  const [clientIds, setClientIds] = useState<string[]>([])
  const [projectId, setProjectId] = useState('')
  const [onlyMe, setOnlyMe] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  // Templates with starter rows (Project timeline): whether to add them, and the date their schedule starts from.
  const [withRows, setWithRows] = useState(true)
  const [withTasks, setWithTasks] = useState(true)
  const [startDate, setStartDate] = useState(() => {
    const now = new Date()
    const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + ((8 - now.getDay()) % 7 || 7))
    return `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}-${String(next.getDate()).padStart(2, '0')}`
  })
  const template = templateById(templateId)!
  const starter = template.rows?.length ? template.rows.length : 0
  const pick = (id: string) => {
    setTemplateId(id)
    if (!touched) setName(id === 'blank' ? '' : templateById(id)?.name || '')
  }
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (busy) return
    if (!name.trim()) return setError('Enter a name for the tracker.')
    setBusy(true)
    setError('')
    try {
      const result = await trackerApi.create({
        name: name.trim(),
        columns: template.columns,
        template: template.saved && !template.builtIn ? 'saved' : template.id,
        ...(template.stepTasks !== undefined ? { stepTasks: template.stepTasks } : {}),
        clientIds,
        projectId,
        private: onlyMe,
      })
      let tracker = result.tracker
      // The done column (Status → Done) completes and reopens the linked tasks, and follows them.
      const doneColumns = withDoneColumn(template, tracker.columns)
      if (doneColumns)
        tracker =
          (await trackerApi.saveColumns(tracker.id, doneColumns, tracker.revision).catch(() => null))?.tracker ||
          tracker
      if (starter && withRows) {
        // The tracker exists either way; if the rows cannot be added, it opens empty and they can be typed in.
        const added = await trackerApi
          .addRows(tracker.id, templateRows(template, tracker.columns, startDate))
          .catch(() => null)
        tracker = added ? { ...tracker, rowCount: added.rows.length } : tracker
        if (added && template.tasks && withTasks && onCreateTasks && clientIds.length) {
          const made = await createRowTasks({
            tracker: { ...tracker, clientIds },
            rows: added.rows,
            items,
            currentUserId,
            onCreateTasks,
          }).catch(error => ({ created: 0, error: error instanceof Error ? error.message : String(error) }))
          onCreated(
            tracker,
            'error' in made && made.error
              ? `The tracker was made, but its tasks were not: ${made.error}`
              : made.created
                ? `${plural(made.created, 'task')} made in Tasks: one for each phase and a subtask for each row.`
                : undefined,
          )
          return
        }
      }
      onCreated(tracker)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The tracker could not be created.')
      setBusy(false)
    }
  }
  return (
    <Dialog title="New tracker" eyebrow="Trackers" onClose={onClose} wide busy={busy}>
      <form className="trk-new" onSubmit={event => void submit(event)}>
        <fieldset className="trk-templates">
          <legend>Start from</legend>
          {choices.map(item => (
            <label key={item.id} className={`trk-template${item.id === templateId ? ' on' : ''}`}>
              <input
                type="radio"
                name="template"
                value={item.id}
                checked={item.id === templateId}
                onChange={() => pick(item.id)}
              />
              <strong>
                {item.name}
                <TemplateTag choice={item} />
              </strong>
              <span>{item.about}</span>
              <small>
                {item.columns
                  .slice(0, 5)
                  .map(column => column.name)
                  .join(' · ')}
                {item.columns.length > 5 ? ` · +${item.columns.length - 5}` : ''}
              </small>
            </label>
          ))}
        </fieldset>
        <div className="trk-new-fields">
          <label className="trk-field-block">
            Name
            <input
              value={name}
              maxLength={TRACKER_LIMITS.nameLength}
              onChange={event => {
                setName(event.target.value)
                setTouched(true)
              }}
              autoFocus
              required
            />
          </label>
          <TrackerClientPicker clients={clients} value={clientIds} onChange={setClientIds} />
          <label className="trk-field-block">
            Project
            <select value={projectId} onChange={event => setProjectId(event.target.value)}>
              <option value="">None</option>
              {projects.map(project => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </label>
          {starter > 0 && (
            <fieldset className="trk-starter">
              <label className="trk-checkline">
                <input type="checkbox" checked={withRows} onChange={event => setWithRows(event.target.checked)} /> Start
                with the standard task list ({starter} tasks in{' '}
                {new Set(template.rows!.map(row => String(row.cells.Phase || ''))).size} phases)
              </label>
              {withRows && template.tasks && onCreateTasks && (
                <label className="trk-checkline">
                  <input
                    type="checkbox"
                    checked={withTasks && clientIds.length > 0}
                    disabled={!clientIds.length}
                    onChange={event => setWithTasks(event.target.checked)}
                  />{' '}
                  {clientIds.length
                    ? `Make a task for each phase and a subtask for each row in Tasks, assigned to you${projectId ? '' : `, in a new project “${name.trim() || 'named after the tracker'}”`}`
                    : 'Choose a client above to also make a task for each phase and a subtask for each row'}
                </label>
              )}
              {withRows && template.schedule && (
                <label className="trk-field-block">
                  Project start date
                  <input type="date" value={startDate} onChange={event => setStartDate(event.target.value)} />
                  <span className="trk-muted-text">
                    Every task gets a first Start and End from this date, on working days. Leave it empty to fill the
                    dates in yourself. You can change, add or remove any task afterwards.
                  </span>
                </label>
              )}
            </fieldset>
          )}
          <label className="trk-checkline">
            <input type="checkbox" checked={onlyMe} onChange={event => setOnlyMe(event.target.checked)} /> Only I can
            see this tracker
          </label>
          <p className="trk-muted-text">
            Everyone in the account who has Trackers can open a tracker unless you make it private. You can change the
            columns afterwards.
          </p>
        </div>
        {error && (
          <p className="trk-field-error" role="alert">
            {error}
          </p>
        )}
        <div className="k-dialog-actions">
          <span className="trk-spacer" />
          <button type="button" className="trk-button" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="trk-button primary" disabled={busy}>
            {busy ? 'Creating…' : 'Create tracker'}
          </button>
        </div>
      </form>
    </Dialog>
  )
}

export default function Trackers(props: Props) {
  // The open tracker lives in the address (/trackers/<id>). Other screens that send the person to a tracker
  // remember it first (trackerNav), and it opens when the address is just /trackers.
  const [openId, setOpenIdState] = useState(() => trackerIdFromPath(window.location.pathname) || remembered())
  const setOpenId = (id: string) => {
    remember(id)
    setOpenIdState(id)
  }
  const firstAddress = useRef(true)
  // Set when a tracker was opened from the list in this tab, so its Back button can step back in the history.
  const openedFromList = useRef(false)
  useEffect(() => {
    const { pathname, hash } = window.location
    const target = pathForTracker(openId)
    const inTrackers = pathname === VIEW_PATHS.trackers || pathname.startsWith(`${VIEW_PATHS.trackers}/`)
    if (pathname !== target) {
      try {
        if (firstAddress.current && (inTrackers || hash)) window.history.replaceState(null, '', target)
        else {
          openedFromList.current = Boolean(openId) && pathname === VIEW_PATHS.trackers
          window.history.pushState(null, '', target)
        }
      } catch {
        /* The tracker still opens; only the address is not updated. */
      }
    }
    firstAddress.current = false
  }, [openId])
  useEffect(() => {
    const onPop = () => {
      const { pathname } = window.location
      if (pathname !== VIEW_PATHS.trackers && !pathname.startsWith(`${VIEW_PATHS.trackers}/`)) return
      const id = trackerIdFromPath(pathname)
      openedFromList.current = false
      remember(id)
      setOpenIdState(id)
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])
  /** Back to the list: a step back in the history when the tracker was opened from the list, so Back and Forward agree. */
  const closeTracker = () => {
    if (openedFromList.current) {
      openedFromList.current = false
      window.history.back()
    } else setOpenId('')
  }
  const [trackers, setTrackers] = useState<Tracker[] | null>(null)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [clientFilter, setClientFilter] = useState('')
  const [showArchived, setShowArchived] = useState(false)
  const [creating, setCreating] = useState<string | null>(null)
  /** Said once when the new tracker opens, such as how many tasks were made. */
  const [createdNote, setCreatedNote] = useState('')
  const [importing, setImporting] = useState(false)
  const [managing, setManaging] = useState(false)
  const templates = useTrackerTemplates()
  const choices = useMemo(() => templateChoices(templates.saved), [templates.saved])
  // Back from Google's permission page (#sheets=enabled|denied|error): say what happened and reopen the Sheet picker.
  const [sheetReturn] = useState(() => {
    try {
      return new URLSearchParams(window.location.hash.slice(1)).get('sheets') || ''
    } catch {
      return ''
    }
  })
  const [connecting, setConnecting] = useState(sheetReturn === 'enabled')
  useEffect(() => {
    if (sheetReturn) {
      try {
        window.history.replaceState(null, '', window.location.pathname + window.location.search)
      } catch {
        /* The address keeps the note. */
      }
    }
  }, [sheetReturn])

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const result = await trackerApi.list(signal)
      setTrackers(result.trackers)
      setError('')
    } catch (e) {
      if ((e as Error)?.name === 'AbortError') return
      setError(e instanceof Error ? e.message : 'Trackers could not be loaded.')
    }
  }, [])
  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
    return () => controller.abort()
  }, [load])

  const clientName = useCallback(
    (id: string) => props.clients.find(client => client.id === id)?.name || '',
    [props.clients],
  )
  const projectName = useCallback(
    (id: string) => props.projects.find(project => project.id === id)?.name || '',
    [props.projects],
  )
  const shown = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean)
    return (trackers || []).filter(
      tracker =>
        (showArchived || !tracker.archived) &&
        (!clientFilter || clientsOf(tracker).includes(clientFilter)) &&
        words.every(word =>
          `${tracker.name} ${clientsOf(tracker).map(clientName).join(' ')} ${projectName(tracker.projectId)} ${tracker.createdByName}`
            .toLowerCase()
            .includes(word),
        ),
    )
  }, [trackers, query, clientFilter, showArchived, clientName, projectName])
  const archivedCount = (trackers || []).filter(tracker => tracker.archived).length
  const people = useMemo(
    () =>
      props.accounts
        .filter(account => account.status === 'Active')
        .map(account => ({ id: account.id, name: account.name || account.username })),
    [props.accounts],
  )

  if (openId)
    return (
      <TrackerScreen
        key={openId}
        trackerId={openId}
        isAdmin={props.isAdmin}
        items={props.items}
        clients={props.clients}
        projects={props.projects}
        accounts={props.accounts}
        today={props.today}
        onBack={() => {
          closeTracker()
          void load()
        }}
        onOpenTask={props.onOpenTask}
        isTaskClosed={props.isTaskClosed}
        onCreateTasks={props.onCreateTasks}
        onUpdateTasks={props.onUpdateTasks}
        currentUserId={props.currentUserId || ''}
        startNote={createdNote}
        onListChanged={() => void load()}
        googleReturn={sheetReturn}
      />
    )

  return (
    <div className="trk-page trk-home">
      <header className="trk-header">
        <div className="trk-title">
          <div>
            <h2>Trackers</h2>
            <p className="trk-muted-text">
              Sheets you shape yourself. Add the columns you need, link rows to tasks, and keep access details
              protected.
            </p>
          </div>
        </div>
        {props.canCreate && (
          <div className="trk-header-actions">
            <button type="button" className="trk-button" onClick={() => setImporting(true)}>
              <Upload size={14} aria-hidden="true" /> Import a sheet
            </button>
            {props.canCreate && (
              <button
                type="button"
                className="trk-button"
                onClick={() => setConnecting(true)}
                title="Make a tracker that follows a Google Sheet and keeps up with it"
              >
                <Link2 size={14} aria-hidden="true" /> From Google Sheet
              </button>
            )}
            <button type="button" className="trk-button" onClick={() => setManaging(true)}>
              <LayoutTemplate size={14} aria-hidden="true" /> Templates
            </button>
            <button type="button" className="trk-button primary" onClick={() => setCreating('blank')}>
              <Plus size={14} aria-hidden="true" /> New tracker
            </button>
          </div>
        )}
      </header>
      {error && <Notice kind="error">{error}</Notice>}

      {trackers && trackers.filter(tracker => !tracker.archived).length === 0 && !error && (
        <section className="trk-welcome" aria-label="Start a tracker">
          <h3>Start your first tracker</h3>
          <p className="trk-muted-text">Pick a starting point. You can rename, add and remove columns afterwards.</p>
          <div className="trk-template-grid">
            {choices
              .filter(item => item.id !== 'blank')
              .map(item => (
                <button
                  type="button"
                  key={item.id}
                  className="trk-template-card"
                  disabled={!props.canCreate}
                  onClick={() => setCreating(item.id)}
                >
                  <Table2 size={18} aria-hidden="true" />
                  <strong>{item.name}</strong>
                  <span>{item.about}</span>
                </button>
              ))}
          </div>
          {!props.canCreate && <p className="trk-muted-text">Your role can view trackers but not create them.</p>}
        </section>
      )}

      {trackers && trackers.length > 0 && (
        <>
          <div className="trk-toolbar">
            <label className="trk-search">
              <Search size={14} aria-hidden="true" />
              <input
                type="search"
                placeholder="Search trackers"
                aria-label="Search trackers"
                value={query}
                onChange={event => setQuery(event.target.value)}
              />
            </label>
            <label className="trk-inline-select">
              Client
              <ClientSelect
                clients={props.clients}
                value={clientFilter}
                onChange={value => setClientFilter(value)}
                extra={[{ value: '', label: 'All clients' }]}
              />
            </label>
            {archivedCount > 0 && (
              <label className="trk-checkline">
                <input
                  type="checkbox"
                  checked={showArchived}
                  onChange={event => setShowArchived(event.target.checked)}
                />{' '}
                Show archived ({archivedCount})
              </label>
            )}
          </div>
          <section className="trk-list" aria-label="Trackers">
            <div className="trk-list-row head" role="row">
              <span role="columnheader">Name</span>
              <span role="columnheader">Client and project</span>
              <span role="columnheader">Rows</span>
              <span role="columnheader">Columns</span>
              <span role="columnheader">Updated</span>
              <span role="columnheader">Created by</span>
            </div>
            {shown.map(tracker => (
              <div className="trk-list-row" role="row" key={tracker.id}>
                <span role="cell" className="trk-list-name">
                  <a
                    className="trk-link-button"
                    href={pathForTracker(tracker.id)}
                    onClick={event => {
                      if (opensElsewhere(event)) return
                      event.preventDefault()
                      setOpenId(tracker.id)
                    }}
                  >
                    {tracker.name}
                  </a>
                  {tracker.private && (
                    <span className="trk-chip">
                      <Lock size={11} aria-hidden="true" /> Only you
                    </span>
                  )}
                  {tracker.archived && <span className="trk-chip warn">Archived</span>}
                </span>
                <span role="cell">
                  {[clientsOf(tracker).map(clientName).join(', '), projectName(tracker.projectId)]
                    .filter(Boolean)
                    .join(' · ') || <span className="trk-muted">—</span>}
                </span>
                <span role="cell">{tracker.rowCount.toLocaleString('en')}</span>
                <span
                  role="cell"
                  title={tracker.columns.map(column => `${column.name} (${columnTypeLabel(column.type)})`).join(', ')}
                >
                  {tracker.columns.length}
                </span>
                <span role="cell">{niceTime(tracker.updatedAt)}</span>
                <span role="cell">{tracker.createdByName || <span className="trk-muted">—</span>}</span>
              </div>
            ))}
            {!shown.length && (
              <p className="trk-empty-line">
                No tracker matches. {plural((trackers || []).length, 'tracker')} in total.
              </p>
            )}
          </section>
        </>
      )}
      {!trackers && !error && (
        <p className="trk-muted-text" role="status">
          Loading trackers…
        </p>
      )}

      {managing && (
        <TemplatesDialog
          saved={templates.saved}
          isAdmin={props.isAdmin}
          canCreate={props.canCreate}
          missing={templates.missing}
          onSaved={templates.setSaved}
          onClose={() => setManaging(false)}
        />
      )}
      {creating && (
        <NewTrackerDialog
          initialTemplate={creating}
          choices={choices}
          clients={props.clients}
          projects={props.projects}
          items={props.items}
          currentUserId={props.currentUserId || ''}
          onCreateTasks={props.onCreateTasks}
          onClose={() => setCreating(null)}
          onCreated={(tracker, note) => {
            setCreating(null)
            if (note) setCreatedNote(note)
            setOpenId(tracker.id)
            void load()
          }}
        />
      )}
      {importing && (
        <TrackerImportDialog
          clients={props.clients}
          projects={props.projects}
          people={people}
          today={props.today}
          onClose={() => setImporting(false)}
          onDone={trackerId => {
            setImporting(false)
            setOpenId(trackerId)
            void load()
          }}
        />
      )}
      {connecting && (
        <TrackerImportDialog
          fromSheet
          clients={props.clients}
          projects={props.projects}
          people={people}
          today={props.today}
          onClose={() => setConnecting(false)}
          onDone={trackerId => {
            setConnecting(false)
            setOpenId(trackerId)
            void load()
          }}
        />
      )}
      {sheetReturn === 'denied' && !connecting && (
        <p className="trk-field-error" role="alert">
          Google Sheets was not allowed, so no Sheet can be connected. Click From Google Sheet to try again.
        </p>
      )}
      {sheetReturn === 'error' && !connecting && (
        <p className="trk-field-error" role="alert">
          Google sign-in did not finish. Click From Google Sheet to try again.
        </p>
      )}
    </div>
  )
}
