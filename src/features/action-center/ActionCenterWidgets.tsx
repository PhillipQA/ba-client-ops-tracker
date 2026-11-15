/**
 * Action Center widgets that read other pages: the latest Work Hub client emails, and DocHub documents still out for
 * signature. Each loads when shown and on Refresh; nothing polls, so a hidden widget costs nothing.
 */
import { ExternalLink, FileSignature, Mail, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { requestJson } from '../../shared/http'
import type { Client } from '../../shared/types'
import { type DocHubDocument, docHubLabels } from '../documents/dochub'
import { rememberWorkHubMessage } from '../work-hub/workHubNav'
import { awaitingSignature, type Email, emailsToShow } from './widgetLists'

type View = (view: any) => void

function useLoad<T>(load: () => Promise<T>) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const refresh = useCallback(() => {
    setBusy(true)
    setError('')
    load()
      .then(setData)
      .catch(failure => setError(failure instanceof Error ? failure.message : 'Could not load.'))
      .finally(() => setBusy(false))
  }, [load])
  useEffect(refresh, [refresh])
  return { data, error, busy, refresh }
}

const shortDate = (value?: string) => {
  const date = value ? new Date(value) : null
  if (!date || Number.isNaN(date.getTime())) return ''
  const today = new Date()
  return date.toDateString() === today.toDateString()
    ? date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : date.toLocaleDateString([], { month: 'short', day: 'numeric' })
}
/** "Ana Cruz <ana@client.com>" → "Ana Cruz". */
const senderName = (sender: string) =>
  sender
    .replace(/\s*<[^>]*>\s*$/, '')
    .replace(/^"|"$/g, '')
    .trim() || sender

export function WorkHubWidget({ clients, setView }: { clients: Client[]; setView: View }) {
  const load = useCallback(
    () =>
      requestJson<{ items: Email[] }>('/api/communications?tab=Gmail&page=1&pageSize=15', {
        noStore: true,
        fallback: 'Work Hub emails could not be loaded.',
      }).then(result => result.items || []),
    [],
  )
  const { data, error, busy, refresh } = useLoad(load)
  const shown = emailsToShow(data || [])
  const unread = (data || []).filter(item => item.read_at === null).length
  const clientName = (id?: string | null) => clients.find(client => client.id === id)?.name
  return (
    <div className="panel dashboard-panel ac-widget-list">
      <div className="panel-heading dashboard-panel-heading">
        <div>
          <h2>
            <Mail size={17} /> Work Hub emails
          </h2>
          <p>{data ? (unread ? `${unread} unread` : 'All read') : 'Your latest client emails'}</p>
        </div>
        <div className="dashboard-panel-actions">
          <button
            type="button"
            className="secondary icon-only"
            aria-label="Refresh emails"
            onClick={refresh}
            disabled={busy}
          >
            <RefreshCw size={15} />
          </button>
          <button type="button" className="secondary" onClick={() => setView('inbox')}>
            Open Work Hub
          </button>
        </div>
      </div>
      {error ? (
        <p className="ac-widget-note">{error}</p>
      ) : !data ? (
        <p className="ac-widget-note">Loading…</p>
      ) : !shown.length ? (
        <p className="ac-widget-note">No client emails yet. Connect Gmail in Work Hub to see them here.</p>
      ) : (
        <ul>
          {shown.map(email => (
            <li key={email.id}>
              <button
                type="button"
                className={email.read_at === null ? 'unread' : ''}
                onClick={() => {
                  rememberWorkHubMessage(email.id, email.source)
                  setView('inbox')
                }}
              >
                <span className="ac-row-main">
                  <strong>{senderName(email.sender)}</strong>
                  <span>{email.subject || '(no subject)'}</span>
                </span>
                <span className="ac-row-side">
                  {clientName(email.client_id) && <em>{clientName(email.client_id)}</em>}
                  <time>{shortDate(email.received_at)}</time>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export function DocHubWidget({ setView }: { setView: View }) {
  const load = useCallback(
    () =>
      requestJson<{ documents: DocHubDocument[] }>('/api/dochub/documents', {
        noStore: true,
        fallback: 'DocHub documents could not be loaded.',
      }).then(result => awaitingSignature(result.documents || [])),
    [],
  )
  const { data, error, busy, refresh } = useLoad(load)
  return (
    <div className="panel dashboard-panel ac-widget-list">
      <div className="panel-heading dashboard-panel-heading">
        <div>
          <h2>
            <FileSignature size={17} /> Awaiting signature
          </h2>
          <p>{data ? `${data.length} out for signing` : 'DocHub documents still out for signing'}</p>
        </div>
        <div className="dashboard-panel-actions">
          <button
            type="button"
            className="secondary icon-only"
            aria-label="Refresh documents"
            onClick={refresh}
            disabled={busy}
          >
            <RefreshCw size={15} />
          </button>
          <button type="button" className="secondary" onClick={() => setView('documents')}>
            Open Documents
          </button>
        </div>
      </div>
      {error ? (
        <p className="ac-widget-note">{error}</p>
      ) : !data ? (
        <p className="ac-widget-note">Loading…</p>
      ) : !data.length ? (
        <p className="ac-widget-note">Nothing is waiting for a signature.</p>
      ) : (
        <ul>
          {data.slice(0, 8).map(doc => {
            const signers = doc.signers.filter(signer => !signer.removed)
            const signed = signers.filter(signer => signer.signedAt).length
            const waiting = signers
              .filter(signer => !signer.signedAt)
              .map(signer => signer.name)
              .slice(0, 2)
              .join(', ')
            return (
              <li key={doc.id}>
                <a href={doc.documentUrl || undefined} target="_blank" rel="noreferrer">
                  <span className="ac-row-main">
                    <strong>{doc.title}</strong>
                    <span>
                      {docHubLabels[String(doc.status).toUpperCase()] || doc.status}
                      {signers.length ? ` · ${signed}/${signers.length} signed` : ''}
                      {waiting ? ` · waiting on ${waiting}` : ''}
                    </span>
                  </span>
                  <span className="ac-row-side">
                    <time>{shortDate(doc.updatedAt || doc.createdAt)}</time>
                    {doc.documentUrl && <ExternalLink size={13} />}
                  </span>
                </a>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
