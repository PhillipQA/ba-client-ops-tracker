import test from 'node:test'
import assert from 'node:assert/strict'
import { createPostgresClient } from '../server/postgres-client'

function fakeDatabase(jsonColumns: string[] = []) {
  const queries: { sql: string; params: unknown[] }[] = []
  const pool = { async query(sql: string, params: unknown[] = []) {
    queries.push({ sql, params })
    if (sql.includes('information_schema.columns')) return { rows: [{ column_name: 'id', data_type: 'uuid' }, ...jsonColumns.map(column_name => ({ column_name, data_type: 'jsonb' }))] }
    if (sql.includes('pg_index')) return { rows: [{ attname: 'id' }] }
    if (sql.includes('count(*)')) return { rows: [{ n: 2 }] }
    return { rows: [{ id: 'a', labels: ['bug'] }] }
  } }
  return { client: createPostgresClient('postgresql://unused', pool as any), queries }
}

test('PostgreSQL mode uses JSONB containment and count for a filtered GitLab page', async () => {
  const { client, queries } = fakeDatabase(['labels'])
  const result = await client.from('user_gitlab_issues').select('*', { count: 'exact', head: true }).eq('tenant_id', 'tenant-1').contains('labels', ['bug'])
  assert.equal(result.count, 2)
  assert.equal(result.error, null)
  const count = queries.find(item => item.sql.includes('count(*)'))!
  assert.match(count.sql, /"labels" @> \$2/)
  assert.deepEqual(count.params, ['tenant-1', '["bug"]'])
})

test('PostgreSQL mode preserves SQL array containment for Gmail labels', async () => {
  const { client, queries } = fakeDatabase()
  await client.from('user_communications').select('*').contains('source_labels', ['Inbox'])
  const read = queries.find(item => item.sql.startsWith('SELECT *'))!
  assert.deepEqual(read.params, [['Inbox']])
})

test('PostgreSQL mode passes workspace state as JSON to the atomic save function', async () => {
  const { client, queries } = fakeDatabase()
  await client.rpc('save_tenant_state_v16', { p_state: { items: [] }, p_reason: 'test' })
  const save = queries.find(item => item.sql.includes('save_tenant_state_v16'))!
  assert.match(save.sql, /"p_state" => \$1/)
  assert.deepEqual(save.params, ['{"items":[]}', 'test'])
})

test('DocHub task filters read the task ID from JSON', async () => {
  const { client, queries } = fakeDatabase(['data'])
  await client.from('tenant_dochub_documents').select('id').eq('tenant_id', 'tenant-1').eq('data->>taskId', 'task-1')
  const read = queries.find(item => item.sql.startsWith('SELECT "id"'))!
  assert.match(read.sql, /\("data"->>'taskId'\) = \$2/)
  assert.deepEqual(read.params, ['tenant-1', 'task-1'])
})
