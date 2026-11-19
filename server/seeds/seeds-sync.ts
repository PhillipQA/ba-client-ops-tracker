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
  type SeedsCounts,
  type SeedsMatch,
  type SeedsProject,
  type SeedsSnapshot,
  seedsState,
} from '../../src/shared/seeds'
import { asList as list } from '../../src/shared/lists'

type Options = {
  now: string
  today: string
  /** Status and waiting-on labels new parent tasks start with. */
  openStatus: string
  waitingOn: string
  /** Whose part of the account sync this is. */
  userId: string
  /** Seeds assignments of theirs this sync did not read again (a delta sync): they stay as they are. */
  keep?: Assignment[]
  id?: () => string
}

const text = (value: unknown) => (value == null ? '' : String(value))

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

/**
 * The fields Seeds owns on a linked project, copied from Seeds. A deleted project may come with no name: it keeps its
 * own. Answers whether the name changed.
 */
function applyProject(project: any, source: SeedsProject) {
  const renamed = Boolean(source.name) && project.name !== source.name
  if (renamed) project.name = source.name
  if (source.contractNumber) project.contractNumber = source.contractNumber
  else if (!source.archived) delete project.contractNumber
  if (source.productId) project.seedsProductId = source.productId
  else if (!source.archived) delete project.seedsProductId
  if (source.timeRules) project.seedsTimeRules = source.timeRules
  else if (!source.archived) delete project.seedsTimeRules
  if (source.archived) project.seedsArchived = true
  else delete project.seedsArchived
  return renamed
}

/**
 * Projects already linked here follow Seeds even when nobody here is on them any more: a project completed, closed
 * or deleted in Seeds is marked closed, and renames, contract numbers, products and time-entry rules follow.
 */
export function refreshLinkedProjects(state: any, sources: SeedsProject[]) {
  const bySeeds = new Map(sources.map(source => [source.id, source]))
  let changed = false
  const projects = list(state?.projects).map(project => {
    const source = project?.seedsId ? bySeeds.get(text(project.seedsId)) : undefined
    if (!source) return project
    const next = { ...project }
    applyProject(next, source)
    if (stableRecord(next) === stableRecord(project)) return project
    changed = true
    return next
  })
  return changed ? settle(state, { ...state, projects }) : state
}

/**
 * Every Seeds parent becomes a client here, whether or not anyone here is on one of its projects: a Seeds project with
 * no parent of its own lets each time entry name any parent, so all of them must be there to pick. Linked by Seeds id
 * only (never by name); Seeds renames and closes them. A parent closed in Seeds that is not here yet is not added.
 */
export function refreshSeedsClients(state: any, sources: SeedsSnapshot['clients'], makeId: () => string = randomUUID) {
  const bySource = new Map(sources.filter(source => source.id && source.name).map(source => [source.id, source]))
  const clients = list(state?.clients)
  const linked = new Set(clients.map(client => text(client?.seedsId)).filter(Boolean))
  let changed = false
  const updated = clients.map(client => {
    const source = client?.seedsId ? bySource.get(text(client.seedsId)) : undefined
    if (!source) return client
    const next = { ...client, name: source.name }
    if (source.archived) next.seedsArchived = true
    else delete next.seedsArchived
    if (stableRecord(next) === stableRecord(client)) return client
    changed = true
    return next
  })
  const added = [...bySource.values()]
    .filter(source => !linked.has(source.id) && !source.archived)
    .map(source => ({
      id: makeId(),
      name: source.name,
      contact: '',
      email: '',
      status: 'Active',
      health: 'Good',
      notes: '',
      seedsId: source.id,
    }))
  if (!changed && !added.length) return state
  return settle(state, { ...state, clients: [...updated, ...added] })
}

/** Each Seeds project's task list (by Seeds project id), as a project here keeps it, sorted by name. */
function seedsTaskLists(sources: SeedsSnapshot['tasks']) {
  const lists = new Map<
    string,
    { id: string; name: string; productRequired?: boolean; defaultProductId?: string; archived?: boolean }[]
  >()
  for (const task of sources) {
    const tasks = lists.get(task.projectId) || []
    tasks.push({
      id: task.id,
      name: task.name,
      ...(task.productRequired ? { productRequired: true } : {}),
      ...(task.defaultProductId ? { defaultProductId: task.defaultProductId } : {}),
      ...(task.archived ? { archived: true } : {}),
    })
    lists.set(task.projectId, tasks)
  }
  for (const tasks of lists.values()) tasks.sort((a, b) => a.name.localeCompare(b.name))
  return lists
}

/**
 * Every open Seeds project becomes a project here, whether or not anyone here is a member: Seeds lets anyone log time
 * on some projects (company-wide programs, internal admin), so they must be there to pick. It goes under its Seeds
 * parent's client and keeps its Seeds task list (refreshed for every project the read covered). Linked by Seeds id
 * only; renames and closing follow through refreshLinkedProjects. A project closed in Seeds is not added.
 */
