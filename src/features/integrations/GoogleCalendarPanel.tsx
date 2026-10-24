import { useEffect, useRef, useState } from 'react'
import { CalendarDays, ExternalLink, RefreshCw } from 'lucide-react'
import ActivityCommentPreview from '../tasks/ActivityCommentPreview'
import { calendarRequest, scheduleRange, type CalendarChoice, type CalendarConnection, type CalendarEvent } from './googleCalendar'
import './google-calendar.css'

type AccountConfig = { platformEnabled: boolean; configured: boolean; enabled: boolean; encryptionReady: boolean; clientId: string; redirectUri: string; expectedRedirectUri: string }

export function CalendarAccountSettings() {
  const [config, setConfig] = useState<AccountConfig | null>(null), [busy, setBusy] = useState(false), [message, setMessage] = useState('')
  const [oauthJson, setOauthJson] = useState(''), [filename, setFilename] = useState(''), [clientId, setClientId] = useState(''), [clientSecret, setClientSecret] = useState(''), [enabled, setEnabled] = useState(true)
  const load = async () => { const value = await calendarRequest<AccountConfig>('/api/account/google-calendar'); setConfig(value); setEnabled(value.configured ? value.enabled : true) }
  useEffect(() => { let alive = true; void calendarRequest<AccountConfig>('/api/account/google-calendar').then(value => { if (alive) { setConfig(value); setEnabled(value.configured ? value.enabled : true) } }).catch(e => { if (alive) setMessage(e.message) }); return () => { alive = false } }, [])
  const upload = async (file?: File) => {
    if (!file) return
    setMessage('')
    try {
      if (file.size > 32768) throw new Error()
      const text = await file.text(), parsed = JSON.parse(text)
      if (!parsed.web?.client_id || !parsed.web?.client_secret) throw new Error()
      setOauthJson(JSON.stringify({ web: { client_id: parsed.web.client_id, client_secret: parsed.web.client_secret } })); setFilename(file.name); setClientId(''); setClientSecret('')
    } catch { setOauthJson(''); setFilename(''); setMessage('Choose a valid Google Web application OAuth JSON file under 32 KB.') }
  }
  const save = async (remove = false) => {
    const replacing = Boolean(oauthJson || clientId || clientSecret)
    if ((remove || (config?.configured && replacing)) && !window.confirm(remove ? 'Remove this account’s Google credentials? Users must reconnect after new credentials are saved. Existing user tokens can still be removed with Disconnect.' : 'Replace this account’s Google credentials? All users will need to reconnect.')) return
    setBusy(true); setMessage('')
    try {
      await calendarRequest('/api/account/google-calendar', remove ? 'DELETE' : 'PUT', remove ? {} : { enabled, ...(replacing ? { oauthJson: oauthJson || undefined, clientId, clientSecret, redirectUri: config?.expectedRedirectUri } : {}) })
      setOauthJson(''); setFilename(''); setClientId(''); setClientSecret(''); await load()
      setMessage(remove ? 'Account credentials removed.' : 'Account Calendar settings saved. Users can connect from Action Center → My Google Calendar.')
    } catch (e) { setMessage((e as Error).message) } finally { setBusy(false) }
  }
  return <section className="panel account-integration-card calendar-card">
    <div className="panel-heading"><div><h2>Google Calendar — account setup</h2><p>Account credentials are encrypted. Each user authorizes their own Google account separately.</p></div></div>
    {config && <><p>Internal Admin: {config.platformEnabled ? 'Enabled' : 'Disabled'} · Credentials: {config.configured ? 'Saved' : 'Not configured'}</p>
      {!config.encryptionReady && <p role="alert">Internal Admin must configure the existing TENANT_INTEGRATION_MASTER_KEY before saving credentials.</p>}
      <label>Authorized redirect URI — copy this exact address to Google Cloud<input readOnly value={config.expectedRedirectUri} onFocus={e => e.target.select()} /></label>
      {config.redirectUri !== config.expectedRedirectUri && <p role="alert">The saved callback uses an older app address. Re-upload your OAuth JSON after updating Google Cloud.</p>}
      {config.clientId && <p className="calendar-break">Saved Client ID: {config.clientId}</p>}
      <div className="integration-form"><label>Google OAuth JSON (Web application)<input type="file" accept=".json,application/json" disabled={busy || !config.platformEnabled} onChange={e => { void upload(e.target.files?.[0]); e.target.value = '' }} /><small>{filename ? `${filename} selected; choose Save to store it securely.` : 'The JSON is not saved until you click Save. It is not kept in browser storage.'}</small></label>
      <details><summary>Or enter Client ID and Client Secret</summary><label>Client ID<input autoComplete="off" value={clientId} disabled={busy || Boolean(oauthJson)} onChange={e => setClientId(e.target.value)} /></label><label>Client Secret<input type="password" autoComplete="new-password" value={clientSecret} disabled={busy || Boolean(oauthJson)} onChange={e => setClientSecret(e.target.value)} /></label><small>Leave both blank to keep saved credentials.</small></details>
      <label className="checkbox-label"><input type="checkbox" checked={enabled} disabled={busy} onChange={e => setEnabled(e.target.checked)} /> Enable Calendar for this account</label></div>
      <div className="integration-actions"><button className="primary" type="button" disabled={busy || !config.platformEnabled || !config.encryptionReady} onClick={() => void save()}>{busy ? 'Saving…' : 'Save Calendar settings'}</button><button className="secondary" type="button" disabled={busy || !config.configured} onClick={() => void save(true)}>Remove account credentials</button></div>
      <small>Enable Google Calendar API in Google Cloud. External/Testing users must be added as test users and may need to reconnect after seven days. No Google credential environment variables are used.</small>
    </>}
    {message && <p role="status" className="settings-message">{message}</p>}
  </section>
}

