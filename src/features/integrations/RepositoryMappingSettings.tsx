/**
 * Settings › Integrations › Repository mapping (Administrators): which Client and Project each GitLab or GitHub
 * repository's tickets belong to, for the whole workspace. A GIT Tracker puts a ticket's Tasks and Subtasks there.
 * People's own Work Hub repository settings are offered as suggestions.
 */
import { useEffect, useMemo, useState } from 'react'
import { requestJson, type HttpMethod } from '../../shared/http'
import type { Client, Project } from '../../shared/types'
import ClientSelect, { SearchSelect, type SearchChoice } from '../../shared/ui/SearchSelect'
import { isClosedProject } from '../tasks/lifecycle'

type Provider = 'gitlab' | 'github'
type Mapping = {
  id: string
  provider: Provider
  instanceUrl: string
  repositoryId: number
  repository: string
  clientId: string
  projectId: string
  updatedAt: string
  updatedBy: string
}
type Suggestion = {
  provider: Provider
  instanceUrl: string
  repository: string
  clientId: string
  projectId: string
  people: string[]
}
const PROVIDER: Record<Provider, string> = { gitlab: 'GitLab', github: 'GitHub' }
const request = <T,>(url: string, method = 'GET', body?: unknown) =>
  requestJson<T>(url, {
    method: method as HttpMethod,
    body,
    noStore: true,
    fallback: 'Repository mapping is unavailable right now. Try again in a moment.',
  })

/** Open projects a repository can be mapped to for a client: its own, and projects shared by several clients. */
export function projectsForMapping(projects: Project[], clientId: string) {
  return projects.filter(
    project => !isClosedProject(project) && (!project.clientId || !clientId || project.clientId === clientId),
  )
}

