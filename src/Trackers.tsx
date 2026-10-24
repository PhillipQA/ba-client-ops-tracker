import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { Lock, Plus, Search, Table2, Upload } from 'lucide-react'
import { TRACKER_LIMITS, columnTypeLabel, type Tracker } from './trackerModel'
import { TRACKER_TEMPLATES, templateById } from './trackerTemplates'
import { trackerApi } from './trackerApi'
import { rememberTracker, rememberedTracker } from './trackerNav'
import TrackerClientPicker from './TrackerClientPicker'
import type { TaskDraft } from './TrackerWork'

const clientsOf = (tracker: Tracker) => tracker.clientIds?.length ? tracker.clientIds : tracker.clientId ? [tracker.clientId] : []
import TrackerScreen from './TrackerScreen'
import TrackerImportDialog from './TrackerImportDialog'
import { Dialog, Notice, niceTime, plural } from './trackerUi'
import type { Client, Project, UserAccount, WorkItem } from './types'
import './trackers.css'
import ClientSelect from './ClientSelect'

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
}

const remembered = rememberedTracker
const remember = rememberTracker

function NewTrackerDialog({ initialTemplate, clients, projects, onClose, onCreated }: { initialTemplate: string; clients: Client[]; projects: Project[]; onClose: () => void; onCreated: (tracker: Tracker) => void }) {
  const [templateId, setTemplateId] = useState(initialTemplate)
  const [name, setName] = useState(initialTemplate === 'blank' ? '' : templateById(initialTemplate)?.name || '')
  const [touched, setTouched] = useState(false)
  const [clientIds, setClientIds] = useState<string[]>([])
  const [projectId, setProjectId] = useState('')
  const [onlyMe, setOnlyMe] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const template = templateById(templateId)!
  const pick = (id: string) => { setTemplateId(id); if (!touched) setName(id === 'blank' ? '' : templateById(id)?.name || '') }
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (busy) return
    if (!name.trim()) return setError('Enter a name for the tracker.')
    setBusy(true); setError('')
    try {
      const result = await trackerApi.create({ name: name.trim(), columns: template.columns, template: template.id, clientIds, projectId, private: onlyMe })
      onCreated(result.tracker)
    } catch (e) { setError(e instanceof Error ? e.message : 'The tracker could not be created.'); setBusy(false) }
  }
  return <Dialog title="New tracker" eyebrow="Trackers" onClose={onClose} wide busy={busy}>
    <form className="trk-new" onSubmit={event => void submit(event)}>
      <fieldset className="trk-templates"><legend>Start from</legend>
        {TRACKER_TEMPLATES.map(item => <label key={item.id} className={`trk-template${item.id === templateId ? ' on' : ''}`}>
          <input type="radio" name="template" value={item.id} checked={item.id === templateId} onChange={() => pick(item.id)} />
          <strong>{item.name}</strong><span>{item.about}</span>
          <small>{item.columns.slice(0, 5).map(column => column.name).join(' · ')}{item.columns.length > 5 ? ` · +${item.columns.length - 5}` : ''}</small>
        </label>)}
      </fieldset>
      <div className="trk-new-fields">
        <label className="trk-field-block">Name<input value={name} maxLength={TRACKER_LIMITS.nameLength} onChange={event => { setName(event.target.value); setTouched(true) }} autoFocus required /></label>
        <TrackerClientPicker clients={clients} value={clientIds} onChange={setClientIds} />
        <label className="trk-field-block">Project<select value={projectId} onChange={event => setProjectId(event.target.value)}><option value="">None</option>{projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
        <label className="trk-checkline"><input type="checkbox" checked={onlyMe} onChange={event => setOnlyMe(event.target.checked)} /> Only I can see this tracker</label>
        <p className="trk-muted-text">Everyone in the account who has Trackers can open a tracker unless you make it private. You can change the columns afterwards.</p>
      </div>
      {error && <p className="trk-field-error" role="alert">{error}</p>}
      <div className="trk-dialog-actions"><span className="trk-spacer" /><button type="button" className="trk-button" disabled={busy} onClick={onClose}>Cancel</button><button type="submit" className="trk-button primary" disabled={busy}>{busy ? 'Creating…' : 'Create tracker'}</button></div>
    </form>
  </Dialog>
}

