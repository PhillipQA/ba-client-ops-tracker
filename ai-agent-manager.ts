import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import type { Express, Request, Response, NextFunction } from 'express'
import rateLimit from 'express-rate-limit'
import {
  IntegrationError,
  aiProviderName,
  createAiClient,
  encryptionKey,
  normalizeAiConfig,
  type AiProvider,
  type createIntegrationStore,
} from './tenant-integrations'

export type AiAgentId = 'ba_assistant' | 'document'

export const AI_AGENT_DEFINITIONS: Record<AiAgentId, {
  id: AiAgentId
  name: string
  shortName: string
  description: string
  defaultConfig: { provider: AiProvider; model: string }
  responsibilities: string[]
  context: string[]
}> = {
  ba_assistant: {
    id: 'ba_assistant',
    name: 'BA Assistant',
    shortName: 'BA Assistant',
    description: 'Conversational Business Analyst support for client, project, task, activity and inquiry work.',
    defaultConfig: { provider: 'gemini', model: 'gemini-3.8-flash' },
    responsibilities: ['Assess inquiries', 'Review work', 'Draft updates', 'Suggest follow-ups'],
    context: ['Authorized clients', 'Projects', 'Tasks', 'Activities', 'User work history'],
  },
  document: {
    id: 'document',
    name: 'Document Agent',
    shortName: 'Document Agent',
    description: 'Dedicated document-generation agent for requirements extraction, FSD creation and document validation.',
    defaultConfig: { provider: 'openai', model: 'gpt-5.6-terra' },
    responsibilities: ['Extract requirements', 'Build FSD', 'Validate FSD', 'Generate test coverage'],
    context: ['Uploaded requirement sources', 'Document details', 'Selected presets', 'Template structure'],
  },
}

function validAgentId(value: unknown): AiAgentId {
  if (value === 'ba_assistant' || value === 'document') return value
  throw new IntegrationError('Unknown AI agent.', 404)
}

function agentAad(tenantId: string, agentId: AiAgentId) {
  return `${tenantId}:ai-agent:${agentId}:v1`
}

function encryptAgentSecret(secret: string, tenantId: string, agentId: AiAgentId, key = encryptionKey()) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from(agentAad(tenantId, agentId)))
  const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()])
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), encrypted.toString('base64')].join('.')
}

function decryptAgentSecret(value: string, tenantId: string, agentId: AiAgentId, key = encryptionKey()) {
  try {
    const [version, iv, tag, body] = value.split('.')
    if (version !== 'v1') throw new Error('Unsupported encrypted value')
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'))
    decipher.setAAD(Buffer.from(agentAad(tenantId, agentId)))
    decipher.setAuthTag(Buffer.from(tag, 'base64'))
    return Buffer.concat([decipher.update(Buffer.from(body, 'base64')), decipher.final()]).toString('utf8')
  } catch {
    throw new IntegrationError('Stored AI agent credential could not be decrypted. Restore the original master key or replace this credential.', 503)
  }
}

function missingAgentTable(error: any) {
  return error?.code === '42P01' || /tenant_ai_agents/i.test(String(error?.message || '')) && /does not exist|schema cache|not found/i.test(String(error?.message || ''))
}

