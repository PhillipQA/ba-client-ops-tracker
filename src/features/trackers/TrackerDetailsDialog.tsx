import { useState, type FormEvent } from 'react'
import { TRACKER_LIMITS, type Tracker } from './trackerModel'
import { Dialog } from './trackerUi'
import TrackerClientPicker from './TrackerClientPicker'

type Props = {
  tracker: Tracker
  clients: { id: string; name: string }[]
  projects: { id: string; name: string; clientId?: string; seedsId?: string }[]
  onClose: () => void
  onSave: (body: { name: string; clientIds: string[]; projectId: string }) => Promise<void>
}

/** Rename a tracker and change which clients and project it belongs to. */
export default function TrackerDetailsDialog({ tracker, clients, projects, onClose, onSave }: Props) {
  const [name, setName] = useState(tracker.name)
  const [clientIds, setClientIds] = useState<string[]>(
    tracker.clientIds?.length ? tracker.clientIds : tracker.clientId ? [tracker.clientId] : [],
  )
  const [projectId, setProjectId] = useState(tracker.projectId)
  const fromSeeds = projects.filter(project => project.seedsId)
  const before = projects.filter(project => !project.seedsId)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (busy) return
    if (!name.trim()) return setError('Enter a tracker name.')
    setBusy(true)
    setError('')
    try {
      await onSave({ name: name.trim(), clientIds, projectId })
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The tracker could not be updated.')
      setBusy(false)
    }
  }
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
        <label className="trk-field-block">
          Project
          <select
            value={projectId}
            onChange={event => {
              const next = event.target.value
              setProjectId(next)
              // A Seeds project brings its client (the Seeds parent); the tracker's other clients stay, so rows keep
              // their Before Seeds tasks while new ones go to Seeds.
              const client = projects.find(project => project.id === next && project.seedsId)?.clientId
              if (client && !clientIds.includes(client)) setClientIds([...clientIds, client])
            }}
          >
            <option value="">None</option>
            {projectId && !projects.some(project => project.id === projectId) && (
              <option value={projectId}>Unknown project</option>
            )}
            {fromSeeds.length > 0 ? (
              <>
                <optgroup label="From Seeds">
                  {fromSeeds.map(project => (
                    <option key={project.id} value={project.id}>
                      {project.name}
                    </option>
                  ))}
                </optgroup>
                <optgroup label="Before Seeds">
                  {before.map(project => (
                    <option key={project.id} value={project.id}>
                      {project.name}
                    </option>
                  ))}
                </optgroup>
              </>
            ) : (
              projects.map(project => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))
            )}
          </select>
        </label>
        {fromSeeds.length > 0 && (
          <p className="trk-muted-text">
            Pick a Seeds project to link this tracker to Seeds. Rows keep their Before Seeds tasks; new tasks made here
            go to the Seeds project.
          </p>
        )}
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
