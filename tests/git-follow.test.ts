import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  addPins,
  cleanPins,
  followedCells,
  followedValues,
  headerField,
  labelGroupValue,
  labelParts,
  pinnedColumns,
  refreshPatch,
  removePins,
} from '../src/features/trackers/gitFollow'
import type { GitTicketSnapshot } from '../src/features/trackers/gitGeneration'
import { refreshText } from '../src/features/trackers/gitTicketsApi'
import type { TrackerColumn } from '../src/features/trackers/trackerModel'
import { gitEntryIds } from '../server/trackers/git-tracker-ids'
import { entryOut, gitSourceKey, newestIssues } from '../server/trackers/git-ticket-plan'
import { trackerGitTickets } from '../server/trackers/tracker-git-tickets'

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

const columns: TrackerColumn[] = [
  { id: 'c_stage', name: 'Stage', type: 'text' },
  { id: 'c_title', name: 'Title', type: 'text' },
  {
    id: 'c_priority',
    name: 'Priority',
    type: 'select',
    options: [
      { id: 'o_high', label: 'High' },
      { id: 'o_low', label: 'Low' },
    ],
  },
  { id: 'c_severity', name: 'Severity', type: 'text' },
  { id: 'c_due', name: 'Due date', type: 'date' },
  {
    id: 'c_state',
    name: 'Ticket state',
    type: 'select',
    options: [
      { id: 'o_open', label: 'Open' },
      { id: 'o_closed', label: 'Closed' },
    ],
  },
  { id: 'c_labels', name: 'Labels', type: 'longtext' },
  { id: 'c_owner', name: 'Assignee', type: 'person' },
  { id: 'c_notes', name: 'Notes', type: 'text' },
  { id: 'c_done', name: 'Done', type: 'checkbox' },
  { id: 'c_status', name: 'Status', type: 'text' },
] as TrackerColumn[]

const ticket: GitTicketSnapshot = {
  provider: 'gitlab',
  repository: 'team/app',
  number: 7,
  title: 'Login fails',
  body: 'Steps…',
  url: 'https://gitlab.example.com/team/app/-/issues/7',
  state: 'open',
  labels: ['bug', 'priority::high', 'Priority: low', 'severity::2 - major'],
  assignees: ['dev1'],
  author: 'qa',
  milestone: 'Sprint 4',
  dueDate: '2026-12-01',
}

test('a column named after a ticket field fills with it; other names are not guessed', () => {
  assert.equal(headerField('Title'), 'title')
  assert.equal(headerField(' Due  Date '), 'due')
  assert.equal(headerField('Ticket #'), 'number')
  assert.equal(headerField('due_date'), 'due')
  assert.equal(headerField('Assigned to'), 'assignees')
  assert.equal(headerField('Description'), 'body')
  assert.equal(headerField('Status'), null, 'a workflow Status is the team’s own, not the ticket’s state')
  assert.equal(headerField('Priority'), null)
})

test('a label group takes the first label of its name: priority::high, Priority: High, priority/high', () => {
  assert.deepEqual(labelParts('priority::high'), { group: 'priority', value: 'high' })
  assert.deepEqual(labelParts('Priority: High'), { group: 'priority', value: 'High' })
  assert.deepEqual(labelParts('team/backend'), { group: 'team', value: 'backend' })
  assert.equal(labelParts('bug'), null)
  assert.equal(labelGroupValue(columns[2], ticket.labels), 'high', 'two labels of the group: the first one')
  assert.equal(labelGroupValue(columns[3], ticket.labels), '2 - major')
  assert.equal(labelGroupValue(columns[8], ticket.labels), null)
})

