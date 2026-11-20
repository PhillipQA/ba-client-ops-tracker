/**
 * Repository mapping for the whole workspace (GIT Tracker): which Client and Project a GitLab or GitHub repository's
 * tickets belong to. Administrators set it; everyone reads it for the clients they can see.
 *
 * - A repository is mapped by the provider's stable id, looked up with the Administrator's own connection when it is
 *   mapped, so a renamed repository stays mapped.
 * - One active mapping per repository. Changing a mapping keeps the old one, inactive, for history; tickets already
 *   added to a GIT Tracker keep the Client and Project they were added with.
 * - Each person's own repository settings in Work Hub are offered to Administrators as suggestions.
 */
import type { Express, Request, RequestHandler, Response } from 'express'
import { canSeeClient, scopeFor } from '../../src/shared/access'
import { githubRepoPath, githubRepositoryName, githubRequest } from './github-api'
import { gitlabBaseUrl, gitlabRepoPath, gitlabRepositoryName, gitlabRequest } from './gitlab-api'
import { decryptSecret, IntegrationError } from './tenant-integrations'
import { type GitProvider, mappingSuggestions, mappingTargetError } from './git-mapping-rules'

export { mappingSuggestions, mappingTargetError } from './git-mapping-rules'

export const GITHUB_INSTANCE = 'https://github.com'
export const MAPPING_LIMIT = 500
const TABLE = 'tenant_git_repository_mappings'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
export const MAPPING_UPGRADE =
  'Repository mapping needs the database update database/migrations/schema-v42-git-tracker.sql. Ask your administrator to run it.'

type User = { id: string; name: string; role: string; organizationId: string; accountType?: string }
type Deps = {
  db: any
  requireAuth: RequestHandler
  requireTenant: RequestHandler
  load: (tenantId: string) => Promise<any>
  gitlab?: (token: string, path: string, baseUrl: string) => Promise<any>
  github?: (token: string, path: string) => Promise<any>
}

export type RepositoryMapping = {
  id: string
  provider: GitProvider
  instanceUrl: string
  repositoryId: number
  repository: string
  clientId: string
  projectId: string
  updatedAt: string
  updatedBy: string
}

export const mappingOut = (row: any): RepositoryMapping => ({
  id: row.id,
  provider: row.provider,
  instanceUrl: row.instance_url,
  repositoryId: Number(row.repository_id),
  repository: row.repository_path,
  clientId: row.client_id,
  projectId: row.project_id,
  updatedAt: row.updated_at,
  updatedBy: row.updated_by || row.created_by || '',
})

