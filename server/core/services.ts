// Integration settings and AI agents, shared by the routes that use AI.
import { createAiAgentManager } from '../ai/ai-agent-manager'
import { createIntegrationStore } from '../integrations/tenant-integrations'
import { supabaseAdmin } from './database'

export const integrations = createIntegrationStore(supabaseAdmin)

export const aiAgents = createAiAgentManager(supabaseAdmin, integrations)
