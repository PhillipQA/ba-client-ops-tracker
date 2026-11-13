import { useMemo } from 'react'
import { X } from 'lucide-react'
import ClientSelect from '../../shared/ui/SearchSelect'
import type { Client, Project } from '../../shared/types'
import { AI_SCOPE_CLIENTS, projectsOfClient, type AiScope } from './aiScope'

/**
 * Chooses what the assistant looks at: one or more clients, and under each client all its projects or only the ticked
 * ones. Projects are listed under their own client only. Nothing chosen means all clients.
 */
export default function AiScopePicker({
  clients,
  projects,
  owner,
  scope,
  onChange,
}: {
  clients: Client[]
  projects: Project[]
  /** The client each project belongs to (see projectClients). */
  owner: Map<string, string>
  scope: AiScope
  onChange: (scope: AiScope) => void
}) {
  const choices = useMemo(() => clients.filter(client => !scope.clientIds.includes(client.id)), [clients, scope])
  const name = (id: string) => clients.find(client => client.id === id)?.name || 'Unknown client'
  const full = scope.clientIds.length >= AI_SCOPE_CLIENTS

  const addClient = (id: string) => {
    if (!id || scope.clientIds.includes(id) || full) return
    onChange({ ...scope, clientIds: [...scope.clientIds, id] })
  }
  const removeClient = (id: string) =>
    onChange({
      clientIds: scope.clientIds.filter(client => client !== id),
      projectIds: scope.projectIds.filter(project => owner.get(project) !== id),
    })
  const toggleProject = (id: string) =>
    onChange({
      ...scope,
      projectIds: scope.projectIds.includes(id)
        ? scope.projectIds.filter(project => project !== id)
        : [...scope.projectIds, id],
    })
  const allProjects = (clientId: string) =>
    onChange({ ...scope, projectIds: scope.projectIds.filter(project => owner.get(project) !== clientId) })

  return (
    <div className="ai-scope">
      <div className="ai-scope-head">
        <span>Clients and projects</span>
        {scope.clientIds.length > 0 && (
          <button type="button" className="ai-scope-clear" onClick={() => onChange({ clientIds: [], projectIds: [] })}>
            Clear
          </button>
        )}
      </div>
      <ClientSelect
        clients={choices}
        value=""
        onChange={addClient}
        disabled={full}
        aria-label="Add a client"
        placeholder={
          full
            ? `Up to ${AI_SCOPE_CLIENTS} clients`
            : scope.clientIds.length
              ? 'Add another client'
              : 'All clients / general — type to pick a client'
        }
      />
      {scope.clientIds.map(clientId => {
        const own = projectsOfClient(clientId, projects, owner)
        const ticked = own.filter(project => scope.projectIds.includes(project.id))
        return (
          <fieldset className="ai-scope-client" key={clientId}>
            <legend>
              <strong>{name(clientId)}</strong>
              <button type="button" aria-label={`Remove ${name(clientId)}`} onClick={() => removeClient(clientId)}>
                <X size={13} aria-hidden="true" />
              </button>
            </legend>
            {own.length ? (
              <>
                <label className="ai-scope-project">
                  <input type="checkbox" checked={!ticked.length} onChange={() => allProjects(clientId)} />
                  All projects
                </label>
                {own.map(project => (
                  <label className="ai-scope-project" key={project.id}>
                    <input
                      type="checkbox"
                      checked={scope.projectIds.includes(project.id)}
                      onChange={() => toggleProject(project.id)}
                    />
                    {project.name}
                  </label>
                ))}
              </>
            ) : (
              <p className="ai-scope-none">No open projects for this client.</p>
            )}
          </fieldset>
        )
      })}
    </div>
  )
}