export function createAiAgentManager(db: any, legacy: ReturnType<typeof createIntegrationStore>) {
  function database() {
    if (!db) throw new IntegrationError('Supabase is not configured.', 503)
    return db
  }

  async function dedicatedRow(tenantId: string, agentId: AiAgentId) {
    const { data, error } = await database().from('tenant_ai_agents').select('*').eq('tenant_id', tenantId).eq('agent_id', agentId).maybeSingle()
    if (error && missingAgentTable(error)) return { row: null, schemaReady: false }
    if (error) throw new IntegrationError('AI Agent storage is unavailable. Check Supabase and apply schema-v11-ai-agent-manager.sql.', 503)
    return { row: data, schemaReady: true }
  }

  async function schemaReady() {
    const { error } = await database().from('tenant_ai_agents').select('tenant_id').limit(1)
    if (error && missingAgentTable(error)) return false
    if (error) throw new IntegrationError('AI Agent storage is unavailable.', 503)
    return true
  }

  async function summary(tenantId: string, agentId: AiAgentId) {
    const definition = AI_AGENT_DEFINITIONS[agentId]
    const dedicated = await dedicatedRow(tenantId, agentId)
    if (dedicated.row) {
      const config = normalizeAiConfig({ provider: dedicated.row.provider, model: dedicated.row.model })
      return {
        ...definition,
        configured: true,
        inherited: false,
        enabled: Boolean(dedicated.row.is_enabled),
        maskedKey: `••••••••${dedicated.row.secret_suffix}`,
        config,
        connectionStatus: dedicated.row.connection_status || 'untested',
        lastTestedAt: dedicated.row.last_tested_at || null,
        schemaReady: dedicated.schemaReady,
      }
    }

    let legacyRow: any = null
    try { legacyRow = await legacy.row(tenantId, 'openai') } catch { /* surfaced by integrations status elsewhere */ }
    if (legacyRow) {
      return {
        ...definition,
        configured: false,
        inherited: true,
        enabled: Boolean(legacyRow.is_enabled),
        maskedKey: `••••••••${legacyRow.secret_suffix}`,
        config: normalizeAiConfig(legacyRow.config_json),
        connectionStatus: legacyRow.connection_status || 'untested',
        lastTestedAt: legacyRow.last_tested_at || null,
        schemaReady: dedicated.schemaReady,
      }
    }

    return {
      ...definition,
      configured: false,
      inherited: false,
      enabled: false,
      maskedKey: '',
      config: definition.defaultConfig,
      connectionStatus: 'not_configured',
      lastTestedAt: null,
      schemaReady: dedicated.schemaReady,
    }
  }

  async function active(tenantId: string, agentId: AiAgentId) {
    const dedicated = await dedicatedRow(tenantId, agentId)
    if (dedicated.row) {
      if (!dedicated.row.is_enabled) return null
      return {
        secret: decryptAgentSecret(dedicated.row.encrypted_secret, tenantId, agentId),
        config: normalizeAiConfig({ provider: dedicated.row.provider, model: dedicated.row.model }),
        revision: dedicated.row.updated_at,
        agentId,
        inherited: false,
      }
    }
    const fallback = await legacy.active(tenantId, 'openai')
    return fallback ? { ...fallback, agentId, inherited: true } : null
  }

  async function save(tenantId: string, agentId: AiAgentId, input: any) {
    if (!await schemaReady()) throw new IntegrationError('Apply supabase/schema-v11-ai-agent-manager.sql before saving separate AI agents.', 503)
    const definition = AI_AGENT_DEFINITIONS[agentId]
    const current = await dedicatedRow(tenantId, agentId)
    const previous = current.row
    const config = normalizeAiConfig(input?.config || (previous ? { provider: previous.provider, model: previous.model } : definition.defaultConfig))
    let secret = typeof input?.secret === 'string' ? input.secret.trim() : ''
    if (secret && (secret.length < 20 || secret.length > 4096 || /\s/.test(secret))) throw new IntegrationError('The AI provider credential format is invalid.')

    if (!secret && previous) {
      const previousConfig = normalizeAiConfig({ provider: previous.provider, model: previous.model })
      if (previousConfig.provider !== config.provider) throw new IntegrationError('Changing AI provider requires that provider’s API key.')
      secret = decryptAgentSecret(previous.encrypted_secret, tenantId, agentId)
    }

    if (!secret && !previous) {
      const inherited = await legacy.active(tenantId, 'openai')
      if (!inherited) throw new IntegrationError('Enter an API key for this AI agent.')
      const inheritedConfig = normalizeAiConfig(inherited.config)
      if (inheritedConfig.provider !== config.provider) throw new IntegrationError('Changing from the inherited AI provider requires the new provider’s API key.')
      secret = inherited.secret
    }

    const now = new Date().toISOString()
    const record = {
      tenant_id: tenantId,
      agent_id: agentId,
      provider: config.provider,
      model: config.model,
      encrypted_secret: encryptAgentSecret(secret, tenantId, agentId),
      secret_suffix: secret.slice(-4),
      is_enabled: typeof input?.enabled === 'boolean' ? input.enabled : previous?.is_enabled ?? true,
      connection_status: 'untested',
      last_tested_at: null,
      updated_at: now,
    }
    const { error } = await database().from('tenant_ai_agents').upsert(record, { onConflict: 'tenant_id,agent_id' })
    if (error) throw new IntegrationError('Could not save this AI agent. Apply schema-v11-ai-agent-manager.sql and retry.', 503)
    return summary(tenantId, agentId)
  }

  async function remove(tenantId: string, agentId: AiAgentId) {
    if (!await schemaReady()) throw new IntegrationError('AI Agent storage is not installed.', 503)
    const { error } = await database().from('tenant_ai_agents').delete().eq('tenant_id', tenantId).eq('agent_id', agentId)
    if (error) throw new IntegrationError('Could not remove the AI agent configuration.', 503)
  }

  async function test(tenantId: string, agentId: AiAgentId) {
    const dedicated = await dedicatedRow(tenantId, agentId)
    if (!dedicated.row) {
      const inherited = await legacy.row(tenantId, 'openai')
      if (!inherited) throw new IntegrationError('Save an API key for this agent before testing.')
      const result = await legacy.test(tenantId, 'openai')
      return { ...result, inherited: true }
    }

    const record = dedicated.row
    const secret = decryptAgentSecret(record.encrypted_secret, tenantId, agentId)
    const config = normalizeAiConfig({ provider: record.provider, model: record.model })
    const ai = createAiClient(secret, config, 15000)
    let ok = false
    try {
      if (ai.provider === 'anthropic') {
        const response = await fetch(`https://api.anthropic.com/v1/models/${encodeURIComponent(ai.model)}`, {
          headers: { 'x-api-key': secret, 'anthropic-version': '2023-06-01' },
          signal: AbortSignal.timeout(15000), redirect: 'error',
        })
        ok = response.ok
      } else if (ai.provider === 'deepseek') {
        const models = await ai.client.models.list(); ok = models.data.some(model => model.id === ai.model)
      } else {
        await ai.client.models.retrieve(ai.model); ok = true
      }
    } catch { ok = false }

    const testedAt = new Date().toISOString()
    const { error } = await database().from('tenant_ai_agents').update({ connection_status: ok ? 'verified' : 'failed', last_tested_at: testedAt })
      .eq('tenant_id', tenantId).eq('agent_id', agentId).eq('updated_at', record.updated_at).eq('encrypted_secret', record.encrypted_secret)
    if (error) throw new IntegrationError('Could not update the AI agent connection status.', 503)
    return {
      ok,
      message: ok ? `${AI_AGENT_DEFINITIONS[agentId].name}: ${aiProviderName(config)} credential and ${config.model} access verified.` : `${AI_AGENT_DEFINITIONS[agentId].name} connection test failed. Check the API key, provider, model access, quota, and network connection.`,
    }
  }

  return { active, summary, save, remove, test, schemaReady }
}

