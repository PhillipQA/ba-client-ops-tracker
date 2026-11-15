/**
 * Jarvis for SQL (Data explorer and Reports): POST /api/assistant/sql.
 * - write, change, fix: one read-only query; explain: what a query does; report: a plan of SQL widgets;
 *   notes: findings from the results the person chose to send.
 * Only table and column names reach the AI for queries; rows never do, except the results sent for notes. Every query
 * the AI writes is checked to be one SELECT or WITH statement, and it runs in the person's browser over what they may
 * already see.
 */
import type express from 'express'
import type { Express, RequestHandler } from 'express'
import rateLimit from 'express-rate-limit'
import { moduleAllowed, requireAuth, requireTenantWorkspace, type SessionUser } from '../core/auth'
import { followUpTimeZone } from '../core/config'
import { aiAgents } from '../core/services'
import { tenantIdForUser } from '../core/tenant-state'
import { dateKeyInTimeZone } from '../services/follow-up-rollover'
import {
  ASSIST_LIMITS,
  ASSIST_MODES,
  type AssistMode,
  assistInput,
  assistInstructions,
  cleanExplanation,
  cleanNotes,
  cleanPlan,
  cleanSqlAnswer,
} from '../../src/features/reports/explorer/sqlAssist'
import { SQL_LIMITS } from '../../src/features/reports/explorer/sqlEngine'
import { runAiJson } from './parse-ai-json'
import { runTenantAi } from './tenant-ai'

type Ai = { secret: string; config: unknown }
export type SqlAssistDeps = {
  auth?: RequestHandler[]
  ai?: (tenant: string) => Promise<Ai | null>
  run?: (secret: string, config: unknown, instructions: string, input: string) => Promise<string>
  now?: () => Date
}

class AssistError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message)
  }
}

export function registerSqlAssistRoutes(app: Express, deps: SqlAssistDeps = {}) {
  const auth = deps.auth || [requireAuth, requireTenantWorkspace]
  const activeAi = deps.ai || ((tenant: string) => aiAgents.active(tenant, 'ba_assistant'))
  const run =
    deps.run || ((secret, config, instructions, input) => runTenantAi(secret, config, instructions, input, 45000))
  const who = (req: express.Request) => (req as express.Request & { authUser: SessionUser }).authUser
  const mayAsk = (user: SessionUser) =>
    (user.role !== 'Viewer' || (user as { askAi?: boolean }).askAi === true) &&
    moduleAllowed(user, 'ai') &&
    moduleAllowed(user, 'reports')
  const limit = rateLimit({
    windowMs: 10 * 60_000,
    limit: 60,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: req => {
      const user = (req as express.Request & { authUser?: SessionUser }).authUser
      return `${user?.organizationId || ''}:${user?.id || ''}`
    },
    message: { error: 'Too many questions to Jarvis. Wait a little and try again.' },
  })

  app.post('/api/assistant/sql', ...auth, limit, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    try {
      const user = who(req)
      if (!mayAsk(user)) throw new AssistError('Your account does not have Jarvis for reports.', 403)
      const body = req.body || {}
      const mode = String(body.mode || '') as AssistMode
      const field = (name: string, max: number) => {
        const value = body[name]
        if (value === undefined || value === null || value === '') return ''
        if (typeof value !== 'string' || value.length > max) throw new AssistError('That request is too long.')
        return value
      }
      if (!ASSIST_MODES.includes(mode)) throw new AssistError('Choose what Jarvis should do.')
      const question = field('question', ASSIST_LIMITS.question).trim(),
        sql = field('sql', SQL_LIMITS.length),
        error = field('error', ASSIST_LIMITS.error),
        schema = field('schema', ASSIST_LIMITS.schema),
        results = field('results', ASSIST_LIMITS.results)
      if (['write', 'change', 'report'].includes(mode) && !question) throw new AssistError('Ask Jarvis a question.')
      if (['change', 'fix', 'explain'].includes(mode) && !sql.trim()) throw new AssistError('There is no query yet.')
      if (['write', 'change', 'fix', 'report'].includes(mode) && !schema)
        throw new AssistError('The tables are missing.')
      if (mode === 'notes' && !results) throw new AssistError('Run the report first.')
      const ai = await activeAi(String(tenantIdForUser(user))).catch(() => null)
      if (!ai)
        throw new AssistError('Turn on the BA Assistant in Account Settings › AI Agent Manager to use Jarvis.', 409)
      const today = dateKeyInTimeZone(deps.now ? deps.now() : new Date(), followUpTimeZone)
      const answer = await runAiJson(
        extra =>
          run(
            ai.secret,
            ai.config,
            `${assistInstructions(mode)}${extra}`,
            assistInput({ mode, question, sql, error, schema, results, today }),
          ),
        () => new AssistError('Jarvis could not answer this time. Try again.', 502),
        'sql-assist',
      )
      const unreadable = () =>
        new AssistError('Jarvis could not write a usable query this time. Try rewording it.', 502)
      if (mode === 'explain') {
        const explanation = cleanExplanation(answer)
        if (!explanation) throw unreadable()
        res.json({ explanation })
      } else if (mode === 'report') {
        const plan = cleanPlan(answer)
        if (!plan) throw unreadable()
        res.json(plan)
      } else if (mode === 'notes') {
        const notes = cleanNotes(answer)
        if (!notes.length) throw unreadable()
        res.json({ notes })
      } else {
        const cleaned = cleanSqlAnswer(answer)
        if (!cleaned) throw unreadable()
        res.json(cleaned)
      }
    } catch (error) {
      if (error instanceof AssistError) return void res.status(error.status).json({ error: error.message })
      console.error('Jarvis SQL failed:', error instanceof Error ? error.message : error)
      res.status(503).json({ error: 'Jarvis is unavailable right now. Try again in a moment.' })
    }
  })
}
