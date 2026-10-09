import { useSyncExternalStore } from 'react'
import { workHubSync } from './workHubSync'

export function useWorkHubSync() {
  return useSyncExternalStore(workHubSync.subscribe, workHubSync.getSnapshot, workHubSync.getSnapshot)
}
