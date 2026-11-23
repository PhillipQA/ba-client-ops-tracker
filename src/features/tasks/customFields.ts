/**
 * Custom task fields: an account's own fields on every task (Settings › Workflow), such as "Module", "Ticket link"
 * or "Story points". The definitions live in taskSettings.customFields; each task keeps its values in `custom`
 * (field id -> value). A field can be shown as a column in the Tasks table, and its values are found by search.
 *
 * Removing a field hides its values; adding it back with the same id shows them again. A Choice value that is no
 * longer one of its options is still shown, as it was saved.
 */
import type { WorkItem } from '../../shared/types'

export type TaskFieldType = 'text' | 'number' | 'date' | 'select' | 'checkbox' | 'url'
export type TaskFieldDef = {
  id: string
  name: string
  type: TaskFieldType
  /** Choice fields: the options, in order. */
  options?: string[]
  /** Shown as a column in the Tasks table. */
  showInTable?: boolean
}
export type TaskFieldValue = string | number | boolean

export const FIELD_TYPES: { value: TaskFieldType; label: string }[] = [
  { value: 'text', label: 'Text' },
  { value: 'number', label: 'Number' },
  { value: 'date', label: 'Date' },
  { value: 'select', label: 'Choice' },
  { value: 'checkbox', label: 'Checkbox' },
  { value: 'url', label: 'Link' },
]
export const FIELD_LIMITS = { fields: 30, options: 50, name: 60, option: 60, text: 1000 }

const TYPES = new Set(FIELD_TYPES.map(type => type.value))
const clip = (value: unknown, max: number) => (typeof value === 'string' ? value.trim().slice(0, max) : '')

/** Field definitions as stored or sent: malformed ones dropped, names unique, Choice fields with options. */
export function cleanFieldDefs(raw: unknown): TaskFieldDef[] {
  if (!Array.isArray(raw)) return []
  const out: TaskFieldDef[] = []
  const names = new Set<string>()
  const ids = new Set<string>()
  for (const entry of raw) {
    if (out.length >= FIELD_LIMITS.fields) break
    if (!entry || typeof entry !== 'object') continue
    const field = entry as Record<string, unknown>
    const name = clip(field.name, FIELD_LIMITS.name)
    const id = clip(field.id, 60).replace(/[^\w-]/g, '')
    const type = TYPES.has(field.type as TaskFieldType) ? (field.type as TaskFieldType) : null
    if (!name || !id || !type || names.has(name.toLowerCase()) || ids.has(id)) continue
    const def: TaskFieldDef = { id, name, type }
    if (type === 'select') {
      const options = [
        ...new Set(
          (Array.isArray(field.options) ? field.options : [])
            .map(option => clip(option, FIELD_LIMITS.option))
            .filter(Boolean),
        ),
      ].slice(0, FIELD_LIMITS.options)
      if (!options.length) continue
      def.options = options
    }
    if (field.showInTable === true) def.showInTable = true
    names.add(name.toLowerCase())
    ids.add(id)
    out.push(def)
  }
  return out
}

/** A field's value as it may be saved ('' and false-ish empties become undefined: nothing to keep). */
export function cleanFieldValue(def: TaskFieldDef, value: unknown): TaskFieldValue | undefined {
  if (value === undefined || value === null || value === '') return undefined
  switch (def.type) {
    case 'number': {
      const number = typeof value === 'number' ? value : Number(String(value).trim())
      return Number.isFinite(number) ? number : undefined
    }
    case 'checkbox':
      return value === true || value === 'true' ? true : undefined
    case 'date': {
      const day = String(value).slice(0, 10)
      return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : undefined
    }
    case 'url': {
      const text = clip(value, FIELD_LIMITS.text)
      if (!text) return undefined
      const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`
      return /^https?:\/\//i.test(withScheme) ? withScheme : undefined
    }
    case 'select':
      return clip(value, FIELD_LIMITS.option) || undefined
    default:
      return clip(value, FIELD_LIMITS.text) || undefined
  }
}

/** A task's values for these fields, cleaned; values of removed fields are kept as they were (hidden). */
export function cleanCustomValues(
  defs: readonly TaskFieldDef[],
  next: Record<string, unknown> | undefined,
  previous?: Record<string, TaskFieldValue>,
): Record<string, TaskFieldValue> | undefined {
  const known = new Set(defs.map(def => def.id))
  const out: Record<string, TaskFieldValue> = {}
  for (const [id, value] of Object.entries(previous || {})) if (!known.has(id)) out[id] = value
  for (const def of defs) {
    const value = cleanFieldValue(def, next?.[def.id])
    if (value !== undefined) out[def.id] = value
  }
  return Object.keys(out).length ? out : undefined
}

/** A value as text: for table cells, search and CSV. */
export function fieldText(def: TaskFieldDef, value: TaskFieldValue | undefined): string {
  if (value === undefined || value === '') return ''
  if (def.type === 'checkbox') return value === true ? 'Yes' : ''
  if (def.type === 'date' && typeof value === 'string') {
    const [year, month, day] = value.split('-').map(Number)
    return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString('en', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      timeZone: 'UTC',
    })
  }
  return String(value)
}

/** Every custom value of a task as text, for search. */
export function customSearchText(defs: readonly TaskFieldDef[], item: Pick<WorkItem, 'custom'>): string {
  return defs
    .map(def => fieldText(def, item.custom?.[def.id]))
    .filter(Boolean)
    .join(' ')
}

/** A new field id from its name: "Story points" -> "story-points", made unique among the others. */
export function fieldIdFor(name: string, taken: readonly string[]) {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40) || 'field'
  let id = base
  for (let n = 2; taken.includes(id); n++) id = `${base}-${n}`
  return id
}
