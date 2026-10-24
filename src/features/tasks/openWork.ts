import { createContext, useContext } from 'react'

/**
 * Whether a task status counts as closed or resolved in this account's task settings. Pickers that offer a task or
 * subtask to link, file under or attach to use it to offer only open work. The app provides the account's rule; the
 * default matches the built-in Resolved and Closed statuses.
 */
export const ClosedStatusContext = createContext<(status: string) => boolean>(
  status => status === 'Resolved' || status === 'Closed',
)
export const useIsClosed = () => useContext(ClosedStatusContext)
