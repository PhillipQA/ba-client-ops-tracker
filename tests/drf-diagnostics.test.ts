import assert from 'node:assert/strict'
import { test } from 'node:test'
import { recordDrfError, safeDrfMessage } from '../server/documents/drf-diagnostics'

test('DRF diagnostics save scoped metadata without document values or credentials', async () => {
  let saved: any
  const db = {
    from: (table: string) => {
      assert.equal(table, 'drf_error_logs')
      return {
        insert: async (row: any) => {
          saved = row
          return { error: null }
        },
      }
    },
  }
  const id = await recordDrfError(
    db,
    { tenantId: 'tenant-a', userId: 'user-a' },
    'template_render',
    'server',
    new Error('Expected cell B3. Bearer secret-token sk-exampleSECRET123456789 user@example.com'),
    { fileType: 'xlsx', fileBytes: 5000, templateType: 'xlsx', unexpected: 'COR contents' } as any,
  )
  assert.equal(saved.id, id)
  assert.equal(saved.tenant_id, 'tenant-a')
  assert.equal(saved.user_id, 'user-a')
  assert.equal(saved.stage, 'template_render')
  assert.equal(saved.context.templateType, 'xlsx')
  assert.ok(!JSON.stringify(saved).includes('COR contents'))
  assert.ok(!saved.message.includes('user@example.com'))
  assert.ok(!saved.message.includes('sk-exampleSECRET123456789'))
  assert.ok(!saved.message.includes('secret-token'))
})

test('DRF diagnostics do not replace the original failure when logging is unavailable', async () => {
  const db = { from: () => ({ insert: async () => ({ error: { code: '42P01' } }) }) }
  assert.equal(
    await recordDrfError(db, { tenantId: 'tenant-a', userId: 'user-a' }, 'cor_local', 'browser', 'OCR failed'),
    null,
  )
  assert.equal(safeDrfMessage('OCR failed\nCOR text should not be stored'), 'OCR failed')
})
