import assert from 'node:assert/strict'
import test from 'node:test'
import express from 'express'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import GithubHub from '../src/features/integrations/GithubHub'
import GitProviderHub from '../src/features/integrations/GitProviderHub'
import {
  gitlabRequest,
  gitlabBaseUrl,
  gitlabRepositoryName,
  gitlabPublicAddress,
} from '../server/integrations/gitlab-api'
import WorkHub from '../src/features/work-hub/WorkHub'
import { WORK_HUB_TABS } from '../src/features/integrations/github-model'
import { registerGitlab } from '../server/integrations/gitlab'
import { decryptSecret } from '../server/integrations/tenant-integrations'

const TOKEN_A = 'glpat_' + 'a'.repeat(30),
  TOKEN_B = 'glpat_' + 'b'.repeat(30)
const now = new Date().toISOString()
function issue(number: number, extra: any = {}) {
  return {
    id: 10000 + number,
    iid: number,
    title: `Inventory ticket ${number}`,
    description: 'PRIVATE body for QA',
    html_url: `https://gitlab.com/acme/pos/-/issues/${number}`,
    state: 'opened',
    author: { username: 'alice' },
    assignees: [{ username: 'alice' }],
    labels: ['bug'],
    user_notes_count: 0,
    created_at: '2011-01-01T00:00:00Z',
    updated_at: now,
    ...extra,
  }
}
async function fixture(run: (f: any) => Promise<void>, budget = 12) {
  const oldFetch = globalThis.fetch,
    oldKey = process.env.TENANT_INTEGRATION_MASTER_KEY
  process.env.TENANT_INTEGRATION_MASTER_KEY = 'a'.repeat(64)
  const tables: Record<string, any[]> = { user_gitlab_connections: [], user_gitlab_issues: [] }
  const states: Record<string, any> = {
    tenant: {
      clients: [{ id: 'client', name: 'Acme' }],
      projects: [{ id: 'project', name: 'POS' }],
      accounts: [
        { id: 'user-a', name: 'Alice', role: 'Contributor', status: 'Active' },
        { id: 'user-b', name: 'Bob', role: 'Contributor', status: 'Active' },
      ],
      items: [
        {
          id: 'existing',
          title: 'Existing task',
          type: 'Task',
          status: 'Open',
          clientId: 'client',
          projectId: 'project',
        },
        {
          id: 'child',
          title: 'Retest subtask',
          parentTaskId: 'existing',
          type: 'Task',
          status: 'Open',
          clientId: 'client',
          projectId: 'project',
        },
      ],
    },
    other: { clients: [], projects: [], accounts: [], items: [] },
  }
  let commitFailure = false,
    lostResponse = false,
    remoteFailure = 0,
    hold: Promise<void> | null = null,
    missingTable = false
  const provider: any[] = []
  const repositories: Record<string, any[]> = { 'acme/pos': [issue(1)], 'acme/reports': [] }
  // My comment events (GitLab's /events), newest first.
  const events: any[] = []
  const projectId = (repo: string) => Object.keys(repositories).indexOf(repo) + 1
  const projectName = (id: string) => (/^\d+$/.test(id) ? Object.keys(repositories)[Number(id) - 1] : id)
  let repositoryCatalog: any[] = [
    { path_with_namespace: 'acme/pos', issues_enabled: true, visibility: 'private' },
    { path_with_namespace: 'acme/reports', issues_enabled: true, visibility: 'public' },
  ]
  const comments = Array.from({ length: 6 }, (_, i) => ({
    id: i + 1,
    author: { username: 'dev' },
    body: `Comment ${i + 1}`,
    updated_at: now,
  }))
  class Query {
    checks: ((r: any) => boolean)[] = []
    action = 'read'
    value: any
    conflict: string[] = []
    columns = '*'
    many = true
    head = false
    start = 0
    end = Infinity
    orders: { key: string; ascending: boolean }[] = []
    constructor(public table: string) {}
    select(columns = '*', options: any = {}) {
      this.columns = columns
      this.head = Boolean(options.head)
      return this
    }
    eq(k: string, v: any) {
      this.checks.push(r => r[k] === v)
      return this
    }
    is(k: string, v: any) {
      this.checks.push(r => r[k] === v || (v === null && r[k] === undefined))
      return this
    }
    in(k: string, v: any[]) {
      this.checks.push(r => v.includes(r[k]))
      return this
    }
    contains(k: string, v: any[]) {
      this.checks.push(r => v.every(x => (r[k] || []).includes(x)))
      return this
    }
    or(value: string) {
      const fields = value.split(',').map(part => part.split('.')[0])
      this.checks.push(r => fields.some(k => r[k] === true))
      return this
    }
    lt(k: string, v: any) {
      this.checks.push(r => r[k] !== null && r[k] !== undefined && r[k] < v)
      return this
    }
    lte(k: string, v: any) {
      this.checks.push(r => r[k] !== null && r[k] !== undefined && r[k] <= v)
      return this
    }
    gte(k: string, v: any) {
      this.checks.push(r => r[k] !== null && r[k] !== undefined && r[k] >= v)
      return this
    }
    limit(n: number) {
      this.end = n - 1
      return this
    }
    ilike(k: string, pattern: string) {
      const term = pattern
        .slice(1, -1)
        .replace(/\\([\\%_])/g, '$1')
        .toLowerCase()
      this.checks.push(r =>
        String(r[k] || '')
          .toLowerCase()
          .includes(term),
      )
      return this
    }
    order(key: string, options: { ascending: boolean }) {
      this.orders.push({ key, ascending: options.ascending })
      return this
    }
    range(start: number, end: number) {
      this.start = start
      this.end = end
      return this
    }
    update(value: any) {
      this.action = 'update'
      this.value = value
      return this
    }
    upsert(value: any, options: any) {
      this.action = 'upsert'
      this.value = value
      this.conflict = options.onConflict.split(',')
      return this
    }
    maybeSingle() {
      this.many = false
      return this.run()
    }
    then(resolve: any, reject: any) {
      return this.run().then(resolve, reject)
    }
    async run() {
      if (missingTable) return { data: null, error: { code: '42P01' } }
      const rows = tables[this.table]
      if (!rows) throw new Error(`Unexpected table ${this.table}`)
      if (this.action === 'upsert') {
        for (const incoming of Array.isArray(this.value) ? this.value : [this.value]) {
          const found = rows.find(r => this.conflict.every(k => r[k] === incoming[k]))
          if (found) Object.assign(found, structuredClone(incoming))
          else
            rows.push({
              id: crypto.randomUUID(),
              qa_status: 'Not started',
              linked_task_id: null,
              available: true,
              ...structuredClone(incoming),
            })
        }
        return { data: null, error: null }
      }
      const matched = rows.filter(r => this.checks.every(check => check(r)))
      if (this.action === 'update') for (const row of matched) Object.assign(row, structuredClone(this.value))
      matched.sort((a, b) => {
        for (const o of this.orders) {
          const result = String(a[o.key]).localeCompare(String(b[o.key]))
          if (result) return o.ascending ? result : -result
        }
        return 0
      })
      if (this.start > 0 && this.start >= matched.length)
        return { data: null, count: null, error: { code: 'PGRST103' } }
      const projection = (r: any) =>
        structuredClone(this.columns === '*' ? r : Object.fromEntries(this.columns.split(',').map(k => [k, r[k]])))
      return {
        data: this.head
          ? null
          : this.many
            ? matched.slice(this.start, this.end + 1).map(projection)
            : matched[0]
              ? projection(matched[0])
              : null,
        count: matched.length,
        error: null,
      }
    }
  }
  const app = express()
  app.use(express.json())
  app.use((req: any, _res, next) => {
    req.authUser = {
      id: String(req.headers['x-user'] || 'user-a'),
      organizationId: String(req.headers['x-tenant'] || 'tenant'),
      role: String(req.headers['x-role'] || 'Contributor'),
      modules: req.headers['x-no-tasks'] ? ['inbox'] : ['inbox', 'items'],
    }
    next()
  })
  const pass = (_req: any, _res: any, next: any) => next()
  registerGitlab(app, {
    db: { from: (table: string) => new Query(table) },
    requireAuth: pass,
    requireTenant: pass,
    guard: (_req, res, next) => {
      res.setHeader('Cache-Control', 'no-store')
      next()
    },
    load: async id => ({ data: structuredClone(states[id]) }),
    commit: async (id, next) => {
      if (commitFailure) throw new Error('Commit failed')
      states[id] = structuredClone(next)
      if (lostResponse) throw new Error('Response lost')
    },
    openStatus: () => 'Open',
    requestBudget: budget,
    request: (token, path, baseUrl) =>
      gitlabRequest(token, path, baseUrl, (url, token) =>
        globalThis.fetch(url, { headers: { 'PRIVATE-TOKEN': token } }),
      ),
  })
  const server = app.listen(0),
    base = `http://127.0.0.1:${(server.address() as any).port}/api/work-hub/gitlab`
  const ask = async (
    path: string,
    method = 'GET',
    body?: any,
    who = 'user-a',
    tenant = 'tenant',
    role = 'Contributor',
  ) => {
    const response = await oldFetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', 'x-user': who, 'x-tenant': tenant, 'x-role': role },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    return { status: response.status, body: await response.json(), headers: response.headers }
  }
  globalThis.fetch = (async (input: any, options: any) => {
    if (!String(input).startsWith('https://gitlab.com') && !String(input).startsWith('https://gitlab.company.com'))
      return oldFetch(input, options)
    const url = new URL(String(input)),
      token = options.headers['PRIVATE-TOKEN'],
      login = token === TOKEN_B ? 'bob' : 'alice'
    provider.push({ url: String(url), method: options.method || 'GET', token })
    if (hold) await hold
    const json = (value: any, status = 200, headers: any = {}) =>
      new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } })
    if (remoteFailure)
      return json(
        { message: `Sensitive provider echo ${TOKEN_A}` },
        remoteFailure,
        remoteFailure === 429 ? { 'retry-after': '90' } : {},
      )
    if (url.pathname === '/api/v4/user') return json({ id: login === 'alice' ? 42 : 43, username: login })
    if (url.pathname === '/api/v4/projects') {
      const p = Number(url.searchParams.get('page') || 1)
      return json(repositoryCatalog.slice((p - 1) * 100, p * 100))
    }
    const served = (repo: string, i: any) => ({
      ...i,
      project_id: projectId(repo),
      references: { full: `${repo}#${i.iid}` },
      web_url: `${url.origin}/${repo}/-/issues/${i.iid}`,
    })
    if (url.pathname === '/api/v4/issues') {
      const scope = url.searchParams.get('scope'),
        state = url.searchParams.get('state'),
        since = url.searchParams.get('updated_after'),
        page = Number(url.searchParams.get('page') || 1)
      const all = Object.entries(repositories).flatMap(([repo, values]) =>
        values
          .filter(
            i =>
              (!state || i.state === state) &&
              (!since || i.updated_at >= since) &&
              (scope === 'created_by_me'
                ? i.author.username === login
                : scope === 'assigned_to_me'
                  ? i.assignees.some((a: any) => a.username === login)
                  : false),
          )
          .map(i => served(repo, i)),
      )
      all.sort((a, b) => b.updated_at.localeCompare(a.updated_at) || a.id - b.id)
      return json(all.slice((page - 1) * 100, page * 100))
    }
    if (url.pathname === '/api/v4/events') {
      const page = Number(url.searchParams.get('page') || 1)
      return json(login === 'alice' ? events.slice((page - 1) * 100, page * 100) : [])
    }
    const route = url.pathname.match(/^\/api\/v4\/projects\/([^/]+)(?:\/issues(?:\/(\d+)(?:\/(notes))?)?)?$/)
    if (!route) return json({}, 404)
    const repo = projectName(decodeURIComponent(route[1]))
    if (!repo || !(repo in repositories)) return json({}, 404)
    if (!url.pathname.includes('/issues')) return json({ path_with_namespace: repo, issues_enabled: true })
    const number = Number(route[2]),
      values = repositories[repo]
    if (number) {
      const found = values.find(i => i.iid === number)
      if (!found) return json({}, 404)
      if (route[3]) {
        const page = Number(url.searchParams.get('page') || 1)
        return json([...comments].sort((a, b) => b.id - a.id).slice((page - 1) * 20, page * 20))
      }
      return json(served(repo, found))
    }
    const state = url.searchParams.get('state'),
      creator = url.searchParams.get('author_id'),
      assignee = url.searchParams.get('assignee_id'),
      since = url.searchParams.get('updated_after'),
      page = Number(url.searchParams.get('page') || 1)
    const filtered = values
      .filter(
        i =>
          (!state || i.state === state) &&
          (!creator || i.author.username === (creator === '42' ? 'alice' : 'bob')) &&
          (!assignee || i.assignees.some((a: any) => a.username === (assignee === '42' ? 'alice' : 'bob'))) &&
          (!since || i.updated_at >= since),
      )
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at) || a.id - b.id)
    return json(filtered.slice((page - 1) * 100, page * 100))
  }) as typeof fetch
  const connect = async (who = 'user-a', token = TOKEN_A) => {
    assert.equal((await ask('/connection', 'PUT', { token }, who)).status, 200)
  }
  const select = async (names = ['acme/pos'], who = 'user-a') => {
    const response = await ask(
      '/repositories',
      'PUT',
      { repositories: names.map(fullName => ({ fullName, clientId: 'client', projectId: 'project' })) },
      who,
    )
    assert.equal(response.status, 200, JSON.stringify(response.body))
  }
  const sync = async (who = 'user-a') => {
    let response: any
    for (let i = 0; i < 50; i++) {
      response = await ask('/sync', 'POST', {}, who)
      assert.equal(response.status, 200, JSON.stringify(response.body))
      if (!response.body.hasMore) return response.body
    }
    throw new Error('Sync did not complete')
  }
  try {
    await run({
      ask,
      connect,
      select,
      sync,
      tables,
      states,
      repositories,
      events,
      projectId,
      provider,
      comments,
      setRemoteFailure: (v: number) => {
        remoteFailure = v
      },
      setHold: (v: Promise<void> | null) => {
        hold = v
      },
      setCommitFailure: (v: boolean) => {
        commitFailure = v
      },
      setLostResponse: (v: boolean) => {
        lostResponse = v
      },
      setMissingTable: (v: boolean) => {
        missingTable = v
      },
      setCatalog: (v: any[]) => {
        repositoryCatalog = v
      },
    })
  } finally {
    globalThis.fetch = oldFetch
    await new Promise<void>(resolve => server.close(() => resolve()))
    if (oldKey === undefined) delete process.env.TENANT_INTEGRATION_MASTER_KEY
    else process.env.TENANT_INTEGRATION_MASTER_KEY = oldKey
  }
}

