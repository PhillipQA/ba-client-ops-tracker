/**
 * Per-person visibility settings and Seeds.
 *
 *   GET/PUT /api/access               Administrators: the visibility switch and hand-entered assignments
 *   GET/PUT/DELETE /api/account/seeds Administrators: turn Seeds on for the account and give its API address
 *   GET/PUT/DELETE /api/me/seeds      Everyone: their own Seeds API key. Saving it syncs straight away.
 *   POST /api/seeds/sync              Everyone connected: sync their own Seeds now
 *   POST /api/seeds/matches/:id       Administrators and Project Managers: confirm or turn down a close match
 *
 * Each person's Seeds key reads only what Seeds shows that person, so Seeds itself decides their access. Every
 * connected person syncs on their own every 30 minutes. If Seeds cannot be reached, their last synced access stays.
 */
import type { Express, NextFunction, Request, Response } from 'express'
import { normalizeAssignment, rolesFor, workspaceAccess } from '../../src/shared/access'
import { jobRoles } from '../../src/shared/roles'
import { defaultWaitingOn } from '../../src/features/tasks/waitingOn'
import { seedsState, seedsStatusFor, type SeedsSnapshot } from '../../src/shared/seeds'
import { cleanSeedsBaseUrl, httpSeedsSource, SeedsError, type SeedsSource } from './seeds-client'
import { decideSeedsMatch, planSeedsSync, SEEDS_ACTOR } from './seeds-sync'

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
  /** Credential encryption (integrations/tenant-integrations.ts), bound to one person in one account. */
  secrets: {
    encrypt: (secret: string, owner: string) => string
    decrypt: (value: string, owner: string) => string
    ready: () => boolean
  }
  /** Replaced in tests by a fake Seeds. */
  source?: (baseUrl: string, apiKey: string) => SeedsSource
}

const SYNC_EVERY_MS = 30 * 60_000
const MAX_ASSIGNMENTS = 5000
const TABLE = 'user_seeds_connections'
const owner = (organizationId: string, userId: string) => `${organizationId}:${userId}`

