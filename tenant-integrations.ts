import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import type { Express, Request, Response, NextFunction } from 'express'
import OpenAI from 'openai'
import PizZip from 'pizzip'
import rateLimit from 'express-rate-limit'

export type IntegrationKind = 'discord' | 'openai'
export class IntegrationError extends Error {
  constructor(message: string, public status = 400) { super(message) }
}
export function encryptionKey(value = process.env.TENANT_INTEGRATION_MASTER_KEY || '') {
  if (!/^[a-fA-F0-9]{64}$/.test(value)) throw new IntegrationError('Integration storage needs a 64-character hex TENANT_INTEGRATION_MASTER_KEY on the server.', 503)
  return Buffer.from(value, 'hex')
}
export function encryptSecret(secret: string, tenantId: string, kind: IntegrationKind, key = encryptionKey()) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from(`${tenantId}:${kind}:v1`))
  const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()])
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), encrypted.toString('base64')].join('.')
}
export function decryptSecret(value: string, tenantId: string, kind: IntegrationKind, key = encryptionKey()) {
  try {
    const [version, iv, tag, body] = value.split('.')
    if (version !== 'v1') throw new Error()
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'))
    decipher.setAAD(Buffer.from(`${tenantId}:${kind}:v1`))
    decipher.setAuthTag(Buffer.from(tag, 'base64'))
    return Buffer.concat([decipher.update(Buffer.from(body, 'base64')), decipher.final()]).toString('utf8')
  } catch { throw new IntegrationError('Stored credential could not be decrypted. Restore the original master key or replace this credential.', 503) }
}
export function integrationSummary(row: any, kind: IntegrationKind) {
  return { kind, configured: Boolean(row), maskedKey: row ? `••••••••${row.secret_suffix}` : '', enabled: row?.is_enabled ?? false,
    config: row?.config_json || (kind === 'openai' ? { model: 'gpt-5.6-terra' } : { allowedUserIds: [] }),
    connectionStatus: row?.connection_status || 'not_configured', lastTestedAt: row?.last_tested_at || null }
}
export function cleanIntegrationConfig(kind: IntegrationKind, input: any) {
  if (kind === 'openai') {
    const model = String(input?.model || 'gpt-5.6-terra').trim()
    if (!/^[a-zA-Z0-9._:-]{1,100}$/.test(model)) throw new IntegrationError('Enter a valid OpenAI model ID.')
    return { model }
  }
  const ids = Array.isArray(input?.allowedUserIds) ? input.allowedUserIds : String(input?.allowedUserIds || '').split(',')
  const allowedUserIds: string[] = [...new Set<string>(ids.map((id: any) => String(id).trim()).filter(Boolean))]
  if (allowedUserIds.length > 200 || allowedUserIds.some(id => !/^\d{15,22}$/.test(id))) throw new IntegrationError('Enter Discord user IDs separated by commas (up to 200).')
  return { allowedUserIds }
}
export function createIntegrationStore(db: any) {
  function database() { if (!db) throw new IntegrationError('Supabase is not configured.', 503); return db }
  function check(error: any) {
    if (!error) return
    if (error.code === '23505') throw new IntegrationError('This Discord bot is already assigned to another account.', 409)
    throw new IntegrationError('Integration storage is unavailable. Check the connection and apply schema-v8-tenant-integrations.sql.', 503)
  }
  async function row(tenantId: string, kind: IntegrationKind) {
    const { data, error } = await database().from('tenant_integrations').select('*').eq('tenant_id', tenantId).eq('integration_type', kind).maybeSingle()
    check(error); return data
  }
  async function active(tenantId: string, kind: IntegrationKind) {
    const record = await row(tenantId, kind)
    return record?.is_enabled ? { secret: decryptSecret(record.encrypted_secret, tenantId, kind), config: record.config_json, revision: record.updated_at } : null
  }
  async function save(tenantId: string, kind: IntegrationKind, input: any, insertOnly = false) {
    const previous = await row(tenantId, kind)
    if (insertOnly && previous) throw new IntegrationError('This account already has this integration. Nothing was overwritten.', 409)
    const secret = typeof input.secret === 'string' ? input.secret.trim() : ''
    if (!secret && !previous) throw new IntegrationError('Enter a credential first.')
    if (secret && (secret.length < 20 || secret.length > 4096 || /\s/.test(secret))) throw new IntegrationError('The credential format is invalid.')
    const config = cleanIntegrationConfig(kind, input.config ?? previous?.config_json)
    let identity = previous?.provider_identity || null
    if (secret && kind === 'discord') {
      const response = await fetch('https://discord.com/api/v10/users/@me', { headers: { Authorization: `Bot ${secret}` }, signal: AbortSignal.timeout(15000) })
      if (!response.ok) throw new IntegrationError('Discord could not verify this bot token. Check the token and retry.', 400)
      const bot: any = await response.json()
      if (!bot.bot || !bot.id) throw new IntegrationError('A Discord bot token is required.')
      identity = String(bot.id)
    }
    const record = { tenant_id: tenantId, integration_type: kind,
      encrypted_secret: secret ? encryptSecret(secret, tenantId, kind) : previous.encrypted_secret,
      secret_suffix: secret ? secret.slice(-4) : previous.secret_suffix, provider_identity: identity,
      config_json: config, is_enabled: typeof input.enabled === 'boolean' ? input.enabled : previous?.is_enabled ?? true,
      connection_status: 'untested', last_tested_at: null, updated_at: new Date().toISOString() }
    const query = database().from('tenant_integrations')
    const { error } = await (insertOnly ? query.insert(record) : query.upsert(record, { onConflict: 'tenant_id,integration_type' }))
    check(error); return integrationSummary(record, kind)
  }
  async function remove(tenantId: string, kind: IntegrationKind) {
    const { error } = await database().from('tenant_integrations').delete().eq('tenant_id', tenantId).eq('integration_type', kind); check(error)
  }
  async function test(tenantId: string, kind: IntegrationKind) {
    const record = await row(tenantId, kind)
    if (!record) throw new IntegrationError('Save a credential before testing.')
    const secret = decryptSecret(record.encrypted_secret, tenantId, kind)
    let ok = false
    try {
      if (kind === 'discord') {
        const response = await fetch('https://discord.com/api/v10/users/@me', { headers: { Authorization: `Bot ${secret}` }, signal: AbortSignal.timeout(15000) }); ok = response.ok
      } else {
        await new OpenAI({ apiKey: secret, timeout: 15000, maxRetries: 0 }).models.retrieve(record.config_json.model); ok = true
      }
    } catch { ok = false }
    // A late test must never change the health of a replacement credential.
    const { error } = await database().from('tenant_integrations').update({ connection_status: ok ? 'verified' : 'failed', last_tested_at: new Date().toISOString() })
      .eq('tenant_id', tenantId).eq('integration_type', kind).eq('updated_at', record.updated_at).eq('encrypted_secret', record.encrypted_secret)
    check(error)
    return { ok, message: ok ? (kind === 'openai' ? 'Credential and model access verified. Generation quota is checked when AI runs.' : 'Bot token verified. Gateway status is shown separately.') : 'Connection test failed. Check the credential, model access, and network connection.' }
  }
  return { row, active, save, remove, test }
}

