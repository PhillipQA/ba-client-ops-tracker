/** Repository mapping rules (GIT Tracker), kept free of server dependencies so they are easy to test. */
import { isClosedProject } from '../../src/features/tasks/lifecycle'

export type GitProvider = 'gitlab' | 'github'

/** The Client and Project a mapping may point at: both active, the project open, and of that client if it has one. */
export function mappingTargetError(state: any, clientId: string, projectId: string): string {
  const client = (state?.clients || []).find((item: any) => item.id === clientId)
  if (!client || client.archived) return 'Choose an active client.'
  const project = (state?.projects || []).find((item: any) => item.id === projectId)
  if (!project || project.archived) return 'Choose an active project.'
  if (isClosedProject(project))
    return 'That project is completed, so it takes no new tasks. Map the repository to an open project.'
  if (project.clientId && project.clientId !== clientId) return 'That project belongs to another client.'
  return ''
}

/** Personal mappings (Work Hub repository settings) not mapped for the workspace yet, one entry per repository. */
export function mappingSuggestions(
  connections: { provider: GitProvider; instanceUrl: string; userId: string; repositories: any }[],
  active: { provider: string; instanceUrl: string; repository: string }[],
  nameOf: (userId: string) => string,
) {
  const taken = new Set(active.map(item => `${item.provider}|${item.instanceUrl}|${item.repository.toLowerCase()}`))
  const found = new Map<
    string,
    {
      provider: GitProvider
      instanceUrl: string
      repository: string
      clientId: string
      projectId: string
      people: string[]
    }
  >()
  for (const connection of connections)
    for (const item of Array.isArray(connection.repositories) ? connection.repositories : []) {
      const repository = typeof item?.fullName === 'string' ? item.fullName.trim() : ''
      const clientId = typeof item?.clientId === 'string' ? item.clientId : ''
      const projectId = typeof item?.projectId === 'string' ? item.projectId : ''
      if (!repository || !clientId || !projectId) continue
      const key = `${connection.provider}|${connection.instanceUrl}|${repository.toLowerCase()}`
      if (taken.has(key)) continue
      // People may disagree: each Client and Project pair is its own suggestion.
      const pair = `${key}|${clientId}|${projectId}`
      const entry = found.get(pair) || {
        provider: connection.provider,
        instanceUrl: connection.instanceUrl,
        repository,
        clientId,
        projectId,
        people: [],
      }
      const name = nameOf(connection.userId)
      if (name && !entry.people.includes(name)) entry.people.push(name)
      found.set(pair, entry)
    }
  return [...found.values()].sort((a, b) => a.repository.localeCompare(b.repository))
}
