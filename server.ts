import dotenv from 'dotenv'
import express from 'express'
import rateLimit from 'express-rate-limit'
import bcrypt from 'bcryptjs'
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import OpenAI from 'openai'
import { requirePlatformAdmin } from './platform-auth'
import { registerPlatformSettings } from './platform-settings'
import { createIntegrationStore, registerIntegrationRoutes, encryptionKey, IntegrationError } from './tenant-integrations'
import Docxtemplater from 'docxtemplater'
import PizZip from 'pizzip'
import { PDFDocument, PDFTextField } from 'pdf-lib'
import { createClient } from '@supabase/supabase-js'
import { Client as DiscordClient, GatewayIntentBits, Partials } from 'discord.js'
import { createServer as createViteServer } from 'vite'
import { normalizeAppTheme } from './src/theme'
import { recoveryMailer, recoveryMessage, recoveryUnavailable, validRecoveryEmail } from './password-recovery-email'

dotenv.config({ path: '.env.local' })
dotenv.config()

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = express()
const port = Number(process.env.PORT || 5173)
const isProduction = process.env.NODE_ENV === 'production' || process.argv.includes('--production')

// Render and similar hosts terminate TLS at a trusted reverse proxy.
app.set('trust proxy', 1)

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many failed login attempts. Please try again in 15 minutes.' },
})

app.use(express.json({ limit: '24mb' }))

const recoveryRequestLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 5, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many recovery requests. Please try again in 15 minutes.' },
})
const recoverySubmitLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many attempts. Please try again in 15 minutes.' },
})
const sendRecoveryEmail = recoveryMailer()
app.use('/api/auth', (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next() })

const supabaseUrl = process.env.SUPABASE_URL
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
const supabaseAdmin = supabaseUrl && supabaseServiceRoleKey
  ? createClient(supabaseUrl, supabaseServiceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } })
  : null

const integrations = createIntegrationStore(supabaseAdmin)
type DiscordRuntime = { client: DiscordClient; revision: string; online: boolean; botName: string; guildCount: number; lastMessageAt: string; lastError: string }
const discordRuntimes = new Map<string, DiscordRuntime>()
const discordReconnections = new Map<string, Promise<void>>()
const discordCaptures = new Map<string, Promise<any>>()
const discordUserWindows = new Map<string, { startedAt: number; count: number }>()
function discordUserRateLimited(userId: string) {
  const now = Date.now()
  const current = discordUserWindows.get(userId)
  if (!current || now - current.startedAt >= 60_000) {
    discordUserWindows.set(userId, { startedAt: now, count: 1 }); return false
  }
  return ++current.count > 10
}

