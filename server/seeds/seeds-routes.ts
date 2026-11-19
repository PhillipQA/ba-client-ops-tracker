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
 * member decide what they see. Only projects someone here works on come in. The account syncs every 10 minutes; if
 * Seeds cannot be reached, the last synced access stays.
 */
import { randomUUID } from 'node:crypto'
import type { Express, NextFunction, Request, Response } from 'express'
import { normalizeAssignment, rolesFor, workspaceAccess } from '../../src/shared/access'
import { jobRoles } from '../../src/shared/roles'
import { defaultWaitingOn } from '../../src/features/tasks/waitingOn'
import {
  cleanProducts,
  moveToBeforeSeeds,
  type SeedsCounts,
  type SeedsSnapshot,
  seedsState,
  seedsStatusFor,
} from '../../src/shared/seeds'
import {
  httpSeedsSource,
  SeedsError,
  type SeedsFields,
  type SeedsProgress,
  type SeedsReadOptions,
  type SeedsSource,
} from './seeds-client'
import { decideSeedsMatch, planSeedsSync, refreshLinkedProjects, refreshSeedsClients, SEEDS_ACTOR } from './seeds-sync'
import { checkGoogleIdToken, postSeedsTime, seedsTimeBody, seedsTimeKey } from './seeds-time'
import { calendarTimeOf, calendarTimeWork, logCalendarTime, removeCalendarTime } from './calendar-time'
import { type TimeEntry, unsentToSeeds } from '../../src/features/tasks/effort'
import { asList as list } from '../../src/shared/lists'

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
  source?: (token: string, apiUrl: string, options: SeedsReadOptions) => SeedsSource
}

/** A delta sync reads only what Seeds changed (often one request), so it can run often within 20 requests a minute. */
const SYNC_EVERY_MS = 10 * 60_000
/**
 * A full sync (every open project's members, the people directory, parent renames) once a week as a safety net, and
 * whenever someone asks for one; delta syncs in between.
 */
