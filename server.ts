import dotenv from 'dotenv'
import express from 'express'
import { createHash, randomBytes } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import OpenAI from 'openai'
import { createClient } from '@supabase/supabase-js'
import { Client as DiscordClient, GatewayIntentBits, Partials } from 'discord.js'
import { createServer as createViteServer } from 'vite'

dotenv.config({ path: '.env.local' })
dotenv.config()

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = express()
const port = Number(process.env.PORT || 5173)

app.use(express.json({ limit: '2mb' }))

const supabaseUrl = process.env.SUPABASE_URL
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
const supabaseAdmin = supabaseUrl && supabaseServiceRoleKey
  ? createClient(supabaseUrl, supabaseServiceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } })
  : null

const discordToken = process.env.DISCORD_BOT_TOKEN?.trim() || ''
const discordAllowedUserIds = new Set((process.env.DISCORD_ALLOWED_USER_IDS || '').split(',').map((value) => value.trim()).filter(Boolean))
const discordClient = discordToken ? new DiscordClient({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.DirectMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel],
}) : null
const discordRuntime = {
  configured: Boolean(discordToken),
  online: false,
  botName: '',
  guildCount: 0,
  lastEventAt: '',
  lastEventKind: '',
  lastEventUserId: '',
  lastMessageAt: '',
  lastError: '',
}

const ALL_MODULES = ['action', 'clients', 'projects', 'inbox', 'items', 'reports', 'ai', 'settings']
const ADMIN_PASSWORD_HASH = '8c6976e5b5410415bde908bd4dee15dfb167a9c873fc4bb8a81f6f2ab448a918'
const defaultAdmin = {
  id: 'admin', username: 'Admin', passwordHash: ADMIN_PASSWORD_HASH, name: 'Administrator', email: '', phone: '', role: 'Administrator',
  modules: ALL_MODULES, status: 'Active', createdAt: '2026-09-17',
}

const defaultTaskSettings = {
  statuses: [
    { id: 'open', label: 'Open', closed: false },
    { id: 'in-progress', label: 'In Progress', closed: false },
    { id: 'blocked', label: 'Blocked', closed: false },
    { id: 'resolved', label: 'Resolved', closed: true },
    { id: 'closed', label: 'Closed', closed: true },
  ],
  visibleColumns: ['status', 'client', 'project', 'type', 'waitingOn', 'priority', 'owner', 'dueDate', 'followUpDate'],
}

function openTaskStatus(state: any) {
  const statuses = Array.isArray(state?.taskSettings?.statuses) ? state.taskSettings.statuses : defaultTaskSettings.statuses
  return String(statuses.find((status: any) => !status?.closed)?.label || 'Open')
}

type SessionUser = Omit<typeof defaultAdmin, 'passwordHash' | 'createdAt'> & { createdAt?: string }
const sessions = new Map<string, SessionUser>()

function passwordHash(value: string) {
  return createHash('sha256').update(value).digest('hex')
}

function safeUser(account: any): SessionUser {
  return {
    id: String(account.id),
    username: String(account.username || ''),
    name: String(account.name || account.username || 'User'),
    email: String(account.email || ''),
    phone: String(account.phone || ''),
    role: account.role === 'Administrator' || account.role === 'Viewer' ? account.role : 'Contributor',
    modules: account.role === 'Administrator' ? [...ALL_MODULES] : Array.isArray(account.modules) ? account.modules.filter((value: unknown) => ALL_MODULES.includes(String(value))) : [],
    status: account.status === 'Disabled' ? 'Disabled' : 'Active',
    createdAt: account.createdAt ? String(account.createdAt) : undefined,
  }
}

function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map((part) => part.trim()).filter(Boolean).map((part) => {
    const index = part.indexOf('=')
    return index < 0 ? [part, ''] : [part.slice(0, index), decodeURIComponent(part.slice(index + 1))]
  }))
}

