import { useEffect, useState } from 'react'
import type { Client, Project, UserAccount } from '../../shared/types'
import { DocHubSettings } from '../documents/DocHubPanel'
import { CalendarAccountSettings } from '../integrations/GoogleCalendarPanel'
import { GmailAccountSettings } from '../integrations/GmailAccountSettings'
import { DriveAccountSettings } from '../integrations/DriveAccountSettings'
import { RepositoryMappingSettings } from '../integrations/RepositoryMappingSettings'
import { AccessSettings, SeedsConnectionCard } from '../seeds/SeedsSettings'
import { AccountWorkflow } from './WorkflowEditor'
import { RolesSettings } from './RolesSettings'
import type { SignoffTemplateKind } from '../documents/signoff'

export async function settingsRequest(url: string, method = 'GET', data?: unknown) {
  const response = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: data === undefined ? undefined : JSON.stringify(data),
  })
  const result = await response.json()
  if (!response.ok) throw new Error(result.error || 'Settings request failed.')
  return result
}
/** The account's Discord bot. AI keys are not here any more: Internal Admin sets them for every account. */
type Integration = {
  kind: 'discord'
  configured: boolean
  maskedKey: string
  enabled: boolean
  config: { allowedUserIds?: string[] }
  connectionStatus: string
  lastTestedAt?: string
}
function IntegrationCard({
  value,
  refresh,
  runtime,
}: {
  value: Integration
  refresh: () => Promise<void>
  runtime?: any
}) {
  const [secret, setSecret] = useState('')
  const [enabled, setEnabled] = useState(value.enabled)
  const [ids, setIds] = useState((value.config.allowedUserIds || []).join(', '))
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    setEnabled(value.enabled)
    setIds((value.config.allowedUserIds || []).join(', '))
  }, [value])
  const act = async (action: 'save' | 'test' | 'remove') => {
    if (action === 'remove' && !window.confirm('Remove this account’s Discord credential?')) return
    setBusy(true)
    setMessage('')
    try {
      const url = `/api/account/integrations/${value.kind}`
      const result = await settingsRequest(
        action === 'test' ? `${url}/test` : url,
        action === 'test' ? 'POST' : action === 'remove' ? 'DELETE' : 'PUT',
        action === 'save' ? { secret, enabled, config: { allowedUserIds: ids } } : undefined,
      )
      if (action !== 'test') setSecret('')
      setMessage(result.message || (action === 'remove' ? 'Credential removed.' : 'Account integration saved.'))
      await refresh()
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Request failed.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="panel account-integration-card">
      <div className="panel-heading">
        <div>
          <h2>Discord Integration</h2>
          <p>Capture DMs and mentions into this account’s Inbox.</p>
        </div>
        <span className="role-badge">
          {value.configured ? (value.enabled ? 'Enabled' : 'Disabled') : 'Not configured'}
        </span>
      </div>
      <p>
        Saved key: <b>{value.maskedKey || 'None'}</b> · Connection: {value.connectionStatus.replace(/_/g, ' ')}
      </p>
      {value.lastTestedAt && <p>Last tested: {new Date(value.lastTestedAt).toLocaleString()}</p>}
      <div className="integration-form">
        <label>
          {value.configured ? 'Replace credential (leave blank to keep it)' : 'Discord bot token'}
          <input type="password" value={secret} autoComplete="new-password" onChange={e => setSecret(e.target.value)} />
        </label>
        <label>
          Allowed Discord user IDs (comma-separated)
          <input value={ids} onChange={e => setIds(e.target.value)} />
          <small>Leave blank to allow anyone who can DM or mention your bot.</small>
        </label>
        <label className="checkbox-label">
          <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} /> Enable for this
          account
        </label>
      </div>
      <p>
        Gateway: {runtime?.online ? `Online — ${runtime.botName}` : 'Offline'}
        {runtime?.lastMessageAt ? ` · Last capture ${new Date(runtime.lastMessageAt).toLocaleString()}` : ''}
        {runtime?.lastError ? ` · ${runtime.lastError}` : ''}
      </p>
      {message && (
        <p role="status" className="settings-message">
          {message}
        </p>
      )}
      <div className="integration-actions">
        <button
          className="primary"
          disabled={busy || (!value.configured && !secret.trim())}
          onClick={() => void act('save')}
        >
          Save settings
        </button>
        <button className="secondary" disabled={busy || !value.configured} onClick={() => void act('test')}>
          Test saved connection
        </button>
        <button
          className="secondary danger-button"
          disabled={busy || !value.configured}
          onClick={() => void act('remove')}
        >
          Remove key
        </button>
      </div>
      <small>
        Saved credentials are encrypted. The full key is never returned after saving. Enable Message Content intent in
        the Discord Developer Portal.
      </small>
    </div>
  )
}

