/**
 * The numbers on the Action Center's count tiles. Built-in counts read the work view's open work; a person's own count
 * reads the Tasks records Reports uses, with their filters. Kept apart from the components so it can be tested alone.
 */
import { unsentToSeeds } from '../tasks/effort'
import { waitingOnOptions } from '../tasks/waitingOn'
import type { CountTile, BuiltinCount } from '../../shared/actionCenterSettings'
import { builtinLabel } from '../../shared/actionCenterSettings'
import { type Field, type FieldType, matches, type Rec } from '../reports/custom/reportData'
import type { TaskSettings, WorkItem } from '../../shared/types'

export type TileValue = { title: string; value: string; detail: string }

/** What the built-in tiles need: the open work of the work view, and a few counts the page already has. */
export type BuiltinInput = {
  open: WorkItem[]
  allItems: WorkItem[]
  taskSettings: TaskSettings
  today: string
  meId: string
  activitiesToday: { meetings: number; tracker: number; followUps: number }
  /** The page's own title for the developer tile ("Waiting on Developer", or "Waiting on others"). */
  waitingTitle: string
  waitingDev: WorkItem[]
}

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`
const late = (item: WorkItem, today: string) =>
  Boolean((item.dueDate && item.dueDate < today) || (item.followUpDate && item.followUpDate < today))

export function builtinValue(id: BuiltinCount, input: BuiltinInput): TileValue {
  const { open, today } = input
  switch (id) {
    case 'attention': {
      const clients = new Set(open.map(item => item.clientId).filter(Boolean)).size
      return { title: builtinLabel(id), value: String(open.length), detail: `Across ${plural(clients, 'client')}` }
    }
    case 'waitingDev':
      return {
        title: input.waitingTitle,
        value: String(input.waitingDev.length),
        detail: `${input.waitingDev.filter(item => item.followUpDate && item.followUpDate < today).length} overdue`,
      }
    case 'waitingClient': {
      const client = waitingOnOptions(input.taskSettings).find(option => option.id === 'client' && !option.done)
      const waiting = client ? open.filter(item => item.waitingOn === client.label) : []
      return {
        title: client ? `Waiting on ${client.label}` : builtinLabel(id),
        value: String(waiting.length),
        detail: `${waiting.filter(item => late(item, today)).length} overdue`,
      }
    }
    case 'overdue': {
      const overdue = open.filter(item => late(item, today))
      const oldest = overdue.reduce(
        (min, item) =>
          [item.dueDate, item.followUpDate].filter(day => day && day < today).reduce((a, b) => (b < a ? b : a), min),
        today,
      )
      return {
        title: builtinLabel(id),
        value: String(overdue.length),
        detail: overdue.length ? `Oldest from ${oldest}` : 'Nothing late',
      }
    }
    case 'dueToday': {
      const due = open.filter(item => item.dueDate === today).length
      const follow = open.filter(item => item.followUpDate === today).length
      const total = open.filter(item => item.dueDate === today || item.followUpDate === today).length
      return { title: builtinLabel(id), value: String(total), detail: `${due} due · ${plural(follow, 'follow-up')}` }
    }
    case 'activities': {
      const { meetings, tracker, followUps } = input.activitiesToday
      return {
        title: builtinLabel(id),
        value: String(meetings + tracker + followUps),
        detail: `${plural(meetings, 'meeting')} · ${tracker} tracker activities · ${plural(followUps, 'follow-up')}`,
      }
    }
    case 'inquiries':
      return {
        title: builtinLabel(id),
        value: String(open.filter(item => item.type === 'Inquiry').length),
        detail: 'Need classification',
      }
    case 'unsentTime': {
      let hours = 0,
        entries = 0
      for (const item of input.allItems)
        for (const entry of item.timeEntries || [])
          if (entry.userId === input.meId && unsentToSeeds(entry)) {
            hours += Number(entry.hours) || 0
            entries += 1
          }
      return {
        title: builtinLabel(id),
        value: `${Math.round(hours * 100) / 100}h`,
        detail: entries ? `${plural(entries, 'entry', 'entries')} to send` : 'All sent',
      }
    }
  }
}

/** A person's own count over the Tasks records: open only unless "all", theirs only if "mine", then the filters. */
export function customValue(tile: CountTile, records: Rec[], fields: Field[], today: string, meId: string): TileValue {
  const types = new Map(fields.map(field => [field.key, field.type]))
  const chosen = records.filter(
    record =>
      (tile.all || record.done !== true) &&
      (!tile.mine || record.$user === meId) &&
      (tile.filters || []).every(
        filter => !types.has(filter.field) || matches(record, filter, types.get(filter.field) as FieldType, today),
      ),
  )
  const detail =
    tile.detail === 'none'
      ? ''
      : tile.detail === 'clients'
        ? `Across ${plural(new Set(chosen.map(record => record.$client).filter(Boolean)).size, 'client')}`
        : `${chosen.filter(record => record.overdue === true).length} overdue`
  return { title: tile.title || 'My count', value: String(chosen.length), detail }
}

/** A filter in a sentence, for the tile editor: "Waiting on is Client". */
export function describeFilter(filter: { field: string; op: string; value?: string }, fields: Field[]) {
  const label = fields.find(field => field.key === filter.field)?.label || filter.field
  const ops: Record<string, string> = {
    is: 'is',
    is_not: 'is not',
    contains: 'contains',
    empty: 'is empty',
    not_empty: 'is not empty',
    eq: '=',
    gt: '>',
    lt: '<',
    before: 'before',
    after: 'after',
    on: 'on',
    true: 'is yes',
    false: 'is no',
  }
  const needs = !['empty', 'not_empty', 'true', 'false'].includes(filter.op)
  return `${label} ${ops[filter.op] || filter.op}${needs && filter.value ? ` ${filter.value}` : ''}`
}
