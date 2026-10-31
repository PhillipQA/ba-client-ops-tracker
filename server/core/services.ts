// Integration settings and AI agents, shared by the routes that use AI.
import { createAiAgentManager } from '../ai/ai-agent-manager'
import { createIntegrationStore } from '../integrations/tenant-integrations'
import { db } from './database'

export const integrations = createIntegrationStore(db)

export const aiAgents = createAiAgentManager(db, integrations)