export function RepositoryMappingSettings({ clients, projects }: { clients: Client[]; projects: Project[] }) {
  const [mappings, setMappings] = useState<Mapping[] | null>(null)
  const [suggestions, setSuggestions] = useState<Suggestion[] | null>(null)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [provider, setProvider] = useState<Provider>('gitlab')
  const [repository, setRepository] = useState('')
  const [clientId, setClientId] = useState('')
  const [projectId, setProjectId] = useState('')
  const clientName = (id: string) => clients.find(client => client.id === id)?.name || 'Unknown client'
  const projectName = (id: string) => projects.find(project => project.id === id)?.name || 'Unknown project'
  const projectChoices: SearchChoice[] = useMemo(
    () => [
      { value: '', label: clientId ? 'Choose a project' : 'Choose a client first' },
      ...projectsForMapping(projects, clientId)
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(project => ({ value: project.id, label: project.name, hint: project.contractNumber || undefined })),
    ],
    [projects, clientId],
  )

  const load = async () => {
    const result = await request<{ mappings: Mapping[] }>('/api/git-mappings')
    setMappings(result.mappings)
  }
  useEffect(() => {
    void load().catch(error => setMessage(error instanceof Error ? error.message : String(error)))
  }, [])

  const save = async (body: { provider: Provider; repository: string; clientId: string; projectId: string }) => {
    setBusy(true)
    setMessage('')
    try {
      const result = await request<{ mapping: Mapping; unchanged?: boolean }>('/api/git-mappings', 'POST', body)
      await load()
      const done = body.repository.toLowerCase()
      setSuggestions(list => list?.filter(item => item.repository.toLowerCase() !== done) || null)
      const where = `${clientName(body.clientId)} › ${projectName(body.projectId)}`
      setMessage(
        result.unchanged
          ? `${result.mapping.repository} was already mapped there.`
          : `${result.mapping.repository} → ${where}. New tickets added to a GIT Tracker go there.`,
      )
      return true
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'The mapping could not be saved.')
      return false
    } finally {
      setBusy(false)
    }
  }
  const add = async () => {
    if (!repository.trim()) return setMessage('Enter the repository, such as group/project.')
    if (!clientId || !projectId) return setMessage('Choose the client and project its tickets belong to.')
    if (await save({ provider, repository: repository.trim(), clientId, projectId })) {
      setRepository('')
      setProjectId('')
    }
  }
  const remove = async (mapping: Mapping) => {
    const ask = `Stop mapping ${mapping.repository}? Its tickets cannot be added to a GIT Tracker until it is mapped`
    if (!window.confirm(`${ask} again. Work already made stays where it is.`)) return
    setBusy(true)
    setMessage('')
    try {
      await request(`/api/git-mappings/${mapping.id}`, 'DELETE')
      await load()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'The mapping could not be removed.')
    } finally {
      setBusy(false)
    }
  }
  const showSuggestions = async () => {
    setBusy(true)
    setMessage('')
    try {
      setSuggestions((await request<{ suggestions: Suggestion[] }>('/api/git-mappings/suggestions')).suggestions)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Suggestions are unavailable.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="panel account-integration-card repo-mapping">
      <div className="panel-heading">
        <div>
          <h2>Repository mapping</h2>
          <p>
            Which Client and Project each GitLab or GitHub repository’s tickets belong to, for everyone. When a ticket
            is added to a GIT Tracker, its Tasks and Subtasks go there. Changing a mapping later does not move work
            already made.
          </p>
        </div>
      </div>
      {message && (
        <p className="settings-message" role="status">
          {message}
        </p>
      )}
      {mappings === null ? (
        <p className="repo-mapping-note">Loading…</p>
      ) : mappings.length ? (
        <div className="repo-mapping-table" role="table" aria-label="Mapped repositories">
          <div className="repo-mapping-row head" role="row">
            <span role="columnheader">Repository</span>
            <span role="columnheader">Client</span>
            <span role="columnheader">Project</span>
            <span role="columnheader">
              <span className="repo-mapping-hidden">Remove</span>
            </span>
          </div>
          {mappings.map(mapping => (
            <div key={mapping.id} className="repo-mapping-row" role="row">
              <span role="cell">
                <strong>{mapping.repository}</strong>
                <small>
                  {PROVIDER[mapping.provider]}
                  {mapping.provider === 'gitlab' ? ` · ${mapping.instanceUrl.replace(/^https:\/\//, '')}` : ''}
                </small>
              </span>
              <span role="cell">{clientName(mapping.clientId)}</span>
              <span role="cell">{projectName(mapping.projectId)}</span>
              <span role="cell">
                <button
                  type="button"
                  className="secondary compact"
                  disabled={busy}
                  onClick={() => void remove(mapping)}
                >
                  Remove
                </button>
              </span>
            </div>
          ))}
        </div>
      ) : (
        <p className="repo-mapping-note">No repository is mapped yet.</p>
      )}

      <form
        className="repo-mapping-add"
        onSubmit={event => {
          event.preventDefault()
          void add()
        }}
      >
        <label>
          Provider
          <select value={provider} onChange={event => setProvider(event.target.value as Provider)}>
            <option value="gitlab">GitLab</option>
            <option value="github">GitHub</option>
          </select>
        </label>
        <label>
          Repository
          <input
            value={repository}
            placeholder={provider === 'gitlab' ? 'group/project' : 'owner/repository'}
            maxLength={200}
            onChange={event => setRepository(event.target.value)}
          />
        </label>
        <label>
          Client
          <ClientSelect
            clients={clients.filter(client => !client.archived)}
            value={clientId}
            onChange={value => {
              setClientId(value)
              setProjectId('')
            }}
            extra={[{ value: '', label: 'Choose a client' }]}
          />
        </label>
        <label>
          Project
          <SearchSelect
            choices={projectChoices}
            value={projectId}
            disabled={!clientId}
            onChange={setProjectId}
            unknown="Unknown project"
            placeholder="Type a project or contract number"
            aria-label="Project"
          />
        </label>
        <div className="repo-mapping-actions">
          <button type="submit" disabled={busy}>
            Map repository
          </button>
          <button type="button" className="secondary" disabled={busy} onClick={() => void showSuggestions()}>
            Suggestions from Work Hub
          </button>
        </div>
        <p className="repo-mapping-note">
          The repository is looked up with your own {PROVIDER[provider]} connection (Work Hub › {PROVIDER[provider]}),
          so it stays mapped if it is renamed.
        </p>
      </form>

      {suggestions && (
        <div className="repo-mapping-suggestions">
          <h3>Suggestions</h3>
          {suggestions.length ? (
            <ul>
              {suggestions.map(item => (
                <li key={`${item.provider}|${item.repository}|${item.clientId}|${item.projectId}`}>
                  <span>
                    <strong>{item.repository}</strong> ({PROVIDER[item.provider]}) →{' '}
                    {`${clientName(item.clientId)} › ${projectName(item.projectId)}`}
                    <small> · set by {item.people.join(', ') || 'someone'} in Work Hub</small>
                  </span>
                  <button
                    type="button"
                    className="secondary compact"
                    disabled={busy}
                    onClick={() =>
                      void save({
                        provider: item.provider,
                        repository: item.repository,
                        clientId: item.clientId,
                        projectId: item.projectId,
                      })
                    }
                  >
                    Use this
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="repo-mapping-note">No unmapped repositories in people’s Work Hub settings.</p>
          )}
        </div>
      )}
    </section>
  )
}