test('GitLab personal tokens are validated, encrypted for the owning user, and absent from public settings', async () =>
  fixture(async (f: any) => {
    await f.connect()
    const stored = f.tables.user_gitlab_connections[0]
    assert.notEqual(stored.encrypted_token, TOKEN_A)
    assert.equal(decryptSecret(stored.encrypted_token, 'tenant:user-a:https://gitlab.com', 'gitlab-token'), TOKEN_A)
    assert.throws(() => decryptSecret(stored.encrypted_token, 'tenant:user-b:https://gitlab.com', 'gitlab-token'))
    const summary = await f.ask('/connection')
    assert.equal(summary.body.connected, true)
    assert.equal(summary.body.login, 'alice')
    assert.ok(!JSON.stringify(summary.body).includes(TOKEN_A))
    assert.ok(!JSON.stringify(summary.body).includes('encrypted_token'))
    assert.equal((await f.ask('/connection', 'PUT', { token: 'invalid' })).status, 400)
    assert.equal(f.tables.user_gitlab_connections[0].encrypted_token, stored.encrypted_token)
    assert.equal((await f.ask('/connection', 'GET', undefined, 'user-b')).body.connected, false)
  }))

test('repository selection validates access, unique names, mappings and owner/repository format', async () =>
  fixture(async (f: any) => {
    await f.connect()
    await f.select()
    const selected = await f.ask('/connection')
    assert.deepEqual(selected.body.repositories, [{ fullName: 'acme/pos', clientId: 'client', projectId: 'project' }])
    for (const repositories of [
      [{ fullName: 'https://evil.example', clientId: '', projectId: '' }],
      [{ fullName: 'acme/missing' }],
      [{ fullName: 'acme/pos', clientId: 'another-tenant' }],
      [{ fullName: 'acme/pos' }, { fullName: 'acme/pos' }],
    ])
      assert.ok((await f.ask('/repositories', 'PUT', { repositories })).status >= 400)
    assert.deepEqual((await f.ask('/connection')).body.repositories, selected.body.repositories)
  }))

