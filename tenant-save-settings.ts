// Task configuration belongs to Internal Admin. Workspace saves may carry a
// normalized display copy (for example an inserted Start Date column), but
// must never change the authoritative server settings.
export function preserveTaskSettings<T extends { taskSettings?: unknown }>(current: T, incoming: T): T {
  return { ...incoming, taskSettings: current.taskSettings }
}
