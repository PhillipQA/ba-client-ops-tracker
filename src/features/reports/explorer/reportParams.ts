// Query widgets on reports: parameters left empty take the report's filters, so a query follows the report's dates,
// client, project and person like every other widget.
import type { SavedQuery } from '../custom/reportModel'
import { queryParams } from './sqlEngine'

export const REPORT_PARAMS =
  '{{from}} / {{to}} (or a date column’s _from / _to), {{client}}, {{project}} and {{person}} (or {{user}}, {{assignee}}, {{owner}}; _id for ids)'

export type ReportFilterValues = {
  /** The report's dates; null for all dates. */
  range: { from: string; to: string } | null
  client: string
  project: string
  person: string
  /** The same choices by id, for parameters such as {{client_id}}. */
  clientId?: string
  projectId?: string
  personId?: string
}

export type ReportFilterKey = 'from' | 'to' | 'client' | 'project' | 'person'

/**
 * Which report filter fills a parameter. The Data explorer's "Ask each time" names parameters after their column
 * ({{client}}, {{client_id}}, {{assignee}}, {{due_date_from}}), so every one of those follows the report too.
 */
export function reportFilterFor(name: string): { filter: ReportFilterKey; byId: boolean } | null {
  const n = name.toLowerCase()
  // Ends of a date range: {{from}}, {{due_date_from}}, {{received_at_to}}. Not just any *_to ({{sent_to}}).
  const end = /^(.+)_(from|to)$/.exec(n)
  if (n === 'from' || n === 'to') return { filter: n, byId: false }
  if (end && /(^|_)(date|day|at|on|updated)(_|$)/.test(end[1]))
    return { filter: end[2] as 'from' | 'to', byId: false }
  const match = /^(client|project|person|user|assignee|owner)(_name|_id)?$/.exec(n)
  if (!match) return null
  const filter = match[1] === 'client' ? 'client' : match[1] === 'project' ? 'project' : 'person'
  return { filter, byId: match[2] === '_id' }
}

const valueFor = (name: string, filters: ReportFilterValues) => {
  const target = reportFilterFor(name)
  if (!target) return ''
  if (target.filter === 'from') return filters.range?.from || ''
  if (target.filter === 'to') return filters.range?.to || ''
  if (target.filter === 'client') return (target.byId ? filters.clientId : filters.client) || ''
  if (target.filter === 'project') return (target.byId ? filters.projectId : filters.project) || ''
  return (target.byId ? filters.personId : filters.person) || ''
}

/** The values a query runs with on a report: its own, then the report's filters for the empty ones. */
export function reportQueryParams(query: SavedQuery, filters: ReportFilterValues): Record<string, string> {
  return Object.fromEntries(
    queryParams(query.sql).map(name => [name, (query.params[name] ?? '').trim() || valueFor(name, filters)]),
  )
}

/**
 * A query going onto a report: parameters the report's filters can fill are left empty so they follow the report.
 * Values picked while trying the query in the Data explorer would otherwise pin it to that client or date for good.
 */
export function paramsForReport(query: SavedQuery): SavedQuery {
  return {
    ...query,
    params: Object.fromEntries(
      Object.entries(query.params).map(([name, value]) => [name, reportFilterFor(name) ? '' : value]),
    ),
  }
}

/** The report filters a query cannot follow: none of its WHERE parameters takes that filter. */
export function reportFiltersIgnored(where: string, filters: ReportFilterValues): string[] {
  const used = new Set(queryParams(where).map(name => reportFilterFor(name)?.filter))
  const missing: string[] = []
  if (filters.range && (!used.has('from') || !used.has('to'))) missing.push('Dates')
  if (filters.client && !used.has('client')) missing.push('Client')
  if (filters.project && !used.has('project')) missing.push('Project')
  if (filters.person && !used.has('person')) missing.push('Person')
  return missing
}