export function registerGitMappings(app: Express, deps: Deps) {
  const { db } = deps
  const gitlab = deps.gitlab || ((token: string, path: string, baseUrl: string) => gitlabRequest(token, path, baseUrl))
  const github = deps.github || githubRequest
  const who = (req: Request) => (req as any).authUser as User
  const guard: RequestHandler = (req, res, next) => {
    const user = (req as any).authUser as User | undefined
    if (!db) return void res.status(503).json({ error: 'Cloud storage is required for repository mapping.' })
    if (!user?.organizationId || user.accountType === 'platform')
      return void res.status(403).json({ error: 'Repository mapping is for workspace members.' })
    if (req.method !== 'GET' && user.role !== 'Administrator')
      return void res.status(403).json({ error: 'Only Administrators map repositories to clients and projects.' })
    res.setHeader('Cache-Control', 'no-store')
    next()
  }
  const scope = [deps.requireAuth, deps.requireTenant, guard]
  const route =
    (handler: (req: Request, res: Response) => Promise<void>): RequestHandler =>
    async (req, res) => {
      try {
        await handler(req, res)
      } catch (error: any) {
        if (error instanceof IntegrationError) return void res.status(error.status).json({ error: error.message })
        const missing = error?.code === '42P01' || error?.code === '42703'
        res.status(503).json({
          error: missing ? MAPPING_UPGRADE : 'Repository mapping is unavailable right now. Try again in a moment.',
          ...(missing ? { needsUpgrade: true } : {}),
        })
      }
    }
  const workspace = async (tenant: string) => (await deps.load(tenant)).data || {}
  async function activeRows(tenant: string) {
    const r = await db.from(TABLE).select('*').eq('tenant_id', tenant).eq('is_active', true).limit(MAPPING_LIMIT + 1)
    if (r.error) throw r.error
    return (r.data || []) as any[]
  }
  /** The Administrator's own connection and token, to look the repository up with. */
  async function lookup(user: User, provider: GitProvider, name: string) {
    const table = provider === 'gitlab' ? 'user_gitlab_connections' : 'user_github_connections'
    const r = await db
      .from(table)
      .select('*')
      .eq('tenant_id', user.organizationId)
      .eq('user_id', user.id)
      .maybeSingle()
    if (r.error) throw r.error
    const label = provider === 'gitlab' ? 'GitLab' : 'GitHub'
    if (!r.data?.encrypted_token)
      throw new IntegrationError(
        `Connect your own ${label} token in Work Hub › ${label} first: the repository is looked up with it.`,
        409,
      )
    const owner = `${user.organizationId}:${user.id}`
    if (provider === 'gitlab') {
      const instanceUrl = gitlabBaseUrl(r.data.instance_url || 'https://gitlab.com')
      const token = decryptSecret(r.data.encrypted_token, `${owner}:${r.data.instance_url}`, 'gitlab-token')
      const repo = await gitlab(token, gitlabRepoPath(gitlabRepositoryName(name)), instanceUrl)
      if (!Number.isSafeInteger(repo?.id) || repo.id < 1)
        throw new IntegrationError('GitLab did not return that repository. Check its path.', 502)
      if (repo.issues_enabled === false) throw new IntegrationError(`${name} does not have GitLab Issues enabled.`)
      return { instanceUrl, id: Number(repo.id), path: gitlabRepositoryName(repo.path_with_namespace) }
    }
    const token = decryptSecret(r.data.encrypted_token, owner, 'github-token')
    const repo = await github(token, githubRepoPath(githubRepositoryName(name)))
    if (!Number.isSafeInteger(repo?.id) || repo.id < 1)
      throw new IntegrationError('GitHub did not return that repository. Check its name.', 502)
    if (repo.has_issues === false) throw new IntegrationError(`${name} does not have GitHub Issues enabled.`)
    return { instanceUrl: GITHUB_INSTANCE, id: Number(repo.id), path: githubRepositoryName(repo.full_name) }
  }

  app.get(
    '/api/git-mappings',
    ...scope,
    route(async (req, res) => {
      const user = who(req)
      const rows = await activeRows(user.organizationId)
      const access = scopeFor(await workspace(user.organizationId), user.id)
      // People who do not see every client see the mappings of the clients they do see.
      const shown = access.all ? rows : rows.filter(row => canSeeClient(access, row.client_id))
      res.json({
        mappings: shown.map(mappingOut).sort((a, b) => a.repository.localeCompare(b.repository)),
        canManage: user.role === 'Administrator',
      })
    }),
  )

  app.get(
    '/api/git-mappings/suggestions',
    ...scope,
    route(async (req, res) => {
      const user = who(req)
      if (user.role !== 'Administrator') throw new IntegrationError('Only Administrators see suggestions.', 403)
      const tenant = user.organizationId
      const [gitlabRows, githubRows, active, state] = await Promise.all([
        db.from('user_gitlab_connections').select('user_id, instance_url, repositories').eq('tenant_id', tenant),
        db.from('user_github_connections').select('user_id, repositories').eq('tenant_id', tenant),
        activeRows(tenant),
        workspace(tenant),
      ])
      if (gitlabRows.error) throw gitlabRows.error
      if (githubRows.error) throw githubRows.error
      const instance = (value: unknown) => {
        try {
          return gitlabBaseUrl(value || 'https://gitlab.com')
        } catch {
          return ''
        }
      }
      const accounts = new Map<string, string>(
        (state.accounts || []).map((account: any) => [account.id, account.name || account.email || '']),
      )
      res.json({
        suggestions: mappingSuggestions(
          [
            ...(gitlabRows.data || []).map((row: any) => ({
              provider: 'gitlab' as const,
              instanceUrl: instance(row.instance_url),
              userId: row.user_id,
              repositories: row.repositories,
            })),
            ...(githubRows.data || []).map((row: any) => ({
              provider: 'github' as const,
              instanceUrl: GITHUB_INSTANCE,
              userId: row.user_id,
              repositories: row.repositories,
            })),
          ].filter(item => item.instanceUrl),
          active.map(row => ({
            provider: row.provider,
            instanceUrl: row.instance_url,
            repository: row.repository_path,
          })),
          id => accounts.get(id) || '',
        ),
      })
    }),
  )

  app.post(
    '/api/git-mappings',
    ...scope,
    route(async (req, res) => {
      const user = who(req),
        tenant = user.organizationId,
        body = req.body || {}
      if (body.provider !== 'gitlab' && body.provider !== 'github')
        throw new IntegrationError('Choose GitLab or GitHub.')
      const provider: GitProvider = body.provider
      const clientId = typeof body.clientId === 'string' ? body.clientId : ''
      const projectId = typeof body.projectId === 'string' ? body.projectId : ''
      const problem = mappingTargetError(await workspace(tenant), clientId, projectId)
      if (problem) throw new IntegrationError(problem)
      const repo = await lookup(user, provider, String(body.repository || ''))
      const rows = await activeRows(tenant)
      const same = rows.find(
        row =>
          row.provider === provider && row.instance_url === repo.instanceUrl && Number(row.repository_id) === repo.id,
      )
      if (!same && rows.length >= MAPPING_LIMIT)
        throw new IntegrationError(`A workspace can map at most ${MAPPING_LIMIT} repositories.`, 409)
      const stamp = new Date().toISOString()
      // The mapping it replaces stays, inactive, for history.
      if (same) {
        if (same.client_id === clientId && same.project_id === projectId)
          return void res.json({ mapping: mappingOut(same), unchanged: true })
        const off = await db
          .from(TABLE)
          .update({ is_active: false, updated_by: user.name, updated_at: stamp })
          .eq('tenant_id', tenant)
          .eq('id', same.id)
        if (off.error) throw off.error
      }
      const row = {
        tenant_id: tenant,
        provider,
        instance_url: repo.instanceUrl,
        connection_user_id: user.id,
        repository_id: repo.id,
        repository_path: repo.path,
        client_id: clientId,
        project_id: projectId,
        is_active: true,
        created_by: user.name,
        updated_by: user.name,
        created_at: stamp,
        updated_at: stamp,
      }
      const saved = await db.from(TABLE).insert(row).select('*').single()
      if (saved.error?.code === '23505')
        throw new IntegrationError('Someone else mapped this repository at the same time. Reload and try again.', 409)
      if (saved.error) throw saved.error
      res.status(same ? 200 : 201).json({ mapping: mappingOut(saved.data) })
    }),
  )

  app.delete(
    '/api/git-mappings/:id',
    ...scope,
    route(async (req, res) => {
      const user = who(req),
        id = String(req.params.id || '')
      if (!UUID.test(id)) throw new IntegrationError('Mapping not found.', 404)
      const r = await db
        .from(TABLE)
        .update({ is_active: false, updated_by: user.name, updated_at: new Date().toISOString() })
        .eq('tenant_id', user.organizationId)
        .eq('id', id)
        .eq('is_active', true)
        .select('id')
      if (r.error) throw r.error
      if (!r.data?.length) throw new IntegrationError('Mapping not found. It may have been removed already.', 404)
      res.json({ removed: true })
    }),
  )
}