function sessionFromRequest(req: express.Request) {
  const token = parseCookies(req.headers.cookie || '').ba_session
  return token ? { token, user: sessions.get(token) ?? null } : { token: '', user: null }
}

function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  const { user } = sessionFromRequest(req)
  if (!user || user.status !== 'Active') {
    res.status(401).json({ error: 'Please sign in.' })
    return
  }
  ;(req as express.Request & { authUser?: SessionUser }).authUser = user
  next()
}

async function loadTrackerState() {
  if (!supabaseAdmin) return { configured: false, data: null as any, updatedAt: undefined as string | undefined }
  const { data, error } = await supabaseAdmin.from('tracker_state').select('data, updated_at').eq('id', 'main').maybeSingle()
  if (error) throw error
  return { configured: true, data: data?.data ?? null, updatedAt: data?.updated_at as string | undefined }
}

function isLegacyStore(data: any) {
  return !data || typeof data !== 'object' || Number(data.schemaVersion || 0) < 3
}

app.get('/api/auth/session', (req, res) => {
  const { user } = sessionFromRequest(req)
  if (!user || user.status !== 'Active') {
    res.status(401).json({ user: null })
    return
  }
  res.json({ user })
})

app.post('/api/auth/login', async (req, res) => {
  const username = typeof req.body?.username === 'string' ? req.body.username.trim() : ''
  const password = typeof req.body?.password === 'string' ? req.body.password : ''
  if (!username || !password) {
    res.status(400).json({ error: 'Username and password are required.' })
    return
  }

  try {
    const state = await loadTrackerState()
    const accounts = Array.isArray(state.data?.accounts) ? state.data.accounts : []
    let account = accounts.find((candidate: any) => String(candidate.username || '').toLowerCase() === username.toLowerCase())

    // Upgrade path from the earlier demo build and local-only first setup.
    if (!account && username.toLowerCase() === 'admin' && passwordHash(password) === ADMIN_PASSWORD_HASH && (!state.configured || isLegacyStore(state.data) || accounts.length === 0)) {
      account = defaultAdmin
    }

    if (!account || account.status === 'Disabled' || !account.passwordHash || passwordHash(password) !== String(account.passwordHash)) {
      res.status(401).json({ error: 'Invalid username or password.' })
      return
    }

    const user = safeUser(account)
    const token = randomBytes(32).toString('hex')
    sessions.set(token, user)
    res.setHeader('Set-Cookie', `ba_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`)
    res.json({ user, cloudConfigured: state.configured })
  } catch (error) {
    console.error('Login failed:', error)
    res.status(500).json({ error: error instanceof Error ? error.message : 'Login failed.' })
  }
})

app.post('/api/auth/logout', requireAuth, (req, res) => {
  const { token } = sessionFromRequest(req)
  if (token) sessions.delete(token)
  res.setHeader('Set-Cookie', 'ba_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0')
  res.json({ ok: true })
})

app.get('/api/store', requireAuth, async (_req, res) => {
  if (!supabaseAdmin) {
    res.status(503).json({ configured: false, data: null, error: 'Supabase is not configured.' })
    return
  }
  try {
    const state = await loadTrackerState()
    res.json({ configured: true, data: state.data, updatedAt: state.updatedAt })
  } catch (error) {
    console.error('Supabase load failed:', error)
    res.status(500).json({ configured: true, error: error instanceof Error ? error.message : 'Cloud database load failed.' })
  }
})

function stable(value: unknown) { return JSON.stringify(value) }

function accountChangesAreSelfOnly(currentAccounts: any[], nextAccounts: any[], userId: string) {
  if (currentAccounts.length !== nextAccounts.length) return false
  const currentMap = new Map(currentAccounts.map((account) => [String(account.id), account]))
  for (const next of nextAccounts) {
    const current = currentMap.get(String(next.id))
    if (!current) return false
    if (String(next.id) !== userId) {
      if (stable(current) !== stable(next)) return false
      continue
    }
    const allowed = ['name', 'email', 'phone', 'passwordHash']
    const keys = new Set([...Object.keys(current), ...Object.keys(next)])
    for (const key of keys) {
      if (allowed.includes(key)) continue
      if (stable(current[key]) !== stable(next[key])) return false
    }
  }
  return true
}

