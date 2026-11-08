/**
 * Per-person visibility settings and Seeds.
 *
 *   GET/PUT /api/access               Administrators: the visibility switch and hand-entered assignments
 *   GET/PUT/DELETE /api/account/seeds Administrators: turn Seeds on (it syncs straight away) or off
 *   POST /api/seeds/sync              Anyone signed in: sync the account with Seeds now
 *   POST /api/seeds/matches/:id       Administrators and Project Managers: confirm or turn down a close match
 *
 * Seeds gives this app one application token (docs/seeds-api.md); the server keeps it in SEEDS_API_TOKEN. One sync
 * reads the whole account: each person here is matched to Seeds by email, and the projects Seeds lists them on as a
 * member decide what they see. Only projects someone here works on come in. The account syncs every 30 minutes; if
 * Seeds cannot be reached, the last synced access stays.
 */
import type { Express, NextFunction, Request, Response } from 'express'
import { normalizeAssignment, rolesFor, workspaceAccess } from '../../src/shared/access'
import { jobRoles } from '../../src/shared/roles'
import { defaultWaitingOn } from '../../src/features/tasks/waitingOn'
import {
  moveToBeforeSeeds,
  type SeedsCounts,
  type SeedsSnapshot,
  seedsState,
  seedsStatusFor,
} from '../../src/shared/seeds'
import { httpSeedsSource, SeedsError, type SeedsFields, type SeedsSource } from './seeds-client'
import { decideSeedsMatch, planSeedsSync, SEEDS_ACTOR } from './seeds-sync'
import { checkGoogleIdToken, postSeedsTime, seedsTimeBody, seedsTimeKey } from './seeds-time'
import { type TimeEntry, unsentToSeeds } from '../../src/features/tasks/effort'

type Middleware = (req: Request, res: Response, next: NextFunction) => any
type User = { id: string; role: string; modules: string[]; organizationId: string }

export interface SeedsDeps {
  db: any
  requireAuth: Middleware
  requireTenant: Middleware
  load: (organizationId: string) => Promise<{ data: any }>
  commit: (organizationId: string, state: any, actor: any, reason: string, before: any) => Promise<unknown>
  raced: (error: unknown) => boolean
  openStatus: (state: any) => string
  today: () => string
  /** The Seeds application token (SEEDS_API_TOKEN); empty when the server has none. */
  token: () => string
  /** The Seeds API address (SEEDS_API_URL, or the default). */
  apiUrl: () => string
  /** The Google OAuth client ID registered with Seeds Admin for writes (SEEDS_GOOGLE_CLIENT_ID); empty when none. */
  googleClientId?: () => string
  /** Replaced in tests by a fake Seeds. */
  postTime?: typeof postSeedsTime
  /** Replaced in tests by a fake Seeds. */
  source?: (token: string, apiUrl: string) => SeedsSource
}

const SYNC_EVERY_MS = 30 * 60_000
const MAX_ASSIGNMENTS = 5000
const text = (value: unknown) => (value == null ? '' : String(value))
const emailOf = (account: any) => text(account?.email).trim().toLowerCase()
const active = (state: any) =>
  (Array.isArray(state?.accounts) ? state.accounts : []).filter(
    (account: any) => account && account.status !== 'Disabled' && emailOf(account),
  )

/** The part of the account's snapshot that is one person's: their projects, those projects' clients and tasks. */
export function personalSnapshot(snapshot: SeedsSnapshot, email: string): SeedsSnapshot {
  const assignments = snapshot.assignments.filter(assignment => assignment.email === email)
  const projectIds = new Set(assignments.map(assignment => assignment.projectId).filter(Boolean))
  const projects = snapshot.projects.filter(project => projectIds.has(project.id))
  const clientIds = new Set(projects.map(project => project.clientId).filter(Boolean))
  return {
    people: [],
    clients: snapshot.clients.filter(client => clientIds.has(client.id)),
    projects,
    tasks: snapshot.tasks.filter(task => projectIds.has(task.projectId)),
    assignments,
  }
}

