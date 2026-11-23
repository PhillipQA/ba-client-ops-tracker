// Loading and saving each organisation's workspace.
import { rememberAccess } from '../services/access-cache'
import { normalizeInterfaceMode } from '../../src/features/settings/appearance'
import { LifecycleError } from '../../src/features/tasks/lifecycle'
import { assertRtmMutation, reconcileRtm } from '../../src/features/requirements/rtm'
import { normalizeAppTheme, normalizeClientThemes } from '../../src/features/settings/theme'
import {
  dateKeyInTimeZone,
  type FollowUpRolloverChange,
  rollOverOpenSubtaskFollowUps,
} from '../services/follow-up-rollover'
import { reconcileNotifications } from '../services/notification-engine'
import { createWorkspaceGuard } from '../services/workspace-guard'
import { workspaceVersion } from '../services/workspace-version'
import { type OrganizationInfo, type SessionUser, verifyPassword } from './auth'
import { followUpTimeZone } from './config'
import { ALL_MODULES, BXI_CORE_ORG_ID, defaultTaskSettings } from './constants'
import { db } from './database'

export async function loadLegacyTrackerState() {
  if (!db) return { configured: false, data: null as any, updatedAt: undefined as string | undefined }
  const { data, error } = await db.from('tracker_state').select('data, updated_at').eq('id', 'main').maybeSingle()
  if (error) throw error
  return { configured: true, data: data?.data ?? null, updatedAt: data?.updated_at as string | undefined }
}

export async function multiTenantSchemaReady() {
  if (!db) return false
  const { error } = await db.from('organizations').select('id').limit(1)
  return !error
}

export async function platformAuthSchemaReady() {
  if (!db) return false
  const { error } = await db.from('platform_users').select('id').limit(1)
  return !error
}

function normalizeOrganization(row: any): OrganizationInfo {
  return {
    id: String(row?.id || ''),
    name: String(row?.name || 'Workspace'),
    slug: String(row?.slug || ''),
    status: row?.status === 'Suspended' ? 'Suspended' : 'Active',
    enabledModules: Array.isArray(row?.enabled_modules)
      ? row.enabled_modules.filter((value: unknown) => ALL_MODULES.includes(String(value))).map(String)
      : [...ALL_MODULES],
  }
}

export async function organizationById(id?: string | null) {
  if (!db || !id) return null
  const { data, error } = await db
    .from('organizations')
    .select('id,name,slug,status,enabled_modules')
    .eq('id', id)
    .is('deleted_at', null)
    .maybeSingle()
  if (error) return null
  return data ? normalizeOrganization(data) : null
}

export async function organizationByLoginKey(account: string) {
  if (!db) return null
  const raw = account.trim()
  const slug = cleanSlug(raw)
  if (slug) {
    const { data, error } = await db
      .from('organizations')
      .select('id,name,slug,status,enabled_modules')
      .ilike('slug', slug)
      .is('deleted_at', null)
      .maybeSingle()
    if (!error && data) return normalizeOrganization(data)
  }
  const { data, error } = await db
    .from('organizations')
    .select('id,name,slug,status,enabled_modules')
    .ilike('name', raw)
    .is('deleted_at', null)
    .limit(1)
    .maybeSingle()
  if (error) return null
  return data ? normalizeOrganization(data) : null
}

const loadedRevisions = new WeakMap<object, string | null>()

export async function loadTenantState(organizationId?: string | null) {
  if (!db) return { configured: false, data: null as any, updatedAt: undefined as string | undefined }
  // A known tenant must never fall back to the original workspace after a DB error.
  if (organizationId) {
    const { data, error } = await db
      .from('tenant_state')
      .select('data, updated_at')
      .eq('organization_id', organizationId)
      .maybeSingle()
    if (error) throw error
    // Recover accounts missing from older/fresh snapshots without replacing operational data.
    // app_users is the authentication authority; passwords never come from the browser.
    const { data: users, error: usersError } = await db
      .from('app_users')
      .select('*')
      .eq('organization_id', organizationId)
      .is('deleted_at', null)
    if (usersError) throw usersError
    const snapshot = data?.data && typeof data.data === 'object' ? data.data : emptyTenantData()
    const accounts = Array.isArray(snapshot.accounts) ? snapshot.accounts : []
    const knownIds = new Set(accounts.map((account: any) => String(account.id)))
    const recovered = (users || []).filter((user: any) => !knownIds.has(String(user.id))).map(accountFromDatabase)
    const recoveredState = { ...snapshot, accounts: [...accounts, ...recovered] }
    loadedRevisions.set(recoveredState, data?.updated_at || null)
    rememberAccess(organizationId, recoveredState)
    return { configured: true, data: recoveredState, updatedAt: data?.updated_at as string | undefined }
  }
  return loadLegacyTrackerState()
}

