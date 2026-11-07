/**
 * Per-person visibility settings and the Seeds connection.
 *
 *   GET/PUT /api/access              Administrators: the visibility switch and hand-entered assignments
 *   GET/PUT/DELETE /api/account/seeds Administrators: the Seeds address and API key. Saving a key turns Seeds on.
 *   POST /api/seeds/sync             Administrators and Project Managers: sync now
 *   POST /api/seeds/matches/:id      Administrators and Project Managers: confirm or turn down a close match
 *
 * Seeds syncs on its own every 30 minutes once connected. If Seeds cannot be reached, the last synced assignments
 * stay in force and the error is shown on the Seeds page.
 */
import type { Express, NextFunction, Request, Response } from 'express'
import { normalizeAssignment, rolesFor, workspaceAccess } from '../../src/shared/access'
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
  /** The account's credential encryption (integrations/tenant-integrations.ts). */
  secrets: {
    encrypt: (secret: string, organizationId: string) => string
    decrypt: (value: string, organizationId: string) => string
    ready: () => boolean
  }
  /** Replaced in tests by a fake Seeds. */
  source?: (baseUrl: string, apiKey: string) => SeedsSource
}

const SYNC_EVERY_MS = 30 * 60_000
const MAX_ASSIGNMENTS = 5000

