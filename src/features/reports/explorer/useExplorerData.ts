// Data explorer: the tables, loaded as queries need them. Trackers and Work Hub messages are fetched the first time a
// query reads them; everything else is already in the browser.
import { useCallback, useMemo, useRef, useState } from 'react'
import { businessDateKey, useBusinessDate } from '../../../shared/businessDate'
import { requestJson } from '../../../shared/http'
import type {
  Client,
  PlannerActivity,
  Project,
  TaskSettings,
  UserAccount,
  WorkActivityEvent,
  WorkItem,
} from '../../../shared/types'
import { loadAllRows, trackerApi } from '../../trackers/trackerApi'
import type { Tracker, TrackerRow } from '../../trackers/trackerModel'
import { explorerCatalog, explorerTables, type ExplorerMessage, type TableInfo } from './explorerTables'
import {
  referencedTables,
  resolveTableIdentifierParams,
  runQuery,
  SqlError,
  type SqlResult,
  type SqlTable,
} from './sqlEngine'

export type ExplorerProps = {
  clients: Client[]
  projects: Project[]
  items: WorkItem[]
  planner: PlannerActivity[]
  workEvents: WorkActivityEvent[]
  accounts: UserAccount[]
  taskSettings: TaskSettings
  currentUser: UserAccount
  canUseTrackers: boolean
  /** Whether the person has Work Hub, so their messages can be a table. */
  canUseInbox: boolean
  /** Administrators and people given Data explorer query the whole account; others their own work. */
  wholeAccount: boolean
}

export function useExplorerData(props: ExplorerProps) {
  const today = useBusinessDate()
  const [trackers, setTrackers] = useState<Tracker[] | null>(null)
  const [trackerRows, setTrackerRows] = useState<Record<string, { tracker: Tracker; rows: TrackerRow[] } | undefined>>(
    {},
  )
  const [messages, setMessages] = useState<ExplorerMessage[] | null | undefined>(props.canUseInbox ? undefined : null)
  const pending = useRef(new Map<string, Promise<unknown>>())
  const state = useRef({ trackers, trackerRows, messages })
  state.current = { trackers, trackerRows, messages }

  const once = <T>(key: string, load: () => Promise<T>): Promise<T> => {
    const existing = pending.current.get(key)
    if (existing) return existing as Promise<T>
    const job = load().finally(() => pending.current.delete(key))
    pending.current.set(key, job)
    return job
  }
  const loadTrackers = useCallback(async (): Promise<Tracker[]> => {
    if (!props.canUseTrackers) return []
    if (state.current.trackers) return state.current.trackers
    return once('trackers', async () => {
      const list = (await trackerApi.list()).trackers.filter(tracker => !tracker.archived)
      state.current.trackers = list
      setTrackers(list)
      return list
    }).catch(() => {
      setTrackers([])
      return []
    })
  }, [props.canUseTrackers])
  const loadTracker = (id: string) =>
    once(`tracker:${id}`, async () => {
      const [result, rows] = await Promise.all([trackerApi.get(id), loadAllRows(id)])
      const next = { ...state.current.trackerRows, [id]: { tracker: result.tracker, rows } }
      state.current.trackerRows = next
      setTrackerRows(next)
    })
  const loadMessages = () =>
    once('messages', async () => {
      const result = await requestJson<{ items: (ExplorerMessage & { body?: string })[] }>('/api/communications', {
        noStore: true,
        fallback: 'Work Hub messages could not be loaded.',
      })
      // Only what the table shows is kept: never the message itself.
      const list = (result.items || []).map(({ body: _body, ...message }) => message)
      state.current.messages = list
      setMessages(list)
    })

  const input = (current = state.current) => ({
    clients: props.clients,
    projects: props.projects,
    items: props.items,
    planner: props.planner,
    workEvents: props.workEvents,
    accounts: props.accounts,
    taskSettings: props.taskSettings,
    today,
    currentUser: props.currentUser,
    dateOf: (iso: string) => businessDateKey(iso),
    trackers: current.trackers || [],
    trackerRows: current.trackerRows,
    messages: current.messages,
    wholeAccount: props.wholeAccount,
  })
  const catalog: TableInfo[] = useMemo(
    () => explorerCatalog({ trackers: trackers || [], clients: props.clients, messages }),
    [trackers, props.clients, messages],
  )

  // Build the account tables once per data change and share them across queries.
  const built = useRef<{ from: unknown[]; tables: Record<string, SqlTable> } | null>(null)
  const tables = () => {
    const current = input()
    const from = [
      current.clients,
      current.projects,
      current.items,
      current.planner,
      current.workEvents,
      current.accounts,
      current.taskSettings,
      current.today,
      current.currentUser,
      current.trackers,
      current.trackerRows,
      current.messages,
      current.wholeAccount,
    ]
    if (built.current && built.current.from.every((value, index) => value === from[index])) return built.current.tables
    const made = explorerTables(current)
    built.current = { from, tables: made }
    return made
  }

  /** Loads what a query reads, then runs it. */
  const run = async (sql: string, params: Record<string, string>): Promise<SqlResult> => {
    // Table identifier parameters are resolved only against this user's visible table catalog.
    if (/(?:from|join)\s+\{\{/i.test(sql)) await loadTrackers()
    const known = explorerCatalog({
      trackers: state.current.trackers || [],
      clients: props.clients,
      messages: state.current.messages,
    })
    const executableSql = resolveTableIdentifierParams(
      sql,
      params,
      known.map(table => table.name),
    )
    const wanted = referencedTables(executableSql)
    for (const name of wanted) {
      const info = known.find(table => table.name === name)
      if (!info?.load) continue
      if (info.load.kind === 'tracker' && !state.current.trackerRows[info.load.trackerId]) {
        try {
          await loadTracker(info.load.trackerId)
        } catch {
          throw new SqlError(`The tracker behind ${name} could not be loaded. Try again.`)
        }
      }
      if (info.load.kind === 'messages' && state.current.messages === undefined) {
        try {
          await loadMessages()
        } catch {
          throw new SqlError('Your Work Hub messages could not be loaded. Try again.')
        }
      }
    }
    return runQuery(executableSql, tables(), { params, today })
  }

  return { catalog, run, loadTrackers, today, trackersLoaded: trackers !== null }
}
