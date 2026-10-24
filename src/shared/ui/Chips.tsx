import { type Client, type ItemType, type Priority, type TaskSettings, type WaitingOn, type WorkItem } from '../types'
import { waitingOnTone } from '../../features/tasks/waitingOn'
import { CheckCircle2 } from 'lucide-react'

export function Empty({ text }: { text: string }) { return <div className="empty"><CheckCircle2 size={28} /><p>{text}</p></div> }

export function TypeChip({ value }: { value: ItemType }) { return <span className={`chip type-${value.toLowerCase().replace(' ', '-')}`}>{value}</span> }

export function PriorityChip({ value }: { value: Priority }) { return <span className={`chip priority-${value.toLowerCase()}`}>{value}</span> }

export function InquirySourceBadge({ source, isNew = false }: { source: WorkItem['source']; isNew?: boolean }) { return <span className={`inquiry-source source-${source.toLowerCase().replace(/\s+/g, '-')} ${isNew ? 'is-new' : ''}`}>{source}{isNew ? ' · New' : ''}</span> }

export function WaitingChip({ value, settings }: { value: WaitingOn; settings: TaskSettings }) { return <span className={`chip waiting-${waitingOnTone(value, settings)}`}>{value}</span> }

export function StatusChip({ value }: { value: string }) { return <span className="chip neutral">{value}</span> }

export function HealthChip({ value }: { value: Client['health'] }) { return <span className={`chip health-${value.toLowerCase().replace(' ', '-')}`}>{value}</span> }