export default function Trackers(props: Props) {
  const [openId, setOpenIdState] = useState(remembered)
  const setOpenId = (id: string) => { remember(id); setOpenIdState(id) }
  const [trackers, setTrackers] = useState<Tracker[] | null>(null)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [clientFilter, setClientFilter] = useState('')
  const [showArchived, setShowArchived] = useState(false)
  const [creating, setCreating] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)

  const load = useCallback(async (signal?: AbortSignal) => {
    try { const result = await trackerApi.list(signal); setTrackers(result.trackers); setError('') }
    catch (e) { if ((e as Error)?.name === 'AbortError') return; setError(e instanceof Error ? e.message : 'Trackers could not be loaded.') }
  }, [])
  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
    return () => controller.abort()
  }, [load])

  const clientName = useCallback((id: string) => props.clients.find(client => client.id === id)?.name || '', [props.clients])
  const projectName = useCallback((id: string) => props.projects.find(project => project.id === id)?.name || '', [props.projects])
  const shown = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean)
    return (trackers || []).filter(tracker => (showArchived || !tracker.archived) && (!clientFilter || clientsOf(tracker).includes(clientFilter))
      && words.every(word => `${tracker.name} ${clientsOf(tracker).map(clientName).join(' ')} ${projectName(tracker.projectId)} ${tracker.createdByName}`.toLowerCase().includes(word)))
  }, [trackers, query, clientFilter, showArchived, clientName, projectName])
  const archivedCount = (trackers || []).filter(tracker => tracker.archived).length
  const people = useMemo(() => props.accounts.filter(account => account.status === 'Active').map(account => ({ id: account.id, name: account.name || account.username })), [props.accounts])

  if (openId) return <TrackerScreen key={openId} trackerId={openId} isAdmin={props.isAdmin} items={props.items} clients={props.clients} projects={props.projects} accounts={props.accounts} today={props.today}
    onBack={() => { setOpenId(''); void load() }} onOpenTask={props.onOpenTask} isTaskClosed={props.isTaskClosed} onCreateTasks={props.onCreateTasks} onListChanged={() => void load()} />

  return <div className="trk-page trk-home">
    <header className="trk-header">
      <div className="trk-title"><div><h2>Trackers</h2><p className="trk-muted-text">Sheets you shape yourself. Add the columns you need, link rows to tasks, and keep access details protected.</p></div></div>
      {props.canCreate && <div className="trk-header-actions">
        <button type="button" className="trk-button" onClick={() => setImporting(true)}><Upload size={14} aria-hidden="true" /> Import a sheet</button>
        <button type="button" className="trk-button primary" onClick={() => setCreating('blank')}><Plus size={14} aria-hidden="true" /> New tracker</button>
      </div>}
    </header>
    {error && <Notice kind="error">{error}</Notice>}

    {trackers && trackers.filter(tracker => !tracker.archived).length === 0 && !error && <section className="trk-welcome" aria-label="Start a tracker">
      <h3>Start your first tracker</h3>
      <p className="trk-muted-text">Pick a starting point. You can rename, add and remove columns afterwards.</p>
      <div className="trk-template-grid">
        {TRACKER_TEMPLATES.filter(item => item.id !== 'blank').map(item => <button type="button" key={item.id} className="trk-template-card" disabled={!props.canCreate} onClick={() => setCreating(item.id)}>
          <Table2 size={18} aria-hidden="true" /><strong>{item.name}</strong><span>{item.about}</span>
        </button>)}
      </div>
      {!props.canCreate && <p className="trk-muted-text">Your role can view trackers but not create them.</p>}
    </section>}

    {trackers && trackers.length > 0 && <>
      <div className="trk-toolbar">
        <label className="trk-search"><Search size={14} aria-hidden="true" /><input type="search" placeholder="Search trackers" aria-label="Search trackers" value={query} onChange={event => setQuery(event.target.value)} /></label>
        <label className="trk-inline-select">Client<ClientSelect clients={props.clients} value={clientFilter} onChange={(value) => setClientFilter(value)} extra={[{ value: '', label: 'All clients' }]} /></label>
        {archivedCount > 0 && <label className="trk-checkline"><input type="checkbox" checked={showArchived} onChange={event => setShowArchived(event.target.checked)} /> Show archived ({archivedCount})</label>}
      </div>
      <section className="trk-list" aria-label="Trackers">
        <div className="trk-list-row head" role="row"><span role="columnheader">Name</span><span role="columnheader">Client and project</span><span role="columnheader">Rows</span><span role="columnheader">Columns</span><span role="columnheader">Updated</span><span role="columnheader">Created by</span></div>
        {shown.map(tracker => <div className="trk-list-row" role="row" key={tracker.id}>
          <span role="cell" className="trk-list-name"><button type="button" className="trk-link-button" onClick={() => setOpenId(tracker.id)}>{tracker.name}</button>
            {tracker.private && <span className="trk-chip"><Lock size={11} aria-hidden="true" /> Only you</span>}{tracker.archived && <span className="trk-chip warn">Archived</span>}</span>
          <span role="cell">{[clientsOf(tracker).map(clientName).join(', '), projectName(tracker.projectId)].filter(Boolean).join(' · ') || <span className="trk-muted">—</span>}</span>
          <span role="cell">{tracker.rowCount.toLocaleString('en')}</span>
          <span role="cell" title={tracker.columns.map(column => `${column.name} (${columnTypeLabel(column.type)})`).join(', ')}>{tracker.columns.length}</span>
          <span role="cell">{niceTime(tracker.updatedAt)}</span>
          <span role="cell">{tracker.createdByName || <span className="trk-muted">—</span>}</span>
        </div>)}
        {!shown.length && <p className="trk-empty-line">No tracker matches. {plural((trackers || []).length, 'tracker')} in total.</p>}
      </section>
    </>}
    {!trackers && !error && <p className="trk-muted-text" role="status">Loading trackers…</p>}

    {creating && <NewTrackerDialog initialTemplate={creating} clients={props.clients} projects={props.projects} onClose={() => setCreating(null)}
      onCreated={tracker => { setCreating(null); setOpenId(tracker.id); void load() }} />}
    {importing && <TrackerImportDialog clients={props.clients} projects={props.projects} people={people} today={props.today}
      onClose={() => setImporting(false)} onDone={trackerId => { setImporting(false); setOpenId(trackerId); void load() }} />}
  </div>
}