export async function saveTenantState(organizationId: string | undefined, data: any, before: any) {
  const saved = await commitTenantState(organizationId, data, null, 'account-snapshot', before, false)
  return saved.syncedAt
}

function accountFromDatabase(row: any) {
  return {
    id: String(row.id),
    username: String(row.username || ''),
    passwordHash: String(row.password_hash || ''),
    name: String(row.name || row.username || ''),
    email: String(row.email || ''),
    phone: String(row.phone || ''),
    role: row.role || 'Contributor',
    modules: Array.isArray(row.modules) ? row.modules : [],
    status: row.status || 'Active',
    createdAt: String(row.created_on || new Date().toISOString().slice(0, 10)),
    theme: normalizeAppTheme(row.raw_data?.theme),
    clientThemes: normalizeClientThemes(row.raw_data?.clientThemes),
    interfaceMode: normalizeInterfaceMode(row.raw_data?.interfaceMode),
  }
}

// The users table is the authority for passwords, so re-checking a password reads it from there.
export async function verifyTenantUserPassword(user: SessionUser, plaintext: string) {
  if (!db || !user.organizationId || !plaintext) return false
  const { data, error } = await db
    .from('app_users')
    .select('password_hash,status')
    .eq('id', user.id)
    .eq('organization_id', user.organizationId)
    .is('deleted_at', null)
    .maybeSingle()
  if (error || !data || data.status === 'Disabled') return false
  return verifyPassword(plaintext, data.password_hash)
}

export function tenantIdForUser(user: SessionUser | null | undefined) {
  if (!user || user.accountType === 'platform') return undefined
  return user.organizationId || BXI_CORE_ORG_ID
}

type NormalizedSyncResult = {
  ready: boolean
  version?: string
  syncedAt?: string
  counts?: Record<string, number>
  error?: string
}

function cleanObject(value: any) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return value
}

export function sanitizedAccountRaw(account: any) {
  const { passwordHash: _passwordHash, ...safe } = cleanObject(account)
  return safe
}

export async function normalizedSchemaStatus(organizationId?: string): Promise<NormalizedSyncResult> {
  if (!db) return { ready: false, error: 'Database is not configured.' }
  const { error } = await db.from('data_migration_runs').select('id').limit(1)
  if (error) return { ready: false, error: error.message }
  let query = db
    .from('data_migration_runs')
    .select('completed_at, counts')
    .eq('status', 'completed')
    .order('completed_at', { ascending: false })
    .limit(1)
  if (organizationId && (await multiTenantSchemaReady())) query = query.eq('organization_id', organizationId)
  const { data: lastRun } = await query.maybeSingle()
  return { ready: true, syncedAt: lastRun?.completed_at || undefined, counts: lastRun?.counts || undefined }
}

function changedFields(before: any, after: any) {
  const keys = new Set([...Object.keys(cleanObject(before)), ...Object.keys(cleanObject(after))])
  return [...keys].filter(key => stable(before?.[key]) !== stable(after?.[key]))
}

