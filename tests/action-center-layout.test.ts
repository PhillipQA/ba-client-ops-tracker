import assert from 'node:assert/strict'
import test from 'node:test'
import {
  addWidget,
  cleanLayout,
  DEFAULT_ACTION_CENTER,
  layoutToShow,
  moveWidget,
  removeWidget,
  setWidgetSettings,
  setWidgetWidth,
  widgetsToAdd,
} from '../src/shared/actionCenterLayout'
import { tilesOf } from '../src/shared/actionCenterSettings'
import { builtinValue, customValue } from '../src/features/action-center/countTiles'
import { cleanJobRole } from '../src/shared/roles'
import { awaitingSignature, emailsToShow } from '../src/features/action-center/widgetLists'

const everything = () => true

test('a saved layout is cleaned: known widgets, each once, full or half', () => {
  assert.deepEqual(
    cleanLayout([
      { id: 'workhub', width: 'half' },
      { id: 'nope' },
      { id: 'workhub' },
      'counts',
      { id: 'brief', width: 'huge' },
    ]),
    [
      { id: 'workhub', width: 'half' },
      { id: 'counts', width: 'full' },
      { id: 'brief', width: 'full' },
    ],
  )
  assert.equal(cleanLayout('not a list'), undefined)
  assert.deepEqual(cleanLayout([]), [])
})

test('the person’s own layout wins, then the role’s, then the standard page', () => {
  const own = [{ id: 'dochub', width: 'half' }] as const
  const role = [{ id: 'workhub', width: 'full' }] as const
  assert.deepEqual(layoutToShow({ own: [...own], role: [...role] }, everything), own)
  assert.deepEqual(layoutToShow({ own: null, role: [...role] }, everything), role)
  assert.deepEqual(layoutToShow({}, everything), DEFAULT_ACTION_CENTER)
  // An empty own layout is a choice (nothing shown), not "none saved".
  assert.deepEqual(layoutToShow({ own: [], role: [...role] }, everything), [])
})

test('widgets for pages a person cannot open are left out, and not offered', () => {
  const noAi = (module: string) => module !== 'ai' && module !== 'inbox'
  const shown = layoutToShow(
    {
      own: [
        { id: 'assistant', width: 'full' },
        { id: 'workhub', width: 'half' },
        { id: 'counts', width: 'full' },
      ],
    },
    noAi,
  )
  assert.deepEqual(
    shown.map(item => item.id),
    ['counts'],
  )
  const offered = widgetsToAdd(shown, noAi).map(widget => widget.id)
  assert.ok(offered.includes('dochub'))
  assert.ok(!offered.includes('assistant') && !offered.includes('workhub') && !offered.includes('counts'))
})

test('adding, hiding, resizing and moving widgets', () => {
  let layout = addWidget(DEFAULT_ACTION_CENTER, 'workhub')
  assert.deepEqual(layout.at(-1), { id: 'workhub', width: 'half' }, 'Work Hub starts half width')
  assert.equal(addWidget(layout, 'workhub'), layout, 'not twice')
  layout = moveWidget(layout, 'workhub', 0)
  assert.equal(layout[0].id, 'workhub')
  layout = moveWidget(layout, 'workhub', 99)
  assert.equal(layout.at(-1)?.id, 'workhub')
  layout = setWidgetWidth(layout, 'workhub', 'full')
  assert.equal(layout.at(-1)?.width, 'full')
  layout = removeWidget(layout, 'calendar')
  assert.ok(!layout.some(item => item.id === 'calendar'))
})

test('a role keeps its starting layout through Settings › Roles', () => {
  const role = cleanJobRole({
    id: 'qa',
    name: 'Quality Assurance',
    modules: ['action'],
    actionCenter: [{ id: 'dochub', width: 'half' }, { id: 'bogus' }],
  })
  assert.deepEqual(role?.actionCenter, [{ id: 'dochub', width: 'half' }])
  assert.equal(cleanJobRole({ id: 'pm', name: 'PM' })?.actionCenter, undefined)
})

test('emails show unread first, then newest; documents show those out for signing, oldest first', () => {
  const emails = emailsToShow([
    {
      id: 'a',
      source: 'Gmail',
      subject: '',
      sender: '',
      received_at: '2026-11-15T03:00:00Z',
      read_at: '2026-11-15T04:00:00Z',
    },
    { id: 'b', source: 'Gmail', subject: '', sender: '', received_at: '2026-11-14T03:00:00Z', read_at: null },
    { id: 'c', source: 'Gmail', subject: '', sender: '', received_at: '2026-11-15T05:00:00Z', read_at: null },
  ])
  assert.deepEqual(
    emails.map(email => email.id),
    ['c', 'b', 'a'],
  )
  const doc = (id: string, status: string, createdAt: string) => ({
    id,
    status,
    createdAt,
    title: id,
    kind: 'DRF',
    signers: [],
    events: [],
  })
  assert.deepEqual(
    awaitingSignature([
      doc('done', 'COMPLETED', '2026-11-01T00:00:00Z'),
      doc('new', 'SENT', '2026-11-14T00:00:00Z'),
      doc('old', 'partially_signed', '2026-11-10T00:00:00Z'),
      doc('draft', 'READY_TO_REVIEW', '2026-11-09T00:00:00Z'),
    ]).map(item => item.id),
    ['old', 'new'],
  )
})

