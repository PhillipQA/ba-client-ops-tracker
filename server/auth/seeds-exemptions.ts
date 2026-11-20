/**
 * Seeds exceptions (schema v43): app_users.seeds_exempt lets one user sign in with a password when Seeds does not list
 * them. Only Internal Admin sets it. The rule itself is seedsSignInRoute in google-sign-in.ts; this reads the column,
 * and copes with a database that does not have it yet.
 */
import type { SeedsExemption } from './google-sign-in'

export const SEEDS_EXEMPT_NEEDS_SCHEMA =
  'Seeds exceptions need database schema v43. Run database/migrations/schema-v43-seeds-exemptions.sql, then try again.'

/** The database is older than schema v43: app_users has no seeds_exempt column. */
export const missingSeedsExemptColumn = (error: any) =>
  Boolean(error) && (error.code === '42703' || /seeds_exempt/.test(String(error.message || '')))

/** One user's Seeds exception; 'legacy' before schema v43. */
export async function seedsExemptionOf(database: any, userId: string, organizationId: string): Promise<SeedsExemption> {
  const { data, error } = await database
    .from('app_users')
    .select('seeds_exempt')
    .eq('id', userId)
    .eq('organization_id', organizationId)
    .maybeSingle()
  if (error) {
    if (missingSeedsExemptColumn(error)) return 'legacy'
    throw error
  }
  return data?.seeds_exempt === true
}

/** Every user's Seeds exception by id, for Internal Admin; null before schema v43. */
export async function seedsExemptionsById(database: any): Promise<Map<string, boolean> | null> {
  const { data, error } = await database.from('app_users').select('id,seeds_exempt').is('deleted_at', null)
  if (error) {
    if (missingSeedsExemptColumn(error)) return null
    throw error
  }
  return new Map((data || []).map((row: any) => [String(row.id), row.seeds_exempt === true]))
}