type Middleware = (req: Request, res: Response, next: NextFunction) => any

export function registerAiAgentRoutes(app: Express, deps: {
  requireAuth: Middleware
  requireTenant: Middleware
  organizationById: (id: string) => Promise<any>
  manager: ReturnType<typeof createAiAgentManager>
}) {
  const guard: Middleware = async (req, res, next) => {
    try {
      const user = (req as any).authUser
      const org = await deps.organizationById(user.organizationId)
      if (!org || org.status !== 'Active') return void res.status(403).json({ error: 'This account is unavailable.' })
      if (user.role !== 'Administrator' || !user.modules.includes('settings')) return void res.status(403).json({ error: 'Account administrator with Settings access is required.' })
      res.setHeader('Cache-Control', 'no-store')
      next()
    } catch { res.status(503).json({ error: 'AI Agent settings are unavailable.' }) }
  }
  const wrap = (fn: (req: Request, res: Response) => Promise<any>): Middleware => async (req, res) => {
    try { await fn(req, res) } catch (e) { res.status(e instanceof IntegrationError ? e.status : 503).json({ error: e instanceof IntegrationError ? e.message : 'Could not complete AI Agent settings.' }) }
  }
  const limiter = rateLimit({ windowMs: 60000, limit: 60, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many settings requests. Wait a minute and retry.' } })
  const scope = [deps.requireAuth, deps.requireTenant, guard, limiter]
  const tenant = (req: Request) => (req as any).authUser.organizationId as string
  const agent = (req: Request) => validAgentId(req.params.agentId)

  app.get('/api/account/ai-agents', ...scope, wrap(async (req, res) => {
    const id = tenant(req)
    const agents = await Promise.all((Object.keys(AI_AGENT_DEFINITIONS) as AiAgentId[]).map(agentId => deps.manager.summary(id, agentId)))
    let encryptionReady = true; try { encryptionKey() } catch { encryptionReady = false }
    res.json({ agents, schemaReady: agents.every(item => item.schemaReady), encryptionReady })
  }))
  app.put('/api/account/ai-agents/:agentId', ...scope, wrap(async (req, res) => { res.json(await deps.manager.save(tenant(req), agent(req), req.body || {})) }))
  app.delete('/api/account/ai-agents/:agentId', ...scope, wrap(async (req, res) => { await deps.manager.remove(tenant(req), agent(req)); res.json({ ok: true }) }))
  app.post('/api/account/ai-agents/:agentId/test', ...scope, wrap(async (req, res) => { res.json(await deps.manager.test(tenant(req), agent(req))) }))
}