const ALL_MODULES = ['action', 'clients', 'projects', 'inbox', 'items', 'documents', 'reports', 'ai', 'settings']
const BXI_CORE_ORG_ID = '00000000-0000-0000-0000-000000000001'
const BXI_CORE_ORG_NAME = 'BXI-Core'
const BXI_CORE_ORG_SLUG = 'bxi-core'
const INTERNAL_ADMIN_ACCOUNT_KEY = 'internal_admin'
const INTERNAL_ADMIN_USER_ID = '00000000-0000-0000-0000-000000000100'
const PASSWORD_BOOTSTRAP_MARKER = '__BOOTSTRAP_REQUIRED__'
const BCRYPT_ROUNDS = 12
const internalAdminBootstrapPassword = process.env.INTERNAL_ADMIN_BOOTSTRAP_PASSWORD || ''
const bxiCoreBootstrapPassword = process.env.BXI_CORE_BOOTSTRAP_PASSWORD || ''
const defaultAdmin = {
  id: 'admin', username: 'Admin', passwordHash: '', name: 'Administrator', email: '', phone: '', role: 'Administrator',
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

type SessionUser = Omit<typeof defaultAdmin, 'passwordHash' | 'createdAt'> & {
  createdAt?: string
  organizationId?: string
  organizationName?: string
  organizationSlug?: string
  organizationModules?: string[]
  isPlatformAdmin?: boolean
  accountType?: 'tenant' | 'platform'
  accountKey?: string
  mustChangePassword?: boolean
  lastLoginAt?: string
}

type OrganizationInfo = {
  id: string
  name: string
  slug: string
  status: 'Active' | 'Suspended'
  enabledModules: string[]
}
const sessions = new Map<string, SessionUser>()

// Legacy SHA-256 digest retained only for backward-compatible verification and
// as the browser-to-server pre-hash used by the existing Settings UI. Passwords
// stored by the server are bcrypt hashes of this digest.
function passwordHash(value: string) {
  return createHash('sha256').update(value).digest('hex')
}

function isBcryptHash(value: unknown) {
  return /^\$2[aby]\$/.test(String(value || ''))
}

function isLegacyDigest(value: unknown) {
  return /^[a-f0-9]{64}$/i.test(String(value || ''))
}

function safeEqualText(left: string, right: string) {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

async function secureHashDigest(digest: string) {
  return bcrypt.hash(digest, BCRYPT_ROUNDS)
}

async function secureHashPassword(plaintext: string) {
  return secureHashDigest(passwordHash(plaintext))
}

async function verifyPassword(plaintext: string, storedHash: unknown) {
  const stored = String(storedHash || '')
  if (!stored || stored === PASSWORD_BOOTSTRAP_MARKER) return false
  const digest = passwordHash(plaintext)
  if (isBcryptHash(stored)) return bcrypt.compare(digest, stored)
  return isLegacyDigest(stored) && safeEqualText(digest.toLowerCase(), stored.toLowerCase())
}

function bootstrapPasswordUsable(value: string) {
  return value.length >= 12 && !['admin', 'password', 'changeme'].includes(value.toLowerCase())
}

function sessionCookie(token: string, maxAge: number) {
  return `ba_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${isProduction ? '; Secure' : ''}`
}

function sanitizeStateForClient(state: any) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return state
  return {
    ...state,
    accounts: Array.isArray(state.accounts)
      ? state.accounts.map((account: any) => ({ ...account, passwordHash: '' }))
      : state.accounts,
  }
}

function safeUser(account: any, organization?: OrganizationInfo | null): SessionUser {
  const role = account.role === 'Administrator' || account.role === 'Viewer' ? account.role : 'Contributor'
  const organizationModules = organization?.enabledModules?.filter((value) => ALL_MODULES.includes(String(value))) || [...ALL_MODULES]
  const accountModules = Array.isArray(account.modules) ? account.modules.filter((value: unknown) => ALL_MODULES.includes(String(value))) : []
  const modules = role === 'Administrator' ? [...organizationModules] : accountModules.filter((value: string) => organizationModules.includes(value))
  return {
    id: String(account.id),
    username: String(account.username || ''),
    name: String(account.name || account.username || 'User'),
    email: String(account.email || ''),
    phone: String(account.phone || ''),
    role,
    modules,
    status: account.status === 'Disabled' ? 'Disabled' : 'Active',
    createdAt: account.createdAt || account.created_on ? String(account.createdAt || account.created_on) : undefined,
    organizationId: organization?.id || (account.organization_id ? String(account.organization_id) : undefined),
    organizationName: organization?.name,
    organizationSlug: organization?.slug,
    organizationModules,
    isPlatformAdmin: false,
    accountType: 'tenant',
    accountKey: organization?.slug || BXI_CORE_ORG_SLUG,
    lastLoginAt: account.last_login_at ? String(account.last_login_at) : account.lastLoginAt ? String(account.lastLoginAt) : undefined,
  }
}

function safePlatformUser(account: any): SessionUser {
  return {
    id: String(account.id || INTERNAL_ADMIN_USER_ID),
    username: String(account.username || 'admin'),
    name: String(account.name || 'Internal Administrator'),
    email: String(account.email || ''),
    phone: String(account.phone || ''),
    role: 'Administrator',
    modules: [],
    status: account.status === 'Disabled' ? 'Disabled' : 'Active',
    isPlatformAdmin: true,
    accountType: 'platform',
    accountKey: String(account.account_key || INTERNAL_ADMIN_ACCOUNT_KEY),
    mustChangePassword: Boolean(account.must_change_password),
    lastLoginAt: account.last_login_at ? String(account.last_login_at) : undefined,
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

async function loadLegacyTrackerState() {
  if (!supabaseAdmin) return { configured: false, data: null as any, updatedAt: undefined as string | undefined }
  const { data, error } = await supabaseAdmin.from('tracker_state').select('data, updated_at').eq('id', 'main').maybeSingle()
  if (error) throw error
  return { configured: true, data: data?.data ?? null, updatedAt: data?.updated_at as string | undefined }
}

async function multiTenantSchemaReady() {
  if (!supabaseAdmin) return false
  const { error } = await supabaseAdmin.from('organizations').select('id').limit(1)
  return !error
}

async function platformAuthSchemaReady() {
  if (!supabaseAdmin) return false
  const { error } = await supabaseAdmin.from('platform_users').select('id').limit(1)
  return !error
}

function normalizeOrganization(row: any): OrganizationInfo {
  return {
    id: String(row?.id || ''),
    name: String(row?.name || 'Workspace'),
    slug: String(row?.slug || ''),
    status: row?.status === 'Suspended' ? 'Suspended' : 'Active',
    enabledModules: Array.isArray(row?.enabled_modules) ? row.enabled_modules.filter((value: unknown) => ALL_MODULES.includes(String(value))).map(String) : [...ALL_MODULES],
  }
}

async function organizationById(id?: string | null) {
  if (!supabaseAdmin || !id) return null
  const { data, error } = await supabaseAdmin.from('organizations').select('id,name,slug,status,enabled_modules').eq('id', id).is('deleted_at', null).maybeSingle()
  if (error) return null
  return data ? normalizeOrganization(data) : null
}

async function organizationBySlug(slug: string) {
  if (!supabaseAdmin) return null
  const { data, error } = await supabaseAdmin.from('organizations').select('id,name,slug,status,enabled_modules').eq('slug', slug).is('deleted_at', null).maybeSingle()
  if (error) return null
  return data ? normalizeOrganization(data) : null
}

async function organizationByLoginKey(account: string) {
  if (!supabaseAdmin) return null
  const raw = account.trim()
  const slug = cleanSlug(raw)
  if (slug) {
    const { data, error } = await supabaseAdmin.from('organizations').select('id,name,slug,status,enabled_modules').ilike('slug', slug).is('deleted_at', null).maybeSingle()
    if (!error && data) return normalizeOrganization(data)
  }
  const { data, error } = await supabaseAdmin.from('organizations').select('id,name,slug,status,enabled_modules').ilike('name', raw).is('deleted_at', null).limit(1).maybeSingle()
  if (error) return null
  return data ? normalizeOrganization(data) : null
}

async function loadTenantState(organizationId?: string | null) {
  if (!supabaseAdmin) return { configured: false, data: null as any, updatedAt: undefined as string | undefined }
  // A known tenant must never fall back to the original workspace after a DB error.
  if (organizationId) {
    const { data, error } = await supabaseAdmin.from('tenant_state').select('data, updated_at').eq('organization_id', organizationId).maybeSingle()
    if (error) throw error
    // Recover accounts missing from older/fresh snapshots without replacing operational data.
    // app_users is the authentication authority; passwords never come from the browser.
    const { data: users, error: usersError } = await supabaseAdmin.from('app_users').select('*').eq('organization_id', organizationId).is('deleted_at', null)
    if (usersError) throw usersError
    const snapshot = data?.data && typeof data.data === 'object' ? data.data : emptyTenantData()
    const accounts = Array.isArray(snapshot.accounts) ? snapshot.accounts : []
    const knownIds = new Set(accounts.map((account: any) => String(account.id)))
    const recovered = (users || []).filter((user: any) => !knownIds.has(String(user.id))).map(accountFromDatabase)
    return { configured: true, data: { ...snapshot, accounts: [...accounts, ...recovered] }, updatedAt: data?.updated_at as string | undefined }
  }
  return loadLegacyTrackerState()
}

async function saveTenantState(organizationId: string | undefined, data: any) {
  const saved = await commitTenantState(organizationId, data, null, 'account-snapshot', undefined, false)
  return saved.syncedAt
}

function accountFromDatabase(row: any) {
  return {
    id: String(row.id), username: String(row.username || ''), passwordHash: String(row.password_hash || ''),
    name: String(row.name || row.username || ''), email: String(row.email || ''), phone: String(row.phone || ''),
    role: row.role || 'Contributor', modules: Array.isArray(row.modules) ? row.modules : [], status: row.status || 'Active',
    createdAt: String(row.created_on || new Date().toISOString().slice(0, 10)), theme: normalizeAppTheme(row.raw_data?.theme),
  }
}

function tenantIdForUser(user: SessionUser | null | undefined) {
  if (!user || user.accountType === 'platform') return undefined
  return user.organizationId || BXI_CORE_ORG_ID
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

async function normalizedSchemaStatus(organizationId?: string): Promise<NormalizedSyncResult> {
  if (!supabaseAdmin) return { ready: false, error: 'Supabase is not configured.' }
  const { error } = await supabaseAdmin.from('data_migration_runs').select('id').limit(1)
  if (error) return { ready: false, error: error.message }
  let query = supabaseAdmin.from('data_migration_runs').select('completed_at, counts').eq('status', 'completed').order('completed_at', { ascending: false }).limit(1)
  if (organizationId && await multiTenantSchemaReady()) query = query.eq('organization_id', organizationId)
  const { data: lastRun } = await query.maybeSingle()
  return { ready: true, syncedAt: lastRun?.completed_at || undefined, counts: lastRun?.counts || undefined }
}

function changedFields(before: any, after: any) {
  const keys = new Set([...Object.keys(cleanObject(before)), ...Object.keys(cleanObject(after))])
  return [...keys].filter((key) => stable(before?.[key]) !== stable(after?.[key]))
}

function auditEntriesForChanges(current: any, next: any, actor: SessionUser | null, source = 'tracker', organizationId?: string) {
  const tenantReady = Boolean(organizationId)
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
        id: crypto.randomUUID(), ...(tenantReady ? { organization_id: organizationId } : {}), entity_type: entityType, entity_id: id, action,
        changed_fields: changedFields(safeBefore, safeAfter), before_data: safeBefore, after_data: safeAfter,
        changed_by: actor?.id || null, changed_by_name: actor?.name || 'System', source,
      })
    }
  }
  return entries
}

function normalizedRecords(state: any, organizationId: string) {
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
  const tenantReady = true
  return {
    clients: clients.map((row: any) => ({ id: String(row.id), name: row.name || '', contact: row.contact || '', email: row.email || '', status: row.status || '', health: row.health || '', notes: row.notes || '', raw_data: row })),
    projects: projects.map((row: any) => ({ id: String(row.id), name: row.name || '', status: row.status || '', target_date: row.targetDate || null, summary: row.summary || '', raw_data: row })),
    tasks: tasks.map((row: any) => ({ id: String(row.id), client_id: row.clientId || null, project_id: row.projectId || null, parent_task_id: row.parentTaskId || null, subtask_order: Number.isFinite(row.subtaskOrder) ? row.subtaskOrder : null, title: row.title || '', type: row.type || 'Task', priority: row.priority || '', status: row.status || '', waiting_on: row.waitingOn || '', owner: row.owner || '', date_raised: row.dateRaised || null, due_date: row.dueDate || null, follow_up_date: row.followUpDate || null, description: row.description || '', resolution: row.resolution || '', resolved_date: row.resolvedDate || null, source: row.source || '', external_source_id: row.externalSourceId || null, source_sender: row.sourceSender || null, raw_data: row })),
    inquiries: inquiries.map((row: any) => ({ id: String(row.id), client_id: row.clientId || null, project_id: row.projectId || null, title: row.title || '', priority: row.priority || '', status: row.status || '', waiting_on: row.waitingOn || '', owner: row.owner || '', date_raised: row.dateRaised || null, follow_up_date: row.followUpDate || null, description: row.description || '', resolution: row.resolution || '', resolved_date: row.resolvedDate || null, source: row.source || '', external_source_id: row.externalSourceId || null, source_sender: row.sourceSender || null, raw_data: row })),
    activity_logs: activities.map((row: any) => ({ id: String(row.id), client_id: row.clientId || null, project_id: row.projectId || null, activity_date: row.date || null, text: row.text || '', raw_data: row })),
    planner_activities: planner.map((row: any) => ({ id: String(row.id), client_id: row.clientId || null, project_id: row.projectId || null, title: row.title || '', activity_date: row.date || null, start_time: row.startTime || null, end_time: row.endTime || null, end_date: row.endDate || null, all_day: Boolean(row.allDay), source: row.source || '', status: row.status || '', notes: row.notes || '', calendar_event_id: row.calendarEventId || null, calendar_link: row.calendarLink || null, raw_data: row })),
    app_users: accounts.map((row: any) => ({ id: String(row.id), username: row.username || '', password_hash: row.passwordHash || '', name: row.name || '', email: row.email || '', phone: row.phone || '', role: row.role || '', modules: Array.isArray(row.modules) ? row.modules : [], status: row.status || '', created_on: row.createdAt || null, raw_data: sanitizedAccountRaw(row) })),
    task_statuses: statuses.map((row: any, index: number) => ({ id: tenantReady ? `${organizationId}:${String(row.id)}` : String(row.id), label: row.label || '', is_completed: Boolean(row.closed), sort_order: index, raw_data: row })),
    app_settings: [{ id: tenantReady ? `${organizationId}:task-settings` : 'task-settings', setting_key: tenantReady ? `task_settings:${organizationId}` : 'task_settings', value: source.taskSettings || defaultTaskSettings, raw_data: source.taskSettings || defaultTaskSettings }],
  }
}

