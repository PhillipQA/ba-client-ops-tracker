import { useState, type FormEvent } from 'react'
import { TRACKER_LIMITS, type Tracker } from './trackerModel'
import { Dialog } from './trackerUi'

type Props = {
  tracker: Tracker
  clients: { id: string; name: string }[]
  projects: { id: string; name: string }[]
  onClose: () => void
  onSave: (body: { name: string; clientId: string; projectId: string }) => Promise<void>
}

/** Rename a tracker and change which client and project it belongs to. */
export default function TrackerDetailsDialog({ tracker, clients, projects, onClose, onSave }: Props) {
  const [name, setName] = useState(tracker.name)
  const [clientId, setClientId] = useState(tracker.clientId)
  const [projectId, setProjectId] = useState(tracker.projectId)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (busy) return
    if (!name.trim()) return setError('Enter a tracker name.')
    setBusy(true); setError('')
    try { await onSave({ name: name.trim(), clientId, projectId }); onClose() }
    catch (e) { setError(e instanceof Error ? e.message : 'The tracker could not be updated.'); setBusy(false) }
  }
  return <Dialog title="Tracker details" eyebrow="Edit" onClose={onClose} busy={busy}>
    <form className="trk-form" onSubmit={event => void submit(event)}>
      <label className="trk-field-block">Name<input value={name} maxLength={TRACKER_LIMITS.nameLength} onChange={event => setName(event.target.value)} autoFocus required /></label>
      <label className="trk-field-block">Client<select value={clientId} onChange={event => setClientId(event.target.value)}>
        <option value="">None</option>{clientId && !clients.some(client => client.id === clientId) && <option value={clientId}>Unknown client</option>}{clients.map(client => <option key={client.id} value={client.id}>{client.name}</option>)}</select></label>
      <label className="trk-field-block">Project<select value={projectId} onChange={event => setProjectId(event.target.value)}>
        <option value="">None</option>{projectId && !projects.some(project => project.id === projectId) && <option value={projectId}>Unknown project</option>}{projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
      {error && <p className="trk-field-error" role="alert">{error}</p>}
      <div className="trk-dialog-actions"><span className="trk-spacer" /><button type="button" className="trk-button" disabled={busy} onClick={onClose}>Cancel</button><button type="submit" className="trk-button primary" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button></div>
    </form>
  </Dialog>
}
