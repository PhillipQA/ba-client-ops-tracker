/**
 * Asks Work Hub to open one message (from the morning brief, say). The request waits in this tab's session storage
 * until Work Hub has opened the message, so a page reload or React's double effects in development do not lose it.
 */
const OPEN_KEY = 'ba.workhub.openMessage'

export type WorkHubTarget = { id: string; source: 'Gmail' | 'Discord' }

export const rememberWorkHubMessage = (id: string, source: string) => {
  try {
    if (!id) return
    const target: WorkHubTarget = { id, source: source === 'Discord' ? 'Discord' : 'Gmail' }
    window.sessionStorage.setItem(OPEN_KEY, JSON.stringify(target))
  } catch {
    /* Without storage Work Hub still opens, on its list. */
  }
}

/** The message Work Hub was asked to open, if any. Reading leaves it in place; see forgetWorkHubMessage. */
export const wantedWorkHubMessage = (): WorkHubTarget | null => {
  try {
    const value = JSON.parse(window.sessionStorage.getItem(OPEN_KEY) || 'null')
    if (!value || typeof value.id !== 'string' || !value.id) return null
    return { id: value.id, source: value.source === 'Discord' ? 'Discord' : 'Gmail' }
  } catch {
    return null
  }
}

export const forgetWorkHubMessage = () => {
  try {
    window.sessionStorage.removeItem(OPEN_KEY)
  } catch {
    /* Nothing to forget. */
  }
}
