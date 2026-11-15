/**
 * The Action Center is a set of widgets each person picks, orders and sizes for themselves. An Administrator can save
 * a layout as a job role's starting layout (QA, Support…); a person without their own layout gets their role's, and
 * anyone can go back to it. With neither, everyone gets the built-in layout: the page as it always was.
 *
 * A layout is the visible widgets in order, each full or half width. Widgets a person cannot use (no AI BA Assistant,
 * no Work Hub, no Documents) are left out when it is shown, so one role layout fits everyone who has that role.
 */
import type { AppModule } from './types'

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
export type WidgetWidth = 'full' | 'half'
export type LayoutItem = { id: WidgetId; width: WidgetWidth }
export type ActionCenterLayout = LayoutItem[]

export type WidgetDefinition = {
  id: WidgetId
  label: string
  description: string
  /** The width it gets when added. */
  width: WidgetWidth
  /** The page a person needs to see this widget. */
  module?: AppModule
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
]

const KNOWN = new Map(ACTION_CENTER_WIDGETS.map(widget => [widget.id, widget]))

/** The page as it was before widgets: every original section, full width, in its old order. */
export const DEFAULT_ACTION_CENTER: ActionCenterLayout = (
  ['brief', 'counts', 'activities', 'calendar', 'assistant', 'attention'] as WidgetId[]
).map(id => ({ id, width: 'full' }))

/** A saved layout, made safe: known widgets, each once, a valid width. Not a list → undefined (none saved). */
export function cleanLayout(raw: unknown): ActionCenterLayout | undefined {
  if (!Array.isArray(raw)) return undefined
  const seen = new Set<WidgetId>()
  const layout: ActionCenterLayout = []
  for (const entry of raw) {
    const id = String((entry as any)?.id ?? entry) as WidgetId
    if (!KNOWN.has(id) || seen.has(id)) continue
    seen.add(id)
    layout.push({ id, width: (entry as any)?.width === 'half' ? 'half' : 'full' })
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

/** Widgets that can still be added: known, usable, and not on the page. */
export function widgetsToAdd(layout: ActionCenterLayout, canSee: (module: AppModule) => boolean) {
  const shown = new Set(layout.map(item => item.id))
  return ACTION_CENTER_WIDGETS.filter(widget => !shown.has(widget.id) && (!widget.module || canSee(widget.module)))
}

export const addWidget = (layout: ActionCenterLayout, id: WidgetId): ActionCenterLayout =>
  layout.some(item => item.id === id) || !KNOWN.has(id) ? layout : [...layout, { id, width: KNOWN.get(id)!.width }]

export const removeWidget = (layout: ActionCenterLayout, id: WidgetId): ActionCenterLayout =>
  layout.filter(item => item.id !== id)

export const setWidgetWidth = (layout: ActionCenterLayout, id: WidgetId, width: WidgetWidth): ActionCenterLayout =>
  layout.map(item => (item.id === id ? { ...item, width } : item))

/** Moves a widget to another place in the order (drag and drop, or the up/down buttons). */
export function moveWidget(layout: ActionCenterLayout, id: WidgetId, to: number): ActionCenterLayout {
  const from = layout.findIndex(item => item.id === id)
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