test('sync imports created or assigned issues once, excludes pull requests and unrelated issues, and keeps old open tickets', async () =>
  fixture(async (f: any) => {
    f.repositories['acme/pos'] = [
      issue(1),
      issue(2, { author: { username: 'dev' }, assignees: [{ username: 'alice' }] }),
      issue(3, { author: { username: 'alice' }, assignees: [], state: 'closed' }),
      issue(4, { author: { username: 'dev' }, assignees: [{ username: 'dev' }] }),
      issue(5, { issue_type: 'merge_request' }),
      issue(6, { state: 'closed', updated_at: '2012-01-01T00:00:00Z' }),
    ]
    await f.connect()
    await f.select()
    await f.sync()
    assert.deepEqual(f.tables.user_gitlab_issues.map((i: any) => i.number).sort(), [1, 2, 3])
    assert.equal(f.tables.user_gitlab_issues[0].created_at, '2011-01-01T00:00:00Z')
    assert.equal((await f.ask('/tickets')).body.total, 2)
    assert.equal((await f.ask('/tickets?view=created&state=all')).body.total, 2)
    assert.equal((await f.ask('/tickets?view=assigned')).body.total, 2)
    assert.equal((await f.ask('/tickets?label=bug')).body.total, 2)
    assert.equal((await f.ask('/tickets?label=missing')).body.total, 0)
    assert.equal((await f.ask('/tickets?q=Inventory%25')).body.total, 0)
    await f.sync()
    assert.equal(f.tables.user_gitlab_issues.length, 3)
    assert.ok(f.provider.every((r: any) => r.method === 'GET'))
  }))

