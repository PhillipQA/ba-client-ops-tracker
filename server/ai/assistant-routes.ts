import express, { type Express } from 'express'
import { openWaitingOnOptions } from '../../src/features/tasks/waitingOn'
import { moduleAllowed, requireAuth, requireTenantWorkspace, type SessionUser } from '../core/auth'
import { followUpTimeZone } from '../core/config'
import { aiAgents, integrations } from '../core/services'
import { emptyTenantData, ensureTenantFollowUpsCurrent, tenantIdForUser } from '../core/tenant-state'
import { dateKeyInTimeZone } from '../services/follow-up-rollover'
import { buildAssistantContext } from './assistant-context'
import { parseModelJson, sanitizeSuggestions } from './suggestions'
import { runTenantAi } from './tenant-ai'

/** The AI BA assistant. */
export function registerAssistantRoutes(app: Express) {
  app.post('/api/assistant', requireAuth, requireTenantWorkspace, async (req, res) => {
    const user = (req as express.Request & { authUser: SessionUser }).authUser
    if (user.role === 'Viewer' || !moduleAllowed(user, 'ai')) {
      res.status(403).json({ error: 'Your account does not have access to the AI BA Assistant.' })
      return
    }

    let ai: Awaited<ReturnType<typeof integrations.active>>
    try { ai = await aiAgents.active(tenantIdForUser(user)!, 'ba_assistant') } catch { return void res.status(503).json({ error: 'BA Assistant settings are unavailable.' }) }
    if (!ai) return void res.status(503).json({ error: 'Enable and configure the BA Assistant in Account Settings → AI Agent Manager.' })

    const message = typeof req.body?.message === 'string' ? req.body.message.trim() : ''
    if (!message) {
      res.status(400).json({ error: 'Message is required.' })
      return
    }

    const today = dateKeyInTimeZone(new Date(), followUpTimeZone)
    const requestedContext: any = req.body?.context && typeof req.body.context === 'object' ? req.body.context : {}
    const history = Array.isArray(req.body?.history) ? req.body.history.slice(-8) : []

    // Resolve AI context from the authenticated tenant snapshot. The browser may request a
    // client/project focus, but it cannot supply records or impersonate another current user.
    let context: any
    let waitingOnLabels = openWaitingOnOptions(undefined).map((option) => option.label)
    let taskSettings: unknown
    try {
      const state = (await ensureTenantFollowUpsCurrent(String(tenantIdForUser(user)))).data || emptyTenantData()
      taskSettings = state.taskSettings
      waitingOnLabels = openWaitingOnOptions(state.taskSettings).map((option) => option.label)
      context = buildAssistantContext(state, user, requestedContext, message, today, followUpTimeZone, module => moduleAllowed(user, module as any))
    } catch (error) {
      console.error('AI context load failed:', error)
      return void res.status(503).json({ error: 'The assistant could not load your authorized workspace context.' })
    }

    const instructions = `You are an embedded Business Analyst assistant inside a client operations tracker.
  Your job is to assess messy client input and help the BA organize work without making decisions silently.
  Be concise, practical, and evidence-aware. Distinguish what is known from what needs confirmation.
  Never claim a ticket, activity, email, or requirement was created or sent. You only propose actions for the human to approve.
  The authenticated current user is authoritative. Interpret I/me/my as that user. Respect the supplied role and permission-filtered context. Never infer or request hidden tenant data.
  Today is ${today}. Use the supplied business timezone and explicit period. Use exact totals for counts, never count sampled arrays as the workspace total. Detail arrays may be partial and descriptions shortened: acknowledge omissions, do not claim an exhaustive review, and request a narrower scope when needed. Distinguish current assignments from historical contributions. Cite task/event IDs for factual claims. Never use chat history as newer authoritative tracker data.

  Return JSON only with this shape:
  {
    "message": "your assessment in readable plain text, using short paragraphs or bullets",
    "suggestions": [
      {
        "id": "short-id",
        "kind": "issue | requirement | follow_up | activity | draft_reply",
        "title": "short action title",
        "rationale": "why this is suggested",
        "description": "optional record detail",
        "priority": "Low | Medium | High | Urgent",
        "waitingOn": "${waitingOnLabels.join(' | ')}",
        "followUpDate": "YYYY-MM-DD when useful",
        "activityDate": "YYYY-MM-DD when useful",
        "activityTime": "HH:MM when useful",
        "draft": "only for draft_reply"
      }
    ]
  }
  Use at most 5 suggestions. Do not invent client commitments or technical facts. If the input is ambiguous, suggest a clarification or follow-up instead of pretending it is a defect.`

    try {
      const outputText = await runTenantAi(
        ai.secret,
        ai.config,
        instructions,
        `TRACKER CONTEXT:
  ${JSON.stringify(context, null, 2)}

  RECENT CHAT:
  ${JSON.stringify(history, null, 2)}

  USER MESSAGE:
  ${message}`,
      )
      const parsed = parseModelJson(outputText)
      const responseMessage = String(parsed.message || '').trim()
      if (!responseMessage) throw new Error('The model returned no assessment.')
      res.json({ message: responseMessage + (context.coverageNotice ? `\n\n${context.coverageNotice}` : ''), suggestions: sanitizeSuggestions(parsed.suggestions, taskSettings), contextCoverage: context.coverage })
    } catch (error) {
      console.error('Account AI request failed.')
      res.status(502).json({ error: 'BA Assistant request failed. Check this account’s BA Assistant provider, key, selected model, quota, and connection.' })
    }
  })
}
