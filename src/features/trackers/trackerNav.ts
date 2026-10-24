/** Remembers which tracker (and row) to open, so other screens can send the person straight to it. */
const OPEN_KEY = 'ba.trackers.open'
const ROW_KEY = 'ba.trackers.openRow'

export const rememberedTracker = () => {
  try {
    return window.sessionStorage.getItem(OPEN_KEY) || ''
  } catch {
    return ''
  }
}
export const rememberTracker = (id: string) => {
  try {
    if (id) window.sessionStorage.setItem(OPEN_KEY, id)
    else window.sessionStorage.removeItem(OPEN_KEY)
  } catch {
    /* Storage can be blocked. The list still works. */
  }
}
/** Asks the next tracker screen for this tracker to open the row's details. */
export const rememberTrackerRow = (trackerId: string, rowId: string) => {
  rememberTracker(trackerId)
  try {
    window.sessionStorage.setItem(ROW_KEY, `${trackerId}:${rowId}`)
  } catch {
    /* Without storage the tracker still opens. */
  }
}
/** The row to open for this tracker, once. */
export const takeTrackerRow = (trackerId: string) => {
  try {
    const value = window.sessionStorage.getItem(ROW_KEY) || ''
    if (!value.startsWith(`${trackerId}:`)) return ''
    window.sessionStorage.removeItem(ROW_KEY)
    return value.slice(trackerId.length + 1)
  } catch {
    return ''
  }
}

const REVIEW_KEY = 'ba.trackers.review'
/** Asks the tracker to open the review of these rows ('flagged' = every row waiting for review) when it next opens. */
export const rememberReview = (trackerId: string, rows: string[] | 'flagged') => {
  try {
    window.sessionStorage.setItem(REVIEW_KEY, JSON.stringify({ trackerId, rows }))
  } catch {
    /* The review can still be opened from the banner. */
  }
}
export const takeReview = (trackerId: string): string[] | 'flagged' | null => {
  try {
    const value = JSON.parse(window.sessionStorage.getItem(REVIEW_KEY) || 'null')
    if (!value || value.trackerId !== trackerId) return null
    window.sessionStorage.removeItem(REVIEW_KEY)
    return value.rows === 'flagged' ? 'flagged' : Array.isArray(value.rows) ? value.rows.map(String) : null
  } catch {
    return null
  }
}