const FULL_SYNC_EVERY_MS = 7 * 24 * 3600_000
/** A delta starts this much before the last change Seeds sent, so a change saved during the last read is not missed. */
const DELTA_OVERLAP_MS = 10 * 60_000
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
  options: {
    now: string
    today: string
    openStatus: string
    waitingOn: string
    id?: () => string
    /** Seeds projects Seeds would not give members or tasks for. */
    skipped?: number
    /**
     * A delta sync: the Seeds projects it read. Only assignments on these are replaced; everyone's other Seeds
     * assignments, and the people directory, stay as they were.
     */
    changed?: Set<string>
  },
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
  const changed = options.changed
  const seedsIdOf = new Map<string, string>(
    (Array.isArray(state?.projects) ? state.projects : []).map((project: any): [string, string] => [
      text(project?.id),
      text(project?.seedsId),
    ]),
  )
  for (const account of active(state)) {
    const userId = text(account.id)
    const mine = personalSnapshot(snapshot, emailOf(account))
    // A delta sync leaves alone this person's Seeds assignments on projects it did not read.
    const keep = changed
      ? workspaceAccess(next).assignments.filter(
          assignment =>
            assignment.source === 'seeds' &&
            assignment.userId === userId &&
            !(assignment.projectId && changed.has(seedsIdOf.get(assignment.projectId) || '')),
        )
      : []
    if (!mine.assignments.length && !keep.length) {
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
    const result = planSeedsSync(next, mine, { ...options, userId, keep })
    next = result.state
    pending += result.pending.length
    for (const key of ['assignments', 'created', 'linked', 'renamed'] as const) total[key] += result.counts[key]
  }
  // Linked projects nobody here is on any more still follow Seeds: closed, deleted or renamed there.
  next = refreshLinkedProjects(next, snapshot.projects)
  // Every Seeds client, not only those of projects someone here is on (personalSnapshot keeps only those).
  next = refreshSeedsClients(next, snapshot.clients, options.id)
  const projects = new Set(snapshot.assignments.map(a => a.projectId).filter(Boolean))
  total.projects = projects.size
  total.clients = new Set(snapshot.projects.filter(p => projects.has(p.id) && p.clientId).map(p => p.clientId)).size
  total.tasks = snapshot.tasks.length
  const seeds = seedsState(next)
  next = {
    ...next,
    seeds: {
      ...seeds,
      // Keep the complete account directory, not only people assigned to projects in this app.
      // A failed sync never reaches this point, so the last known-good directory remains available. A delta sync
      // does not read /users, so it keeps the directory it has.
      // The product list, when this read fetched it; else the last one.
      products: snapshot.products ? cleanProducts(snapshot.products) : seeds.products,
      people: (changed && !snapshot.people.length ? seeds.people : snapshot.people)
        .filter(person => {
          const email = text(person.email).trim().toLowerCase()
          return Boolean(text(person.id).trim() && text(person.name).trim() && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
        })
        .slice(0, 20000)
        .map(person => ({
          id: text(person.id).trim(),
          name: text(person.name).trim(),
          email: text(person.email).trim().toLowerCase(),
          ...(text(person.title).trim() ? { title: text(person.title).trim() } : {}),
        })),
      sync: {
        lastAttemptAt: options.now,
        lastSuccessAt: options.now,
        matched,
        unmatched,
        // A delta reads fewer lists: the field names seen before stay for the ones it did not read.
        fields: changed ? { ...seeds.sync.fields, ...fields } : fields,
        ...(options.skipped ? { skipped: options.skipped } : {}),
      },
    },
  }
  return { state: next, counts: total, pending }
}

export function createSeedsService(deps: SeedsDeps) {
  const running = new Map<string, Promise<any>>()
  // Where each account's running sync is, for the Seeds card.
  const progress = new Map<string, SeedsProgress & { startedAt: string }>()

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

  async function syncNow(organizationId: string, full = false) {
    const before = (await deps.load(organizationId)).data || {}
    if (!seedsState(before).connected)
      throw new SeedsError('Seeds is not turned on for this account yet. Ask an Administrator.', 409)
    const token = deps.token()
    if (!token) throw new SeedsError('The server has no Seeds token yet (SEEDS_API_TOKEN). Ask Internal Admin.', 503)
    const now = new Date().toISOString()
    const emails = new Set<string>(active(before).map(emailOf))
    // Delta unless a full one is asked for or due (once a week, and the first time).
    const last = seedsState(before).sync
    const fullDue =
      full || !last.lastFullAt || !last.updatedSince || Date.now() - Date.parse(last.lastFullAt) >= FULL_SYNC_EVERY_MS
    const beforeProjects = Array.isArray(before.projects) ? before.projects : []
    const delta = fullDue
      ? undefined
      : {
          since: new Date(Date.parse(last.updatedSince || now) - DELTA_OVERLAP_MS).toISOString(),
          parents: new Set<string>(
            (Array.isArray(before.clients) ? before.clients : [])
              .filter((client: any) => client?.seedsId)
              .map((client: any) => String(client.seedsId)),
          ),
          products: new Set<string>(seedsState(before).products.map(product => product.id)),
        }
    // Projects from Seeds that are still open here: if Seeds stops listing one, a full read asks whether it closed.
    const linked = new Set<string>(
      beforeProjects
        .filter((project: any) => project?.seedsId && !project.seedsArchived && !project.archived)
        .map((project: any) => String(project.seedsId)),
    )
    let read: Awaited<ReturnType<SeedsSource['read']>>
    try {
      const options: SeedsReadOptions = {
        onProgress: step => progress.set(organizationId, { ...step, startedAt: now }),
      }
      read = await (deps.source
        ? deps.source(token, deps.apiUrl(), options)
        : httpSeedsSource(token, deps.apiUrl(), fetch, 20000, options)
      ).read(emails, delta, linked)
    } catch (error) {
      const message = error instanceof SeedsError ? error.message : 'Seeds could not be read.'
      if (!(error instanceof SeedsError)) console.error('Seeds read failed:', error)
      const fields = error instanceof SeedsError && error.fields ? error.fields : undefined
      await update(organizationId, SEEDS_ACTOR, 'seeds-sync-failed', state => {
        const seeds = seedsState(state)
        return {
          ...state,
          seeds: {
            ...seeds,
            sync: { ...seeds.sync, lastAttemptAt: now, lastError: message, ...(fields ? { fields } : {}) },
          },
        }
      })
      return { ok: false, error: message }
    }
    // A delta read falls back to a full one when Seeds turns down `updatedSince`.
    const mode: 'full' | 'delta' = read.mode || (delta ? 'delta' : 'full')
    let result: ReturnType<typeof planAccountSync> | undefined
    await update(organizationId, SEEDS_ACTOR, 'seeds-sync', state => {
      result = planAccountSync(state, read.snapshot, read.fields, {
        skipped: read.skipped?.length || 0,
        now,
        today: deps.today(),
        openStatus: deps.openStatus(state),
        waitingOn: defaultWaitingOn(state.taskSettings),
        ...(mode === 'delta' ? { changed: new Set(read.projectIds || read.snapshot.projects.map(p => p.id)) } : {}),
      })
      const seeds = seedsState(result.state)
      // The next delta starts from the latest change Seeds sent; with none, from where this one started (a full sync
      // with no dates from Seeds starts from now).
      const updatedSince = read.watermark || (mode === 'full' ? now : last.updatedSince || now)
      const { knownProjects: _known, memberProjects: _members, ...sync } = seeds.sync as any
      return {
        ...result.state,
        seeds: {
          ...seeds,
          sync: {
            ...sync,
            mode,
            checked: read.checked ?? 0,
            lastFullAt: mode === 'full' ? now : last.lastFullAt,
            updatedSince,
          },
        },
      }
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
  function sync(organizationId: string, full = false) {
    const existing = running.get(organizationId)
    if (existing) return existing
    const job = syncNow(organizationId, full).finally(() => {
      running.delete(organizationId)
      progress.delete(organizationId)
    })
    running.set(organizationId, job)
    return job
  }

  /**
   * Starts a sync (or joins the running one) and answers within `ms`: the result if it finished, otherwise that it
   * is still running. A first sync over many projects can take minutes, because Seeds limits how fast the app reads.
   */
  async function syncFor(organizationId: string, ms = 20000, full = false) {
    const job = sync(organizationId, full)
    job.catch(() => {})
    const late = Symbol('late')
    const first = await Promise.race([job, new Promise(resolve => setTimeout(() => resolve(late), ms))])
    return first === late ? { ok: true, running: true, progress: progress.get(organizationId) } : first
  }

  const status = (organizationId: string) =>
    running.has(organizationId) ? { running: true, progress: progress.get(organizationId) } : { running: false }

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

  return { sync, syncFor, status, syncAll, update }
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

  app.get(
    '/api/seeds/people',
    ...auth,
    wrap(async (req, res) => {
      const user = who(req)
      if (!Array.isArray(user.modules) || !user.modules.includes('documents'))
        throw new SeedsError('Document module access is required.', 403)
      const state = (await deps.load(user.organizationId)).data || {}
      const seeds = seedsState(state)
      res.json({
        people: seeds.connected
          ? seeds.people
              .filter(person => person.email)
              .map(person => ({
                name: person.name,
                email: person.email,
                hint: person.title ? `Seeds · ${person.title}` : 'Seeds directory',
              }))
          : [],
      })
    }),
  )

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
        ...service.status(user.organizationId),
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
      res.json({ ok: true, connected: true, sync: await service.syncFor(user.organizationId) })
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
      res.json(await service.syncFor(user.organizationId, 20000, req.body?.full === true))
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
      res.json(deps.token() ? await service.syncFor(user.organizationId) : { ok: true })
    }),
  )

  // ---- Sending time logs to Seeds ----
  const MAX_SEND = 100
  // Time on tasks, and time logged straight from calendar events (calendar-time.ts), which goes to Seeds the same way.
  const mineUnsent = (state: any, userId: string): { item: any; entry: TimeEntry; calendar?: boolean }[] => [
    ...list(state?.items).flatMap(item =>
      list(item?.timeEntries)
        .filter((entry: TimeEntry) => entry?.userId === userId && unsentToSeeds(entry))
        .map((entry: TimeEntry) => ({ item, entry })),
    ),
    ...calendarTimeOf(state, userId)
      .filter(entry => unsentToSeeds(entry))
      .map(entry => ({ item: calendarTimeWork(entry), entry, calendar: true })),
  ]
  const sentResult = (
    entry: TimeEntry,
    result: { seedsEntryId?: string; error?: string; productId?: string } | undefined,
    now: string,
  ) => {
    if (!result || entry.seedsEntryId) return entry
    if (result.seedsEntryId) {
      const { seedsError: _dropped, ...rest } = entry
      return {
        ...rest,
        ...(result.productId ? { productId: result.productId } : {}),
        seedsEntryId: result.seedsEntryId,
        seedsSentAt: now,
      }
    }
    return { ...entry, seedsError: result.error }
  }

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
      // The product chosen in Log time when sending: for entries without one of their own. Kept on those sent.
      const asked = text(req.body?.productId)
      const fallback = asked && seedsState(state).products.some(product => product.id === asked) ? asked : ''
      const outcome = new Map<string, { seedsEntryId?: string; error?: string; productId?: string }>()
      for (const { item, entry } of todo) {
        const body = seedsTimeBody(state, item, entry, fallback)
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
          outcome.set(entry.id, { seedsEntryId, ...(!entry.productId && fallback ? { productId: fallback } : {}) })
        } catch (error) {
          const message = error instanceof SeedsError ? error.message : 'Seeds could not be reached.'
          outcome.set(entry.id, { error: message })
          // A rejected sign-in fails every entry the same way: stop rather than repeat it.
          if (error instanceof SeedsError && (error.status === 401 || error.status === 403)) break
        }
      }
      const now = new Date().toISOString()
      const touched = new Set(
        todo.filter(({ entry, calendar }) => !calendar && outcome.has(entry.id)).map(({ item }) => String(item.id)),
      )
      const saved = await service.update(user.organizationId, SEEDS_ACTOR, 'seeds-time-sent', current => ({
        ...current,
        items: list(current.items).map(item =>
          touched.has(String(item?.id))
            ? {
                ...item,
                timeEntries: list(item.timeEntries).map((entry: TimeEntry) =>
                  sentResult(entry, outcome.get(entry?.id), now),
                ),
              }
            : item,
        ),
        calendarTime: list(current.calendarTime).map((entry: TimeEntry) =>
          entry?.userId === user.id ? sentResult(entry, outcome.get(entry?.id), now) : entry,
        ),
      }))
      const failed = [...outcome].filter(([, result]) => result.error)
      const projectById = new Map(list(state.projects).map(project => [String(project?.id), project]))
      const detailsByEntryId = new Map<
        string,
        { projectName: string; taskName: string; date: string; hours: number; remarks: string }
      >()
      for (const { item, entry } of todo) {
        const project = projectById.get(String(item?.projectId))
        detailsByEntryId.set(entry.id, {
          projectName: text(project?.name) || 'Unknown project',
          taskName: text(item?.title) || 'Unknown task',
          date: text(entry?.date),
          hours: Number(entry?.hours) || 0,
          remarks: text(entry?.note),
        })
      }
      res.json({
        sent: [...outcome.values()].filter(result => result.seedsEntryId).length,
        failed: failed.map(([entryId, result]) => ({
          entryId,
          error: result.error,
          ...(detailsByEntryId.get(entryId) || {}),
        })),
        left: Math.max(0, mineUnsent(saved, user.id).length),
        items: list(saved.items).filter(item => touched.has(String(item?.id))),
        calendarTime: calendarTimeOf(saved, user.id),
      })
    }),
  )

  // ---- Time logged straight from a Google Calendar event (calendar-time.ts) ----
  app.get(
    '/api/seeds/calendar-time',
    ...auth,
    wrap(async (req, res) => {
      const user = who(req)
      const state = (await deps.load(user.organizationId)).data || {}
      res.json({ ready: seedsState(state).connected === true, entries: calendarTimeOf(state, user.id) })
    }),
  )

  app.post(
    '/api/seeds/calendar-time',
    ...auth,
    wrap(async (req, res) => {
      const user = who(req)
      let entry: TimeEntry | undefined
      const saved = await service.update(user.organizationId, user, 'calendar-time', current => {
        const result = logCalendarTime(current, user, req.body, new Date(), randomUUID())
        if (!result.ok) throw new SeedsError(result.error, result.status)
        entry = result.value.entry
        return result.value.state
      })
      res.json({ entry, entries: calendarTimeOf(saved, user.id) })
    }),
  )

  app.delete(
    '/api/seeds/calendar-time/:id',
    ...auth,
    wrap(async (req, res) => {
      const user = who(req)
      const saved = await service.update(user.organizationId, user, 'calendar-time-removed', current => {
        const result = removeCalendarTime(current, user, String(req.params.id || ''))
        if (!result.ok) throw new SeedsError(result.error, result.status)
        return result.value.state
      })
      res.json({ entries: calendarTimeOf(saved, user.id) })
    }),
  )

  return {
    service,
    /** Syncs every account with Seeds turned on every 10 minutes. */
    start() {
      const timer = setInterval(() => void service.syncAll(), SYNC_EVERY_MS)
      timer.unref()
      return timer
    },
  }
}
