import { createHash } from 'node:crypto'
import { stableRecord } from '../../src/features/tasks/lifecycle'

/** Only fields saved by the workspace editor. Dedicated APIs own attachments,
 * comments, time entries, accounts and append-only activity; those are preserved on PUT. */
export function workspaceVersion(state: any): string {
  const editable = Object.fromEntries(['clients', 'projects', 'planner', 'rtms'].map(key => [key, state?.[key] || []]))
  editable.items = (state?.items || [])
    .filter((item: any) => !(item.source === 'Discord' && item.externalSourceId))
    .map((item: any) => {
      const { comments, evidence, docHubDocuments, driveFiles, timeEntries, ...fields } = item
      return fields
    })
  return createHash('sha256').update(stableRecord(editable)).digest('hex')
}

/**
 * The version of a tenant's workspace as stored, remembered per tenant and `updated_at`: every write to tenant_state
 * sets a new `updated_at` (save_tenant_state_v6 and the password reset both do), so the same `updated_at` means the
 * same data. Hashing a large workspace takes several milliseconds, and loads and saves each needed one.
 */
const versions = new Map<string, { updatedAt: string; version: string }>()
const VERSION_CACHE_MAX = 500

export function storedWorkspaceVersion(tenantId: string, updatedAt: string | null | undefined, state: any): string {
  if (!updatedAt) return workspaceVersion(state)
  const held = versions.get(tenantId)
  if (held && held.updatedAt === String(updatedAt)) return held.version
  const version = workspaceVersion(state)
  if (!held && versions.size >= VERSION_CACHE_MAX) versions.delete(versions.keys().next().value as string)
  versions.set(tenantId, { updatedAt: String(updatedAt), version })
  return version
}

export function mergeActivity(current: any[] = [], incoming: any[] = []) {
  const ids = new Set(current.map(entry => entry.id))
  return [...incoming.filter(entry => !ids.has(entry.id)), ...current]
}
