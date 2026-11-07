/**
 * Settings › Workflow: an account's Administrator manages its own task statuses, waiting-on options, visible task
 * columns and the names of priorities and client health. Renames carry over to every task; a status still in use is
 * removed only by moving its tasks. The rules live in src/features/tasks/workflow.ts, shared with Internal Admin.
 */
import type { Express, NextFunction, Request, Response } from 'express'
import { planWorkflowUpdate, statusUsage } from '../../src/features/tasks/workflow'
import { waitingOnOptions } from '../../src/features/tasks/waitingOn'
import { cleanJobRole, jobRoles, MAX_JOB_ROLES } from '../../src/shared/roles'
import { workspaceAccess } from '../../src/shared/access'

type Middleware = (req: Request, res: Response, next: NextFunction) => any
export interface WorkflowDeps {
  requireAuth: Middleware
  requireTenant: Middleware
  load: (organizationId: string) => Promise<{ data: any }>
  commit: (organizationId: string, state: any, actor: any, reason: string, before: any) => Promise<unknown>
  defaults: any
}

/** The workflow and how many tasks use each status and waiting-on option, for the editor. */
export function workflowView(state: any, defaults: any) {
  const taskSettings = state?.taskSettings || defaults
  const items = Array.isArray(state?.items) ? state.items : []
  const waiting = new Map<string, number>()
  for (const item of items) {
    const label = String(item?.waitingOn ?? '')
    if (label) waiting.set(label, (waiting.get(label) || 0) + 1)
  }
  return {
    taskSettings: { ...taskSettings, waitingOn: waitingOnOptions(taskSettings) },
    usage: { statuses: Object.fromEntries(statusUsage(items)), waitingOn: Object.fromEntries(waiting) },
  }
}

/** Applies a workflow change to one account's workspace. Throws { status, message } on a refused change. */
export async function saveWorkflow(deps: WorkflowDeps, organizationId: string, input: any, actor: any, reason: string) {
  const state = await deps.load(organizationId)
  if (!state.data) throw Object.assign(new Error('This account has no saved workspace yet.'), { status: 409 })
  const items = Array.isArray(state.data.items) ? state.data.items : []
  const plan = planWorkflowUpdate(state.data.taskSettings || deps.defaults, items, input || {})
  if (!plan.ok) throw Object.assign(new Error(plan.error), { status: 400 })
  await deps.commit(
    organizationId,
    { ...state.data, items: plan.items, taskSettings: plan.taskSettings },
    actor,
    reason,
    state.data,
  )
  return { ok: true, taskSettings: plan.taskSettings, renamedTasks: plan.renamedTasks, movedTasks: plan.movedTasks }
}

/** Settings › Roles: the account's job roles. Built-in roles can be changed, not removed; a role in use stays. */
export function planJobRoles(state: any, input: unknown) {
  if (!Array.isArray(input) || input.length > MAX_JOB_ROLES)
    throw Object.assign(new Error(`Keep up to ${MAX_JOB_ROLES} roles.`), { status: 400 })
  const roles = input.map(cleanJobRole)
  if (roles.some(role => !role))
    throw Object.assign(new Error('Every role needs a short code and a name.'), { status: 400 })
  const ids = roles.map(role => role!.id)
  if (new Set(ids).size !== ids.length) throw Object.assign(new Error('Role codes must be unique.'), { status: 400 })
  const titles = roles.flatMap(role => role!.seedsTitles.map(title => title.toUpperCase()))
  if (new Set(titles).size !== titles.length)
    throw Object.assign(new Error('A Seeds title can belong to one role only.'), { status: 400 })
  const kept = new Set(ids)
  const used = new Set([
    ...(Array.isArray(state?.accounts) ? state.accounts : []).flatMap((account: any) =>
      Array.isArray(account?.jobRoles) ? account.jobRoles : [],
    ),
    ...workspaceAccess(state).assignments.map(assignment => assignment.role),
  ])
  for (const role of jobRoles(state)) {
    if (kept.has(role.id)) continue
    if (role.builtIn)
      throw Object.assign(new Error(`${role.name} is built in; change it instead of removing it.`), { status: 400 })
    if (used.has(role.id))
      throw Object.assign(new Error(`${role.name} is still given to people. Take it off them first.`), { status: 400 })
  }
  return { ...state, jobRoles: roles }
}

export function registerWorkflowRoutes(app: Express, deps: WorkflowDeps) {
  const auth = [deps.requireAuth, deps.requireTenant]
  const administrator = (req: Request) => {
    const user = (req as any).authUser
    if (user?.role !== 'Administrator' || !user.modules?.includes('settings'))
      throw Object.assign(new Error('Administrator access with Settings is required.'), { status: 403 })
    return user
  }
  const wrap =
    (handler: (req: Request, res: Response) => Promise<unknown>): Middleware =>
    async (req, res) => {
      res.setHeader('Cache-Control', 'no-store')
      try {
        await handler(req, res)
      } catch (error: any) {
        const status = Number(error?.status) || 0
        if (!status) console.error('Workflow request failed:', error)
        res
          .status(status || 503)
          .json({ error: status ? error.message : 'Workflow settings are unavailable. Try again shortly.' })
      }
    }
  app.get(
    '/api/account/workflow',
    ...auth,
    wrap(async (req, res) => {
      const user = administrator(req)
      res.json(workflowView((await deps.load(user.organizationId)).data, deps.defaults))
    }),
  )
  app.get(
    '/api/account/roles',
    ...auth,
    wrap(async (req, res) => {
      const user = administrator(req)
      res.json({ roles: jobRoles((await deps.load(user.organizationId)).data) })
    }),
  )
  app.put(
    '/api/account/roles',
    ...auth,
    wrap(async (req, res) => {
      const user = administrator(req)
      const state = await deps.load(user.organizationId)
      if (!state.data) throw Object.assign(new Error('This account has no saved workspace yet.'), { status: 409 })
      const next = planJobRoles(state.data, req.body?.roles)
      await deps.commit(user.organizationId, next, user, 'account-roles', state.data)
      res.json({ ok: true, roles: jobRoles(next) })
    }),
  )
  app.put(
    '/api/account/workflow',
    ...auth,
    wrap(async (req, res) => {
      const user = administrator(req)
      res.json(await saveWorkflow(deps, user.organizationId, req.body, user, 'account-workflow'))
    }),
  )
}
