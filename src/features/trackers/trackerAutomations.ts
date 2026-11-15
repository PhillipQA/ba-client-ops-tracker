/**
 * When → then automations: small, predictable rules a tracker runs on the server when a row is saved from the app.
 * "When Status changes to Live → set Done date to today", "When a row is added → create its task",
 * "When Status changes to Blocked → notify Lea and add a comment".
 *
 * - Triggers: a row is added, or a column changes (to any value, or to one value).
 * - Conditions (optional): the same comparisons as highlight rules; all must hold after the save.
 * - Actions: set a column, create the row's task, notify people, add a comment.
 * - A change made by an automation never starts another automation, so rules cannot set each other off in a loop.
 * - An automation never deletes, and never sets a cell that comes from a connected Google Sheet.
 *
 * Kept with the tracker's shared view settings. Pure functions, shared by the app, the server and the tests.
 */
import { conditionHolds, type RuleCondition, ruleNeedsValue, ruleOpLabel, ruleOpsFor } from './highlightRules'
import { type Cell, emptyCell, isEmptyCell, randomId, type TrackerColumn, type TrackerRow } from './trackerModel'
import type { Lookup } from './trackerQuery'

export type AutomationTrigger = { kind: 'added' } | { kind: 'changed'; columnId: string; to?: string }
export type AutomationAction =
  | { kind: 'set'; columnId: string; value: string }
  | { kind: 'task'; assigneeColumnId?: string }
  | { kind: 'notify'; people?: string[]; columnId?: string }
  | { kind: 'comment'; text: string }
export type Automation = {
  id: string
  when: AutomationTrigger
  conditions: RuleCondition[]
  then: AutomationAction[]
  off?: boolean
}

export const AUTOMATION_LIMITS = { automations: 10, conditions: 2, actions: 3, text: 500, people: 10, rowsAdded: 20 }
/** The value that sets a date to the day the automation runs. */
export const TODAY = 'today'

const SETTABLE = ['select', 'person', 'checkbox', 'date', 'text', 'number']
/** Columns an action can set: plain values, not task-linked, not "done when tasks are done". */
export const settableColumns = (columns: TrackerColumn[]) =>
  columns.filter(column => SETTABLE.includes(column.type) && !column.autoDone && !column.taskField)
/** Columns a "changes to" trigger can watch for one value. */
const valueTrigger = (column: TrackerColumn) => ['select', 'person', 'checkbox'].includes(column.type)
export const triggerColumns = (columns: TrackerColumn[]) =>
  columns.filter(column => column.type !== 'secret' && column.type !== 'formula' && !column.taskField)
const personColumns = (columns: TrackerColumn[]) => columns.filter(column => column.type === 'person')

/** A value typed or picked for a "set" action, checked against the column: '' clears the cell. */
export function setValueOk(column: TrackerColumn, value: string) {
  if (value === '') return true
  switch (column.type) {
    case 'select':
      return Boolean(column.options?.some(option => option.id === value))
    case 'checkbox':
      return value === 'true' || value === 'false'
    case 'date':
      return value === TODAY || /^\d{4}-\d{2}-\d{2}$/.test(value)
    case 'number':
      return Number.isFinite(Number(value))
    default:
      return true
  }
}