class TenantSaveError extends Error {
  constructor(message: string, public status: number) { super(message) }
}

async function commitTenantState(organizationId: string | undefined, state: any, actor: SessionUser | null, reason: string, before?: any, synchronize = true): Promise<NormalizedSyncResult> {
  if (!supabaseAdmin) throw new TenantSaveError('Supabase is not configured.', 503)
  if (!organizationId) throw new TenantSaveError('A tenant workspace is required.', 403)
  const { data, error } = await supabaseAdmin.rpc('save_tenant_state_v6', {
    p_organization_id: organizationId,
    p_state: state,
    p_records: synchronize ? normalizedRecords(state, organizationId) : null,
    p_audit_entries: before ? auditEntriesForChanges(before, state, actor, reason, organizationId) : [],
    p_actor_id: actor?.id || null,
    p_reason: reason,
  })
  if (error) {
    if (error.code === 'PGRST202' || error.code === '42883') throw new TenantSaveError('Database update required: run supabase/schema-v6-tenant-save-integrity.sql in Supabase SQL Editor, then retry.', 409)
    const status = error.code === '42501' ? 403 : ['23505', '23514', '22023', '22007', '22008'].includes(error.code) ? 400 : 500
    throw new TenantSaveError(error.message || 'The tenant save was rolled back.', status)
  }
  return data as NormalizedSyncResult
}