export function authoritativeWorkEvents(current: any, next: any, actor: SessionUser) {
  const existing = Array.isArray(current?.workEvents) ? current.workEvents : []
  const beforeItems = new Map<string, any>(
    (Array.isArray(current?.items) ? current.items : []).map((item: any) => [String(item?.id || ''), item]),
  )
  const afterItems = new Map<string, any>(
    (Array.isArray(next?.items) ? next.items : []).map((item: any) => [String(item?.id || ''), item]),
  )
  const accounts = [
    ...(Array.isArray(next?.accounts) ? next.accounts : []),
    ...(Array.isArray(current?.accounts) ? current.accounts : []),
  ]
  const assigneeName = (id?: string) =>
    id ? accounts.find((account: any) => String(account?.id || '') === id)?.name || 'Unknown user' : undefined
  const closedStatuses = new Set(
    (Array.isArray(next?.taskSettings?.statuses) ? next.taskSettings.statuses : defaultTaskSettings.statuses)
      .filter((status: any) => status?.closed)
      .map((status: any) => String(status.label)),
  )
  const occurredAt = new Date().toISOString()
  const date = dateKeyInTimeZone(new Date(occurredAt), followUpTimeZone)
  const created: any[] = []
  const make = (item: any, action: string, summary: string, field?: string, oldValue?: string, newValue?: string) => ({
    id: crypto.randomUUID(),
    occurredAt,
    date,
    actorUserId: actor.id,
    actorName: actor.name,
    actorRole: actor.role,
    assignedToUserId: item.assignedToUserId || undefined,
    assignedToName: assigneeName(item.assignedToUserId),
    clientId: item.clientId || undefined,
    projectId: item.projectId || undefined,
    taskId: String(item.id),
    parentTaskId: item.parentTaskId || undefined,
    itemTitle: String(item.title || 'Untitled work item'),
    itemKind: item.parentTaskId ? 'Subtask' : 'Task',
    action,
    summary,
    field,
    oldValue,
    newValue,
  })
  for (const [id, item] of afterItems) {
    const before = beforeItems.get(id)
    if (!before) {
      created.push(
        make(item, 'created', `${actor.name} created ${item.parentTaskId ? 'subtask' : 'task'} “${item.title}”.`),
      )
      if (item.assignedToUserId)
        created.push(
          make(
            item,
            'assigned',
            `${actor.name} assigned “${item.title}” to ${assigneeName(item.assignedToUserId)}.`,
            'assignedToUserId',
            '',
            String(item.assignedToUserId),
          ),
        )
      continue
    }
    if (String(before.assignedToUserId || '') !== String(item.assignedToUserId || '')) {
      const action = before.assignedToUserId ? 'reassigned' : 'assigned'
      created.push(
        make(
          item,
          action,
          item.assignedToUserId
            ? `${actor.name} ${action === 'reassigned' ? `reassigned “${item.title}” from ${assigneeName(before.assignedToUserId)} to` : `assigned “${item.title}” to`} ${assigneeName(item.assignedToUserId)}.`
            : `${actor.name} removed the assignee from “${item.title}”.`,
          'assignedToUserId',
          String(before.assignedToUserId || ''),
          String(item.assignedToUserId || ''),
        ),
      )
    }
    if (String(before.startDate || '') !== String(item.startDate || '') && item.startDate)
      created.push(
        make(
          item,
          'started',
          `${actor.name} set the start date of “${item.title}” to ${item.startDate}.`,
          'startDate',
          String(before.startDate || ''),
          String(item.startDate),
        ),
      )
    if (String(before.status || '') !== String(item.status || '')) {
      const wasClosed =
        closedStatuses.has(String(before.status)) || ['Resolved', 'Closed'].includes(String(before.status))
      const isClosed = closedStatuses.has(String(item.status)) || ['Resolved', 'Closed'].includes(String(item.status))
      const action = isClosed
        ? 'completed'
        : wasClosed
          ? 'reopened'
          : item.status === 'In Progress'
            ? 'started'
            : 'status_changed'
      created.push(
        make(
          item,
          action,
          `${actor.name} changed “${item.title}” from ${before.status} to ${item.status}.`,
          'status',
          String(before.status || ''),
          String(item.status || ''),
        ),
      )
    }
    for (const [field, label] of [
      ['priority', 'priority'],
      ['waitingOn', 'waiting on'],
      ['dueDate', 'due date'],
      ['followUpDate', 'follow-up date'],
      ['estimateHours', 'estimate'],
      ['blockedBy', 'blocked-by tasks'],
      ['recurrence', 'repeat'],
      ['custom', 'custom fields'],
    ] as const) {
      // Lists and objects (repeat rules, custom field values) compare by content.
      const text = (value: unknown) => (value && typeof value === 'object' ? JSON.stringify(value) : String(value || ''))
      if (text(before[field]) !== text(item[field]))
        created.push(
          make(
            item,
            'updated',
            `${actor.name} changed the ${label} for “${item.title}”.`,
            field,
            text(before[field]),
            text(item[field]),
          ),
        )
    }
    const beforeEvidence = Array.isArray(before.evidence) ? before.evidence.length : 0
    const afterEvidence = Array.isArray(item.evidence) ? item.evidence.length : 0
    if (beforeEvidence !== afterEvidence)
      created.push(
        make(
          item,
          afterEvidence > beforeEvidence ? 'evidence_uploaded' : 'evidence_deleted',
          `${actor.name} ${afterEvidence > beforeEvidence ? 'uploaded evidence to' : 'removed evidence from'} “${item.title}”.`,
        ),
      )
  }
  for (const [id, item] of beforeItems)
    if (!afterItems.has(id))
      created.push(
        make(item, 'deleted', `${actor.name} deleted ${item.parentTaskId ? 'subtask' : 'task'} “${item.title}”.`),
      )
  return [...created, ...existing].slice(0, 10000)
}