function moduleAllowed(user: SessionUser, module: string) {
  return user.role === 'Administrator' || user.modules.includes(module)
}

app.put('/api/store', requireAuth, async (req, res) => {
  if (!supabaseAdmin) {
    res.status(503).json({ configured: false, error: 'Supabase is not configured.' })
    return
  }
  let next = req.body?.data
  if (!next || typeof next !== 'object' || Array.isArray(next)) {
    res.status(400).json({ configured: true, error: 'A tracker data object is required.' })
    return
  }

  const user = (req as express.Request & { authUser: SessionUser }).authUser
  try {
    const currentState = await loadTrackerState()
    const current = currentState.data && typeof currentState.data === 'object' ? currentState.data : { schemaVersion: 3, clients: [], projects: [], items: [], activity: [], planner: [], accounts: [defaultAdmin], taskSettings: defaultTaskSettings }

    // Protect externally captured Discord inquiries from being erased by a browser tab
    // that loaded before the bot received them. Existing IDs remain fully editable.
    const currentItems = Array.isArray(current.items) ? current.items : []
    const nextItems = Array.isArray(next.items) ? next.items : []
    const nextIds = new Set(nextItems.map((item: any) => String(item?.id || '')))
    const missingDiscordItems = currentItems.filter((item: any) => item?.source === 'Discord' && item?.externalSourceId && !nextIds.has(String(item.id || '')))
    if (missingDiscordItems.length) next = { ...next, items: [...missingDiscordItems, ...nextItems] }

    const currentAccounts = Array.isArray(current.accounts) ? current.accounts : []
    const nextAccounts = Array.isArray(next.accounts) ? next.accounts : []
    const accountsChanged = stable(currentAccounts) !== stable(nextAccounts)
    const selfOnlyAccounts = accountsChanged && accountChangesAreSelfOnly(currentAccounts, nextAccounts, user.id)

    if (user.role === 'Viewer') {
      const operationalUnchanged = ['clients', 'projects', 'items', 'activity', 'planner'].every((key) => stable(current[key] ?? []) === stable(next[key] ?? []))
        && stable(current.taskSettings ?? defaultTaskSettings) === stable(next.taskSettings ?? defaultTaskSettings)
      if (!operationalUnchanged || (accountsChanged && !selfOnlyAccounts)) {
        res.status(403).json({ configured: true, error: 'Viewer accounts are read-only except for their own profile.' })
        return
      }
    }

    if (user.role === 'Contributor') {
      if (accountsChanged && !selfOnlyAccounts) {
        res.status(403).json({ configured: true, error: 'Only Administrators can manage other accounts.' })
        return
      }
      if (stable(current.taskSettings ?? defaultTaskSettings) !== stable(next.taskSettings ?? defaultTaskSettings)) return void res.status(403).json({ configured: true, error: 'Only Administrators can change task configuration.' })
      if (stable(current.clients ?? []) !== stable(next.clients ?? []) && !moduleAllowed(user, 'clients')) return void res.status(403).json({ configured: true, error: 'Client module access is required.' })
      if (stable(current.projects ?? []) !== stable(next.projects ?? []) && !moduleAllowed(user, 'projects')) return void res.status(403).json({ configured: true, error: 'Project module access is required.' })
      if (stable(current.items ?? []) !== stable(next.items ?? []) && !moduleAllowed(user, 'items') && !moduleAllowed(user, 'inbox')) return void res.status(403).json({ configured: true, error: 'Task module access is required.' })
      if (stable(current.planner ?? []) !== stable(next.planner ?? []) && !moduleAllowed(user, 'action')) return void res.status(403).json({ configured: true, error: 'Action Center access is required.' })
    }

    const { data: saved, error } = await supabaseAdmin
      .from('tracker_state')
      .upsert({ id: 'main', data: next }, { onConflict: 'id' })
      .select('updated_at')
      .single()
    if (error) throw error

    // Apply account/permission changes immediately to active sessions on this server process.
    if (user.role === 'Administrator' && accountsChanged) {
      for (const [token, sessionUser] of sessions.entries()) {
        const account = nextAccounts.find((candidate: any) => String(candidate.id) === sessionUser.id)
        if (!account || account.status === 'Disabled') sessions.delete(token)
        else sessions.set(token, safeUser(account))
      }
    } else if (selfOnlyAccounts) {
      const own = nextAccounts.find((candidate: any) => String(candidate.id) === user.id)
      if (own) {
        for (const [token, sessionUser] of sessions.entries()) if (sessionUser.id === user.id) sessions.set(token, safeUser(own))
      }
    }

    res.json({ configured: true, saved: true, updatedAt: saved.updated_at })
  } catch (error) {
    console.error('Supabase save failed:', error)
    res.status(500).json({ configured: true, error: error instanceof Error ? error.message : 'Cloud database save failed.' })
  }
})

