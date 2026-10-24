import { Client as DiscordClient, GatewayIntentBits, Partials } from 'discord.js'
import type express from 'express'
import type { Express } from 'express'
import { isArchived } from '../../src/features/tasks/lifecycle'
import { defaultWaitingOn } from '../../src/features/tasks/waitingOn'
import { allowedPriorities, allowedWaitingOn, parseModelJson } from '../ai/suggestions'
import { runTenantAi } from '../ai/tenant-ai'
import { moduleAllowed, requireAuth, requireTenantWorkspace, type SessionUser } from '../core/auth'
import { defaultTaskSettings, openTaskStatus } from '../core/constants'
import { supabaseAdmin } from '../core/database'
import { aiAgents, integrations } from '../core/services'
import { commitTenantState, loadTenantState, organizationById } from '../core/tenant-state'

type DiscordRuntime = {
  client: DiscordClient
  revision: string
  online: boolean
  botName: string
  guildCount: number
  lastMessageAt: string
  lastError: string
}

export const discordRuntimes = new Map<string, DiscordRuntime>()

const discordReconnections = new Map<string, Promise<void>>()

const discordCaptures = new Map<string, Promise<any>>()

export const discordUserWindows = new Map<string, { startedAt: number; count: number }>()

/** Saves a Discord message as client communication. The communications routes provide it once they are registered. */
let discordCapture: (message: any, organizationId: string) => Promise<number> = async () => 0
export function setDiscordCapture(capture: typeof discordCapture) {
  discordCapture = capture
}

function discordUserRateLimited(userId: string) {
  const now = Date.now()
  const current = discordUserWindows.get(userId)
  if (!current || now - current.startedAt >= 60_000) {
    discordUserWindows.set(userId, { startedAt: now, count: 1 })
    return false
  }
  return ++current.count > 10
}

function normalizeDiscordContent(content: string, discordClient: DiscordClient) {
  if (!discordClient?.user) return content.trim()
  return content
    .replace(new RegExp(`<@!?${discordClient.user.id}>`, 'g'), '')
    .replace(/\s+/g, ' ')
    .trim()
}

function findNamedContext(text: string, clients: any[], projects: any[]) {
  const q = text.toLowerCase()
  const client = [...clients]
    .filter(candidate => candidate?.name && q.includes(String(candidate.name).toLowerCase()))
    .sort((a, b) => String(b.name).length - String(a.name).length)[0]
  const project = [...projects]
    .filter(candidate => candidate?.name && q.includes(String(candidate.name).toLowerCase()))
    .sort((a, b) => String(b.name).length - String(a.name).length)[0]
  return { clientId: String(client?.id || ''), projectId: String(project?.id || '') }
}