type Middleware = (req: Request, res: Response, next: NextFunction) => any
export function registerIntegrationRoutes(app: Express, deps: { db: any; requireAuth: Middleware; requireTenant: Middleware; organizationById: (id: string) => Promise<any>; store: ReturnType<typeof createIntegrationStore>; reconnect: (id: string) => Promise<void>; status: (id: string) => any }) {
  const { db, store } = deps
  const guard: Middleware = async (req, res, next) => {
    try {
      const user = (req as any).authUser
      const org = await deps.organizationById(user.organizationId)
      if (!org || org.status !== 'Active') return void res.status(403).json({ error: 'This account is unavailable.' })
      const templateRead = req.method === 'GET' && req.path.includes('/templates')
      if (templateRead ? !user.modules.includes('documents') && !user.modules.includes('settings') : user.role !== 'Administrator' || !user.modules.includes('settings')) {
        return void res.status(403).json({ error: 'Account administrator with Settings access is required.' })
      }
      res.setHeader('Cache-Control', 'no-store'); next()
    } catch { res.status(503).json({ error: 'Account settings are unavailable.' }) }
  }
  const wrap = (fn: (req: Request, res: Response) => Promise<any>): Middleware => async (req, res) => {
    try { await fn(req, res) } catch (e) { res.status(e instanceof IntegrationError ? e.status : 503).json({ error: e instanceof IntegrationError ? e.message : 'Could not complete integration settings. Retry when the service is available.' }) }
  }
  const limiter = rateLimit({ windowMs: 60000, limit: 60, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many settings requests. Wait a minute and retry.' } })
  const scope = [deps.requireAuth, deps.requireTenant, guard, limiter]
  const tenant = (req: Request) => (req as any).authUser.organizationId as string
  const kind = (req: Request): IntegrationKind => { if (!['discord', 'openai'].includes(String(req.params.kind))) throw new IntegrationError('Unknown integration.', 404); return req.params.kind as IntegrationKind }
  app.get('/api/account/integrations', ...scope, wrap(async (req, res) => {
    const id = tenant(req)
    const rows = await Promise.all((['discord','openai'] as const).map(async k => integrationSummary(await store.row(id, k), k)))
    let encryptionReady = true; try { encryptionKey() } catch { encryptionReady = false }
    res.json({ integrations: rows, discord: deps.status(id), encryptionReady })
  }))
  app.put('/api/account/integrations/:kind', ...scope, wrap(async (req, res) => {
    const k = kind(req), id = tenant(req)
    const result = await store.save(id, k, req.body || {})
    if (k === 'discord') await deps.reconnect(id)
    res.json(result)
  }))
  app.delete('/api/account/integrations/:kind', ...scope, wrap(async (req, res) => {
    const k = kind(req), id = tenant(req); await store.remove(id, k)
    if (k === 'discord') await deps.reconnect(id)
    res.json({ ok: true })
  }))
  app.post('/api/account/integrations/:kind/test', ...scope, wrap(async (req, res) => { res.json(await store.test(tenant(req), kind(req))) }))
  app.get('/api/account/templates', ...scope, wrap(async (req, res) => {
    const { data, error } = await db.from('tenant_templates').select('name,content_base64,updated_at').eq('tenant_id', tenant(req)).maybeSingle()
    if (error) throw new IntegrationError('Apply schema-v8-tenant-integrations.sql to enable saved templates.', 503)
    res.json({ template: data })
  }))
  app.put('/api/account/templates', ...scope, wrap(async (req, res) => {
    const name = String(req.body?.name || '').replace(/[\\/]/g, '_').slice(0,180)
    const content = String(req.body?.content_base64 || '')
    if (!/\.xlsx$/i.test(name) || !/^[A-Za-z0-9+/]+={0,2}$/.test(content) || content.length > 7 * 1024 * 1024) throw new IntegrationError('Upload an Excel .xlsx DRF template up to 5 MB.')
    const bytes = Buffer.from(content, 'base64')
    if (bytes.length > 5 * 1024 * 1024 || bytes.subarray(0,2).toString() !== 'PK') throw new IntegrationError('Upload a valid Excel workbook up to 5 MB.')
    try { const zip = new PizZip(bytes); if (!zip.file('[Content_Types].xml') || !zip.file('xl/workbook.xml')) throw new Error() } catch { throw new IntegrationError('The file is not a valid Excel workbook.') }
    const { error } = await db.from('tenant_templates').upsert({ tenant_id: tenant(req), name, content_base64: content, updated_at: new Date().toISOString() })
    if (error) throw new IntegrationError('Could not save the account template.', 503)
    res.json({ ok: true })
  }))
  app.delete('/api/account/templates', ...scope, wrap(async (req, res) => {
    const { error } = await db.from('tenant_templates').delete().eq('tenant_id', tenant(req)); if (error) throw new IntegrationError('Could not remove the account template.', 503)
    res.json({ ok: true })
  }))
}