test('followed cells: header names, label groups and the template row’s ticket fields; fixed values are not', () => {
  const blueprint = {
    cells: {
      c_stage: { from: 'fixed' as const, value: 'Ticket' },
      c_notes: { from: 'ticket' as const, field: 'milestone' as const },
    },
  }
  const { cells, notes } = followedCells(columns, ticket, blueprint)
  assert.deepEqual(followedValues(cells), {
    c_title: 'Login fails',
    c_priority: 'o_high',
    c_severity: '2 - major',
    c_due: '2026-12-01',
    c_state: 'o_open',
    c_labels: 'bug, priority::high, Priority: low, severity::2 - major',
    c_notes: 'Sprint 4',
  })
  assert.equal('c_stage' in cells, false, 'a fixed template value is set once, then the person’s')
  assert.equal('c_owner' in cells, false, 'Person columns are not filled')
  assert.equal('c_done' in cells, false)
  assert.equal('c_status' in cells, false)
  assert.deepEqual(notes, [])
  assert.deepEqual(cells.c_priority.source, { label: 'high' })
  assert.deepEqual(cells.c_title.source, { field: 'title' })

  // A label that is not one of the Choice column's options is reported and left alone.
  const urgent = followedCells(columns, { ...ticket, labels: ['priority::urgent'] })
  assert.equal('c_priority' in urgent.cells, false)
  assert.match(urgent.notes[0].text, /Priority: “urgent” is not one of its choices/)
  // No label of the group: the column is left alone (it may not be a label group at all).
  assert.equal('c_severity' in followedCells(columns, { ...ticket, labels: [] }).cells, false)
  // Columns another feature fills are never followed.
  const managed = followedCells([{ id: 'x', name: 'Title', type: 'text', taskField: 'title' } as TrackerColumn], ticket)
  assert.deepEqual(managed.cells, {})
})

test('a refresh changes what differs, never pinned cells; empty values count as the same', () => {
  const { cells } = followedCells(columns, ticket)
  const patch = refreshPatch(
    { c_title: 'Old title', c_priority: 'o_high', c_due: '2026-11-30', c_notes: 'mine' },
    cells,
    ['c_due'],
  )
  assert.deepEqual(patch.changed.sort(), ['c_labels', 'c_severity', 'c_state', 'c_title'])
  assert.equal(patch.cells.c_title, 'Login fails')
  assert.equal('c_due' in patch.cells, false, 'pinned')
  assert.equal('c_notes' in patch.cells, false, 'not followed')
  const cleared = followedCells(
    columns,
    { ...ticket, milestone: '' },
    { cells: { c_notes: { from: 'ticket', field: 'milestone' } } },
  )
  assert.deepEqual(
    refreshPatch({}, { c_notes: cleared.cells.c_notes }, []).changed,
    [],
    'empty and missing are the same',
  )
  assert.deepEqual(refreshPatch({ c_notes: 'Sprint 3' }, { c_notes: cleared.cells.c_notes }, []).cells, { c_notes: '' })
})

test('pins: added per row, released per column or all, malformed ones dropped', () => {
  let pins = addPins({}, 'r1', ['c_title'])
  pins = addPins(pins, 'r1', ['c_title', 'c_due'])
  pins = addPins(pins, 'r2', ['c_due'])
  assert.deepEqual(pins, { r1: ['c_title', 'c_due'], r2: ['c_due'] })
  assert.deepEqual(pinnedColumns(pins).sort(), ['c_due', 'c_title'])
  assert.deepEqual(removePins(pins, ['c_due']), { r1: ['c_title'] })
  assert.deepEqual(removePins(pins, 'all'), {})
  assert.deepEqual(cleanPins({ r1: 'x', r2: [1, 'c_a', 'c_a'], r3: [] }), { r2: ['c_a'] })
  assert.deepEqual(cleanPins(null), {})
})