function auditEntriesForChanges(
  current: any,
  next: any,
  actor: SessionUser | null,
  source = 'tracker',
  organizationId?: string,
) {
  const tenantReady = Boolean(organizationId)
  const groups = [
    ['client', current?.clients, next?.clients],
    ['project', current?.projects, next?.projects],
    ['work_item', current?.items, next?.items],
    ['activity', current?.activity, next?.activity],
    ['planner_activity', current?.planner, next?.planner],
    ['account', current?.accounts, next?.accounts],
  ] as const
  const entries: any[] = []
  for (const [entityType, beforeRowsRaw, afterRowsRaw] of groups) {
    const beforeRows = Array.isArray(beforeRowsRaw) ? beforeRowsRaw : []
    const afterRows = Array.isArray(afterRowsRaw) ? afterRowsRaw : []
    const beforeMap = new Map(beforeRows.map((row: any) => [String(row?.id || ''), row]))
    const afterMap = new Map(afterRows.map((row: any) => [String(row?.id || ''), row]))
    const ids = new Set([...beforeMap.keys(), ...afterMap.keys()])
    for (const id of ids) {
      if (!id) continue
      const before = beforeMap.get(id)
      const after = afterMap.get(id)
      if (stable(before) === stable(after)) continue
      const action = !before ? 'create' : !after ? 'delete' : 'update'
      const safeBefore = entityType === 'account' && before ? sanitizedAccountRaw(before) : before || null
      const safeAfter = entityType === 'account' && after ? sanitizedAccountRaw(after) : after || null
      entries.push({
        id: crypto.randomUUID(),
        ...(tenantReady ? { organization_id: organizationId } : {}),
        entity_type: entityType,
        entity_id: id,
        action,
        changed_fields: changedFields(safeBefore, safeAfter),
        before_data: safeBefore,
        after_data: safeAfter,
        changed_by: actor?.id || null,
        changed_by_name: actor?.name || 'System',
        source,
      })
    }
  }
  return entries
}