type TemplateKind = 'drf' | 'brd' | 'fsd' | SignoffTemplateKind
type TemplateInfo = {
  type: TemplateKind
  active: boolean
  source: 'custom' | 'built-in' | 'none'
  name: string
  updated_at?: string | null
}
const TEMPLATE_SPECS: {
  type: TemplateKind
  title: string
  format: string
  accept: string
  description: string
  note?: string
}[] = [
  {
    type: 'drf',
    title: 'DRF Template',
    format: 'Excel (.xlsx)',
    accept: '.xlsx',
    description:
      'Standard Excel template used by DRF Creation. The generated DRF keeps its layout, formatting, logo, merged cells, and mapped fields.',
  },
  {
    type: 'brd',
    title: 'BRD Template',
    format: 'Word (.docx)',
    accept: '.docx',
    description: 'Business Requirements layout used by BRD Creation.',
    note: 'The built-in template maps project details, summary, objectives, business problem, in-scope, stakeholders, functional requirements, acceptance criteria, and customer mapping. Custom BRD templates must keep the standard BRD mapping tags.',
  },
  {
    type: 'fsd',
    title: 'FSD Template',
    format: 'Word (.docx)',
    accept: '.docx',
    description: 'Word layout used when exporting an FSD.',
    note: 'Custom FSD templates must keep {{FSD_BODY}} in its own paragraph. Optional markers: {{FSD_REFERENCE}}, {{FSD_PRODUCT}}, {{FSD_FEATURE}}, {{FSD_CLIENT}}.',
  },
  {
    type: 'signoff',
    title: 'Production Deployment Template',
    format: 'Word (.docx)',
    accept: '.docx',
    description: 'Word template used for the Production Deployment Form.',
    note: 'Keep the standard Sign Off placeholders such as {client_name}, {document_reference}, deployment fields, and signatory fields.',
  },
  {
    type: 'golive',
    title: 'Go Live Sign Off Template',
    format: 'Word (.docx)',
    accept: '.docx',
    description: 'The Go Live Sign Off layout, mapped from your supplied template.',
    note: 'Keep the Go Live, editable-section, reference, author, date and signatory mapping tags. Additional signatories repeat the first approval row.',
  },
  {
    type: 'uat',
    title: 'UAT Sign Off Template',
    format: 'Word (.docx)',
    accept: '.docx',
    description: 'User Acceptance Testing sign-off, styled like the Go Live form.',
    note: 'Keep the UAT, editable-section, reference, author, date and signatory mapping tags. The three issue tables repeat one row each: keep each {#table_name} start and {/table_name} end tag in the first and last cell of that row.',
  },
  {
    type: 'uatdeploy',
    title: 'UAT Deployment Approval Template',
    format: 'Word (.docx)',
    accept: '.docx',
    description: 'UAT Deployment Approval Form, styled like the Production Deployment form.',
    note: 'Keep the {enhancement_name}, deployment, editable-section, reference and signatory mapping tags. Additional signatories repeat the first approval row.',
  },
  {
    type: 'training',
    title: 'Training Sign Off Template',
    format: 'Word (.docx)',
    accept: '.docx',
    description: 'Training sign-off, styled like the Go Live form.',
    note: 'Keep the training, editable-section, reference, author, date and signatory mapping tags. The Training Activities table repeats one row: keep {#training_activities} in the first cell and {/training_activities} in the last cell of that row.',
  },
]
function templateFileBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || '').split(',')[1] || '')
    reader.onerror = () => reject(new Error(`Could not read ${file.name}.`))
    reader.readAsDataURL(file)
  })
}
function Templates() {
  const [templates, setTemplates] = useState<TemplateInfo[]>([])
  const [messages, setMessages] = useState<Partial<Record<TemplateKind, string>>>({})
  const [busy, setBusy] = useState<TemplateKind | null>(null)
  const load = async () => {
    const result = await settingsRequest('/api/account/templates')
    setTemplates(Array.isArray(result.templates) ? result.templates : [])
    window.dispatchEvent(new Event('account-document-settings-changed'))
  }
  useEffect(() => {
    void load().catch(e => setMessages({ drf: e instanceof Error ? e.message : 'Could not load templates.' }))
  }, [])
  const current = (type: TemplateKind) =>
    templates.find(template => template.type === type) || { type, active: false, source: 'none' as const, name: '' }
  const upload = async (type: TemplateKind, file?: File) => {
    if (!file) return
    const spec = TEMPLATE_SPECS.find(item => item.type === type)!
    if (!file.name.toLowerCase().endsWith(spec.accept) || file.size > 5 * 1024 * 1024)
      return setMessages(value => ({ ...value, [type]: `Choose a ${spec.accept} file up to 5 MB.` }))
    setBusy(type)
    setMessages(value => ({ ...value, [type]: '' }))
    try {
      const content_base64 = await templateFileBase64(file)
      await settingsRequest(`/api/account/templates/${type}`, 'PUT', { name: file.name, content_base64 })
      await load()
      setMessages(value => ({ ...value, [type]: `${spec.title} saved. Document Creation will use it automatically.` }))
    } catch (e) {
      setMessages(value => ({ ...value, [type]: e instanceof Error ? e.message : 'Template upload failed.' }))
    } finally {
      setBusy(null)
    }
  }
  const remove = async (type: TemplateKind) => {
    const info = current(type),
      spec = TEMPLATE_SPECS.find(item => item.type === type)!
    if (
      !info.active ||
      !window.confirm(
        `Remove the active ${spec.title}? ${spec.title.replace('Template', '').trim()} generation will be unavailable until a template is uploaded${type === 'drf' ? '.' : ' or the built-in default is restored.'}`,
      )
    )
      return
    setBusy(type)
    setMessages(value => ({ ...value, [type]: '' }))
    try {
      await settingsRequest(`/api/account/templates/${type}`, 'DELETE')
      await load()
      setMessages(value => ({ ...value, [type]: `${spec.title} removed.` }))
    } catch (e) {
      setMessages(value => ({ ...value, [type]: e instanceof Error ? e.message : 'Could not remove template.' }))
    } finally {
      setBusy(null)
    }
  }
  const restoreDefault = async (type: Exclude<TemplateKind, 'drf'>) => {
    const spec = TEMPLATE_SPECS.find(item => item.type === type)!
    setBusy(type)
    setMessages(value => ({ ...value, [type]: '' }))
    try {
      await settingsRequest(`/api/account/templates/${type}/restore-default`, 'POST')
      await load()
      setMessages(value => ({ ...value, [type]: `Built-in ${spec.title} restored.` }))
    } catch (e) {
      setMessages(value => ({
        ...value,
        [type]: e instanceof Error ? e.message : 'Could not restore the built-in template.',
      }))
    } finally {
      setBusy(null)
    }
  }
  return (
    <div className="panel template-manager">
      <div className="panel-heading">
        <div>
          <h2>Document Templates</h2>
          <p>
            Manage the account-wide templates used by Document Creation. Uploading and replacing templates is handled
            here only.
          </p>
        </div>
      </div>
      <div className="template-manager-grid">
        {TEMPLATE_SPECS.map(spec => {
          const info = current(spec.type)
          const working = busy === spec.type
          const restorableType = spec.type === 'drf' ? null : spec.type
          return (
            <article className="template-manager-card" key={spec.type}>
              <div className="template-manager-card-head">
                <div>
                  <h3>{spec.title}</h3>
                  <span>{spec.format}</span>
                </div>
                <span className={`role-badge ${info.active ? '' : 'template-inactive'}`}>
                  {info.active ? (info.source === 'built-in' ? 'Built-in default' : 'Active') : 'Not configured'}
                </span>
              </div>
              <p>{spec.description}</p>
              <div className={`template-current ${info.active ? '' : 'empty'}`}>
                <strong>{info.active ? info.name : 'No active template'}</strong>
                {info.updated_at && <span>Updated {new Date(info.updated_at).toLocaleString()}</span>}
              </div>
              {spec.note && <small className="settings-helper">{spec.note}</small>}
              <div className="template-manager-actions">
                <label className={`secondary template-upload-button${working ? ' disabled' : ''}`}>
                  {info.source === 'custom' ? 'Change / Replace' : 'Upload template'}
                  <input
                    type="file"
                    accept={spec.accept}
                    disabled={Boolean(busy)}
                    onChange={event => {
                      void upload(spec.type, event.target.files?.[0])
                      event.target.value = ''
                    }}
                  />
                </label>
                <button
                  type="button"
                  className="secondary danger-button"
                  disabled={Boolean(busy) || !info.active}
                  onClick={() => void remove(spec.type)}
                >
                  Remove
                </button>
                {restorableType && info.source !== 'built-in' && (
                  <button
                    type="button"
                    className="secondary"
                    disabled={Boolean(busy)}
                    onClick={() => void restoreDefault(restorableType)}
                  >
                    Restore built-in
                  </button>
                )}
              </div>
              {messages[spec.type] && (
                <p role="status" className="settings-message">
                  {messages[spec.type]}
                </p>
              )}
            </article>
          )
        })}
      </div>
    </div>
  )
}