async function syncNormalizedState(state: any, actor: SessionUser | null = null, reason = 'sync', organizationId?: string): Promise<NormalizedSyncResult> {
  return commitTenantState(organizationId, state, actor, reason)
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

app.post('/api/auth/login', loginLimiter, async (req, res) => {
  const account = typeof req.body?.account === 'string' ? req.body.account.trim() : ''
  const username = typeof req.body?.username === 'string' ? req.body.username.trim() : ''
  const password = typeof req.body?.password === 'string' ? req.body.password : ''
  if (!account || !username || !password) {
    res.status(400).json({ error: 'Account, user, and password are required.' })
    return
  }

  try {
    const accountKey = account.trim().toLowerCase().replace(/\s+/g, '_')

    // The Internal Admin control plane is intentionally separate from tenant workspaces.
    if (accountKey === INTERNAL_ADMIN_ACCOUNT_KEY) {
      if (!supabaseAdmin || !await platformAuthSchemaReady()) {
        res.status(409).json({ error: 'Internal Admin authentication is not initialized. Run the latest Supabase account/security schema first.' })
        return
      }

      const { data: platformAccount, error: platformError } = await supabaseAdmin
        .from('platform_users')
        .select('id,account_key,username,password_hash,name,email,phone,status,must_change_password,last_login_at,deleted_at')
        .ilike('account_key', INTERNAL_ADMIN_ACCOUNT_KEY)
        .ilike('username', username)
        .is('deleted_at', null)
        .maybeSingle()
      if (platformError) throw platformError
      if (!platformAccount || platformAccount.status === 'Disabled') {
        res.status(401).json({ error: 'Invalid account, user, or password.' })
        return
      }

      let storedHash = String(platformAccount.password_hash || '')
      if (storedHash === PASSWORD_BOOTSTRAP_MARKER) {
        if (!bootstrapPasswordUsable(internalAdminBootstrapPassword)) {
          res.status(503).json({ error: 'Internal Admin requires a secure bootstrap password. Set INTERNAL_ADMIN_BOOTSTRAP_PASSWORD (12+ characters) in Render, then redeploy.' })
          return
        }
        if (!safeEqualText(password, internalAdminBootstrapPassword)) {
          res.status(401).json({ error: 'Invalid account, user, or password.' })
          return
        }
        storedHash = await secureHashPassword(password)
        const { error: bootstrapError } = await supabaseAdmin.from('platform_users').update({ password_hash: storedHash, must_change_password: true, updated_at: new Date().toISOString() }).eq('id', platformAccount.id)
        if (bootstrapError) throw bootstrapError
      } else if (!await verifyPassword(password, storedHash)) {
        res.status(401).json({ error: 'Invalid account, user, or password.' })
        return
      } else if (!isBcryptHash(storedHash)) {
        storedHash = await secureHashPassword(password)
        const { error: upgradeError } = await supabaseAdmin.from('platform_users').update({ password_hash: storedHash, updated_at: new Date().toISOString() }).eq('id', platformAccount.id)
        if (upgradeError) throw upgradeError
      }

      const loggedInAt = new Date().toISOString()
      await supabaseAdmin.from('platform_users').update({ last_login_at: loggedInAt, updated_at: loggedInAt }).eq('id', platformAccount.id)
      const user = safePlatformUser({ ...platformAccount, password_hash: storedHash, last_login_at: loggedInAt })
      const token = randomBytes(32).toString('hex')
      sessions.set(token, user)
      res.setHeader('Set-Cookie', sessionCookie(token, 28800))
      res.json({ user, cloudConfigured: true, multiTenant: true })
      return
    }

    if (supabaseAdmin && await multiTenantSchemaReady()) {
      const organization = await organizationByLoginKey(account)
      if (!organization || organization.status !== 'Active') {
        res.status(401).json({ error: 'Invalid account, user, or password.' })
        return
      }
      const { data: normalizedAccount, error: accountError } = await supabaseAdmin
        .from('app_users')
        .select('id,organization_id,username,password_hash,name,email,phone,role,modules,status,created_on,last_login_at,deleted_at')
        .eq('organization_id', organization.id)
        .ilike('username', username)
        .is('deleted_at', null)
        .maybeSingle()
      if (accountError) throw accountError
      if (!normalizedAccount || normalizedAccount.status === 'Disabled') {
        res.status(401).json({ error: 'Invalid account, user, or password.' })
        return
      }

      let storedHash = String(normalizedAccount.password_hash || '')
      if (storedHash === PASSWORD_BOOTSTRAP_MARKER) {
        const isBxiBootstrap = organization.id === BXI_CORE_ORG_ID && username.toLowerCase() === 'admin'
        if (!isBxiBootstrap || !bootstrapPasswordUsable(bxiCoreBootstrapPassword)) {
          res.status(503).json({ error: 'This bootstrap account requires a secure server password. Configure BXI_CORE_BOOTSTRAP_PASSWORD (12+ characters) and redeploy.' })
          return
        }
        if (!safeEqualText(password, bxiCoreBootstrapPassword)) {
          res.status(401).json({ error: 'Invalid account, user, or password.' })
          return
        }
        storedHash = await secureHashPassword(password)
        const { error: bootstrapError } = await supabaseAdmin.from('app_users').update({ password_hash: storedHash, updated_at: new Date().toISOString() }).eq('id', normalizedAccount.id)
        if (bootstrapError) throw bootstrapError
        await updateTenantAccountSnapshot(organization.id, String(normalizedAccount.id), (entry) => entry ? { ...entry, passwordHash: storedHash } : entry)
      } else if (!await verifyPassword(password, storedHash)) {
        res.status(401).json({ error: 'Invalid account, user, or password.' })
        return
      } else if (!isBcryptHash(storedHash)) {
        storedHash = await secureHashPassword(password)
        const { error: upgradeError } = await supabaseAdmin.from('app_users').update({ password_hash: storedHash, updated_at: new Date().toISOString() }).eq('id', normalizedAccount.id)
        if (upgradeError) throw upgradeError
        await updateTenantAccountSnapshot(organization.id, String(normalizedAccount.id), (entry) => entry ? { ...entry, passwordHash: storedHash } : entry)
      }

      const loggedInAt = new Date().toISOString()
      await supabaseAdmin.from('app_users').update({ last_login_at: loggedInAt, updated_at: loggedInAt }).eq('id', normalizedAccount.id)
      const user = safeUser({ ...normalizedAccount, password_hash: storedHash, last_login_at: loggedInAt }, organization)
      const token = randomBytes(32).toString('hex')
      sessions.set(token, user)
      res.setHeader('Set-Cookie', sessionCookie(token, 28800))
      res.json({ user, cloudConfigured: true, multiTenant: true })
      return
    }

    // Legacy BXI-Core compatibility. Existing SHA-256 hashes are accepted once and upgraded.
    if (![BXI_CORE_ORG_SLUG, BXI_CORE_ORG_NAME.toLowerCase()].includes(account.trim().toLowerCase())) {
      res.status(401).json({ error: 'Invalid account, user, or password.' })
      return
    }
    const state = await loadLegacyTrackerState()
    const accounts = Array.isArray(state.data?.accounts) ? state.data.accounts : []
    const legacyAccount = accounts.find((candidate: any) => String(candidate.username || '').toLowerCase() === username.toLowerCase())
    if (!legacyAccount || legacyAccount.status === 'Disabled' || !await verifyPassword(password, legacyAccount.passwordHash)) {
      res.status(401).json({ error: 'Invalid account, user, or password.' })
      return
    }
    if (!isBcryptHash(legacyAccount.passwordHash)) {
      const upgradedHash = await secureHashPassword(password)
      const nextState = { ...state.data, accounts: accounts.map((entry: any) => String(entry.id) === String(legacyAccount.id) ? { ...entry, passwordHash: upgradedHash } : entry) }
      await saveTenantState(BXI_CORE_ORG_ID, nextState)
      legacyAccount.passwordHash = upgradedHash
    }
    const legacyOrganization: OrganizationInfo = { id: BXI_CORE_ORG_ID, name: BXI_CORE_ORG_NAME, slug: BXI_CORE_ORG_SLUG, status: 'Active', enabledModules: [...ALL_MODULES] }
    const user = safeUser(legacyAccount, legacyOrganization)
    const token = randomBytes(32).toString('hex')
    sessions.set(token, user)
    res.setHeader('Set-Cookie', sessionCookie(token, 28800))
    res.json({ user, cloudConfigured: state.configured, multiTenant: false })
  } catch (error) {
    console.error('Login failed:', error)
    res.status(500).json({ error: 'Login failed.' })
  }
})

app.post('/api/auth/forgot-password', recoveryRequestLimiter, (req, res) => {
  const account = typeof req.body?.account === 'string' ? req.body.account.trim() : ''
  const username = typeof req.body?.username === 'string' ? req.body.username.trim() : ''
  const email = typeof req.body?.email === 'string' ? req.body.email.trim() : ''
  if (!account || account.length > 200 || !username || username.length > 200 || !validRecoveryEmail(email)) {
    return void res.status(400).json({ error: 'Enter your account, user, and registered email address.' })
  }
  if (!supabaseAdmin || !sendRecoveryEmail) return void res.status(503).json({ error: recoveryUnavailable })
  // Respond before lookup/delivery so their timing cannot reveal registered accounts.
  res.json({ message: recoveryMessage })
  const database = supabaseAdmin
  const sendEmail = sendRecoveryEmail
  void (async () => {
    const token = randomBytes(32).toString('base64url')
    const tokenHash = passwordHash(token)
    const { data, error } = await database.rpc('issue_password_reset_v7', {
      p_account: account, p_username: username, p_email: email, p_token_hash: tokenHash,
    })
    if (error) throw error
    if (!data) return
    try {
      if (!validRecoveryEmail(String(data.email))) throw new Error('Invalid recovery email')
      await sendEmail(String(data.email), String(data.account), token)
    } catch (error) {
      const { error: revokeError } = await database.from('password_reset_tokens').delete().eq('token_hash', tokenHash)
      if (revokeError) console.error('Could not revoke undelivered recovery token; check database availability.')
      throw error
    }
  })().catch((error: unknown) => {
    // Never log reset URLs, tokens, recipient addresses, or SMTP credentials.
    const code = String((error as { code?: string })?.code || 'DELIVERY_ERROR').replace(/[^A-Z0-9_]/gi, '').slice(0, 40)
    console.error(`Password recovery failed (${code}). Check SMTP settings and schema-v7-password-recovery.sql.`)
  })
})

app.post('/api/auth/reset-password', recoverySubmitLimiter, async (req, res) => {
  const token = typeof req.body?.token === 'string' ? req.body.token : ''
  const password = typeof req.body?.password === 'string' ? req.body.password : ''
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return void res.status(400).json({ error: 'This reset link is invalid or has expired. Request a new link.' })
  if (password.length < 8 || password.length > 128) return void res.status(400).json({ error: 'Use a password between 8 and 128 characters.' })
  if (!supabaseAdmin) return void res.status(503).json({ error: recoveryUnavailable })
  try {
    const { data, error } = await supabaseAdmin.rpc('redeem_password_reset_v7', {
      p_token_hash: passwordHash(token), p_password_hash: await secureHashPassword(password),
    })
    if (error) throw error
    if (!data) return void res.status(400).json({ error: 'This reset link is invalid or has expired. Request a new link.' })
    for (const [sessionToken, user] of sessions) {
      if (user.id === data.userId && user.accountType === data.accountType &&
        (data.accountType === 'platform' || user.organizationId === data.organizationId)) sessions.delete(sessionToken)
    }
    const { token: browserSession } = sessionFromRequest(req)
    if (browserSession) sessions.delete(browserSession)
    res.setHeader('Set-Cookie', sessionCookie('', 0))
    res.json({ message: 'Your password has been reset. Sign in with your new password.' })
  } catch {
    console.error('Password reset could not be completed. Check database availability and schema-v7-password-recovery.sql.')
    res.status(503).json({ error: recoveryUnavailable })
  }
})

app.post('/api/auth/logout', requireAuth, (req, res) => {
  const { token } = sessionFromRequest(req)
  if (token) sessions.delete(token)
  res.setHeader('Set-Cookie', sessionCookie('', 0))
  res.json({ ok: true })
})


app.get('/api/data-architecture/status', requireAuth, requirePlatformAdmin, async (req, res) => {
  const user = (req as express.Request & { authUser: SessionUser }).authUser
  try {
    const organization = await organizationById(String(req.query.organizationId || ''))
    if (!organization) return void res.status(400).json({ error: 'Choose an account.' })
    const status = await normalizedSchemaStatus(organization.id)
    res.json({ ...status, multiTenant: await multiTenantSchemaReady(), organizationId: organization.id, organizationName: organization.name })
  } catch (error) {
    res.status(500).json({ ready: false, error: error instanceof Error ? error.message : 'Could not check normalized data architecture.' })
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

app.get('/api/store', requireAuth, requireTenantWorkspace, async (req, res) => {
  if (!supabaseAdmin) {
    res.status(503).json({ configured: false, data: null, error: 'Supabase is not configured.' })
    return
  }
  const user = (req as express.Request & { authUser: SessionUser }).authUser
  try {
    const state = await loadTenantState(tenantIdForUser(user))
    res.json({ configured: true, data: sanitizeStateForClient(state.data), updatedAt: state.updatedAt, organizationId: user.organizationId, organizationName: user.organizationName })
  } catch (error) {
    console.error('Supabase load failed:', error)
    res.status(500).json({ configured: true, error: error instanceof Error ? error.message : 'Cloud database load failed.' })
  }
})

function stable(value: unknown): string | undefined {
  return JSON.stringify(value, (_key, entry) => entry && typeof entry === 'object' && !Array.isArray(entry)
    ? Object.fromEntries(Object.keys(entry).sort().map((key) => [key, entry[key]])) : entry)
}

function accountDefaults(account: any) {
  return { ...account, theme: normalizeAppTheme(account?.theme) }
}

async function prepareAccountPasswords(currentAccounts: any[], nextAccounts: any[]) {
  const currentMap = new Map(currentAccounts.map((account) => [String(account?.id || ''), account]))
  return Promise.all(nextAccounts.map(async (account: any) => {
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
  }))
}

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
    const allowed = ['name', 'email', 'phone', 'passwordHash', 'theme']
    const keys = new Set([...Object.keys(current), ...Object.keys(next)])
    for (const key of keys) {
      if (allowed.includes(key)) continue
      if (stable(current[key]) !== stable(next[key])) return false
    }
  }
  return true
}

function moduleAllowed(user: SessionUser, module: string) {
  return user.modules.includes(module)
}

function requireTenantWorkspace(req: express.Request, res: express.Response, next: express.NextFunction) {
  const user = (req as express.Request & { authUser?: SessionUser }).authUser
  if (!user || user.accountType === 'platform' || !user.organizationId) {
    res.status(403).json({ error: 'A tenant workspace login is required for this action.' })
    return
  }
  next()
}

app.put('/api/store', requireAuth, requireTenantWorkspace, async (req, res) => {
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
  const organizationId = tenantIdForUser(user)
  try {
    const currentState = await loadTenantState(organizationId)
    const current = currentState.data && typeof currentState.data === 'object' ? currentState.data : { schemaVersion: 5, clients: [], projects: [], items: [], activity: [], planner: [], accounts: [], taskSettings: defaultTaskSettings }

    const currentItems = Array.isArray(current.items) ? current.items : []
    const nextItems = Array.isArray(next.items) ? next.items : []
    const nextIds = new Set(nextItems.map((item: any) => String(item?.id || '')))
    const missingDiscordItems = currentItems.filter((item: any) => item?.source === 'Discord' && item?.externalSourceId && !nextIds.has(String(item.id || '')))
    if (missingDiscordItems.length) next = { ...next, items: [...missingDiscordItems, ...nextItems] }

    const currentAccounts = Array.isArray(current.accounts) ? current.accounts.map(accountDefaults) : []
    const incomingAccounts = Array.isArray(next.accounts) ? next.accounts.map(accountDefaults) : []
    const nextAccounts = await prepareAccountPasswords(currentAccounts, incomingAccounts)
    next = { ...next, accounts: nextAccounts }
    const accountsChanged = stable(currentAccounts) !== stable(nextAccounts)
    const selfOnlyAccounts = accountsChanged && accountChangesAreSelfOnly(currentAccounts, nextAccounts, user.id)
    if (accountsChanged && !selfOnlyAccounts) return void res.status(403).json({ error: 'Manage users and access in Internal Admin.' })
    if (stable(current.taskSettings ?? defaultTaskSettings) !== stable(next.taskSettings ?? defaultTaskSettings)) return void res.status(409).json({ error: 'Task configuration is managed in Internal Admin. Reload this workspace before saving.' })

    if (user.role === 'Viewer') {
      const operationalUnchanged = ['clients', 'projects', 'items', 'activity', 'planner'].every((key) => stable(current[key] ?? []) === stable(next[key] ?? []))
        && stable(current.taskSettings ?? defaultTaskSettings) === stable(next.taskSettings ?? defaultTaskSettings)
      if (!operationalUnchanged || (accountsChanged && !selfOnlyAccounts)) return void res.status(403).json({ configured: true, error: 'Viewer accounts are read-only except for their own profile.' })
    }

    if (user.role === 'Contributor') {
      if (accountsChanged && !selfOnlyAccounts) return void res.status(403).json({ configured: true, error: 'Only Administrators can manage other accounts.' })
      if (stable(current.taskSettings ?? defaultTaskSettings) !== stable(next.taskSettings ?? defaultTaskSettings)) return void res.status(403).json({ configured: true, error: 'Only Administrators can change task configuration.' })
      if (stable(current.clients ?? []) !== stable(next.clients ?? []) && !moduleAllowed(user, 'clients')) return void res.status(403).json({ configured: true, error: 'Client module access is required.' })
      if (stable(current.projects ?? []) !== stable(next.projects ?? []) && !moduleAllowed(user, 'projects')) return void res.status(403).json({ configured: true, error: 'Project module access is required.' })
      if (stable(current.items ?? []) !== stable(next.items ?? []) && !moduleAllowed(user, 'items') && !moduleAllowed(user, 'inbox')) return void res.status(403).json({ configured: true, error: 'Task module access is required.' })
      if (stable(current.planner ?? []) !== stable(next.planner ?? []) && !moduleAllowed(user, 'action')) return void res.status(403).json({ configured: true, error: 'Action Center access is required.' })
    }

    if (accountsChanged && user.role === 'Administrator') {
      const allowedModules = new Set(user.organizationModules || ALL_MODULES)
      for (const account of nextAccounts) {
        const modules = Array.isArray(account.modules) ? account.modules : []
        if (modules.some((module: string) => !allowedModules.has(module))) return void res.status(400).json({ configured: true, error: 'A user cannot be assigned a module disabled for this workspace.' })
      }
      if (await multiTenantSchemaReady()) {
        const { data: existingUsers, error: existingUsersError } = await supabaseAdmin.from('app_users').select('id,username,organization_id').eq('organization_id', organizationId).is('deleted_at', null)
        if (existingUsersError) throw existingUsersError
        for (const account of nextAccounts) {
          const duplicate = (existingUsers || []).find((existing: any) => String(existing.id) !== String(account.id) && String(existing.username || '').toLowerCase() === String(account.username || '').toLowerCase())
          if (duplicate) return void res.status(409).json({ configured: true, error: `Username ${account.username} is already used in this workspace.` })
        }
      }
    }

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
      if (own) for (const [token, sessionUser] of sessions.entries()) if (sessionUser.id === user.id) sessions.set(token, safeUser({ ...own, isPlatformAdmin: sessionUser.isPlatformAdmin }, organization))
    }

    res.json({ configured: true, saved: true, updatedAt })
  } catch (error) {
    console.error('Supabase save failed:', error)
    res.status(error instanceof TenantSaveError ? error.status : 500).json({ configured: true, error: error instanceof Error ? error.message : 'Cloud database save failed.' })
  }
})


function emptyTenantData(accounts: any[] = []) {
  return { schemaVersion: 5, clients: [], projects: [], items: [], activity: [], planner: [], accounts, taskSettings: defaultTaskSettings }
}

function cleanSlug(value: unknown) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)
}