test('entries say whether they follow and what is pinned; the freshest Work Hub copy of a ticket is used', () => {
  const entry = entryOut({ id: 'e', pinned_cells: { r1: ['c_title'] }, refreshed_at: '2026-11-22T08:00:00Z' })
  assert.equal(entry.follows, true, 'on unless turned off')
  assert.deepEqual(entry.pinnedColumns, ['c_title'])
  assert.equal(entryOut({ follows_ticket: false }).follows, false)
  const issues = newestIssues('gitlab', [
    { gitlab_id: '9', instance_url: 'https://g', title: 'old', updated_at: '2026-11-01' },
    { gitlab_id: '9', instance_url: 'https://g', title: 'new', updated_at: '2026-11-20' },
  ])
  assert.equal(issues.get('gitlab|https://g|9').title, 'new')
  assert.equal(refreshText({ tickets: 2, rows: 0, cells: 0, trackers: 0 }), '')
  assert.match(refreshText({ tickets: 2, rows: 1, cells: 3, trackers: 1 }), /Updated 3 cells in 1 row/)
  assert.match(refreshText({ tickets: 0, rows: 0, cells: 0, trackers: 0, needsUpgrade: true }), /schema v45/)
})

/** A tiny in-memory stand-in for the database client: enough of the query builder for refresh and pins. */
function fakeDb(tables: Record<string, any[]>, missingColumns: string[] = []) {
  return {
    from(table: string) {
      const filters: ((row: any) => boolean)[] = []
      let action: 'select' | 'update' = 'select'
      let patch: any = null
      let single = false
      let limit = Infinity
      let failure: any = null
      const builder: any = {
        select: () => builder,
        update: (value: any) => {
          action = 'update'
          patch = value
          if (Object.keys(value).some(key => missingColumns.includes(key))) failure = { code: '42703' }
          return builder
        },
        eq: (column: string, value: any) => {
          if (missingColumns.includes(column)) failure = { code: '42703' }
          filters.push(row => String(row[column]) === String(value))
          return builder
        },
        in: (column: string, values: any[]) => {
          filters.push(row => values.map(String).includes(String(row[column])))
          return builder
        },
        order: () => builder,
        limit: (count: number) => {
          limit = count
          return builder
        },
        maybeSingle: () => {
          single = true
          return builder
        },
        then(resolve: (value: any) => void) {
          if (failure) return resolve({ data: null, error: failure })
          if (!tables[table]) tables[table] = []
          const rows = tables[table].filter(row => filters.every(filter => filter(row))).slice(0, limit)
          if (action === 'update') for (const row of rows) Object.assign(row, structuredClone(patch))
          const data = rows.map(row => structuredClone(row))
          resolve({ data: single ? data[0] || null : data, error: null })
        },
      }
      return builder
    },
  }
}

const TENANT = 'org1'
const ENTRY = '6f0e2a4b-8c1d-4e3f-9a5b-7c6d5e4f3a21'
const OFF = '7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'
const generation = {
  version: 1,
  rows: [
    {
      key: 'ticket',
      name: 'Ticket',
      cells: { c_stage: { from: 'fixed', value: 'Ticket' } },
      when: [],
      work: 'task',
      task: { title: '{ticket.title}', description: '', due: { from: 'ticket' } },
    },
  ],
  columnRules: [],
}

