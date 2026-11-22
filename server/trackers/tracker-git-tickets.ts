/**
 * GIT Tracker, part 3: adding a GitLab or GitHub ticket from Work Hub to a GIT Tracker, and making its rows, Tasks and
 * Subtasks with the tracker's GIT template (gitGeneration.ts).
 *
 * - A person adds one of their own Work Hub tickets. Its repository must be mapped (Settings › Integrations); the work
 *   goes under the mapped Client and Project, which the entry keeps even if the mapping changes later.
 * - A ticket is in a GIT Tracker at most once (a unique index), so repeated clicks add it once.
 * - Generation is safe to repeat: every row and Task has a stable id under the entry (git-tracker-ids.ts), and each
 *   step makes only what is missing. A failed entry keeps its error and can be retried.
 * - Removing a ticket deletes the rows it made. Its Tasks stay: time may have been logged on them.
 * - People who don't see a ticket's client don't see its entry, or its rows (see tracker-row-routes.ts).
 * - Its rows follow the ticket (gitFollow.ts): columns named after a ticket field or a label group fill themselves,
 *   and `refresh` updates them when GitLab or GitHub is synced (sign-in, Sync in Work Hub, Refresh in the GIT
 *   Tracker). Cells a person changed by hand are pinned and left alone. Following needs schema v45; without it new
 *   rows still fill, and refresh quietly does nothing.
 */
import { randomUUID } from 'node:crypto'
import type { Express } from 'express'
import {
  addPins,
  cleanPins,
  followedCells,
  followedValues,
  refreshPatch,
  removePins,
} from '../../src/features/trackers/gitFollow'
import { normalizeGitGeneration, planGitGeneration } from '../../src/features/trackers/gitGeneration'
import { TRACKER_LIMITS, TrackerError } from '../../src/features/trackers/trackerModel'
import { tasksFromDrafts } from '../../src/features/trackers/trackerTaskDrafts'
import { canSeeClient, scopeFor } from '../../src/shared/access'
import { asList as list } from '../../src/shared/lists'
import { mappingTargetError } from '../integrations/git-mapping-rules'
import { dateKeyInTimeZone } from '../services/follow-up-rollover'
import { canCreateWork } from '../services/visibility'
import {
  canGenerate,
  entryIdOfSourceKey,
  entryOut,
  failureText,
  type GitProvider,
  type GitTicketEntry,
  GITHUB_INSTANCE,
  gitSourceKey,
  issueIds,
  issueKey,
  mappingForTicket,
  missingWork,
  newestIssues,
  plannedIds,
  ticketSnapshot,
} from './git-ticket-plan'
import type { Deps, User } from './tracker-common'
import { UUID } from './tracker-common'
import type { TrackerCore } from './tracker-core'
import { gitEntryIds } from './git-tracker-ids'
import { GIT_UPGRADE } from './tracker-templates'

const ENTRIES = 'tenant_git_tracker_tickets'
const WORK = 'tenant_git_ticket_tasks'
const issueTable = (provider: GitProvider) => (provider === 'gitlab' ? 'user_gitlab_issues' : 'user_github_issues')
const missingSchema = (error: any) => error?.code === '42P01' || error?.code === '42703'
const FOLLOW_UPGRADE =
  'Following GitLab needs database schema v45. Run database/migrations/schema-v45-git-follow.sql, then try again.'
/** The most ticket entries one refresh compares, and Work Hub tickets read per query. */
const REFRESH_MAX = 500
const READ_CHUNK = 200

export type GitRefreshResult = {
  /** Ticket entries compared with their ticket. */
  tickets: number
  rows: number
  cells: number
  /** GIT Trackers with a changed row. */
  trackers: number
  /** The database needs schema v45 before rows can follow their tickets. */
  needsUpgrade?: boolean
}

