import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { aiModuleOn, createAiAgentManager, decryptAgentSecret, encryptAgentSecret } from '../server/ai/ai-agent-manager'

process.env.TENANT_INTEGRATION_MASTER_KEY = 'cd'.repeat(32)
const key = 'sk-platform-ai-key-for-everyone-9876'
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

/** A small stand-in for the database: tables of rows, eq filters, maybeSingle, upsert by agent_id, delete. */
function memoryDb(seed: Record<string, any[]>) {
  const tables = new Map(Object.entries(seed).map(([name, rows]) => [name, rows.map(row => ({ ...row }))]))
  return {
    tables,
    from(table: string) {
      if (!tables.has(table)) tables.set(table, [])
      const filters: [string, unknown][] = []
      let op: 'select' | 'upsert' | 'delete' = 'select'
      let payload: any
      let single = false
      const q: any = {
        select: () => q,
        eq: (k: string, v: unknown) => {
          filters.push([k, v])
          return q
        },
        maybeSingle: () => {
          single = true
          return q
        },
        upsert: (v: any) => {
          op = 'upsert'
          payload = v
          return q
        },
        delete: () => {
          op = 'delete'
          return q
        },
        then(resolve: (value: unknown) => void) {
          const rows = tables.get(table)!
          const match = (row: any) => filters.every(([k, v]) => row[k] === v)
          if (op === 'upsert') {
            const at = rows.findIndex(row => row.agent_id === payload.agent_id)
            if (at >= 0) rows[at] = { ...rows[at], ...payload }
            else rows.push({ ...payload })
            return resolve({ data: null, error: null })
          }
          if (op === 'delete') {
            tables.set(
              table,
              rows.filter(row => !match(row)),
            )
            return resolve({ data: null, error: null })
          }
          const found = rows.filter(match)
          return resolve({ data: single ? found[0] || null : found, error: null })
        },
      }
      return q
    },
  }
}

const accounts = [
  { id: 'with-ai', status: 'Active', enabled_modules: ['items', 'ai'] },
  { id: 'no-ai', status: 'Active', enabled_modules: ['items', 'documents'] },
  { id: 'suspended', status: 'Suspended', enabled_modules: ['ai'] },
]

test('one key per agent, set in Internal Admin, serves every account whose AI module is on', async () => {
  const db = memoryDb({ organizations: accounts })
  const ai = createAiAgentManager(db)
  assert.equal(await ai.active('with-ai', 'ba_assistant'), null, 'no key yet')
  await assert.rejects(ai.save('ba_assistant', {}), /Enter an API key/)
  await ai.save('ba_assistant', { secret: key, config: { provider: 'openai', model: 'gpt-5.6-terra' } }, 'Phillip')

  const stored = db.tables.get('platform_ai_agents')![0]
  assert.notEqual(stored.encrypted_secret, key, 'kept encrypted')
  assert.equal(stored.secret_suffix, '9876')
  assert.equal(stored.updated_by, 'Phillip')

  assert.equal((await ai.active('with-ai', 'ba_assistant'))?.secret, key)
  assert.equal(await ai.active('no-ai', 'ba_assistant'), null, 'AI module off: no AI')
  assert.equal(await ai.active('suspended', 'ba_assistant'), null)
  assert.equal(await ai.active('missing', 'ba_assistant'), null)
  assert.equal(await ai.active('with-ai', 'document'), null, 'each agent has its own key')

  const summary = await ai.summary('ba_assistant')
  assert.equal(summary.maskedKey, '••••••••9876')
  assert.ok(!JSON.stringify(summary).includes(key), 'the key is never shown')
  assert.equal(summary.updatedBy, 'Phillip')

  // Turned off: no account gets it. Saving without a key keeps the old one.
  await ai.save('ba_assistant', { enabled: false })
  assert.equal(await ai.active('with-ai', 'ba_assistant'), null)
  await ai.save('ba_assistant', { enabled: true })
  assert.equal((await ai.active('with-ai', 'ba_assistant'))?.secret, key)
  await assert.rejects(
    ai.save('ba_assistant', { config: { provider: 'anthropic', model: 'claude-sonnet-5' } }),
    /needs that provider’s key/,
  )
  await ai.remove('ba_assistant')
  assert.equal(await ai.active('with-ai', 'ba_assistant'), null)
})

test('platform keys are bound to their agent', () => {
  const sealed = encryptAgentSecret(key, 'document')
  assert.equal(decryptAgentSecret(sealed, 'document'), key)
  assert.throws(() => decryptAgentSecret(sealed, 'ba_assistant'))
  assert.equal(aiModuleOn(['ai']), true)
  assert.equal(aiModuleOn(['items']), false)
  assert.equal(aiModuleOn(null), false)
})

test('accounts no longer hold AI keys, and there is no connection test', () => {
  const manager = read('server/ai/ai-agent-manager.ts')
  assert.match(manager, /'\/api\/internal-admin\/ai-agents'/)
  assert.doesNotMatch(manager, /\/api\/account\/ai-agents/)
  assert.doesNotMatch(manager, /\/test'/, 'no Test route')
  assert.match(
    read('server/index.ts'),
    /registerAiAgentRoutes\(app, \{ requireAuth, requirePlatformAdmin, manager: aiAgents \}\)/,
  )
  const settings = read('src/features/settings/Settings.tsx')
  assert.doesNotMatch(settings, /AI Agents|AIAgentManager|ai-agents/)
  const panel = read('src/features/admin/PlatformAiAgents.tsx')
  assert.doesNotMatch(panel, /Test/)
  assert.match(read('src/features/admin/InternalAdmin.tsx'), /<PlatformAiAgents \/>/)
  const migration = read('database/migrations/schema-v44-platform-ai.sql')
  assert.match(migration, /create table if not exists public\.platform_ai_agents/)
  assert.ok(Number(/(\d+) as schema_version/.exec(read('database/schema.sql'))?.[1]) >= 44)
})
