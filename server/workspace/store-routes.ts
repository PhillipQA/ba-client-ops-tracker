import type express from 'express'
import type { Express } from 'express'
import { normalizeInterfaceMode } from '../../src/features/settings/appearance'
import { assertLifecycleMutation, LifecycleError } from '../../src/features/tasks/lifecycle'
import { applySubtaskAssignmentInheritance } from '../../src/features/tasks/subtaskAssignment'
import { normalizeAppTheme, normalizeClientThemes } from '../../src/features/settings/theme'
import { preserveInterfaceModes } from '../accounts/preferences'
import {
  AccessDenied,
  assignmentsFromSeeds,
  creatorAssignments,
  mergeScopedSave,
  scopeFor,
  workspaceAccess,
} from '../../src/shared/access'
import { keepSeedsFields } from '../../src/shared/seeds'
import { WorkspaceRaceError } from '../services/workspace-guard'
import {
  isBcryptHash,
  isLegacyDigest,
  moduleAllowed,
  requireAuth,
  requireTenantWorkspace,
  safeUser,
  secureHashDigest,
  sessions,
  type SessionUser,
} from '../core/auth'
import { followUpTimeZone } from '../core/config'
import { ALL_MODULES, defaultTaskSettings } from '../core/constants'
import { db } from '../core/database'
import {
  authoritativeWorkEvents,
  commitTenantState,
  ensureTenantFollowUpsCurrent,
  loadTenantState,
  multiTenantSchemaReady,
  normalizedSchemaStatus,
  notificationsForUser,
  organizationById,
  stable,
  syncNormalizedState,
  tenantIdForUser,
  TenantSaveError,
} from '../core/tenant-state'
import { requirePlatformAdmin } from '../platform/platform-auth'
import { accountChangesAreSelfOnly } from '../services/account-guard'
import { sanitizeStateForClient } from '../services/client-state'
import { dateKeyInTimeZone } from '../services/follow-up-rollover'
import {
  markAllNotificationsReadForUser,
  reconcileNotifications,
  updateNotificationForUser,
} from '../services/notification-engine'
import { preserveTaskSettings } from '../services/tenant-save-settings'
import { applyEffortSaveRules } from '../services/time-entries'
import { readNotificationState, readWorkspaceRevision, workspaceRevision } from '../services/workspace-reads'
import { mergeActivity, workspaceVersion } from '../services/workspace-version'

function accountDefaults(account: any) {
  return {
    ...account,
    theme: normalizeAppTheme(account?.theme),
    clientThemes: normalizeClientThemes(account?.clientThemes),
    interfaceMode: normalizeInterfaceMode(account?.interfaceMode),
  }
}

async function prepareAccountPasswords(currentAccounts: any[], nextAccounts: any[]) {
  const currentMap = new Map(currentAccounts.map(account => [String(account?.id || ''), account]))
  return Promise.all(
    nextAccounts.map(async (account: any) => {
      const id = String(account?.id || '')
      const current = currentMap.get(id)
      const incoming = String(account?.passwordHash || '')
      const currentHash = String(current?.passwordHash || '')

      // GET /api/store never returns real password hashes. Blank means preserve the server copy.
      if (!incoming) {
        if (currentHash) return { ...account, passwordHash: currentHash }
        throw new Error(`A password is required for new account ${String(account?.username || id || 'user')}.`)
      }

      // An unchanged server-side bcrypt hash may only appear in trusted/legacy internal state.
      if (currentHash && incoming === currentHash) return account

      // Browser account/profile forms send a SHA-256 digest; bcrypt it before storage.
      if (isLegacyDigest(incoming)) return { ...account, passwordHash: await secureHashDigest(incoming.toLowerCase()) }

      // Never accept a new bcrypt hash supplied by a browser/client request.
      if (isBcryptHash(incoming)) throw new Error('Client-supplied password hashes are not accepted.')
      throw new Error('Invalid password update payload.')
    }),
  )
}

