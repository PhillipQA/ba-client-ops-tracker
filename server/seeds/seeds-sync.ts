/**
 * One Seeds sync, as a pure change to the workspace: link or add clients (Seeds parents) and projects, follow renames,
 * keep each project's Seeds tasks as a pick-list for subtasks, and replace the Seeds assignments. Records are matched by Seeds id first, then by exact name; a close name is held
 * for someone to confirm instead of guessing. Nothing here deletes: work that is not in Seeds keeps working.
 */
import { randomUUID } from 'node:crypto'
import { archivedWorkReason, isArchived, stableRecord } from '../../src/features/tasks/lifecycle'
import { type Assignment, workspaceAccess } from '../../src/shared/access'
import { roleForSeedsTitle } from '../../src/shared/roles'
import {
  CLOSE_MATCH,
  matchKey,
  nameSimilarity,
  type SeedsCounts,
  type SeedsMatch,
  type SeedsSnapshot,
  seedsState,
} from '../../src/shared/seeds'

type Options = {
  now: string
  today: string
  /** Status and waiting-on labels new parent tasks start with. */
  openStatus: string
  waitingOn: string
  /** Whose part of the account sync this is. */
  userId: string
  id?: () => string
}

const text = (value: unknown) => (value == null ? '' : String(value))
const list = (value: unknown): any[] => (Array.isArray(value) ? value : [])

/** Seeds saves as the system, with the rights a sync needs (rename clients, add projects and tasks). */
export const SEEDS_ACTOR = {
  id: 'system:seeds',
  name: 'Seeds sync',
  username: 'seeds',
  role: 'Administrator',
  modules: ['clients', 'projects', 'items'],
  accountType: 'tenant',
  status: 'Active',
}

/**
 * Makes a sync's changes pass the workspace's own rules: a changed client or project gets its next record version,
 * and work under anything archived is left exactly as it was (archived work is read-only until reopened).
 */
function settle(before: any, after: any) {
  const bumped = (key: 'clients' | 'projects') => {
    const old = new Map(list(before?.[key]).map(record => [text(record?.id), record]))
    return list(after[key]).map(record => {
      const previous = old.get(text(record?.id))
      if (!previous) return record
      const same =
        stableRecord({ ...previous, lifecycleVersion: undefined }) ===
        stableRecord({ ...record, lifecycleVersion: undefined })
      return same ? previous : { ...record, lifecycleVersion: (Number(previous.lifecycleVersion) || 0) + 1 }
    })
  }
  const draft = { ...after, clients: bumped('clients'), projects: bumped('projects') }
  const old = new Map(list(before?.items).map(item => [text(item?.id), item]))
  const items = list(after.items)
    .map(item => {
      const previous = old.get(text(item?.id))
      if (previous && stableRecord(previous) === stableRecord(item)) return previous
      const blocked =
        (previous && (isArchived(previous) || archivedWorkReason(before, previous))) || archivedWorkReason(draft, item)
      return blocked ? previous : item
    })
    .filter(Boolean)
  return { ...draft, items }
}

/** The best unlinked record for a Seeds name: exact, close (to confirm), or none. */
function bestMatch(name: string, candidates: any[], field: 'name' | 'title') {
  const key = matchKey(name)
  const exact = candidates.find(candidate => key && matchKey(candidate[field]) === key)
  if (exact) return { exact }
  let close: any
  let score = CLOSE_MATCH
  for (const candidate of candidates) {
    const similarity = nameSimilarity(name, candidate[field])
    if (similarity >= score) {
      score = similarity
      close = candidate
    }
  }
  return close ? { close } : {}
}

