/**
 * Routes that turn a message into work: link it to a task or subtask, or create one from it.
 */
import { randomUUID } from 'node:crypto'
import type { Express } from 'express'
import { IntegrationError } from './tenant-integrations'
import {
  subtaskParentProblem,
  findSubtaskDuplicate,
  findCommunicationTaskDuplicate,
  nextSubtaskOrder,
} from '../../src/features/work-hub/communicationTasks'
import { isWorkDone } from '../../src/features/tasks/lifecycle'
import { visibleTask, canCreateWork } from '../services/visibility'
import { defaultWaitingOn } from '../../src/features/tasks/waitingOn'
import { type CommunicationsDeps, requireText } from './communications-common'
import type { CommunicationsCore } from './communications-core'

export function messageTaskRoutes(app: Express, deps: CommunicationsDeps, comms: CommunicationsCore) {
  const { db, auth, guard, wrap, current, createTaskInOrder, own } = comms
  /** Trackers the person can open that have this work on a row (the row's task, or a task made from a cell). */
  const trackersFor = async (user: any, taskIds: string[]) => {
    try {
      const [rows, links] = await Promise.all([
        db.from('tenant_tracker_rows').select('tracker_id').eq('tenant_id', user.organizationId).in('task_id', taskIds),
        db
          .from('tenant_tracker_task_links')
          .select('tracker_id')
          .eq('tenant_id', user.organizationId)
          .in('task_id', taskIds),
      ])
      const ids = [...new Set([...(rows.data || []), ...(links.data || [])].map((row: any) => String(row.tracker_id)))]
      if (!ids.length) return []
      const trackers = await db
        .from('tenant_trackers')
        .select('id,name,private,created_by,archived_at')
        .eq('tenant_id', user.organizationId)
        .in('id', ids)
      return (trackers.data || [])
        .filter((row: any) => !row.archived_at && (!row.private || row.created_by === user.id))
        .map((row: any) => ({ id: String(row.id), name: String(row.name || 'Tracker') }))
    } catch {
      // Trackers are only a heads-up: linking still works without them.
      return []
    }
  }
  /**
   * Links one of your emails to an existing task or subtask (or removes the link). Only your own copy of the email
   * changes: the task gets nothing from the email, as with Create task. The answer names the trackers the work is on.
   */
  app.post(
    '/api/communications/:id/link-task',
    ...auth,
    guard,
    wrap(async (req, res) => {
      const user = current(req)
      if (!user.modules?.includes('items') && !user.modules?.includes('inbox') && user.role !== 'Administrator')
        throw new IntegrationError('Task access is required.', 403)
      const taskId = requireText(req.body?.taskId, 'Task', 100)
      const unlink = req.body?.unlink === true
      // In order with Create task and other links on this account, so two at once cannot lose one of them.
      await createTaskInOrder(user.organizationId, async () => {
        const communication = await own(req, req.params.id)
        const stateResult = await deps.load(user.organizationId)
        const items: any[] = Array.isArray(stateResult?.data?.items) ? stateResult.data.items : []
        // Old Discord captures are kept away from every browser (see sanitizeStateForClient): not linkable either.
        const task = items.find(
          item =>
            String(item?.id) === taskId &&
            !(item?.source === 'Discord' && item?.externalSourceId) &&
            visibleTask(stateResult.data, user, taskId, 'write'),
        )
        if (!unlink && (!task || task.archived)) throw new IntegrationError('That task or subtask was not found.', 404)
        const existing = [
          ...new Set([
            ...(Array.isArray(communication.linked_task_ids) ? communication.linked_task_ids : []),
            ...(communication.linked_task_id ? [communication.linked_task_id] : []),
          ]),
        ].map(String)
        const ids = unlink ? existing.filter(id => id !== taskId) : [...existing.filter(id => id !== taskId), taskId]
        // The badge keeps the latest link; the full list is what Drive filing, DRF and replies read.
        const latest = ids.at(-1) || null
        const { error } = await db
          .from('user_communications')
          .update({ linked_task_id: latest, linked_task_ids: ids.slice(-200) })
          .eq('id', communication.id)
          .eq('tenant_id', user.organizationId)
          .eq('owner_user_id', user.id)
        if (error) throw error
        const parent = task?.parentTaskId ? String(task.parentTaskId) : ''
        res.json({
          linkedTaskId: latest,
          linkedTaskIds: ids,
          trackers: unlink ? [] : await trackersFor(user, parent ? [taskId, parent] : [taskId]),
        })
      })
    }),
  )
  app.post(
    '/api/communications/:id/create-task',
    ...auth,
    guard,
    wrap(async (req, res) => {
      const user = current(req)
      if (user.role === 'Viewer' || (!user.modules?.includes('items') && user.role !== 'Administrator'))
        throw new IntegrationError('Task write access is required.', 403)
      await createTaskInOrder(user.organizationId, async () => {
        const communication = await own(req, req.params.id)
        const stateResult = await deps.load(user.organizationId),
          state = stateResult.data
        if (!state) throw new IntegrationError('Workspace data is unavailable.', 503)
        // A subtask goes under an existing open task and takes that task's client and project.
        const parentTaskId = req.body?.parentTaskId ? requireText(req.body.parentTaskId, 'Parent task', 100) : ''
        const parent = parentTaskId ? (state.items || []).find((x: any) => x.id === parentTaskId) : undefined
        if (parentTaskId) {
          const problem = subtaskParentProblem(parent, status =>
            isWorkDone({ status } as any, state.taskSettings || { statuses: [] }),
          )
          if (problem) throw new IntegrationError(problem)
        }
        const clientId = parent ? String(parent.clientId || '') : requireText(req.body?.clientId, 'Client', 100),
          projectId = parent ? String(parent.projectId || '') : requireText(req.body?.projectId, 'Project', 100)
        if (
          !clientId ||
          !projectId ||
          !state.clients?.some((x: any) => x.id === clientId && !x.archived) ||
          !state.projects?.some((x: any) => x.id === projectId && !x.archived)
        )
          throw new IntegrationError(
            parent
              ? `“${parent.title}” has no active client and project, so a subtask cannot be added to it here.`
              : 'Select an active client and project.',
          )
        if (!canCreateWork(state, user, { clientId, projectId, parentTaskId }))
          throw new IntegrationError('You don’t have access to that client or project.', 403)
        const assignee = requireText(req.body?.assignedToUserId, 'Assignee', 100)
        const account = (state.accounts || []).find(
          (x: any) => x.id === assignee && x.status !== 'Disabled' && ['Administrator', 'Contributor'].includes(x.role),
        )
        if (!account) throw new IntegrationError('Select an active team member.')
        const title = requireText(req.body?.title, 'Task title', 200),
          description = requireText(req.body?.description, 'Task description', 5000)
        if (!title) throw new IntegrationError(parent ? 'Enter a subtask title.' : 'Enter a task title.')
        const duplicate = parent
          ? findSubtaskDuplicate(state.items || [], parent.id, title)
          : findCommunicationTaskDuplicate(state.items || [], { title, clientId, projectId })
        if (duplicate) {
          res.status(409).json({
            code: 'DUPLICATE_TASK',
            error: parent
              ? `“${parent.title}” already has a subtask named “${duplicate.title}”. Enter a different title.`
              : `A task named “${duplicate.title}” already exists for this client and project. Enter a different task title.`,
            taskId: duplicate.id,
          })
          return
        }
        const item = {
          id: randomUUID(),
          clientId,
          projectId,
          ...(parent ? { parentTaskId: parent.id, subtaskOrder: nextSubtaskOrder(state.items || [], parent.id) } : {}),
          title,
          type: 'Task',
          priority: 'Medium',
          status: deps.openStatus(state),
          waitingOn: defaultWaitingOn(state?.taskSettings),
          owner: account.name || account.username,
          assignedToUserId: assignee,
          dateRaised: new Date().toISOString().slice(0, 10),
          dueDate: '',
          followUpDate: '',
          description,
          resolution: '',
          source: 'Internal',
        }
        // Shared task contains only the fields explicitly submitted here; never a private source ID or thread.
        await deps.commit(
          user.organizationId,
          { ...state, items: [item, ...(state.items || [])] },
          user,
          'communication-task',
          state,
        )
        // This private badge records the latest task; it must not restrict subsequent tasks.
        // A badge-write failure does not undo a task that was already committed.
        let warning: string | undefined
        try {
          const { error } = await db
            .from('user_communications')
            .update({ linked_task_id: item.id })
            .eq('id', communication.id)
            .eq('tenant_id', user.organizationId)
            .eq('owner_user_id', user.id)
          if (error) warning = 'Task created, but the message badge could not be updated.'
        } catch {
          warning = 'Task created, but the message badge could not be updated.'
        }
        // Private list of every task made from this message, used to pick a Drive folder.
        // Kept separate so a database without schema v23 still records the badge above.
        try {
          const ids = [
            ...new Set([
              ...(Array.isArray(communication.linked_task_ids) ? communication.linked_task_ids : []),
              ...(communication.linked_task_id ? [communication.linked_task_id] : []),
              item.id,
            ]),
          ].slice(-200)
          await db
            .from('user_communications')
            .update({ linked_task_ids: ids })
            .eq('id', communication.id)
            .eq('tenant_id', user.organizationId)
            .eq('owner_user_id', user.id)
        } catch {
          /* Older schema: the latest-task badge still works. */
        }
        res.status(201).json({ task: item, ...(warning ? { warning } : {}) })
      })
    }),
  )
}
