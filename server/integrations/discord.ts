import { Client as DiscordClient, GatewayIntentBits, Partials } from 'discord.js'
import type express from 'express'
import type { Express } from 'express'
import { moduleAllowed, requireAuth, requireTenantWorkspace, type SessionUser } from '../core/auth'
import { db } from '../core/database'
import { integrations } from '../core/services'
import { organizationById } from '../core/tenant-state'

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
  if (!db || reconcilingDiscord) return
  reconcilingDiscord = true
  try {
    const { data, error } = await db
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
    console.warn(
      'Tenant Discord connections unavailable. Check the database connection and the encrypted integration settings.',
    )
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
    if (!db) {
      res.status(503).json({ configured: false, items: [], error: 'Database is not configured.' })
      return
    }
    // Private Discord messages are delivered to Work Hub by the bot. This legacy
    // route must not download tenant_state just to return an empty inquiry list.
    res.json({ configured: true, items: [] })
  })
}
