import { randomUUID } from 'node:crypto'
import type { Express, Request, Response, NextFunction } from 'express'
import { GITHUB_QA_STATUSES, type GithubRepository } from '../../src/features/integrations/github-model'
import { linkedTaskSchedule } from './linked-task-fields'
import { encryptSecret, decryptSecret, encryptionKey, IntegrationError } from './tenant-integrations'
import {
  GitlabError,
  gitlabIdentity,
  gitlabIssue,
  gitlabRepoPath,
  gitlabRepositoryName,
  gitlabRequest,
  gitlabBaseUrl,
} from './gitlab-api'

type Middleware = (req: Request, res: Response, next: NextFunction) => any
type Cursor = {
  startedAt: string
  repository: number
  stage: number
  page: number
  seen: string[]
  phase: 'collect' | 'reconcile'
  missing: { id: string; repository: string; number: number }[]
  index: number
}
const PREFIX = '/api/work-hub/gitlab'
const publicTicketFields =
  'id,gitlab_id,number,repository,title,body,html_url,state,state_reason,creator,assignees,labels,milestone,comments_count,created_at,updated_at,created_by_me,assigned_to_me,qa_status,linked_task_id'

export function registerGitlab(
  app: Express,
  deps: {
    db: any
    requireAuth: Middleware
    requireTenant: Middleware
    guard: Middleware
    load: (id: string) => Promise<any>
    commit: (id: string, next: any, user: any, source: string, current: any) => Promise<any>
    openStatus: (state: any) => string
    requestBudget?: number
    request?: typeof gitlabRequest
  },
) {
  const api = deps.request || gitlabRequest
  const { db } = deps,
    auth = [deps.requireAuth, deps.requireTenant, deps.guard]
  const jobs = new Set<string>()
  const user = (req: Request) => (req as any).authUser
  const key = (u: any) => `${u.organizationId}:${u.id}`
  const wrap =
    (fn: (req: Request, res: Response) => Promise<any>): Middleware =>
    async (req, res) => {
      try {
        if (!db) throw new IntegrationError('Cloud storage is required for GitLab connections.', 503)
        await fn(req, res)
      } catch (e) {
        if (e instanceof GitlabError && e.retryAfterSeconds) res.setHeader('Retry-After', String(e.retryAfterSeconds))
        res
          .status(e instanceof IntegrationError ? e.status : 503)
          .json({
            error:
              e instanceof IntegrationError
                ? e.message
                : 'GitLab storage is unavailable. Apply schema-v20-work-hub-gitlab.sql and retry.',
            ...(e instanceof GitlabError && e.retryAfterSeconds ? { retryAfterSeconds: e.retryAfterSeconds } : {}),
          })
      }
    }
  const locked = async <T>(u: any, fn: () => Promise<T>) => {
    if (jobs.has(key(u)))
      throw new IntegrationError('A GitLab update is already running for your account. Wait for it to finish.', 409)
    jobs.add(key(u))
    try {
      return await fn()
    } finally {
      jobs.delete(key(u))
    }
  }
  const connection = async (u: any) => {
    const result = await db
      .from('user_gitlab_connections')
      .select('*')
      .eq('tenant_id', u.organizationId)
      .eq('user_id', u.id)
      .maybeSingle()
    if (result.error) throw new IntegrationError('Apply schema-v20-work-hub-gitlab.sql before connecting GitLab.', 503)
    return result.data
  }
  const summary = (row: any) => {
    let encryptionReady = true
    try {
      encryptionKey()
    } catch {
      encryptionReady = false
    }
    return {
      connected: Boolean(row?.encrypted_token),
      encryptionReady,
      login: row?.gitlab_login || '',
      repositories: row?.repositories || [],
      lastSyncedAt: row?.last_synced_at || null,
      hasMore: Boolean(row?.sync_cursor),
      baseUrl: row?.instance_url || 'https://gitlab.com',
    }
  }
  const connected = async (u: any) => {
    const row = await connection(u)
    if (!row?.encrypted_token) throw new IntegrationError('Connect your personal GitLab token first.', 409)
    return { row, token: decryptSecret(row.encrypted_token, `${key(u)}:${row.instance_url}`, 'gitlab-token') }
  }
  const saveConnection = async (u: any, patch: any, revision?: string) => {
    let query = db
      .from('user_gitlab_connections')
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('tenant_id', u.organizationId)
      .eq('user_id', u.id)
    if (revision) query = query.eq('revision', revision)
    const result = await query.select('user_id').maybeSingle()
    if (result.error) throw result.error
    if (!result.data)
      throw new IntegrationError(
        'Your GitLab connection changed during this operation. Retry with current settings.',
        409,
      )
  }
  const ticketQuery = (u: any, row: any, columns = publicTicketFields, options?: any) =>
    db
      .from('user_gitlab_issues')
      .select(columns, options)
      .eq('tenant_id', u.organizationId)
      .eq('owner_user_id', u.id)
      .eq('gitlab_user_id', row.gitlab_user_id)
      .eq('instance_url', row.instance_url)
      .in(
        'repository',
        (row.repositories || []).map((r: GithubRepository) => r.fullName),
      )
  const own = async (u: any, id: string) => {
    const row = await connection(u)
    if (!row) throw new IntegrationError('Ticket not found.', 404)
    const result = await ticketQuery(u, row).eq('id', id).maybeSingle()
    if (result.error) throw result.error
    if (!result.data) throw new IntegrationError('Ticket not found.', 404)
    return { row, ticket: result.data }
  }
  const writeTicket = async (u: any, row: any, id: string, patch: any, unlinked = false) => {
    let query = db
      .from('user_gitlab_issues')
      .update(patch)
      .eq('tenant_id', u.organizationId)
      .eq('owner_user_id', u.id)
      .eq('gitlab_user_id', row.gitlab_user_id)
      .eq('instance_url', row.instance_url)
      .eq('id', id)
    if (unlinked) query = query.is('linked_task_id', null)
    const result = await query.select(publicTicketFields).maybeSingle()
    if (result.error) throw result.error
    if (!result.data) throw new IntegrationError('This ticket already has a task link or is no longer available.', 409)
    return result.data
  }
  const taskAccess = (u: any) => {
    if (u.role === 'Viewer' || (u.role !== 'Administrator' && !u.modules?.includes('items')))
      throw new IntegrationError('Task write access is required.', 403)
  }
  const text = (value: unknown, label: string, max: number) => {
    if (typeof value !== 'string' || value.length > max) throw new IntegrationError(`Enter a valid ${label}.`)
    return value.trim()
  }

  app.get(
    `${PREFIX}/connection`,
    ...auth,
    wrap(async (req, res) => res.json(summary(await connection(user(req))))),
  )
  app.put(
    `${PREFIX}/connection`,
    ...auth,
    wrap(async (req, res) =>
      locked(user(req), async () => {
        const u = user(req),
          token = text(req.body?.token, 'personal GitLab token', 255)
        if (!/^[a-z0-9_.-]{16,255}$/i.test(token))
          throw new IntegrationError('Enter your personal GitLab access token. It is saved only for your user.')
        const baseUrl = gitlabBaseUrl(req.body?.baseUrl || 'https://gitlab.com')
        encryptionKey()
        const identity = gitlabIdentity(await api(token, '/user', baseUrl)),
          previous = await connection(u)
        const same = previous?.gitlab_user_id === identity.id && previous?.instance_url === baseUrl
        const result = await db
          .from('user_gitlab_connections')
          .upsert(
            {
              tenant_id: u.organizationId,
              user_id: u.id,
              instance_url: baseUrl,
              gitlab_user_id: identity.id,
              gitlab_login: identity.login,
              encrypted_token: encryptSecret(token, `${key(u)}:${baseUrl}`, 'gitlab-token'),
              repositories: same ? previous.repositories || [] : [],
              sync_cursor: null,
              last_synced_at: same ? previous.last_synced_at : null,
              retry_after: null,
              revision: randomUUID(),
              updated_at: new Date().toISOString(),
            },
            { onConflict: 'tenant_id,user_id' },
          )
        if (result.error) throw result.error
        res.json(summary(await connection(u)))
      }),
    ),
  )
  app.delete(
    `${PREFIX}/connection`,
    ...auth,
    wrap(async (req, res) =>
      locked(user(req), async () => {
        const u = user(req),
          row = await connection(u)
        if (row)
          await saveConnection(
            u,
            { encrypted_token: null, sync_cursor: null, retry_after: null, revision: randomUUID() },
            row.revision,
          )
        res.json({ disconnected: true })
      }),
    ),
  )
  app.get(
    `${PREFIX}/repositories`,
    ...auth,
    wrap(async (req, res) => {
      const page = Number(req.query.page || 1)
      if (!Number.isSafeInteger(page) || page < 1 || page > 10000)
        throw new IntegrationError('Choose a valid repository page.')
      const { row, token } = await connected(user(req)),
        result = await api(
          token,
          `/projects?membership=true&per_page=100&page=${page}&order_by=path&sort=asc`,
          row.instance_url,
        )
      if (!Array.isArray(result)) throw new IntegrationError('GitLab returned an invalid repository list.', 502)
      res.json({
        repositories: result
          .filter(r => r.issues_enabled !== false)
          .map(r => ({ fullName: gitlabRepositoryName(r.path_with_namespace), private: r.visibility !== 'public' })),
        hasMore: result.length === 100,
        page,
      })
    }),
  )
  app.put(
    `${PREFIX}/repositories`,
    ...auth,
    wrap(async (req, res) =>
      locked(user(req), async () => {
        const u = user(req),
          { row, token } = await connected(u),
          incoming = req.body?.repositories
        if (!Array.isArray(incoming) || incoming.length > 20)
          throw new IntegrationError('Select up to 20 repositories.')
        const state = (await deps.load(u.organizationId)).data
        if (!state) throw new IntegrationError('Workspace data is unavailable.', 503)
        const repositories: GithubRepository[] = []
        for (const item of incoming) {
          const fullName = gitlabRepositoryName(item?.fullName),
            clientId = text(item?.clientId || '', 'client', 100),
            projectId = text(item?.projectId || '', 'project', 100)
          if (
            (clientId && !state.clients?.some((c: any) => c.id === clientId && !c.archived)) ||
            (projectId && !state.projects?.some((p: any) => p.id === projectId && !p.archived))
          )
            throw new IntegrationError('Choose an active client and project for each repository.')
          const repo = await api(token, gitlabRepoPath(fullName), row.instance_url)
          if (repo.issues_enabled === false)
            throw new IntegrationError(`${fullName} does not have GitLab Issues enabled.`)
          repositories.push({ fullName: gitlabRepositoryName(repo.path_with_namespace), clientId, projectId })
        }
        if (new Set(repositories.map(r => r.fullName.toLowerCase())).size !== repositories.length)
          throw new IntegrationError('Choose each repository once.')
        await saveConnection(
          u,
          { repositories, sync_cursor: null, last_synced_at: null, retry_after: null, revision: randomUUID() },
          row.revision,
        )
        res.json(summary(await connection(u)))
      }),
    ),
  )

  app.post(
    `${PREFIX}/sync`,
    ...auth,
    wrap(async (req, res) =>
      locked(user(req), async () => {
        const u = user(req),
          { row, token } = await connected(u),
          repositories: GithubRepository[] = row.repositories || []
        if (!repositories.length)
          throw new IntegrationError('Select and save at least one repository in My GitLab settings.')
        const retry = Date.parse(row.retry_after || '') - Date.now()
        if (retry > 0)
          throw new GitlabError('GitLab requests are paused until the limit resets.', 429, Math.ceil(retry / 1000))
        if (
          req.body?.auto === true &&
          !row.sync_cursor &&
          Date.now() - Date.parse(row.last_synced_at || '') < 5 * 60 * 1000
        ) {
          res.json({ imported: 0, updated: 0, requests: 0, hasMore: false, lastSyncedAt: row.last_synced_at })
          return
        }
        const cursor: Cursor = row.sync_cursor || {
          startedAt: new Date().toISOString(),
          repository: 0,
          stage: 0,
          page: 1,
          seen: [],
          phase: 'collect',
          missing: [],
          index: 0,
        }
        const seen = new Set(cursor.seen),
          counted = new Set<number>(),
          counts = { imported: 0, updated: 0, requests: 0 },
          started = Date.now()
        const persist = async () => {
          cursor.seen = [...seen]
          await saveConnection(u, { sync_cursor: cursor }, row.revision)
        }
        const importIssues = async (values: any[], repository: string, personalOnly = true) => {
          const fresh = await connection(u)
          if (fresh?.revision !== row.revision)
            throw new IntegrationError('GitLab settings changed during sync. Retry with current settings.', 409)
          const issues = values
            .map(v => gitlabIssue(v, repository, row.gitlab_login, row.instance_url))
            .filter((i): i is NonNullable<typeof i> =>
              Boolean(i && (!personalOnly || i.created_by_me || i.assigned_to_me)),
            )
          if (!issues.length) return
          const existing = await ticketQuery(u, row, 'gitlab_id').in(
            'gitlab_id',
            issues.map(i => i.gitlab_id),
          )
          if (existing.error) throw existing.error
          const known = new Set((existing.data || []).map((i: any) => i.gitlab_id))
          const result = await db.from('user_gitlab_issues').upsert(
            issues.map(i => ({
              ...i,
              tenant_id: u.organizationId,
              owner_user_id: u.id,
              instance_url: row.instance_url,
              gitlab_user_id: row.gitlab_user_id,
            })),
            { onConflict: 'tenant_id,owner_user_id,instance_url,gitlab_user_id,gitlab_id' },
          )
          if (result.error) throw result.error
          for (const issue of issues) {
            if (!counted.has(issue.gitlab_id)) {
              if (known.has(issue.gitlab_id)) counts.updated++
              else counts.imported++
              counted.add(issue.gitlab_id)
            }
            if (issue.state === 'open') seen.add(`${repository}:${issue.gitlab_id}`)
          }
        }
        try {
          while (counts.requests < (deps.requestBudget || 12) && Date.now() - started < 45000) {
            if (cursor.phase === 'collect') {
              if (cursor.repository >= repositories.length) {
                cursor.phase = 'reconcile'
                cursor.missing = []
                cursor.index = 0
                // Reconcile disappeared open tickets so reassignment and closure do not leave stale rows.
                for (let page = 0; ; page++) {
                  const result = await ticketQuery(u, row, 'id,gitlab_id,repository,number')
                    .eq('state', 'open')
                    .eq('available', true)
                    .order('id', { ascending: true })
                    .range(page * 1000, page * 1000 + 999)
                  if (result.error && result.error.code !== 'PGRST103') throw result.error
                  for (const item of result.data || [])
                    if (!seen.has(`${item.repository}:${item.gitlab_id}`))
                      cursor.missing.push({ id: item.id, repository: item.repository, number: item.number })
                  if (!result.data || result.data.length < 1000) break
                }
                await persist()
                continue
              }
              const repository = repositories[cursor.repository].fullName,
                closed = cursor.stage >= 2,
                assigned = cursor.stage % 2 === 1
              const params = new URLSearchParams({
                scope: 'all',
                state: closed ? 'closed' : 'opened',
                per_page: '100',
                page: String(cursor.page),
                order_by: 'updated_at',
                sort: 'desc',
                [assigned ? 'assignee_id' : 'author_id']: String(row.gitlab_user_id),
              })
              if (closed)
                params.set('updated_after', new Date(Date.parse(cursor.startedAt) - 30 * 86400000).toISOString())
              const values = await api(token, `${gitlabRepoPath(repository)}/issues?${params}`, row.instance_url)
              counts.requests++
              if (!Array.isArray(values)) throw new IntegrationError('GitLab returned an invalid issue list.', 502)
              await importIssues(values, repository)
              if (values.length === 100) cursor.page++
              else {
                cursor.page = 1
                cursor.stage++
                if (cursor.stage === 4) {
                  cursor.repository++
                  cursor.stage = 0
                }
              }
              await persist()
            } else {
              if (cursor.index >= cursor.missing.length) break
              const item = cursor.missing[cursor.index]
              try {
                const value = await api(
                  token,
                  `${gitlabRepoPath(item.repository)}/issues/${item.number}`,
                  row.instance_url,
                )
                counts.requests++
                await importIssues([value], item.repository, false)
              } catch (e) {
                if (!(e instanceof GitlabError) || e.status !== 404) throw e
                counts.requests++
                await writeTicket(u, row, item.id, { available: false })
              }
              cursor.index++
              await persist()
            }
          }
          const hasMore = cursor.phase !== 'reconcile' || cursor.index < cursor.missing.length
          if (!hasMore)
            await saveConnection(
              u,
              { sync_cursor: null, last_synced_at: new Date().toISOString(), retry_after: null },
              row.revision,
            )
          res.json({ ...counts, hasMore, ...(!hasMore ? { lastSyncedAt: (await connection(u)).last_synced_at } : {}) })
        } catch (e) {
          if (e instanceof GitlabError && e.retryAfterSeconds)
            await saveConnection(
              u,
              { retry_after: new Date(Date.now() + e.retryAfterSeconds * 1000).toISOString() },
              row.revision,
            )
          throw e
        }
      }),
    ),
  )

  app.get(
    `${PREFIX}/tickets`,
    ...auth,
    wrap(async (req, res) => {
      const u = user(req),
        row = await connection(u),
        page = Number(req.query.page || 1),
        pageSize = Number(req.query.pageSize || 5)
      const view = String(req.query.view || 'all'),
        state = String(req.query.state || 'open'),
        repo = String(req.query.repository || ''),
        qa = String(req.query.qa || ''),
        q = String(req.query.q || '').trim(),
        label = String(req.query.label || '').trim()
      if (
        !Number.isSafeInteger(page) ||
        page < 1 ||
        page > 1000000 ||
        ![5, 10, 15].includes(pageSize) ||
        !['all', 'assigned', 'created'].includes(view) ||
        !['all', 'open', 'closed'].includes(state) ||
        q.length > 200 ||
        label.length > 100 ||
        (qa && !GITHUB_QA_STATUSES.includes(qa as any))
      )
        throw new IntegrationError('Choose valid GitLab ticket filters.')
      if (!row || !row.repositories?.length) {
        res.json({ items: [], total: 0, page, pageSize })
        return
      }
      const filtered = (head = false) => {
        let query = ticketQuery(u, row, publicTicketFields, { count: 'exact', head })
          .eq('available', true)
          .or('created_by_me.eq.true,assigned_to_me.eq.true')
        if (view === 'assigned') query = query.eq('assigned_to_me', true)
        if (view === 'created') query = query.eq('created_by_me', true)
        if (state !== 'all') query = query.eq('state', state)
        if (repo) query = query.eq('repository', repo)
        if (qa) query = query.eq('qa_status', qa)
        if (q) query = query.ilike('title', `%${q.replace(/[\\%_]/g, '\\$&')}%`)
        if (label) query = query.contains('labels', [label])
        return query
      }
      let result = await filtered()
        .order('updated_at', { ascending: false })
        .order('id', { ascending: true })
        .range((page - 1) * pageSize, page * pageSize - 1)
      if (result.error?.code === 'PGRST103') {
        const count = await filtered(true)
        if (count.error) throw count.error
        result = { data: [], count: count.count, error: null }
      }
      if (result.error) throw result.error
      res.json({ items: result.data || [], total: result.count || 0, page, pageSize })
    }),
  )
  app.get(
    `${PREFIX}/tickets/:id`,
    ...auth,
    wrap(async (req, res) => {
      const u = user(req),
        { row, ticket } = await own(u, req.params.id)
      let comments: any[] = [],
        commentError = ''
      if (row.encrypted_token)
        try {
          const token = decryptSecret(row.encrypted_token, `${key(u)}:${row.instance_url}`, 'gitlab-token'),
            path = `${gitlabRepoPath(ticket.repository)}/issues/${ticket.number}`
          let values: any[] = []
          for (let page = 1; page <= 5; page++) {
            const batch = await api(
              token,
              `${path}/notes?per_page=20&page=${page}&order_by=updated_at&sort=desc`,
              row.instance_url,
            )
            if (!Array.isArray(batch)) throw new Error()
            values = batch.filter(v => !v.system)
            if (values.length || batch.length < 20) break
            if (page === 5)
              commentError = 'No user comments found in the latest 100 notes. Open in GitLab to review older comments.'
          }
          comments = values
            .map(v => ({
              author: String(v.author?.username || 'GitLab user'),
              body: String(v.body || '').slice(0, 30000),
              updatedAt: String(v.updated_at || ''),
              url: `${ticket.html_url}#note_${Number(v.id) || 0}`,
            }))
            .reverse()
        } catch (e) {
          commentError = e instanceof IntegrationError ? e.message : 'Could not load the latest GitLab comment.'
        }
      res.json({ ticket, comments, commentError })
    }),
  )
  app.patch(
    `${PREFIX}/tickets/:id`,
    ...auth,
    wrap(async (req, res) =>
      locked(user(req), async () => {
        const u = user(req),
          { row, ticket } = await own(u, req.params.id),
          qaStatus = req.body?.qaStatus
        if (!GITHUB_QA_STATUSES.includes(qaStatus)) throw new IntegrationError('Choose a valid QA status.')
        res.json({ ticket: await writeTicket(u, row, ticket.id, { qa_status: qaStatus }) })
      }),
    ),
  )
  app.post(
    `${PREFIX}/tickets/:id/link-task`,
    ...auth,
    wrap(async (req, res) =>
      locked(user(req), async () => {
        const u = user(req)
        taskAccess(u)
        const { row, ticket } = await own(u, req.params.id),
          taskId = text(req.body?.taskId || '', 'task', 100),
          state = (await deps.load(u.organizationId)).data
        if (!state) throw new IntegrationError('Workspace data is unavailable.', 503)
        if (taskId && !state.items?.some((item: any) => item.id === taskId && item.type === 'Task' && !item.archived))
          throw new IntegrationError('Select an existing task or subtask in this workspace.', 404)
        res.json({ ticket: await writeTicket(u, row, ticket.id, { linked_task_id: taskId || null }) })
      }),
    ),
  )
  app.post(
    `${PREFIX}/tickets/:id/create-task`,
    ...auth,
    wrap(async (req, res) =>
      locked(user(req), async () => {
        const u = user(req)
        taskAccess(u)
        const { row, ticket } = await own(u, req.params.id)
        if (ticket.linked_task_id) throw new IntegrationError('This ticket already has a linked task.', 409)
        const state = (await deps.load(u.organizationId)).data
        if (!state) throw new IntegrationError('Workspace data is unavailable.', 503)
        const clientId = text(req.body?.clientId, 'client', 100),
          projectId = text(req.body?.projectId, 'project', 100),
          assignee = text(req.body?.assignedToUserId, 'assignee', 100),
          title = text(req.body?.title, 'task title', 200),
          description = text(req.body?.description, 'task description', 5000)
        if (
          !title ||
          !clientId ||
          !projectId ||
          !state.clients?.some((c: any) => c.id === clientId && !c.archived) ||
          !state.projects?.some((p: any) => p.id === projectId && !p.archived)
        )
          throw new IntegrationError('Enter a task title and select an active client and project.')
        const account = state.accounts?.find(
          (a: any) => a.id === assignee && a.status !== 'Disabled' && ['Administrator', 'Contributor'].includes(a.role),
        )
        if (!account) throw new IntegrationError('Select an active team member.')
        const schedule = linkedTaskSchedule(req.body, state)
        const task = {
          id: randomUUID(),
          clientId,
          projectId,
          title,
          type: 'Task',
          priority: 'Medium',
          status: deps.openStatus(state),
          waitingOn: schedule.waitingOn,
          owner: account.name || account.username,
          assignedToUserId: assignee,
          dateRaised: new Date().toISOString().slice(0, 10),
          startDate: schedule.startDate,
          dueDate: schedule.dueDate,
          followUpDate: schedule.followUpDate,
          description,
          resolution: '',
          source: 'Other',
        }
        // Reserve the private link before creating shared work, preventing duplicate submissions.
        await writeTicket(u, row, ticket.id, { linked_task_id: task.id }, true)
        try {
          await deps.commit(
            u.organizationId,
            { ...state, items: [task, ...(state.items || [])] },
            u,
            'gitlab-task',
            state,
          )
        } catch (e) {
          // A lost commit response can still mean success; inspect the task before releasing its link.
          const saved = (await deps.load(u.organizationId)).data
          if (!saved?.items?.some((i: any) => i.id === task.id)) {
            await writeTicket(u, row, ticket.id, { linked_task_id: null })
            throw e
          }
        }
        res.status(201).json({ task, ticket: { ...ticket, linked_task_id: task.id } })
      }),
    ),
  )
}