/** Saved automations, made safe: known columns, values that fit them, at least one action. */
export function cleanAutomations(raw: unknown, columns: TrackerColumn[]): Automation[] {
  if (!Array.isArray(raw)) return []
  const byId = new Map(columns.map(column => [column.id, column]))
  const seen = new Set<string>()
  const out: Automation[] = []
  for (const entry of raw.slice(0, AUTOMATION_LIMITS.automations * 2)) {
    if (!entry || typeof entry !== 'object') continue
    let when: AutomationTrigger | undefined
    if (entry.when?.kind === 'added') when = { kind: 'added' }
    else if (entry.when?.kind === 'changed') {
      const column = byId.get(String(entry.when.columnId || ''))
      if (column && triggerColumns(columns).includes(column)) {
        const to =
          typeof entry.when.to === 'string' && entry.when.to !== '' && valueTrigger(column) ? entry.when.to : ''
        when =
          to && setValueOk(column, to) && to !== TODAY
            ? { kind: 'changed', columnId: column.id, to }
            : { kind: 'changed', columnId: column.id }
      }
    }
    if (!when) continue
    const conditions: RuleCondition[] = []
    for (const item of Array.isArray(entry.conditions) ? entry.conditions : []) {
      const column = byId.get(String(item?.columnId || ''))
      const op = column ? ruleOpsFor(column).find(candidate => candidate === item?.op) : undefined
      const value = op && ruleNeedsValue(op) ? String(item?.value ?? '').slice(0, 200) : ''
      if (!column || !op || (ruleNeedsValue(op) && !value.trim())) continue
      conditions.push({ columnId: column.id, op, value })
      if (conditions.length >= AUTOMATION_LIMITS.conditions) break
    }
    const then: AutomationAction[] = []
    for (const action of Array.isArray(entry.then) ? entry.then : []) {
      if (action?.kind === 'set') {
        const column = byId.get(String(action.columnId || ''))
        const value = String(action.value ?? '')
        if (column && settableColumns(columns).includes(column) && setValueOk(column, value))
          then.push({ kind: 'set', columnId: column.id, value })
      } else if (action?.kind === 'task') {
        const assignee = byId.get(String(action.assigneeColumnId || ''))
        then.push(
          assignee && personColumns(columns).includes(assignee)
            ? { kind: 'task', assigneeColumnId: assignee.id }
            : { kind: 'task' },
        )
      } else if (action?.kind === 'notify') {
        const column = byId.get(String(action.columnId || ''))
        const people = Array.isArray(action.people)
          ? [...new Set(action.people.map(String).filter(Boolean))].slice(0, AUTOMATION_LIMITS.people)
          : []
        const ok = column && personColumns(columns).includes(column)
        if (people.length || ok)
          then.push({
            kind: 'notify',
            ...(people.length ? { people: people as string[] } : {}),
            ...(ok ? { columnId: column!.id } : {}),
          })
      } else if (action?.kind === 'comment') {
        const text = String(action.text ?? '')
          .trim()
          .slice(0, AUTOMATION_LIMITS.text)
        if (text) then.push({ kind: 'comment', text })
      }
      if (then.length >= AUTOMATION_LIMITS.actions) break
    }
    if (!then.length) continue
    let id = typeof entry.id === 'string' && /^[a-z0-9_]{3,40}$/i.test(entry.id) ? entry.id : ''
    while (!id || seen.has(id)) id = randomId('a_')
    seen.add(id)
    out.push({ id, when, conditions, then, ...(entry.off === true ? { off: true } : {}) })
    if (out.length >= AUTOMATION_LIMITS.automations) break
  }
  return out
}

const same = (a: Cell | undefined, b: Cell | undefined) =>
  JSON.stringify(isEmptyCell(a) ? null : a) === JSON.stringify(isEmptyCell(b) ? null : b)
const asText = (value: Cell | undefined) => (value === true ? 'true' : value === false ? 'false' : String(value ?? ''))

/**
 * The automations a save starts, in order. `before` is null for a new row. Conditions are read on the row as saved.
 * Only the person's own change counts: an automation's changes are never fed back in.
 */
export function triggered(
  automations: Automation[],
  before: TrackerRow | null,
  after: TrackerRow,
  columns: TrackerColumn[],
  lookup: Lookup,
  today: string,
): Automation[] {
  return automations.filter(automation => {
    if (automation.off) return false
    const when = automation.when
    if (when.kind === 'added') {
      if (before) return false
    } else {
      if (!before) return false
      const column = columns.find(item => item.id === when.columnId)
      if (!column) return false
      const was = before.cells[column.id],
        now = after.cells[column.id]
      if (same(was, now)) return false
      if (when.to !== undefined && asText(now) !== when.to) return false
    }
    return automation.conditions.every(condition => {
      const column = columns.find(item => item.id === condition.columnId)
      return column ? conditionHolds(condition, after, column, lookup, today) : false
    })
  })
}

/** The cell value a "set" action writes. */
export function setCellValue(column: TrackerColumn, value: string, today: string): Cell {
  if (value === '') return emptyCell(column.type)
  if (column.type === 'checkbox') return value === 'true'
  if (column.type === 'number') return Number(value)
  if (column.type === 'date' && value === TODAY) return today
  return value
}

export type AutomationPlan = {
  /** Cells to write, by column id. */
  cells: Record<string, Cell>
  /** Make the row's task (when it has none), assigned to this person ('' = the person saving). */
  task: { assignee: string } | null
  /** People to notify. */
  notify: string[]
  comments: string[]
  /** What each automation did, in words, for the run log and the person saving. */
  done: string[]
  /** Actions left out, and why. */
  skipped: string[]
}

/**
 * What the automations do to a row, without doing it. Cells that come from a one-way Google Sheet are skipped; a
 * later action on the same cell wins; the task is only made for a row with none, on a tracker that does not make
 * tasks by itself, and only when the row has a name.
 */