function cleanModules(value: unknown) {
  return Array.isArray(value) ? [...new Set(value.map(String).filter((module) => ALL_MODULES.includes(module)))] : []
}

async function usernameExists(organizationId: string, username: string, excludeId?: string) {
  if (!supabaseAdmin) return false
  let query = supabaseAdmin.from('app_users').select('id').eq('organization_id', organizationId).ilike('username', username).is('deleted_at', null).limit(1)
  if (excludeId) query = query.neq('id', excludeId)
  const { data, error } = await query
  if (error) throw error
  return Boolean(data?.length)
}

async function updateTenantAccountSnapshot(organizationId: string, accountId: string, updater: (account: any | null) => any | null) {
  const state = await loadTenantState(organizationId)
  const base = state.data && typeof state.data === 'object' ? state.data : emptyTenantData()
  const accounts = Array.isArray(base.accounts) ? base.accounts : []
  const existing = accounts.find((account: any) => String(account.id) === accountId) || null
  const updated = updater(existing)
  const nextAccounts = updated
    ? existing ? accounts.map((account: any) => String(account.id) === accountId ? updated : account) : [...accounts, updated]
    : accounts.filter((account: any) => String(account.id) !== accountId)
  const next = { ...base, schemaVersion: 5, accounts: nextAccounts, taskSettings: base.taskSettings || defaultTaskSettings }
  await saveTenantState(organizationId, next)
  return next
}

app.get('/api/internal-admin/dashboard', requireAuth, requirePlatformAdmin, async (_req, res) => {
  if (!supabaseAdmin || !await multiTenantSchemaReady() || !await platformAuthSchemaReady()) return void res.status(409).json({ error: 'Run supabase/schema-v3-multitenant.sql and supabase/schema-v4-account-login.sql before using Internal Admin.' })
  try {
    const [{ data: organizations, error: orgError }, { data: users, error: userError }] = await Promise.all([
      supabaseAdmin.from('organizations').select('id,name,slug,status,enabled_modules,created_at').is('deleted_at', null).order('name'),
      supabaseAdmin.from('app_users').select('id,organization_id,username,name,email,phone,role,modules,status,created_on,is_platform_admin,last_login_at').is('deleted_at', null).order('name'),
    ])
    if (orgError) throw orgError
    if (userError) throw userError
    const userRows = users || []
    const organizationRows = (organizations || []).map((row: any) => {
      const scopedUsers = userRows.filter((user: any) => String(user.organization_id || '') === String(row.id))
      return {
        id: String(row.id), name: row.name || '', slug: row.slug || '', status: row.status === 'Suspended' ? 'Suspended' : 'Active',
        enabledModules: cleanModules(row.enabled_modules), createdAt: row.created_at || '',
        userCount: scopedUsers.length, activeUserCount: scopedUsers.filter((user: any) => user.status !== 'Disabled').length,
      }
    })
    res.json({
      organizations: organizationRows,
      users: userRows.map((user: any) => ({
        id: String(user.id), organizationId: String(user.organization_id || ''), username: user.username || '', name: user.name || '', email: user.email || '', phone: user.phone || '',
        role: user.role === 'Administrator' || user.role === 'Viewer' ? user.role : 'Contributor', modules: cleanModules(user.modules), status: user.status === 'Disabled' ? 'Disabled' : 'Active',
        isPlatformAdmin: Boolean(user.is_platform_admin), createdAt: user.created_on || '', lastLoginAt: user.last_login_at || undefined,
      })),
      totals: {
        organizations: organizationRows.length,
        activeOrganizations: organizationRows.filter((org: any) => org.status === 'Active').length,
        users: userRows.length,
        activeUsers: userRows.filter((user: any) => user.status !== 'Disabled').length,
      },
    })
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Could not load Internal Admin.' })
  }
})