export function CalendarPlatformControl({ organizationId }: { organizationId: string }) {
  const [data, setData] = useState<{ enabled: boolean; configured: boolean } | null>(null), [message, setMessage] = useState(''), [busy, setBusy] = useState(false)
  const url = `/api/internal-admin/organizations/${encodeURIComponent(organizationId)}/google-calendar`
  useEffect(() => { const controller = new AbortController(); setData(null); setMessage(''); void calendarRequest<typeof data>(url, 'GET', undefined, controller.signal).then(setData).catch(e => { if (!controller.signal.aborted) setMessage(e.message) }); return () => controller.abort() }, [url])
  const toggle = async () => {
    if (!data) return
    setBusy(true); setMessage('')
    try { await calendarRequest(url, 'PUT', { enabled: !data.enabled }); setData({ ...data, enabled: !data.enabled }) } catch(e) { setMessage((e as Error).message) } finally { setBusy(false) }
  }
  return <div className="internal-admin-detail-section"><strong>Google Calendar integration</strong><p>Enable for this tenant; its administrator manages credentials in account Settings.</p>{data && <><label className="checkbox-label"><input type="checkbox" checked={data.enabled} disabled={busy} onChange={() => void toggle()} /> Allow Google Calendar</label><small>Credentials: {data.configured ? 'Configured by account' : 'Not configured'}. User calendars and tokens are private.</small></>}{message && <p role="alert">{message}</p>}</div>
}