/** The workspace store, its revision, notifications and the data-architecture checks. */
export function registerStoreRoutes(app: Express) {
  app.get('/api/data-architecture/status', requireAuth, requirePlatformAdmin, async (req, res) => {
    try {
      const organization = await organizationById(String(req.query.organizationId || ''))
      if (!organization) return void res.status(400).json({ error: 'Choose an account.' })
      const status = await normalizedSchemaStatus(organization.id)
      res.json({
        ...status,
        multiTenant: await multiTenantSchemaReady(),
        organizationId: organization.id,
        organizationName: organization.name,
      })
    } catch (error) {
      res.status(500).json({
        ready: false,
        error: error instanceof Error ? error.message : 'Could not check normalized data architecture.',
      })
    }
  })

  app.post('/api/data-architecture/migrate', requireAuth, requirePlatformAdmin, async (req, res) => {
    const user = (req as express.Request & { authUser: SessionUser }).authUser
    if (user.role !== 'Administrator') return void res.status(403).json({ error: 'Administrator access is required.' })
    try {
      const organization = await organizationById(String(req.body?.organizationId || ''))
      if (!organization) return void res.status(400).json({ error: 'Choose an account.' })
      const organizationId = organization.id
      const state = await loadTenantState(organizationId)
      if (!state.data) return void res.status(400).json({ error: 'There is no tracker state to migrate yet.' })
      const result = await syncNormalizedState(state.data, user, 'manual-migration', organizationId)
      if (!result.ready) return void res.status(409).json(result)
      if (result.error) return void res.status(500).json(result)
      res.json(result)
    } catch (error) {
      res.status(500).json({ ready: false, error: error instanceof Error ? error.message : 'Migration failed.' })
    }
  })

  app.get('/api/store/revision', requireAuth, requireTenantWorkspace, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    if (!db) return void res.status(503).json({ configured: false, error: 'Database is not configured.' })
    const user = (req as express.Request & { authUser: SessionUser }).authUser
    try {
      res.json(await readWorkspaceRevision(db, String(tenantIdForUser(user)), followUpTimeZone))
    } catch {
      res.status(500).json({ error: 'Could not check the workspace revision.' })
    }
  })

  app.get('/api/store', requireAuth, requireTenantWorkspace, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    if (!db) {
      res.status(503).json({ configured: false, data: null, error: 'Database is not configured.' })
      return
    }
    const user = (req as express.Request & { authUser: SessionUser }).authUser
    try {
      const state = await ensureTenantFollowUpsCurrent(String(tenantIdForUser(user)))
      res.json({
        configured: true,
        data: sanitizeStateForClient(state.data, user),
        updatedAt: state.updatedAt,
        version: workspaceVersion(state.data),
        revision: workspaceRevision(state.updatedAt, followUpTimeZone),
        timeZone: followUpTimeZone,
        organizationId: user.organizationId,
        organizationName: user.organizationName,
      })
    } catch (error) {
      console.error('Database load failed:', error)
      res
        .status(500)
        .json({ configured: true, error: error instanceof Error ? error.message : 'Cloud database load failed.' })
    }
  })

  app.get('/api/notifications', requireAuth, requireTenantWorkspace, async (req, res) => {
    if (!db)
      return void res.status(503).json({ configured: false, notifications: [], error: 'Database is not configured.' })
    const user = (req as express.Request & { authUser: SessionUser }).authUser
    try {
      const current = await readNotificationState(db, String(tenantIdForUser(user)))
      res.json({
        configured: true,
        notifications: notificationsForUser(current, user.id),
        updatedAt: current.updatedAt,
      })
    } catch (error) {
      res.status(500).json({
        configured: true,
        notifications: [],
        error: error instanceof Error ? error.message : 'Notifications could not be loaded.',
      })
    }
  })

  app.put('/api/notifications/:notificationId', requireAuth, requireTenantWorkspace, async (req, res) => {
    if (!db) return void res.status(503).json({ error: 'Database is not configured.' })
    const user = (req as express.Request & { authUser: SessionUser }).authUser
    const action = String(req.body?.action || '') as 'read' | 'unread' | 'dismiss'
    if (!['read', 'unread', 'dismiss'].includes(action))
      return void res.status(400).json({ error: 'Choose read, unread, or dismiss.' })
    try {
      const current = await ensureTenantFollowUpsCurrent(String(tenantIdForUser(user)))
      const updated = updateNotificationForUser(current.data, String(req.params.notificationId || ''), user.id, action)
      if (!updated.matched) return void res.status(404).json({ error: 'Notification was not found.' })
      const saved = await commitTenantState(
        tenantIdForUser(user),
        updated.state,
        user,
        `notification-${action}`,
        current.data,
        false,
      )
      res.json({ notifications: notificationsForUser(updated.state, user.id), updatedAt: saved.syncedAt })
    } catch (error) {
      res
        .status(error instanceof LifecycleError ? error.status : 500)
        .json({ error: error instanceof Error ? error.message : 'Notification could not be updated.' })
    }
  })

  app.post('/api/notifications/read-all', requireAuth, requireTenantWorkspace, async (req, res) => {
    if (!db) return void res.status(503).json({ error: 'Database is not configured.' })
    const user = (req as express.Request & { authUser: SessionUser }).authUser
    try {
      const current = await ensureTenantFollowUpsCurrent(String(tenantIdForUser(user)))
      const updated = markAllNotificationsReadForUser(current.data, user.id)
      if (!updated.changed)
        return void res.json({
          notifications: notificationsForUser(current.data, user.id),
          updatedAt: current.updatedAt,
        })
      const saved = await commitTenantState(
        tenantIdForUser(user),
        updated.state,
        user,
        'notification-read-all',
        current.data,
        false,
      )
      res.json({ notifications: notificationsForUser(updated.state, user.id), updatedAt: saved.syncedAt })
    } catch (error) {
      res
        .status(error instanceof LifecycleError ? error.status : 500)
        .json({ error: error instanceof Error ? error.message : 'Notifications could not be updated.' })
    }
  })

  app.put('/api/store', requireAuth, requireTenantWorkspace, async (req, res) => {
    if (!db) {
      res.status(503).json({ configured: false, error: 'Database is not configured.' })
      return
    }
    let next = req.body?.data
    if (!next || typeof next !== 'object' || Array.isArray(next)) {
      res.status(400).json({ configured: true, error: 'A tracker data object is required.' })
      return
    }

    const user = (req as express.Request & { authUser: SessionUser }).authUser
    const organizationId = tenantIdForUser(user)
    try {
      const currentState = await ensureTenantFollowUpsCurrent(String(organizationId))
      if (currentState.changes.length) {
        res.status(409).json({
          configured: true,
          refreshRequired: true,
          error: `${currentState.changes.length} open Subtask follow-up${currentState.changes.length === 1 ? '' : 's'} rolled forward automatically. Reload to preserve the System trail before saving your change.`,
        })
        return
      }
      const current =
        currentState.data && typeof currentState.data === 'object'
          ? currentState.data
          : {
              schemaVersion: 6,
              clients: [],
              projects: [],
              items: [],
              activity: [],
              planner: [],
              workEvents: [],
              notifications: [],
              accounts: [],
              taskSettings: defaultTaskSettings,
            }

      if (typeof req.body?.baseVersion !== 'string' || req.body.baseVersion !== workspaceVersion(current)) {
        return void res.status(409).json({
          configured: true,
          refreshRequired: true,
          error:
            'This workspace has newer changes. Your edits are retained locally. Download them and reload the latest workspace before reapplying your change.',
        })
      }

      // With per-person visibility on, the browser holds only part of the workspace. Lay its save onto the whole
      // workspace: records it cannot see or change stay as stored. Access and Seeds data belong to the server.
      const scope = scopeFor(current, user.id)
      try {
        next = mergeScopedSave(current, next, scope, { seedsConnected: assignmentsFromSeeds(current, user.id) })
      } catch (error) {
        if (error instanceof AccessDenied) return void res.status(403).json({ configured: true, error: error.message })
        throw error
      }
      const { access: _sentAccess, seeds: _sentSeeds, jobRoles: _sentRoles, ...edited } = next
      next = keepSeedsFields(current, {
        ...edited,
        ...(current.access !== undefined ? { access: current.access } : {}),
        ...(current.seeds !== undefined ? { seeds: current.seeds } : {}),
        // Job roles change only in Settings › Roles.
        ...(current.jobRoles !== undefined ? { jobRoles: current.jobRoles } : {}),
      })

      // The browser may add default display columns while loading old tenant
      // data. Ordinary workspace saves cannot edit platform-managed settings.
      next = preserveTaskSettings(current, { ...next, schemaVersion: Math.max(6, Number(next.schemaVersion || 0)) })

      const currentItems = Array.isArray(current.items) ? current.items : []
      const nextItems = Array.isArray(next.items) ? next.items : []
      const legacyDiscordItems = currentItems.filter(
        (item: any) => item?.source === 'Discord' && item?.externalSourceId,
      )
      // Quarantine captures created before user ownership existed; clients cannot alter or read them.
      next = {
        ...next,
        items: [
          ...nextItems.filter((item: any) => !legacyDiscordItems.some((old: any) => old.id === item.id)),
          ...legacyDiscordItems,
        ],
      }

      const currentAccounts = Array.isArray(current.accounts) ? current.accounts.map(accountDefaults) : []
      const incomingAccounts = preserveInterfaceModes(currentAccounts, currentAccounts)
      const nextAccounts = await prepareAccountPasswords(currentAccounts, incomingAccounts)
      const assignableUsers = new Map(
        nextAccounts
          .filter(
            (account: any) =>
              account.status === 'Active' && (account.role === 'Administrator' || account.role === 'Contributor'),
          )
          .map((account: any) => [String(account.id), account]),
      )
      const currentItemMap = new Map(currentItems.map((item: any) => [String(item?.id || ''), item]))
      const inheritedItems = applySubtaskAssignmentInheritance<any>(
        currentItems,
        Array.isArray(next.items) ? next.items : [],
      )
      const normalizedItems = inheritedItems.map((item: any) => {
        const assignedToUserId = String(item?.assignedToUserId || '')
        if (assignedToUserId && !assignableUsers.has(assignedToUserId))
          throw new TenantSaveError(
            `Task “${String(item?.title || 'Untitled')}” must be assigned to an active Administrator or Contributor in this workspace.`,
            400,
          )
        const startDate = String(item?.startDate || '')
        const dueDate = String(item?.dueDate || '')
        if (startDate && !/^\d{4}-\d{2}-\d{2}$/.test(startDate))
          throw new TenantSaveError('Task Start Date must use YYYY-MM-DD.', 400)
        if (dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(dueDate))
          throw new TenantSaveError('Task Due Date must use YYYY-MM-DD.', 400)
        if (startDate && dueDate && dueDate < startDate)
          throw new TenantSaveError(
            `Task “${String(item?.title || 'Untitled')}” cannot be due before its Start Date.`,
            400,
          )
        const currentItem = currentItemMap.get(String(item?.id || '')) as any
        const comments = Array.isArray(currentItem?.comments) ? currentItem.comments : []
        const effort = applyEffortSaveRules(currentItem, item)
        if (!effort.ok) throw new TenantSaveError(effort.error, effort.status)
        return {
          ...effort.value,
          comments,
          evidence: currentItem?.evidence || [],
          docHubDocuments: currentItem?.docHubDocuments || [],
          driveFiles: currentItem?.driveFiles || [],
          assignedToUserId: assignedToUserId || undefined,
          owner: assignedToUserId ? String(assignableUsers.get(assignedToUserId)?.name || '') : '',
        }
      })
      // Work history is derived on the server from the authenticated actor. Browser-supplied
      // event identities are never trusted, so assignment and action reports remain auditable.
      const candidateNext = {
        ...next,
        activity: mergeActivity(current.activity, next.activity),
        rtms: next.rtms === undefined ? current.rtms || [] : next.rtms,
        // Time logged from calendar events is written only by /api/seeds/calendar-time, never by a workspace save.
        calendarTime: Array.isArray(current.calendarTime) ? current.calendarTime : [],
        accounts: nextAccounts,
        items: normalizedItems,
        notifications: Array.isArray(current.notifications) ? current.notifications : [],
        notificationState: current.notificationState,
      }
      const workEvents = authoritativeWorkEvents(current, candidateNext, user)
      const existingEventIds = new Set(
        (Array.isArray(current.workEvents) ? current.workEvents : []).map((event: any) => String(event?.id || '')),
      )
      const newEventIds = workEvents
        .filter((event: any) => !existingEventIds.has(String(event?.id || '')))
        .map((event: any) => String(event.id))
      next = reconcileNotifications(
        { ...candidateNext, workEvents },
        { today: dateKeyInTimeZone(new Date(), followUpTimeZone), newEventIds },
      ).state
      const accountsChanged = stable(currentAccounts) !== stable(nextAccounts)
      const selfOnlyAccounts = accountsChanged && accountChangesAreSelfOnly(currentAccounts, nextAccounts, user.id)
      if (accountsChanged && !selfOnlyAccounts)
        return void res.status(403).json({
          error:
            'Manage users and access in Users & Permissions. Reload if another administrator changed account users.',
        })
      if (stable(current.taskSettings ?? defaultTaskSettings) !== stable(next.taskSettings ?? defaultTaskSettings))
        return void res
          .status(409)
          .json({ error: 'Task configuration is managed in Internal Admin. Reload this workspace before saving.' })

      if (user.role === 'Viewer') {
        const operationalUnchanged =
          ['clients', 'projects', 'items', 'activity', 'planner', 'rtms'].every(
            key => stable(current[key] ?? []) === stable(next[key] ?? []),
          ) && stable(current.taskSettings ?? defaultTaskSettings) === stable(next.taskSettings ?? defaultTaskSettings)
        if (!operationalUnchanged || (accountsChanged && !selfOnlyAccounts))
          return void res
            .status(403)
            .json({ configured: true, error: 'Viewer accounts are read-only except for their own profile.' })
      }

      // Job roles say which pages a person may change (shared/roles.ts); without one, the pages they see.
      const editModules: string[] | undefined = (user as any).editModules
      const canChange = (module: string) => (editModules ? editModules.includes(module) : moduleAllowed(user, module))
      if (user.role === 'Contributor') {
        if (accountsChanged && !selfOnlyAccounts)
          return void res
            .status(403)
            .json({ configured: true, error: 'Only Administrators can manage other accounts.' })
        if (stable(current.taskSettings ?? defaultTaskSettings) !== stable(next.taskSettings ?? defaultTaskSettings))
          return void res
            .status(403)
            .json({ configured: true, error: 'Only Administrators can change task configuration.' })
        if (stable(current.clients ?? []) !== stable(next.clients ?? []) && !canChange('clients'))
          return void res.status(403).json({ configured: true, error: 'Client module access is required.' })
        if (stable(current.projects ?? []) !== stable(next.projects ?? []) && !canChange('projects'))
          return void res.status(403).json({ configured: true, error: 'Project module access is required.' })
        if (stable(current.items ?? []) !== stable(next.items ?? []) && !canChange('items') && !canChange('inbox'))
          return void res.status(403).json({ configured: true, error: 'Task module access is required.' })
        if (stable(current.planner ?? []) !== stable(next.planner ?? []) && !canChange('action'))
          return void res.status(403).json({ configured: true, error: 'Action Center access is required.' })
        if (editModules && stable(current.rtms ?? []) !== stable(next.rtms ?? []) && !canChange('requirements'))
          return void res.status(403).json({ configured: true, error: 'Your role cannot change requirements.' })
      }

      if (accountsChanged && user.role === 'Administrator') {
        const allowedModules = new Set(user.organizationModules || ALL_MODULES)
        for (const account of nextAccounts) {
          const modules = Array.isArray(account.modules) ? account.modules : []
          if (modules.some((module: string) => !allowedModules.has(module)))
            return void res
              .status(400)
              .json({ configured: true, error: 'A user cannot be assigned a module disabled for this workspace.' })
        }
        if (await multiTenantSchemaReady()) {
          const { data: existingUsers, error: existingUsersError } = await db
            .from('app_users')
            .select('id,username,organization_id')
            .eq('organization_id', organizationId)
            .is('deleted_at', null)
          if (existingUsersError) throw existingUsersError
          for (const account of nextAccounts) {
            const duplicate = (existingUsers || []).find(
              (existing: any) =>
                String(existing.id) !== String(account.id) &&
                String(existing.username || '').toLowerCase() === String(account.username || '').toLowerCase(),
            )
            if (duplicate)
              return void res
                .status(409)
                .json({ configured: true, error: `Username ${account.username} is already used in this workspace.` })
          }
        }
      }

      // Someone who sees only their own clients keeps seeing the clients and projects they create.
      if (!scope.all) {
        const access = workspaceAccess(current)
        const created = creatorAssignments(current, next, user.id).filter(
          assignment => !access.assignments.some(existing => existing.id === assignment.id),
        )
        if (created.length) next = { ...next, access: { ...access, assignments: [...access.assignments, ...created] } }
      }

      assertLifecycleMutation(current, next, user)
      const saved = await commitTenantState(organizationId, next, user, 'tracker-save', current)
      const updatedAt = saved.syncedAt

      const organization = await organizationById(organizationId)
      if (user.role === 'Administrator' && accountsChanged) {
        for (const [token, sessionUser] of sessions.entries()) {
          if (sessionUser.organizationId !== organizationId) continue
          const account = nextAccounts.find((candidate: any) => String(candidate.id) === sessionUser.id)
          if (!account || account.status === 'Disabled') sessions.delete(token)
          else sessions.set(token, safeUser({ ...account, isPlatformAdmin: sessionUser.isPlatformAdmin }, organization))
        }
      } else if (selfOnlyAccounts) {
        const own = nextAccounts.find((candidate: any) => String(candidate.id) === user.id)
        if (own)
          for (const [token, sessionUser] of sessions.entries())
            if (sessionUser.id === user.id)
              sessions.set(token, safeUser({ ...own, isPlatformAdmin: sessionUser.isPlatformAdmin }, organization))
      }

      res.json({ configured: true, saved: true, updatedAt, version: saved.version })
    } catch (error) {
      // Someone else saved in the moment between the version check and this commit. refreshRequired lets the browser
      // fetch the latest, merge its own changes onto it and retry, instead of showing the Save conflict box.
      const raced = error instanceof WorkspaceRaceError || (error instanceof TenantSaveError && error.raced)
      if (!raced) console.error('Database save failed:', error)
      res.status(error instanceof TenantSaveError || error instanceof LifecycleError ? error.status : 500).json({
        configured: true,
        ...(raced ? { refreshRequired: true } : {}),
        error: error instanceof Error ? error.message : 'Cloud database save failed.',
      })
    }
  })
}
