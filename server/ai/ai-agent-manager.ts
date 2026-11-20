import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
/**
 * The AI agents (BA Assistant, Document Agent). Their keys are set once, in Internal Admin › AI, and serve every
 * account that has its AI module on (Internal Admin › the account › Modules). Accounts no longer hold AI keys.
 */
import type { Express, Request, Response, NextFunction } from 'express'
import rateLimit from 'express-rate-limit'
import {
  IntegrationError,
  encryptionKey,
  normalizeAiConfig,
  type AiProvider,
} from '../integrations/tenant-integrations'
export { AI_UNAVAILABLE } from './ai-messages'

export type AiAgentId = 'ba_assistant' | 'document'

export const AI_AGENT_DEFINITIONS: Record<
  AiAgentId,
  {
    id: AiAgentId
    name: string
    shortName: string
    description: string
    defaultConfig: { provider: AiProvider; model: string }
    responsibilities: string[]
    context: string[]
  }
> = {
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
    description:
      'Dedicated document-generation agent for requirements extraction, BRD/FSD creation and document validation.',
    defaultConfig: { provider: 'openai', model: 'gpt-5.6-terra' },
    responsibilities: [
      'Extract requirements',
      'Draft BRD',
      'Build FSD',
      'Validate FSD',
      'Generate test coverage',
      'Map RTM sources',
    ],
    context: ['Uploaded requirement sources', 'Document details', 'Selected presets', 'Template structure'],
  },
}

export function validAgentId(value: unknown): AiAgentId {
  if (value === 'ba_assistant' || value === 'document') return value
  throw new IntegrationError('Unknown AI agent.', 404)
}

function agentAad(agentId: AiAgentId) {
  return `platform:ai-agent:${agentId}:v1`
}

export function encryptAgentSecret(secret: string, agentId: AiAgentId, key = encryptionKey()) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from(agentAad(agentId)))
  const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()])
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), encrypted.toString('base64')].join('.')
}

export function decryptAgentSecret(value: string, agentId: AiAgentId, key = encryptionKey()) {
  try {
    const [version, iv, tag, body] = value.split('.')
    if (version !== 'v1') throw new Error('Unsupported encrypted value')
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'))
    decipher.setAAD(Buffer.from(agentAad(agentId)))
    decipher.setAuthTag(Buffer.from(tag, 'base64'))
    return Buffer.concat([decipher.update(Buffer.from(body, 'base64')), decipher.final()]).toString('utf8')
  } catch {
    throw new IntegrationError(
      'The saved AI key could not be decrypted. Restore the original master key, or enter the key again in Internal Admin › AI.',
      503,
    )
  }
}

const missingTable = (error: any) =>
  error?.code === '42P01' ||
  (/platform_ai_agents/i.test(String(error?.message || '')) &&
    /does not exist|schema cache|not found/i.test(String(error?.message || '')))

export const AI_NEEDS_SCHEMA =
  'AI keys need database schema v44. Run database/migrations/schema-v44-platform-ai.sql, then try again.'

/** Whether an account has AI: its AI module is on (Internal Admin › the account › Modules). */
export function aiModuleOn(modules: unknown) {
  return Array.isArray(modules) && modules.map(String).includes('ai')
}