test('paged sync continues after its request budget and retains QA status and task links during refresh', async () =>
  fixture(async (f: any) => {
    f.repositories['acme/pos'] = Array.from({ length: 101 }, (_, i) => issue(i + 1))
    await f.connect()
    await f.select()
    const first = await f.ask('/sync', 'POST', {})
    assert.equal(first.body.hasMore, true)
    assert.equal(f.tables.user_gitlab_issues.length, 101)
    const ticket = f.tables.user_gitlab_issues[0]
    assert.equal((await f.ask(`/tickets/${ticket.id}`, 'PATCH', { qaStatus: 'Needs retest' })).status, 200)
    assert.equal((await f.ask(`/tickets/${ticket.id}/link-task`, 'POST', { taskId: 'child' })).status, 200)
    await f.sync()
    assert.equal(f.tables.user_gitlab_issues.length, 101)
    assert.equal(ticket.qa_status, 'Needs retest')
    assert.equal(ticket.linked_task_id, 'child')
    assert.ok(f.provider.some((r: any) => new URL(r.url).searchParams.get('page') === '2'))
    assert.equal((await f.ask('/tickets?page=2&pageSize=5')).body.items.length, 5)
    assert.equal((await f.ask('/tickets?page=500&pageSize=5')).body.total, 101)
    assert.equal((await f.ask('/tickets?qa=Needs%20retest')).body.total, 1)
    assert.equal((await f.ask('/sync', 'POST', { auto: true })).body.requests, 0)
  }, 2))

