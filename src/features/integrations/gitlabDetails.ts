/** How Work Hub shows the extra GitLab details: involvement, due date, priority, time and checklist progress. */
import type { GithubTicket } from './github-model'

/** "Created by me · Assigned to me · Commented". */
export function involvement(ticket: Pick<GithubTicket, 'created_by_me' | 'assigned_to_me' | 'commented_by_me'>) {
  return [
    ticket.created_by_me && 'Created by me',
    ticket.assigned_to_me && 'Assigned to me',
    ticket.commented_by_me && 'Commented',
  ]
    .filter(Boolean)
    .join(' · ')
}

/** Priority and severity from scoped labels ("priority::high", "severity::2") or P0–P4 labels. */
export function priorityLabels(labels: string[]) {
  let priority = '',
    severity = ''
  for (const label of labels) {
    const scoped = /^(priority|severity)\s*::\s*(.+)$/i.exec(label)
    if (scoped) {
      if (scoped[1].toLowerCase() === 'priority' && !priority) priority = scoped[2].trim()
      if (scoped[1].toLowerCase() === 'severity' && !severity) severity = scoped[2].trim()
    } else if (/^p[0-4]$/i.test(label.trim()) && !priority) priority = label.trim().toUpperCase()
  }
  return { priority, severity }
}

/** Seconds as GitLab shows time: "1h 30m", "45m". */
export function duration(seconds?: number) {
  if (!seconds || seconds < 60) return seconds ? '<1m' : ''
  const hours = Math.floor(seconds / 3600),
    minutes = Math.round((seconds % 3600) / 60)
  return [hours && `${hours}h`, minutes && `${minutes}m`].filter(Boolean).join(' ')
}

/** "Overdue by 3 days", "Due today", "Due in 2 days", "Due Nov 30"; tone for colouring. */
export function dueText(due: string | null | undefined, today: string, open = true) {
  if (!due) return null
  const days = Math.round((Date.parse(`${due}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000)
  const date = new Date(`${due}T00:00:00Z`).toLocaleDateString([], { month: 'short', day: 'numeric', timeZone: 'UTC' })
  if (!open) return { text: `Due ${date}`, tone: 'plain' as const }
  if (days < 0) return { text: `Overdue by ${-days} day${days === -1 ? '' : 's'}`, tone: 'late' as const }
  if (days === 0) return { text: 'Due today', tone: 'soon' as const }
  if (days <= 7) return { text: `Due in ${days} day${days === 1 ? '' : 's'}`, tone: 'soon' as const }
  return { text: `Due ${date}`, tone: 'plain' as const }
}