export function createAiAgentManager(db: any) {
  function database() {
    if (!db) throw new IntegrationError('The database is not configured.', 503)
    return db
  }

  async function agentRow(agentId: AiAgentId) {
    const { data, error } = await database()
      .from('platform_ai_agents')
      .select('*')
      .eq('agent_id', agentId)
      .maybeSingle()
    if (error && missingTable(error)) return { row: null, schemaReady: false }
    if (error) throw new IntegrationError('AI settings are unavailable. Check the database connection.', 503)
    return { row: data, schemaReady: true }
  }

  async function aiOn(tenantId: string) {
    const { data, error } = await database()
      .from('organizations')
      .select('enabled_modules,status')
      .eq('id', tenantId)
      .maybeSingle()
    if (error) throw new IntegrationError('AI settings are unavailable. Check the database connection.', 503)
    return Boolean(data && data.status === 'Active' && aiModuleOn(data.enabled_modules))
  }

  /** An agent as Internal Admin sees it; never the key itself. */
  async function summary(agentId: AiAgentId) {
    const definition = AI_AGENT_DEFINITIONS[agentId]
    const { row, schemaReady } = await agentRow(agentId)
    if (!row)
      return {
        ...definition,
        configured: false,
        enabled: false,
        maskedKey: '',
        config: definition.defaultConfig,
        updatedAt: null,
        updatedBy: '',
        schemaReady,
      }
    return {
      ...definition,
      configured: true,
      enabled: Boolean(row.is_enabled),
      maskedKey: `••••••••${row.secret_suffix}`,
      config: normalizeAiConfig({ provider: row.provider, model: row.model }),
      updatedAt: row.updated_at || null,
      updatedBy: String(row.updated_by || ''),
      schemaReady,
    }
  }

  /** The key and model an account's AI feature uses now, or null: AI off for the account, or no key set. */
  async function active(tenantId: string, agentId: AiAgentId) {
    if (!(await aiOn(tenantId))) return null
    const { row } = await agentRow(agentId)
    if (!row || !row.is_enabled) return null
    return {
      secret: decryptAgentSecret(row.encrypted_secret, agentId),
      config: normalizeAiConfig({ provider: row.provider, model: row.model }),
      revision: row.updated_at,
      agentId,
      inherited: false,
    }
  }

  async function save(agentId: AiAgentId, input: any, actor = '') {
    const definition = AI_AGENT_DEFINITIONS[agentId]
    const { row: previous, schemaReady } = await agentRow(agentId)
    if (!schemaReady) throw new IntegrationError(AI_NEEDS_SCHEMA, 409)
    const config = normalizeAiConfig(
      input?.config || (previous ? { provider: previous.provider, model: previous.model } : definition.defaultConfig),
    )
    let secret = typeof input?.secret === 'string' ? input.secret.trim() : ''
    if (secret && (secret.length < 20 || secret.length > 4096 || /\s/.test(secret)))
      throw new IntegrationError('That doesn’t look like an AI provider key. Paste the whole key.')
    if (!secret && previous) {
      if (normalizeAiConfig({ provider: previous.provider, model: previous.model }).provider !== config.provider)
        throw new IntegrationError('Changing the AI provider needs that provider’s key.')
      secret = decryptAgentSecret(previous.encrypted_secret, agentId)
    }
    if (!secret) throw new IntegrationError(`Enter an API key for the ${definition.name}.`)
    const record = {
      agent_id: agentId,
      provider: config.provider,
      model: config.model,
      encrypted_secret: encryptAgentSecret(secret, agentId),
      secret_suffix: secret.slice(-4),
      is_enabled: typeof input?.enabled === 'boolean' ? input.enabled : (previous?.is_enabled ?? true),
      updated_by: String(actor || '').slice(0, 200),
      updated_at: new Date().toISOString(),
    }
    const { error } = await database().from('platform_ai_agents').upsert(record, { onConflict: 'agent_id' })
    if (error) throw new IntegrationError('The AI settings could not be saved. Check the database connection.', 503)
    return summary(agentId)
  }

  async function remove(agentId: AiAgentId) {
    const { schemaReady } = await agentRow(agentId)
    if (!schemaReady) throw new IntegrationError(AI_NEEDS_SCHEMA, 409)
    const { error } = await database().from('platform_ai_agents').delete().eq('agent_id', agentId)
    if (error) throw new IntegrationError('The AI key could not be removed.', 503)
  }

  return { active, summary, save, remove }
}

type Middleware = (req: Request, res: Response, next: NextFunction) => any

/** Internal Admin › AI: one key per agent, for every account with AI on. There is no connection test. */
export function registerAiAgentRoutes(
  app: Express,
  deps: {
    requireAuth: Middleware
    requirePlatformAdmin: Middleware
    manager: ReturnType<typeof createAiAgentManager>
  },
) {
  const wrap =
    (fn: (req: Request, res: Response) => Promise<any>): Middleware =>
    async (req, res) => {
      res.setHeader('Cache-Control', 'no-store')
      try {
        await fn(req, res)
      } catch (e) {
        res
          .status(e instanceof IntegrationError ? e.status : 503)
          .json({ error: e instanceof IntegrationError ? e.message : 'The AI settings are unavailable right now.' })
      }
    }
  const limiter = rateLimit({
    windowMs: 60000,
    limit: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many settings requests. Wait a minute and retry.' },
  })
  const scope = [deps.requireAuth, deps.requirePlatformAdmin, limiter]
  const agent = (req: Request) => validAgentId(req.params.agentId)

  app.get(
    '/api/internal-admin/ai-agents',
    ...scope,
    wrap(async (_req, res) => {
      const agents = await Promise.all(
        (Object.keys(AI_AGENT_DEFINITIONS) as AiAgentId[]).map(agentId => deps.manager.summary(agentId)),
      )
      let encryptionReady = true
      try {
        encryptionKey()
      } catch {
        encryptionReady = false
      }
      res.json({ agents, schemaReady: agents.every(item => item.schemaReady), encryptionReady })
    }),
  )
  app.put(
    '/api/internal-admin/ai-agents/:agentId',
    ...scope,
    wrap(async (req, res) => {
      const actor = (req as any).authUser
      res.json(await deps.manager.save(agent(req), req.body || {}, actor?.name || actor?.username || 'Internal Admin'))
    }),
  )
  app.delete(
    '/api/internal-admin/ai-agents/:agentId',
    ...scope,
    wrap(async (req, res) => {
      await deps.manager.remove(agent(req))
      res.json({ ok: true })
    }),
  )
}
