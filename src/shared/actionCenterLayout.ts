/**
 * The Action Center is a set of widgets each person picks, orders and sizes for themselves. An Administrator can save
 * a layout as a job role's starting layout (QA, Support…); a person without their own layout gets their role's, and
 * anyone can go back to it. With neither, everyone gets the built-in layout: the page as it always was.
 *
 * A layout is the visible widgets in order, each full or half width. Widgets a person cannot use (no AI BA Assistant,
 * no Work Hub, no Documents) are left out when it is shown, so one role layout fits everyone who has that role.
 */
import type { AppModule } from './types'
import { cleanSettings } from './actionCenterSettings'

export type WidgetId =
  | 'brief'
  | 'counts'
  | 'activities'
  | 'calendar'
  | 'assistant'
  | 'attention'
  | 'workhub'
  | 'dochub'
  | 'rollouts'
  | 'custom'
  | 'pinned'
  | 'time'
  | 'followups'
  | 'trackerChanges'
  | 'links'
export type WidgetWidth = 'full' | 'half'
export type LayoutItem = {
  id: WidgetId
  width: WidgetWidth
  /** Set on widgets that can be added more than once (each its own key); otherwise the id is the key. */
  key?: string
  /** What the widget shows, where it can be changed (see actionCenterSettings). */
  settings?: Record<string, unknown>
}
export type ActionCenterLayout = LayoutItem[]

export type WidgetDefinition = {
  id: WidgetId
  label: string
  description: string
  /** The width it gets when added. */
  width: WidgetWidth
  /** The page a person needs to see this widget. */
  module?: AppModule
  /** Can be on the page more than once, each with its own settings; added from its own dialog, not the Add list. */
  multi?: boolean
}

export const ACTION_CENTER_WIDGETS: WidgetDefinition[] = [
  {
    id: 'brief',
    label: 'Morning brief',
    description: 'Today at a glance, with an AI summary on request.',
    width: 'full',
  },
  {
    id: 'counts',
    label: 'Counts',
    description: 'Needs attention, waiting on, activities today, open inquiries.',
    width: 'full',
  },
  {
    id: 'activities',
    label: 'Activities',
    description: 'Meetings, tracker activities and follow-ups, today or this week.',
    width: 'full',
  },
  { id: 'calendar', label: 'Google Calendar', description: 'Your connected calendar.', width: 'full' },
  {
    id: 'assistant',
    label: 'AI BA Assistant',
    description: 'Ask about a client inquiry or note.',
    width: 'full',
    module: 'ai',
  },
  {
    id: 'attention',
    label: 'Needs attention',
    description: 'Open tasks and subtasks, most urgent first.',
    width: 'full',
  },
  {
    id: 'workhub',
    label: 'Work Hub emails',
    description: 'Your latest client emails, unread first.',
    width: 'half',
    module: 'inbox',
  },
  {
    id: 'dochub',
    label: 'Awaiting signature',
    description: 'DocHub documents still out for signing.',
    width: 'half',
    module: 'documents',
  },
  {
    id: 'rollouts',
    label: 'Rollouts due this week',
    description: 'Site rollout rows going live in the next seven days, and any overdue.',
    width: 'half',
    module: 'trackers',
  },
  {
    id: 'time',
    label: 'My time this week',
    description: 'Hours logged each day against your weekly target, and time still to send to Seeds.',
    width: 'half',
    module: 'items',
  },
  {
    id: 'followups',
    label: 'Follow-ups due',
    description: 'Follow-ups due today and overdue; tick one to mark it done.',
    width: 'half',
    module: 'items',
  },
  {
    id: 'trackerChanges',
    label: 'Recent tracker changes',
    description: 'Edits, comments and automation runs on the trackers you can open.',
    width: 'half',
    module: 'trackers',
  },
  {
    id: 'links',
    label: 'Quick links and note',
    description: 'Your own links and a short note, only for you.',
    width: 'half',
  },
  {
    id: 'custom',
    label: 'Your own widget',
    description: 'A number, chart or table you build, like in Reports.',
    width: 'half',
    module: 'reports',
    multi: true,
  },
  {
    id: 'pinned',
    label: 'Pinned from Reports',
    description: 'A widget of a saved report; it follows the report.',
    width: 'half',
    module: 'reports',
    multi: true,
  },
]

const KNOWN = new Map(ACTION_CENTER_WIDGETS.map(widget => [widget.id, widget]))
const KEY = /^[A-Za-z0-9_-]{1,40}$/
export const LAYOUT_LIMIT = 30

/** The key a layout item is found by: its own key, else its id. */
export const keyOf = (item: Pick<LayoutItem, 'id' | 'key'>) => item.key || item.id

