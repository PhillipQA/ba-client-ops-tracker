/**
 * Where task evidence files are: the account's Google Drive (driveFileId) or, for files saved before Drive was
 * connected, the app's database (storagePath). Pure functions for moving them to Drive (see task-routes).
 */

/** Evidence entries whose file is still in the database, with their task. */
export function evidenceInDatabase(state: any) {
  return (Array.isArray(state?.items) ? state.items : []).flatMap((task: any) =>
    (Array.isArray(task?.evidence) ? task.evidence : [])
      .filter((entry: any) => entry?.storagePath && !entry.driveFileId)
      .map((entry: any) => ({ task, entry })),
  ) as { task: any; entry: any }[]
}

/** How many evidence files are in Drive. */
export function evidenceInDrive(state: any) {
  return (Array.isArray(state?.items) ? state.items : []).reduce(
    (total: number, task: any) =>
      total + (Array.isArray(task?.evidence) ? task.evidence.filter((entry: any) => entry?.driveFileId).length : 0),
    0,
  )
}

/** The workspace with the moved evidence entries pointing to Drive (their database path cleared). */
export function moveEvidenceToDrive(state: any, moved: { taskId: string; id: string; fileId: string; url: string }[]) {
  const byTask = new Map<string, Map<string, { fileId: string; url: string }>>()
  for (const file of moved) {
    const entries = byTask.get(file.taskId) || new Map()
    entries.set(file.id, { fileId: file.fileId, url: file.url })
    byTask.set(file.taskId, entries)
  }
  return {
    ...state,
    items: (Array.isArray(state?.items) ? state.items : []).map((task: any) => {
      const entries = byTask.get(String(task?.id))
      if (!entries || !Array.isArray(task.evidence)) return task
      return {
        ...task,
        evidence: task.evidence.map((entry: any) => {
          const drive = entries.get(String(entry?.id))
          return drive ? { ...entry, storagePath: '', driveFileId: drive.fileId, driveUrl: drive.url } : entry
        }),
      }
    }),
  }
}