app.post('/api/internal-admin/organizations', requireAuth, requirePlatformAdmin, async (req, res) => {
  if (!supabaseAdmin || !await multiTenantSchemaReady() || !await platformAuthSchemaReady()) return void res.status(409).json({ error: 'Run the multi-tenant and account-login schemas first.' })
  const name = String(req.body?.name || '').trim()
  const slug = cleanSlug(req.body?.slug || name)
  const enabledModules = cleanModules(req.body?.enabledModules)
  const administrator = req.body?.administrator || {}
  const username = String(administrator.username || '').trim()
  const password = String(administrator.password || '')
  if (!name || !slug || !username || !password) return void res.status(400).json({ error: 'Organization name, slug, administrator username, and initial password are required.' })
  if (slug === 'internal-admin' || name.trim().toLowerCase().replace(/\s+/g, '_') === INTERNAL_ADMIN_ACCOUNT_KEY) return void res.status(400).json({ error: 'internal_admin is reserved for the BXI-Core control plane.' })
  if (password.length < 8) return void res.status(400).json({ error: 'Use an initial password with at least 8 characters.' })
  try {
    const { data: duplicateSlug } = await supabaseAdmin.from('organizations').select('id').eq('slug', slug).is('deleted_at', null).maybeSingle()
    if (duplicateSlug) return void res.status(409).json({ error: 'That workspace slug is already in use.' })
    const organizationId = randomUUID()
    const userId = randomUUID()
    const createdAt = new Date().toISOString().slice(0, 10)
    const modules = enabledModules
    const account = {
      id: userId, username, passwordHash: await secureHashPassword(password), name: String(administrator.name || username).trim(), email: String(administrator.email || '').trim(), phone: String(administrator.phone || '').trim(),
      role: 'Administrator', modules, status: 'Active', createdAt, theme: 'default',
    }
    const { error: orgError } = await supabaseAdmin.from('organizations').insert({ id: organizationId, name, slug, status: 'Active', enabled_modules: modules })
    if (orgError) throw orgError
    const { error: userError } = await supabaseAdmin.from('app_users').insert({
      id: userId, organization_id: organizationId, username, password_hash: account.passwordHash, name: account.name, email: account.email, phone: account.phone,
      role: 'Administrator', modules, status: 'Active', created_on: createdAt, raw_data: sanitizedAccountRaw(account), is_platform_admin: false,
    })
    if (userError) {
      await supabaseAdmin.from('organizations').delete().eq('id', organizationId)
      throw userError
    }
    await saveTenantState(organizationId, emptyTenantData([account]))
    res.json({ organization: { id: organizationId, name, slug, status: 'Active', enabledModules: modules } })
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Could not create tenant account.' })
  }
})

app.patch('/api/internal-admin/organizations/:organizationId', requireAuth, requirePlatformAdmin, async (req, res) => {
  if (!supabaseAdmin) return void res.status(503).json({ error: 'Supabase is not configured.' })
  const organizationId = String(req.params.organizationId || '')
  try {
    const current = await organizationById(organizationId)
    if (!current) return void res.status(404).json({ error: 'Account was not found.' })
    const patch: any = { updated_at: new Date().toISOString() }
    if (typeof req.body?.name === 'string' && req.body.name.trim()) patch.name = req.body.name.trim()
    if (req.body?.status === 'Active' || req.body?.status === 'Suspended') {
      patch.status = req.body.status
    }
    if (Array.isArray(req.body?.enabledModules)) patch.enabled_modules = cleanModules(req.body.enabledModules)
    const { error } = await supabaseAdmin.from('organizations').update(patch).eq('id', organizationId)
    if (error) throw error
    if (patch.enabled_modules) {
      const { data: orgUsers, error: orgUsersError } = await supabaseAdmin.from('app_users').select('id,role,modules').eq('organization_id', organizationId).is('deleted_at', null)
      if (orgUsersError) throw orgUsersError
      for (const orgUser of orgUsers || []) {
        const modules = orgUser.role === 'Administrator' ? patch.enabled_modules : cleanModules(orgUser.modules).filter((module) => patch.enabled_modules.includes(module))
        await supabaseAdmin.from('app_users').update({ modules, updated_at: new Date().toISOString() }).eq('id', orgUser.id)
        await updateTenantAccountSnapshot(organizationId, String(orgUser.id), (account) => account ? { ...account, modules } : account)
      }
    }
    const organization = await organizationById(organizationId)
    if (!organization) throw new Error('Could not reload the account.')
    if (organization.status !== 'Active') { const runtime = discordRuntimes.get(organizationId); discordRuntimes.delete(organizationId); if (runtime) await runtime.client.destroy() }
    for (const [token, sessionUser] of sessions.entries()) {
      if (sessionUser.organizationId !== organizationId) continue
      if (organization.status !== 'Active') { sessions.delete(token); continue }
      const { data: account } = await supabaseAdmin.from('app_users').select('*').eq('id', sessionUser.id).maybeSingle()
      if (account) sessions.set(token, safeUser(account, organization))
    }
    res.json({ ok: true })
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Could not update tenant account.' })
  }
})

app.post('/api/internal-admin/organizations/:organizationId/users', requireAuth, requirePlatformAdmin, async (req, res) => {
  if (!supabaseAdmin) return void res.status(503).json({ error: 'Supabase is not configured.' })
  const organizationId = String(req.params.organizationId || '')
  const username = String(req.body?.username || '').trim()
  const password = String(req.body?.password || '')
  const role = req.body?.role === 'Administrator' || req.body?.role === 'Viewer' ? req.body.role : 'Contributor'
  if (!username || !password) return void res.status(400).json({ error: 'Username and initial password are required.' })
  if (password.length < 8) return void res.status(400).json({ error: 'Use an initial password with at least 8 characters.' })
  try {
    const organization = await organizationById(organizationId)
    if (!organization) return void res.status(404).json({ error: 'Account was not found.' })
    if (await usernameExists(organizationId, username)) return void res.status(409).json({ error: 'That username is already used in this account.' })
    const requestedModules = cleanModules(req.body?.modules).filter((module) => organization.enabledModules.includes(module))
    const modules = role === 'Administrator' ? organization.enabledModules : requestedModules
    const account = {
      id: randomUUID(), username, passwordHash: await secureHashPassword(password), name: String(req.body?.name || username).trim(), email: String(req.body?.email || '').trim(), phone: String(req.body?.phone || '').trim(),
      role, modules, status: 'Active', createdAt: new Date().toISOString().slice(0, 10), theme: 'default',
    }
    const { error } = await supabaseAdmin.from('app_users').insert({
      id: account.id, organization_id: organizationId, username, password_hash: account.passwordHash, name: account.name, email: account.email, phone: account.phone,
      role, modules, status: 'Active', created_on: account.createdAt, raw_data: sanitizedAccountRaw(account), is_platform_admin: false,
    })
    if (error) throw error
    await updateTenantAccountSnapshot(organizationId, account.id, () => account)
    res.json({ user: sanitizedAccountRaw(account) })
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Could not create user.' })
  }
})

