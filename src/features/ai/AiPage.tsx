import type { AppState, SignedInUser } from '../../app/useAppState'
import AIAssistant from './AIAssistant'
import { isArchived, isClosedProject } from '../tasks/lifecycle'
import { loadCloudStore } from '../../app/cloudStore'
import { normalizeStore, seedStore, type Store } from '../../app/store'

/** Ai screen. It reads the app state; see app/useAppState. */
export function AiPage({ app, currentUser }: { app: AppState; currentUser: SignedInUser }) {
  const {
    aiClientId,
    aiProjectId,
    aiPrompt,
    applyAISuggestion,
    applyTimeEntryMutation,
    canWriteTasks,
    createPlannedTasks,
    setAiClientId,
    setAiProjectId,
    setAiPrompt,
    setStore,
    store,
  } = app
  return (
    <section className="page-stack">
      <AIAssistant
        clients={store.clients.filter(client => !isArchived(client))}
        projects={store.projects.filter(project => !isClosedProject(project))}
        items={store.items}
        planner={store.planner}
        taskSettings={store.taskSettings}
        accounts={store.accounts}
        workEvents={store.workEvents}
        currentUser={currentUser}
        initialClientId={aiClientId}
        initialProjectId={aiProjectId}
        initialPrompt={aiPrompt}
        onContextChange={() => {
          // The assistant keeps the clients and projects chosen; clearing these lets the same client be opened again.
          setAiClientId('')
          setAiProjectId('')
          setAiPrompt('')
        }}
        onApplySuggestion={applyAISuggestion}
        canWriteTasks={canWriteTasks}
        onCreateTasks={createPlannedTasks}
        onTimeEntry={applyTimeEntryMutation}
        onWorkChanged={async () => {
          const result = await loadCloudStore<Store>()
          if (result.data) setStore(normalizeStore(result.data, seedStore()))
        }}
      />
    </section>
  )
}