export function refreshSeedsProjects(
  state: any,
  snapshot: Pick<SeedsSnapshot, 'projects' | 'tasks'>,
  makeId: () => string = randomUUID,
) {
  const clientBySeeds = new Map(
    list(state?.clients)
      .filter(client => client?.seedsId)
      .map(client => [text(client.seedsId), text(client.id)] as const),
  )
  const tasksOf = seedsTaskLists(snapshot.tasks)
  const projects = list(state?.projects)
  const linked = new Set(projects.map(project => text(project?.seedsId)).filter(Boolean))
  let changed = false
  const updated = projects.map(project => {
    const tasks = project?.seedsId && !project.archived ? tasksOf.get(text(project.seedsId)) : undefined
    if (!tasks) return project
    const next = { ...project, seedsTasks: tasks }
    if (stableRecord(next) === stableRecord(project)) return project
    changed = true
    return next
  })
  const added = snapshot.projects
    .filter(source => source.id && source.name && !source.archived && !linked.has(source.id))
    .filter(source => !source.clientId || clientBySeeds.has(source.clientId))
    .map(source => {
      const project: any = { id: makeId(), name: source.name, status: 'Active', targetDate: '', summary: '' }
      project.seedsId = source.id
      applyProject(project, source)
      const clientId = source.clientId ? clientBySeeds.get(source.clientId) : ''
      if (clientId) project.clientId = clientId
      const tasks = tasksOf.get(source.id)
      if (tasks) project.seedsTasks = tasks
      return project
    })
  if (!changed && !added.length) return state
  return settle(state, { ...state, projects: [...updated, ...added] })
}

export function planSeedsSync(state: any, snapshot: SeedsSnapshot, options: Options) {
  const makeId = options.id || randomUUID
  const seeds = seedsState(state)
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

  // Clients
  const clients = list(state?.clients).map(client => ({ ...client }))
  const clientBySeeds = new Map<string, any>()
  for (const client of clients) if (client.seedsId) clientBySeeds.set(text(client.seedsId), client)
  for (const source of snapshot.clients) {
    // Seeds is the source of truth: a client comes from Seeds, linked by Seeds id only. What existed before Seeds was
    // moved to Before Seeds and is never matched by name, so nothing is merged or duplicated by guesswork.
    let client = clientBySeeds.get(source.id)
    if (!client) {
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
      clientBySeeds.set(source.id, client)
    }
    if (client.name !== source.name) {
      client.name = source.name
      counts.renamed++
    }
    if (source.archived) client.seedsArchived = true
    else delete client.seedsArchived
  }

  // Projects, under their Seeds parent (this app's client).
  const projects = list(state?.projects).map(project => ({ ...project }))
  const projectBySeeds = new Map<string, any>()
  for (const project of projects) if (project.seedsId) projectBySeeds.set(text(project.seedsId), project)
  for (const source of snapshot.projects) {
    const client = source.clientId ? clientBySeeds.get(source.clientId) : undefined
    if (source.clientId && !client) continue
    let project = projectBySeeds.get(source.id)
    if (!project) {
      project = {
        id: makeId(),
        name: source.name,
        status: 'Active',
        targetDate: '',
        summary: '',
        seedsId: source.id,
        // When the sync first brought it in: new projects are offered to trackers for a while (see seedsRows).
        seedsAddedAt: new Date().toISOString(),
      }
      projects.push(project)
      counts.created++
      projectBySeeds.set(source.id, project)
    }
    if (applyProject(project, source)) counts.renamed++
    if (client) project.clientId = client.id
    else delete project.clientId
  }

  // Work under a Seeds project belongs to that project's client: when Seeds moves a project, its tasks follow.
  const clientOfSeedsProject = new Map(
    projects.filter(project => project.seedsId).map(project => [text(project.id), text(project.clientId)] as const),
  )
  const items = list(state?.items).map(item => {
    const projectId = text(item?.projectId)
    if (!clientOfSeedsProject.has(projectId)) return item
    const clientId = clientOfSeedsProject.get(projectId) || ''
    if (text(item?.clientId) === clientId) return item
    const moved = { ...item }
    if (clientId) moved.clientId = clientId
    else delete moved.clientId
    return moved
  })

  // Seeds tasks (Go Live, Meetings…) are not created here: tasks and subtasks are this app's own, and each can be
  // linked to one of its project's Seeds tasks, so time goes to the right Seeds task later.
  const tasksByProject = seedsTaskLists(snapshot.tasks)
  for (const [seedsId, tasks] of tasksByProject) {
    const project = projectBySeeds.get(seedsId)
    if (!project || project.archived) continue
    project.seedsTasks = tasks
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
  for (const kept of options.keep || [])
    if (!seen.has(kept.id) && (!kept.projectId || projects.some(project => project.id === kept.projectId))) {
      seen.add(kept.id)
      mine.push(kept)
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