app.patch('/api/internal-admin/users/:userId', requireAuth, requirePlatformAdmin, async (req, res) => {
  if (!supabaseAdmin) return void res.status(503).json({ error: 'Supabase is not configured.' })
  const userId = String(req.params.userId || '')
  try {
    const { data: existing, error: readError } = await supabaseAdmin.from('app_users').select('*').eq('id', userId).is('deleted_at', null).maybeSingle()
    if (readError) throw readError
    if (!existing) return void res.status(404).json({ error: 'User was not found.' })
    const organization = await organizationById(existing.organization_id)
    if (!organization) return void res.status(404).json({ error: 'User workspace was not found.' })
    const patch: any = { updated_at: new Date().toISOString() }
    if (typeof req.body?.name === 'string') patch.name = req.body.name.trim()
    if (typeof req.body?.email === 'string') patch.email = req.body.email.trim()
    if (typeof req.body?.phone === 'string') patch.phone = req.body.phone.trim()
    if (req.body?.role === 'Administrator' || req.body?.role === 'Contributor' || req.body?.role === 'Viewer') patch.role = req.body.role
    if (req.body?.status === 'Active' || req.body?.status === 'Disabled') patch.status = req.body.status
    if (Array.isArray(req.body?.modules)) patch.modules = cleanModules(req.body.modules).filter((module) => organization.enabledModules.includes(module))
    const nextRole = patch.role || existing.role
    if (nextRole === 'Administrator') patch.modules = organization.enabledModules
    const { error } = await supabaseAdmin.from('app_users').update(patch).eq('id', userId)
    if (error) throw error
    const snapshotPatch: any = {}
    for (const [dbKey, appKey] of [['name','name'],['email','email'],['phone','phone'],['role','role'],['status','status'],['modules','modules']] as [string,string][]) if (patch[dbKey] !== undefined) snapshotPatch[appKey] = patch[dbKey]
    await updateTenantAccountSnapshot(String(existing.organization_id), userId, (account) => account ? { ...account, ...snapshotPatch } : account)
    for (const [token, sessionUser] of sessions.entries()) {
      if (sessionUser.id !== userId) continue
      if (patch.status === 'Disabled') sessions.delete(token)
      else {
        const { data: refreshed } = await supabaseAdmin.from('app_users').select('*').eq('id', userId).maybeSingle()
        if (refreshed) sessions.set(token, safeUser(refreshed, organization))
      }
    }
    res.json({ ok: true })
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Could not update user.' })
  }
})

app.post('/api/internal-admin/recovery-email', requireAuth, requirePlatformAdmin, recoverySubmitLimiter, async (req, res) => {
  if (!supabaseAdmin) return void res.status(503).json({ error: 'Account settings are unavailable.' })
  const user = (req as express.Request & { authUser: SessionUser }).authUser
  const email = typeof req.body?.email === 'string' ? req.body.email.trim() : ''
  const currentPassword = typeof req.body?.currentPassword === 'string' ? req.body.currentPassword : ''
  if (!validRecoveryEmail(email)) return void res.status(400).json({ error: 'Enter a valid recovery email address.' })
  try {
    const { data, error } = await supabaseAdmin.from('platform_users').select('id,password_hash,status').eq('id', user.id).is('deleted_at', null).maybeSingle()
    if (error) throw error
    if (!data || data.status !== 'Active' || !await verifyPassword(currentPassword, data.password_hash)) return void res.status(401).json({ error: 'Current password is incorrect.' })
    const { data: updated, error: updateError } = await supabaseAdmin.from('platform_users').update({ email, updated_at: new Date().toISOString() })
      .eq('id', user.id).eq('password_hash', data.password_hash).eq('status', 'Active').is('deleted_at', null).select('id').maybeSingle()
    if (updateError) throw updateError
    if (!updated) return void res.status(409).json({ error: 'Your account changed. Sign in and try again.' })
    for (const [token, sessionUser] of sessions) {
      if (sessionUser.id === user.id && sessionUser.accountType === 'platform') sessions.set(token, { ...sessionUser, email })
    }
    res.json({ ok: true, email })
  } catch {
    res.status(500).json({ error: 'Could not save your recovery email.' })
  }
})

app.post('/api/internal-admin/password', requireAuth, requirePlatformAdmin, async (req, res) => {
  if (!supabaseAdmin || !await platformAuthSchemaReady()) return void res.status(409).json({ error: 'Run supabase/schema-v4-account-login.sql before changing the Internal Admin password.' })
  const user = (req as express.Request & { authUser: SessionUser }).authUser
  const currentPassword = String(req.body?.currentPassword || '')
  const newPassword = String(req.body?.newPassword || '')
  if (newPassword.length < 8) return void res.status(400).json({ error: 'Use a new password with at least 8 characters.' })
  try {
    const { data: platformAccount, error: readError } = await supabaseAdmin.from('platform_users').select('id,password_hash').eq('id', user.id).is('deleted_at', null).maybeSingle()
    if (readError) throw readError
    if (!platformAccount || !await verifyPassword(currentPassword, platformAccount.password_hash)) return void res.status(401).json({ error: 'Current password is incorrect.' })
    const updatedAt = new Date().toISOString()
    const { error } = await supabaseAdmin.from('platform_users').update({ password_hash: await secureHashPassword(newPassword), must_change_password: false, password_changed_at: updatedAt, updated_at: updatedAt }).eq('id', user.id)
    if (error) throw error
    for (const [token, sessionUser] of sessions.entries()) {
      if (sessionUser.id === user.id && sessionUser.accountType === 'platform') sessions.set(token, { ...sessionUser, mustChangePassword: false })
    }
    res.json({ ok: true })
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Could not change Internal Admin password.' })
  }
})

