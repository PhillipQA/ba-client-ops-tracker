/** Small helpers the AI assistant modules share for reading the workspace and trimming text. */

/** Text on one line, at most `length` characters. */
export const clip = (value: unknown, length: number) => `${value ?? ''}`.replace(/\s+/g, ' ').trim().slice(0, length)

/** A workspace list (items, clients…), or empty when the workspace has none. */
export const stateList = (state: any, key: string): any[] => (Array.isArray(state?.[key]) ? state[key] : [])