test('count tiles: kept with the counts widget, cleaned on every save', () => {
  const layout = cleanLayout([
    {
      id: 'counts',
      width: 'full',
      settings: {
        tiles: [
          { builtin: 'waitingClient', title: '  Client owes us  ', color: 'amber' },
          { builtin: 'waitingClient' },
          { builtin: 'nope' },
          {
            id: 'mine1',
            title: 'High, waiting on client',
            color: 'pink',
            mine: true,
            filters: [
              { field: 'priority', op: 'is', value: 'High' },
              { field: 'waitingOn', op: 'is', value: 'Client' },
              { field: 'type', op: 'is', value: 'Issue' },
              { field: 'status', op: 'is', value: 'Open' },
            ],
          },
          { id: 'untitled', filters: [] },
        ],
      },
    },
  ])!
  const tiles = (layout[0].settings as any).tiles
  assert.deepEqual(tiles[0], { id: 'waitingClient', builtin: 'waitingClient', title: 'Client owes us', color: 'amber' })
  assert.equal(tiles.length, 2, 'a built-in once, unknown ones and untitled custom counts dropped')
  assert.equal(tiles[1].color, undefined, 'only known colours')
  assert.equal(tiles[1].filters.length, 3, 'at most three filters')
  assert.equal(tiles[1].mine, true)
  assert.equal(tiles[1].detail, 'overdue')
  assert.deepEqual(
    tilesOf(undefined).map(tile => tile.builtin),
    ['attention', 'waitingDev', 'activities', 'inquiries'],
  )
  const edited = setWidgetSettings(layout, 'counts', undefined)
  assert.equal(edited[0].settings, undefined, 'back to the built-in tiles')
})

test('custom counts and built-in counts', () => {
  const today = '2026-11-15'
  const records = [
    { $user: 'u1', $client: 'c1', done: false, overdue: true, priority: 'High', waitingOn: 'Client' },
    { $user: 'u2', $client: 'c2', done: false, overdue: false, priority: 'High', waitingOn: 'Client' },
    { $user: 'u1', $client: 'c1', done: true, overdue: false, priority: 'High', waitingOn: 'Client' },
    { $user: 'u1', $client: 'c3', done: false, overdue: false, priority: 'Low', waitingOn: 'Client' },
  ]
  const fields = [
    { key: 'priority', label: 'Priority', type: 'text' as const },
    { key: 'waitingOn', label: 'Waiting on', type: 'text' as const },
  ]
  const tile = {
    id: 'x',
    title: 'Mine',
    mine: true,
    filters: [{ field: 'priority', op: 'is' as const, value: 'high' }],
  }
  assert.deepEqual(customValue(tile, records, fields, today, 'u1'), { title: 'Mine', value: '1', detail: '1 overdue' })
  assert.equal(customValue({ ...tile, mine: false, all: true }, records, fields, today, 'u1').value, '3')
  assert.equal(
    customValue({ ...tile, mine: false, detail: 'clients' }, records, fields, today, 'u1').detail,
    'Across 2 clients',
  )
  const open = [
    { id: '1', clientId: 'c1', dueDate: '2026-11-10', followUpDate: '', waitingOn: 'Client', type: 'Task' },
    { id: '2', clientId: 'c1', dueDate: today, followUpDate: '', waitingOn: 'Developer', type: 'Inquiry' },
    { id: '3', clientId: 'c2', dueDate: '', followUpDate: today, waitingOn: 'Client', type: 'Task' },
  ] as any[]
  const input = {
    open,
    allItems: [
      {
        timeEntries: [
          { userId: 'u1', hours: 2.5, forSeeds: true },
          { userId: 'u1', hours: 1, seedsEntryId: 's1', forSeeds: true },
        ],
      },
    ] as any[],
    taskSettings: {} as any,
    today,
    meId: 'u1',
    activitiesToday: { meetings: 1, tracker: 0, followUps: 2 },
    waitingTitle: 'Waiting on Developer',
    waitingDev: [open[1]],
  }
  assert.equal(builtinValue('attention', input).detail, 'Across 2 clients')
  assert.equal(builtinValue('waitingClient', input).value, '2')
  assert.equal(builtinValue('overdue', input).value, '1')
  assert.deepEqual(builtinValue('dueToday', input), { title: 'Due today', value: '2', detail: '1 due · 1 follow-up' })
  assert.equal(builtinValue('activities', input).value, '3')
  assert.equal(builtinValue('inquiries', input).value, '1')
  assert.deepEqual(builtinValue('unsentTime', input), {
    title: 'Time not sent to Seeds',
    value: '2.5h',
    detail: '1 entry to send',
  })
})
