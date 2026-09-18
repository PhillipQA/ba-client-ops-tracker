import dotenv from 'dotenv'
import express from 'express'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import OpenAI from 'openai'
import Docxtemplater from 'docxtemplater'
import PizZip from 'pizzip'
import { PDFDocument, PDFTextField } from 'pdf-lib'
import { createClient } from '@supabase/supabase-js'
import { Client as DiscordClient, GatewayIntentBits, Partials } from 'discord.js'
import { createServer as createViteServer } from 'vite'

dotenv.config({ path: '.env.local' })
dotenv.config()

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = express()
const port = Number(process.env.PORT || 5173)

app.use(express.json({ limit: '24mb' }))

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

const ALL_MODULES = ['action', 'clients', 'projects', 'inbox', 'items', 'documents', 'reports', 'ai', 'settings']
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



type NormalizedSyncResult = {
  ready: boolean
  syncedAt?: string
  counts?: Record<string, number>
  error?: string
}

function cleanObject(value: any) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return value
}

function sanitizedAccountRaw(account: any) {
  const { passwordHash: _passwordHash, ...safe } = cleanObject(account)
  return safe
}

async function normalizedSchemaStatus(): Promise<NormalizedSyncResult> {
  if (!supabaseAdmin) return { ready: false, error: 'Supabase is not configured.' }
  const { error } = await supabaseAdmin.from('data_migration_runs').select('id').limit(1)
  if (error) return { ready: false, error: error.message }
  const { data: lastRun } = await supabaseAdmin.from('data_migration_runs').select('completed_at, counts').eq('status', 'completed').order('completed_at', { ascending: false }).limit(1).maybeSingle()
  return { ready: true, syncedAt: lastRun?.completed_at || undefined, counts: lastRun?.counts || undefined }
}

async function upsertAndSoftDelete(table: string, rows: any[]) {
  if (!supabaseAdmin) throw new Error('Supabase is not configured.')
  const now = new Date().toISOString()
  const normalizedRows = rows.map((row) => ({ ...row, deleted_at: null, updated_at: now }))
  if (normalizedRows.length) {
    const { error } = await supabaseAdmin.from(table).upsert(normalizedRows, { onConflict: 'id' })
    if (error) throw error
  }
  const { data: existing, error: existingError } = await supabaseAdmin.from(table).select('id, deleted_at')
  if (existingError) throw existingError
  const keep = new Set(normalizedRows.map((row) => String(row.id)))
  const missingIds = (existing || []).filter((row: any) => !keep.has(String(row.id)) && !row.deleted_at).map((row: any) => String(row.id))
  if (missingIds.length) {
    const { error } = await supabaseAdmin.from(table).update({ deleted_at: now, updated_at: now }).in('id', missingIds)
    if (error) throw error
  }
  return normalizedRows.length
}

function changedFields(before: any, after: any) {
  const keys = new Set([...Object.keys(cleanObject(before)), ...Object.keys(cleanObject(after))])
  return [...keys].filter((key) => stable(before?.[key]) !== stable(after?.[key]))
}

async function writeAuditEntries(current: any, next: any, actor: SessionUser | null, source = 'tracker') {
  if (!supabaseAdmin) return
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
        id: crypto.randomUUID(), entity_type: entityType, entity_id: id, action,
        changed_fields: changedFields(safeBefore, safeAfter), before_data: safeBefore, after_data: safeAfter,
        changed_by: actor?.id || null, changed_by_name: actor?.name || 'System', source,
      })
    }
  }
  if (entries.length) {
    const { error } = await supabaseAdmin.from('audit_logs').insert(entries)
    if (error) throw error
  }
}