test('sync reconciles closure and reassignment without changing local QA status or task state', async () =>
  fixture(async (f: any) => {
    f.repositories['acme/pos'] = [issue(1), issue(2, { author: { username: 'dev' } })]
    await f.connect()
    await f.select()
    await f.sync()
    const ticket = f.tables.user_gitlab_issues.find((i: any) => i.number === 1)
    await f.ask(`/tickets/${ticket.id}`, 'PATCH', { qaStatus: 'Needs retest' })
    f.repositories['acme/pos'][0].state = 'closed'
    f.repositories['acme/pos'][0].updated_at = '2012-01-01T00:00:00Z'
    f.repositories['acme/pos'][1].assignees = []
    await f.sync()
    assert.equal(ticket.state, 'closed')
    assert.equal(ticket.qa_status, 'Needs retest')
    assert.equal((await f.ask('/tickets')).body.total, 0)
    assert.equal((await f.ask('/tickets?state=closed')).body.total, 1)
    assert.equal(f.states.tenant.items[0].status, 'Open')
  }))

test('tokens and imported tickets stay isolated across users, tenants and GitLab account changes', async () =>
  fixture(async (f: any) => {
    await f.connect()
    await f.select()
    await f.sync()
    const id = f.tables.user_gitlab_issues[0].id
    assert.equal((await f.ask('/tickets', 'GET', undefined, 'user-b', 'tenant', 'Administrator')).body.total, 0)
    for (const [path, method, body] of [
      [`/tickets/${id}`, 'GET', undefined],
      [`/tickets/${id}`, 'PATCH', { qaStatus: 'Passed' }],
      [`/tickets/${id}/link-task`, 'POST', { taskId: 'existing' }],
      [`/tickets/${id}/create-task`, 'POST', {}],
    ])
      assert.equal((await f.ask(path as string, method as string, body, 'user-b')).status, 404)
    assert.equal((await f.ask(`/tickets/${id}`, 'GET', undefined, 'user-a', 'other')).status, 404)
    await f.connect('user-b', TOKEN_B)
    await f.select(['acme/pos'], 'user-b')
    await f.sync('user-b')
    assert.equal((await f.ask('/tickets', 'GET', undefined, 'user-b')).body.total, 0)
    await f.ask('/connection', 'DELETE')
    assert.equal((await f.ask('/connection')).body.connected, false)
    assert.equal((await f.ask('/tickets')).body.total, 1)
    await f.connect('user-a', TOKEN_B)
    assert.equal((await f.ask('/connection')).body.repositories.length, 0)
    await f.select()
    assert.equal((await f.ask('/tickets')).body.total, 0)
    assert.ok(
      f.tables.user_gitlab_issues.some((i: any) => i.id === id),
      'old account cache retained privately',
    )
  }))

test('task creation shares only reviewed fields and cannot create a duplicate on repeated submission', async () =>
  fixture(async (f: any) => {
    await f.connect()
    await f.select()
    await f.sync()
    const id = f.tables.user_gitlab_issues[0].id
    const body = {
      title: 'Retest inventory',
      description: 'Shared summary',
      clientId: 'client',
      projectId: 'project',
      assignedToUserId: 'user-b',
    }
    const created = await f.ask(`/tickets/${id}/create-task`, 'POST', body)
    assert.equal(created.status, 201, JSON.stringify(created.body))
    assert.equal(created.body.task.assignedToUserId, 'user-b')
    assert.equal(f.states.tenant.items[0].description, 'Shared summary')
    assert.ok(!JSON.stringify(f.states.tenant.items[0]).includes('PRIVATE'))
    assert.ok(!JSON.stringify(f.states.tenant.items[0]).includes(id))
    assert.ok(!JSON.stringify(f.states.tenant.items[0]).includes(TOKEN_A))
    assert.equal((await f.ask(`/tickets/${id}/create-task`, 'POST', body)).status, 409)
    assert.equal(f.states.tenant.items.length, 3)
    assert.equal((await f.ask(`/tickets/${id}/link-task`, 'POST', { taskId: '' })).status, 200)
    assert.equal(
      (await f.ask(`/tickets/${id}/link-task`, 'POST', { taskId: 'child' })).body.ticket.linked_task_id,
      'child',
    )
    assert.equal((await f.ask(`/tickets/${id}/link-task`, 'POST', { taskId: 'other-tenant-task' })).status, 404)
    assert.equal((await f.ask(`/tickets/${id}/create-task`, 'POST', body, 'user-a', 'tenant', 'Viewer')).status, 403)
  }))

