/**
 * Minimized task windows: a task being edited can be put aside in a dock at the bottom of the screen and opened again
 * with one click, like the email drafts (which have their own dock). Up to four are kept, per person, in this browser.
 * The dock keeps which tasks they are: the task's saved details always come from the workspace when it is opened again.
 */
export const MAX_DOCKED_TASKS = 4

export function cleanDocked(value: unknown, liveIds?: Set<string>) {
  const ids: string[] = []
  for (const id of Array.isArray(value) ? value : []) {
    if (typeof id !== 'string' || !id || ids.includes(id)) continue
    if (liveIds && !liveIds.has(id)) continue
    ids.push(id.slice(0, 80))
  }
  return ids.slice(0, MAX_DOCKED_TASKS)
}

/** Adds a task to the dock (moving it to the end if it is there already). A full dock takes no more. */
export function dockTask(docked: string[], id: string): { docked: string[]; problem?: string } {
  const others = docked.filter(entry => entry !== id)
  if (others.length >= MAX_DOCKED_TASKS)
    return {
      docked,
      problem: `You already have ${MAX_DOCKED_TASKS} tasks minimized. Open or close one of them (at the bottom of the screen) first.`,
    }
  return { docked: [...others, id] }
}

export const undockTask = (docked: string[], id: string) => docked.filter(entry => entry !== id)

/** What a form holds now, to tell whether anything was changed since it opened. */
export function formSnapshot(form: HTMLFormElement | null, extra: unknown) {
  if (!form) return ''
  const fields: [string, string][] = []
  new FormData(form).forEach((value, key) => {
    if (typeof value === 'string') fields.push([key, value])
  })
  return JSON.stringify([fields, extra])
}
