import { requestJson } from '../../shared/http'
import type { Assignment, SeedsRole } from '../../shared/access'
import type { SeedsAccountSync, SeedsCounts, SeedsUserSync } from '../../shared/seeds'

/** Administrators: Seeds for the whole account. */
export type SeedsAccount = {
  connected: boolean
  /** The server has its Seeds application token (SEEDS_API_TOKEN). */
  tokenReady: boolean
  apiUrl: string
  sync: SeedsAccountSync
  people: (SeedsUserSync & { userId: string; name: string })[]
}
export type SyncResult = {
  ok: boolean
  error?: string
  counts?: SeedsCounts
  pending?: number
  matched?: number
  unmatched?: number
}

export type AccessSetup = {
  strictVisibility: boolean
  seedsConnected: boolean
  /** People whose own Seeds sync decides their access (their hand-entered assignments are set aside). */
  seedsUsers: string[]
  assignments: Assignment[]
  roles: { id: string; name: string }[]
  users: { id: string; name: string; role: string; status: string }[]
  clients: { id: string; name: string; archived?: boolean; seedsId?: string }[]
  projects: {
    id: string
    name: string
    clientId?: string
    archived?: boolean
    seedsId?: string
    contractNumber?: string
  }[]
}
export type AssignmentInput = { userId: string; role: SeedsRole; clientId?: string; projectId?: string }

const fallback = 'Seeds is unavailable right now. Try again in a moment.'

export const loadSeedsAccount = () => requestJson<SeedsAccount>('/api/account/seeds', { noStore: true, fallback })
export const turnOnSeeds = () =>
  requestJson<{ ok: boolean; sync: SyncResult }>('/api/account/seeds', { method: 'PUT', body: {}, fallback })
export const turnOffSeeds = () => requestJson('/api/account/seeds', { method: 'DELETE', fallback })
export const syncSeeds = () => requestJson<SyncResult>('/api/seeds/sync', { method: 'POST', body: {}, fallback })
export const decideMatch = (id: string, decision: 'confirm' | 'reject') =>
  requestJson<SyncResult>(`/api/seeds/matches/${encodeURIComponent(id)}`, {
    method: 'POST',
    body: { decision },
    fallback,
  })
export const loadAccessSetup = () => requestJson<AccessSetup>('/api/access', { noStore: true, fallback })
export const saveAccessSetup = (changes: { strictVisibility?: boolean; assignments?: AssignmentInput[] }) =>
  requestJson<{ ok: boolean }>('/api/access', { method: 'PUT', body: changes, fallback })