export default function GoogleCalendarPanel() {
  const [connection, setConnection] = useState<CalendarConnection | null>(null), [choices, setChoices] = useState<CalendarChoice[]>([]), [selected, setSelected] = useState<string[]>([])
  const [events, setEvents] = useState<CalendarEvent[]>([]), [range, setRange] = useState<'today' | 'week'>('today'), [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [error, setError] = useState(''), [refreshed, setRefreshed] = useState(''), [showCalendars, setShowCalendars] = useState(false), [timeZone, setTimeZone] = useState('')
  const controller = useRef<AbortController | null>(null), alive = useRef(true)
  const load = async (mode = range) => {
    controller.current?.abort(); const request = new AbortController(); controller.current = request
    setBusy(true); setError(''); setEvents([]); setRefreshed(''); setChoices([])
    try {
      const status = await calendarRequest<CalendarConnection>('/api/me/google-calendar', 'GET', undefined, request.signal)
      if (request.signal.aborted) return
      setConnection(status); setSelected(status.selectedCalendarIds)
      if (status.enabled && status.connected) {
        const window = scheduleRange(mode)
        const [calendars, schedules] = await Promise.all([
          calendarRequest<{ calendars: CalendarChoice[] }>('/api/me/google-calendar/calendars', 'GET', undefined, request.signal),
          calendarRequest<{ events: CalendarEvent[]; refreshedAt: string; timeZone: string }>(`/api/me/google-calendar/events?${new URLSearchParams(window)}`, 'GET', undefined, request.signal),
        ])
        if (!request.signal.aborted) { setChoices(calendars.calendars); setEvents(schedules.events); setRefreshed(schedules.refreshedAt); setTimeZone(schedules.timeZone) }
      }
    } catch (e) { if (!request.signal.aborted) { setError((e as Error).message); setEvents([]) } } finally { if (!request.signal.aborted) setBusy(false) }
  }
  useEffect(() => {
    alive.current = true
    const result = new URLSearchParams(window.location.hash.slice(1)).get('calendar')
    if (result) { setMessage(result === 'connected' ? 'Google Calendar connected to your user.' : result === 'denied' ? 'Google authorization was cancelled. No connection was saved.' : 'Connection was not completed. Check both Calendar permissions, callback URL and test-user access, then retry.'); window.history.replaceState(null, '', window.location.pathname + window.location.search) }
    return () => { alive.current = false; controller.current?.abort() }
  }, [])
  useEffect(() => { void load(range); return () => controller.current?.abort() }, [range])
  const act = async (action: 'connect' | 'disconnect' | 'select') => {
    if (action === 'disconnect' && !window.confirm('Disconnect your Google Calendar and revoke this Google app’s access? Google revocation can also affect other connections using the same Google account and Cloud project.')) return
    setBusy(true); setError(''); setMessage('')
    try {
      if (action === 'connect') {
        const result = await calendarRequest<{ url: string }>('/api/me/google-calendar/connect', 'POST', {})
        if (!alive.current) return
        const url = new URL(result.url)
        if (url.origin !== 'https://accounts.google.com') throw new Error('Invalid Google authorization address.')
        window.location.assign(url.href); return
      }
      if (action === 'disconnect') {
        const result = await calendarRequest('/api/me/google-calendar', 'DELETE', {})
        if (!alive.current) return
        setEvents([]); setChoices([]); setMessage(result.message)
      } else {
        await calendarRequest('/api/me/google-calendar/calendars', 'PUT', { calendarIds: selected })
        if (!alive.current) return
        setMessage('Calendar selection saved for your user.'); setShowCalendars(false)
      }
      await load()
    } catch(e) { if (alive.current) { setError((e as Error).message); setEvents([]) } } finally { if (alive.current) setBusy(false) }
  }
  const calendarId = (choice: CalendarChoice) => choice.primary ? 'primary' : choice.id
  return <section className="panel dashboard-panel calendar-card" aria-label="My private Google Calendar">
    <div className="panel-heading dashboard-panel-heading"><div><h2><CalendarDays size={18} /> My Google Calendar</h2><p>Your private schedule only—even when the work view shows another user or all users. Read-only; never sent to AI or saved as shared tracker activities.</p></div></div>
    <div className="calendar-toolbar"><span>{connection?.connected ? `Connected: ${connection.email}` : 'Not connected'}</span>
      {connection?.enabled && <button className="secondary" disabled={busy} onClick={() => void act('connect')}>{connection.connected ? 'Reconnect / change Google account' : 'Connect Google Calendar'}</button>}
      {connection?.hasConnection && <button className="secondary" disabled={busy} onClick={() => void act('disconnect')}>Disconnect</button>}
      <button className="secondary" disabled={busy} onClick={() => void load()}><RefreshCw size={15} /> {busy ? 'Loading…' : 'Refresh'}</button>
    </div>
    {connection && !connection.enabled && <p>Calendar is not enabled or configured for this account. Ask your account administrator to check Settings → Google Calendar and Internal Admin access.</p>}
    {connection?.reconnectRequired && <p>The account’s OAuth credentials changed. Connect again to continue.</p>}
    {connection?.enabled && connection.connected && <>
      <div className="calendar-toolbar"><button className={`secondary ${range === 'today' ? 'active-tab' : ''}`} disabled={busy} onClick={() => setRange('today')}>Today</button><button className={`secondary ${range === 'week' ? 'active-tab' : ''}`} disabled={busy} onClick={() => setRange('week')}>This Week</button><button className="secondary" disabled={busy} onClick={() => setShowCalendars(!showCalendars)}>Choose calendars</button><small>{timeZone} · Week starts Sunday</small></div>
      {showCalendars && <div className="calendar-picker"><p>Select up to 10 calendars. This selection belongs only to you.</p>{choices.map(choice => <label className="checkbox-label" key={choice.id}><input type="checkbox" checked={selected.includes(calendarId(choice))} disabled={busy || (!selected.includes(calendarId(choice)) && selected.length >= 10)} onChange={e => setSelected(e.target.checked ? [...selected, calendarId(choice)] : selected.filter(id => id !== calendarId(choice)))} /> {choice.name}{choice.primary ? ' (Primary)' : ''}</label>)}<button className="primary" disabled={busy || !choices.length} onClick={() => void act('select')}>Save my selection</button></div>}
      {!busy && !error && !events.length && <p>{selected.length ? 'No events in this range.' : 'No calendars selected. Choose calendars to display your schedule.'}</p>}
      <div className="activity-tile-grid">{events.map(event => <article className="activity-tile" key={event.id}><div className="activity-tile-top"><span className="activity-tile-kind">Google Calendar · Private · Read-only</span></div><h3>{event.title}</h3><p>{event.date}{event.endDate !== event.date ? ` – ${event.endDate}` : ''} · {event.allDay ? 'All day' : `${event.startTime} – ${event.endTime}`}</p><p className="activity-tile-context">{choices.find(choice => calendarId(choice) === event.calendarId)?.name || 'Google Calendar'}{event.location ? ` · ${event.location}` : ''}</p><ActivityCommentPreview text={event.notes} title={event.title} />{event.calendarLink && <a className="secondary compact dashboard-link-button" href={event.calendarLink} target="_blank" rel="noreferrer"><ExternalLink size={14} /> Open in Google Calendar</a>}</article>)}</div>
      {refreshed && <small>Last refreshed: {new Date(refreshed).toLocaleString()}. Use Refresh for Google changes; your tracker activities are unchanged.</small>}
    </>}
    {message && <p role="status" className="calendar-message">{message}</p>}{error && <p role="alert" className="calendar-message">{error}</p>}
  </section>
}
