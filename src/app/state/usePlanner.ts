/**
 * The planner (activities and follow-ups for today and this week) and the dashboard's AI assessment and
 * planned tasks.
 */
import { priorityRank } from '../navigation'
import { archivedWorkReason } from '../../features/tasks/lifecycle'
import type { FormEvent } from 'react'
import {
  type AIMessage,
  askBAAssistant,
  assistantMessages,
  type AISuggestion,
  type TaskPlan,
} from '../../features/ai/ai'
import { openWaitingOnOptions, defaultWaitingOn } from '../../features/tasks/waitingOn'
import type { PlannerActivity, ItemType, WorkItem } from '../../shared/types'
import { defaultOpenTaskStatus, isTaskClosed } from '../store'
import { weekStartKey, weekEndKey } from '../../shared/dates'
import type { UiState } from './useUiState'
import type { WorkspaceSave } from './useWorkspaceSave'
import type { SignIn } from './useSignIn'
import type { WorkViews } from './useWorkViews'

export function usePlanner(ui: UiState, saving: WorkspaceSave, signIn: SignIn, views: WorkViews) {
  const {
    today,
    store,
    editingActivityId,
    setEditingActivityId,
    setModal,
    dashboardAiPrompt,
    dashboardAiBusy,
    setDashboardAiBusy,
    setDashboardAiError,
    setDashboardAiResult,
    aiClientId,
    aiProjectId,
    setAiPrompt,
    setView,
    storeRef,
  } = ui
  const { persist } = saving
  const { canWrite, currentUser, canWriteTasks } = signIn
  const { actionCenterWorkItems, dashboardAiContext } = views
  const weekStart = weekStartKey(today)
  const weekEnd = weekEndKey(today)
  const sortedPlanner = [...store.planner].sort(
    (a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime),
  )
  const todayActivities = sortedPlanner.filter(item => item.date === today && item.status !== 'Cancelled')
  const weekActivities = sortedPlanner.filter(
    item => item.date >= weekStart && item.date <= weekEnd && item.status !== 'Cancelled',
  )
  const todayFollowUps = actionCenterWorkItems
    .filter(item => item.followUpDate === today)
    .sort((a, b) => priorityRank[b.priority] - priorityRank[a.priority] || a.title.localeCompare(b.title))
  const weekFollowUps = actionCenterWorkItems
    .filter(item => item.followUpDate && item.followUpDate >= weekStart && item.followUpDate <= weekEnd)
    .sort(
      (a, b) =>
        a.followUpDate.localeCompare(b.followUpDate) ||
        priorityRank[b.priority] - priorityRank[a.priority] ||
        a.title.localeCompare(b.title),
    )
  const editingActivity = editingActivityId ? (store.planner.find(item => item.id === editingActivityId) ?? null) : null

  const openActivityModal = (activity?: PlannerActivity) => {
    if (!canWrite) return
    setEditingActivityId(activity?.id ?? null)
    setModal('activity')
  }

  const saveActivity = (activity: PlannerActivity) => {
    if (!canWrite) return
    const exists = store.planner.some(item => item.id === activity.id)
    persist({
      ...store,
      planner: exists
        ? store.planner.map(item => (item.id === activity.id ? activity : item))
        : [activity, ...store.planner],
    })
    setModal(null)
    setEditingActivityId(null)
  }

  const toggleActivityDone = (id: string) => {
    if (!canWrite) return
    persist({
      ...store,
      planner: store.planner.map(item =>
        item.id === id ? { ...item, status: item.status === 'Done' ? 'Planned' : 'Done' } : item,
      ),
    })
  }

  const assessDashboardAI = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const text = dashboardAiPrompt.trim()
    if (!text || dashboardAiBusy) return

    setDashboardAiBusy(true)
    setDashboardAiError('')
    setDashboardAiResult(null)

    const threadKey = `${currentUser?.id || 'unknown'}:${aiClientId || 'global'}:${aiProjectId || 'all'}`
    let threads: Record<string, AIMessage[]> = {}
    try {
      threads = JSON.parse(localStorage.getItem('ba-client-ops-ai-threads-v1') || '{}') as Record<string, AIMessage[]>
    } catch {
      threads = {}
    }
    const history = Array.isArray(threads[threadKey]) ? threads[threadKey] : []

    try {
      const result = await askBAAssistant({ message: text, context: dashboardAiContext, history: history.slice(-8) })
      const now = new Date().toISOString()
      const userMessage: AIMessage = { id: crypto.randomUUID(), role: 'user', content: text, createdAt: now }
      const nextThreads = { ...threads, [threadKey]: [...history, userMessage, ...assistantMessages(result)] }
      localStorage.setItem('ba-client-ops-ai-threads-v1', JSON.stringify(nextThreads))
      const wordCount = result.message.trim().split(/\s+/).filter(Boolean).length
      setDashboardAiResult({ message: result.message, wordCount })
    } catch (error) {
      setDashboardAiError(error instanceof Error ? error.message : 'The AI assistant could not respond.')
    } finally {
      setDashboardAiBusy(false)
    }
  }

  const openDashboardAiResult = () => {
    setAiPrompt('')
    setView('ai')
  }

  const applyAISuggestion = (suggestion: AISuggestion, contextClientId: string, contextProjectId: string) => {
    if (!canWriteTasks) return 'Task or Inbox write access is required to apply a suggestion.'
    const clientId = contextClientId || undefined
    const projectId = contextProjectId || undefined
    const locked = archivedWorkReason(store, { clientId, projectId })
    if (locked) return locked

    if (suggestion.kind === 'activity') {
      const activity: PlannerActivity = {
        id: crypto.randomUUID(),
        title: suggestion.title,
        date: suggestion.activityDate || suggestion.followUpDate || today,
        startTime: suggestion.activityTime || '',
        endTime: '',
        allDay: !suggestion.activityTime,
        source: 'Local',
        status: 'Planned',
        clientId,
        projectId,
        notes: suggestion.description || suggestion.rationale,
      }
      persist({ ...store, planner: [activity, ...store.planner] })
      return `Added tracker activity: ${suggestion.title}`
    }

    const type: ItemType =
      suggestion.kind === 'issue' ? 'Issue' : suggestion.kind === 'requirement' ? 'Requirement' : 'Follow-up'
    const item: WorkItem = {
      id: crypto.randomUUID(),
      clientId,
      projectId,
      title: suggestion.title,
      type,
      priority: suggestion.priority || 'Medium',
      status: defaultOpenTaskStatus(store.taskSettings),
      waitingOn:
        suggestion.waitingOn &&
        openWaitingOnOptions(store.taskSettings).some(option => option.label === suggestion.waitingOn)
          ? suggestion.waitingOn
          : defaultWaitingOn(store.taskSettings),
      assignedToUserId: currentUser?.id,
      owner: currentUser?.name || '',
      dateRaised: today,
      startDate: '',
      dueDate: '',
      followUpDate: suggestion.followUpDate || '',
      description: suggestion.description || suggestion.rationale,
      resolution: '',
      source: 'Internal',
    }
    persist({
      ...store,
      items: [item, ...store.items],
      activity: [
        {
          id: crypto.randomUUID(),
          clientId,
          projectId,
          date: today,
          text: `AI suggestion approved: created ${type.toLowerCase()} task — ${suggestion.title}`,
        },
        ...store.activity,
      ],
    })
    return `Created ${type.toLowerCase()} task: ${suggestion.title}`
  }

  /**
   * Creates the ticked tasks of a plan the AI assistant drafted from notes, in one save: tasks first, then subtasks
   * under them (or under an open task of the project). Subtasks take their task's assignee, as everywhere else.
   */
  const createPlannedTasks = (plan: TaskPlan, refs: string[]): { ok: boolean; message: string } => {
    if (!canWriteTasks) return { ok: false, message: 'Task write access is required to create tasks.' }
    const current = storeRef.current
    const locked = archivedWorkReason(current, { clientId: plan.clientId, projectId: plan.projectId })
    if (locked) return { ok: false, message: locked }
    const chosen = new Set(refs)
    const ids = new Map<string, string>()
    const made: WorkItem[] = []
    const nextOrder = new Map<string, number>()
    const orderUnder = (parentId: string) => {
      const next =
        nextOrder.get(parentId) ??
        Math.max(
          -1,
          ...current.items.filter(item => item.parentTaskId === parentId).map(item => item.subtaskOrder ?? -1),
        ) + 1
      nextOrder.set(parentId, next + 1)
      return next
    }
    for (const subtasks of [false, true])
      for (const task of plan.tasks) {
        const isSubtask = Boolean(task.parentRef || task.parentTaskId)
        if (!chosen.has(task.ref) || isSubtask !== subtasks) continue
        const parentId = task.parentRef ? ids.get(task.parentRef) : task.parentTaskId
        const parent = parentId
          ? made.find(item => item.id === parentId) || current.items.find(item => item.id === parentId)
          : undefined
        if (isSubtask && (!parent || isTaskClosed(parent.status, current.taskSettings))) continue
        const id = crypto.randomUUID()
        ids.set(task.ref, id)
        const assignedToUserId = parent ? parent.assignedToUserId : task.assigneeId
        made.push({
          id,
          clientId: plan.clientId,
          projectId: plan.projectId,
          title: task.title,
          type: 'Task',
          priority: task.priority || 'Medium',
          status: defaultOpenTaskStatus(current.taskSettings),
          waitingOn: defaultWaitingOn(current.taskSettings),
          assignedToUserId,
          assignmentInherited: parent ? true : undefined,
          owner: assignedToUserId ? current.accounts.find(account => account.id === assignedToUserId)?.name || '' : '',
          parentTaskId: parent?.id,
          subtaskOrder: parent ? orderUnder(parent.id) : undefined,
          dateRaised: today,
          startDate: '',
          dueDate: task.dueDate || '',
          followUpDate: '',
          description: task.description || '',
          resolution: '',
          source: 'Internal',
        })
      }
    if (!made.length) return { ok: false, message: 'Nothing to create: tick at least one task.' }
    const subtaskCount = made.filter(item => item.parentTaskId).length
    const taskCount = made.length - subtaskCount
    const counts = [
      taskCount ? `${taskCount} task${taskCount === 1 ? '' : 's'}` : '',
      subtaskCount ? `${subtaskCount} subtask${subtaskCount === 1 ? '' : 's'}` : '',
    ]
      .filter(Boolean)
      .join(' and ')
    persist({
      ...current,
      items: [...made, ...current.items],
      activity: [
        {
          id: crypto.randomUUID(),
          clientId: plan.clientId,
          projectId: plan.projectId,
          date: today,
          text: `AI plan approved: created ${counts} in ${plan.projectName}`,
        },
        ...current.activity,
      ],
    })
    return { ok: true, message: `Created ${counts} in ${plan.clientName} / ${plan.projectName}.` }
  }

  return {
    applyAISuggestion,
    createPlannedTasks,
    assessDashboardAI,
    editingActivity,
    openActivityModal,
    openDashboardAiResult,
    saveActivity,
    todayActivities,
    todayFollowUps,
    toggleActivityDone,
    weekActivities,
    weekFollowUps,
  }
}

export type Planner = ReturnType<typeof usePlanner>
