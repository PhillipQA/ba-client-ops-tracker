import { useState, type FormEvent } from 'react'
import { TRACKER_LIMITS, TRACKER_PROJECTS, type Tracker, trackerProjectIds } from './trackerModel'
import { Dialog } from './trackerUi'
import TrackerClientPicker from './TrackerClientPicker'

type Props = {
  tracker: Tracker
  clients: { id: string; name: string }[]
  projects: {
    id: string
    name: string
    clientId?: string
    seedsId?: string
    seedsArchived?: boolean
    contractNumber?: string
  }[]
  onClose: () => void
  onSave: (body: { name: string; clientIds: string[]; projectIds: string[] }) => Promise<void>
}

/**
 * Rename a tracker and change its clients and projects. A tracker can have several projects (one client often has a
 * project, and contract, per site); the default one takes new rows that do not say which project they are for.
 */
export default function TrackerDetailsDialog({ tracker, clients, projects, onClose, onSave }: Props) {
  const [name, setName] = useState(tracker.name)
  const [clientIds, setClientIds] = useState<string[]>(
    tracker.clientIds?.length ? tracker.clientIds : tracker.clientId ? [tracker.clientId] : [],
  )
  const [projectIds, setProjectIds] = useState<string[]>(trackerProjectIds(tracker))
  const [search, setSearch] = useState('')
  const chosen = new Set(projectIds)
  // Offered: projects of the tracker's clients (or with no client), open ones; plus whatever is already chosen.
  const offered = projects.filter(
    project =>
      chosen.has(project.id) ||
      (!project.seedsArchived && (!project.clientId || !clientIds.length || clientIds.includes(project.clientId))),
  )
  const term = search.trim().toLowerCase()
  const matches = (project: (typeof projects)[number]) =>
    !term || `${project.name} ${project.contractNumber || ''}`.toLowerCase().includes(term)
  const fromSeeds = offered.filter(project => project.seedsId && matches(project))
  const before = offered.filter(project => !project.seedsId && matches(project))
  const toggle = (id: string) => {
    if (chosen.has(id)) return setProjectIds(projectIds.filter(other => other !== id))
    setProjectIds([...projectIds, id])
    // A Seeds project brings its client (the Seeds parent); the tracker's other clients stay.
    const client = projects.find(project => project.id === id && project.seedsId)?.clientId
    if (client && !clientIds.includes(client)) setClientIds([...clientIds, client])
  }
  const projectName = (id: string) => projects.find(project => project.id === id)?.name || 'Unknown project'
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (busy) return
    if (!name.trim()) return setError('Enter a tracker name.')
    if (projectIds.length > TRACKER_PROJECTS) return setError(`Choose at most ${TRACKER_PROJECTS} projects.`)
    setBusy(true)
    setError('')
    try {
      await onSave({ name: name.trim(), clientIds, projectIds })
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The tracker could not be updated.')
      setBusy(false)
    }
  }
  const option = (project: (typeof projects)[number]) => (
    <label key={project.id} className="trk-project-option">
      <input type="checkbox" checked={chosen.has(project.id)} onChange={() => toggle(project.id)} />
      <span>{project.name}</span>
      {project.contractNumber && <small>{project.contractNumber}</small>}
    </label>
  )
  return (
    <Dialog title="Tracker details" eyebrow="Edit" onClose={onClose} busy={busy}>
      <form className="trk-form" onSubmit={event => void submit(event)}>
        <label className="trk-field-block">
          Name
          <input
            value={name}
            maxLength={TRACKER_LIMITS.nameLength}
            onChange={event => setName(event.target.value)}
            autoFocus
            required
          />
        </label>
        <TrackerClientPicker clients={clients} value={clientIds} onChange={setClientIds} />
        <fieldset className="trk-field-block trk-projects">
          <legend>Projects ({projectIds.length})</legend>
          <input
            type="search"
            placeholder="Find a project or contract number"
            value={search}
            onChange={event => setSearch(event.target.value)}
          />
          <div className="trk-project-list">
            {fromSeeds.length > 0 && <p className="trk-project-group">From Seeds</p>}
            {fromSeeds.map(option)}
            {before.length > 0 && fromSeeds.length > 0 && <p className="trk-project-group">Before Seeds</p>}
            {before.map(option)}
            {!fromSeeds.length && !before.length && <p className="trk-muted-text">No projects match.</p>}
          </div>
        </fieldset>
        {projectIds.length > 1 && (
          <label className="trk-field-block">
            Default project
            <select
              value={projectIds[0]}
              onChange={event =>
                setProjectIds([event.target.value, ...projectIds.filter(id => id !== event.target.value)])
              }
            >
              {projectIds.map(id => (
                <option key={id} value={id}>
                  {projectName(id)}
                </option>
              ))}
            </select>
          </label>
        )}
        <p className="trk-muted-text">
          Each row goes to its task's project. A row with no task yet goes to the project whose contract number is in
          its Contract number column (for example SLSS #), else to the default project.
        </p>
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
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </Dialog>
  )
}