test('task creation saves the chosen schedule and waiting on, and rejects invalid values', async () =>
  fixture(async (f: any) => {
    await f.connect()
    await f.select()
    await f.sync()
    const id = f.tables.user_gitlab_issues[0].id
    const base = {
      title: 'Scheduled retest',
      description: 'Summary',
      clientId: 'client',
      projectId: 'project',
      assignedToUserId: 'user-b',
    }
    for (const bad of [
      { waitingOn: 'Nobody' },
      { startDate: '2026-13-01' },
      { dueDate: '2026-02-30' },
      { followUpDate: 'tomorrow' },
      { startDate: '2026-10-21', dueDate: '2026-10-20' },
    ]) {
      const rejected = await f.ask(`/tickets/${id}/create-task`, 'POST', { ...base, ...bad })
      assert.equal(rejected.status, 400, JSON.stringify(bad))
      assert.equal(f.tables.user_gitlab_issues[0].linked_task_id, null)
    }
    const created = await f.ask(`/tickets/${id}/create-task`, 'POST', {
      ...base,
      waitingOn: 'Client',
      startDate: '2026-10-20',
      dueDate: '2026-10-24',
      followUpDate: '2026-10-22',
    })
    assert.equal(created.status, 201, JSON.stringify(created.body))
    const saved = f.states.tenant.items[0]
    assert.equal(saved.waitingOn, 'Client')
    assert.equal(saved.startDate, '2026-10-20')
    assert.equal(saved.dueDate, '2026-10-24')
    assert.equal(saved.followUpDate, '2026-10-22')
  }))

test('failed task commits release the reservation; lost successful responses keep a recoverable link', async () =>
  fixture(async (f: any) => {
    await f.connect()
    await f.select()
    await f.sync()
    const ticket = f.tables.user_gitlab_issues[0],
      body = {
        title: 'Retest',
        description: 'Summary',
        clientId: 'client',
        projectId: 'project',
        assignedToUserId: 'user-a',
      }
    f.setCommitFailure(true)
    assert.equal((await f.ask(`/tickets/${ticket.id}/create-task`, 'POST', body)).status, 503)
    assert.equal(ticket.linked_task_id, null)
    f.setCommitFailure(false)
    f.setLostResponse(true)
    const saved = await f.ask(`/tickets/${ticket.id}/create-task`, 'POST', body)
    assert.equal(saved.status, 201)
    assert.equal(ticket.linked_task_id, saved.body.task.id)
    assert.equal((await f.ask(`/tickets/${ticket.id}/create-task`, 'POST', body)).status, 409)
  }))

test('latest comment is fetched using GitLab notes sorted by update without exposing private provider data', async () =>
  fixture(async (f: any) => {
    f.repositories['acme/pos'][0].user_notes_count = 6
    await f.connect()
    await f.select()
    await f.sync()
    const id = f.tables.user_gitlab_issues[0].id
    const detail = await f.ask(`/tickets/${id}`)
    assert.equal(detail.status, 200)
    assert.equal(detail.body.comments.at(-1).body, 'Comment 6')
    assert.ok(f.provider.some((p: any) => p.url.includes('/notes?per_page=20&page=1&order_by=updated_at&sort=desc')))
    assert.ok(!JSON.stringify(detail.body).includes(TOKEN_A))
    assert.equal(detail.headers.get('cache-control'), 'no-store')
  }))

test('rate limits pause sync with retry guidance; revoked tokens preserve cached tickets', async () =>
  fixture(async (f: any) => {
    await f.connect()
    await f.select()
    await f.sync()
    const id = f.tables.user_gitlab_issues[0].id
    f.setRemoteFailure(429)
    const limited = await f.ask('/sync', 'POST', {})
    assert.equal(limited.status, 429)
    assert.equal(limited.body.retryAfterSeconds, 90)
    assert.equal(limited.headers.get('retry-after'), '90')
    assert.ok(!JSON.stringify(limited.body).includes(TOKEN_A))
    const calls = f.provider.length
    assert.equal((await f.ask('/sync', 'POST', {})).status, 429)
    assert.equal(f.provider.length, calls)
    f.tables.user_gitlab_connections[0].retry_after = null
    f.setRemoteFailure(401)
    assert.equal((await f.ask('/sync', 'POST', {})).status, 409)
    assert.equal((await f.ask('/tickets')).body.total, 1)
    const detail = await f.ask(`/tickets/${id}`)
    assert.equal(detail.status, 200)
    assert.match(detail.body.commentError, /expired or was revoked/)
  }))

