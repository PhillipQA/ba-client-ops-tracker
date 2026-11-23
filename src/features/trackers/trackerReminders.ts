/**
 * Date reminders: a tracker reminds people about its rows' dates. "3 days before Go-live, if Status is not Live,
 * remind the row's Owner", "On Go-live", or "After Go-live has passed, every working day, until Status is Live".
 *
 * Checked once every morning (8:00 AM business time) by the server: plain comparisons, no AI. A reminder becomes a
 * bell notification, at most one per reminder, row and person a day. It stops by itself once its condition no longer
 * holds, and a person can snooze a row's reminder for themselves.
 *
 * Reminders are view settings shared by everyone on the tracker (kept with the Timeline settings, like highlight rules).
 * Pure functions, shared by the app, the server and the tests.
 */
import { conditionHolds, type RuleCondition, ruleNeedsValue, ruleOpLabel, ruleOpsFor } from './highlightRules'
import { randomId, type TrackerColumn, type TrackerRow } from './trackerModel'
import { type Lookup, rowTitle, shown } from './trackerQuery'
import { dateFormat } from '../../shared/intlFormat'

export type ReminderWhen = 'before' | 'on' | 'after'
export type TrackerReminder = {
  id: string
  /** The Date column the reminder is about. */
  dateId: string
  when: ReminderWhen
  /** "before": how many days before. Unused otherwise. */
  days: number
  /** Only when this holds (optional): the same comparisons as highlight rules. */
  condition?: RuleCondition
  /** Who is reminded: people in a Person column of the row, named people, and/or the tracker's creator. */
  to: { columnId?: string; people?: string[]; creator?: boolean }
  /** Switched off without being deleted. */
  off?: boolean
}

export const REMINDER_LIMITS = { reminders: 10, days: 90, people: 10 }
export const REMINDER_HOUR = 8

const isDate = (column: TrackerColumn) => column.type === 'date' || column.type === 'task_due'
export const reminderDateColumns = (columns: TrackerColumn[]) => columns.filter(isDate)
export const reminderPersonColumns = (columns: TrackerColumn[]) =>
  columns.filter(column => column.type === 'person' || column.type === 'task_owner')

/** Saved reminders, made safe. A reminder without a date column or without anyone to remind is dropped. */
export function cleanReminders(raw: unknown, columns: TrackerColumn[]): TrackerReminder[] {
  if (!Array.isArray(raw)) return []
  const byId = new Map(columns.map(column => [column.id, column]))
  const seen = new Set<string>()
  const out: TrackerReminder[] = []
  for (const entry of raw.slice(0, REMINDER_LIMITS.reminders * 2)) {
    if (!entry || typeof entry !== 'object') continue
    const date = byId.get(String(entry.dateId || ''))
    if (!date || !isDate(date)) continue
    const when: ReminderWhen = entry.when === 'on' || entry.when === 'after' ? entry.when : 'before'
    const days =
      when === 'before' ? Math.min(REMINDER_LIMITS.days, Math.max(1, Math.round(Number(entry.days) || 0))) : 0
    const person = byId.get(String(entry.to?.columnId || ''))
    const to = {
      ...(person && reminderPersonColumns(columns).includes(person) ? { columnId: person.id } : {}),
      ...(Array.isArray(entry.to?.people) && entry.to.people.length
        ? {
            people: [...new Set(entry.to.people.map(String).filter(Boolean))].slice(
              0,
              REMINDER_LIMITS.people,
            ) as string[],
          }
        : {}),
      ...(entry.to?.creator === true ? { creator: true } : {}),
    }
    if (!to.columnId && !to.people?.length && !to.creator) continue
    let condition: RuleCondition | undefined
    const wanted = entry.condition
    if (wanted && typeof wanted === 'object') {
      const column = byId.get(String(wanted.columnId || ''))
      const op = column ? ruleOpsFor(column).find(candidate => candidate === wanted.op) : undefined
      const value = op && ruleNeedsValue(op) ? String(wanted.value ?? '').slice(0, 200) : ''
      if (column && op && (!ruleNeedsValue(op) || value.trim())) condition = { columnId: column.id, op, value }
    }
    let id = typeof entry.id === 'string' && /^[a-z0-9_]{3,40}$/i.test(entry.id) ? entry.id : ''
    while (!id || seen.has(id)) id = randomId('m_')
    seen.add(id)
    out.push({
      id,
      dateId: date.id,
      when,
      days,
      to,
      ...(condition ? { condition } : {}),
      ...(entry.off === true ? { off: true } : {}),
    })
    if (out.length >= REMINDER_LIMITS.reminders) break
  }
  return out
}

const DAY = 86_400_000
const dayOf = (iso: string) => Math.round(Date.parse(`${iso}T00:00:00Z`) / DAY)
const weekend = (iso: string) => {
  const day = new Date(`${iso}T00:00:00Z`).getUTCDay()
  return day === 0 || day === 6
}

/**
 * Whether a reminder is due for a row today, and how far the date is: days until it (negative when past).
 * "before": exactly N days before; "on": the day itself; "after": every working day once the date has passed.
 */