/** One account sync as a pure change: every active person with an email gets their part. */
export function planAccountSync(
  state: any,
  snapshot: SeedsSnapshot,
  fields: SeedsFields,
  options: { now: string; today: string; openStatus: string; waitingOn: string; id?: () => string },
) {
  let next = state
  let matched = 0
  let unmatched = 0
  let pending = 0
  const total: SeedsCounts = {
    people: snapshot.people.length,
    clients: 0,
    projects: 0,
    tasks: 0,
    assignments: 0,
    created: 0,
    linked: 0,
    renamed: 0,
  }
  for (const account of active(state)) {
    const userId = text(account.id)
    const mine = personalSnapshot(snapshot, emailOf(account))
    if (!mine.assignments.length) {
      // Not on any Seeds project: their hand-entered assignments (if any) count instead.
      unmatched++
      const seeds = seedsState(next)
      const access = workspaceAccess(next)
      next = {
        ...next,
        access: {
          ...access,
          assignments: access.assignments.filter(a => !(a.source === 'seeds' && a.userId === userId)),
        },
        seeds: { ...seeds, users: { ...seeds.users, [userId]: { connected: false, lastAttemptAt: options.now } } },
      }
      continue
    }
    matched++
    const result = planSeedsSync(next, mine, { ...options, userId })
    next = result.state
    pending += result.pending.length
    for (const key of ['assignments', 'created', 'linked', 'renamed'] as const) total[key] += result.counts[key]
  }
  const projects = new Set(snapshot.assignments.map(a => a.projectId).filter(Boolean))
  total.projects = projects.size
  total.clients = new Set(snapshot.projects.filter(p => projects.has(p.id) && p.clientId).map(p => p.clientId)).size
  total.tasks = snapshot.tasks.length
  const seeds = seedsState(next)
  next = {
    ...next,
    seeds: {
      ...seeds,
      sync: { lastAttemptAt: options.now, lastSuccessAt: options.now, matched, unmatched, fields },
    },
  }
  return { state: next, counts: total, pending }
}

export function createSeedsService(deps: SeedsDeps) {
  const running = new Map<string, Promise<any>>()

  /** Load, change and save the workspace, starting again if someone else saved in between. */
  async function update(organizationId: string, actor: any, reason: string, change: (state: any) => any) {
    for (let attempt = 0; ; attempt++) {
      const current = (await deps.load(organizationId)).data || {}
      const next = change(current)
      if (!next) return current
      try {
        await deps.commit(organizationId, next, actor, reason, current)
        return next
      } catch (error) {
        if (attempt < 3 && deps.raced(error)) continue
        throw error
      }
    }
  }

  async function syncNow(organizationId: string) {
    const before = (await deps.load(organizationId)).data || {}
    if (!seedsState(before).connected)
      throw new SeedsError('Seeds is not turned on for this account yet. Ask an Administrator.', 409)
    const token = deps.token()
    if (!token) throw new SeedsError('The server has no Seeds token yet (SEEDS_API_TOKEN). Ask Internal Admin.', 503)
    const now = new Date().toISOString()
    const emails = new Set<string>(active(before).map(emailOf))
    let read: Awaited<ReturnType<SeedsSource['read']>>
    try {
      read = await (deps.source || httpSeedsSource)(token, deps.apiUrl()).read(emails)
    } catch (error) {
      const message = error instanceof SeedsError ? error.message : 'Seeds could not be read.'
      if (!(error instanceof SeedsError)) console.error('Seeds read failed:', error)
      await update(organizationId, SEEDS_ACTOR, 'seeds-sync-failed', state => {
        const seeds = seedsState(state)
        return { ...state, seeds: { ...seeds, sync: { ...seeds.sync, lastAttemptAt: now, lastError: message } } }
      })
      return { ok: false, error: message }
    }
    let result: ReturnType<typeof planAccountSync> | undefined
    await update(organizationId, SEEDS_ACTOR, 'seeds-sync', state => {
      result = planAccountSync(state, read.snapshot, read.fields, {
        now,
        today: deps.today(),
        openStatus: deps.openStatus(state),
        waitingOn: defaultWaitingOn(state.taskSettings),
      })
      return result.state
    })
    return {
      ok: true,
      counts: result?.counts,
      pending: result?.pending || 0,
      matched: seedsState(result?.state).sync.matched || 0,
      unmatched: seedsState(result?.state).sync.unmatched || 0,
    }
  }

  /** One sync per account at a time; a second request waits for the running one. */
  function sync(organizationId: string) {
    const existing = running.get(organizationId)
    if (existing) return existing
    const job = syncNow(organizationId).finally(() => running.delete(organizationId))
    running.set(organizationId, job)
    return job
  }

  async function syncAll() {
    if (!deps.token()) return
    const { data, error } = await deps.db.from('organizations').select('id').is('deleted_at', null)
    if (error) return
    for (const row of data || []) {
      const organizationId = text(row.id)
      try {
        const state = (await deps.load(organizationId)).data || {}
        if (seedsState(state).connected) await sync(organizationId)
      } catch (failure) {
        console.error('Seeds sync failed:', failure instanceof Error ? failure.message : failure)
      }
    }
  }

  return { sync, syncAll, update }
}

