import { stableJson } from '../../src/shared/workspaceChanges'

type Row = { id: string } & Record<string, unknown>
export type RowChanges = { upsert: Row[]; remove: string[]; replace?: boolean }

/**
 * The rows a save writes (schema v46, save_tenant_changes_v1): in each record table, the rows that differ from the
 * table before the save, and the ids of rows no longer in it. Tables in `whole` are written whole, as every table
 * used to be. `counts` is how many live rows each written table must hold afterwards, which the database checks.
 */
export function changedRows<T extends Record<string, Row[]>>(before: T, after: T, whole: (keyof T)[] = []) {
  const changes: Partial<Record<keyof T, RowChanges>> = {}
  const counts: Partial<Record<keyof T, number>> = {}
  for (const table of Object.keys(after) as (keyof T)[]) {
    const rows = after[table]
    if (whole.includes(table)) {
      changes[table] = { upsert: rows, remove: [], replace: true }
      counts[table] = rows.length
      continue
    }
    const old = new Map((before[table] || []).map(row => [row.id, stableJson(row)]))
    const upsert = rows.filter(row => old.get(row.id) !== stableJson(row))
    const kept = new Set(rows.map(row => row.id))
    const remove = [...old.keys()].filter(id => !kept.has(id))
    if (!upsert.length && !remove.length) continue
    changes[table] = { upsert, remove }
    counts[table] = rows.length
  }
  return { changes, counts }
}
