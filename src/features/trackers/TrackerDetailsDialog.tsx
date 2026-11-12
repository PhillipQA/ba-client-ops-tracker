import { useState, type FormEvent } from 'react'
import { TRACKER_LIMITS, TRACKER_PROJECTS, type Tracker, trackerProjectIds } from './trackerModel'
import { Dialog } from './trackerUi'
import TrackerClientPicker from './TrackerClientPicker'
import TrackerProjectPicker from './TrackerProjectPicker'
import TrackerUsersField from './TrackerUsersField'
import { userReason, usersOf } from './trackerFolders'

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
  /** Active people on the account, for the Users list. */
  people: { id: string; name: string }[]
  onClose: () => void
  onSave: (body: { name: string; clientIds: string[]; projectIds: string[]; members?: string[] }) => Promise<void>
}

/**
 * Rename a tracker and change its clients and projects. A tracker can have several projects (one client often has a
 * project, and contract, per site); the default one takes new rows that do not say which project they are for.
 */
export default function TrackerDetailsDialog({ tracker, clients, projects, people, onClose, onSave }: Props) {
  const [name, setName] = useState(tracker.name)
  // Users: the creator and the people on its projects come automatically; others are added by hand.
  const [members, setMembers] = useState<string[]>(tracker.members || [])
  const automatic = usersOf(tracker)
    .filter(id => userReason(tracker, id) !== 'added')
    .map(id => ({ id, why: userReason(tracker, id) === 'creator' ? 'Creator' : 'On its project' }))
  const [clientIds, setClientIds] = useState<string[]>(
    tracker.clientIds?.length ? tracker.clientIds : tracker.clientId ? [tracker.clientId] : [],
  )
  const [projectIds, setProjectIds] = useState<string[]>(trackerProjectIds(tracker))
  // Picking a Seeds project brings its client (the Seeds parent); the tracker's other clients stay.
  const pickProjects = (ids: string[], picked?: { clientId?: string; seedsId?: string }) => {
    setProjectIds(ids)
    if (picked?.seedsId && picked.clientId && !clientIds.includes(picked.clientId))
      setClientIds([...clientIds, picked.clientId])
  }
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
      // Added people go only when they changed, so other edits work before the schema v36 update is run.
      const changed = members.join() !== (tracker.members || []).join()
      await onSave({ name: name.trim(), clientIds, projectIds, ...(tracker.canManage && changed ? { members } : {}) })
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
        <TrackerProjectPicker
          projects={projects}
          clients={clients}
          clientIds={clientIds}
          value={projectIds}
          onChange={pickProjects}
        />
        <p className="trk-muted-text">
          Type a project's name or contract number to add it; ★ makes one the default. Each row goes to its task's
          project; a row with no task yet goes to the project whose contract number is in its Contract number column
          (for example SLSS #), else to the default project.
        </p>
        <TrackerUsersField
          people={people}
          automatic={automatic}
          value={members}
          onChange={setMembers}
          canChange={tracker.canManage}
        />
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