function harness(missingColumns: string[] = []) {
  const rowId = gitEntryIds(ENTRY)('row', 'ticket')
  const offRow = gitEntryIds(OFF)('row', 'ticket')
  const tables: Record<string, any[]> = {
    tenant_trackers: [{ tenant_id: TENANT, id: 't1', kind: 'git', columns, git_config: generation, archived_at: null }],
    tenant_git_tracker_tickets: [
      {
        tenant_id: TENANT,
        id: ENTRY,
        tracker_id: 't1',
        provider: 'gitlab',
        instance_url: 'https://gitlab.example.com',
        issue_id: 901,
        issue_number: 7,
        title_snapshot: 'Login fails',
        generation_status: 'Completed',
        follows_ticket: true,
        pinned_cells: {},
      },
      {
        tenant_id: TENANT,
        id: OFF,
        tracker_id: 't1',
        provider: 'gitlab',
        instance_url: 'https://gitlab.example.com',
        issue_id: 902,
        issue_number: 8,
        generation_status: 'Completed',
        follows_ticket: false,
        pinned_cells: {},
      },
    ],
    tenant_tracker_rows: [
      {
        tenant_id: TENANT,
        tracker_id: 't1',
        id: rowId,
        source_key: gitSourceKey(ENTRY),
        data: { c_stage: 'Ticket', c_notes: 'mine' },
        version: 1,
      },
      { tenant_id: TENANT, tracker_id: 't1', id: offRow, source_key: gitSourceKey(OFF), data: {}, version: 1 },
    ],
    user_gitlab_issues: [
      {
        tenant_id: TENANT,
        owner_user_id: 'u2',
        gitlab_id: 901,
        instance_url: 'https://gitlab.example.com',
        number: 7,
        repository: 'team/app',
        title: 'Login fails',
        html_url: ticket.url,
        state: 'opened',
        labels: ['priority::high', 'severity::2 - major'],
        assignees: ['dev1'],
        due_date: '2026-12-01',
        updated_at: '2026-11-22T08:00:00Z',
      },
      {
        tenant_id: TENANT,
        gitlab_id: 902,
        instance_url: 'https://gitlab.example.com',
        number: 8,
        title: 'Other',
        labels: ['priority::low'],
        updated_at: '2026-11-22T08:00:00Z',
      },
    ],
  }
  const records: any[] = []
  const core: any = {
    db: fakeDb(tables, missingColumns),
    scope: [],
    route: (handler: any) => handler,
    who: () => user,
    columnsOf: (row: any) => row.columns,
    mergeCells: (data: any, _columns: any, cells: any) =>
      Object.fromEntries(
        Object.entries({ ...data, ...cells }).filter(
          ([, value]) => !(value === '' || value === null || (Array.isArray(value) && !value.length)),
        ),
      ),
    shown: (_column: any, value: any) => String(value ?? ''),
    record: async (...args: any[]) => void records.push(args),
    touch: async () => {},
    readOnly: () => false,
  }
  const git = trackerGitTickets({ now: () => new Date('2026-11-22T09:00:00Z') } as any, core, 'Asia/Manila')
  return { git, tables, records, rowId, offRow }
}
const user = { id: 'u1', name: 'Phillip', organizationId: TENANT } as any

test('refresh: ticket rows take the ticket’s values, pinned cells keep the person’s, unfollowed tickets stay', async () => {
  const { git, tables, records, rowId, offRow } = harness()
  const first = await git.refresh(TENANT, user)
  assert.deepEqual(first, { tickets: 1, rows: 1, cells: 6, trackers: 1 })
  const row = () => tables.tenant_tracker_rows.find(item => item.id === rowId)
  assert.deepEqual(row().data, {
    c_stage: 'Ticket',
    c_notes: 'mine',
    c_title: 'Login fails',
    c_priority: 'o_high',
    c_severity: '2 - major',
    c_due: '2026-12-01',
    c_state: 'o_open',
    c_labels: 'priority::high, severity::2 - major',
  })
  assert.equal(row().version, 2)
  assert.equal(records[0][4], 'git_follow')
  assert.equal(records[0][5].ticket, '#7')
  assert.deepEqual(tables.tenant_tracker_rows.find(item => item.id === offRow).data, {}, 'follows_ticket off')

  // Nothing changed in GitLab: nothing is written.
  assert.deepEqual(await git.refresh(TENANT, user), { tickets: 1, rows: 0, cells: 0, trackers: 0 })

  // The person changes the title by hand; GitLab then changes the title and the priority.
  await git.pinCells(TENANT, 't1', row(), ['c_title'])
  assert.deepEqual(tables.tenant_git_tracker_tickets[0].pinned_cells, { [rowId]: ['c_title'] })
  row().data.c_title = 'My title'
  Object.assign(tables.user_gitlab_issues[0], { title: 'Login still fails', labels: ['priority::low'] })
  const third = await git.refresh(TENANT, user, { provider: 'gitlab' })
  assert.equal(third.cells, 2, 'Priority and Labels')
  assert.equal(row().data.c_labels, 'priority::low')
  assert.equal(row().data.c_title, 'My title', 'pinned')
  assert.equal(row().data.c_priority, 'o_low')
  assert.equal(row().data.c_severity, '2 - major', 'no severity label now: left as it was')
  assert.equal(tables.tenant_git_tracker_tickets[0].title_snapshot, 'Login still fails')

  // Another tracker, or only GitHub: nothing here.
  assert.equal((await git.refresh(TENANT, user, { trackerId: 't2' })).tickets, 0)
  assert.equal((await git.refresh(TENANT, user, { provider: 'github' })).tickets, 0)
})