export function reminderDue(
  reminder: TrackerReminder,
  row: TrackerRow,
  columns: TrackerColumn[],
  lookup: Lookup,
  today: string,
): { due: boolean; days: number; date: string } {
  const column = columns.find(item => item.id === reminder.dateId)
  const date = column ? shown(column, row, lookup).text.slice(0, 10) : ''
  if (reminder.off || !column || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return { due: false, days: 0, date: '' }
  const days = dayOf(date) - dayOf(today)
  const timing =
    reminder.when === 'before'
      ? days === reminder.days
      : reminder.when === 'on'
        ? days === 0
        : days < 0 && !weekend(today)
  if (!timing) return { due: false, days, date }
  if (reminder.condition) {
    const conditionColumn = columns.find(item => item.id === reminder.condition!.columnId)
    if (!conditionColumn || !conditionHolds(reminder.condition, row, conditionColumn, lookup, today))
      return { due: false, days, date }
  }
  return { due: true, days, date }
}

/** The people a reminder goes to for a row: its Person column's value, named people, the creator. */
export function reminderPeople(
  reminder: TrackerReminder,
  row: TrackerRow,
  columns: TrackerColumn[],
  lookup: Lookup,
  creator: string,
) {
  const people = new Set<string>(reminder.to.people || [])
  if (reminder.to.creator && creator) people.add(creator)
  const column = reminder.to.columnId ? columns.find(item => item.id === reminder.to.columnId) : undefined
  if (column?.type === 'person') {
    const value = row.cells[column.id]
    if (typeof value === 'string' && value) people.add(value)
  } else if (column?.type === 'task_owner' && row.taskId) {
    const task = lookup.task(row.taskId)
    if (task?.assignedToUserId) people.add(task.assignedToUserId)
  }
  return [...people]
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
export const niceDate = (iso: string) =>
  `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}, ${iso.slice(0, 4)}`

/** The notification's words: "Festival Mall: Go-live in 3 days", with the date and the tracker. */
export function reminderText(
  row: TrackerRow,
  columns: TrackerColumn[],
  reminder: TrackerReminder,
  due: { days: number; date: string },
  trackerName: string,
) {
  const name = rowTitle(columns, row) || 'A row'
  const dateName = columns.find(column => column.id === reminder.dateId)?.name || 'Date'
  const when =
    due.days === 0
      ? 'is today'
      : due.days > 0
        ? `in ${due.days} day${due.days === 1 ? '' : 's'}`
        : `was ${-due.days} day${due.days === -1 ? '' : 's'} ago`
  return {
    title: `${name}: ${dateName} ${when}`,
    message: `${dateName} ${niceDate(due.date)} · ${trackerName}`,
    severity: (due.days < 0 ? 'warning' : 'info') as 'warning' | 'info',
  }
}

/** A reminder in words, for the list: "3 days before Go-live, if Status is not Live → the row's Owner". */
export function describeReminder(
  reminder: TrackerReminder,
  columns: TrackerColumn[],
  personName: (id: string) => string,
) {
  const name = (id?: string) => columns.find(column => column.id === id)?.name || '(deleted column)'
  const timing =
    reminder.when === 'before'
      ? `${reminder.days} day${reminder.days === 1 ? '' : 's'} before ${name(reminder.dateId)}`
      : reminder.when === 'on'
        ? `On ${name(reminder.dateId)}`
        : `After ${name(reminder.dateId)} has passed, every working day`
  const condition = reminder.condition
  let because = ''
  if (condition) {
    const column = columns.find(item => item.id === condition.columnId)
    const value = !ruleNeedsValue(condition.op)
      ? ''
      : column?.type === 'select'
        ? column.options?.find(option => option.id === condition.value)?.label || '(deleted option)'
        : column?.type === 'person'
          ? personName(condition.value)
          : condition.op === 'within'
            ? `${condition.value} days`
            : condition.value
    because = `, if ${name(condition.columnId)} ${ruleOpLabel(condition.op)}${value ? ` ${value}` : ''}`
  }
  const who = [
    reminder.to.columnId ? `the row’s ${name(reminder.to.columnId)}` : '',
    ...(reminder.to.people || []).map(id => personName(id) || 'Unknown user'),
    reminder.to.creator ? 'the tracker’s creator' : '',
  ].filter(Boolean)
  return `${timing}${because} → ${who.join(', ')}`
}

/** A new reminder for the editor: before the first date column, to the first person column (or the creator). */
export function newReminder(columns: TrackerColumn[]): TrackerReminder | undefined {
  const date =
    reminderDateColumns(columns).find(column => /go.?live|due|end|deadline/i.test(column.name)) ||
    reminderDateColumns(columns)[0]
  if (!date) return undefined
  const person = reminderPersonColumns(columns)[0]
  return {
    id: randomId('m_'),
    dateId: date.id,
    when: 'before',
    days: 3,
    to: person ? { columnId: person.id } : { creator: true },
  }
}

/** The notification key: one per reminder, row, person and day. */
export const reminderKey = (trackerId: string, reminderId: string, rowId: string, personId: string, today: string) =>
  `tracker-reminder:${trackerId}:${reminderId}:${rowId}:${personId}:${today}`

/** Whether it is time for today's check: on or after the reminder hour, business time. */
export const reminderHourReached = (hour: number) => hour >= REMINDER_HOUR

/** The hour of the day in the business time zone. */
export function businessHour(now: Date, timeZone: string) {
  const hour = dateFormat('en-US', { timeZone, hour: 'numeric', hourCycle: 'h23' }).format(now)
  return Number(hour) || 0
}
