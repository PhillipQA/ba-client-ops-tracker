import type { Client, Project, TaskDriveFile, WorkItem } from './types'

/** Pure helpers behind the Google Drive pickers in Document Creation. */
export type DriveScope = { items: WorkItem[]; clients: Client[]; projects: Project[] }

export const fileSize = (bytes: number) => bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`
export const extensionOf = (name: string) => name.includes('.') ? name.slice(name.lastIndexOf('.')).toLowerCase() : ''

export const archivedContext = ({ clients, projects }: DriveScope, item: WorkItem) =>
  Boolean(clients.find(c => c.id === item.clientId)?.archived || projects.find(p => p.id === item.projectId)?.archived)
export const placeOf = ({ clients, projects }: DriveScope, item: WorkItem) =>
  [clients.find(c => c.id === item.clientId)?.name, projects.find(p => p.id === item.projectId)?.name].filter(Boolean).join(' / ')

/** Tasks and subtasks that can receive a file, parents first so subtasks sit under them. Work under an archived client or project is left out. */
export function taskOptions(scope: DriveScope, clientId: string) {
  const open = scope.items.filter(item => !archivedContext(scope, item) && (!clientId || item.clientId === clientId))
  const rows: { id: string; label: string }[] = []
  for (const parent of open.filter(item => !item.parentTaskId)) {
    rows.push({ id: parent.id, label: `${parent.title}${placeOf(scope, parent) ? ` — ${placeOf(scope, parent)}` : ''}` })
    open.filter(child => child.parentTaskId === parent.id).forEach(child => rows.push({ id: child.id, label: `   ↳ ${child.title}` }))
  }
  const known = new Set(rows.map(row => row.id))
  open.filter(item => item.parentTaskId && !known.has(item.id)).forEach(item => rows.push({ id: item.id, label: `↳ ${item.title}${placeOf(scope, item) ? ` — ${placeOf(scope, item)}` : ''}` }))
  return rows
}

/** Tasks that have saved Drive files of an accepted type, with only the matching files. */
export function driveFileGroups(scope: DriveScope, options: { allowed: Set<string>; clientId: string; query: string }) {
  const needle = options.query.trim().toLowerCase()
  return scope.items
    .filter(item => !archivedContext(scope, item) && (!options.clientId || item.clientId === options.clientId))
    .map(item => ({ item, files: (item.driveFiles || []).filter((file: TaskDriveFile) => options.allowed.has(extensionOf(file.name)) && (!needle || file.name.toLowerCase().includes(needle) || item.title.toLowerCase().includes(needle))) }))
    .filter(group => group.files.length)
}