app.post('/api/internal-admin/users/:userId/password', requireAuth, requirePlatformAdmin, async (req, res) => {
  if (!supabaseAdmin) return void res.status(503).json({ error: 'Supabase is not configured.' })
  const userId = String(req.params.userId || '')
  const password = String(req.body?.password || '')
  if (password.length < 8) return void res.status(400).json({ error: 'Use a password with at least 8 characters.' })
  try {
    const { data: existing, error: readError } = await supabaseAdmin.from('app_users').select('id,organization_id').eq('id', userId).is('deleted_at', null).maybeSingle()
    if (readError) throw readError
    if (!existing) return void res.status(404).json({ error: 'User was not found.' })
    const nextHash = await secureHashPassword(password)
    const { error } = await supabaseAdmin.from('app_users').update({ password_hash: nextHash, updated_at: new Date().toISOString() }).eq('id', userId)
    if (error) throw error
    await updateTenantAccountSnapshot(String(existing.organization_id), userId, (account) => account ? { ...account, passwordHash: nextHash } : account)
    for (const [token, sessionUser] of sessions.entries()) if (sessionUser.id === userId) sessions.delete(token)
    res.json({ ok: true })
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Could not reset password.' })
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

app.post('/api/assistant', requireAuth, requireTenantWorkspace, async (req, res) => {
  const user = (req as express.Request & { authUser: SessionUser }).authUser
  if (user.role === 'Viewer' || !moduleAllowed(user, 'ai')) {
    res.status(403).json({ error: 'Your account does not have access to the AI BA Assistant.' })
    return
  }

  let ai: Awaited<ReturnType<typeof integrations.active>>
  try { ai = await integrations.active(tenantIdForUser(user)!, 'openai') } catch { return void res.status(503).json({ error: 'Account AI settings are unavailable.' }) }
  if (!ai) return void res.status(503).json({ error: 'Enable an AI API key in this account’s Settings.' })
  const apiKey = ai.secret

  const message = typeof req.body?.message === 'string' ? req.body.message.trim() : ''
  if (!message) {
    res.status(400).json({ error: 'Message is required.' })
    return
  }

  const client = new OpenAI({ apiKey })
  const model = ai.config.model
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
    console.error('Account AI request failed.')
    res.status(502).json({ error: 'AI request failed. Check this account’s key, selected model, quota, and connection.' })
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

function normalizeDiscordContent(content: string, discordClient: DiscordClient) {
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

async function assessDiscordInquiry(messageText: string, sender: string, state: any, organizationId: string) {
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

  let ai
  try { ai = await integrations.active(organizationId, 'openai') } catch { return fallback }
  if (!ai) return fallback
  const client = new OpenAI({ apiKey: ai.secret, timeout: 30000, maxRetries: 0 })
  const model = ai.config.model
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
    console.error('Discord AI assessment failed; using basic capture.')
    return fallback
  }
}

async function captureDiscordInquiry(discordMessage: any, organizationId: string, discordClient: DiscordClient, revision: string) {
  if (!supabaseAdmin) throw new Error('Supabase is not configured; Discord capture requires persistent cloud storage.')
  const text = normalizeDiscordContent(String(discordMessage.content || ''), discordClient)
  if (!text) return { created: false, reason: 'empty' }

  const externalSourceId = `discord:${discordMessage.id}`
  const organization = await organizationById(organizationId)
  if (!organization || organization.status !== 'Active') throw new Error('Discord target workspace is unavailable.')
  const stateResult = await loadTenantState(organizationId)
  const base = stateResult.data && typeof stateResult.data === 'object'
    ? stateResult.data
    : { schemaVersion: 3, clients: [], projects: [], items: [], activity: [], planner: [], accounts: [], taskSettings: defaultTaskSettings }
  const items = Array.isArray(base.items) ? base.items : []
  const existing = items.find((item: any) => item?.externalSourceId === externalSourceId)
  if (existing) return { created: false, reason: 'duplicate', item: existing }

  const sender = discordMessage.member?.displayName || discordMessage.author?.globalName || discordMessage.author?.username || 'Discord user'
  const senderTag = discordMessage.author?.username ? `@${discordMessage.author.username}` : ''
  const assessed = await assessDiscordInquiry(text, sender, base, organizationId)
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
  const active = await integrations.row(organizationId, 'discord')
  const currentOrganization = await organizationById(organizationId)
  if (!active?.is_enabled || active.updated_at !== revision || currentOrganization?.status !== 'Active') return { created: false, reason: 'disabled' }
  await commitTenantState(organizationId, nextState, null, 'discord-capture', base)
  return { created: true, item, clients: base.clients || [], projects: base.projects || [] }
}

function discordStatusPayload(id: string) {
  const runtime = discordRuntimes.get(id)
  return { online: runtime?.online || false, botName: runtime?.botName || '', guildCount: runtime?.guildCount || 0,
    lastMessageAt: runtime?.lastMessageAt || '', lastError: runtime?.lastError || '' }
}
app.get('/api/integrations/discord/status', requireAuth, requireTenantWorkspace, (req, res) => {
  const user = (req as any).authUser
  if (!moduleAllowed(user, 'settings')) return void res.status(403).json({ error: 'Settings access is required.' })
  res.json(discordStatusPayload(user.organizationId))
})
registerPlatformSettings(app, { db: supabaseAdmin, requireAuth, requirePlatformAdmin, organizationById, loadTenantState, normalizedSchemaStatus, defaultTaskSettings, commitTenantState, integrations })
registerIntegrationRoutes(app, { db: supabaseAdmin, requireAuth, requireTenant: requireTenantWorkspace,
  organizationById, store: integrations, reconnect: reconnectDiscord, status: discordStatusPayload })

app.get('/api/integrations/discord/inquiries', requireAuth, requireTenantWorkspace, async (req, res) => {
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
    const state = await loadTenantState(tenantIdForUser(user))
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
  const saved = await commitTenantState(tenantIdForUser(actor), next, actor, source, current)
  return saved.syncedAt
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
    const state = await loadTenantState(tenantIdForUser(user))
    const current = state.data && typeof state.data === 'object' ? state.data : null
    if (!current) return void res.status(404).json({ error: 'Tracker data is not available.' })
    const items = Array.isArray(current.items) ? current.items : []
    const task = items.find((candidate: any) => String(candidate?.id || '') === taskId)
    if (!task) return void res.status(404).json({ error: 'Subtask was not found.' })
    if (!task.parentTaskId) return void res.status(400).json({ error: 'Evidence uploads are currently available for subtasks only.' })

    await ensureTaskEvidenceBucket()
    const evidenceId = randomUUID()
    const storagePath = `organizations/${tenantIdForUser(user)}/subtasks/${taskId}/${evidenceId}-${fileName}`
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
    const state = await loadTenantState(tenantIdForUser(user))
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
    const state = await loadTenantState(tenantIdForUser(user))
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

async function reconnectDiscord(organizationId: string) {
  const previous = discordReconnections.get(organizationId) || Promise.resolve()
  const next = previous.catch(() => undefined).then(() => startTenantDiscord(organizationId))
  discordReconnections.set(organizationId, next)
  try { await next } finally { if (discordReconnections.get(organizationId) === next) discordReconnections.delete(organizationId) }
}
async function startTenantDiscord(organizationId: string) {
  const previous = discordRuntimes.get(organizationId)
  if (previous) { discordRuntimes.delete(organizationId); await previous.client.destroy() }
  const organization = await organizationById(organizationId)
  if (organization?.status !== 'Active') return
  const config = await integrations.active(organizationId, 'discord')
  if (!config) return
  const client = new DiscordClient({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.DirectMessages, GatewayIntentBits.MessageContent], partials: [Partials.Channel] })
  const runtime: DiscordRuntime = { client, revision: config.revision, online: false, botName: '', guildCount: 0, lastMessageAt: '', lastError: '' }
  discordRuntimes.set(organizationId, runtime)
  client.once('ready', ready => { runtime.online = true; runtime.botName = ready.user.tag; runtime.guildCount = ready.guilds.cache.size; runtime.lastError = '' })
  client.on('shardDisconnect', () => { runtime.online = false })
  client.on('shardResume', () => { runtime.online = true })
  client.on('error', () => { runtime.lastError = 'Discord connection error. Check bot permissions and reconnect.' })
  client.on('shardError', () => { runtime.online = false; runtime.lastError = 'Discord gateway error.' })
  client.on('messageCreate', message => {
    if (message.author.bot || !client.user || (message.guildId && !message.mentions.users.has(client.user.id))) return
    const allowed = config.config.allowedUserIds || []
    if (allowed.length && !allowed.includes(message.author.id)) return
    if (discordUserRateLimited(`${organizationId}:${message.author.id}`)) return
    // Serial capture per tenant preserves message deduplication and independent bot state.
    const queued = (discordCaptures.get(organizationId) || Promise.resolve()).catch(() => undefined).then(async () => {
      if (discordRuntimes.get(organizationId) !== runtime) return
      try {
        const result = await captureDiscordInquiry(message, organizationId, client, config.revision)
        if (result.created) {
          runtime.lastMessageAt = new Date().toISOString(); runtime.lastError = ''
          await message.reply({ content: '✅ Inquiry added to BA Tracker.', allowedMentions: { parse: [], repliedUser: false } }).catch(() => undefined)
        }
      } catch { runtime.lastError = 'Inquiry could not be saved. Check account storage and retry.' }
    })
    discordCaptures.set(organizationId, queued)
    void queued.finally(() => { if (discordCaptures.get(organizationId) === queued) discordCaptures.delete(organizationId) })
  })
  // Saving settings must not wait for the Gateway handshake.
  void client.login(config.secret).catch(() => { runtime.online = false; runtime.lastError = 'Bot login failed. Check token and Message Content intent.' })
}
let reconcilingDiscord = false
async function reconcileDiscord() {
  if (!supabaseAdmin || reconcilingDiscord) return
  reconcilingDiscord = true
  try {
    const { data, error } = await supabaseAdmin.from('tenant_integrations').select('tenant_id,updated_at').eq('integration_type','discord').eq('is_enabled',true)
    if (error) throw error
    const enabled = new Set((data || []).map(row => row.tenant_id))
    for (const [id, runtime] of discordRuntimes) if (!enabled.has(id)) { discordRuntimes.delete(id); await runtime.client.destroy() }
    for (const row of data || []) {
      const organization = await organizationById(row.tenant_id)
      const runtime = discordRuntimes.get(row.tenant_id)
      if (organization?.status !== 'Active' || runtime?.revision !== row.updated_at || !runtime?.online) await reconnectDiscord(row.tenant_id).catch(() => undefined)
    }
  } catch { console.warn('Tenant Discord connections unavailable. Check schema-v8 and encrypted integration configuration.') }
  finally { reconcilingDiscord = false }
}

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
  if (isProduction && !bootstrapPasswordUsable(internalAdminBootstrapPassword)) {
    console.warn('SECURITY: INTERNAL_ADMIN_BOOTSTRAP_PASSWORD is not configured with 12+ characters. It is required only while the Internal Admin account is in bootstrap state.')
  }
  if (isProduction && !bootstrapPasswordUsable(bxiCoreBootstrapPassword)) {
    console.warn('SECURITY: BXI_CORE_BOOTSTRAP_PASSWORD is not configured with 12+ characters. It is required only while the initial BXI-Core Admin account is in bootstrap state.')
  }
  void reconcileDiscord()
})

const discordTimer = setInterval(() => { void reconcileDiscord(); const now = Date.now(); for (const [id, value] of discordUserWindows) if (now - value.startedAt > 60000) discordUserWindows.delete(id) }, 30000)
discordTimer.unref()
process.on('SIGTERM', () => { clearInterval(discordTimer); for (const runtime of discordRuntimes.values()) void runtime.client.destroy(); process.exit(0) })