export function trackerGitTickets(deps: Deps, core: TrackerCore, timeZone: string) {
  const { db, scope, route, who, idParam, trackerRow, workspace, columnsOf, mergeCells, record, touch, readOnly, shown } =
    core
  const nowMs = () => (deps.now ? deps.now() : new Date()).getTime()
  const stamp = () => new Date(nowMs()).toISOString()

  /** Storage errors: a database without schema v42 says which update to run. */
  const check = (error: any) => {
    if (!error) return
    if (missingSchema(error)) throw new TrackerError(GIT_UPGRADE, 503, { needsUpgrade: true })
    throw new TrackerError('GIT Tracker storage is unavailable right now. Try again in a moment.', 503)
  }
  const provider = (value: unknown): GitProvider => {
    if (value === 'gitlab' || value === 'github') return value
    throw new TrackerError('Choose GitLab or GitHub.')
  }

  /** One of the person's own Work Hub tickets. */
  async function ownTicket(user: User, from: GitProvider, ticketId: unknown) {
    const id = String(ticketId || '')
    if (!UUID.test(id)) throw new TrackerError('That ticket was not found in your Work Hub.', 404)
    const r = await db
      .from(issueTable(from))
      .select('*')
      .eq('tenant_id', user.organizationId)
      .eq('owner_user_id', user.id)
      .eq('id', id)
      .maybeSingle()
    check(r.error)
    if (!r.data) throw new TrackerError('That ticket was not found in your Work Hub. Sync it and try again.', 404)
    return r.data
  }
  const instanceOf = (from: GitProvider, issue: any) =>
    from === 'gitlab' ? String(issue.instance_url || 'https://gitlab.com') : GITHUB_INSTANCE

  async function mappingFor(tenant: string, from: GitProvider, issue: any) {
    const r = await db
      .from('tenant_git_repository_mappings')
      .select('*')
      .eq('tenant_id', tenant)
      .eq('provider', from)
      .eq('is_active', true)
    check(r.error)
    const { repositoryId } = issueIds(from, issue)
    return mappingForTicket(r.data || [], {
      provider: from,
      instanceUrl: instanceOf(from, issue),
      repositoryId,
      repository: String(issue.repository || ''),
    })
  }

  async function oneEntry(tenant: string, trackerId: string, entryId: string) {
    if (!UUID.test(entryId)) throw new TrackerError('That ticket is not in this GIT Tracker.', 404)
    const r = await db
      .from(ENTRIES)
      .select('*')
      .eq('tenant_id', tenant)
      .eq('tracker_id', trackerId)
      .eq('id', entryId)
      .maybeSingle()
    check(r.error)
    if (!r.data) throw new TrackerError('That ticket is not in this GIT Tracker.', 404)
    return r.data
  }

  /** The ticket as it is now, from whoever in the workspace has it in Work Hub (the adder first). */
  async function currentIssue(tenant: string, entry: any) {
    const from = provider(entry.provider)
    let query = db
      .from(issueTable(from))
      .select('*')
      .eq('tenant_id', tenant)
      .eq(from === 'gitlab' ? 'gitlab_id' : 'github_id', entry.issue_id)
    if (from === 'gitlab') query = query.eq('instance_url', entry.instance_url)
    const r = await query.order('updated_at', { ascending: false }).limit(20)
    check(r.error)
    const rows = r.data || []
    return rows.find((row: any) => row.owner_user_id === entry.added_by) || rows[0] || null
  }

  async function workCount(tenant: string, entryIds: string[]) {
    if (!entryIds.length) return new Map<string, number>()
    const r = await db
      .from(WORK)
      .select('git_tracker_ticket_id')
      .eq('tenant_id', tenant)
      .in('git_tracker_ticket_id', entryIds)
    check(r.error)
    const counts = new Map<string, number>()
    for (const row of r.data || [])
      counts.set(row.git_tracker_ticket_id, (counts.get(row.git_tracker_ticket_id) || 0) + 1)
    return counts
  }

  /**
   * Makes what the entry's ticket asks for and is still missing: Tasks and Subtasks, then rows, then the links between
   * them. Never throws: a failure is saved on the entry, for the person to read and retry.
   */
  async function generate(tenant: string, tracker: any, entryRow: any, user: User): Promise<GitTicketEntry> {
    const entry = entryOut(entryRow)
    if (!canGenerate(entry, nowMs()))
      throw new TrackerError(
        entry.status === 'Completed'
          ? 'This ticket’s rows and Tasks are already made.'
          : 'This ticket is being added right now. Wait a moment, then reload.',
        409,
      )
    // Claim it: only one attempt runs at a time (the update matches only the version that was read).
    const claimed = await db
      .from(ENTRIES)
      .update({ generation_status: 'Processing', attempts: entry.attempts + 1, updated_at: stamp() })
      .eq('tenant_id', tenant)
      .eq('id', entry.id)
      .eq('generation_status', entryRow.generation_status)
      .eq('attempts', entry.attempts)
      .select('*')
    check(claimed.error)
    if (!claimed.data?.length)
      throw new TrackerError('This ticket is being added right now. Wait a moment, then reload.', 409)

    const finish = async (status: 'Completed' | 'Failed', error = '') => {
      const saved = await db
        .from(ENTRIES)
        .update({ generation_status: status, generation_error: error, updated_at: stamp() })
        .eq('tenant_id', tenant)
        .eq('id', entry.id)
        .select('*')
      return entryOut(saved.data?.[0] || { ...claimed.data[0], generation_status: status, generation_error: error })
    }

    try {
      const issue = await currentIssue(tenant, entryRow)
      if (!issue)
        throw new Error(
          'The ticket can no longer be read from Work Hub. Sync GitLab or GitHub in Work Hub, then retry.',
        )
      const ticket = ticketSnapshot(entry.provider, issue)
      const columns = columnsOf(tracker)
      const state = await workspace(tenant)
      const accounts = list(state.accounts)
      const adder = accounts.find(
        (account: any) =>
          String(account.id) === entry.addedBy &&
          account.status !== 'Disabled' &&
          ['Administrator', 'Contributor'].includes(account.role),
      )
      const plan = planGitGeneration({
        generation: tracker.git_config || {},
        columns,
        ticket,
        clientId: entry.clientId,
        projectId: entry.projectId,
        assigneeId: adder ? String(adder.id) : '',
        idFor: gitEntryIds(entry.id),
      })
      if (plan.errors.length) throw new Error(plan.errors.join(' '))
      const targetError = mappingTargetError(state, entry.clientId, entry.projectId)
      if (plan.work.length && targetError) throw new Error(`The ticket’s Client and Project: ${targetError}`)

      // 1. Tasks and Subtasks, with their planned ids, so a retry finds the ones an earlier attempt made.
      if (plan.work.length) {
        if (!deps.commit) throw new Error('Tasks cannot be made here.')
        for (let attempt = 0; attempt < 2; attempt++) {
          const current = await deps.load(tenant)
          const data = current.data || {}
          const items = list(data.items)
          const { drafts, ids } = missingWork(plan, new Set(items.map((item: any) => String(item.id))))
          if (!drafts.length) break
          const { projects, made, activity } = tasksFromDrafts(
            {
              clients: list(data.clients),
              projects: list(data.projects),
              items,
              accounts: list(data.accounts),
              taskSettings: { ...data.taskSettings, statuses: list(data.taskSettings?.statuses) },
            },
            drafts,
            { today: dateKeyInTimeZone(new Date(nowMs()), timeZone), newId: plannedIds(ids, randomUUID) },
          )
          try {
            await deps.commit(
              tenant,
              { ...data, projects, items: [...made, ...items], activity: [...activity, ...list(data.activity)] },
              user,
              'git-tracker',
              data,
            )
            break
          } catch (error) {
            // Someone saved at the same moment: read again and try once more.
            if (attempt === 1) throw error
          }
        }
      }

      // 2. Rows, each linked to its own Task or Subtask.
      const rowIds = plan.rows.map(row => row.id)
      if (rowIds.length) {
        const have = await db
          .from('tenant_tracker_rows')
          .select('id')
          .eq('tenant_id', tenant)
          .eq('tracker_id', tracker.id)
          .in('id', rowIds)
        check(have.error)
        const known = new Set((have.data || []).map((row: any) => row.id))
        const missing = plan.rows.filter(row => !known.has(row.id))
        if (missing.length) {
          const count = await db
            .from('tenant_tracker_rows')
            .select('id', { count: 'exact', head: true })
            .eq('tenant_id', tenant)
            .eq('tracker_id', tracker.id)
          check(count.error)
          if (Number(count.count || 0) + missing.length > TRACKER_LIMITS.rows)
            throw new Error(`This GIT Tracker is full: a tracker can have at most ${TRACKER_LIMITS.rows} rows.`)
          const last = await db
            .from('tenant_tracker_rows')
            .select('position')
            .eq('tenant_id', tenant)
            .eq('tracker_id', tracker.id)
            .order('position', { ascending: false })
            .limit(1)
          check(last.error)
          let position = Number(last.data?.[0]?.position ?? 0)
          const at = stamp()
          const taskOfRow = new Map(
            plan.work.filter(work => work.ruleKey === `row:${work.rowKey}`).map(work => [work.rowKey, work.id]),
          )
          // Columns named after a ticket field or a label group fill themselves; the template row's own cells win.
          const blueprints = new Map(
            normalizeGitGeneration(tracker.git_config || {}, columns).generation.rows.map(row => [row.key, row]),
          )
          const startCells = (row: (typeof plan.rows)[number]) => ({
            ...followedValues(followedCells(columns, ticket, blueprints.get(row.key)).cells),
            ...row.cells,
          })
          const inserted = await db.from('tenant_tracker_rows').insert(
            missing.map(row => ({
              tenant_id: tenant,
              tracker_id: tracker.id,
              id: row.id,
              position: ++position,
              data: mergeCells({}, columns, startCells(row)),
              secrets: {},
              task_id: taskOfRow.get(row.key) || '',
              version: 1,
              created_by: user.id,
              updated_by: user.id,
              created_at: at,
              updated_at: at,
              source_key: gitSourceKey(entry.id),
            })),
          )
          check(inserted.error)
        }
      }

      // 3. Column rules' Subtasks sit in a cell of their row.
      const cellWork = plan.work.filter(work => work.columnId)
      if (cellWork.length) {
        const have = await db
          .from('tenant_tracker_task_links')
          .select('row_id,column_id,task_id')
          .eq('tenant_id', tenant)
          .eq('tracker_id', tracker.id)
          .in('row_id', [...new Set(cellWork.map(work => work.rowId))])
        check(have.error)
        const taken = new Set((have.data || []).map((link: any) => `${link.row_id}|${link.column_id}|${link.task_id}`))
        const links = cellWork
          .filter(work => !taken.has(`${work.rowId}|${work.columnId}|${work.id}`))
          .map(work => ({
            id: randomUUID(),
            tenant_id: tenant,
            tracker_id: tracker.id,
            row_id: work.rowId,
            column_id: work.columnId,
            task_id: work.id,
            created_by: user.id,
            created_by_name: user.name,
            created_at: stamp(),
          }))
        if (links.length) check((await db.from('tenant_tracker_task_links').insert(links)).error)
      }

      // 4. What each rule made, once per rule.
      if (plan.work.length) {
        const have = await db
          .from(WORK)
          .select('rule_key')
          .eq('tenant_id', tenant)
          .eq('git_tracker_ticket_id', entry.id)
        check(have.error)
        const done = new Set((have.data || []).map((row: any) => row.rule_key))
        const records = plan.work
          .filter(work => !done.has(work.ruleKey))
          .map(work => ({
            tenant_id: tenant,
            git_tracker_ticket_id: entry.id,
            tracker_row_id: work.rowId,
            rule_key: work.ruleKey,
            task_id: work.id,
            parent_task_id: work.parentId,
            work_type: work.type,
            template_id: tracker.git_template_id || null,
          }))
        if (records.length) check((await db.from(WORK).insert(records)).error)
      }

      await record(tenant, tracker.id, plan.rows[0]?.id || '', user, 'git_ticket_added', {
        ticket: `#${ticket.number} ${ticket.title}`.trim(),
        repository: ticket.repository,
        rows: plan.rows.length,
        tasks: plan.work.length,
        skipped: plan.skipped.map(item => item.reason),
      })
      await touch(tenant, tracker.id)
      return await finish('Completed')
    } catch (error) {
      const message = error instanceof TrackerError ? error.message : failureText(error)
      return await finish('Failed', message)
    }
  }

  /**
   * Brings ticket rows up to date with their tickets, as Work Hub last read them: every followed cell (gitFollow.ts)
   * that differs, except pinned ones. Only entries that are Completed and follow their ticket. Same-moment calls for
   * the same scope share one run (several people signing in at once).
   */
  const running = new Map<string, Promise<GitRefreshResult>>()
  function refresh(
    tenant: string,
    user: User,
    only: { trackerId?: string; entryId?: string; provider?: GitProvider } = {},
  ): Promise<GitRefreshResult> {
    const key = [tenant, only.trackerId || '', only.entryId || '', only.provider || ''].join('|')
    const held = running.get(key)
    if (held) return held
    const job = refreshNow(tenant, user, only).finally(() => running.delete(key))
    running.set(key, job)
    return job
  }

  async function refreshNow(
    tenant: string,
    user: User,
    only: { trackerId?: string; entryId?: string; provider?: GitProvider },
  ): Promise<GitRefreshResult> {
    const result: GitRefreshResult = { tickets: 0, rows: 0, cells: 0, trackers: 0 }
    let trackersQuery = db.from('tenant_trackers').select('*').eq('tenant_id', tenant).eq('kind', 'git')
    if (only.trackerId) trackersQuery = trackersQuery.eq('id', only.trackerId)
    const trackers = await trackersQuery
    check(trackers.error)
    const open = (trackers.data || []).filter((row: any) => !row.archived_at)
    if (!open.length) return result
    let entriesQuery = db
      .from(ENTRIES)
      .select('*')
      .eq('tenant_id', tenant)
      .eq('generation_status', 'Completed')
      .eq('follows_ticket', true)
      .in(
        'tracker_id',
        open.map((row: any) => row.id),
      )
    if (only.entryId) entriesQuery = entriesQuery.eq('id', only.entryId)
    if (only.provider) entriesQuery = entriesQuery.eq('provider', only.provider)
    const entries = await entriesQuery.order('created_at', { ascending: false }).limit(REFRESH_MAX)
    if (entries.error) {
      if (missingSchema(entries.error)) return { ...result, needsUpgrade: true }
      check(entries.error)
    }
    const all = entries.data || []
    if (!all.length) return result

    // Each ticket as Work Hub has it now: one read per provider and chunk, the freshest copy of each.
    const issues = new Map<string, any>()
    for (const from of ['gitlab', 'github'] as GitProvider[]) {
      const ids = [...new Set(all.filter((row: any) => row.provider === from).map((row: any) => Number(row.issue_id)))]
      for (let at = 0; at < ids.length; at += READ_CHUNK) {
        const r = await db
          .from(issueTable(from))
          .select('*')
          .eq('tenant_id', tenant)
          .in(from === 'gitlab' ? 'gitlab_id' : 'github_id', ids.slice(at, at + READ_CHUNK))
        check(r.error)
        for (const [key, row] of newestIssues(from, r.data || [])) issues.set(key, row)
      }
    }

    for (const tracker of open) {
      const mine = all.filter((row: any) => row.tracker_id === tracker.id)
      if (!mine.length) continue
      const columns = columnsOf(tracker)
      const byId = new Map(columns.map(column => [column.id, column]))
      const blueprints = normalizeGitGeneration(tracker.git_config || {}, columns).generation.rows
      const rows = await db
        .from('tenant_tracker_rows')
        .select('id,data,version,source_key')
        .eq('tenant_id', tenant)
        .eq('tracker_id', tracker.id)
        .in(
          'source_key',
          mine.map((row: any) => gitSourceKey(row.id)),
        )
      check(rows.error)
      let changedHere = false
      for (const entry of mine) {
        const issue = issues.get(issueKey(entry.provider, entry.instance_url, entry.issue_id))
        if (!issue) continue
        const ticket = ticketSnapshot(entry.provider, issue)
        const idFor = gitEntryIds(entry.id)
        const blueprintOf = new Map(blueprints.map(row => [idFor('row', row.key), row]))
        const pins = cleanPins(entry.pinned_cells)
        for (const row of (rows.data || []).filter((item: any) => item.source_key === gitSourceKey(entry.id))) {
          const followed = followedCells(columns, ticket, blueprintOf.get(row.id)).cells
          const patch = refreshPatch(row.data || {}, followed, pins[row.id] || [])
          if (!patch.changed.length) continue
          const version = Number(row.version || 1)
          const saved = await db
            .from('tenant_tracker_rows')
            .update({
              data: mergeCells(row.data || {}, columns, patch.cells),
              version: version + 1,
              updated_by: user.id,
              updated_at: stamp(),
            })
            .eq('tenant_id', tenant)
            .eq('tracker_id', tracker.id)
            .eq('id', row.id)
            .eq('version', version)
            .select('id')
          // Someone saved the row at the same moment: leave it; the next refresh compares again.
          if (saved.error || !saved.data?.length) continue
          result.rows++
          result.cells += patch.changed.length
          changedHere = true
          await record(tenant, tracker.id, row.id, user, 'git_follow', {
            provider: entry.provider,
            ticket: `#${ticket.number}`,
            cells: patch.changed.map(columnId => ({
              columnId,
              name: byId.get(columnId)?.name || '',
              from: shown(byId.get(columnId)!, row.data?.[columnId]),
              to: shown(byId.get(columnId)!, patch.cells[columnId]),
            })),
          })
        }
        await db
          .from(ENTRIES)
          .update({
            refreshed_at: stamp(),
            title_snapshot: ticket.title.slice(0, 300) || entry.title_snapshot,
            ...(ticket.url ? { issue_url: ticket.url } : {}),
          })
          .eq('tenant_id', tenant)
          .eq('id', entry.id)
        result.tickets++
      }
      if (changedHere) {
        result.trackers++
        await touch(tenant, tracker.id)
      }
    }
    return result
  }

  /**
   * A person changed cells of a ticket row by hand: they are pinned, so a refresh leaves them as the person set them.
   * Best effort: without schema v45 there is nothing to pin.
   */
  async function pinCells(tenant: string, trackerId: string, row: { id: string; source_key?: string }, columnIds: string[]) {
    const entryId = entryIdOfSourceKey(row.source_key)
    if (!entryId || !columnIds.length) return
    const r = await db
      .from(ENTRIES)
      .select('id,pinned_cells')
      .eq('tenant_id', tenant)
      .eq('tracker_id', trackerId)
      .eq('id', entryId)
      .maybeSingle()
    if (r.error || !r.data) return
    await db
      .from(ENTRIES)
      .update({ pinned_cells: addPins(r.data.pinned_cells, row.id, columnIds) })
      .eq('tenant_id', tenant)
      .eq('id', entryId)
  }

  /** Entries the person may see: those of clients they see (everyone sees all with per-person visibility off). */
  async function visibleEntries(tenant: string, user: User, rows: any[]) {
    const access = scopeFor(await workspace(tenant), user.id)
    return access.all ? rows : rows.filter(row => canSeeClient(access, String(row.client_id)))
  }

  const editable = (user: User, tracker: any) => {
    if (readOnly(user)) throw new TrackerError('Your role can view trackers but not change them.', 403)
    if (tracker.kind !== 'git') throw new TrackerError('Tickets are added to GIT Trackers only.', 409)
    if (tracker.archived_at) throw new TrackerError('This GIT Tracker is archived. Restore it to add tickets.', 409)
  }

  function routes(app: Express) {
    // For the Work Hub ticket panel: the GIT Trackers to add it to, the ones it is in, and where its work would go.
    app.get(
      '/api/tracker-git/tickets/:provider/:ticketId',
      ...scope,
      route(async (req, res) => {
        const user = who(req),
          tenant = user.organizationId,
          from = provider(req.params.provider)
        const issue = await ownTicket(user, from, req.params.ticketId)
        const trackers = await db
          .from('tenant_trackers')
          .select('id,name,kind,private,created_by,archived_at')
          .eq('tenant_id', tenant)
          .eq('kind', 'git')
        check(trackers.error)
        const open = (trackers.data || []).filter(
          (row: any) => !row.archived_at && (!row.private || row.created_by === user.id),
        )
        const names = new Map(open.map((row: any) => [row.id, row.name]))
        const { issueId } = issueIds(from, issue)
        let entries: GitTicketEntry[] = []
        if (issueId) {
          let query = db.from(ENTRIES).select('*').eq('tenant_id', tenant).eq('provider', from).eq('issue_id', issueId)
          query = query.eq('instance_url', instanceOf(from, issue))
          const r = await query
          check(r.error)
          const shown = (await visibleEntries(tenant, user, r.data || [])).filter((row: any) =>
            names.has(row.tracker_id),
          )
          const counts = await workCount(
            tenant,
            shown.map((row: any) => row.id),
          )
          entries = shown.map((row: any) => ({
            ...entryOut(row),
            trackerName: String(names.get(row.tracker_id) || ''),
            workCount: counts.get(row.id) || 0,
          }))
        }
        const mapping = await mappingFor(tenant, from, issue)
        res.json({
          trackers: open
            .map((row: any) => ({ id: row.id, name: row.name }))
            .sort((a: any, b: any) => a.name.localeCompare(b.name)),
          entries,
          mapping: mapping ? { clientId: mapping.client_id, projectId: mapping.project_id } : null,
          repository: String(issue.repository || ''),
          canAdd: !readOnly(user),
        })
      }),
    )

    // Add a ticket to a GIT Tracker, and make its rows and Tasks.
    app.post(
      '/api/trackers/:id/git-tickets',
      ...scope,
      route(async (req, res) => {
        const user = who(req),
          tenant = user.organizationId,
          id = idParam(req)
        const tracker = await trackerRow(tenant, id, user)
        editable(user, tracker)
        const from = provider(req.body?.provider)
        const issue = await ownTicket(user, from, req.body?.ticketId)
        const { issueId, repositoryId } = issueIds(from, issue)
        if (!issueId) throw new TrackerError('That ticket could not be read. Sync it in Work Hub and try again.')
        const mapping = await mappingFor(tenant, from, issue)
        if (!mapping)
          throw new TrackerError(
            `${issue.repository} is not mapped to a Client and Project yet. An Administrator maps it in Settings › Integrations › Repository mapping.`,
            409,
          )
        const state = await workspace(tenant)
        const targetError = mappingTargetError(state, mapping.client_id, mapping.project_id)
        if (targetError) throw new TrackerError(`The repository’s mapping: ${targetError}`, 409)
        if (!canCreateWork(state, user, { clientId: mapping.client_id, projectId: mapping.project_id }))
          throw new TrackerError('You can’t add work for that repository’s client or project.', 403)
        const at = stamp()
        const row = {
          id: randomUUID(),
          tenant_id: tenant,
          tracker_id: id,
          provider: from,
          instance_url: instanceOf(from, issue),
          repository_id: repositoryId || Number(mapping.repository_id),
          repository_path: String(issue.repository || mapping.repository_path),
          issue_id: issueId,
          issue_number: Number(issue.number) || 1,
          issue_url: String(issue.html_url || ''),
          title_snapshot: String(issue.title || '').slice(0, 300),
          client_id: mapping.client_id,
          project_id: mapping.project_id,
          mapping_id: mapping.id,
          template_id: tracker.git_template_id || null,
          template_revision: tracker.git_template_revision || null,
          generation_status: 'Pending',
          generation_error: '',
          attempts: 0,
          added_by: user.id,
          added_by_name: user.name,
          created_at: at,
          updated_at: at,
        }
        const saved = await db.from(ENTRIES).insert(row)
        if (saved.error?.code === '23505')
          throw new TrackerError('This ticket is already in that GIT Tracker.', 409, { already: true })
        check(saved.error)
        const entry = await generate(tenant, tracker, row, user)
        res.status(201).json({ entry: { ...entry, trackerName: tracker.name } })
      }),
    )

    // Try a failed ticket again: only what is still missing is made.
    app.post(
      '/api/trackers/:id/git-tickets/:entryId/retry',
      ...scope,
      route(async (req, res) => {
        const user = who(req),
          tenant = user.organizationId,
          id = idParam(req)
        const tracker = await trackerRow(tenant, id, user)
        editable(user, tracker)
        const row = await oneEntry(tenant, id, String(req.params.entryId))
        if (!(await visibleEntries(tenant, user, [row])).length)
          throw new TrackerError('That ticket is not in this GIT Tracker.', 404)
        const entry = await generate(tenant, tracker, row, user)
        res.json({ entry: { ...entry, trackerName: tracker.name } })
      }),
    )

    // Bring ticket rows up to date with their tickets: after sign-in and after a GitLab or GitHub sync in Work Hub.
    // It writes only what the tickets say, and answers with counts, so anyone who uses Trackers may start it.
    app.post(
      '/api/tracker-git/refresh',
      ...scope,
      route(async (req, res) => {
        const user = who(req)
        const from = req.body?.provider
        res.json(
          await refresh(user.organizationId, user, from === 'gitlab' || from === 'github' ? { provider: from } : {}),
        )
      }),
    )

    // Refresh in a GIT Tracker: its ticket rows only.
    app.post(
      '/api/trackers/:id/git-tickets/refresh',
      ...scope,
      route(async (req, res) => {
        const user = who(req),
          tenant = user.organizationId,
          id = idParam(req)
        const tracker = await trackerRow(tenant, id, user)
        if (tracker.kind !== 'git') throw new TrackerError('Only GIT Trackers follow tickets.', 409)
        res.json(await refresh(tenant, user, { trackerId: id }))
      }),
    )

    // Follow the ticket or stop, and release pinned cells (then the ticket's values come back right away).
    app.patch(
      '/api/trackers/:id/git-tickets/:entryId',
      ...scope,
      route(async (req, res) => {
        const user = who(req),
          tenant = user.organizationId,
          id = idParam(req)
        const tracker = await trackerRow(tenant, id, user)
        editable(user, tracker)
        const row = await oneEntry(tenant, id, String(req.params.entryId))
        if (!(await visibleEntries(tenant, user, [row])).length)
          throw new TrackerError('That ticket is not in this GIT Tracker.', 404)
        const body = req.body || {}
        const patch: Record<string, unknown> = {}
        if (body.follows !== undefined) {
          if (typeof body.follows !== 'boolean') throw new TrackerError('Choose whether the rows follow the ticket.')
          patch.follows_ticket = body.follows
        }
        if (body.unpin !== undefined) {
          const unpin =
            body.unpin === 'all'
              ? 'all'
              : Array.isArray(body.unpin)
                ? body.unpin.filter((value: unknown): value is string => typeof value === 'string').slice(0, 100)
                : null
          if (!unpin) throw new TrackerError('Choose the cells to release.')
          patch.pinned_cells = removePins(cleanPins(row.pinned_cells), unpin)
        }
        if (!Object.keys(patch).length) throw new TrackerError('Nothing to change.')
        const saved = await db
          .from(ENTRIES)
          .update({ ...patch, updated_at: stamp() })
          .eq('tenant_id', tenant)
          .eq('id', row.id)
          .select('*')
        if (saved.error && missingSchema(saved.error)) throw new TrackerError(FOLLOW_UPGRADE, 503, { needsUpgrade: true })
        check(saved.error)
        const next = saved.data?.[0] || { ...row, ...patch }
        const refreshed = next.follows_ticket !== false ? await refresh(tenant, user, { entryId: row.id }) : null
        const after = refreshed?.rows ? await oneEntry(tenant, id, row.id) : next
        res.json({ entry: { ...entryOut(after), trackerName: tracker.name }, refreshed })
      }),
    )

    // A GIT Tracker's tickets, with the rows each made, for its ticket list and the Client filter.
    app.get(
      '/api/trackers/:id/git-tickets',
      ...scope,
      route(async (req, res) => {
        const user = who(req),
          tenant = user.organizationId,
          id = idParam(req)
        const tracker = await trackerRow(tenant, id, user)
        if (tracker.kind !== 'git') return void res.json({ entries: [] })
        const r = await db
          .from(ENTRIES)
          .select('*')
          .eq('tenant_id', tenant)
          .eq('tracker_id', id)
          .order('created_at', { ascending: false })
        check(r.error)
        const shown = await visibleEntries(tenant, user, r.data || [])
        const rows = await db
          .from('tenant_tracker_rows')
          .select('id,source_key')
          .eq('tenant_id', tenant)
          .eq('tracker_id', id)
          .like('source_key', 'git:%')
        check(rows.error)
        const byEntry = new Map<string, string[]>()
        for (const row of rows.data || []) {
          const key = String(row.source_key)
          byEntry.set(key, [...(byEntry.get(key) || []), row.id])
        }
        const counts = await workCount(
          tenant,
          shown.map((row: any) => row.id),
        )
        res.json({
          entries: shown.map((row: any) => ({
            ...entryOut(row),
            rowIds: byEntry.get(gitSourceKey(row.id)) || [],
            workCount: counts.get(row.id) || 0,
          })),
        })
      }),
    )

    // Take a ticket out: its rows go; its Tasks stay in Tasks.
    app.delete(
      '/api/trackers/:id/git-tickets/:entryId',
      ...scope,
      route(async (req, res) => {
        const user = who(req),
          tenant = user.organizationId,
          id = idParam(req)
        const tracker = await trackerRow(tenant, id, user)
        if (readOnly(user)) throw new TrackerError('Your role can view trackers but not change them.', 403)
        if (tracker.archived_at) throw new TrackerError('This GIT Tracker is archived. Restore it first.', 409)
        const row = await oneEntry(tenant, id, String(req.params.entryId))
        if (!(await visibleEntries(tenant, user, [row])).length)
          throw new TrackerError('That ticket is not in this GIT Tracker.', 404)
        if (!canGenerate(entryOut(row), nowMs()) && row.generation_status === 'Processing')
          throw new TrackerError('This ticket is being added right now. Wait a moment, then try again.', 409)
        const rows = await db
          .from('tenant_tracker_rows')
          .select('id')
          .eq('tenant_id', tenant)
          .eq('tracker_id', id)
          .eq('source_key', gitSourceKey(row.id))
        check(rows.error)
        const rowIds = (rows.data || []).map((item: any) => item.id)
        if (rowIds.length) {
          check(
            (
              await db
                .from('tenant_tracker_task_links')
                .delete()
                .eq('tenant_id', tenant)
                .eq('tracker_id', id)
                .in('row_id', rowIds)
            ).error,
          )
          check(
            (
              await db
                .from('tenant_tracker_rows')
                .delete()
                .eq('tenant_id', tenant)
                .eq('tracker_id', id)
                .in('id', rowIds)
            ).error,
          )
        }
        check((await db.from(ENTRIES).delete().eq('tenant_id', tenant).eq('id', row.id)).error)
        await record(tenant, id, '', user, 'git_ticket_removed', {
          ticket: `#${row.issue_number} ${row.title_snapshot}`.trim(),
          rows: rowIds.length,
        })
        await touch(tenant, id)
        res.json({ removed: true, rows: rowIds.length })
      }),
    )
  }

  /**
   * Source keys of the ticket entries this person may not see, for the rows list: a GIT Tracker shows everyone, but
   * each ticket's rows only to people who see its client. Empty when they see every client.
   */
  async function hiddenSourceKeys(tenant: string, trackerId: string, user: User) {
    const access = scopeFor(await workspace(tenant), user.id)
    if (access.all) return new Set<string>()
    const r = await db.from(ENTRIES).select('id,client_id').eq('tenant_id', tenant).eq('tracker_id', trackerId)
    if (r.error) {
      if (missingSchema(r.error)) return new Set<string>()
      check(r.error)
    }
    return new Set(
      (r.data || [])
        .filter((row: any) => !canSeeClient(access, String(row.client_id)))
        .map((row: any) => gitSourceKey(row.id)),
    )
  }

  return { routes, generate, hiddenSourceKeys, refresh, pinCells }
}

export type TrackerGitTickets = ReturnType<typeof trackerGitTickets>