test('without schema v45 a refresh says so and changes nothing; pinning is quietly skipped', async () => {
  const { git, tables, rowId } = harness(['follows_ticket', 'pinned_cells'])
  assert.deepEqual(await git.refresh(TENANT, user), {
    tickets: 0,
    rows: 0,
    cells: 0,
    trackers: 0,
    needsUpgrade: true,
  })
  assert.deepEqual(tables.tenant_tracker_rows.find(item => item.id === rowId).data, {
    c_stage: 'Ticket',
    c_notes: 'mine',
  })
  await git.pinCells(TENANT, 't1', { id: rowId, source_key: gitSourceKey(ENTRY) }, ['c_title'])
})

test('wiring: schema v45, new rows fill, edits pin, refresh at sign-in, page load, Work Hub sync and Refresh', () => {
  const migration = read('database/migrations/schema-v45-git-follow.sql')
  for (const column of ['follows_ticket boolean default true not null', 'pinned_cells jsonb', 'refreshed_at'])
    assert.ok(migration.includes(column), column)
  assert.match(migration, /45 as schema_version/)
  const schema = read('database/schema.sql')
  assert.ok(schema.includes('follows_ticket boolean default true not null'), 'schema.sql includes v45')
  assert.ok(Number(/(\d+) as schema_version/.exec(schema)?.[1]) >= 45)

  const server = read('server/trackers/tracker-git-tickets.ts')
  assert.match(server, /data: mergeCells\(\{\}, columns, startCells\(row\)\)/, 'new rows fill from headers and labels')
  assert.match(server, /'\/api\/tracker-git\/refresh'/)
  assert.match(server, /'\/api\/trackers\/:id\/git-tickets\/refresh'/)
  assert.match(server, /app\.patch\(\s*'\/api\/trackers\/:id\/git-tickets\/:entryId'/)
  const rowRoutes = read('server/trackers/tracker-row-routes.ts')
  assert.match(rowRoutes, /startsWith\('git:'\)\)\s*await pinGitCells\(tenant, id, current, changed\)/)
  assert.match(read('server/trackers/trackers.ts'), /gitTickets\.pinCells\)/)

  assert.match(read('src/app/state/useUiState.ts'), /gitFollowSession\(authUser\)/)
  const browser = read('src/features/trackers/gitRefresh.ts')
  assert.match(browser, /workHubSync\.subscribe/)
  assert.match(browser, /phase === 'success'/)
  assert.doesNotMatch(browser, /setInterval|setTimeout/, 'never on a timer')
  const panel = read('src/features/trackers/GitTicketsPanel.tsx')
  assert.match(panel, /workHubSync\.syncOne\('gitlab'\)/)
  assert.match(panel, /gitTicketsApi\.refresh\(trackerId\)/)
  assert.match(panel, /follow\(entry, \{ unpin: \[id\] \}\)/)
  assert.match(panel, /GIT_REFRESHED/)
})
