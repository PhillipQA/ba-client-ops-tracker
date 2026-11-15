/**
 * The roll-up: one list of rows across several trackers, usually every Site rollout tracker a person can see. Nothing
 * is copied: rows are read live from their own trackers, and an edit made here is saved to the row's own tracker, so
 * history, linked tasks, the connected Sheet and automations all follow as if it were made there.
 *
 * Trackers are lined up by four columns, matched by name and type: Site, Status, Go-live and Owner. A tracker needs a
 * Status or a Go-live column to take part. With no Owner column, the owner is whoever the row's task is assigned to.
 */
import type { Tracker, TrackerColumn, TrackerRow } from './trackerModel'
import { csvField } from './trackerExport'
import { type Lookup, shown, type Tone } from './trackerQuery'

export type RollupField = 'site' | 'status' | 'goLive' | 'owner'
/** The column id each field reads, per tracker. A field with no match is left out. */
export type RollupColumns = Partial<Record<RollupField, string>>

export const ROLLUP_TEMPLATE = 'site-rollout'
/** The address the roll-up opens at, /trackers/rollup. Tracker ids are UUIDs, so this cannot clash with one. */
export const ROLLUP_ID = 'rollup'
export const ROLLUP_LIMITS = { trackers: 30, rows: 5000 }
/** "Due soon" on the summary tiles: go-live within this many days. */
export const DUE_SOON_DAYS = 14

const SITE_NAME = /site|terminal|branch|store|outlet|location/i
const STATUS_NAME = /status|stage|state|phase/i
const GO_LIVE_NAME = /go.?live|launch|live date|cut.?over/i
const DUE_NAME = /due|target|deadline/i
const OWNER_NAME = /owner|assignee|assigned|pic\b|in.?charge|engineer|handled/i

const pick = (columns: TrackerColumn[], types: string[], name?: RegExp) =>
  columns.find(column => types.includes(column.type) && (!name || name.test(column.name)))

/** Which column gives each field, by name first and then by type. */
export function rollupColumns(columns: TrackerColumn[]): RollupColumns {
  const out: RollupColumns = {}
  const site = pick(columns, ['text'], SITE_NAME) || pick(columns, ['text'])
  const status =
    pick(columns, ['select'], STATUS_NAME) ||
    pick(columns, ['task_status']) ||
    pick(columns, ['text'], STATUS_NAME) ||
    pick(columns, ['select'])
  const goLive =
    pick(columns, ['date'], GO_LIVE_NAME) ||
    columns.find(column => column.type === 'date' && column.taskField === 'due') ||
    pick(columns, ['date'], DUE_NAME) ||
    pick(columns, ['task_due'])
  const owner =
    pick(columns, ['person', 'task_owner', 'text'], OWNER_NAME) ||
    pick(columns, ['task_owner']) ||
    pick(columns, ['person'])
  if (site) out.site = site.id
  if (status) out.status = status.id
  if (goLive) out.goLive = goLive.id
  if (owner && owner.id !== site?.id) out.owner = owner.id
  return out
}

/** A tracker can take part when it has a Status or a Go-live column. */
export const rollupFits = (columns: TrackerColumn[]) => {
  const matched = rollupColumns(columns)
  return Boolean(matched.status || matched.goLive)
}

/** The trackers shown when the person has not chosen: every Site rollout tracker that is not archived. */
export function defaultRollupIds(trackers: Pick<Tracker, 'id' | 'template' | 'archived' | 'columns'>[]) {
  return trackers
    .filter(tracker => !tracker.archived && tracker.template === ROLLUP_TEMPLATE && rollupFits(tracker.columns))
    .slice(0, ROLLUP_LIMITS.trackers)
    .map(tracker => tracker.id)
}

/** The columns the roll-up reads, so the server sends nothing else. */
export function rollupColumnIds(columns: TrackerColumn[]) {
  return [...new Set(Object.values(rollupColumns(columns)).filter((id): id is string => Boolean(id)))]
}