const allowedKinds = new Set(['issue', 'requirement', 'follow_up', 'activity', 'draft_reply'])
const allowedPriorities = new Set(['Low', 'Medium', 'High', 'Urgent'])
const allowedWaiting = new Set(['Me', 'Developer', 'Client', 'QA', 'Design'])

function sanitizeSuggestions(value: unknown) {
  if (!Array.isArray(value)) return []
  return value.slice(0, 5).flatMap((raw) => {
    if (!raw || typeof raw !== 'object') return []
    const item = raw as Record<string, unknown>
    if (!allowedKinds.has(String(item.kind)) || !String(item.title || '').trim()) return []
    return [{
      id: String(item.id || crypto.randomUUID()),
      kind: String(item.kind),
      title: String(item.title).slice(0, 180),
      rationale: String(item.rationale || '').slice(0, 600),
      description: item.description ? String(item.description).slice(0, 1200) : undefined,
      priority: allowedPriorities.has(String(item.priority)) ? String(item.priority) : undefined,
      waitingOn: allowedWaiting.has(String(item.waitingOn)) ? String(item.waitingOn) : undefined,
      followUpDate: /^\d{4}-\d{2}-\d{2}$/.test(String(item.followUpDate || '')) ? String(item.followUpDate) : undefined,
      activityDate: /^\d{4}-\d{2}-\d{2}$/.test(String(item.activityDate || '')) ? String(item.activityDate) : undefined,
      activityTime: /^\d{2}:\d{2}$/.test(String(item.activityTime || '')) ? String(item.activityTime) : undefined,
      draft: item.draft ? String(item.draft).slice(0, 3000) : undefined,
    }]
  })
}

function parseModelJson(text: string) {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  try { return JSON.parse(cleaned) as Record<string, unknown> } catch {
    const start = cleaned.indexOf('{')
    const end = cleaned.lastIndexOf('}')
    if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>
    throw new Error('The model did not return valid JSON.')
  }
}

