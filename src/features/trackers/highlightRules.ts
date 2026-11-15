/**
 * Highlight rules: rows colour themselves from their own values, such as "Go-live is past and Status is not Live →
 * red". Rules are checked top to bottom and the first that matches gives the row its colour. A colour set by hand on a
 * row still wins, and a rule wins over "Colour by status". No AI: plain comparisons, re-checked as rows change.
 *
 * Rules are view settings shared by everyone on the tracker (kept with the Timeline settings).
 * Pure functions, shared by the app, the server and the tests.
 */
import {
  type FilterOp,
  filterNeedsValue,
  filterOpLabel,
  filterOpsFor,
  OPTION_COLORS,
  type OptionColor,
  randomId,
  type TrackerColumn,
  type TrackerRow,
} from './trackerModel'
import { type Lookup, matchesFilter, shown } from './trackerQuery'

/** Date columns also take: the date has passed, is today, or falls in the next N days (today included). */
export type RuleOp = FilterOp | 'past' | 'today' | 'within'
export type RuleCondition = { columnId: string; op: RuleOp; value: string }
export type HighlightRule = {
  id: string
  color: OptionColor
  /** Switched off without being deleted. */
  off?: boolean
  /** All of them must hold. */
  conditions: RuleCondition[]
}

export const RULE_LIMITS = { rules: 10, conditions: 3, value: 200, days: 365 }
const DATE_OPS: RuleOp[] = ['past', 'today', 'within']
const isDateColumn = (column: TrackerColumn) => column.type === 'date' || column.type === 'task_due'

/** The comparisons a column offers in a rule: the filter's, plus the date ones for date columns. */
export const ruleOpsFor = (column: TrackerColumn): RuleOp[] =>
  column.type === 'secret'
    ? []
    : isDateColumn(column)
      ? [...DATE_OPS, ...filterOpsFor(column.type)]
      : filterOpsFor(column.type)

export const ruleOpLabel = (op: RuleOp) =>
  op === 'past'
    ? 'is before today'
    : op === 'today'
      ? 'is today'
      : op === 'within'
        ? 'is within the next'
        : filterOpLabel[op]

export const ruleNeedsValue = (op: RuleOp) =>
  op === 'past' || op === 'today' ? false : op === 'within' ? true : filterNeedsValue(op)

/** Columns a rule can look at. */
export const ruleColumns = (columns: TrackerColumn[]) => columns.filter(column => ruleOpsFor(column).length > 0)

/** Saved rules, made safe: known columns, comparisons that fit them, a known colour. Broken conditions are dropped. */
export function cleanRules(raw: unknown, columns: TrackerColumn[]): HighlightRule[] {
  if (!Array.isArray(raw)) return []
  const byId = new Map(columns.map(column => [column.id, column]))
  const seen = new Set<string>()
  const rules: HighlightRule[] = []
  for (const entry of raw.slice(0, RULE_LIMITS.rules * 2)) {
    if (!entry || typeof entry !== 'object') continue
    const color = OPTION_COLORS.find(item => item === entry.color)
    if (!color) continue
    const conditions: RuleCondition[] = []
    for (const item of Array.isArray(entry.conditions) ? entry.conditions : []) {
      const column = byId.get(String(item?.columnId || ''))
      const op = column ? ruleOpsFor(column).find(candidate => candidate === item?.op) : undefined
      if (!column || !op) continue
      let value = ruleNeedsValue(op) ? String(item?.value ?? '').slice(0, RULE_LIMITS.value) : ''
      if (op === 'within') {
        const days = Math.round(Number(value))
        if (!Number.isFinite(days) || days < 0) continue
        value = String(Math.min(RULE_LIMITS.days, days))
      } else if (ruleNeedsValue(op) && value.trim() === '') continue
      conditions.push({ columnId: column.id, op, value })
      if (conditions.length >= RULE_LIMITS.conditions) break
    }
    if (!conditions.length) continue
    let id = typeof entry.id === 'string' && /^[a-z0-9_]{3,40}$/i.test(entry.id) && !seen.has(entry.id) ? entry.id : ''
    while (!id || seen.has(id)) id = randomId('r_')
    seen.add(id)
    rules.push({ id, color, conditions, ...(entry.off === true ? { off: true } : {}) })
    if (rules.length >= RULE_LIMITS.rules) break
  }
  return rules
}

const addDays = (iso: string, days: number) => {
  const date = new Date(`${iso}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

function conditionHolds(
  condition: RuleCondition,
  row: TrackerRow,
  column: TrackerColumn,
  lookup: Lookup,
  today: string,
) {
  if (condition.op === 'past' || condition.op === 'today' || condition.op === 'within') {
    const date = shown(column, row, lookup).text.slice(0, 10)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false
    if (condition.op === 'past') return date < today
    if (condition.op === 'today') return date === today
    return date >= today && date <= addDays(today, Number(condition.value) || 0)
  }
  return matchesFilter(column, row, { columnId: condition.columnId, op: condition.op, value: condition.value }, lookup)
}

/** The colour the rules give a row: the first rule, top to bottom, whose conditions all hold. */
export function ruleTone(
  rules: HighlightRule[],
  row: TrackerRow,
  columns: TrackerColumn[],
  lookup: Lookup,
  today: string,
): OptionColor | undefined {
  for (const rule of rules) {
    if (rule.off || !rule.conditions.length) continue
    const holds = rule.conditions.every(condition => {
      const column = columns.find(item => item.id === condition.columnId)
      // A rule about a column that was deleted never matches, rather than matching everything.
      return column ? conditionHolds(condition, row, column, lookup, today) : false
    })
    if (holds) return rule.color
  }
  return undefined
}

/** The colours for all rows that some rule matches. */
export function ruleTones(
  rules: HighlightRule[],
  rows: TrackerRow[],
  columns: TrackerColumn[],
  lookup: Lookup,
  today: string,
) {
  const tones = new Map<string, OptionColor>()
  if (!rules.some(rule => !rule.off)) return tones
  for (const row of rows) {
    const tone = ruleTone(rules, row, columns, lookup, today)
    if (tone) tones.set(row.id, tone)
  }
  return tones
}

/** A rule in words, for the legend: "Go-live is before today and Status is not Live". */
export function describeRule(rule: HighlightRule, columns: TrackerColumn[], personName: (id: string) => string) {
  return rule.conditions
    .map(condition => {
      const column = columns.find(item => item.id === condition.columnId)
      if (!column) return '(deleted column)'
      const value = !ruleNeedsValue(condition.op)
        ? ''
        : condition.op === 'within'
          ? `${condition.value} day${condition.value === '1' ? '' : 's'}`
          : column.type === 'select'
            ? column.options?.find(option => option.id === condition.value)?.label || '(deleted option)'
            : column.type === 'person'
              ? personName(condition.value) || 'Unknown user'
              : condition.value
      return `${column.name} ${ruleOpLabel(condition.op)}${value ? ` ${value}` : ''}`
    })
    .join(' and ')
}

/** A new rule for the editor, on the first column that suits one. */
export function newRule(columns: TrackerColumn[]): HighlightRule | undefined {
  const usable = ruleColumns(columns)
  const column = usable.find(isDateColumn) || usable.find(item => item.type === 'select') || usable[0]
  if (!column) return undefined
  const op = ruleOpsFor(column)[0]
  return {
    id: randomId('r_'),
    color: 'red',
    conditions: [{ columnId: column.id, op, value: op === 'within' ? '7' : '' }],
  }
}