export default function Settings({
  currentUser,
  clients = [],
  projects = [],
}: {
  currentUser: UserAccount
  /** For Repository mapping (GIT Tracker). */
  clients?: Client[]
  projects?: Project[]
}) {
  const [data, setData] = useState<any>(null),
    [error, setError] = useState('')
  const isAdmin = currentUser.role === 'Administrator'
  const [activeTab, setActiveTab] = useState<'templates' | 'integrations' | 'workflow' | 'roles' | 'access'>(() =>
    new URLSearchParams(window.location.hash.slice(1)).has('drive') ? 'integrations' : 'templates',
  )
  const tabs = isAdmin
    ? [
        { id: 'templates' as const, label: 'Templates' },
        { id: 'integrations' as const, label: 'Integrations' },
        { id: 'workflow' as const, label: 'Workflow' },
        { id: 'roles' as const, label: 'Roles' },
        { id: 'access' as const, label: 'Access' },
      ]
    : []
  const load = async () => {
    setData(await settingsRequest('/api/account/integrations'))
    setError('')
  }
  useEffect(() => {
    if (isAdmin) void load().catch(e => setError(e.message))
  }, [currentUser.id, currentUser.organizationId, isAdmin])
  return (
    <section className="page-stack settings-page">
      <div className="page-heading">
        <div>
          <h1>Settings</h1>
          <p>{currentUser.organizationName} · Account preferences and integrations</p>
        </div>
      </div>
      {isAdmin ? (
        <>
          <div className="settings-tabs" role="tablist" aria-label="Settings sections">
            {tabs.map((tab, index) => (
              <button
                type="button"
                key={tab.id}
                id={`settings-tab-${tab.id}`}
                role="tab"
                aria-selected={activeTab === tab.id}
                aria-controls={`settings-section-${tab.id}`}
                tabIndex={activeTab === tab.id ? 0 : -1}
                onClick={() => setActiveTab(tab.id)}
                onKeyDown={event => {
                  const nextIndex =
                    event.key === 'ArrowRight'
                      ? (index + 1) % tabs.length
                      : event.key === 'ArrowLeft'
                        ? (index + tabs.length - 1) % tabs.length
                        : event.key === 'Home'
                          ? 0
                          : event.key === 'End'
                            ? tabs.length - 1
                            : -1
                  if (nextIndex < 0) return
                  event.preventDefault()
                  setActiveTab(tabs[nextIndex].id)
                  event.currentTarget.parentElement
                    ?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
                    [nextIndex]?.focus()
                }}
              >
                {tab.label}
              </button>
            ))}
          </div>
          <div
            className="settings-tab-content"
            id="settings-section-templates"
            role="tabpanel"
            aria-labelledby="settings-tab-templates"
            hidden={activeTab !== 'templates'}
            tabIndex={0}
          >
            <Templates />
          </div>
          <div
            className="settings-tab-content"
            id="settings-section-integrations"
            role="tabpanel"
            aria-labelledby="settings-tab-integrations"
            hidden={activeTab !== 'integrations'}
            tabIndex={0}
          >
            <div className="settings-section-heading">
              <div>
                <h2>Account integrations</h2>
                <p>Manage connections used by your account.</p>
              </div>
              <button type="button" className="secondary" onClick={() => void load().catch(e => setError(e.message))}>
                Refresh status
              </button>
            </div>
            {error && (
              <p role="alert" className="settings-message">
                {error}
              </p>
            )}
            {data && !data.encryptionReady && (
              <p role="alert" className="settings-message">
                Integration storage needs setup by Internal Admin.
              </p>
            )}
            {data?.integrations.map((value: Integration) => (
              <IntegrationCard key={value.kind} value={value} runtime={data.discord} refresh={load} />
            ))}
            <DocHubSettings key={`dochub:${currentUser.organizationId}`} />
            <CalendarAccountSettings key={currentUser.organizationId} />
            <GmailAccountSettings key={`gmail:${currentUser.organizationId}`} />
            <DriveAccountSettings key={`drive:${currentUser.organizationId}`} />
            <SeedsConnectionCard key={`seeds:${currentUser.organizationId}`} />
            {activeTab === 'integrations' && (
              <RepositoryMappingSettings
                key={`git-mapping:${currentUser.organizationId}`}
                clients={clients}
                projects={projects}
              />
            )}
          </div>
          <div
            className="settings-tab-content"
            id="settings-section-workflow"
            role="tabpanel"
            aria-labelledby="settings-tab-workflow"
            hidden={activeTab !== 'workflow'}
            tabIndex={0}
          >
            {activeTab === 'workflow' && (
              <AccountWorkflow key={`workflow:${currentUser.organizationId}`} request={settingsRequest} />
            )}
          </div>
          <div
            className="settings-tab-content"
            id="settings-section-roles"
            role="tabpanel"
            aria-labelledby="settings-tab-roles"
            hidden={activeTab !== 'roles'}
            tabIndex={0}
          >
            {activeTab === 'roles' && <RolesSettings request={settingsRequest} />}
          </div>
          <div
            className="settings-tab-content"
            id="settings-section-access"
            role="tabpanel"
            aria-labelledby="settings-tab-access"
            hidden={activeTab !== 'access'}
            tabIndex={0}
          >
            {activeTab === 'access' && <AccessSettings key={`access:${currentUser.organizationId}`} />}
          </div>
        </>
      ) : (
        <div className="panel">
          <h2>Account settings</h2>
          <p>Your account administrator manages templates and integrations.</p>
          <p className="settings-helper">
            Use <strong>My Themes</strong> in the left panel for interface mode and workspace background preferences.
          </p>
        </div>
      )}
    </section>
  )
}