export function registerSeedsRoutes(app: Express, deps: SeedsDeps) {
  const service = createSeedsService(deps)
  const auth = [deps.requireAuth, deps.requireTenant]
  const who = (req: Request) => (req as any).authUser as User
  const administrator = (user: User) => user.role === 'Administrator' && user.modules.includes('settings')
  const wrap =
    (handler: (req: Request, res: Response) => Promise<unknown>): Middleware =>
    async (req, res) => {
      res.setHeader('Cache-Control', 'no-store')
      try {
        await handler(req, res)
      } catch (error) {
        const status = error instanceof SeedsError ? error.status : Number((error as any)?.status) || 500
        const known = error instanceof Error && (error instanceof SeedsError || status < 500)
        if (!known) console.error('Seeds request failed:', error)
        res.status(status).json({ error: known ? (error as Error).message : 'Seeds request failed. Try again.' })
      }
    }
  const requireAdministrator = (user: User) => {
    if (!administrator(user)) throw new SeedsError('Administrator access with Settings is required.', 403)
  }
  const list = (value: unknown): any[] => (Array.isArray(value) ? value : [])

  app.get(
    '/api/access',
    ...auth,
    wrap(async (req, res) => {
      const user = who(req)
      requireAdministrator(user)
      const state = (await deps.load(user.organizationId)).data || {}
      const access = workspaceAccess(state)
      const seeds = seedsState(state)
      // Names only: setting up access is not a way to read client work.
      res.json({
        strictVisibility: access.strictVisibility,
        seedsConnected: seeds.connected,
        seedsUsers: Object.entries(seeds.users)
          .filter(([, sync]) => sync.lastSuccessAt)
          .map(([userId]) => userId),
        assignments: access.assignments,
        roles: jobRoles(state).map(role => ({ id: role.id, name: role.name })),
        users: list(state.accounts).map(account => ({
          id: String(account.id),
          name: String(account.name || account.username || 'User'),
          role: account.role,
          status: account.status,
        })),
        clients: list(state.clients).map(client => ({
          id: String(client.id),
          name: String(client.name || ''),
          ...(client.archived ? { archived: true } : {}),
          ...(client.seedsId ? { seedsId: String(client.seedsId) } : {}),
        })),
        projects: list(state.projects).map(project => ({
          id: String(project.id),
          name: String(project.name || ''),
          ...(project.clientId ? { clientId: String(project.clientId) } : {}),
          ...(project.archived ? { archived: true } : {}),
          ...(project.seedsId ? { seedsId: String(project.seedsId) } : {}),
          ...(project.contractNumber ? { contractNumber: String(project.contractNumber) } : {}),
        })),
      })
    }),
  )

  app.put(
    '/api/access',
    ...auth,
    wrap(async (req, res) => {
      const user = who(req)
      requireAdministrator(user)
      const body = req.body || {}
      if (body.strictVisibility !== undefined && typeof body.strictVisibility !== 'boolean')
        throw new SeedsError('Choose on or off for per-person visibility.', 400)
      if (
        body.assignments !== undefined &&
        (!Array.isArray(body.assignments) || body.assignments.length > MAX_ASSIGNMENTS)
      )
        throw new SeedsError(`Send up to ${MAX_ASSIGNMENTS} assignments.`, 400)
      const saved = await service.update(user.organizationId, user, 'access-update', state => {
        const access = workspaceAccess(state)
        let assignments = access.assignments
        // Hand-entered assignments only; the ones from each person's Seeds sync are not edited here.
        if (body.assignments !== undefined) {
          const users = new Set(
            list(state.accounts)
              .filter(a => a.status !== 'Disabled')
              .map(a => String(a.id)),
          )
          const clients = new Set(list(state.clients).map(c => String(c.id)))
          const projects = new Set(list(state.projects).map(p => String(p.id)))
          const roleIds = new Set(jobRoles(state).map(role => role.id))
          const manual = body.assignments.map((raw: any) => {
            const assignment = normalizeAssignment({ ...raw, id: '', source: 'manual' })
            if (
              !assignment ||
              !roleIds.has(assignment.role) ||
              !users.has(assignment.userId) ||
              (assignment.projectId ? !projects.has(assignment.projectId) : !clients.has(String(assignment.clientId)))
            )
              throw new SeedsError(
                'Each assignment needs an active person, a role and an existing client or project.',
                400,
              )
            const { clientId: _clientId, ...projectOnly } = assignment
            return assignment.projectId ? projectOnly : assignment
          })
          const unique = new Map(manual.map((assignment: any) => [assignment.id, assignment]))
          assignments = [
            ...access.assignments.filter(a => a.source === 'seeds'),
            ...unique.values(),
          ] as typeof assignments
        }
        return {
          ...state,
          access: {
            ...access,
            strictVisibility: body.strictVisibility ?? access.strictVisibility,
            assignments,
            updatedAt: new Date().toISOString(),
            updatedBy: user.id,
          },
        }
      })
      res.json({
        ok: true,
        strictVisibility: workspaceAccess(saved).strictVisibility,
        assignments: workspaceAccess(saved).assignments,
      })
    }),
  )

  app.get(
    '/api/account/seeds',
    ...auth,
    wrap(async (req, res) => {
      const user = who(req)
      requireAdministrator(user)
      const state = (await deps.load(user.organizationId)).data || {}
      const names = new Map(list(state.accounts).map(a => [String(a.id), String(a.name || a.username || 'User')]))
      const seeds = seedsState(state)
      const status = seedsStatusFor(state, user)
      res.json({
        connected: seeds.connected,
        tokenReady: Boolean(deps.token()),
        apiUrl: deps.apiUrl(),
        sync: seeds.sync,
        people: (status.people || []).map(person => ({ ...person, name: names.get(person.userId) || 'Former user' })),
      })
    }),
  )

  app.put(
    '/api/account/seeds',
    ...auth,
    wrap(async (req, res) => {
      const user = who(req)
      requireAdministrator(user)
      if (!deps.token())
        throw new SeedsError('The server has no Seeds token yet (SEEDS_API_TOKEN). Ask Internal Admin.', 503)
      // The first time, everything that exists moves to Before Seeds: Seeds is the source of truth from here on.
      await service.update(user.organizationId, SEEDS_ACTOR, 'seeds-enable', state => {
        const on = { ...state, seeds: { ...seedsState(state), connected: true } }
        return moveToBeforeSeeds(on, new Date().toISOString())
      })
      // Turning it on is the first sync.
      res.json({ ok: true, connected: true, sync: await service.sync(user.organizationId) })
    }),
  )

  app.delete(
    '/api/account/seeds',
    ...auth,
    wrap(async (req, res) => {
      const user = who(req)
      requireAdministrator(user)
      // Synced records stay linked; meanwhile hand-entered access counts.
      await service.update(user.organizationId, user, 'seeds-disable', state => ({
        ...state,
        seeds: { ...seedsState(state), connected: false },
      }))
      res.json({ ok: true })
    }),
  )

  app.post(
    '/api/seeds/sync',
    ...auth,
    wrap(async (req, res) => {
      const user = who(req)
      res.json(await service.sync(user.organizationId))
    }),
  )

  app.post(
    '/api/seeds/matches/:id',
    ...auth,
    wrap(async (req, res) => {
      const user = who(req)
      const state = (await deps.load(user.organizationId)).data || {}
      if (!administrator(user) && !rolesFor(state, user.id).includes('PM'))
        throw new SeedsError('Administrators and Project Managers can do this.', 403)
      const decision = req.body?.decision
      if (decision !== 'confirm' && decision !== 'reject') throw new SeedsError('Choose confirm or reject.', 400)
      const matchId = String(req.params.id || '')
      if (!seedsStatusFor(state, user).pendingMatches.some(match => match.id === matchId))
        throw new SeedsError('That match was not found. Sync again to refresh the list.', 404)
      await service.update(
        user.organizationId,
        SEEDS_ACTOR,
        'seeds-match',
        current => decideSeedsMatch(current, matchId, decision)?.state,
      )
      // A rejected match becomes a new record on the next sync; run it now.
      res.json(deps.token() ? await service.sync(user.organizationId) : { ok: true })
    }),
  )

  // ---- Sending time logs to Seeds ----
  const MAX_SEND = 100
  const mineUnsent = (state: any, userId: string) =>
    list(state?.items).flatMap(item =>
      list(item?.timeEntries)
        .filter((entry: TimeEntry) => entry?.userId === userId && unsentToSeeds(entry))
        .map((entry: TimeEntry) => ({ item, entry })),
    )

  app.get(
    '/api/seeds/time',
    ...auth,
    wrap(async (req, res) => {
      const user = who(req)
      const state = (await deps.load(user.organizationId)).data || {}
      const clientId = deps.googleClientId?.() || ''
      const unsent = mineUnsent(state, user.id)
      res.json({
        ready: Boolean(seedsState(state).connected && deps.token() && clientId),
        clientId,
        unsent: unsent.length,
        hours: unsent.reduce((total, { entry }) => total + (Number(entry.hours) || 0), 0),
      })
    }),
  )

  app.post(
    '/api/seeds/time/send',
    ...auth,
    wrap(async (req, res) => {
      const user = who(req)
      const state = (await deps.load(user.organizationId)).data || {}
      if (!seedsState(state).connected) throw new SeedsError('Seeds is not turned on for this account.', 409)
      const token = deps.token()
      const clientId = deps.googleClientId?.() || ''
      if (!token || !clientId)
        throw new SeedsError(
          'Sending time to Seeds is not set up yet (SEEDS_GOOGLE_CLIENT_ID). Ask Internal Admin.',
          503,
        )
      const account = list(state.accounts).find(candidate => String(candidate?.id) === user.id)
      const checked = checkGoogleIdToken(req.body?.idToken, {
        clientId,
        email: String(account?.email || ''),
        now: Date.now(),
      })
      if (!checked.ok) throw new SeedsError(checked.error, 400)
      const wanted = Array.isArray(req.body?.entryIds) ? new Set(req.body.entryIds.map(String)) : null
      const todo = mineUnsent(state, user.id)
        .filter(({ entry }) => !wanted || wanted.has(entry.id))
        .slice(0, MAX_SEND)
      const outcome = new Map<string, { seedsEntryId?: string; error?: string }>()
      for (const { item, entry } of todo) {
        const body = seedsTimeBody(state, item, entry)
        if (!body.ok) {
          outcome.set(entry.id, { error: body.error })
          continue
        }
        try {
          const seedsEntryId = await (deps.postTime || postSeedsTime)({
            baseUrl: deps.apiUrl(),
            token,
            idToken: String(req.body.idToken),
            key: seedsTimeKey(entry),
            body: body.body,
          })
          outcome.set(entry.id, { seedsEntryId })
        } catch (error) {
          const message = error instanceof SeedsError ? error.message : 'Seeds could not be reached.'
          outcome.set(entry.id, { error: message })
          // A rejected sign-in fails every entry the same way: stop rather than repeat it.
          if (error instanceof SeedsError && (error.status === 401 || error.status === 403)) break
        }
      }
      const now = new Date().toISOString()
      const touched = new Set(todo.filter(({ entry }) => outcome.has(entry.id)).map(({ item }) => String(item.id)))
      const saved = await service.update(user.organizationId, SEEDS_ACTOR, 'seeds-time-sent', current => ({
        ...current,
        items: list(current.items).map(item =>
          touched.has(String(item?.id))
            ? {
                ...item,
                timeEntries: list(item.timeEntries).map((entry: TimeEntry) => {
                  const result = outcome.get(entry?.id)
                  if (!result || entry.seedsEntryId) return entry
                  if (result.seedsEntryId) {
                    const { seedsError: _dropped, ...rest } = entry
                    return { ...rest, seedsEntryId: result.seedsEntryId, seedsSentAt: now }
                  }
                  return { ...entry, seedsError: result.error }
                }),
              }
            : item,
        ),
      }))
      const failed = [...outcome].filter(([, result]) => result.error)
      res.json({
        sent: [...outcome.values()].filter(result => result.seedsEntryId).length,
        failed: failed.map(([entryId, result]) => ({ entryId, error: result.error })),
        left: Math.max(0, mineUnsent(saved, user.id).length),
        items: list(saved.items).filter(item => touched.has(String(item?.id))),
      })
    }),
  )

  return {
    service,
    /** Syncs every account with Seeds turned on every 30 minutes. */
    start() {
      const timer = setInterval(() => void service.syncAll(), SYNC_EVERY_MS)
      timer.unref()
      return timer
    },
  }
}
