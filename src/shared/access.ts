/**
 * Who sees which client data.
 *
 * Seeds (or, until Seeds is connected, the assignments an Administrator enters by hand) decides which clients and
 * projects each person sees; their job roles (shared/roles.ts) decide which pages they get and what they can change.
 * Administrators see and change everything. When per-person visibility is off, everyone sees the whole workspace.
 *
 * Pure functions shared by the server (filtering reads, merging saves, guarding task APIs) and the browser (badges,
 * read-only fields). Workspace records are read loosely (`any`) because stored workspaces can be older than the types.
 */

import { accessForRoles, jobRoles, ROLE_MODULES, roleCanChange } from './roles'
import type { AppModule } from './types'

/** A job role id (shared/roles.ts): BA, PM, PO, DEV, QA, SUPPORT, AM, or one an Administrator added. */
export type SeedsRole = string

export type AssignmentSource = 'manual' | 'seeds'

/** One person on one client or one project. A project assignment does not open the rest of its client. */
export interface Assignment {
  id: string
  userId: string
  role: SeedsRole
  clientId?: string
  projectId?: string
  source: AssignmentSource
}

export interface WorkspaceAccess {
  /** Off by default. When on, each person sees only the clients and projects they are assigned to. */
  strictVisibility: boolean
  assignments: Assignment[]
  updatedAt?: string
  updatedBy?: string
}

/** What the browser is told about access: only the person's own assignments. */
export interface ClientAccess {
  strictVisibility: boolean
  seedsConnected: boolean
  /** True when this person's access comes from their own Seeds sync. */
  assignmentsFromSeeds: boolean
  /** Roles from this person's assignments (per client or project). */
  roles: SeedsRole[]
  /** All of this person's job roles (picked in Users & Permissions, plus their assignments' roles). */
  jobRoles: string[]
  /** Pages and editable pages from those roles; absent for Administrators and people without a job role. */
  modules?: AppModule[]
  editModules?: AppModule[]
  assignments: Assignment[]
  /** Client and project ids this person can change. Absent when everything is visible. */
  writableClientIds?: string[]
  writableProjectIds?: string[]
}

const list = (value: unknown): any[] => (Array.isArray(value) ? value : [])
const text = (value: unknown) => (typeof value === 'string' ? value : value == null ? '' : String(value))

export function normalizeAssignment(value: any): Assignment | null {
  const userId = text(value?.userId).trim()
  const role = /^[A-Z0-9_-]{1,20}$/.test(text(value?.role).trim().toUpperCase())
    ? text(value.role).trim().toUpperCase()
    : null
  const clientId = text(value?.clientId).trim()
  const projectId = text(value?.projectId).trim()
  if (!userId || !role || (!clientId && !projectId)) return null
  return {
    id:
      text(value?.id).trim() ||
      `${value?.source === 'seeds' ? 'seeds' : 'manual'}:${userId}:${role}:${projectId || clientId}`,
    userId,
    role,
    ...(clientId ? { clientId } : {}),
    ...(projectId ? { projectId } : {}),
    source: value?.source === 'seeds' ? 'seeds' : 'manual',
  }
}

export function workspaceAccess(state: any): WorkspaceAccess {
  const raw = state?.access && typeof state.access === 'object' ? state.access : {}
  const seen = new Set<string>()
  const assignments = list(raw.assignments)
    .map(normalizeAssignment)
    .filter((assignment): assignment is Assignment => {
      if (!assignment || seen.has(assignment.id)) return false
      seen.add(assignment.id)
      return true
    })
  return {
    strictVisibility: raw.strictVisibility === true,
    assignments,
    ...(raw.updatedAt ? { updatedAt: text(raw.updatedAt) } : {}),
    ...(raw.updatedBy ? { updatedBy: text(raw.updatedBy) } : {}),
  }
}

/**
 * Each person connects Seeds with their own API key. Once Seeds is on for the account and that person's own sync has
 * succeeded, Seeds decides their access; until then their hand-entered assignments (if any) count.
 */
export function assignmentsFromSeeds(state: any, userId: string) {
  return state?.seeds?.connected === true && Boolean(state?.seeds?.users?.[userId]?.lastSuccessAt)
}

