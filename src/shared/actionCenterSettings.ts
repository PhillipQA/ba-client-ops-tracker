/**
 * Settings a widget on the Action Center can carry, kept with the person's layout (or a role's starting layout). The
 * server cleans them on every save, so a layout never holds more than these shapes allow.
 *
 * - counts: which tiles show, in order; built-in ones can be renamed and recoloured, and a person can build their own
 *   count of tasks with up to three filters (the same filters as Reports).
 */
import { cleanFilter, type WidgetFilter } from '../features/reports/custom/reportModel'

export type BuiltinCount =
  | 'attention'
  | 'waitingDev'
  | 'waitingClient'
  | 'overdue'
  | 'dueToday'
  | 'activities'
  | 'inquiries'
  | 'unsentTime'

export const BUILTIN_COUNTS: { id: BuiltinCount; label: string; about: string }[] = [
  { id: 'attention', label: 'Needs attention', about: 'Open tasks and subtasks in this work view.' },
  {
    id: 'waitingDev',
    label: 'Waiting on developer',
    about: 'Open work waiting on the developer, with how many are overdue.',
  },
  { id: 'waitingClient', label: 'Waiting on client', about: 'Open work waiting on the client.' },
  { id: 'overdue', label: 'Overdue', about: 'Open work past its due or follow-up date.' },
  { id: 'dueToday', label: 'Due today', about: 'Work due or to follow up today.' },
  { id: 'activities', label: 'Activities today', about: 'Meetings, tracker activities and follow-ups today.' },
  { id: 'inquiries', label: 'Open inquiries', about: 'Open work of the Inquiry type.' },
  { id: 'unsentTime', label: 'Time not sent to Seeds', about: 'Your time entries still to send to Seeds, in hours.' },
]
const BUILTIN_IDS = BUILTIN_COUNTS.map(item => item.id)

export type TileColor = 'green' | 'blue' | 'amber' | 'red' | 'purple' | 'gray'
export const TILE_COLORS: TileColor[] = ['green', 'blue', 'amber', 'red', 'purple', 'gray']
/** The small line under a custom count's number. */
export type TileDetail = 'overdue' | 'clients' | 'none'
export const TILE_DETAILS: TileDetail[] = ['overdue', 'clients', 'none']

export type CountTile = {
  id: string
  /** A built-in count; without it the tile is the person's own count of tasks. */
  builtin?: BuiltinCount
  /** Replaces the built-in name; required for a custom count. */
  title?: string
  color?: TileColor
  /** Custom counts: Reports filters on the Tasks source. */
  filters?: WidgetFilter[]
  /** Custom counts: only tasks assigned to the person. */
  mine?: boolean
  /** Custom counts: open tasks only (the default) or all. */
  all?: boolean
  detail?: TileDetail
}
export type CountsSettings = { tiles: CountTile[] }

export const COUNT_LIMITS = { tiles: 8, filters: 3, title: 60 }

/** The strip as it always was: four built-in tiles. */
export const DEFAULT_TILES: CountTile[] = (
  ['attention', 'waitingDev', 'activities', 'inquiries'] as BuiltinCount[]
).map(id => ({ id, builtin: id }))

const ID = /^[A-Za-z0-9_-]{1,40}$/
const title = (value: unknown) =>
  typeof value === 'string'
    ? value
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, COUNT_LIMITS.title)
    : ''

/** Tiles made safe: known built-ins once each, custom counts with a title, at most eight. */
export function cleanTiles(raw: unknown): CountTile[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const tiles: CountTile[] = []
  const seen = new Set<string>()
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || tiles.length >= COUNT_LIMITS.tiles) continue
    const input = entry as Record<string, unknown>
    const builtin = BUILTIN_IDS.includes(input.builtin as BuiltinCount) ? (input.builtin as BuiltinCount) : undefined
    const id = builtin || (typeof input.id === 'string' && ID.test(input.id) ? input.id : '')
    if (!id || seen.has(id)) continue
    const name = title(input.title)
    if (!builtin && !name) continue
    seen.add(id)
    const tile: CountTile = { id }
    if (builtin) tile.builtin = builtin
    if (name) tile.title = name
    if (TILE_COLORS.includes(input.color as TileColor)) tile.color = input.color as TileColor
    if (!builtin) {
      tile.filters = (Array.isArray(input.filters) ? input.filters : [])
        .map(cleanFilter)
        .filter((item): item is WidgetFilter => Boolean(item))
        .slice(0, COUNT_LIMITS.filters)
      if (input.mine === true) tile.mine = true
      if (input.all === true) tile.all = true
      tile.detail = TILE_DETAILS.includes(input.detail as TileDetail) ? (input.detail as TileDetail) : 'overdue'
    }
    tiles.push(tile)
  }
  return tiles
}

/** A widget's settings, cleaned for its kind. Undefined: none (the widget's defaults apply). */
export function cleanSettings(id: string, raw: unknown): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const input = raw as Record<string, unknown>
  switch (id) {
    case 'counts': {
      const tiles = cleanTiles(input.tiles)
      return tiles ? { tiles } : undefined
    }
    default:
      return undefined
  }
}

/** The tiles a counts widget shows: its own, or the four it always had. */
export const tilesOf = (settings?: Record<string, unknown>) => cleanTiles(settings?.tiles) ?? DEFAULT_TILES

export const builtinLabel = (id: BuiltinCount) => BUILTIN_COUNTS.find(item => item.id === id)?.label || id

export function newTileId() {
  return `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}
