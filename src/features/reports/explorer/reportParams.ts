// Query widgets on reports: parameters left empty take the report's filters, so a query follows the report's dates,
// client, project and person like every other widget.
import type { SavedQuery } from '../custom/reportModel'
import { queryParams } from './sqlEngine'

export const REPORT_PARAMS = '{{from}}, {{to}}, {{client}}, {{project}} and {{person}}'

export type ReportFilterValues = {
  /** The report's dates; null for all dates. */
  range: { from: string; to: string } | null
  client: string
  project: string
  person: string
}

/** The values a query runs with on a report: its own, then the report's filters for the empty ones. */
export function reportQueryParams(query: SavedQuery, filters: ReportFilterValues): Record<string, string> {
  const fromReport: Record<string, string> = {
    from: filters.range?.from || '',
    to: filters.range?.to || '',
    client: filters.client,
    project: filters.project,
    person: filters.person,
    user: filters.person,
  }
  return Object.fromEntries(
    queryParams(query.sql).map(name => [name, (query.params[name] ?? '').trim() || fromReport[name] || '']),
  )
}
