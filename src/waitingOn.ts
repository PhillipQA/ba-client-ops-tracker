import type { WaitingOnDefinition } from './types'

/**
 * "Waiting on" options are configured per account in Internal Admin, next to
 * task statuses. Tasks store the option label. Exactly one option is the
 * completion option: completing a task sets it, and a task waiting on it
 * counts as done everywhere (reports, Action Center, notifications).
 *
 * This module is shared by the browser and the server, so it must stay free
 * of browser- and Node-specific imports.
 */

export const DEFAULT_WAITING_ON: readonly WaitingOnDefinition[] = Object.freeze([
  { id: 'me', label: 'Me', done: false },
  { id: 'developer', label: 'Developer', done: false },
  { id: 'client', label: 'Client', done: false },
  { id: 'qa', label: 'QA', done: false },
  { id: 'design', label: 'Design', done: false },
  { id: 'done', label: 'Done', done: true },
])

export const WAITING_ON_LIMITS = { maxOptions: 30, maxLabel: 40, maxId: 100 } as const

/** Default option ids that have their own chip colour. Anything else uses the neutral "custom" style. */
const STYLED_IDS = new Set(['me', 'developer', 'client', 'qa', 'design'])

type SettingsLike = { waitingOn?: unknown } | null | undefined

const defaults = () => DEFAULT_WAITING_ON.map((option) => ({ ...option }))

function cleanOption(raw: unknown, index: number): WaitingOnDefinition | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Record<string, unknown>
  const label = String(value.label ?? '').trim()
  if (!label) return null
  return { id: String(value.id || `waiting-${index + 1}`), label, done: Boolean(value.done) }
}

/**
 * The configured options for an account, or the built-in defaults when the
 * account has none yet (older workspaces) or the stored list is unusable.
 */
export function waitingOnOptions(settings: SettingsLike): WaitingOnDefinition[] {
  const stored = settings?.waitingOn
  if (!Array.isArray(stored)) return defaults()
  const options = stored.map(cleanOption).filter((option): option is WaitingOnDefinition => Boolean(option))
  return validWaitingOnShape(options) ? options : defaults()
}

function validWaitingOnShape(options: WaitingOnDefinition[]) {
  const ids = new Set(options.map((option) => option.id))
  const labels = new Set(options.map((option) => option.label.toLowerCase()))
  return options.length >= 2
    && ids.size === options.length
    && labels.size === options.length
    && options.filter((option) => option.done).length === 1
}

/** Options a person can pick for open work (everything except the completion option). */
export function openWaitingOnOptions(settings: SettingsLike) {
  return waitingOnOptions(settings).filter((option) => !option.done)
}

/** Label written when a task is completed. */
export function doneWaitingOn(settings: SettingsLike) {
  return waitingOnOptions(settings).find((option) => option.done)!.label
}

/** Label used for new and reopened work: the first open option. */
export function defaultWaitingOn(settings: SettingsLike) {
  return openWaitingOnOptions(settings)[0].label
}

/**
 * Whether a task's waiting-on value marks it as done. Values that are not in
 * the configured list fall back to the legacy rule (the literal "Done").
 */
export function isWaitingOnDone(value: unknown, settings: SettingsLike) {
  const label = String(value ?? '')
  const match = waitingOnOptions(settings).find((option) => option.label === label)
  return match ? match.done : label.toLowerCase() === 'done'
}

export function findWaitingOn(value: unknown, settings: SettingsLike) {
  return waitingOnOptions(settings).find((option) => option.label === String(value ?? ''))
}

/** CSS suffix for `waiting-*` chips and `tone-*` board dots. */
export function waitingOnTone(value: unknown, settings: SettingsLike) {
  const option = findWaitingOn(value, settings)
  if (option?.done || (!option && String(value ?? '').toLowerCase() === 'done')) return 'done'
  if (option && STYLED_IDS.has(option.id)) return option.id
  const legacy = String(value ?? '').toLowerCase()
  return !option && STYLED_IDS.has(legacy) ? legacy : 'custom'
}

export type WaitingOnUpdate = {
  options: WaitingOnDefinition[]
  /** Old label → new label for options that were renamed. */
  renamed: Map<string, string>
}

/**
 * Validates an Internal Admin change to the waiting-on list against the
 * account's current options and tasks. Renaming an option is allowed and
 * moves its tasks to the new label. Removing an option that tasks still use
 * is rejected, as is changing which option marks work as done.
 */
export function planWaitingOnUpdate(input: unknown, current: SettingsLike, items: readonly { waitingOn?: unknown }[]): { ok: true; update: WaitingOnUpdate } | { ok: false; error: string } {
  if (!Array.isArray(input) || input.length < 2 || input.length > WAITING_ON_LIMITS.maxOptions) {
    return { ok: false, error: `Provide between 2 and ${WAITING_ON_LIMITS.maxOptions} waiting-on options.` }
  }
  const options = input.map((raw: any) => ({
    id: String(raw?.id ?? '').trim().slice(0, WAITING_ON_LIMITS.maxId),
    label: String(raw?.label ?? '').trim(),
    done: Boolean(raw?.done),
  }))
  if (options.some((option) => !option.id || !option.label)) return { ok: false, error: 'Every waiting-on option needs a name.' }
  if (options.some((option) => option.label.length > WAITING_ON_LIMITS.maxLabel)) return { ok: false, error: `Keep waiting-on names to ${WAITING_ON_LIMITS.maxLabel} characters.` }
  if (new Set(options.map((option) => option.id)).size !== options.length) return { ok: false, error: 'Waiting-on option IDs must be unique.' }
  if (new Set(options.map((option) => option.label.toLowerCase())).size !== options.length) return { ok: false, error: 'Waiting-on names must be unique.' }
  if (options.filter((option) => option.done).length !== 1) return { ok: false, error: 'Exactly one waiting-on option must mark work as done.' }

  const previous = waitingOnOptions(current)
  const previousDone = previous.find((option) => option.done)!
  const nextDone = options.find((option) => option.done)!
  if (nextDone.id !== previousDone.id) return { ok: false, error: 'The completion option can be renamed but not replaced.' }

  const nextById = new Map(options.map((option) => [option.id, option]))
  const renamed = new Map<string, string>()
  for (const option of previous) {
    const next = nextById.get(option.id)
    if (next && next.label !== option.label) renamed.set(option.label, next.label)
  }
  const used = new Map<string, number>()
  for (const item of items) {
    const label = String(item?.waitingOn ?? '')
    if (label) used.set(label, (used.get(label) || 0) + 1)
  }
  for (const option of previous) {
    const count = used.get(option.label) || 0
    if (count && !nextById.has(option.id)) {
      return { ok: false, error: `"${option.label}" is used by ${count} task${count === 1 ? '' : 's'}. Move ${count === 1 ? 'it' : 'them'} to another option before removing it.` }
    }
  }
  return { ok: true, update: { options, renamed } }
}

/** Applies renames from {@link planWaitingOnUpdate} to the account's tasks. */
export function applyWaitingOnRenames<T extends { waitingOn?: unknown }>(items: readonly T[], renamed: Map<string, string>): T[] {
  if (!renamed.size) return [...items]
  return items.map((item) => {
    const next = renamed.get(String(item?.waitingOn ?? ''))
    return next === undefined ? item : { ...item, waitingOn: next }
  })
}
