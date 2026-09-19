import type { Express } from 'express'
import { APP_VERSION } from './src/version'
import { encryptionKey, IntegrationError } from './tenant-integrations'

export function registerPlatformSettings(app: Express, d: any) {
  const scope = [d.requireAuth, d.requirePlatformAdmin]
  const wrap = (fn: any) => async (req: any, res: any) => {
    res.setHeader('Cache-Control', 'no-store')
    try { await fn(req, res) } catch (e) { res.status(e instanceof IntegrationError ? e.status : 503).json({ error: e instanceof IntegrationError ? e.message : 'Platform settings unavailable. Check the database and migrations.' }) }
  }
  const organization = async (req: any) => {
    const org = await d.organizationById(String(req.params.id || ''))
    if (!org) throw new IntegrationError('Choose an existing account.', 404)
    return org
  }
  app.get('/api/internal-admin/system', ...scope, wrap(async (_req: any, res: any) => {
    let encryptionReady = true; try { encryptionKey() } catch { encryptionReady = false }
    let integrationsReady = false
    let health: any[] = []
    if (d.db) {
      const { data, error } = await d.db.from('tenant_integrations').select('tenant_id,integration_type,is_enabled,connection_status,last_tested_at')
      integrationsReady = !error; health = data || []
    }
    res.json({ version: APP_VERSION, supabaseConfigured: Boolean(d.db), encryptionReady, integrationsReady, health,
      legacy: { discord: Boolean(process.env.DISCORD_BOT_TOKEN), openai: Boolean(process.env.OPENAI_API_KEY) } })
  }))
  app.get('/api/internal-admin/organizations/:id/system', ...scope, wrap(async (req: any, res: any) => {
    const org = await organization(req), state = await d.loadTenantState(org.id)
    res.json({ taskSettings: state.data?.taskSettings || d.defaultTaskSettings, sync: await d.normalizedSchemaStatus(org.id) })
  }))
  app.put('/api/internal-admin/organizations/:id/task-settings', ...scope, wrap(async (req: any, res: any) => {
    const org = await organization(req), state = await d.loadTenantState(org.id)
    if (!state.data) throw new IntegrationError('This account has no saved workspace yet.')
    const input = req.body
    const columns = ['status','client','project','type','waitingOn','priority','owner','dueDate','followUpDate']
    if (!Array.isArray(input?.statuses) || !input.statuses.length || input.statuses.length > 60 || !Array.isArray(input.visibleColumns)) throw new IntegrationError('Provide statuses and visible columns.')
    const statuses = input.statuses.map((s: any) => ({ id: String(s.id || '').slice(0,100), label: String(s.label || '').trim().slice(0,80), closed: Boolean(s.closed) }))
    if (statuses.some((s: any) => !s.id || !s.label) || new Set(statuses.map((s: any) => s.id)).size !== statuses.length || new Set(statuses.map((s: any) => s.label.toLowerCase())).size !== statuses.length || statuses.every((s: any) => s.closed)) throw new IntegrationError('Use unique status IDs and labels, with at least one open status.')
    const labels = new Set(statuses.map((s: any) => s.label))
    if ((state.data.items || []).some((item: any) => !labels.has(item.status))) throw new IntegrationError('A status used by existing tasks cannot be removed or renamed.')
    if (input.visibleColumns.some((c: any) => !columns.includes(c))) throw new IntegrationError('Unknown task column.')
    const taskSettings = { statuses, visibleColumns: [...new Set(['status', ...input.visibleColumns])] }
    await d.commitTenantState(org.id, { ...state.data, taskSettings }, req.authUser, 'platform-task-settings', state.data)
    res.json({ ok: true, taskSettings })
  }))
  app.post('/api/internal-admin/organizations/:id/import-legacy/:kind', ...scope, wrap(async (req: any, res: any) => {
    const org = await organization(req), kind = String(req.params.kind)
    if (!['discord','openai'].includes(kind)) throw new IntegrationError('Unknown integration.', 404)
    if (org.status !== 'Active') throw new IntegrationError('Select an active account.')
    const secret = kind === 'discord' ? process.env.DISCORD_BOT_TOKEN : process.env.OPENAI_API_KEY
    if (!secret) throw new IntegrationError('No legacy environment credential is available.')
    const config = kind === 'discord' ? { allowedUserIds: process.env.DISCORD_ALLOWED_USER_IDS || '' } : { model: process.env.OPENAI_MODEL || 'gpt-5.6-terra' }
    // Explicit tenant selection only. Keep disabled until the account admin reviews it.
    await d.integrations.save(org.id, kind, { secret, config, enabled: false }, true)
    res.json({ ok: true, message: 'Imported encrypted and disabled. Sign in to this account to test and enable it. The environment variable was not removed.' })
  }))
}