/** The page as it was before widgets: every original section, full width, in its old order. */
export const DEFAULT_ACTION_CENTER: ActionCenterLayout = (
  ['brief', 'counts', 'activities', 'calendar', 'assistant', 'attention'] as WidgetId[]
).map(id => ({ id, width: 'full' }))

/**
 * A saved layout, made safe: known widgets, each once (or each key once, for widgets that can repeat), a valid width,
 * cleaned settings. Not a list → undefined (none saved).
 */
export function cleanLayout(raw: unknown): ActionCenterLayout | undefined {
  if (!Array.isArray(raw)) return undefined
  const seen = new Set<string>()
  const layout: ActionCenterLayout = []
  for (const entry of raw) {
    if (layout.length >= LAYOUT_LIMIT) break
    const id = String((entry as any)?.id ?? entry) as WidgetId
    const known = KNOWN.get(id)
    if (!known) continue
    const rawKey = (entry as any)?.key
    const key = known.multi ? (typeof rawKey === 'string' && KEY.test(rawKey) ? rawKey : '') : id
    if (!key || seen.has(key)) continue
    seen.add(key)
    const item: LayoutItem = { id, width: (entry as any)?.width === 'half' ? 'half' : 'full' }
    if (known.multi) item.key = key
    const settings = cleanSettings(id, (entry as any)?.settings)
    if (settings) item.settings = settings
    else if (known.multi) continue
    layout.push(item)
  }
  return layout
}

/** The layout to show: the person's own, else their role's, else the built-in one, without widgets they can't use. */
export function layoutToShow(
  input: { own?: ActionCenterLayout | null; role?: ActionCenterLayout | null },
  canSee: (module: AppModule) => boolean,
): ActionCenterLayout {
  const layout = cleanLayout(input.own) ?? cleanLayout(input.role) ?? DEFAULT_ACTION_CENTER
  return layout.filter(item => {
    const module = KNOWN.get(item.id)?.module
    return !module || canSee(module)
  })
}

/** Widgets that can still be added from the list: known, usable, not on the page, and not added from a dialog. */
export function widgetsToAdd(layout: ActionCenterLayout, canSee: (module: AppModule) => boolean) {
  const shown = new Set(layout.map(item => item.id))
  return ACTION_CENTER_WIDGETS.filter(
    widget => !widget.multi && !shown.has(widget.id) && (!widget.module || canSee(widget.module)),
  )
}

const newKey = (id: string) => `${id}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

/** Adds a widget at the end. A widget that repeats gets a new key and needs its settings. */
export function addWidget(
  layout: ActionCenterLayout,
  id: WidgetId,
  settings?: Record<string, unknown>,
): ActionCenterLayout {
  const known = KNOWN.get(id)
  if (!known || layout.length >= LAYOUT_LIMIT) return layout
  if (!known.multi && layout.some(item => item.id === id)) return layout
  const item: LayoutItem = { id, width: known.width }
  if (known.multi) {
    if (!settings) return layout
    item.key = newKey(id)
  }
  if (settings) item.settings = settings
  return [...layout, item]
}

export const removeWidget = (layout: ActionCenterLayout, key: string): ActionCenterLayout =>
  layout.filter(item => keyOf(item) !== key)

export const setWidgetWidth = (layout: ActionCenterLayout, key: string, width: WidgetWidth): ActionCenterLayout =>
  layout.map(item => (keyOf(item) === key ? { ...item, width } : item))

/** Replaces a widget's settings; undefined goes back to its defaults. */
export const setWidgetSettings = (
  layout: ActionCenterLayout,
  key: string,
  settings: Record<string, unknown> | undefined,
): ActionCenterLayout =>
  layout.map(item => {
    if (keyOf(item) !== key) return item
    const { settings: _old, ...rest } = item
    return settings ? { ...rest, settings } : rest
  })

/** Moves a widget to another place in the order (drag and drop, or the up/down buttons). */
export function moveWidget(layout: ActionCenterLayout, key: string, to: number): ActionCenterLayout {
  const from = layout.findIndex(item => keyOf(item) === key)
  if (from < 0) return layout
  const target = Math.max(0, Math.min(layout.length - 1, to))
  if (target === from) return layout
  const next = [...layout]
  const [moved] = next.splice(from, 1)
  next.splice(target, 0, moved)
  return next
}

export const sameLayout = (a?: ActionCenterLayout | null, b?: ActionCenterLayout | null) =>
  JSON.stringify(cleanLayout(a) ?? null) === JSON.stringify(cleanLayout(b) ?? null)

export const widgetLabel = (id: WidgetId) => KNOWN.get(id)?.label || id