app.post('/api/assistant', requireAuth, async (req, res) => {
  const user = (req as express.Request & { authUser: SessionUser }).authUser
  if (user.role === 'Viewer' || !moduleAllowed(user, 'ai')) {
    res.status(403).json({ error: 'Your account does not have access to the AI BA Assistant.' })
    return
  }

  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) {
    res.status(503).json({ error: 'AI is not configured yet. Add OPENAI_API_KEY to .env.local and restart the app.' })
    return
  }

  const message = typeof req.body?.message === 'string' ? req.body.message.trim() : ''
  if (!message) {
    res.status(400).json({ error: 'Message is required.' })
    return
  }

  const client = new OpenAI({ apiKey })
  const model = process.env.OPENAI_MODEL || 'gpt-5.6-terra'
  const today = new Date().toISOString().slice(0, 10)
  const context = req.body?.context ?? {}
  const history = Array.isArray(req.body?.history) ? req.body.history.slice(-8) : []

  const instructions = `You are an embedded Business Analyst assistant inside a client operations tracker.
Your job is to assess messy client input and help the BA organize work without making decisions silently.
Be concise, practical, and evidence-aware. Distinguish what is known from what needs confirmation.
Never claim a ticket, activity, email, or requirement was created or sent. You only propose actions for the human to approve.
Today is ${today}.

Return JSON only with this shape:
{
  "message": "your assessment in readable plain text, using short paragraphs or bullets",
  "suggestions": [
    {
      "id": "short-id",
      "kind": "issue | requirement | follow_up | activity | draft_reply",
      "title": "short action title",
      "rationale": "why this is suggested",
      "description": "optional record detail",
      "priority": "Low | Medium | High | Urgent",
      "waitingOn": "Me | Developer | Client | QA | Design",
      "followUpDate": "YYYY-MM-DD when useful",
      "activityDate": "YYYY-MM-DD when useful",
      "activityTime": "HH:MM when useful",
      "draft": "only for draft_reply"
    }
  ]
}
Use at most 5 suggestions. Do not invent client commitments or technical facts. If the input is ambiguous, suggest a clarification or follow-up instead of pretending it is a defect.`

  try {
    const response = await client.responses.create({
      model,
      instructions,
      input: `TRACKER CONTEXT:\n${JSON.stringify(context, null, 2)}\n\nRECENT CHAT:\n${JSON.stringify(history, null, 2)}\n\nUSER MESSAGE:\n${message}`,
      reasoning: { effort: 'low' },
    })
    const parsed = parseModelJson(response.output_text)
    const responseMessage = String(parsed.message || '').trim()
    if (!responseMessage) throw new Error('The model returned no assessment.')
    res.json({ message: responseMessage, suggestions: sanitizeSuggestions(parsed.suggestions) })
  } catch (error) {
    console.error(error)
    res.status(500).json({ error: error instanceof Error ? error.message : 'AI assistant request failed.' })
  }
})


function normalizeDiscordContent(content: string) {
  if (!discordClient?.user) return content.trim()
  return content
    .replace(new RegExp(`<@!?${discordClient.user.id}>`, 'g'), '')
    .replace(/\s+/g, ' ')
    .trim()
}

function findNamedContext(text: string, clients: any[], projects: any[]) {
  const q = text.toLowerCase()
  const client = [...clients].filter((candidate) => candidate?.name && q.includes(String(candidate.name).toLowerCase())).sort((a, b) => String(b.name).length - String(a.name).length)[0]
  const project = [...projects].filter((candidate) => candidate?.name && q.includes(String(candidate.name).toLowerCase())).sort((a, b) => String(b.name).length - String(a.name).length)[0]
  return { clientId: String(client?.id || ''), projectId: String(project?.id || '') }
}