/** The assignments in force for one person. */
export function activeAssignments(state: any, userId: string): Assignment[] {
  const source: AssignmentSource = assignmentsFromSeeds(state, userId) ? 'seeds' : 'manual'
  return workspaceAccess(state).assignments.filter(
    assignment => assignment.userId === userId && assignment.source === source,
  )
}

/** Roles from this person's assignments, in the order of the account's role list. */
export function rolesFor(state: any, userId: string): SeedsRole[] {
  const roles = new Set(activeAssignments(state, userId).map(a => a.role))
  return jobRoles(state)
    .map(role => role.id)
    .filter(id => roles.has(id))
}

export function isAdministrator(state: any, userId: string) {
  return list(state?.accounts).some(account => text(account?.id) === userId && account?.role === 'Administrator')
}

/** Every job role this person has: picked for them in Users & Permissions, and from their assignments. */
export function personRoles(state: any, userId: string): string[] {
  const account = list(state?.accounts).find(candidate => text(candidate?.id) === userId)
  const picked = list(account?.jobRoles).map(text)
  const wanted = new Set([...picked, ...activeAssignments(state, userId).map(a => a.role)])
  return jobRoles(state)
    .map(role => role.id)
    .filter(id => wanted.has(id))
}

/**
 * The session as the app should treat it. Administrators see and change everything. Anyone with a job role gets the
 * pages of their roles; if those roles change nothing, they are a Viewer (who may still ask the AI BA Assistant).
 * Without a job role, a person keeps the modules picked for them by hand.
 */
export function effectiveAccount<
  T extends { id: string; role: string; modules: string[]; organizationModules?: string[] },
>(user: T, state: any): T {
  if (user.role === 'Administrator') return user
  const access = accessForRoles(state, personRoles(state, user.id))
  if (!access) return user
  const allowed: string[] = user.organizationModules?.length ? user.organizationModules : ROLE_MODULES
  const modules = access.modules.filter(module => allowed.includes(module))
  const editModules = access.edit.filter(module => modules.includes(module))
  return {
    ...user,
    role: editModules.length ? (user.role === 'Viewer' ? 'Viewer' : 'Contributor') : 'Viewer',
    modules,
    editModules,
    jobRoles: access.roles,
    /** A Viewer by role may still ask the AI BA Assistant about their clients. */
    askAi: modules.includes('ai'),
  } as T
}

export interface Scope {
  /** Everything is visible and editable (visibility is off). */
  all: boolean
  userId: string
  /** All work under these is visible. */
  fullClients: Set<string>
  fullProjects: Set<string>
  /** Of those, the ones this person can change (BA or PM). */
  writeClients: Set<string>
  writeProjects: Set<string>
  /** Shown by name only, because visible work refers to them. Includes the full ones. */
  labelClients: Set<string>
  labelProjects: Set<string>
  visibleItems: Set<string>
  writableItems: Set<string>
}

