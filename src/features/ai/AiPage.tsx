import { type AppState, type SignedInUser } from '../../app/useAppState'
import AIAssistant from '../../AIAssistant'
import { isArchived } from '../../lifecycle'

/** Ai screen. It reads the app state; see app/useAppState. */
export function AiPage({ app, currentUser }: { app: AppState; currentUser: SignedInUser }) {
  const { aiClientId, aiProjectId, aiPrompt, applyAISuggestion, setAiClientId, setAiProjectId, setAiPrompt, store } = app
  return (
    <section className="page-stack"><AIAssistant clients={store.clients.filter(client => !isArchived(client))} projects={store.projects.filter(project => !isArchived(project))} items={store.items} planner={store.planner} taskSettings={store.taskSettings} accounts={store.accounts} workEvents={store.workEvents} currentUser={currentUser} initialClientId={aiClientId} initialProjectId={aiProjectId} initialPrompt={aiPrompt} onContextChange={(clientId, projectId) => { setAiClientId(clientId); setAiProjectId(projectId); setAiPrompt('') }} onApplySuggestion={applyAISuggestion} /></section>
  )
}