function normalizedRecords(state: any, organizationId: string) {
  const source = state && typeof state === 'object' ? state : {}
  const clients = Array.isArray(source.clients) ? source.clients : []
  const projects = Array.isArray(source.projects) ? source.projects : []
  const items = Array.isArray(source.items) ? source.items : []
  const activities = Array.isArray(source.activity) ? source.activity : []
  const planner = Array.isArray(source.planner) ? source.planner : []
  const accounts = Array.isArray(source.accounts) ? source.accounts : []
  const statuses = Array.isArray(source.taskSettings?.statuses)
    ? source.taskSettings.statuses
    : defaultTaskSettings.statuses
  const tasks = items.filter((item: any) => item?.type !== 'Inquiry')
  const inquiries = items.filter((item: any) => item?.type === 'Inquiry')
  const tenantReady = true
  return {
    clients: clients.map((row: any) => ({
      id: String(row.id),
      name: row.name || '',
      contact: row.contact || '',
      email: row.email || '',
      status: row.status || '',
      health: row.health || '',
      notes: row.notes || '',
      raw_data: row,
    })),
    projects: projects.map((row: any) => ({
      id: String(row.id),
      name: row.name || '',
      status: row.status || '',
      target_date: row.targetDate || null,
      summary: row.summary || '',
      raw_data: row,
    })),
    tasks: tasks.map((row: any) => ({
      id: String(row.id),
      client_id: row.clientId || null,
      project_id: row.projectId || null,
      parent_task_id: row.parentTaskId || null,
      subtask_order: Number.isFinite(row.subtaskOrder) ? row.subtaskOrder : null,
      title: row.title || '',
      type: row.type || 'Task',
      priority: row.priority || '',
      status: row.status || '',
      waiting_on: row.waitingOn || '',
      owner: row.owner || '',
      date_raised: row.dateRaised || null,
      due_date: row.dueDate || null,
      follow_up_date: row.followUpDate || null,
      description: row.description || '',
      resolution: row.resolution || '',
      resolved_date: row.resolvedDate || null,
      source: row.source || '',
      external_source_id: row.externalSourceId || null,
      source_sender: row.sourceSender || null,
      raw_data: row,
    })),
    inquiries: inquiries.map((row: any) => ({
      id: String(row.id),
      client_id: row.clientId || null,
      project_id: row.projectId || null,
      title: row.title || '',
      priority: row.priority || '',
      status: row.status || '',
      waiting_on: row.waitingOn || '',
      owner: row.owner || '',
      date_raised: row.dateRaised || null,
      follow_up_date: row.followUpDate || null,
      description: row.description || '',
      resolution: row.resolution || '',
      resolved_date: row.resolvedDate || null,
      source: row.source || '',
      external_source_id: row.externalSourceId || null,
      source_sender: row.sourceSender || null,
      raw_data: row,
    })),
    activity_logs: activities.map((row: any) => ({
      id: String(row.id),
      client_id: row.clientId || null,
      project_id: row.projectId || null,
      activity_date: row.date || null,
      text: row.text || '',
      raw_data: row,
    })),
    planner_activities: planner.map((row: any) => ({
      id: String(row.id),
      client_id: row.clientId || null,
      project_id: row.projectId || null,
      title: row.title || '',
      activity_date: row.date || null,
      start_time: row.startTime || null,
      end_time: row.endTime || null,
      end_date: row.endDate || null,
      all_day: Boolean(row.allDay),
      source: row.source || '',
      status: row.status || '',
      notes: row.notes || '',
      calendar_event_id: row.calendarEventId || null,
      calendar_link: row.calendarLink || null,
      raw_data: row,
    })),
    app_users: accounts.map((row: any) => ({
      id: String(row.id),
      username: row.username || '',
      password_hash: row.passwordHash || '',
      name: row.name || '',
      email: row.email || '',
      phone: row.phone || '',
      role: row.role || '',
      modules: Array.isArray(row.modules) ? row.modules : [],
      status: row.status || '',
      created_on: row.createdAt || null,
      raw_data: sanitizedAccountRaw(row),
    })),
    task_statuses: statuses.map((row: any, index: number) => ({
      id: tenantReady ? `${organizationId}:${String(row.id)}` : String(row.id),
      label: row.label || '',
      is_completed: Boolean(row.closed),
      sort_order: index,
      raw_data: row,
    })),
    app_settings: [
      {
        id: tenantReady ? `${organizationId}:task-settings` : 'task-settings',
        setting_key: tenantReady ? `task_settings:${organizationId}` : 'task_settings',
        value: source.taskSettings || defaultTaskSettings,
        raw_data: source.taskSettings || defaultTaskSettings,
      },
    ],
  }
}

export class TenantSaveError extends Error {
  constructor(
    message: string,
    public status: number,
    /** Another save got in first: fetching the latest and merging can succeed. */
    public raced = false,
  ) {
    super(message)
  }
}

