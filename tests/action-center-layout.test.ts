import assert from 'node:assert/strict'
import test from 'node:test'
import {
  addWidget,
  cleanLayout,
  DEFAULT_ACTION_CENTER,
  layoutToShow,
  moveWidget,
  removeWidget,
  setWidgetWidth,
  widgetsToAdd,
} from '../src/shared/actionCenterLayout'
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
