import { requestJson } from '../../shared/http'
import type { Assignment, SeedsRole } from '../../shared/access'
import type { SeedsCounts, SeedsStatus } from '../../shared/seeds'

export type SeedsConnection = {
  configured: boolean
  baseUrl: string
  maskedKey: string
  connectionStatus: string
  lastTestedAt: string | null
  encryptionReady: boolean
  status: SeedsStatus
}
export type SyncResult = { ok: boolean; error?: string; counts?: SeedsCounts; pending?: number }

export type AccessSetup = {
  strictVisibility: boolean
  seedsConnected: boolean
  assignmentsFromSeeds: boolean
  assignments: Assignment[]
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

export const loadSeedsConnection = () => requestJson<SeedsConnection>('/api/account/seeds', { noStore: true, fallback })
export const saveSeedsConnection = (baseUrl: string, apiKey: string) =>
  requestJson<{ saved: boolean; sync: SyncResult }>('/api/account/seeds', {
    method: 'PUT',
    body: { baseUrl, ...(apiKey ? { apiKey } : {}) },
    fallback,
  })
export const removeSeedsConnection = () => requestJson('/api/account/seeds', { method: 'DELETE', fallback })
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