async function assessDiscordInquiry(messageText: string, sender: string, state: any) {
  const clients = Array.isArray(state?.clients) ? state.clients : []
  const projects = Array.isArray(state?.projects) ? state.projects : []
  const named = findNamedContext(messageText, clients, projects)
  const fallbackTitle = messageText.replace(/\s+/g, ' ').trim().slice(0, 110) || 'Discord inquiry'
  const fallback = {
    title: fallbackTitle,
    summary: messageText.trim(),
    priority: 'Medium',
    waitingOn: 'Me',
    followUpDate: '',
    clientId: named.clientId,
    projectId: named.projectId,
  }

  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) return fallback

  const client = new OpenAI({ apiKey })
  const model = process.env.OPENAI_MODEL || 'gpt-5.6-terra'
  const today = new Date().toISOString().slice(0, 10)
  const clientContext = clients.map((item: any) => ({ id: String(item.id), name: String(item.name) }))
  const projectContext = projects.map((item: any) => ({ id: String(item.id), name: String(item.name) }))
  const instructions = `You convert a Business Analyst's Discord capture into one clean Inquiry record. Today is ${today}.
Return JSON only:
{
  "title": "concise inquiry title under 110 chars",
  "summary": "clean short summary preserving important facts and questions",
  "priority": "Low | Medium | High | Urgent",
  "waitingOn": "Me | Developer | Client | QA | Design",
  "followUpDate": "YYYY-MM-DD or empty",
  "clientId": "an ID from the supplied clients or empty",
  "projectId": "an ID from the supplied projects or empty"
}
Do not invent commitments, dates, defects, client names, or projects. Only choose a client/project when the message clearly identifies it. If the user says follow up tomorrow/Friday, resolve that to a date. This is capture/organization, not final classification: the record remains an Inquiry.`
  try {
    const response = await client.responses.create({
      model,
      instructions,
      input: `SENDER: ${sender}\nCLIENTS: ${JSON.stringify(clientContext)}\nPROJECTS: ${JSON.stringify(projectContext)}\nMESSAGE: ${messageText}`,
      reasoning: { effort: 'low' },
    })
    const parsed = parseModelJson(response.output_text)
    const validClientIds = new Set(clientContext.map((item: any) => item.id))
    const validProjectIds = new Set(projectContext.map((item: any) => item.id))
    const projectId = validProjectIds.has(String(parsed.projectId || '')) ? String(parsed.projectId) : fallback.projectId
    const parsedClientId = validClientIds.has(String(parsed.clientId || '')) ? String(parsed.clientId) : ''
    const clientId = parsedClientId || fallback.clientId
    const priority = allowedPriorities.has(String(parsed.priority)) ? String(parsed.priority) : fallback.priority
    const waitingOn = allowedWaiting.has(String(parsed.waitingOn)) ? String(parsed.waitingOn) : fallback.waitingOn
    const followUpDate = /^\d{4}-\d{2}-\d{2}$/.test(String(parsed.followUpDate || '')) ? String(parsed.followUpDate) : ''
    return {
      title: String(parsed.title || fallback.title).trim().slice(0, 110),
      summary: String(parsed.summary || fallback.summary).trim().slice(0, 1800),
      priority,
      waitingOn,
      followUpDate,
      clientId,
      projectId,
    }
  } catch (error) {
    console.error('Discord AI assessment failed; using basic capture:', error)
    return fallback
  }
}

async function captureDiscordInquiry(discordMessage: any) {
  if (!supabaseAdmin) throw new Error('Supabase is not configured; Discord capture requires persistent cloud storage.')
  const text = normalizeDiscordContent(String(discordMessage.content || ''))
  if (!text) return { created: false, reason: 'empty' }

  const externalSourceId = `discord:${discordMessage.id}`
  const stateResult = await loadTrackerState()
  const base = stateResult.data && typeof stateResult.data === 'object'
    ? stateResult.data
    : { schemaVersion: 3, clients: [], projects: [], items: [], activity: [], planner: [], accounts: [defaultAdmin], taskSettings: defaultTaskSettings }
  const items = Array.isArray(base.items) ? base.items : []
  const existing = items.find((item: any) => item?.externalSourceId === externalSourceId)
  if (existing) return { created: false, reason: 'duplicate', item: existing }

  const sender = discordMessage.member?.displayName || discordMessage.author?.globalName || discordMessage.author?.username || 'Discord user'
  const senderTag = discordMessage.author?.username ? `@${discordMessage.author.username}` : ''
  const assessed = await assessDiscordInquiry(text, sender, base)
  const today = new Date().toISOString().slice(0, 10)
  const item = {
    id: crypto.randomUUID(),
    clientId: assessed.clientId,
    projectId: assessed.projectId,
    title: assessed.title,
    type: 'Inquiry',
    priority: assessed.priority,
    status: openTaskStatus(base),
    waitingOn: assessed.waitingOn,
    owner: 'Me',
    dateRaised: today,
    dueDate: '',
    followUpDate: assessed.followUpDate,
    description: `${assessed.summary}\n\nDiscord sender: ${sender}${senderTag ? ` (${senderTag})` : ''}\nOriginal: ${text}`,
    resolution: '',
    source: 'Discord',
    externalSourceId,
    sourceSender: `${sender}${senderTag ? ` (${senderTag})` : ''}`,
  }
  const activity = Array.isArray(base.activity) ? base.activity : []
  const nextState = {
    ...base,
    items: [item, ...items],
    activity: [{ id: crypto.randomUUID(), clientId: item.clientId, projectId: item.projectId, date: today, text: `Discord inquiry captured: ${item.title}` }, ...activity],
  }
  const { error } = await supabaseAdmin.from('tracker_state').upsert({ id: 'main', data: nextState }, { onConflict: 'id' })
  if (error) throw error
  return { created: true, item, clients: base.clients || [], projects: base.projects || [] }
}