export function planSeedsSync(state: any, snapshot: SeedsSnapshot, options: Options) {
  const makeId = options.id || randomUUID
  const seeds = seedsState(state)
  const rejected = new Set(seeds.rejected)
  const counts: SeedsCounts = {
    people: snapshot.people.length,
    clients: snapshot.clients.length,
    projects: snapshot.projects.length,
    tasks: snapshot.tasks.length,
    assignments: 0,
    created: 0,
    linked: 0,
    renamed: 0,
  }
  const pending: SeedsMatch[] = []
  const hold = (kind: SeedsMatch['kind'], seedsId: string, seedsName: string, app: any, extra = {}) =>
    pending.push({
      id: `${kind}:${seedsId}`,
      kind,
      seedsId,
      seedsName,
      appId: text(app.id),
      appName: text(app.name ?? app.title),
      ...extra,
    })

  // Clients
  const clients = list(state?.clients).map(client => ({ ...client }))
  const clientBySeeds = new Map<string, any>()
  for (const client of clients) if (client.seedsId) clientBySeeds.set(text(client.seedsId), client)
  for (const source of snapshot.clients) {
    let client = clientBySeeds.get(source.id)
    if (!client) {
      const free = clients.filter(candidate => !candidate.seedsId)
      const found = bestMatch(source.name, free, 'name')
      if (found.exact) {
        client = found.exact
        client.seedsId = source.id
        counts.linked++
      } else if (found.close && !rejected.has(source.id)) {
        hold('client', source.id, source.name, found.close)
        continue
      } else {
        client = {
          id: makeId(),
          name: source.name,
          contact: '',
          email: '',
          status: 'Active',
          health: 'Good',
          notes: '',
          seedsId: source.id,
        }
        clients.push(client)
        counts.created++
      }
      clientBySeeds.set(source.id, client)
    }
    if (client.name !== source.name) {
      client.name = source.name
      counts.renamed++
    }
    if (source.archived) client.seedsArchived = true
    else delete client.seedsArchived
  }

  // Projects, under their Seeds client. A project whose client is waiting for a confirmation waits too.
  const projects = list(state?.projects).map(project => ({ ...project }))
  const projectBySeeds = new Map<string, any>()
  for (const project of projects) if (project.seedsId) projectBySeeds.set(text(project.seedsId), project)
  for (const source of snapshot.projects) {
    const client = source.clientId ? clientBySeeds.get(source.clientId) : undefined
    if (source.clientId && !client) continue
    let project = projectBySeeds.get(source.id)
    if (!project) {
      const free = projects.filter(
        candidate => !candidate.seedsId && (!candidate.clientId || candidate.clientId === client?.id),
      )
      const contract = matchKey(source.contractNumber)
      const byContract =
        contract.length >= 4 ? free.find(candidate => matchKey(candidate.name).includes(contract)) : undefined
      const found = byContract ? { exact: byContract } : bestMatch(source.name, free, 'name')
      if (found.exact) {
        project = found.exact
        project.seedsId = source.id
        counts.linked++
      } else if (found.close && !rejected.has(source.id)) {
        hold('project', source.id, source.name, found.close, { contractNumber: source.contractNumber })
        continue
      } else {
        project = {
          id: makeId(),
          name: source.name,
          status: 'Active',
          targetDate: '',
          summary: '',
          seedsId: source.id,
        }
        projects.push(project)
        counts.created++
      }
      projectBySeeds.set(source.id, project)
    }
    if (project.name !== source.name) {
      project.name = source.name
      counts.renamed++
    }
    if (client) project.clientId = client.id
    else delete project.clientId
    if (source.contractNumber) project.contractNumber = source.contractNumber
    else delete project.contractNumber
    if (source.archived) project.seedsArchived = true
    else delete project.seedsArchived
  }

  // Seeds tasks (Go Live, Meetings…) sit at subtask level: they are not created here. Each project keeps its list, and
  // subtasks pick one, so time can go to the right Seeds task later.
  const items = list(state?.items)
  const tasksByProject = new Map<string, { id: string; name: string; archived?: boolean }[]>()
  for (const task of snapshot.tasks) {
    const tasks = tasksByProject.get(task.projectId) || []
    tasks.push({ id: task.id, name: task.name, ...(task.archived ? { archived: true } : {}) })
    tasksByProject.set(task.projectId, tasks)
  }
  for (const [seedsId, tasks] of tasksByProject) {
    const project = projectBySeeds.get(seedsId)
    if (!project || project.archived) continue
    project.seedsTasks = tasks.sort((a, b) => a.name.localeCompare(b.name))
  }

  // This person's own assignments: Seeds project members matched to them by email. A snapshot may hold other people's
  // too; only the ones with this person's email count.
  const account = list(state?.accounts).find(candidate => text(candidate?.id) === options.userId)
  const email = text(account?.email).trim().toLowerCase()
  const seen = new Set<string>()
  const unknownRoles = new Set<string>()
  const mine: Assignment[] = []
  for (const source of snapshot.assignments) {
    if (!email || text(source.email).trim().toLowerCase() !== email) continue
    const projectId = source.projectId ? projectBySeeds.get(source.projectId)?.id : undefined
    const clientId = !source.projectId && source.clientId ? clientBySeeds.get(source.clientId)?.id : undefined
    if (!projectId && !clientId) continue
    // Seeds titles map to job roles (Settings › Roles); a title no role claims is reported, not guessed.
    const role = roleForSeedsTitle(state, source.role)
    if (!role) {
      unknownRoles.add(source.role)
      continue
    }
    const id = `seeds:${options.userId}:${role}:${projectId || clientId}`
    if (seen.has(id)) continue
    seen.add(id)
    mine.push({
      id,
      userId: options.userId,
      role,
      ...(projectId ? { projectId } : { clientId }),
      source: 'seeds',
    })
  }
  counts.assignments = mine.length

  // Matches this sync found replace the ones it found last time; others' stay. Linked ones drop out.
  const linkedNow = new Set([...clients, ...projects, ...items].map(record => text(record?.seedsId)).filter(Boolean))
  const seenSeeds = new Set([...snapshot.clients, ...snapshot.projects, ...snapshot.tasks].map(record => record.id))
  const pendingMatches = [...seeds.pendingMatches.filter(match => !seenSeeds.has(match.seedsId)), ...pending].filter(
    match => !linkedNow.has(match.seedsId),
  )

  const access = workspaceAccess(state)
  const next = settle(state, {
    ...state,
    clients,
    projects,
    items,
    access: {
      ...access,
      assignments: [
        ...access.assignments.filter(
          assignment => !(assignment.source === 'seeds' && assignment.userId === options.userId),
        ),
        ...mine,
      ],
    },
    seeds: {
      ...seeds,
      users: {
        ...seeds.users,
        [options.userId]: {
          connected: true,
          lastAttemptAt: options.now,
          lastSuccessAt: options.now,
          counts,
          ...(unknownRoles.size ? { unknownRoles: [...unknownRoles].slice(0, 20) } : {}),
        },
      },
      pendingMatches,
    },
  })
  return { state: next, counts, pending }
}

/** Confirm (link) or turn down (add as new on the next sync) one held match. */
export function decideSeedsMatch(state: any, matchId: string, decision: 'confirm' | 'reject') {
  const seeds = seedsState(state)
  const match = seeds.pendingMatches.find(candidate => candidate.id === matchId)
  if (!match) return null
  const key = match.kind === 'client' ? 'clients' : match.kind === 'project' ? 'projects' : 'items'
  const linkedAlready = list(state?.[key]).some(record => text(record?.seedsId) === match.seedsId)
  const records =
    decision === 'confirm' && !linkedAlready
      ? list(state?.[key]).map(record =>
          text(record?.id) === match.appId && !record.seedsId
            ? {
                ...record,
                seedsId: match.seedsId,
                ...(key === 'items' ? { title: match.seedsName } : { name: match.seedsName }),
              }
            : record,
        )
      : list(state?.[key])
  return {
    match,
    state: settle(state, {
      ...state,
      [key]: records,
      seeds: {
        ...seeds,
        pendingMatches: seeds.pendingMatches.filter(candidate => candidate.id !== matchId),
        rejected: decision === 'reject' ? [...new Set([...seeds.rejected, match.seedsId])] : seeds.rejected,
      },
    }),
  }
}