async function syncNormalizedState(state: any, actor: SessionUser | null = null, reason = 'sync'): Promise<NormalizedSyncResult> {
  if (!supabaseAdmin) return { ready: false, error: 'Supabase is not configured.' }
  const status = await normalizedSchemaStatus()
  if (!status.ready) return status
  const source = state && typeof state === 'object' ? state : {}
  const clients = Array.isArray(source.clients) ? source.clients : []
  const projects = Array.isArray(source.projects) ? source.projects : []
  const items = Array.isArray(source.items) ? source.items : []
  const activities = Array.isArray(source.activity) ? source.activity : []
  const planner = Array.isArray(source.planner) ? source.planner : []
  const accounts = Array.isArray(source.accounts) ? source.accounts : []
  const statuses = Array.isArray(source.taskSettings?.statuses) ? source.taskSettings.statuses : defaultTaskSettings.statuses
  const tasks = items.filter((item: any) => item?.type !== 'Inquiry')
  const inquiries = items.filter((item: any) => item?.type === 'Inquiry')
  const startedAt = new Date().toISOString()
  const runId = crypto.randomUUID()
  await supabaseAdmin.from('data_migration_runs').insert({ id: runId, status: 'running', reason, started_at: startedAt, started_by: actor?.id || null })
  try {
    const counts: Record<string, number> = {}
    counts.clients = await upsertAndSoftDelete('clients', clients.map((row: any) => ({ id: String(row.id), name: row.name || '', contact: row.contact || '', email: row.email || '', status: row.status || '', health: row.health || '', notes: row.notes || '', raw_data: row })))
    counts.projects = await upsertAndSoftDelete('projects', projects.map((row: any) => ({ id: String(row.id), name: row.name || '', status: row.status || '', target_date: row.targetDate || null, summary: row.summary || '', raw_data: row })))
    counts.tasks = await upsertAndSoftDelete('tasks', tasks.map((row: any) => ({ id: String(row.id), client_id: row.clientId || null, project_id: row.projectId || null, parent_task_id: row.parentTaskId || null, subtask_order: Number.isFinite(row.subtaskOrder) ? row.subtaskOrder : null, title: row.title || '', type: row.type || 'Task', priority: row.priority || '', status: row.status || '', waiting_on: row.waitingOn || '', owner: row.owner || '', date_raised: row.dateRaised || null, due_date: row.dueDate || null, follow_up_date: row.followUpDate || null, description: row.description || '', resolution: row.resolution || '', resolved_date: row.resolvedDate || null, source: row.source || '', external_source_id: row.externalSourceId || null, source_sender: row.sourceSender || null, raw_data: row })))
    counts.inquiries = await upsertAndSoftDelete('inquiries', inquiries.map((row: any) => ({ id: String(row.id), client_id: row.clientId || null, project_id: row.projectId || null, title: row.title || '', priority: row.priority || '', status: row.status || '', waiting_on: row.waitingOn || '', owner: row.owner || '', date_raised: row.dateRaised || null, follow_up_date: row.followUpDate || null, description: row.description || '', resolution: row.resolution || '', resolved_date: row.resolvedDate || null, source: row.source || '', external_source_id: row.externalSourceId || null, source_sender: row.sourceSender || null, raw_data: row })))
    counts.activity_logs = await upsertAndSoftDelete('activity_logs', activities.map((row: any) => ({ id: String(row.id), client_id: row.clientId || null, project_id: row.projectId || null, activity_date: row.date || null, text: row.text || '', raw_data: row })))
    counts.planner_activities = await upsertAndSoftDelete('planner_activities', planner.map((row: any) => ({ id: String(row.id), client_id: row.clientId || null, project_id: row.projectId || null, title: row.title || '', activity_date: row.date || null, start_time: row.startTime || null, end_time: row.endTime || null, end_date: row.endDate || null, all_day: Boolean(row.allDay), source: row.source || '', status: row.status || '', notes: row.notes || '', calendar_event_id: row.calendarEventId || null, calendar_link: row.calendarLink || null, raw_data: row })))
    counts.app_users = await upsertAndSoftDelete('app_users', accounts.map((row: any) => ({ id: String(row.id), username: row.username || '', password_hash: row.passwordHash || '', name: row.name || '', email: row.email || '', phone: row.phone || '', role: row.role || '', modules: Array.isArray(row.modules) ? row.modules : [], status: row.status || '', created_on: row.createdAt || null, raw_data: sanitizedAccountRaw(row) })))
    counts.task_statuses = await upsertAndSoftDelete('task_statuses', statuses.map((row: any, index: number) => ({ id: String(row.id), label: row.label || '', is_completed: Boolean(row.closed), sort_order: index, raw_data: row })))
    counts.app_settings = await upsertAndSoftDelete('app_settings', [{ id: 'task-settings', setting_key: 'task_settings', value: source.taskSettings || defaultTaskSettings, raw_data: source.taskSettings || defaultTaskSettings }])
    const completedAt = new Date().toISOString()
    const { error: updateError } = await supabaseAdmin.from('data_migration_runs').update({ status: 'completed', completed_at: completedAt, counts }).eq('id', runId)
    if (updateError) throw updateError
    return { ready: true, syncedAt: completedAt, counts }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Normalized data sync failed.'
    try {
      await supabaseAdmin.from('data_migration_runs').update({ status: 'failed', completed_at: new Date().toISOString(), error: message }).eq('id', runId)
    } catch {
      // Keep the original sync error as the useful failure signal.
    }
    return { ready: true, error: message }
  }
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


app.get('/api/data-architecture/status', requireAuth, async (req, res) => {
  const user = (req as express.Request & { authUser: SessionUser }).authUser
  if (!moduleAllowed(user, 'settings')) return void res.status(403).json({ error: 'Settings access is required.' })
  try {
    const status = await normalizedSchemaStatus()
    res.json(status)
  } catch (error) {
    res.status(500).json({ ready: false, error: error instanceof Error ? error.message : 'Could not check normalized data architecture.' })
  }
})

app.post('/api/data-architecture/migrate', requireAuth, async (req, res) => {
  const user = (req as express.Request & { authUser: SessionUser }).authUser
  if (user.role !== 'Administrator') return void res.status(403).json({ error: 'Administrator access is required.' })
  try {
    const state = await loadTrackerState()
    if (!state.data) return void res.status(400).json({ error: 'There is no tracker state to migrate yet.' })
    const result = await syncNormalizedState(state.data, user, 'manual-migration')
    if (!result.ready) return void res.status(409).json(result)
    if (result.error) return void res.status(500).json(result)
    res.json(result)
  } catch (error) {
    res.status(500).json({ ready: false, error: error instanceof Error ? error.message : 'Migration failed.' })
  }
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

    // Keep the normalized Supabase tables in sync for reporting, recovery, and future migration.
    // This is best-effort so the legacy tracker_state remains the compatibility fallback.
    try {
      const normalized = await normalizedSchemaStatus()
      if (normalized.ready) {
        await writeAuditEntries(current, next, user, 'tracker-save')
        const normalizedResult = await syncNormalizedState(next, user, 'tracker-save')
        if (normalizedResult.error) console.warn('Normalized Supabase sync warning:', normalizedResult.error)
      }
    } catch (normalizedError) {
      console.warn('Normalized Supabase sync skipped:', normalizedError)
    }

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



function documentAccessAllowed(user: SessionUser) {
  return user.role !== 'Viewer' && moduleAllowed(user, 'documents')
}

function safeDocumentBase64(value: unknown, maxBytes: number) {
  const raw = typeof value === 'string' ? value.replace(/^data:[^;]+;base64,/, '') : ''
  if (!raw || !/^[A-Za-z0-9+/=\r\n]+$/.test(raw)) throw new Error('The uploaded file data is invalid.')
  const estimatedBytes = Math.floor(raw.replace(/\s/g, '').length * 3 / 4)
  if (estimatedBytes > maxBytes) throw new Error(`The uploaded file is too large. Maximum size is ${Math.round(maxBytes / 1024 / 1024)} MB.`)
  return raw.replace(/\s/g, '')
}

function safeTemplateValue(value: unknown) {
  if (value === null || value === undefined) return ''
  return String(value).slice(0, 10000)
}

function normalizeTemplateValues(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {} as Record<string, string>
  const output: Record<string, string> = {}
  for (const [rawKey, rawValue] of Object.entries(value as Record<string, unknown>)) {
    const key = rawKey.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/^_+|_+$/g, '')
    if (!key) continue
    output[key] = safeTemplateValue(rawValue)
  }
  return output
}

function safeOutputName(businessName: string, extension: string) {
  const base = businessName.trim().replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 70) || 'Company'
  return `DRF-${base}.${extension}`
}

function findDocxTemplateFields(zip: any) {
  const fields = new Set<string>()
  for (const [name, file] of Object.entries(zip.files || {}) as [string, any][]) {
    if (!name.startsWith('word/') || !name.endsWith('.xml') || file.dir) continue
    const xml = file.asText()
    for (const match of xml.matchAll(/\{([a-zA-Z0-9_]+)\}/g)) fields.add(match[1])
  }
  return [...fields]
}

function drfText(value: Record<string, string>, key: string) {
  return safeTemplateValue(value[key]).trim()
}

function splitDrfText(input: string, preferredFirstLine = 58) {
  const text = String(input || '').replace(/\s+/g, ' ').trim()
  if (!text || text.length <= preferredFirstLine) return [text, '']
  let breakAt = text.lastIndexOf(' ', preferredFirstLine)
  if (breakAt < Math.floor(preferredFirstLine * 0.55)) breakAt = text.indexOf(' ', preferredFirstLine)
  if (breakAt < 0) breakAt = preferredFirstLine
  return [text.slice(0, breakAt).trim(), text.slice(breakAt).trim()]
}

function signatoryLabel(value: string, fallback: string) {
  const text = String(value || fallback).trim() || fallback
  return text.endsWith(':') ? text : `${text}:`
}

function signatoryInstruction(title: string, fallback: string) {
  const value = String(title || '').trim()
  return value ? `(${value}) Signature Over Printed Name & Date` : fallback
}

function escapeXmlText(value: string) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function xlsxHasCell(sheetXml: string, cellRef: string) {
  const pattern = new RegExp(`<c\\b[^>]*\\br="${cellRef}"(?:\\s|>|/)`)
  return pattern.test(sheetXml)
}

function setXlsxCellText(sheetXml: string, cellRef: string, value: string) {
  const pattern = new RegExp(`<c\\b([^>]*\\br="${cellRef}"[^>]*?)(?:\\s*/>|>[\\s\\S]*?<\\/c>)`)
  const match = sheetXml.match(pattern)
  if (!match) throw new Error(`The DRF template is missing expected cell ${cellRef}.`)
  let attributes = match[1].replace(/\s+t="[^"]*"/g, '').replace(/\/\s*$/, '')
  const replacement = `<c${attributes} t="inlineStr"><is><t xml:space="preserve">${escapeXmlText(value)}</t></is></c>`
  return sheetXml.replace(pattern, replacement)
}

function renderIrippleDrfExcel(source: Buffer, values: Record<string, string>, rawRows: unknown) {
  const zip = new PizZip(source)
  const worksheetPath = 'xl/worksheets/sheet1.xml'
  const worksheetFile = zip.file(worksheetPath)
  if (!worksheetFile) throw new Error('The Excel template does not contain the expected first DRF worksheet.')
  let sheetXml = worksheetFile.asText()

  for (const ref of ['B3', 'B4', 'B5', 'B6', 'B7', 'B8', 'H3', 'H4', 'H5', 'H7', 'H8', 'B9', 'B10', 'B11', 'B12', 'B13', 'A16', 'D32', 'A39', 'A40', 'A41', 'D39', 'D40', 'D41', 'H39', 'H40', 'H41']) {
    if (!xlsxHasCell(sheetXml, ref)) throw new Error(`This Excel file does not match the mapped iRipple DRF template. Expected cell ${ref} was not found.`)
  }

  const requestDate = drfText(values, 'request_date') || new Date().toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' })
  const [address1, address2] = splitDrfText(drfText(values, 'address'), 62)
  const [notes1, notes2] = splitDrfText(drfText(values, 'notes'), 46)
  const assignments: [string, string, string][] = [
    ['B3', 'business_name', drfText(values, 'business_name')],
    ['B4', 'branch_name', drfText(values, 'branch_name')],
    ['B5', 'trade_name', drfText(values, 'trade_name')],
    ['B6', 'tin', drfText(values, 'tin')],
    ['B7', 'address', address1],
    ['B8', 'address', address2],
    ['H3', 'request_date', requestDate],
    ['H4', 'go_live_date', drfText(values, 'go_live_date') || 'TBA'],
    ['H5', 'contract_number', drfText(values, 'contract_number')],
    ['H7', 'notes', notes1],
    ['H8', 'notes', notes2],
    ['B9', 'request_for', drfText(values, 'request_for') || 'POS PERMIT APPLICATION ONLY'],
    ['B10', 'dongle', drfText(values, 'dongle') || 'n/a'],
    ['B11', 'license_for', drfText(values, 'license_for')],
    ['B12', 'request_note', drfText(values, 'request_note')],
    ['B13', 'pos_setup', drfText(values, 'pos_setup') || 'STANDALONE'],
    ['A39', 'signatory_1_label', signatoryLabel(drfText(values, 'signatory_1_label'), 'Prepared By')],
    ['A40', 'signatory_1_name', drfText(values, 'signatory_1_name')],
    ['A41', 'signatory_1_title', signatoryInstruction(drfText(values, 'signatory_1_title'), 'Signature Over Printed Name & Date')],
    ['D39', 'signatory_2_label', signatoryLabel(drfText(values, 'signatory_2_label'), 'Authorized By')],
    ['D40', 'signatory_2_name', drfText(values, 'signatory_2_name')],
    ['D41', 'signatory_2_title', signatoryInstruction(drfText(values, 'signatory_2_title'), '(Account Manager) Signature Over Printed Name & Date')],
    ['H39', 'signatory_3_label', signatoryLabel(drfText(values, 'signatory_3_label'), 'Approved By')],
    ['H40', 'signatory_3_name', drfText(values, 'signatory_3_name')],
    ['H41', 'signatory_3_title', signatoryInstruction(drfText(values, 'signatory_3_title'), '(Accounting Head) Signature Over Printed Name & Date')],
  ]

  const matchedFields = new Set<string>()
  for (const [cell, key, value] of assignments) {
    sheetXml = setXlsxCellText(sheetXml, cell, value)
    matchedFields.add(key)
  }

  for (let row = 16; row <= 32; row += 1) {
    for (const column of ['A', 'B', 'C', 'D']) sheetXml = setXlsxCellText(sheetXml, `${column}${row}`, '')
  }

  const rows = Array.isArray(rawRows) ? rawRows.slice(0, 17) : []
  const normalizedRows = rows.map((row: any) => ({
    computerName: String(row?.computerName || '').trim().toUpperCase().slice(0, 12),
    serialNo: String(row?.serialNo || '').trim().slice(0, 180),
    brand: String(row?.brand || '').trim().slice(0, 120),
    model: String(row?.model || '').trim().slice(0, 120),
  })).filter((row: any) => row.computerName || row.serialNo || row.brand || row.model)

  normalizedRows.forEach((row: any, index: number) => {
    const excelRow = 16 + index
    sheetXml = setXlsxCellText(sheetXml, `A${excelRow}`, row.computerName)
    sheetXml = setXlsxCellText(sheetXml, `B${excelRow}`, row.serialNo)
    sheetXml = setXlsxCellText(sheetXml, `C${excelRow}`, row.brand)
    sheetXml = setXlsxCellText(sheetXml, `D${excelRow}`, row.model)
  })

  zip.file(worksheetPath, sheetXml)
  return {
    output: zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' }) as Buffer,
    matchedFields: [...matchedFields],
    posRowsWritten: normalizedRows.length,
  }
}

app.post('/api/documents/drf/extract-cor', requireAuth, async (req, res) => {
  const user = (req as express.Request & { authUser: SessionUser }).authUser
  if (!documentAccessAllowed(user)) return void res.status(403).json({ error: 'Document Creation access with write permission is required.' })
  res.status(410).json({ error: 'COR extraction now runs privately in the browser. Refresh the app and use Extract COR details locally.' })
})

app.post('/api/documents/drf/render-template', requireAuth, async (req, res) => {
  const user = (req as express.Request & { authUser: SessionUser }).authUser
  if (!documentAccessAllowed(user)) return void res.status(403).json({ error: 'Document Creation access with write permission is required.' })

  try {
    const templateName = String(req.body?.templateName || 'drf-template').slice(0, 180)
    const templateData = safeDocumentBase64(req.body?.templateData, 12 * 1024 * 1024)
    const values = normalizeTemplateValues(req.body?.values)
    const extension = templateName.split('.').pop()?.toLowerCase() || ''
    const source = Buffer.from(templateData, 'base64')
    let output: Buffer
    let mimeType = 'application/octet-stream'
    let matchedFields: string[] = []

    let posRowsWritten = 0

    if (extension === 'xlsx') {
      const rendered = renderIrippleDrfExcel(source, values, req.body?.posRows)
      output = rendered.output
      matchedFields = rendered.matchedFields
      posRowsWritten = rendered.posRowsWritten
      mimeType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    } else if (extension === 'docx') {
      const zip = new PizZip(source)
      const templateFields = findDocxTemplateFields(zip)
      const doc = new Docxtemplater(zip, {
        paragraphLoop: true,
        linebreaks: true,
        nullGetter: () => '',
      })
      doc.render(values)
      output = doc.getZip().generate({ type: 'nodebuffer', compression: 'DEFLATE' })
      matchedFields = templateFields.filter((field) => Object.prototype.hasOwnProperty.call(values, field))
      mimeType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    } else if (extension === 'pdf') {
      const pdf = await PDFDocument.load(source)
      const form = pdf.getForm()
      const fields = form.getFields()
      for (const field of fields) {
        const fieldName = field.getName()
        const normalizedName = fieldName.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/^_+|_+$/g, '')
        if (!Object.prototype.hasOwnProperty.call(values, normalizedName)) continue
        if (field instanceof PDFTextField) {
          field.setText(values[normalizedName])
          matchedFields.push(normalizedName)
        }
      }
      if (!matchedFields.length) throw new Error('No matching fillable PDF fields were found. Use PDF form field names such as business_name, trade_name, tin, address, or use a DOCX template with placeholders.')
      output = Buffer.from(await pdf.save())
      mimeType = 'application/pdf'
    } else if (['txt', 'html', 'htm', 'md', 'rtf'].includes(extension)) {
      let text = source.toString('utf8')
      const found = new Set<string>()
      text = text.replace(/\{\{?([a-zA-Z0-9_]+)\}?\}/g, (full, key) => {
        const normalized = String(key).toLowerCase()
        if (!Object.prototype.hasOwnProperty.call(values, normalized)) return full
        found.add(normalized)
        return values[normalized]
      })
      matchedFields = [...found]
      output = Buffer.from(text, 'utf8')
      mimeType = extension === 'html' || extension === 'htm' ? 'text/html' : extension === 'rtf' ? 'application/rtf' : 'text/plain'
    } else {
      throw new Error('Unsupported DRF template format. Use the approved XLSX DRF template. Legacy DOCX, fillable PDF, TXT, HTML, MD, and RTF templates are also supported.')
    }

    const outputName = safeOutputName(values.business_name || values.trade_name || '', extension || 'docx')
    res.json({ fileData: output.toString('base64'), fileName: outputName, mimeType, matchedFields, posRowsWritten })
  } catch (error) {
    console.error('DRF template generation failed:', error)
    res.status(500).json({ error: error instanceof Error ? error.message : 'DRF template generation failed.' })
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
  try {
    const normalized = await normalizedSchemaStatus()
    if (normalized.ready) {
      await writeAuditEntries(base, nextState, null, 'discord')
      const normalizedResult = await syncNormalizedState(nextState, null, 'discord-capture')
      if (normalizedResult.error) console.warn('Normalized Discord sync warning:', normalizedResult.error)
    }
  } catch (normalizedError) {
    console.warn('Normalized Discord sync skipped:', normalizedError)
  }
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


const TASK_EVIDENCE_BUCKET = 'task-evidence'
const TASK_EVIDENCE_MAX_BYTES = 10 * 1024 * 1024
const TASK_EVIDENCE_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/bmp',
  'application/pdf',
  'text/plain',
  'text/csv',
  'application/zip',
  'application/x-zip-compressed',
  'application/msword',
  'application/vnd.ms-excel',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
])
let taskEvidenceBucketReady = false

function taskEvidenceWriteAllowed(user: SessionUser) {
  return user.role !== 'Viewer' && moduleAllowed(user, 'items')
}

function taskEvidenceReadAllowed(user: SessionUser) {
  return moduleAllowed(user, 'items')
}

function safeEvidenceFileName(value: unknown) {
  const source = typeof value === 'string' ? value.trim() : ''
  const fileName = source.split(/[\\/]/).pop() || 'evidence-file'
  return fileName.replace(/[<>:"|?*\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').slice(0, 140) || 'evidence-file'
}

function normalizedEvidenceMimeType(rawMimeType: unknown, fileName: string) {
  const mimeType = String(rawMimeType || '').trim().toLowerCase()
  if (TASK_EVIDENCE_MIME_TYPES.has(mimeType)) return mimeType
  const extension = fileName.toLowerCase().split('.').pop() || ''
  const byExtension: Record<string, string> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp',
    pdf: 'application/pdf', txt: 'text/plain', csv: 'text/csv', zip: 'application/zip',
    doc: 'application/msword', xls: 'application/vnd.ms-excel', ppt: 'application/vnd.ms-powerpoint',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  }
  return byExtension[extension] || mimeType || 'application/octet-stream'
}

function evidenceBase64(value: unknown) {
  const raw = typeof value === 'string' ? value.replace(/^data:[^;]+;base64,/, '').replace(/\s/g, '') : ''
  if (!raw || !/^[A-Za-z0-9+/=]+$/.test(raw)) throw new Error('The evidence file data is invalid.')
  const buffer = Buffer.from(raw, 'base64')
  if (!buffer.length) throw new Error('The evidence file is empty.')
  if (buffer.length > TASK_EVIDENCE_MAX_BYTES) throw new Error('Evidence files must be 10 MB or smaller.')
  return buffer
}

async function ensureTaskEvidenceBucket() {
  if (!supabaseAdmin) throw new Error('Supabase is not configured.')
  if (taskEvidenceBucketReady) return
  const { data: buckets, error: listError } = await supabaseAdmin.storage.listBuckets()
  if (listError) throw listError
  if (!(buckets || []).some((bucket: any) => bucket.id === TASK_EVIDENCE_BUCKET || bucket.name === TASK_EVIDENCE_BUCKET)) {
    const { error: createError } = await supabaseAdmin.storage.createBucket(TASK_EVIDENCE_BUCKET, {
      public: false,
      fileSizeLimit: TASK_EVIDENCE_MAX_BYTES,
      allowedMimeTypes: [...TASK_EVIDENCE_MIME_TYPES],
    })
    if (createError) throw createError
  }
  taskEvidenceBucketReady = true
}

async function saveEvidenceState(current: any, next: any, actor: SessionUser, source: string) {
  if (!supabaseAdmin) throw new Error('Supabase is not configured.')
  const { data: saved, error } = await supabaseAdmin.from('tracker_state').upsert({ id: 'main', data: next }, { onConflict: 'id' }).select('updated_at').single()
  if (error) throw error
  try {
    const normalized = await normalizedSchemaStatus()
    if (normalized.ready) {
      await writeAuditEntries(current, next, actor, source)
      const normalizedResult = await syncNormalizedState(next, actor, source)
      if (normalizedResult.error) console.warn('Task evidence normalized sync warning:', normalizedResult.error)
    }
  } catch (normalizedError) {
    console.warn('Task evidence normalized sync skipped:', normalizedError)
  }
  return saved?.updated_at as string | undefined
}

app.post('/api/tasks/:taskId/evidence', requireAuth, async (req, res) => {
  const user = (req as express.Request & { authUser: SessionUser }).authUser
  if (!taskEvidenceWriteAllowed(user)) return void res.status(403).json({ error: 'Task edit access is required to upload evidence.' })
  if (!supabaseAdmin) return void res.status(503).json({ error: 'Supabase is not configured.' })

  const taskId = String(req.params.taskId || '')
  const fileName = safeEvidenceFileName(req.body?.fileName)
  const mimeType = normalizedEvidenceMimeType(req.body?.mimeType, fileName)
  if (!TASK_EVIDENCE_MIME_TYPES.has(mimeType)) return void res.status(400).json({ error: 'This evidence file type is not supported.' })

  let fileBuffer: Buffer
  try {
    fileBuffer = evidenceBase64(req.body?.dataBase64)
  } catch (error) {
    return void res.status(400).json({ error: error instanceof Error ? error.message : 'The evidence file is invalid.' })
  }

  try {
    const state = await loadTrackerState()
    const current = state.data && typeof state.data === 'object' ? state.data : null
    if (!current) return void res.status(404).json({ error: 'Tracker data is not available.' })
    const items = Array.isArray(current.items) ? current.items : []
    const task = items.find((candidate: any) => String(candidate?.id || '') === taskId)
    if (!task) return void res.status(404).json({ error: 'Subtask was not found.' })
    if (!task.parentTaskId) return void res.status(400).json({ error: 'Evidence uploads are currently available for subtasks only.' })

    await ensureTaskEvidenceBucket()
    const evidenceId = randomUUID()
    const storagePath = `subtasks/${taskId}/${evidenceId}-${fileName}`
    const { error: uploadError } = await supabaseAdmin.storage.from(TASK_EVIDENCE_BUCKET).upload(storagePath, fileBuffer, {
      contentType: mimeType,
      cacheControl: '3600',
      upsert: false,
    })
    if (uploadError) throw uploadError

    const evidence = {
      id: evidenceId,
      fileName,
      mimeType,
      fileSize: fileBuffer.length,
      storagePath,
      uploadedAt: new Date().toISOString(),
      uploadedBy: user.id,
      uploadedByName: user.name || user.username,
      kind: mimeType.startsWith('image/') ? 'Screenshot' : 'File',
    }
    const updatedTask = { ...task, evidence: [...(Array.isArray(task.evidence) ? task.evidence : []), evidence] }
    const activity = {
      id: randomUUID(),
      clientId: task.clientId || undefined,
      projectId: task.projectId || undefined,
      date: new Date().toISOString().slice(0, 10),
      text: `Attached evidence to subtask "${task.title}": ${fileName}`,
    }
    const next = {
      ...current,
      items: items.map((candidate: any) => String(candidate?.id || '') === taskId ? updatedTask : candidate),
      activity: [activity, ...(Array.isArray(current.activity) ? current.activity : [])],
    }

    try {
      const updatedAt = await saveEvidenceState(current, next, user, 'task-evidence-upload')
      res.json({ item: updatedTask, activity, updatedAt })
    } catch (saveError) {
      await supabaseAdmin.storage.from(TASK_EVIDENCE_BUCKET).remove([storagePath]).catch(() => undefined)
      throw saveError
    }
  } catch (error) {
    console.error('Task evidence upload failed:', error)
    res.status(500).json({ error: error instanceof Error ? error.message : 'Task evidence upload failed.' })
  }
})

app.delete('/api/tasks/:taskId/evidence/:evidenceId', requireAuth, async (req, res) => {
  const user = (req as express.Request & { authUser: SessionUser }).authUser
  if (!taskEvidenceWriteAllowed(user)) return void res.status(403).json({ error: 'Task edit access is required to remove evidence.' })
  if (!supabaseAdmin) return void res.status(503).json({ error: 'Supabase is not configured.' })

  try {
    const taskId = String(req.params.taskId || '')
    const evidenceId = String(req.params.evidenceId || '')
    const state = await loadTrackerState()
    const current = state.data && typeof state.data === 'object' ? state.data : null
    if (!current) return void res.status(404).json({ error: 'Tracker data is not available.' })
    const items = Array.isArray(current.items) ? current.items : []
    const task = items.find((candidate: any) => String(candidate?.id || '') === taskId)
    if (!task || !task.parentTaskId) return void res.status(404).json({ error: 'Subtask was not found.' })
    const evidence = (Array.isArray(task.evidence) ? task.evidence : []).find((entry: any) => String(entry?.id || '') === evidenceId)
    if (!evidence) return void res.status(404).json({ error: 'Evidence was not found.' })

    await ensureTaskEvidenceBucket()
    const updatedTask = { ...task, evidence: (Array.isArray(task.evidence) ? task.evidence : []).filter((entry: any) => String(entry?.id || '') !== evidenceId) }
    const activity = {
      id: randomUUID(),
      clientId: task.clientId || undefined,
      projectId: task.projectId || undefined,
      date: new Date().toISOString().slice(0, 10),
      text: `Removed evidence from subtask "${task.title}": ${evidence.fileName || 'file'}`,
    }
    const next = {
      ...current,
      items: items.map((candidate: any) => String(candidate?.id || '') === taskId ? updatedTask : candidate),
      activity: [activity, ...(Array.isArray(current.activity) ? current.activity : [])],
    }
    const updatedAt = await saveEvidenceState(current, next, user, 'task-evidence-delete')
    const { error: removeError } = await supabaseAdmin.storage.from(TASK_EVIDENCE_BUCKET).remove([String(evidence.storagePath || '')])
    if (removeError) console.warn('Task evidence storage cleanup warning:', removeError.message)
    res.json({ item: updatedTask, activity, updatedAt })
  } catch (error) {
    console.error('Task evidence delete failed:', error)
    res.status(500).json({ error: error instanceof Error ? error.message : 'Task evidence delete failed.' })
  }
})

app.get('/api/tasks/:taskId/evidence/:evidenceId', requireAuth, async (req, res) => {
  const user = (req as express.Request & { authUser: SessionUser }).authUser
  if (!taskEvidenceReadAllowed(user)) return void res.status(403).json({ error: 'Task access is required to view evidence.' })
  if (!supabaseAdmin) return void res.status(503).json({ error: 'Supabase is not configured.' })

  try {
    const taskId = String(req.params.taskId || '')
    const evidenceId = String(req.params.evidenceId || '')
    const state = await loadTrackerState()
    const items = Array.isArray(state.data?.items) ? state.data.items : []
    const task = items.find((candidate: any) => String(candidate?.id || '') === taskId)
    if (!task || !task.parentTaskId) return void res.status(404).json({ error: 'Subtask was not found.' })
    const evidence = (Array.isArray(task.evidence) ? task.evidence : []).find((entry: any) => String(entry?.id || '') === evidenceId)
    if (!evidence?.storagePath) return void res.status(404).json({ error: 'Evidence was not found.' })

    await ensureTaskEvidenceBucket()
    const { data, error } = await supabaseAdmin.storage.from(TASK_EVIDENCE_BUCKET).download(String(evidence.storagePath))
    if (error || !data) throw error || new Error('Evidence could not be downloaded.')
    const buffer = Buffer.from(await data.arrayBuffer())
    const mimeType = String(evidence.mimeType || 'application/octet-stream')
    const inline = mimeType.startsWith('image/') || mimeType === 'application/pdf'
    const encodedName = encodeURIComponent(String(evidence.fileName || 'evidence-file')).replace(/'/g, '%27')
    res.setHeader('Content-Type', mimeType)
    res.setHeader('Content-Length', String(buffer.length))
    res.setHeader('Cache-Control', 'private, no-store')
    res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodedName}`)
    res.send(buffer)
  } catch (error) {
    console.error('Task evidence download failed:', error)
    res.status(500).json({ error: error instanceof Error ? error.message : 'Task evidence download failed.' })
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