export function scopeFor(state: any, userId: string): Scope {
  const empty = () => new Set<string>()
  const scope: Scope = {
    // Administrators see and change everything, assigned or not.
    all: !workspaceAccess(state).strictVisibility || isAdministrator(state, userId),
    userId,
    fullClients: empty(),
    fullProjects: empty(),
    writeClients: empty(),
    writeProjects: empty(),
    labelClients: empty(),
    labelProjects: empty(),
    visibleItems: empty(),
    writableItems: empty(),
  }
  if (scope.all) return scope

  for (const assignment of activeAssignments(state, userId)) {
    const write = roleCanChange(state, assignment.role)
    if (assignment.projectId) {
      scope.fullProjects.add(assignment.projectId)
      if (write) scope.writeProjects.add(assignment.projectId)
    } else if (assignment.clientId) {
      scope.fullClients.add(assignment.clientId)
      if (write) scope.writeClients.add(assignment.clientId)
    }
  }

  // Before Seeds (what existed when Seeds was turned on) is open to everyone, and editable.
  for (const client of list(state?.clients))
    if (client?.beforeSeeds === true) {
      scope.fullClients.add(text(client.id))
      scope.writeClients.add(text(client.id))
    }
  for (const project of list(state?.projects))
    if (project?.beforeSeeds === true) {
      scope.fullProjects.add(text(project.id))
      scope.writeProjects.add(text(project.id))
    }

  const items = list(state?.items)
  // Older projects have no client of their own; their client is whoever their tasks belong to. Such a project opens
  // only when every one of its clients is open to this person, so a shared project never shows another client's work.
  const clientsOfProject = new Map<string, Set<string>>()
  for (const item of items) {
    const projectId = text(item?.projectId)
    const clientId = text(item?.clientId)
    if (!projectId || !clientId) continue
    if (!clientsOfProject.has(projectId)) clientsOfProject.set(projectId, new Set())
    clientsOfProject.get(projectId)?.add(clientId)
  }
  for (const project of list(state?.projects)) {
    const id = text(project?.id)
    if (!id || scope.fullProjects.has(id)) continue
    const own = text(project?.clientId)
    const clients = own ? [own] : [...(clientsOfProject.get(id) || [])]
    if (!clients.length) continue
    if (clients.every(clientId => scope.fullClients.has(clientId))) {
      scope.fullProjects.add(id)
      if (clients.every(clientId => scope.writeClients.has(clientId))) scope.writeProjects.add(id)
    }
  }

  const creators = new Map<string, string>()
  for (const event of list(state?.workEvents))
    if (event?.action === 'created' && event.taskId && !creators.has(text(event.taskId)))
      creators.set(text(event.taskId), text(event.actorUserId))

  const byId = new Map(items.map(item => [text(item?.id), item]))
  const own = (item: any): { visible: boolean; write: boolean } => {
    const projectId = text(item?.projectId)
    const clientId = text(item?.clientId)
    const viaProject = Boolean(projectId) && scope.fullProjects.has(projectId)
    const viaClient = Boolean(clientId) && scope.fullClients.has(clientId)
    if (viaProject || viaClient)
      return {
        visible: true,
        write: (viaProject && scope.writeProjects.has(projectId)) || (viaClient && scope.writeClients.has(clientId)),
      }
    if (!projectId && !clientId) {
      const assignee = text(item?.assignedToUserId)
      const mine = assignee ? assignee === userId : creators.get(text(item?.id)) === userId
      return { visible: mine, write: mine }
    }
    return { visible: false, write: false }
  }
  for (const item of items) {
    const id = text(item?.id)
    if (!id) continue
    const parent = item?.parentTaskId ? byId.get(text(item.parentTaskId)) : undefined
    const result = own(parent || item)
    if (result.visible) scope.visibleItems.add(id)
    if (result.write) scope.writableItems.add(id)
  }

  for (const id of scope.fullClients) scope.labelClients.add(id)
  for (const id of scope.fullProjects) scope.labelProjects.add(id)
  for (const project of list(state?.projects))
    if (scope.fullProjects.has(text(project?.id)) && project?.clientId) scope.labelClients.add(text(project.clientId))
  for (const item of items) {
    if (!scope.visibleItems.has(text(item?.id))) continue
    if (item?.clientId) scope.labelClients.add(text(item.clientId))
    if (item?.projectId) scope.labelProjects.add(text(item.projectId))
  }
  return scope
}

const scopedVisible = (scope: Scope, record: any) =>
  (Boolean(record?.clientId) && scope.fullClients.has(text(record.clientId))) ||
  (Boolean(record?.projectId) && scope.fullProjects.has(text(record.projectId)))
const scopedWritable = (scope: Scope, record: any) =>
  (Boolean(record?.clientId) && scope.writeClients.has(text(record.clientId))) ||
  (Boolean(record?.projectId) && scope.writeProjects.has(text(record.projectId)))
const unscoped = (record: any) => !record?.clientId && !record?.projectId

export function canSeeItem(scope: Scope, itemId: string) {
  return scope.all || scope.visibleItems.has(itemId)
}
export function canChangeItem(scope: Scope, itemId: string) {
  return scope.all || scope.writableItems.has(itemId)
}
export function canSeeClient(scope: Scope, clientId: string) {
  return scope.all || scope.fullClients.has(clientId)
}
export function canChangeClient(scope: Scope, clientId: string) {
  return scope.all || scope.writeClients.has(clientId)
}

