import type { Client, ItemType, Priority, TaskSettings, WaitingOn, WorkflowLabels, WorkItem } from '../types'
import { waitingOnTone } from '../../features/tasks/waitingOn'
import { HEALTHS, healthLabel, PRIORITIES, priorityLabel } from '../../features/tasks/workflow'
import { CheckCircle2 } from 'lucide-react'
import { createContext, useContext } from 'react'

/** The account's own names for priorities and client health (Settings › Workflow). */
export const WorkflowLabelsContext = createContext<WorkflowLabels | undefined>(undefined)

/** Priority choices for a select, shown with the account's names; the stored values stay the same. */
export function PriorityOptions() {
  const labels = useContext(WorkflowLabelsContext)
  return (
    <>
      {PRIORITIES.map(value => (
        <option key={value} value={value}>
          {priorityLabel(value, labels)}
        </option>
      ))}
    </>
  )
}

export function HealthOptions() {
  const labels = useContext(WorkflowLabelsContext)
  return (
    <>
      {HEALTHS.map(value => (
        <option key={value} value={value}>
          {healthLabel(value, labels)}
        </option>
      ))}
    </>
  )
}

export function Empty({ text }: { text: string }) {
  return (
    <div className="empty">
      <CheckCircle2 size={28} />
      <p>{text}</p>
    </div>
  )
}

export function TypeChip({ value }: { value: ItemType }) {
  return <span className={`chip type-${value.toLowerCase().replace(' ', '-')}`}>{value}</span>
}

export function PriorityChip({ value }: { value: Priority }) {
  const labels = useContext(WorkflowLabelsContext)
  return <span className={`chip priority-${value.toLowerCase()}`}>{priorityLabel(value, labels)}</span>
}

export function InquirySourceBadge({ source, isNew = false }: { source: WorkItem['source']; isNew?: boolean }) {
  // Older or hand-made records can lack a source: show Other rather than stopping the whole page.
  const label = String(source || 'Other')
  return (
    <span className={`inquiry-source source-${label.toLowerCase().replace(/\s+/g, '-')} ${isNew ? 'is-new' : ''}`}>
      {label}
      {isNew ? ' · New' : ''}
    </span>
  )
}

export function WaitingChip({ value, settings }: { value: WaitingOn; settings: TaskSettings }) {
  return <span className={`chip waiting-${waitingOnTone(value, settings)}`}>{value}</span>
}

export function StatusChip({ value }: { value: string }) {
  return <span className="chip neutral">{value}</span>
}

export function HealthChip({ value }: { value: Client['health'] }) {
  const labels = useContext(WorkflowLabelsContext)
  return <span className={`chip health-${value.toLowerCase().replace(' ', '-')}`}>{healthLabel(value, labels)}</span>
}
