export interface AssignmentItem {
  id: string
  parentTaskId?: string
  assignedToUserId?: string
  assignmentInherited?: boolean
}

const assignmentId = (item?: AssignmentItem) => String(item?.assignedToUserId || '')

const followsParent = (item: AssignmentItem, parent?: AssignmentItem) =>
  typeof item.assignmentInherited === 'boolean'
    ? item.assignmentInherited
    : assignmentId(item) === assignmentId(parent)

/**
 * Adds an explicit inheritance marker to legacy subtasks. Legacy subtasks that
 * already differ from their parent are treated as manual overrides.
 */
export function normalizeSubtaskAssignmentInheritance<T extends AssignmentItem>(items: readonly T[]): T[] {
  const byId = new Map(items.map((item) => [String(item.id), item]))
  return items.map((item) => {
    if (!item.parentTaskId) return { ...item, assignmentInherited: undefined }
    const parent = byId.get(String(item.parentTaskId))
    if (!parent) return { ...item, assignmentInherited: false }
    return { ...item, assignmentInherited: followsParent(item, parent) }
  })
}

/**
 * Applies assignment inheritance to an incoming workspace snapshot.
 *
 * - New subtasks always inherit their parent's current assignee.
 * - Inherited subtasks follow later parent assignment changes.
 * - A manually assigned subtask keeps its explicit override.
 */
export function applySubtaskAssignmentInheritance<T extends AssignmentItem>(
  currentItems: readonly T[],
  incomingItems: readonly T[],
): T[] {
  const currentById = new Map(currentItems.map((item) => [String(item.id), item]))
  const incomingById = new Map(incomingItems.map((item) => [String(item.id), item]))

  return incomingItems.map((item) => {
    if (!item.parentTaskId) return { ...item, assignmentInherited: undefined }

    const nextParent = incomingById.get(String(item.parentTaskId))
    if (!nextParent) return { ...item, assignmentInherited: false }

    const currentItem = currentById.get(String(item.id))
    if (!currentItem) {
      return {
        ...item,
        assignedToUserId: nextParent.assignedToUserId || undefined,
        assignmentInherited: true,
      }
    }

    if (item.assignmentInherited === true) {
      return {
        ...item,
        assignedToUserId: nextParent.assignedToUserId || undefined,
        assignmentInherited: true,
      }
    }

    if (item.assignmentInherited === false) return { ...item, assignmentInherited: false }

    const currentParent = currentById.get(String(currentItem.parentTaskId || item.parentTaskId))
    const wasInherited = followsParent(currentItem, currentParent)
    if (!wasInherited) return { ...item, assignmentInherited: false }

    const parentChanged = assignmentId(currentParent) !== assignmentId(nextParent)
    const childChanged = assignmentId(currentItem) !== assignmentId(item)
    if (childChanged && !(parentChanged && assignmentId(item) === assignmentId(nextParent))) {
      return { ...item, assignmentInherited: false }
    }

    return {
      ...item,
      assignedToUserId: nextParent.assignedToUserId || undefined,
      assignmentInherited: true,
    }
  })
}