function limitedClient(client: any) {
  return {
    id: client.id,
    name: client.name,
    status: client.status,
    health: client.health,
    contact: '',
    email: '',
    notes: '',
    ...(client.archived ? { archived: true } : {}),
    ...(client.lifecycleVersion ? { lifecycleVersion: client.lifecycleVersion } : {}),
    ...(client.seedsId ? { seedsId: client.seedsId } : {}),
    accessLimited: true,
  }
}
function limitedProject(project: any) {
  return {
    id: project.id,
    name: project.name,
    status: project.status,
    targetDate: project.targetDate,
    summary: '',
    ...(project.clientId ? { clientId: project.clientId } : {}),
    ...(project.archived ? { archived: true } : {}),
    ...(project.lifecycleVersion ? { lifecycleVersion: project.lifecycleVersion } : {}),
    ...(project.seedsId ? { seedsId: project.seedsId } : {}),
    ...(project.contractNumber ? { contractNumber: project.contractNumber } : {}),
    accessLimited: true,
  }
}

/** The part of the workspace this person may hold. Clients and projects they only see by name lose their details. */
export function scopedState(state: any, scope: Scope) {
  if (scope.all || !state || typeof state !== 'object') return state
  return {
    ...state,
    clients: list(state.clients)
      .filter(client => scope.labelClients.has(text(client?.id)))
      .map(client => (scope.fullClients.has(text(client.id)) ? client : limitedClient(client))),
    projects: list(state.projects)
      .filter(project => scope.labelProjects.has(text(project?.id)))
      .map(project => (scope.fullProjects.has(text(project.id)) ? project : limitedProject(project))),
    items: list(state.items).filter(item => scope.visibleItems.has(text(item?.id))),
    activity: list(state.activity).filter(entry => scopedVisible(scope, entry)),
    planner: list(state.planner).filter(entry => unscoped(entry) || scopedVisible(scope, entry)),
    rtms: list(state.rtms).filter(matrix => scopedVisible(scope, matrix)),
    workEvents: list(state.workEvents).filter(
      event =>
        scope.visibleItems.has(text(event?.taskId)) ||
        scopedVisible(scope, event) ||
        (unscoped(event) && (event?.actorUserId === scope.userId || event?.assignedToUserId === scope.userId)),
    ),
    notifications: list(state.notifications).filter(
      notification => !notification?.taskId || scope.visibleItems.has(text(notification.taskId)),
    ),
  }
}

export class AccessDenied extends Error {
  status = 403
}

type Rules = {
  /** May this person change or delete an existing record? */
  writable: (record: any) => boolean
  /** May this person save this version (new, or moved to another client or project)? */
  allowed: (record: any, existing: any | undefined) => boolean
}

/**
 * Lays a save from someone who sees only part of the workspace onto the whole workspace. Records they cannot change
 * stay exactly as stored, wherever they are; their own records take their edits, deletions and order. New records
 * outside their scope are refused rather than dropped, so nothing they typed disappears silently.
 */
function mergeList(current: any[], incoming: any[], rules: Rules, label: string) {
  const currentById = new Map(current.map(record => [text(record?.id), record]))
  const accepted: any[] = []
  for (const record of incoming) {
    const existing = currentById.get(text(record?.id))
    if (existing && !rules.writable(existing)) continue
    if (!rules.allowed(record, existing))
      throw new AccessDenied(
        `You don't have access to save ${label} “${text(record?.name || record?.title || 'Untitled')}” there. Reload to see your current access.`,
      )
    accepted.push(record)
  }
  // Kept records fill their own slots, in the order the person left them; removed ones drop out. New records go
  // first if they were added at the top, otherwise at the end.
  const kept = accepted.filter(record => currentById.has(text(record?.id)))
  const keptIds = new Set(kept.map(record => text(record?.id)))
  const firstKept = accepted.findIndex(record => currentById.has(text(record?.id)))
  const added = accepted.filter(record => !currentById.has(text(record?.id)))
  const leading = firstKept < 0 ? [] : added.filter(record => accepted.indexOf(record) < firstKept)
  const trailing = added.filter(record => !leading.includes(record))
  const result: any[] = [...leading]
  let next = 0
  for (const record of current) {
    if (!rules.writable(record)) result.push(record)
    else if (keptIds.has(text(record?.id))) result.push(kept[next++])
  }
  return [...result, ...trailing]
}

