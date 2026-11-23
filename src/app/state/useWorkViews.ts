/**
 * What the screens list: clients and tasks after search and filters, the Action Center's scope and counts,
 * inquiries, and the selected client or project.
 */
import { type ClientLayout, priorityRank, labels } from '../navigation'
import { isArchived, isTaskArchived } from '../../features/tasks/lifecycle'
import {
  trackedActionCenterUsers,
  resolveActionCenterScope,
  itemMatchesActionCenterScope,
} from '../../features/action-center/actionCenterScope'
import { useMemo, useEffect } from 'react'
import { isWaitingOnDone, waitingOnOptions, defaultWaitingOn } from '../../features/tasks/waitingOn'
import { seedAccounts } from '../data'
import type { TaskLayout, BoardGroup } from '../../features/tasks/taskBoardModel'
import type { CalendarDate } from '../../features/tasks/taskViews'
import type { WorkItem } from '../../shared/types'
import { isTaskClosed } from '../store'
import { addDays } from '../../shared/dates'
import type { UiState } from './useUiState'
import type { SignIn } from './useSignIn'
import { customSearchText } from '../../features/tasks/customFields'

export function useWorkViews(ui: UiState, signIn: SignIn) {
  const {
    store,
    taskLayout,
    boardGroup,
    boardShowSubtasks,
    taskCalendarDate,
    setTaskLayout,
    setBoardGroup,
    setBoardShowSubtasks,
    setTaskCalendarDate,
    authUser,
    setClientLayout,
    clientSearch,
    clientArchiveFilter,
    clientSort,
    query,
    waitingFilter,
    today,
    actionCenterScope,
    setActionCenterScope,
    aiClientId,
    aiProjectId,
    newExternalInquiryIds,
    taskArchiveView,
    taskClientFilter,
    taskProjectFilter,
    taskStatusFilter,
    taskDateFilter,
    selectedClientId,
    selectedProjectId,
    view,
    editingTaskId,
  } = ui
  const { currentUser, canWriteTasks } = signIn
  const clientName = (id?: string) =>
    id ? (store.clients.find(c => c.id === id)?.name ?? 'Unknown client') : 'General / no client'
  const projectName = (id?: string) =>
    id ? (store.projects.find(p => p.id === id)?.name ?? 'Unknown project') : 'No project'

  const openItems = useMemo(
    () =>
      store.items.filter(
        item =>
          (currentUser?.role !== 'Contributor' || item.assignedToUserId === currentUser.id) &&
          !isTaskClosed(item.status, store.taskSettings) &&
          !isWaitingOnDone(item.waitingOn, store.taskSettings),
      ),
    [store.items, store.taskSettings, currentUser],
  )

  const chooseTaskView = (next: {
    layout?: TaskLayout
    group?: BoardGroup
    subtasks?: boolean
    calendarDate?: CalendarDate
  }) => {
    const view = {
      layout: next.layout ?? taskLayout,
      group: next.group ?? boardGroup,
      subtasks: next.subtasks ?? boardShowSubtasks,
      calendarDate: next.calendarDate ?? taskCalendarDate,
    }
    setTaskLayout(view.layout)
    setBoardGroup(view.group)
    setBoardShowSubtasks(view.subtasks)
    setTaskCalendarDate(view.calendarDate)
    if (!authUser) return
    try {
      localStorage.setItem(`ba-task-view:${authUser.organizationId}:${authUser.id}`, JSON.stringify(view))
    } catch {
      /* Keep the view usable when storage is unavailable. */
    }
  }

  const chooseClientLayout = (layout: ClientLayout) => {
    setClientLayout(layout)
    if (!authUser) return
    try {
      localStorage.setItem(`ba-client-layout:${authUser.organizationId}:${authUser.id}`, layout)
    } catch {
      /* Keep the view usable when storage is unavailable. */
    }
  }

  const visibleClients = useMemo(() => {
    const search = clientSearch.trim().toLocaleLowerCase()
    return store.clients
      .filter(client => clientArchiveFilter === 'all' || isArchived(client) === (clientArchiveFilter === 'archived'))
      .filter(
        client =>
          !search ||
          [client.name, client.contact, client.email, client.notes || ''].some(part =>
            part.toLocaleLowerCase().includes(search),
          ),
      )
      .map(client => {
        const projects = new Set(
          store.items.filter(item => item.clientId === client.id && item.projectId).map(item => item.projectId),
        )
        const tasks = openItems.filter(item => item.clientId === client.id)
        const next = tasks
          .filter(item => item.followUpDate)
          .sort((a, b) => a.followUpDate.localeCompare(b.followUpDate))[0]
        return { client, projectCount: projects.size, openTaskCount: tasks.length, next }
      })
      .sort((a, b) => {
        if (clientSort === 'name-desc') return b.client.name.localeCompare(a.client.name)
        if (clientSort === 'open-tasks')
          return b.openTaskCount - a.openTaskCount || a.client.name.localeCompare(b.client.name)
        if (clientSort === 'follow-up')
          return (
            (a.next?.followUpDate || '9999-12-31').localeCompare(b.next?.followUpDate || '9999-12-31') ||
            a.client.name.localeCompare(b.client.name)
          )
        return a.client.name.localeCompare(b.client.name)
      })
  }, [store.clients, store.items, openItems, clientArchiveFilter, clientSearch, clientSort])

  const openInquiryCount = openItems.filter(item => item.type === 'Inquiry').length

  const searchedItems = useMemo(() => {
    const q = query.trim().toLowerCase()
    return store.items
      .filter(item => {
        const text = [
          item.title,
          item.description,
          clientName(item.clientId),
          projectName(item.projectId),
          item.type,
          item.status,
          // The account's custom fields are searched too.
          customSearchText(store.taskSettings.customFields || [], item),
        ]
          .join(' ')
          .toLowerCase()
        return !q || text.includes(q)
      })
      .filter(item => waitingFilter === 'All' || item.waitingOn === waitingFilter)
      .sort((a, b) => {
        const aOverdue = a.followUpDate && a.followUpDate < today ? 1 : 0
        const bOverdue = b.followUpDate && b.followUpDate < today ? 1 : 0
        return (
          bOverdue - aOverdue ||
          priorityRank[b.priority] - priorityRank[a.priority] ||
          (a.followUpDate || '9999').localeCompare(b.followUpDate || '9999')
        )
      })
  }, [store.items, store.taskSettings, query, waitingFilter, store.clients, store.projects, today])

  const actionCenterUsers = trackedActionCenterUsers(store.accounts)
  const resolvedActionCenterScope = resolveActionCenterScope(
    actionCenterScope,
    currentUser?.id || '',
    currentUser?.role || 'Viewer',
    store.accounts,
  )
  const actionCenterScopeLabel =
    resolvedActionCenterScope.kind === 'all'
      ? 'All Users’ Action Center'
      : resolvedActionCenterScope.kind === 'user'
        ? `${actionCenterUsers.find(account => account.id === resolvedActionCenterScope.userId)?.name || 'User'}’s Action Center`
        : 'My Action Center'
  const matchesActionCenterScope = (item: WorkItem) => itemMatchesActionCenterScope(item, resolvedActionCenterScope)
  const actionCenterWorkItems = store.items.filter(
    item =>
      matchesActionCenterScope(item) &&
      !isTaskClosed(item.status, store.taskSettings) &&
      !isWaitingOnDone(item.waitingOn, store.taskSettings),
  )
  const actionItems = searchedItems.filter(
    item =>
      matchesActionCenterScope(item) &&
      !isTaskClosed(item.status, store.taskSettings) &&
      !isWaitingOnDone(item.waitingOn, store.taskSettings),
  )
  const canEditActionItem = (item: WorkItem) =>
    canWriteTasks && (currentUser?.role === 'Administrator' || item.assignedToUserId === currentUser?.id)
  // The metric follows the built-in Developer option (by id, so a rename keeps it).
  // If an account removed it, count everything waiting on someone other than the default assignee.
  const developerWaitingOn = waitingOnOptions(store.taskSettings).find(
    option => option.id === 'developer' && !option.done,
  )
  const actionCenterWaitingTitle = developerWaitingOn ? `Waiting on ${developerWaitingOn.label}` : 'Waiting on others'
  const actionCenterWaitingDev = actionCenterWorkItems.filter(item =>
    developerWaitingOn
      ? item.waitingOn === developerWaitingOn.label
      : item.waitingOn !== defaultWaitingOn(store.taskSettings),
  )
  const actionCenterClientCount = new Set(actionCenterWorkItems.map(item => item.clientId).filter(Boolean)).size
  const actionCenterWaitingDevOverdue = actionCenterWaitingDev.filter(
    item => item.followUpDate && item.followUpDate < today,
  ).length
  const actionCenterInquiryCount = actionCenterWorkItems.filter(item => item.type === 'Inquiry').length
  useEffect(() => {
    if (
      actionCenterScope.startsWith('user:') &&
      !actionCenterUsers.some(account => account.id === actionCenterScope.slice('user:'.length))
    )
      setActionCenterScope('mine')
  }, [actionCenterScope, store.accounts, setActionCenterScope])
  const dashboardAiContext = useMemo(() => {
    const client = store.clients.find(value => value.id === aiClientId)
    const project = store.projects.find(value => value.id === aiProjectId)
    const scopedItems = store.items.filter(
      item => (!aiClientId || item.clientId === aiClientId) && (!aiProjectId || item.projectId === aiProjectId),
    )
    const closedStatuses = new Set(
      store.taskSettings.statuses.filter(status => status.closed).map(status => status.label),
    )
    const openItems = scopedItems
      .filter(item => !closedStatuses.has(item.status) && !isWaitingOnDone(item.waitingOn, store.taskSettings))
      .slice(0, 20)
    const upcomingActivities = store.planner
      .filter(
        activity =>
          (!aiClientId || activity.clientId === aiClientId) &&
          (!aiProjectId || activity.projectId === aiProjectId) &&
          activity.status === 'Planned',
      )
      .slice(0, 15)
    const contextUser = currentUser || seedAccounts[0]
    return {
      currentUser: { id: contextUser.id, name: contextUser.name, role: contextUser.role, modules: contextUser.modules },
      client,
      project,
      openItems,
      recentItems: scopedItems.slice(0, 20),
      upcomingActivities,
      myAssignments: scopedItems.filter(item => item.assignedToUserId === contextUser.id).slice(0, 40),
      myRecentActivity: store.workEvents
        .filter(
          event =>
            event.actorUserId === contextUser.id ||
            event.assignedToUserId === contextUser.id ||
            (event.field === 'assignedToUserId' && event.oldValue === contextUser.id),
        )
        .slice(0, 40),
    }
  }, [
    aiClientId,
    aiProjectId,
    store.clients,
    store.projects,
    store.items,
    store.planner,
    store.taskSettings,
    store.workEvents,
    currentUser,
  ])
  const inquiryItems = searchedItems.filter(
    item => item.type === 'Inquiry' && !isTaskClosed(item.status, store.taskSettings),
  )
  const archivedInquiryItems = useMemo(() => {
    const q = query.trim().toLowerCase()
    return store.items
      .filter(
        item =>
          item.source === 'Discord' &&
          (item.type !== 'Inquiry' ||
            isTaskClosed(item.status, store.taskSettings) ||
            isWaitingOnDone(item.waitingOn, store.taskSettings)),
      )
      .filter(item => {
        const text = [
          item.title,
          item.description,
          clientName(item.clientId),
          projectName(item.projectId),
          item.type,
          item.status,
          item.sourceSender || '',
        ]
          .join(' ')
          .toLowerCase()
        return !q || text.includes(q)
      })
      .sort((a, b) => (b.resolvedDate || b.dateRaised).localeCompare(a.resolvedDate || a.dateRaised))
  }, [store.items, store.taskSettings, store.clients, store.projects, query])
  const newExternalInquiryCount = newExternalInquiryIds.filter(id =>
    store.items.some(
      item =>
        item.id === id &&
        item.type === 'Inquiry' &&
        !isTaskClosed(item.status, store.taskSettings) &&
        !isWaitingOnDone(item.waitingOn, store.taskSettings),
    ),
  ).length

  const filteredTasks = useMemo(() => {
    const due3 = addDays(today, 3)
    const due7 = addDays(today, 7)
    return searchedItems.filter(item => {
      if (isTaskArchived(store.items, item) !== (taskArchiveView === 'archived')) return false
      if (taskClientFilter === '__none__' && item.clientId) return false
      if (taskClientFilter && taskClientFilter !== '__none__' && item.clientId !== taskClientFilter) return false
      if (taskProjectFilter === '__none__' && item.projectId) return false
      if (taskProjectFilter && taskProjectFilter !== '__none__' && item.projectId !== taskProjectFilter) return false
      if (taskStatusFilter && item.status !== taskStatusFilter) return false
      if (taskDateFilter === 'due-3') return Boolean(item.dueDate && item.dueDate >= today && item.dueDate <= due3)
      if (taskDateFilter === 'due-7') return Boolean(item.dueDate && item.dueDate >= today && item.dueDate <= due7)
      if (taskDateFilter === 'followup-3')
        return Boolean(item.followUpDate && item.followUpDate >= today && item.followUpDate <= due3)
      if (taskDateFilter === 'followup-7')
        return Boolean(item.followUpDate && item.followUpDate >= today && item.followUpDate <= due7)
      if (taskDateFilter === 'overdue')
        return (
          Boolean((item.dueDate && item.dueDate < today) || (item.followUpDate && item.followUpDate < today)) &&
          !isTaskClosed(item.status, store.taskSettings)
        )
      return true
    })
  }, [
    searchedItems,
    store.items,
    taskArchiveView,
    taskClientFilter,
    taskProjectFilter,
    taskStatusFilter,
    taskDateFilter,
    store.taskSettings,
    today,
  ])
  const archivedTaskCount = useMemo(
    () => store.items.filter(item => !item.parentTaskId && isArchived(item)).length,
    [store.items],
  )
  const selectedClient = store.clients.find(client => client.id === selectedClientId) ?? null
  const selectedProject = store.projects.find(project => project.id === selectedProjectId) ?? null
  // The tab title names the page, so the browser's history list (long-press Back) tells pages apart.
  useEffect(() => {
    const page = selectedProject?.name || selectedClient?.name || (currentUser ? labels[view] : '')
    document.title = page ? `${page} · BA Client Ops Tracker` : 'BA Client Ops Tracker'
  }, [view, selectedProject?.name, selectedClient?.name, Boolean(currentUser)])
  const editingTask = editingTaskId ? (store.items.find(item => item.id === editingTaskId) ?? null) : null

  return {
    actionCenterWorkItems,
    dashboardAiContext,
    actionCenterClientCount,
    actionCenterInquiryCount,
    actionCenterScopeLabel,
    actionCenterUsers,
    actionCenterWaitingDev,
    actionCenterWaitingDevOverdue,
    actionCenterWaitingTitle,
    actionItems,
    archivedInquiryItems,
    canEditActionItem,
    chooseClientLayout,
    chooseTaskView,
    clientName,
    editingTask,
    filteredTasks,
    inquiryItems,
    newExternalInquiryCount,
    openInquiryCount,
    openItems,
    projectName,
    archivedTaskCount,
    resolvedActionCenterScope,
    selectedClient,
    selectedProject,
    visibleClients,
  }
}

export type WorkViews = ReturnType<typeof useWorkViews>