test('simultaneous sync and settings mutation do not corrupt the owning connection', async () =>
  fixture(async (f: any) => {
    await f.connect()
    await f.select()
    let release!: () => void
    f.setHold(
      new Promise<void>(resolve => {
        release = resolve
      }),
    )
    const pending = f.ask('/sync', 'POST', {})
    while (!f.provider.some((p: any) => p.url.includes('/issues?')))
      await new Promise(resolve => setTimeout(resolve, 1))
    assert.equal((await f.ask('/connection', 'DELETE')).status, 409)
    assert.equal((await f.ask('/connection', 'GET', undefined, 'user-b')).status, 200)
    release()
    f.setHold(null)
    assert.equal((await pending).status, 200)
    assert.equal((await f.ask('/connection')).body.connected, true)
  }))

test('repository discovery supports pagination and unavailable storage gives migration guidance', async () =>
  fixture(async (f: any) => {
    await f.connect()
    f.setCatalog(
      Array.from({ length: 101 }, (_, i) => ({ path_with_namespace: `acme/repo-${i}`, issues_enabled: true })),
    )
    const first = await f.ask('/repositories')
    assert.equal(first.body.repositories.length, 100)
    assert.equal(first.body.hasMore, true)
    const next = await f.ask('/repositories?page=2')
    assert.equal(next.body.repositories.length, 1)
    assert.equal(next.body.hasMore, false)
    f.setMissingTable(true)
    const result = await f.ask('/connection')
    assert.equal(result.status, 503)
    assert.match(result.body.error, /database\/schema\.sql/)
  }))

test('provider dropdown and GitLab settings use the selected provider without mixing credentials', () => {
  const currentUser: any = {
      id: 'user-a',
      name: 'Alice',
      role: 'Contributor',
      modules: ['inbox', 'items'],
      organizationId: 'tenant',
    },
    props = { clients: [], projects: [], accounts: [], tasks: [], currentUser, onTaskCreated: async () => {} }
  const selector = renderToStaticMarkup(createElement(GitProviderHub, props))
  assert.match(selector, /Ticket provider/)
  assert.match(selector, /<option value="github" selected="">GitHub/)
  assert.match(selector, /<option value="gitlab">GitLab/)
  const gitlab = renderToStaticMarkup(createElement(GithubHub, { ...props, provider: 'gitlab' }))
  assert.match(gitlab, /Assigned to me/)
  assert.match(gitlab, /Created by me/)
  assert.match(gitlab, /GitLab/)
  assert.ok(!gitlab.includes('GitHub'))
})

test('GitLab custom instances, nested groups and account caches remain independent', async () =>
  fixture(async (f: any) => {
    f.repositories['acme/pos'] = []
    f.repositories['acme/team/pos'] = [issue(1)]
    await f.connect()
    await f.select(['acme/team/pos'])
    await f.sync()
    const cloud = f.tables.user_gitlab_issues[0]
    await f.ask(`/tickets/${cloud.id}`, 'PATCH', { qaStatus: 'Passed' })
    assert.equal(cloud.html_url, 'https://gitlab.com/acme/team/pos/-/issues/1')
    assert.ok(f.provider.some((r: any) => r.url.includes('acme%2Fteam%2Fpos')))
    const connected = await f.ask('/connection', 'PUT', { token: TOKEN_A, baseUrl: 'https://gitlab.company.com/' })
    assert.equal(connected.status, 200)
    assert.equal(connected.body.baseUrl, 'https://gitlab.company.com')
    assert.equal(connected.body.repositories.length, 0)
    await f.select(['acme/team/pos'])
    await f.sync()
    const self = f.tables.user_gitlab_issues.find((i: any) => i.instance_url === 'https://gitlab.company.com')
    assert.equal(self.number, 1)
    assert.notEqual(self.id, cloud.id)
    assert.equal(self.qa_status, 'Not started')
    assert.equal((await f.ask(`/tickets/${cloud.id}`)).status, 404)
    assert.equal((await f.ask('/connection', 'PUT', { token: TOKEN_A, baseUrl: 'https://gitlab.com' })).status, 200)
    await f.select(['acme/team/pos'])
    assert.equal((await f.ask('/tickets')).body.items[0].qa_status, 'Passed')
  }))

test('GitLab URL and project validation rejects invalid inputs and local destinations', () => {
  for (const url of [
    'http://gitlab.com',
    'https://user:pass@gitlab.com',
    'https://127.0.0.1',
    'https://[::1]',
    'https://gitlab.local',
    'https://gitlab.com/api/v4',
    'https://gitlab.com?token=secret',
  ])
    assert.throws(() => gitlabBaseUrl(url))
  assert.equal(gitlabBaseUrl('https://gitlab.company.com/gitlab/'), 'https://gitlab.company.com/gitlab')
  assert.equal(gitlabRepositoryName('company/team/pos'), 'company/team/pos')
  for (const name of ['company/../pos', 'company//pos', 'https://gitlab.com/company/pos', 'company'])
    assert.throws(() => gitlabRepositoryName(name))
  for (const address of [
    '127.0.0.1',
    '10.0.0.1',
    '169.254.169.254',
    '192.168.1.1',
    '172.16.0.1',
    '::1',
    '::ffff:127.0.0.1',
    'fe80::1',
  ])
    assert.equal(gitlabPublicAddress(address), false)
  assert.equal(gitlabPublicAddress('8.8.8.8'), true)
})