function discordStatusPayload() {
  return {
    configured: discordRuntime.configured,
    online: discordRuntime.online,
    botName: discordRuntime.botName,
    guildCount: discordRuntime.guildCount,
    allowedUsersConfigured: discordAllowedUserIds.size,
    lastEventAt: discordRuntime.lastEventAt,
    lastEventKind: discordRuntime.lastEventKind,
    lastEventUserId: discordRuntime.lastEventUserId,
    lastMessageAt: discordRuntime.lastMessageAt,
    lastError: discordRuntime.lastError,
    dmCapture: true,
    mentionCapture: true,
  }
}

app.get('/api/integrations/discord/status', requireAuth, (req, res) => {
  const user = (req as express.Request & { authUser: SessionUser }).authUser
  if (!moduleAllowed(user, 'settings')) return void res.status(403).json({ error: 'Settings access is required.' })
  res.json(discordStatusPayload())
})

app.get('/api/integrations/discord/inquiries', requireAuth, async (req, res) => {
  const user = (req as express.Request & { authUser: SessionUser }).authUser
  if (!moduleAllowed(user, 'inbox') && !moduleAllowed(user, 'items')) {
    res.status(403).json({ error: 'Inbox or Task module access is required.' })
    return
  }
  if (!supabaseAdmin) {
    res.status(503).json({ configured: false, items: [], error: 'Supabase is not configured.' })
    return
  }
  try {
    const state = await loadTrackerState()
    const items = Array.isArray(state.data?.items) ? state.data.items : []
    const discordInquiries = items.filter((item: any) => item?.type === 'Inquiry' && item?.source === 'Discord' && item?.externalSourceId)
    res.json({ configured: true, items: discordInquiries, updatedAt: state.updatedAt })
  } catch (error) {
    console.error('Discord inquiry sync failed:', error)
    res.status(500).json({ configured: true, items: [], error: error instanceof Error ? error.message : 'Discord inquiry sync failed.' })
  }
})

