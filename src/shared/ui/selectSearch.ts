/**
 * The app-wide rule for choosing from a list: more than SEARCH_AFTER choices are typed into (a search list), fewer are
 * a plain dropdown. LongSelectSearch applies it to every native <select>; SearchSelect applies it the other way round.
 */
export const SEARCH_AFTER = 10

/** One choice of a native <select>, as the search list shows it. */
export type SelectOption = { value: string; label: string; group: string; disabled: boolean }

type SelectLike = {
  multiple: boolean
  size: number
  disabled: boolean
  dataset: { native?: string }
  options: ArrayLike<{ hidden: boolean | string }>
}

/** Whether a <select> opens the search list: a single-choice, enabled dropdown with more than SEARCH_AFTER choices. */
export function usesSearch(select: SelectLike): boolean {
  if (select.multiple || select.size > 1 || select.disabled) return false
  // `data-native` keeps the browser's own list (a select that must stay native).
  if (select.dataset.native !== undefined) return false
  // A hidden placeholder (such as "Choose…") is not a choice.
  let choices = 0
  for (let at = 0; at < select.options.length; at++) if (!select.options[at].hidden) choices += 1
  return choices > SEARCH_AFTER
}

/**
 * The choices matching what was typed: every word must appear in the label or its group. Labels starting with the
 * first word come first; with groups, each group's choices stay together, in the list's order of groups.
 */
export function matchOptions<T extends { label: string; group?: string }>(options: T[], query: string): T[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return options
  const hits = options.filter(option =>
    words.every(word => `${option.label} ${option.group || ''}`.toLowerCase().includes(word)),
  )
  const starts = (option: T) => option.label.toLowerCase().startsWith(words[0])
  const ranked = [...hits.filter(starts), ...hits.filter(option => !starts(option))]
  const groups = [...new Set(options.map(option => option.group || ''))]
  if (groups.length < 2) return ranked
  return ranked.sort((a, b) => groups.indexOf(a.group || '') - groups.indexOf(b.group || ''))
}