const guardWorkspace = createWorkspaceGuard(
  async id => (await loadTenantState(id)).data,
  () => emptyTenantData() as any,
)

/**
 * Called after a workspace save is stored, with the state before and after it. Listeners run after the save has
 * answered and never affect it: a listener that fails is only logged.
 */
export type TenantCommitListener = (
  organizationId: string,
  before: any,
  after: any,
  actor: SessionUser | null,
) => unknown
const commitListeners = new Set<TenantCommitListener>()
export function onTenantCommitted(listener: TenantCommitListener) {
  commitListeners.add(listener)
  return () => void commitListeners.delete(listener)
}
function announceCommit(organizationId: string, before: any, after: any, actor: SessionUser | null) {
  for (const listener of commitListeners)
    setImmediate(() => {
      Promise.resolve()
        .then(() => listener(organizationId, before, after, actor))
        .catch(error => console.error('A follow-up to a workspace save failed:', error?.message || error))
    })
}

export async function commitTenantState(
  organizationId: string | undefined,
  state: any,
  actor: SessionUser | null,
  reason: string,
  before?: any,
  synchronize = true,
): Promise<NormalizedSyncResult> {
  if (!organizationId) throw new TenantSaveError('A tenant workspace is required.', 403)
  return guardWorkspace(organizationId, state, actor, before, async current => {
    // Older clients must preserve RTMs; all writes use server-derived history.
    if (state.rtms === undefined) state = { ...state, rtms: current.rtms || [] }
    assertRtmMutation(current, state, actor)
    const reconciled = reconcileRtm(current, state, actor)
    const saved = await writeTenantState(organizationId, reconciled, actor, reason, current, synchronize)
    rememberAccess(organizationId, reconciled)
    announceCommit(organizationId, current, reconciled, actor)
    return saved
  })
}

type TenantRolloverResult = {
  configured: boolean
  data: any
  updatedAt?: string
  changes: FollowUpRolloverChange[]
  notificationCount: number
}

export async function ensureTenantFollowUpsCurrent(organizationId: string): Promise<TenantRolloverResult> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const current = await loadTenantState(organizationId)
    const rollover = rollOverOpenSubtaskFollowUps(current.data || emptyTenantData(), { timeZone: followUpTimeZone })
    const existingEventIds = new Set(
      (Array.isArray(current.data?.workEvents) ? current.data.workEvents : []).map((event: any) =>
        String(event?.id || ''),
      ),
    )
    const newEventIds = (Array.isArray(rollover.state?.workEvents) ? rollover.state.workEvents : [])
      .filter((event: any) => !existingEventIds.has(String(event?.id || '')))
      .map((event: any) => String(event.id))
    const notifications = reconcileNotifications(rollover.state, {
      today: dateKeyInTimeZone(new Date(), followUpTimeZone),
      newEventIds,
    })
    if (!rollover.changed && !notifications.changed) return { ...current, changes: [], notificationCount: 0 }
    try {
      const reason = rollover.changed ? 'follow-up-auto-rollover' : 'notification-reconcile'
      await commitTenantState(organizationId, notifications.state, null, reason, current.data, rollover.changed)
      // Read the saved workspace back: a save that follows (read all, dismiss, time entry) must start from a copy the
      // server knows the revision of, or it is refused as out of date ("Reload the workspace before saving").
      const fresh = await loadTenantState(organizationId)
      return {
        configured: true,
        data: fresh.data,
        updatedAt: fresh.updatedAt,
        changes: rollover.changes,
        notificationCount: notifications.created.length,
      }
    } catch (error) {
      if (
        attempt === 0 &&
        (error instanceof LifecycleError || (error instanceof TenantSaveError && error.status === 409))
      )
        continue
      throw error
    }
  }
  const current = await loadTenantState(organizationId)
  return { ...current, changes: [], notificationCount: 0 }
}