export function createSeedsService(deps: SeedsDeps) {
  const running = new Map<string, Promise<any>>()
  const unavailable = (error: any) =>
    new SeedsError(
      error?.code === '42P01'
        ? 'This database needs database/migrations/schema-v36-seeds.sql before Seeds can be connected.'
        : 'Seeds settings could not be read. Check the database connection.',
      503,
    )

  async function connection(organizationId: string, userId: string) {
    const { data, error } = await deps.db
      .from(TABLE)
      .select('*')
      .eq('tenant_id', organizationId)
      .eq('user_id', userId)
      .maybeSingle()
    if (error) throw unavailable(error)
    return data
  }

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

  const withUser = (state: any, userId: string, change: (sync: any) => any) => {
    const seeds = seedsState(state)
    return { ...state, seeds: { ...seeds, users: { ...seeds.users, [userId]: change(seeds.users[userId] || {}) } } }
  }

  async function syncNow(organizationId: string, userId: string) {
    const row = await connection(organizationId, userId)
    if (!row) throw new SeedsError('Connect your Seeds first: paste your personal Seeds API key.', 409)
    const before = (await deps.load(organizationId)).data || {}
    const seeds = seedsState(before)
    if (!seeds.connected || !seeds.baseUrl)
      throw new SeedsError('Seeds is not turned on for this account yet. Ask an Administrator.', 409)
    const account = (before.accounts || []).find((candidate: any) => String(candidate?.id) === userId)
    if (!account || account.status === 'Disabled') return { ok: false, error: 'This account is not active.' }
    const source = (deps.source || httpSeedsSource)(
      seeds.baseUrl,
      deps.secrets.decrypt(row.encrypted_key, owner(organizationId, userId)),
    )
    const now = new Date().toISOString()
    const mark = async (status: 'verified' | 'failed') =>
      await deps.db
        .from(TABLE)
        .update({ connection_status: status, ...(status === 'verified' ? { last_synced_at: now } : {}) })
        .eq('tenant_id', organizationId)
        .eq('user_id', userId)
    let snapshot: SeedsSnapshot
    try {
      snapshot = await source.snapshot()
    } catch (error) {
      const message = error instanceof SeedsError ? error.message : 'Seeds could not be read.'
      await mark('failed').catch(() => undefined)
      await update(organizationId, SEEDS_ACTOR, 'seeds-sync-failed', state =>
        withUser(state, userId, sync => ({ ...sync, connected: true, lastAttemptAt: now, lastError: message })),
      )
      return { ok: false, error: message }
    }
    let result: ReturnType<typeof planSeedsSync> | undefined
    await update(organizationId, SEEDS_ACTOR, 'seeds-sync', state => {
      result = planSeedsSync(state, snapshot, {
        now,
        today: deps.today(),
        openStatus: deps.openStatus(state),
        waitingOn: defaultWaitingOn(state.taskSettings),
        userId,
      })
      return result.state
    })
    await mark('verified').catch(() => undefined)
    return { ok: true, counts: result?.counts, pending: result?.pending.length || 0 }
  }

  /** One sync per person at a time; a second request waits for the running one. */
  function sync(organizationId: string, userId: string) {
    const key = owner(organizationId, userId)
    const existing = running.get(key)
    if (existing) return existing
    const job = syncNow(organizationId, userId).finally(() => running.delete(key))
    running.set(key, job)
    return job
  }

  async function connectPerson(organizationId: string, userId: string, apiKey: unknown) {
    const key = typeof apiKey === 'string' ? apiKey.trim() : ''
    if (key.length < 8 || key.length > 4096 || /\s/.test(key))
      throw new SeedsError('Paste your personal Seeds API key.', 400)
    const { error } = await deps.db.from(TABLE).upsert(
      {
        tenant_id: organizationId,
        user_id: userId,
        encrypted_key: deps.secrets.encrypt(key, owner(organizationId, userId)),
        key_suffix: key.slice(-4),
        connection_status: 'untested',
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'tenant_id,user_id' },
    )
    if (error) throw unavailable(error)
  }

  async function disconnectPerson(organizationId: string, userId: string) {
    const { error } = await deps.db.from(TABLE).delete().eq('tenant_id', organizationId).eq('user_id', userId)
    if (error) throw unavailable(error)
    // Their Seeds access goes with the key; hand-entered assignments (if any) count again.
    await update(organizationId, SEEDS_ACTOR, 'seeds-disconnect', state => {
      const seeds = seedsState(state)
      const { [userId]: _removed, ...users } = seeds.users
      const access = workspaceAccess(state)
      return {
        ...state,
        access: {
          ...access,
          assignments: access.assignments.filter(a => !(a.source === 'seeds' && a.userId === userId)),
        },
        seeds: { ...seeds, users },
      }
    })
  }

  async function syncAll() {
    const { data, error } = await deps.db.from(TABLE).select('tenant_id,user_id')
    if (error) return
    for (const row of data || [])
      await sync(String(row.tenant_id), String(row.user_id)).catch(failure =>
        console.error('Seeds sync failed:', failure instanceof Error ? failure.message : failure),
      )
  }

  return { connection, connectPerson, disconnectPerson, sync, syncAll, update }
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
      const status = seedsStatusFor(state, user)
      res.json({
        connected: status.connected,
        baseUrl: status.baseUrl || '',
        encryptionReady: deps.secrets.ready(),
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
      const baseUrl = cleanSeedsBaseUrl(req.body?.baseUrl)
      await service.update(user.organizationId, user, 'seeds-enable', state => ({
        ...state,
        seeds: { ...seedsState(state), connected: true, baseUrl },
      }))
      res.json({ ok: true, connected: true, baseUrl })
    }),
  )

  app.delete(
    '/api/account/seeds',
    ...auth,
    wrap(async (req, res) => {
      const user = who(req)
      requireAdministrator(user)
      // People's keys stay, so turning Seeds back on picks up where it was; meanwhile hand-entered access counts.
      await service.update(user.organizationId, user, 'seeds-disable', state => ({
        ...state,
        seeds: { ...seedsState(state), connected: false },
      }))
      res.json({ ok: true })
    }),
  )

  app.get(
    '/api/me/seeds',
    ...auth,
    wrap(async (req, res) => {
      const user = who(req)
      const [row, state] = await Promise.all([
        service.connection(user.organizationId, user.id),
        deps.load(user.organizationId),
      ])
      const status = seedsStatusFor(state.data || {}, user)
      res.json({
        available: status.connected,
        configured: Boolean(row),
        maskedKey: row ? `••••••••${row.key_suffix}` : '',
        connectionStatus: row?.connection_status || 'not_configured',
        mine: status.mine,
      })
    }),
  )

  app.put(
    '/api/me/seeds',
    ...auth,
    wrap(async (req, res) => {
      const user = who(req)
      const state = (await deps.load(user.organizationId)).data || {}
      if (!seedsState(state).connected)
        throw new SeedsError('Seeds is not turned on for this account yet. Ask an Administrator.', 409)
      if (!deps.secrets.ready())
        throw new SeedsError('Credential storage is not set up on the server. Ask Internal Admin.', 503)
      await service.connectPerson(user.organizationId, user.id, req.body?.apiKey)
      // Saving your key is what connects you: sync straight away.
      res.json({ saved: true, sync: await service.sync(user.organizationId, user.id) })
    }),
  )

  app.delete(
    '/api/me/seeds',
    ...auth,
    wrap(async (req, res) => {
      const user = who(req)
      await service.disconnectPerson(user.organizationId, user.id)
      res.json({ ok: true })
    }),
  )

  app.post(
    '/api/seeds/sync',
    ...auth,
    wrap(async (req, res) => {
      const user = who(req)
      res.json(await service.sync(user.organizationId, user.id))
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
      // A rejected match becomes a new record on the next sync; run it now if this person is connected.
      const connected = await service.connection(user.organizationId, user.id)
      res.json(connected ? await service.sync(user.organizationId, user.id) : { ok: true })
    }),
  )

  return {
    service,
    /** Syncs every connected person every 30 minutes. */
    start() {
      const timer = setInterval(() => void service.syncAll(), SYNC_EVERY_MS)
      timer.unref()
      return timer
    },
  }
}