async function startDiscordBot() {
  if (!discordClient || !discordToken) {
    console.log('Discord Inquiry Capture: not configured (DISCORD_BOT_TOKEN is empty).')
    return
  }

  discordClient.once('ready', (client) => {
    discordRuntime.online = true
    discordRuntime.botName = client.user.tag || client.user.username
    discordRuntime.guildCount = client.guilds.cache.size
    discordRuntime.lastError = ''
    console.log(`Discord Inquiry Capture online as ${discordRuntime.botName}`)
  })

  discordClient.on('guildCreate', () => { discordRuntime.guildCount = discordClient.guilds.cache.size })
  discordClient.on('guildDelete', () => { discordRuntime.guildCount = discordClient.guilds.cache.size })
  discordClient.on('error', (error) => {
    discordRuntime.lastError = error.message
    console.error('Discord client error:', error)
  })
  discordClient.on('shardError', (error) => {
    discordRuntime.lastError = error.message
    console.error('Discord gateway error:', error)
  })
  discordClient.on('messageCreate', async (message) => {
    if (message.author.bot || !discordClient.user) return
    const isDm = !message.guildId
    const mentionsBot = Boolean(message.guildId && message.mentions.users.has(discordClient.user.id))
    if (!isDm && !mentionsBot) return

    discordRuntime.lastEventAt = new Date().toISOString()
    discordRuntime.lastEventKind = isDm ? 'DM' : 'Mention'
    discordRuntime.lastEventUserId = message.author.id
    console.log(`Discord message received: kind=${discordRuntime.lastEventKind} author=${message.author.id} contentLength=${String(message.content || '').length}`)

    if (discordAllowedUserIds.size && !discordAllowedUserIds.has(message.author.id)) {
      console.warn(`Discord capture rejected unauthorized user ${message.author.id}`)
      if (isDm) await message.reply('This Discord account is not authorized for BA Tracker inquiry capture.').catch(() => undefined)
      return
    }

    const normalizedText = normalizeDiscordContent(String(message.content || ''))
    if (!normalizedText) {
      discordRuntime.lastError = 'Discord message event received, but the text content was empty.'
      console.warn(discordRuntime.lastError)
      await message.reply({ content: '⚠️ I received your message, but I could not read any text from it. Please send a plain-text message and try again.', allowedMentions: { repliedUser: false } }).catch(() => undefined)
      return
    }

    try {
      const result: any = await captureDiscordInquiry(message)
      if (!result.created) {
        if (result.reason === 'duplicate') await message.reply({ content: '✅ This message is already in the BA Tracker.', allowedMentions: { repliedUser: false } }).catch(() => undefined)
        return
      }
      discordRuntime.lastMessageAt = new Date().toISOString()
      const item = result.item
      const clientName = result.clients.find((client: any) => String(client.id) === String(item.clientId))?.name || 'Unassigned'
      const projectName = result.projects.find((project: any) => String(project.id) === String(item.projectId))?.name || 'No project'
      const baseUrl = (process.env.APP_BASE_URL || '').replace(/\/$/, '')
      const lines = [
        '✅ **Inquiry added to BA Tracker**',
        `**${item.title}**`,
        `Client: ${clientName}${projectName !== 'No project' ? ` · ${projectName}` : ''}`,
        `Priority: ${item.priority} · Waiting on: ${item.waitingOn}`,
        item.followUpDate ? `Follow-up: ${item.followUpDate}` : '',
        baseUrl ? `${baseUrl}` : '',
      ].filter(Boolean)
      await message.reply({ content: lines.join('\n').slice(0, 1900), allowedMentions: { repliedUser: false } })
    } catch (error) {
      const messageText = error instanceof Error ? error.message : 'Discord inquiry capture failed.'
      discordRuntime.lastError = messageText
      console.error('Discord inquiry capture failed:', error)
      await message.reply({ content: `⚠️ I could not add that inquiry: ${messageText}`.slice(0, 1900), allowedMentions: { repliedUser: false } }).catch(() => undefined)
    }
  })

  try {
    await discordClient.login(discordToken)
  } catch (error) {
    discordRuntime.online = false
    discordRuntime.lastError = error instanceof Error ? error.message : 'Discord login failed.'
    console.error('Discord bot login failed:', error)
  }
}

const isProduction = process.env.NODE_ENV === 'production' || process.argv.includes('--production')

if (!isProduction) {
  const vite = await createViteServer({ server: { middlewareMode: true }, appType: 'spa' })
  app.use(vite.middlewares)
} else {
  const dist = path.join(__dirname, 'dist')
  app.use(express.static(dist))
  app.get('*', (_req, res) => res.sendFile(path.join(dist, 'index.html')))
}

app.listen(port, () => {
  console.log(`BA Client Ops Tracker running on http://localhost:${port}`)
  void startDiscordBot()
})

process.on('SIGTERM', () => {
  if (discordClient) discordClient.destroy()
})