async function writeTenantState(
  organizationId: string | undefined,
  state: any,
  actor: SessionUser | null,
  reason: string,
  before?: any,
  synchronize = true,
): Promise<NormalizedSyncResult> {
  if (!db) throw new TenantSaveError('Database is not configured.', 503)
  if (!organizationId) throw new TenantSaveError('A tenant workspace is required.', 403)
  if (!before || !loadedRevisions.has(before)) throw new TenantSaveError('Reload the workspace before saving.', 409)
  const { data, error } = await db.rpc('save_tenant_state_v16', {
    p_expected_updated_at: loadedRevisions.get(before),
    p_organization_id: organizationId,
    p_state: state,
    p_records: synchronize ? normalizedRecords(state, organizationId) : null,
    p_audit_entries: before ? auditEntriesForChanges(before, state, actor, reason, organizationId) : [],
    p_actor_id: actor?.id || null,
    p_reason: reason,
  })
  if (error) {
    if (error.code === 'PGRST202' || error.code === '42883')
      throw new TenantSaveError(
        'The workspace save function is missing. Check the database connection; a new database needs database/schema.sql.',
        409,
      )
    const status =
      error.code === '40001'
        ? 409
        : error.code === '42501'
          ? 403
          : ['23505', '23514', '22023', '22007', '22008'].includes(error.code)
            ? 400
            : 500
    throw new TenantSaveError(error.message || 'The tenant save was rolled back.', status, error.code === '40001')
  }
  return { ...data, version: workspaceVersion(state) } as NormalizedSyncResult
}

export async function syncNormalizedState(
  state: any,
  actor: SessionUser | null = null,
  reason = 'sync',
  organizationId?: string,
): Promise<NormalizedSyncResult> {
  return commitTenantState(organizationId, state, actor, reason, state)
}

export function notificationsForUser(state: any, userId: string) {
  return (Array.isArray(state?.notifications) ? state.notifications : [])
    .filter((notification: any) => String(notification?.recipientUserId || '') === userId && !notification?.dismissedAt)
    .sort((a: any, b: any) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
}

export function stable(value: unknown): string | undefined {
  return JSON.stringify(value, (_key, entry) =>
    entry && typeof entry === 'object' && !Array.isArray(entry)
      ? Object.fromEntries(
          Object.keys(entry)
            .sort()
            .map(key => [key, entry[key]]),
        )
      : entry,
  )
}

export function emptyTenantData(accounts: any[] = []) {
  return {
    schemaVersion: 6,
    clients: [],
    projects: [],
    items: [],
    activity: [],
    planner: [],
    workEvents: [],
    notifications: [],
    accounts,
    taskSettings: defaultTaskSettings,
  }
}

export function cleanSlug(value: unknown) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
}

export function cleanModules(value: unknown) {
  return Array.isArray(value) ? [...new Set(value.map(String).filter(module => ALL_MODULES.includes(module)))] : []
}

export async function usernameExists(organizationId: string, username: string, excludeId?: string) {
  if (!db) return false
  let query = db
    .from('app_users')
    .select('id')
    .eq('organization_id', organizationId)
    .ilike('username', username)
    .is('deleted_at', null)
    .limit(1)
  if (excludeId) query = query.neq('id', excludeId)
  const { data, error } = await query
  if (error) throw error
  return Boolean(data?.length)
}

export async function updateTenantAccountSnapshot(
  organizationId: string,
  accountId: string,
  updater: (account: any | null) => any | null,
) {
  const state = await loadTenantState(organizationId)
  const base = state.data && typeof state.data === 'object' ? state.data : emptyTenantData()
  const accounts = Array.isArray(base.accounts) ? base.accounts : []
  const existing = accounts.find((account: any) => String(account.id) === accountId) || null
  const updated = updater(existing)
  const nextAccounts = updated
    ? existing
      ? accounts.map((account: any) => (String(account.id) === accountId ? updated : account))
      : [...accounts, updated]
    : accounts.filter((account: any) => String(account.id) !== accountId)
  const next = {
    ...base,
    schemaVersion: 6,
    workEvents: Array.isArray(base.workEvents) ? base.workEvents : [],
    accounts: nextAccounts,
    taskSettings: base.taskSettings || defaultTaskSettings,
  }
  await saveTenantState(organizationId, next, base)
  return next
}
