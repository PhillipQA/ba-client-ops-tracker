import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, Bell, Check, CheckCheck, CircleAlert, Clock3, Trash2, Users, X } from 'lucide-react'
import type { AppNotification, Client, Project } from '../../shared/types'

function notificationTime(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? 'Recently' : date.toLocaleString()
}

function severityIcon(notification: AppNotification) {
  if (notification.severity === 'urgent') return <CircleAlert size={17} />
  if (notification.severity === 'warning') return <AlertTriangle size={17} />
  if (notification.severity === 'success') return <Check size={17} />
  return <Clock3 size={17} />
}

export default function NotificationCenter({
  notifications,
  clients,
  projects,
  isAdmin,
  busy,
  onOpen,
  onAction,
  onReadAll,
  onRefresh,
}: {
  notifications: AppNotification[]
  clients: Client[]
  projects: Project[]
  isAdmin: boolean
  busy: boolean
  onOpen: (notification: AppNotification) => void
  onAction: (notification: AppNotification, action: 'read' | 'unread' | 'dismiss') => void
  onReadAll: () => void
  onRefresh?: () => void
}) {
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState<'all' | 'unread' | 'team'>('all')
  const root = useRef<HTMLDivElement>(null)
  const active = notifications.filter(notification => !notification.dismissedAt)
  const unread = active.filter(notification => !notification.readAt).length
  const visible = active.filter(notification =>
    filter === 'unread' ? !notification.readAt : filter === 'team' ? notification.scope === 'team' : true,
  )
  useEffect(() => {
    if (!open) return
    const dismiss = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', dismiss)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('pointerdown', dismiss)
      document.removeEventListener('keydown', escape)
    }
  }, [open])
  return (
    <div className="notification-center" ref={root}>
      <button
        className={`notification-bell${open ? ' active' : ''}`}
        type="button"
        title="Notifications"
        aria-label={`${unread} unread notifications`}
        aria-expanded={open}
        onClick={() => {
          if (!open) onRefresh?.()
          setOpen(value => !value)
        }}
      >
        <Bell size={18} />
        {unread > 0 && <span>{unread > 99 ? '99+' : unread}</span>}
      </button>
      {open && (
        <div className="notification-popover" role="dialog" aria-label="Notifications">
          <div className="notification-head">
            <div>
              <strong>Notifications</strong>
              <span>{unread ? `${unread} unread` : 'You are caught up'}</span>
            </div>
            <button
              className="icon-button"
              type="button"
              aria-label="Close notifications"
              onClick={() => setOpen(false)}
            >
              <X size={17} />
            </button>
          </div>
          <div className="notification-toolbar">
            <div className="notification-tabs">
              <button className={filter === 'all' ? 'active' : ''} type="button" onClick={() => setFilter('all')}>
                All
              </button>
              <button className={filter === 'unread' ? 'active' : ''} type="button" onClick={() => setFilter('unread')}>
                Unread
              </button>
              {isAdmin && (
                <button className={filter === 'team' ? 'active' : ''} type="button" onClick={() => setFilter('team')}>
                  <Users size={13} /> Team
                </button>
              )}
            </div>
            <button className="notification-read-all" type="button" disabled={!unread || busy} onClick={onReadAll}>
              <CheckCheck size={14} /> Read all
            </button>
          </div>
          <div className="notification-list">
            {visible.map(notification => {
              const client = clients.find(entry => entry.id === notification.clientId)?.name
              const project = projects.find(entry => entry.id === notification.projectId)?.name
              const context = [client, project].filter(Boolean).join(' · ')
              return (
                <article
                  className={`notification-row severity-${notification.severity}${notification.readAt ? '' : ' unread'}`}
                  key={notification.id}
                >
                  <button
                    className="notification-main"
                    type="button"
                    onClick={() => {
                      onOpen(notification)
                      setOpen(false)
                    }}
                  >
                    <span className="notification-icon">{severityIcon(notification)}</span>
                    <span className="notification-copy">
                      <span className="notification-title-line">
                        <strong>{notification.title}</strong>
                        {notification.scope === 'team' && <em>Team</em>}
                      </span>
                      <span className="notification-message">{notification.message}</span>
                      {context && <span className="notification-context">{context}</span>}
                      <time>{notificationTime(notification.createdAt)}</time>
                    </span>
                  </button>
                  <div className="notification-actions">
                    <button
                      type="button"
                      disabled={busy}
                      title={notification.readAt ? 'Mark unread' : 'Mark read'}
                      onClick={() => onAction(notification, notification.readAt ? 'unread' : 'read')}
                    >
                      {notification.readAt ? <Clock3 size={14} /> : <Check size={14} />}
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      title="Dismiss"
                      onClick={() => onAction(notification, 'dismiss')}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </article>
              )
            })}
            {!visible.length && (
              <div className="notification-empty">
                <Bell size={24} />
                <strong>No notifications here</strong>
                <span>
                  {filter === 'unread'
                    ? 'Everything has been read.'
                    : filter === 'team'
                      ? 'No team escalations.'
                      : 'New assignments and alerts will appear here.'}
                </span>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