export type RollupState = 'live' | 'blocked' | 'overdue' | 'due' | 'open'
export type RollupItem = {
  trackerId: string
  trackerName: string
  clientIds: string[]
  rowId: string
  version: number
  taskId: string
  site: string
  status: string
  statusTone?: Tone
  /** YYYY-MM-DD, or '' when not set. */
  goLive: string
  owner: string
  state: RollupState
}
export type RollupTracker = Pick<Tracker, 'id' | 'name' | 'clientIds' | 'columns' | 'canEdit'>
export type RollupSet = { tracker: RollupTracker; rows: TrackerRow[] }

const LIVE = /^(live|done|completed?|finished|closed|resolved|signed off|turned over)\b/i
const BLOCKED = /\b(blocked|on hold|hold|stuck|issue|problem|escalated|cancel+ed)\b/i

export function addDays(date: string, days: number) {
  const at = new Date(`${date}T00:00:00Z`)
  if (Number.isNaN(at.getTime())) return date
  at.setUTCDate(at.getUTCDate() + days)
  return at.toISOString().slice(0, 10)
}

export function rollupState(status: string, goLive: string, today: string): RollupState {
  if (LIVE.test(status.trim())) return 'live'
  if (BLOCKED.test(status)) return 'blocked'
  if (goLive && goLive < today) return 'overdue'
  if (goLive && goLive <= addDays(today, DUE_SOON_DAYS)) return 'due'
  return 'open'
}

/** Every row of every set, read through its own tracker's columns. */
export function rollupItems(sets: RollupSet[], lookup: Lookup): RollupItem[] {
  const items: RollupItem[] = []
  for (const { tracker, rows } of sets) {
    const matched = rollupColumns(tracker.columns)
    const byId = new Map(tracker.columns.map(column => [column.id, column]))
    const view = { ...lookup, columns: tracker.columns }
    const read = (field: RollupField, row: TrackerRow) => {
      const column = matched[field] ? byId.get(matched[field] as string) : undefined
      return column ? shown(column, row, view) : undefined
    }
    for (const row of rows) {
      const status = read('status', row)
      const goLive = read('goLive', row)?.text || ''
      const owner = read('owner', row)?.text ?? taskOwner(row, lookup)
      const statusText = status?.text || ''
      items.push({
        trackerId: tracker.id,
        trackerName: tracker.name,
        clientIds: tracker.clientIds || [],
        rowId: row.id,
        version: row.version,
        taskId: row.taskId,
        site: read('site', row)?.text || '',
        status: statusText,
        ...(status?.tone ? { statusTone: status.tone } : {}),
        goLive: /^\d{4}-\d{2}-\d{2}$/.test(goLive) ? goLive : '',
        owner,
        state: rollupState(statusText, goLive, lookup.today),
      })
    }
  }
  return items
}

function taskOwner(row: TrackerRow, lookup: Lookup) {
  const task = row.taskId ? lookup.task(row.taskId) : undefined
  if (!task) return ''
  return (task.assignedToUserId && lookup.person(task.assignedToUserId)) || task.owner || ''
}

export type RollupFilter = {
  query?: string
  clientId?: string
  status?: string
  owner?: string
  /** Go-live from and to, inclusive. */
  from?: string
  to?: string
  state?: RollupState | 'all'
}

export function filterRollup(items: RollupItem[], filter: RollupFilter) {
  const words = (filter.query || '').toLowerCase().split(/\s+/).filter(Boolean)
  return items.filter(
    item =>
      (!filter.clientId || item.clientIds.includes(filter.clientId)) &&
      (!filter.status || item.status === filter.status) &&
      (!filter.owner || item.owner === filter.owner) &&
      (!filter.from || (item.goLive && item.goLive >= filter.from)) &&
      (!filter.to || (item.goLive && item.goLive <= filter.to)) &&
      (!filter.state || filter.state === 'all' || item.state === filter.state) &&
      words.every(word => `${item.site} ${item.trackerName} ${item.status} ${item.owner}`.toLowerCase().includes(word)),
  )
}