export function createSeedsService(deps: SeedsDeps) {
  const running = new Map<string, Promise<any>>()

  async function connection(organizationId: string) {
    const { data, error } = await deps.db
      .from('tenant_integrations')
      .select('*')
      .eq('tenant_id', organizationId)
      .eq('integration_type', 'seeds')
      .maybeSingle()
    if (error) throw new SeedsError('Seeds settings could not be read. Check the database connection.', 503)
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

  async function markConnection(organizationId: string, status: 'verified' | 'failed') {
    await deps.db
      .from('tenant_integrations')
      .update({ connection_status: status, last_tested_at: new Date().toISOString() })
      .eq('tenant_id', organizationId)
      .eq('integration_type', 'seeds')
  }

  async function syncNow(organizationId: string) {
    const row = await connection(organizationId)
    if (!row?.is_enabled)
      throw new SeedsError('Seeds is not connected. An Administrator adds the API key in Settings.', 409)
    const source = (deps.source || httpSeedsSource)(
      String(row.config_json?.baseUrl || ''),
      deps.secrets.decrypt(row.encrypted_secret, organizationId),
    )
    const now = new Date().toISOString()
    let snapshot: SeedsSnapshot
    try {
      snapshot = await source.snapshot()
    } catch (error) {
      const message = error instanceof SeedsError ? error.message : 'Seeds could not be read.'
      await markConnection(organizationId, 'failed').catch(() => undefined)
      await update(organizationId, SEEDS_ACTOR, 'seeds-sync-failed', state => ({
        ...state,
        seeds: { ...seedsState(state), connected: true, lastAttemptAt: now, lastError: message },
      }))
      return { ok: false, error: message }
    }
    let result: ReturnType<typeof planSeedsSync> | undefined
    await update(organizationId, SEEDS_ACTOR, 'seeds-sync', state => {
      result = planSeedsSync(state, snapshot, {
        now,
        today: deps.today(),
        openStatus: deps.openStatus(state),
        waitingOn: defaultWaitingOn(state.taskSettings),
      })
      return result.state
    })
    await markConnection(organizationId, 'verified').catch(() => undefined)
    return { ok: true, counts: result?.counts, pending: result?.pending.length || 0 }
  }

  /** One sync per account at a time; a second request waits for the running one. */
  function sync(organizationId: string) {
    const existing = running.get(organizationId)
    if (existing) return existing
    const job = syncNow(organizationId).finally(() => running.delete(organizationId))
    running.set(organizationId, job)
    return job
  }

  async function connect(organizationId: string, input: { baseUrl?: unknown; apiKey?: unknown }) {
    const baseUrl = cleanSeedsBaseUrl(input.baseUrl)
    const apiKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : ''
    const previous = await connection(organizationId)
    if (!apiKey && !previous) throw new SeedsError('Enter the Seeds API key.', 400)
    if (apiKey && (apiKey.length < 8 || apiKey.length > 4096 || /\s/.test(apiKey)))
      throw new SeedsError('That does not look like a Seeds API key.', 400)
    const record = {
      tenant_id: organizationId,
      integration_type: 'seeds',
      encrypted_secret: apiKey ? deps.secrets.encrypt(apiKey, organizationId) : previous.encrypted_secret,
      secret_suffix: apiKey ? apiKey.slice(-4) : previous.secret_suffix,
      provider_identity: null,
      config_json: { baseUrl },
      is_enabled: true,
      connection_status: 'untested',
      last_tested_at: null,
      updated_at: new Date().toISOString(),
    }
    const { error } = await deps.db
      .from('tenant_integrations')
      .upsert(record, { onConflict: 'tenant_id,integration_type' })
    if (error)
      throw new SeedsError(
        error.code === '23514'
          ? 'This database needs database/migrations/schema-v36-seeds.sql before Seeds can be connected.'
          : 'Seeds settings could not be saved. Check the database connection.',
        503,
      )
  }

  async function disconnect(organizationId: string, actor: any) {
    const { error } = await deps.db
      .from('tenant_integrations')
      .delete()
      .eq('tenant_id', organizationId)
      .eq('integration_type', 'seeds')
    if (error) throw new SeedsError('Seeds settings could not be removed. Check the database connection.', 503)
    // Hand-entered assignments count again; the Seeds links on records stay, so reconnecting picks up where it was.
    await update(organizationId, actor, 'seeds-disconnect', state => ({
      ...state,
      seeds: { ...seedsState(state), connected: false },
    }))
  }

  async function syncAll() {
    const { data, error } = await deps.db
      .from('tenant_integrations')
      .select('tenant_id')
      .eq('integration_type', 'seeds')
      .eq('is_enabled', true)
    if (error) return
    for (const row of data || [])
      await sync(String(row.tenant_id)).catch(failure =>
        console.error('Seeds sync failed:', failure instanceof Error ? failure.message : failure),
      )
  }

  return { connection, connect, disconnect, sync, syncAll, update }
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
    '/api/access',
    ...auth,
    wrap(async (req, res) => {
      const user = who(req)
      requireAdministrator(user)
      const state = (await deps.load(user.organizationId)).data || {}
      const access = workspaceAccess(state)
      const list = (value: unknown): any[] => (Array.isArray(value) ? value : [])
      // Names only: setting up access is not a way to read client work.
      res.json({
        strictVisibility: access.strictVisibility,
        seedsConnected: seedsState(state).connected,
        assignmentsFromSeeds: seedsState(state).connected && Boolean(seedsState(state).lastSuccessAt),
        assignments: access.assignments,
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
        const seeds = seedsState(state)
        let assignments = access.assignments
        if (body.assignments !== undefined) {
          if (seeds.connected && seeds.lastSuccessAt)
            throw new SeedsError('Assignments come from Seeds now. Change them in Seeds, then sync.', 409)
          const users = new Set(
            (state.accounts || []).filter((a: any) => a.status !== 'Disabled').map((a: any) => String(a.id)),
          )
          const clients = new Set((state.clients || []).map((c: any) => String(c.id)))
          const projects = new Set((state.projects || []).map((p: any) => String(p.id)))
          const manual = body.assignments.map((raw: any) => {
            const assignment = normalizeAssignment({ ...raw, id: '', source: 'manual' })
            if (
              !assignment ||
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
      const [row, state] = await Promise.all([service.connection(user.organizationId), deps.load(user.organizationId)])
      res.json({
        configured: Boolean(row),
        baseUrl: row?.config_json?.baseUrl || '',
        maskedKey: row ? `••••••••${row.secret_suffix}` : '',
        connectionStatus: row?.connection_status || 'not_configured',
        lastTestedAt: row?.last_tested_at || null,
        encryptionReady: deps.secrets.ready(),
        status: seedsStatusFor(state.data || {}, user),
      })
    }),
  )

  app.put(
    '/api/account/seeds',
    ...auth,
    wrap(async (req, res) => {
      const user = who(req)
      requireAdministrator(user)
      await service.connect(user.organizationId, req.body || {})
      // Saving the key is what turns Seeds on: sync straight away.
      const result = await service.sync(user.organizationId)
      res.json({ saved: true, sync: result })
    }),
  )

  app.delete(
    '/api/account/seeds',
    ...auth,
    wrap(async (req, res) => {
      const user = who(req)
      requireAdministrator(user)
      await service.disconnect(user.organizationId, user)
      res.json({ ok: true })
    }),
  )

  const reviewer = async (user: User) => {
    const state = (await deps.load(user.organizationId)).data || {}
    if (!administrator(user) && !rolesFor(state, user.id).includes('PM'))
      throw new SeedsError('Administrators and Project Managers can do this.', 403)
    return state
  }

  app.post(
    '/api/seeds/sync',
    ...auth,
    wrap(async (req, res) => {
      const user = who(req)
      await reviewer(user)
      res.json(await service.sync(user.organizationId))
    }),
  )

  app.post(
    '/api/seeds/matches/:id',
    ...auth,
    wrap(async (req, res) => {
      const user = who(req)
      const state = await reviewer(user)
      const decision = req.body?.decision
      if (decision !== 'confirm' && decision !== 'reject') throw new SeedsError('Choose confirm or reject.', 400)
      const matchId = String(req.params.id || '')
      if (!seedsStatusFor(state, user).pendingMatches.some(match => match.id === matchId))
        throw new SeedsError('That match was not found. Sync again to refresh the list.', 404)
      await service.update(
        user.organizationId,
        user,
        'seeds-match',
        current => decideSeedsMatch(current, matchId, decision)?.state,
      )
      res.json(await service.sync(user.organizationId))
    }),
  )

  return {
    service,
    /** Syncs every connected account every 30 minutes. */
    start() {
      const timer = setInterval(() => void service.syncAll(), SYNC_EVERY_MS)
      timer.unref()
      return timer
    },
  }
}