async function assessDiscordInquiry(messageText: string, sender: string, state: any, organizationId: string) {
  const clients = Array.isArray(state?.clients) ? state.clients : []
  const projects = Array.isArray(state?.projects) ? state.projects : []
  const named = findNamedContext(messageText, clients, projects)
  const fallbackTitle = messageText.replace(/\s+/g, ' ').trim().slice(0, 110) || 'Discord inquiry'
  const allowedWaiting = allowedWaitingOn(state?.taskSettings)
  const fallback = {
    title: fallbackTitle,
    summary: messageText.trim(),
    priority: 'Medium',
    waitingOn: defaultWaitingOn(state?.taskSettings),
    followUpDate: '',
    clientId: named.clientId,
    projectId: named.projectId,
  }

  let ai
  try {
    ai = await aiAgents.active(organizationId, 'ba_assistant')
  } catch {
    return fallback
  }
  if (!ai) return fallback
  const today = new Date().toISOString().slice(0, 10)
  const clientContext = clients.map((item: any) => ({ id: String(item.id), name: String(item.name) }))
  const projectContext = projects.map((item: any) => ({ id: String(item.id), name: String(item.name) }))
  const instructions = `You convert a Business Analyst's Discord capture into one clean Inquiry record. Today is ${today}.
Return JSON only:
{
  "title": "concise inquiry title under 110 chars",
  "summary": "clean short summary preserving important facts and questions",
  "priority": "Low | Medium | High | Urgent",
  "waitingOn": "${[...allowedWaiting].join(' | ')}",
  "followUpDate": "YYYY-MM-DD or empty",
  "clientId": "an ID from the supplied clients or empty",
  "projectId": "an ID from the supplied projects or empty"
}
Do not invent commitments, dates, defects, client names, or projects. Only choose a client/project when the message clearly identifies it. If the user says follow up tomorrow/Friday, resolve that to a date. This is capture/organization, not final classification: the record remains an Inquiry.`
  try {
    const outputText = await runTenantAi(
      ai.secret,
      ai.config,
      instructions,
      `SENDER: ${sender}
CLIENTS: ${JSON.stringify(clientContext)}
PROJECTS: ${JSON.stringify(projectContext)}
MESSAGE: ${messageText}`,
    )
    const parsed = parseModelJson(outputText)
    const validClientIds = new Set(clientContext.map((item: any) => item.id))
    const validProjectIds = new Set(projectContext.map((item: any) => item.id))
    const projectId = validProjectIds.has(String(parsed.projectId || ''))
      ? String(parsed.projectId)
      : fallback.projectId
    const parsedClientId = validClientIds.has(String(parsed.clientId || '')) ? String(parsed.clientId) : ''
    const clientId = parsedClientId || fallback.clientId
    const priority = allowedPriorities.has(String(parsed.priority)) ? String(parsed.priority) : fallback.priority
    const waitingOn = allowedWaiting.has(String(parsed.waitingOn)) ? String(parsed.waitingOn) : fallback.waitingOn
    const followUpDate = /^\d{4}-\d{2}-\d{2}$/.test(String(parsed.followUpDate || ''))
      ? String(parsed.followUpDate)
      : ''
    return {
      title: String(parsed.title || fallback.title)
        .trim()
        .slice(0, 110),
      summary: String(parsed.summary || fallback.summary)
        .trim()
        .slice(0, 1800),
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

async function captureDiscordInquiry(
  discordMessage: any,
  organizationId: string,
  discordClient: DiscordClient,
  revision: string,
) {
  if (!supabaseAdmin)
    throw new Error('Database is not configured; Discord capture requires persistent database storage.')
  const text = normalizeDiscordContent(String(discordMessage.content || ''), discordClient)
  if (!text) return { created: false, reason: 'empty' }

  const externalSourceId = `discord:${discordMessage.id}`
  const organization = await organizationById(organizationId)
  if (!organization || organization.status !== 'Active') throw new Error('Discord target workspace is unavailable.')
  const stateResult = await loadTenantState(organizationId)
  const base =
    stateResult.data && typeof stateResult.data === 'object'
      ? stateResult.data
      : {
          schemaVersion: 6,
          clients: [],
          projects: [],
          items: [],
          activity: [],
          planner: [],
          workEvents: [],
          notifications: [],
          accounts: [],
          taskSettings: defaultTaskSettings,
        }
  const items = Array.isArray(base.items) ? base.items : []
  const existing = items.find((item: any) => item?.externalSourceId === externalSourceId)
  if (existing) return { created: false, reason: 'duplicate', item: existing }

  const sender =
    discordMessage.member?.displayName ||
    discordMessage.author?.globalName ||
    discordMessage.author?.username ||
    'Discord user'
  const senderTag = discordMessage.author?.username ? `@${discordMessage.author.username}` : ''
  const assessed = await assessDiscordInquiry(text, sender, base, organizationId)
  const today = new Date().toISOString().slice(0, 10)
  const item = {
    id: crypto.randomUUID(),
    clientId: base.clients?.some((c: any) => c.id === assessed.clientId && !isArchived(c))
      ? assessed.clientId
      : undefined,
    projectId: base.projects?.some((p: any) => p.id === assessed.projectId && !isArchived(p))
      ? assessed.projectId
      : undefined,
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
    activity: [
      {
        id: crypto.randomUUID(),
        clientId: item.clientId,
        projectId: item.projectId,
        date: today,
        text: `Discord inquiry captured: ${item.title}`,
      },
      ...activity,
    ],
  }
  const active = await integrations.row(organizationId, 'discord')
  const currentOrganization = await organizationById(organizationId)
  if (!active?.is_enabled || active.updated_at !== revision || currentOrganization?.status !== 'Active')
    return { created: false, reason: 'disabled' }
  await commitTenantState(organizationId, nextState, null, 'discord-capture', base)
  return { created: true, item, clients: base.clients || [], projects: base.projects || [] }
}

export function discordStatusPayload(id: string) {
  const runtime = discordRuntimes.get(id)
  return {
    online: runtime?.online || false,
    botName: runtime?.botName || '',
    guildCount: runtime?.guildCount || 0,
    lastMessageAt: runtime?.lastMessageAt || '',
    lastError: runtime?.lastError || '',
  }
}

export async function reconnectDiscord(organizationId: string) {
  const previous = discordReconnections.get(organizationId) || Promise.resolve()
  const next = previous.catch(() => undefined).then(() => startTenantDiscord(organizationId))
  discordReconnections.set(organizationId, next)
  try {
    await next
  } finally {
    if (discordReconnections.get(organizationId) === next) discordReconnections.delete(organizationId)
  }
}

async function startTenantDiscord(organizationId: string) {
  const previous = discordRuntimes.get(organizationId)
  if (previous) {
    discordRuntimes.delete(organizationId)
    await previous.client.destroy()
  }
  const organization = await organizationById(organizationId)
  if (organization?.status !== 'Active') return
  const config = await integrations.active(organizationId, 'discord')
  if (!config) return
  const client = new DiscordClient({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel],
  })
  const runtime: DiscordRuntime = {
    client,
    revision: config.revision,
    online: false,
    botName: '',
    guildCount: 0,
    lastMessageAt: '',
    lastError: '',
  }
  discordRuntimes.set(organizationId, runtime)
  client.once('ready', ready => {
    runtime.online = true
    runtime.botName = ready.user.tag
    runtime.guildCount = ready.guilds.cache.size
    runtime.lastError = ''
  })
  client.on('shardDisconnect', () => {
    runtime.online = false
  })
  client.on('shardResume', () => {
    runtime.online = true
  })
  client.on('error', () => {
    runtime.lastError = 'Discord connection error. Check bot permissions and reconnect.'
  })
  client.on('shardError', () => {
    runtime.online = false
    runtime.lastError = 'Discord gateway error.'
  })
  client.on('messageCreate', message => {
    if (message.author.bot || !client.user || (message.guildId && message.mentions.users.size === 0)) return
    const allowed = config.config.allowedUserIds || []
    if (allowed.length && !allowed.includes(message.author.id)) return
    if (discordUserRateLimited(`${organizationId}:${message.author.id}`)) return
    // Serial capture per tenant preserves message deduplication and independent bot state.
    const queued = (discordCaptures.get(organizationId) || Promise.resolve())
      .catch(() => undefined)
      .then(async () => {
        if (discordRuntimes.get(organizationId) !== runtime) return
        try {
          const count = await discordCapture(message, organizationId)
          if (count) {
            runtime.lastMessageAt = new Date().toISOString()
            runtime.lastError = ''
          }
        } catch {
          runtime.lastError = 'Inquiry could not be saved. Check account storage and retry.'
        }
      })
    discordCaptures.set(organizationId, queued)
    void queued.finally(() => {
      if (discordCaptures.get(organizationId) === queued) discordCaptures.delete(organizationId)
    })
  })
  // Saving settings must not wait for the Gateway handshake.
  void client.login(config.secret).catch(() => {
    runtime.online = false
    runtime.lastError = 'Bot login failed. Check token and Message Content intent.'
  })
}

let reconcilingDiscord = false

export async function reconcileDiscord() {
  if (!supabaseAdmin || reconcilingDiscord) return
  reconcilingDiscord = true
  try {
    const { data, error } = await supabaseAdmin
      .from('tenant_integrations')
      .select('tenant_id,updated_at')
      .eq('integration_type', 'discord')
      .eq('is_enabled', true)
    if (error) throw error
    const enabled = new Set((data || []).map((row: any) => row.tenant_id))
    for (const [id, runtime] of discordRuntimes)
      if (!enabled.has(id)) {
        discordRuntimes.delete(id)
        await runtime.client.destroy()
      }
    for (const row of data || []) {
      const organization = await organizationById(row.tenant_id)
      const runtime = discordRuntimes.get(row.tenant_id)
      if (organization?.status !== 'Active' || runtime?.revision !== row.updated_at || !runtime?.online)
        await reconnectDiscord(row.tenant_id).catch(() => undefined)
    }
  } catch {
    console.warn('Tenant Discord connections unavailable. Check schema-v8 and encrypted integration configuration.')
  } finally {
    reconcilingDiscord = false
  }
}

/** Discord inquiries: status and captured inquiries. */
export function registerDiscordRoutes(app: Express) {
  app.get('/api/integrations/discord/status', requireAuth, requireTenantWorkspace, (req, res) => {
    const user = (req as any).authUser
    if (!moduleAllowed(user, 'settings')) return void res.status(403).json({ error: 'Settings access is required.' })
    res.json(discordStatusPayload(user.organizationId))
  })

  app.get('/api/integrations/discord/inquiries', requireAuth, requireTenantWorkspace, async (req, res) => {
    const user = (req as express.Request & { authUser: SessionUser }).authUser
    if (!moduleAllowed(user, 'inbox') && !moduleAllowed(user, 'items')) {
      res.status(403).json({ error: 'Inbox or Task module access is required.' })
      return
    }
    if (!supabaseAdmin) {
      res.status(503).json({ configured: false, items: [], error: 'Database is not configured.' })
      return
    }
    // Private Discord messages are delivered to Work Hub by the bot. This legacy
    // route must not download tenant_state just to return an empty inquiry list.
    res.json({ configured: true, items: [] })
  })
}