/** Overdue first, then by go-live (rows with none last), then by site. */
export function sortRollup(items: RollupItem[]) {
  const rank = (item: RollupItem) => (item.state === 'overdue' ? 0 : item.state === 'live' ? 2 : 1)
  return [...items].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (a.goLive || '9999').localeCompare(b.goLive || '9999') ||
      a.site.localeCompare(b.site, undefined, { numeric: true }),
  )
}

export type RollupTiles = { total: number; live: number; due: number; overdue: number; blocked: number }
export function rollupTiles(items: RollupItem[]): RollupTiles {
  const count = (state: RollupState) => items.filter(item => item.state === state).length
  return {
    total: items.length,
    live: count('live'),
    due: count('due'),
    overdue: count('overdue'),
    blocked: count('blocked'),
  }
}

export type RollupGroupBy = 'tracker' | 'client' | 'none'
export type RollupGroup = { key: string; label: string; items: RollupItem[]; live: number; percent: number }

/** Groups in the order their first row appears; with "client", a tracker with several clients shows under each. */
export function groupRollup(
  items: RollupItem[],
  by: RollupGroupBy,
  clientName: (id: string) => string = id => id,
): RollupGroup[] {
  if (by === 'none') return [group('all', 'All rows', items)]
  const groups = new Map<string, { label: string; items: RollupItem[] }>()
  const add = (key: string, label: string, item: RollupItem) => {
    const found = groups.get(key)
    if (found) found.items.push(item)
    else groups.set(key, { label, items: [item] })
  }
  for (const item of items) {
    if (by === 'tracker') add(item.trackerId, item.trackerName, item)
    else if (!item.clientIds.length) add('', 'No client', item)
    else for (const id of item.clientIds) add(id, clientName(id) || 'Unknown client', item)
  }
  return [...groups.entries()].map(([key, value]) => group(key, value.label, value.items))
}

function group(key: string, label: string, items: RollupItem[]): RollupGroup {
  const live = items.filter(item => item.state === 'live').length
  return { key, label, items, live, percent: items.length ? Math.round((live / items.length) * 100) : 0 }
}

/** Not live, with go-live in the next seven days or already past: the Action Center widget's list. */
export function dueThisWeek(items: RollupItem[], today: string) {
  const end = addDays(today, 6)
  return sortRollup(items.filter(item => item.state !== 'live' && item.goLive && item.goLive <= end))
}

export const STATE_LABEL: Record<RollupState, string> = {
  live: 'Live',
  blocked: 'Blocked',
  overdue: 'Overdue',
  due: `Due in ${DUE_SOON_DAYS} days`,
  open: 'Open',
}

/** The roll-up as CSV, in the order shown. */
export function rollupCsv(items: RollupItem[], clientName: (id: string) => string = id => id) {
  const lines = [['Site', 'Tracker', 'Client', 'Status', 'Go-live', 'Owner', 'State'].join(',')]
  for (const item of items)
    lines.push(
      [
        item.site,
        item.trackerName,
        item.clientIds.map(clientName).filter(Boolean).join('; '),
        item.status,
        item.goLive,
        item.owner,
        STATE_LABEL[item.state],
      ]
        .map(value => csvField(value, true))
        .join(','),
    )
  return `﻿${lines.join('\r\n')}\r\n`
}

/** The cell to save when a field is edited here, or null when that field cannot be edited from the roll-up. */
export function rollupEditable(columns: TrackerColumn[], field: RollupField): TrackerColumn | null {
  const id = rollupColumns(columns)[field]
  const column = id ? columns.find(item => item.id === id) : undefined
  if (!column || column.synced) return null
  return ['text', 'select', 'date', 'person'].includes(column.type) ? column : null
}

/** The value as the column stores it: a Choice by its option id, a date as YYYY-MM-DD, a person by account id. */
export function rollupCell(column: TrackerColumn, value: string) {
  if (column.type === 'select') return column.options?.find(option => option.id === value)?.id ?? ''
  if (column.type === 'date') return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : ''
  return value.trim()
}
