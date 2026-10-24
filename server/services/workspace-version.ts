import { createHash } from 'node:crypto'
import { stableRecord } from '../../src/features/tasks/lifecycle'

/** Only fields saved by the workspace editor. Dedicated APIs own attachments,
 * comments, time entries, accounts and append-only activity; those are preserved on PUT. */
export function workspaceVersion(state: any): string {
  const editable = Object.fromEntries(['clients', 'projects', 'planner', 'rtms'].map(key => [key, state?.[key] || []]))
  editable.items = (state?.items || []).filter((item: any) => !(item.source === 'Discord' && item.externalSourceId)).map((item: any) => {
    const { comments, evidence, docHubDocuments, driveFiles, timeEntries, ...fields } = item
    return fields
  })
  return createHash('sha256').update(stableRecord(editable)).digest('hex')
}

export function mergeActivity(current: any[] = [], incoming: any[] = []) {
  const ids = new Set(current.map(entry => entry.id))
  return [...incoming.filter(entry => !ids.has(entry.id)), ...current]
}
