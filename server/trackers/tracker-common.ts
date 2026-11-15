/**
 * Types, limits and small helpers shared by the tracker modules (see trackers.ts).
 */
import type { RequestHandler } from 'express'
import type { TrackerColumn, Cell } from '../../src/features/trackers/trackerModel'
import type { TaskDraft } from '../../src/features/trackers/TrackerWork'
import type { DonePatch } from '../../src/features/trackers/cellSubtasks'

/** What registerTrackerRoutes needs from the server. */
export type Deps = {
  db: any
  requireAuth: RequestHandler
  requireTenant: RequestHandler
  /** The tenant workspace, used to check that a linked task, client or project exists. */
  load: (tenantId: string) => Promise<{ data: any }>
  /** Saves the workspace: used to add a notification for people mentioned in a row comment. Optional. */
  commit?: (
    tenantId: string,
    next: any,
    actor: { id: string; name: string; role: string; organizationId: string },
    reason: string,
    current: any,
  ) => Promise<unknown>
  /** The business time zone (date reminders are sent after 8:00 AM there). */
  timeZone?: string
  /** false: no reminder timer (tests run the check by hand). */
  reminderTimer?: boolean
  /** Encryption key override for tests. */
  key?: Buffer
  now?: () => Date
  /** A Google access token for a person, used to read connected Sheets as the person who connected them. */
  googleAccess?: (tenantId: string, userId: string) => Promise<{ token: string; scope: string; email?: string }>
  /**
   * The account Google Drive: a tracker's new Sheet is made there under Client / Project, shared with the person who
   * makes it. Without a connected Drive the Sheet goes to that person's own Drive.
   */
  drive?: {
    ready: (tenantId: string) => Promise<boolean>
    sheet?: (job: {
      tenantId: string
      title: string
      clientId?: string
      projectId?: string
      editorEmail: string
    }) => Promise<{ spreadsheetId: string; path: string[] }>
  }
  /**
   * Completes or reopens tasks in the workspace as the given person, saying where the change came from. Used for boxes
   * ticked or unticked in a connected Google Sheet (see cellSubtasks). Returns how many tasks changed.
   */
  updateTasks?: (
    tenantId: string,
    patches: DonePatch[],
    actor: { id: string; name: string; role: string },
    from: string,
  ) => Promise<number>
  /**
   * Makes tasks and subtasks in the workspace as the given actor, in the order of the drafts (see trackerTaskDrafts).
   * Used for the rows of new Seeds projects (tracker-seeds-rows). Returns the tasks made.
   */
  createTasks?: (
    tenantId: string,
    drafts: TaskDraft[],
    actor: { id: string; name: string; role: string },
  ) => Promise<{ id: string }[]>
}

/** Blank rows a new Sheet gets below the tracker's rows. */
export const SPARE_SHEET_ROWS = 3

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export const PAGE = 1000

export const HISTORY = 50

export type User = { id: string; name: string; role: string; organizationId: string }

/** Secret columns whose reveal rule changed between two versions of a tracker's columns. */
export function secretRuleChanges(before: TrackerColumn[], after: TrackerColumn[]) {
  const changes: { name: string; from: string; to: string }[] = []
  for (const old of before) {
    if (old.type !== 'secret') continue
    const next = after.find(column => column.id === old.id)
    if (next && (next.revealBy || 'editors') !== (old.revealBy || 'editors'))
      changes.push({ name: next.name, from: old.revealBy || 'editors', to: next.revealBy || 'editors' })
  }
  return changes
}

export const emptyOf = (column: TrackerColumn): Cell =>
  column.type === 'number' ? null : column.type === 'checkbox' ? false : column.type === 'multiselect' ? [] : ''