test('GitLab provider errors do not echo tokens, redirects or unreadable pages', async () => {
  const token = TOKEN_A
  for (const status of [301, 403, 404, 500])
    await assert.rejects(
      () =>
        gitlabRequest(
          token,
          '/user',
          'https://gitlab.com',
          async () => new Response(JSON.stringify({ message: token }), { status }),
        ),
      (e: any) => !e.message.includes(token),
    )
  await assert.rejects(
    () => gitlabRequest(token, '/user', 'https://gitlab.com', async () => new Response('<html>login</html>')),
    /unreadable response/,
  )
})

test('tickets come from every project: created, assigned or commented on by me, and nothing else', async () =>
  fixture(async (f: any) => {
    f.repositories['acme/pos'] = [
      issue(1, { due_date: '2000-01-01', milestone: { title: 'Sprint 9' }, labels: ['bug', 'priority::high'] }),
      issue(2, { author: { username: 'dev' }, assignees: [{ username: 'dev' }] }),
      issue(3, { author: { username: 'dev' }, assignees: [{ username: 'dev' }] }),
    ]
    // Not chosen in settings, and still pulled: assigned to me.
    f.repositories['other/billing'] = [
      issue(7, {
        author: { username: 'dev' },
        assignees: [{ username: 'alice' }],
        due_date: '2999-12-31',
        weight: 3,
        time_stats: { time_estimate: 7200, total_time_spent: 5400 },
        task_completion_status: { count: 5, completed_count: 2 },
        confidential: true,
        merge_requests_count: 2,
        iteration: { title: 'Iteration 4' },
      }),
    ]
    // I commented on #2 only; #3 is someone else's and I never touched it.
    f.events.push(
      { project_id: f.projectId('acme/pos'), note: { noteable_type: 'Issue', noteable_iid: 2 } },
      { project_id: f.projectId('acme/pos'), note: { noteable_type: 'Issue', noteable_iid: 2 } },
      { project_id: f.projectId('acme/pos'), note: { noteable_type: 'MergeRequest', noteable_iid: 3 } },
    )
    await f.connect()
    await f.sync()
    const numbers = f.tables.user_gitlab_issues.map((i: any) => `${i.repository}#${i.number}`).sort()
    assert.deepEqual(numbers, ['acme/pos#1', 'acme/pos#2', 'other/billing#7'], 'no repository selection needed')
    const billing = f.tables.user_gitlab_issues.find((i: any) => i.number === 7)
    assert.equal(billing.html_url, 'https://gitlab.com/other/billing/-/issues/7')
    assert.equal(billing.due_date, '2999-12-31')
    assert.deepEqual(billing.details, {
      weight: 3,
      timeEstimate: 7200,
      timeSpent: 5400,
      tasksTotal: 5,
      tasksDone: 2,
      confidential: true,
      iteration: 'Iteration 4',
      mergeRequests: 2,
    })
    assert.equal(f.tables.user_gitlab_issues.find((i: any) => i.number === 2).commented_by_me, true)
    assert.equal((await f.ask('/tickets?view=commented')).body.total, 1)
    assert.equal((await f.ask('/tickets?view=assigned')).body.total, 2)
    assert.equal((await f.ask('/tickets?due=overdue&today=2026-11-15')).body.items[0].number, 1)
    assert.equal((await f.ask('/tickets?due=none')).body.total, 1)
    assert.equal((await f.ask('/tickets?due=set')).body.total, 2)
    assert.equal((await f.ask('/tickets?milestone=Sprint%209')).body.total, 1)
    assert.equal((await f.ask('/tickets?repository=other/billing')).body.total, 1)
    assert.equal((await f.ask('/tickets?due=soon')).status, 400)
    const facets = await f.ask('/tickets/facets')
    assert.deepEqual(facets.body.repositories, ['acme/pos', 'other/billing'])
    assert.deepEqual(facets.body.milestones, ['Sprint 9'])
    assert.deepEqual(facets.body.labels, ['bug', 'priority::high'])
    // A later sync keeps my comment flag, even though the issue lists don't include it.
    await f.sync()
    assert.equal(f.tables.user_gitlab_issues.find((i: any) => i.number === 2).commented_by_me, true)
    // Unassigned from #7 and never commented: it leaves my list.
    f.repositories['other/billing'][0].assignees = []
    await f.sync()
    assert.equal((await f.ask('/tickets?repository=other/billing')).body.total, 0)
    assert.ok(f.provider.every((r: any) => r.method === 'GET'))
  }))
