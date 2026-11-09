import { useMemo, useState } from 'react'
import { X } from 'lucide-react'
import { isClosedProject } from '../tasks/lifecycle'
import { TRACKER_PROJECTS } from './trackerModel'
import { contractKey } from './trackerProjects'

export type PickerProject = {
  id: string
  name: string
  clientId?: string
  seedsId?: string
  seedsArchived?: boolean
  archived?: boolean
  contractNumber?: string
}

/**
 * Chooses a tracker's projects by typing part of the name or the contract number, like the client picker. Every open
 * project can be found (Seeds first, the tracker's clients' first); the first chosen is the default.
 */
export default function TrackerProjectPicker({
  projects,
  clients,
  clientIds,
  value,
  onChange,
}: {
  projects: PickerProject[]
  clients: { id: string; name: string }[]
  /** The tracker's clients: their projects come first, and are suggested before anything is typed. */
  clientIds: string[]
  value: string[]
  onChange: (ids: string[], picked?: PickerProject) => void
}) {
  const [query, setQuery] = useState('')
  const byId = useMemo(() => new Map(projects.map(project => [project.id, project])), [projects])
  const clientName = (id?: string) => (id && clients.find(client => client.id === id)?.name) || ''
  const open = useMemo(
    () =>
      projects
        .filter(project => !isClosedProject(project))
        .sort(
          (a, b) =>
            Number(!clientIds.includes(a.clientId || '')) - Number(!clientIds.includes(b.clientId || '')) ||
            Number(!a.seedsId) - Number(!b.seedsId) ||
            a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }),
        ),
    [projects, clientIds],
  )
  const matches = useMemo(() => {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
    if (!words.length) return []
    const contract = contractKey(query)
    return open
      .filter(project => {
        if (value.includes(project.id)) return false
        if (contract && contractKey(project.contractNumber).includes(contract)) return true
        const text = `${project.name} ${project.contractNumber || ''} ${clientName(project.clientId)}`.toLowerCase()
        return words.every(word => text.includes(word))
      })
      .slice(0, 10)
  }, [open, query, value, clients])
  const suggested =
    query.trim() === ''
      ? open.filter(project => !value.includes(project.id) && clientIds.includes(project.clientId || '')).slice(0, 6)
      : []
  const full = value.length >= TRACKER_PROJECTS
  const add = (project: PickerProject) => {
    if (!full) onChange([...value, project.id], project)
    setQuery('')
  }
  const label = (project: PickerProject) => (
    <>
      <span>{project.name}</span>
      <small>
        {[project.contractNumber, clientName(project.clientId), project.seedsId ? '' : 'Before Seeds']
          .filter(Boolean)
          .join(' · ')}
      </small>
    </>
  )
  return (
    <div className="trk-field-block trk-clients" role="group" aria-label="Projects">
      <span>Projects</span>
      <div className="trk-client-chips">
        {value.map((id, at) => {
          const project = byId.get(id)
          const name = project?.name || 'Unknown project'
          return (
            <span key={id} className="trk-client-chip" title={project?.contractNumber || undefined}>
              {name}
              {project?.contractNumber && <small className="trk-chip-note">{project.contractNumber}</small>}
              {at === 0 && value.length > 1 && <small className="trk-chip-note">default</small>}
              {at > 0 && (
                <button
                  type="button"
                  className="trk-chip-text"
                  title="Make this the default project"
                  onClick={() => onChange([id, ...value.filter(other => other !== id)])}
                >
                  ★
                </button>
              )}
              <button
                type="button"
                aria-label={`Remove ${name}`}
                onClick={() => onChange(value.filter(item => item !== id))}
              >
                <X size={12} aria-hidden="true" />
              </button>
            </span>
          )
        })}
        {!value.length && <span className="trk-muted">No project yet</span>}
      </div>
      <input
        type="search"
        value={query}
        disabled={full}
        placeholder={
          full ? `Up to ${TRACKER_PROJECTS} projects` : 'Add a project: type its name or contract number (SLSS #)'
        }
        aria-label="Add a project to this tracker"
        onChange={event => setQuery(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Enter') {
            event.preventDefault()
            if (matches[0]) add(matches[0])
          }
        }}
      />
      {query.trim() !== '' && (
        <div className="trk-client-options trk-project-options" role="listbox" aria-label="Matching projects">
          {matches.map(project => (
            <button type="button" role="option" aria-selected="false" key={project.id} onClick={() => add(project)}>
              {label(project)}
            </button>
          ))}
          {!matches.length && <p className="trk-muted-text">No open project matches.</p>}
        </div>
      )}
      {suggested.length > 0 && !full && (
        <div className="trk-client-quick">
          {suggested.map(project => (
            <button
              type="button"
              key={project.id}
              title={project.contractNumber || undefined}
              onClick={() => add(project)}
            >
              + {project.name}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
