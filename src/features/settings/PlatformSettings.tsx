import { useEffect, useState } from 'react'
import { settingsRequest } from './Settings'
import type { TaskSettings } from '../../shared/types'
import { waitingOnOptions } from '../tasks/waitingOn'
import { WorkflowEditor, workflowSavedMessage } from './WorkflowEditor'
const withWaitingOn = (settings: TaskSettings | null | undefined): TaskSettings | null =>
  settings ? { ...settings, waitingOn: waitingOnOptions(settings) } : null
export default function PlatformSettings({
  organizationId,
  organizationName,
}: {
  organizationId: string
  organizationName: string
}) {
  const [system, setSystem] = useState<any>(null),
    [account, setAccount] = useState<any>(null)
  const [taskSettings, setTaskSettings] = useState<TaskSettings | null>(null),
    [version, setVersion] = useState(0)
  const [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false)
  const load = async () => {
    setSystem(await settingsRequest('/api/internal-admin/system'))
    if (organizationId) {
      const result = await settingsRequest(`/api/internal-admin/organizations/${organizationId}/system`)
      setAccount(result)
      setTaskSettings(withWaitingOn(result.taskSettings))
      setVersion(current => current + 1)
    }
  }
  useEffect(() => {
    let active = true
    setAccount(null)
    setTaskSettings(null)
    setMessage('')
    void Promise.all([
      settingsRequest('/api/internal-admin/system'),
      organizationId
        ? settingsRequest(`/api/internal-admin/organizations/${organizationId}/system`)
        : Promise.resolve(null),
    ])
      .then(([s, a]) => {
        if (active) {
          setSystem(s)
          setAccount(a)
          setTaskSettings(withWaitingOn(a?.taskSettings))
        }
      })
      .catch(e => {
        if (active) setMessage(e.message)
      })
    return () => {
      active = false
    }
  }, [organizationId])
  const run = async (fn: () => Promise<any>) => {
    setBusy(true)
    setMessage('')
    try {
      const result = await fn()
      await load()
      setMessage(result.message || 'Completed successfully.')
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Request failed.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="panel platform-settings">
      <div className="panel-heading">
        <div>
          <h2>Platform settings</h2>
          <p>Database sync and account configuration.</p>
        </div>
        <span className="version-badge">v{system?.version || '…'}</span>
      </div>
      {message && (
        <p className="settings-message" role="status">
          {message}
        </p>
      )}
      <div className="platform-settings-grid">
        <section>
          <h3>Database & credential storage</h3>
          <p>
            {system?.databaseProvider || 'Database'}: {system?.databaseConfigured ? 'Configured' : 'Not configured'}
          </p>
          <p>Integration tables: {system?.integrationsReady ? 'Ready' : 'Setup required'}</p>
          <p>Encryption key: {system?.encryptionReady ? 'Configured' : 'Setup required'}</p>
          <small>
            The server uses DATABASE_URL and TENANT_INTEGRATION_MASTER_KEY. Keep these infrastructure secrets
            server-side.
          </small>
        </section>
      </div>
      <h3>{organizationName ? `${organizationName} — account configuration` : 'Choose an account above'}</h3>
      {organizationId && (
        <>
          <section>
            <h4>Database Sync</h4>
            <p>
              Last normalized sync:{' '}
              {account?.sync?.syncedAt ? new Date(account.sync.syncedAt).toLocaleString() : 'No sync recorded'}
            </p>
            <button
              className="secondary"
              disabled={busy || !account?.sync?.ready}
              onClick={() =>
                void run(() => settingsRequest('/api/data-architecture/migrate', 'POST', { organizationId }))
              }
            >
              Migrate / Sync selected account
            </button>
          </section>
          <section>
            <h4>Integration health</h4>
            {['discord', 'openai'].map(kind => {
              const row = system?.health?.find(
                (r: any) => r.tenant_id === organizationId && r.integration_type === kind,
              )
              return (
                <p key={kind}>
                  {kind === 'discord' ? 'Discord' : 'AI'}:{' '}
                  {row ? `${row.is_enabled ? 'Enabled' : 'Disabled'} · ${row.connection_status}` : 'Not configured'}
                </p>
              )
            })}
          </section>
          {(system?.legacy?.discord || system?.legacy?.openai) && (
            <section>
              <h4>Import existing Render credentials</h4>
              <p>
                Import into <b>{organizationName}</b> as disabled credentials. Existing account credentials cannot be
                overwritten.
              </p>
              <div className="integration-actions">
                {(['discord', 'openai'] as const)
                  .filter(kind => system.legacy[kind])
                  .map(kind => (
                    <button
                      className="secondary"
                      key={kind}
                      disabled={busy}
                      onClick={() => {
                        if (
                          window.confirm(
                            `Import the old ${kind} credential into ${organizationName}? It will be saved disabled.`,
                          )
                        )
                          void run(() =>
                            settingsRequest(
                              `/api/internal-admin/organizations/${organizationId}/import-legacy/${kind}`,
                              'POST',
                            ),
                          )
                      }}
                    >
                      Import {kind === 'discord' ? 'Discord' : 'AI'}
                    </button>
                  ))}
              </div>
              <small>
                Test and enable from that account’s Settings, then remove the old provider variables from Render.
              </small>
            </section>
          )}
          {taskSettings && (
            <section>
              <h4>Task configuration</h4>
              <p>
                Changes apply to {organizationName}. The account’s own Administrators can also change this in Settings ›
                Workflow.
              </p>
              <WorkflowEditor
                key={`${organizationId}:${version}`}
                initial={taskSettings}
                usage={account?.usage}
                busy={busy}
                onSave={input =>
                  void run(async () => {
                    const result = await settingsRequest(
                      `/api/internal-admin/organizations/${organizationId}/task-settings`,
                      'PUT',
                      input,
                    )
                    return { ...result, message: workflowSavedMessage(result) }
                  })
                }
              />
            </section>
          )}
        </>
      )}
    </div>
  )
}