export function mergeScopedSave(current: any, next: any, scope: Scope, options: { seedsConnected?: boolean } = {}) {
  if (scope.all) return next
  const currentItems = list(current?.items)
  const incomingItems = list(next?.items)
  const incomingById = new Map(incomingItems.map(item => [text(item?.id), item]))
  const placed = (item: any, seen = new Set<string>()): boolean => {
    const parentId = text(item?.parentTaskId)
    if (parentId && !seen.has(parentId)) {
      seen.add(parentId)
      if (scope.writableItems.has(parentId)) return true
      const parent = incomingById.get(parentId)
      if (parent && !currentItems.some(old => text(old?.id) === parentId)) return placed(parent, seen)
      return false
    }
    return unscoped(item) || scopedWritable(scope, item)
  }
  const moved = (record: any, existing: any) =>
    ['clientId', 'projectId', 'parentTaskId'].some(key => text(record?.[key]) !== text(existing?.[key]))
  const createdHere = (kind: string) => {
    if (options.seedsConnected) throw new AccessDenied(`New ${kind} come from Seeds. Add it in Seeds, then run a sync.`)
    return true
  }
  return {
    ...next,
    clients: mergeList(
      list(current?.clients),
      list(next?.clients),
      {
        writable: client => scope.writeClients.has(text(client?.id)),
        allowed: (_client, existing) => Boolean(existing) || createdHere('clients'),
      },
      'client',
    ),
    projects: mergeList(
      list(current?.projects),
      list(next?.projects),
      {
        writable: project => scope.writeProjects.has(text(project?.id)),
        allowed: (project, existing) =>
          existing
            ? !project?.clientId ||
              text(project.clientId) === text(existing.clientId) ||
              canChangeClient(scope, text(project.clientId))
            : createdHere('projects') && (!project?.clientId || scope.writeClients.has(text(project.clientId))),
      },
      'project',
    ),
    items: mergeList(
      currentItems,
      incomingItems,
      {
        writable: item => scope.writableItems.has(text(item?.id)),
        allowed: (item, existing) => (existing && !moved(item, existing)) || placed(item),
      },
      'task',
    ),
    planner: mergeList(
      list(current?.planner),
      list(next?.planner),
      {
        writable: entry => unscoped(entry) || scopedWritable(scope, entry),
        allowed: (entry, existing) =>
          (existing && !moved(entry, existing)) || unscoped(entry) || scopedWritable(scope, entry),
      },
      'activity',
    ),
    ...(next?.rtms === undefined
      ? {}
      : {
          rtms: mergeList(
            list(current?.rtms),
            list(next.rtms),
            {
              writable: matrix => scopedWritable(scope, matrix),
              allowed: matrix => scopedWritable(scope, matrix),
            },
            'traceability matrix',
          ),
        }),
  }
}

/** Assignments for the person's own clients and projects created in this save, so they keep seeing what they made. */
export function creatorAssignments(current: any, saved: any, userId: string): Assignment[] {
  const known = (key: string) => new Set(list(current?.[key]).map(record => text(record?.id)))
  const clients = known('clients')
  const projects = known('projects')
  const targets: { clientId?: string; projectId?: string }[] = [
    ...list(saved?.clients)
      .filter(client => client?.id && !clients.has(text(client.id)))
      .map(client => ({ clientId: text(client.id) })),
    ...list(saved?.projects)
      .filter(project => project?.id && !projects.has(text(project.id)))
      .map(project => ({ projectId: text(project.id) })),
  ]
  return targets.map(target => ({
    id: `manual:${userId}:BA:${target.projectId || target.clientId}`,
    userId,
    role: 'BA' as const,
    ...target,
    source: 'manual' as const,
  }))
}

export function clientAccessFor(state: any, user: { id: string; role?: string }): ClientAccess {
  const access = workspaceAccess(state)
  const fromSeeds = assignmentsFromSeeds(state, user.id)
  const scope = scopeFor(state, user.id)
  const active = activeAssignments(state, user.id)
  return {
    strictVisibility: access.strictVisibility,
    seedsConnected: state?.seeds?.connected === true,
    assignmentsFromSeeds: fromSeeds,
    roles: rolesFor(state, user.id),
    jobRoles: personRoles(state, user.id),
    ...(user.role === 'Administrator'
      ? {}
      : (() => {
          const roles = accessForRoles(state, personRoles(state, user.id))
          return roles ? { modules: roles.modules, editModules: roles.edit } : {}
        })()),
    assignments: active,
    ...(scope.all ? {} : { writableClientIds: [...scope.writeClients], writableProjectIds: [...scope.writeProjects] }),
  }
}