export function planAutomations(
  automations: Automation[],
  row: TrackerRow,
  columns: TrackerColumn[],
  options: {
    today: string
    locked: (column: TrackerColumn) => boolean
    tasksByTemplate: boolean
    personName: (id: string) => string
  },
): AutomationPlan {
  const plan: AutomationPlan = { cells: {}, task: null, notify: [], comments: [], done: [], skipped: [] }
  const name = (id: string) => columns.find(column => column.id === id)?.name || '(deleted column)'
  for (const automation of automations)
    for (const action of automation.then) {
      if (action.kind === 'set') {
        const column = columns.find(item => item.id === action.columnId)
        if (!column) continue
        if (options.locked(column)) {
          plan.skipped.push(`${column.name} comes from the Google Sheet`)
          continue
        }
        const value = setCellValue(column, action.value, options.today)
        if (same(row.cells[column.id], value) && !(column.id in plan.cells)) continue
        plan.cells[column.id] = value
        plan.done.push(`set ${column.name}`)
      } else if (action.kind === 'task') {
        if (row.taskId) continue
        if (options.tasksByTemplate) {
          plan.skipped.push('this tracker makes its tasks by itself')
          continue
        }
        const titleColumn = columns.find(column => column.type === 'text')
        const named = titleColumn ? row.cells[titleColumn.id] : ''
        if (typeof named !== 'string' || !named.trim()) {
          plan.skipped.push('no task: the row has no name yet')
          continue
        }
        const value = action.assigneeColumnId ? row.cells[action.assigneeColumnId] : ''
        plan.task = { assignee: typeof value === 'string' ? value : '' }
        plan.done.push('created its task')
      } else if (action.kind === 'notify') {
        const people = new Set(action.people || [])
        const value = action.columnId ? row.cells[action.columnId] : ''
        if (typeof value === 'string' && value) people.add(value)
        if (!people.size) {
          plan.skipped.push(`nobody to notify: ${name(action.columnId || '')} is empty`)
          continue
        }
        for (const person of people) if (!plan.notify.includes(person)) plan.notify.push(person)
        plan.done.push(`notified ${[...people].map(id => options.personName(id) || 'someone').join(', ')}`)
      } else if (action.kind === 'comment') {
        plan.comments.push(action.text)
        plan.done.push('added a comment')
      }
    }
  return plan
}

// ---- words ----

const valueWords = (column: TrackerColumn | undefined, value: string, personName: (id: string) => string) => {
  if (!column) return value
  if (value === '') return 'empty'
  if (column.type === 'select') return column.options?.find(option => option.id === value)?.label || '(deleted option)'
  if (column.type === 'person') return personName(value) || 'Unknown user'
  if (column.type === 'checkbox') return value === 'true' ? 'ticked' : 'not ticked'
  if (column.type === 'date' && value === TODAY) return 'today'
  return value
}

export function describeTrigger(when: AutomationTrigger, columns: TrackerColumn[], personName: (id: string) => string) {
  if (when.kind === 'added') return 'A row is added'
  const column = columns.find(item => item.id === when.columnId)
  const name = column?.name || '(deleted column)'
  return when.to ? `${name} changes to ${valueWords(column, when.to, personName)}` : `${name} changes`
}

export function describeAction(action: AutomationAction, columns: TrackerColumn[], personName: (id: string) => string) {
  const name = (id?: string) => columns.find(column => column.id === id)?.name || '(deleted column)'
  if (action.kind === 'set')
    return `Set ${name(action.columnId)} to ${valueWords(
      columns.find(column => column.id === action.columnId),
      action.value,
      personName,
    )}`
  if (action.kind === 'task')
    return `Create its task${action.assigneeColumnId ? `, assigned to the row’s ${name(action.assigneeColumnId)}` : ''}`
  if (action.kind === 'notify')
    return `Notify ${[
      ...(action.columnId ? [`the row’s ${name(action.columnId)}`] : []),
      ...(action.people || []).map(id => personName(id) || 'Unknown user'),
    ].join(', ')}`
  return `Add a comment: “${action.text}”`
}

export function describeAutomation(
  automation: Automation,
  columns: TrackerColumn[],
  personName: (id: string) => string,
) {
  const conditions = automation.conditions.map(condition => {
    const column = columns.find(item => item.id === condition.columnId)
    const value = ruleNeedsValue(condition.op) ? ` ${valueWords(column, condition.value, personName)}` : ''
    return `${column?.name || '(deleted column)'} ${ruleOpLabel(condition.op)}${value}`
  })
  return `${describeTrigger(automation.when, columns, personName)}${conditions.length ? `, if ${conditions.join(' and ')}` : ''} → ${automation.then
    .map(action => describeAction(action, columns, personName))
    .join('; ')}`
}

/** A new automation for the editor: when a Status-like column changes to its last option, tick or date something. */
export function newAutomation(columns: TrackerColumn[]): Automation | undefined {
  const watch = triggerColumns(columns)
  const status =
    watch.find(column => column.type === 'select' && /status|state|stage/i.test(column.name)) ||
    watch.find(column => column.type === 'select')
  const target =
    settableColumns(columns).find(column => column.type === 'date' && column.id !== status?.id) ||
    settableColumns(columns).find(column => column.id !== status?.id)
  if (!target) return undefined
  const last = status?.options?.[status.options.length - 1]
  return {
    id: randomId('a_'),
    when: status ? { kind: 'changed', columnId: status.id, ...(last ? { to: last.id } : {}) } : { kind: 'added' },
    conditions: [],
    then: [{ kind: 'set', columnId: target.id, value: target.type === 'date' ? TODAY : '' }],
  }
}
