import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { cellEntries } from '../src/features/trackers/cellComments'
import {
  planSheetComments,
  postsFromSheets,
  type SheetPost,
  sheetCellIndex,
  sheetCommentText,
  taskCopyText,
} from '../src/features/trackers/sheetComments'
import { readXlsx } from '../server/trackers/xlsx'

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

const grid = [
  ['Task', 'Status', 'Notes', 'Unfollowed'],
  ['Makati', 'Open', 'x', ''],
  [],
  ['Cebu', 'Done', '', ''],
  ['', 'Step', '', ''],
]
const headerMap = { Task: 'c-task', Status: 'c-status', Notes: 'c-notes', Unfollowed: '' }

test('Sheet cells are placed on tracker cells the way the sync keys rows', () => {
  const index = sheetCellIndex(grid, 'task', headerMap)
  assert.equal(index.keyAtRow.get(1), 'Makati')
  assert.equal(index.keyAtRow.get(2), undefined, 'an empty row is not a tracker row')
  assert.equal(index.keyAtRow.get(3), 'Cebu')
  assert.equal(index.keyAtRow.get(4), 'Cebu\u001e1', 'a row under Cebu')
  assert.equal(index.rowOfKey.get('Cebu'), 3)
  assert.equal(index.columnAt.get(1), 'c-status')
  assert.equal(index.columnAt.get(3), undefined, 'a column left out is not followed')
  assert.equal(index.columnOf.get('c-notes'), 2)
})

const post = (extra: Partial<SheetPost>): SheetPost => ({
  threadId: 't1',
  postId: 'p1',
  head: true,
  rowIndex: 1,
  columnIndex: 1,
  author: 'Ana',
  me: false,
  text: 'Check this',
  createdAt: '2026-11-21T01:00:00Z',
  updatedAt: '2026-11-21T01:00:00Z',
  resolved: false,
  ...extra,
})

test('the Sheets API answer becomes posts on cells; resolve-only replies are skipped', () => {
  const data = {
    sheets: [
      { properties: { sheetId: 7, title: 'Other' }, commentAnchors: [] },
      {
        properties: { sheetId: 3, title: 'Sites' },
        commentAnchors: [{ anchorId: 'a1', range: { sheetId: 3, startRowIndex: 3, startColumnIndex: 1 } }],
      },
    ],
    comments: [
      {
        commentId: 'c1',
        anchorId: 'a1',
        status: 'OPEN',
        headPost: { postId: 'h', content: ' Retest ', author: { displayName: 'Ana', me: false }, createTime: 'T1' },
        replies: [
          { postId: 'r1', content: 'ok', author: { displayName: 'Ben', me: true }, createTime: 'T2', updateTime: 'T3' },
          { postId: 'r2', commentAction: 'RESOLVE', author: { displayName: 'Ben' } },
        ],
      },
      { commentId: 'c2', anchorId: 'gone', headPost: { postId: 'x', content: 'lost cell' } },
    ],
  }
  const { sheetId, posts } = postsFromSheets(data, 'Sites')
  assert.equal(sheetId, 3)
  assert.deepEqual(
    posts.map(item => [item.postId, item.head, item.rowIndex, item.columnIndex, item.text, item.me, item.updatedAt]),
    [
      ['h', true, 3, 1, 'Retest', false, 'T1'],
      ['r1', false, 3, 1, 'ok', true, 'T3'],
    ],
  )
  assert.equal(postsFromSheets({ ...data, comments: [{ ...data.comments[0], status: 'RESOLVED' }] }, 'Sites').posts[0].resolved, true)
  assert.deepEqual(postsFromSheets(data, 'Missing'), { sheetId: null, posts: [] })
})

test('a sync adds new Sheet comments, follows edits and deletes, and recognises the tracker’s own', () => {
  const index = sheetCellIndex(grid, 'Task', headerMap)
  const rowsByKey = new Map([
    ['Makati', 'row-m'],
    ['Cebu', 'row-c'],
  ])
  const plan = planSheetComments({
    posts: [
      post({ postId: 'new' }),
      post({ postId: 'edited', text: 'changed', updatedAt: 'later' }),
      post({ postId: 'same', rowIndex: 3, columnIndex: 2, text: 'kept' }),
      post({ postId: 'mine', me: true, rowIndex: 3, columnIndex: 1, text: 'Phillip:  retest   Monday' }),
      post({ postId: 'unfollowed', columnIndex: 3 }),
      post({ postId: 'unknown-row', rowIndex: 9 }),
    ],
    index,
    rowsByKey,
    kept: [
      { recordId: 'k1', postId: 'edited', rowId: 'row-m', columnId: 'c-status', text: 'old', updatedAt: 'T', resolved: false },
      { recordId: 'k2', postId: 'same', rowId: 'row-c', columnId: 'c-notes', text: 'kept', updatedAt: '2026-11-21T01:00:00Z', resolved: false },
      { recordId: 'k3', postId: 'deleted-in-sheet', rowId: 'row-m', columnId: 'c-status', text: 'bye', updatedAt: 'T', resolved: false },
    ],
    outgoing: [
      { recordId: 'out1', rowId: 'row-c', columnId: 'c-status', sheetText: sheetCommentText('Phillip', 'retest Monday'), linked: false },
    ],
  })
  assert.deepEqual(
    plan.inserts.map(item => [item.postId, item.rowId, item.columnId]),
    [['new', 'row-m', 'c-status']],
  )
  assert.deepEqual(
    plan.updates.map(item => item.recordId),
    ['k1'],
    'only what changed',
  )
  assert.deepEqual(plan.deletes, ['k3'])
  assert.deepEqual(plan.links, [{ recordId: 'out1', threadId: 't1', postId: 'mine', head: true }])
  assert.equal(plan.skipped, 2)
})

test('the tooltip hides resolved Sheet threads and shows a task copy once', () => {
  const entries = cellEntries(
    [
      {
        id: 's1',
        authorId: '',
        authorName: 'Ana',
        text: 'Retest',
        mentions: [],
        at: '2026-11-21T01:00:00Z',
        columnId: 'c',
        source: 'sheet',
        taskCommentId: 'copy-1',
      },
      {
        id: 's2',
        authorId: '',
        authorName: 'Ana',
        text: 'done',
        mentions: [],
        at: '2026-11-21T02:00:00Z',
        columnId: 'c',
        source: 'sheet',
        resolved: true,
      },
      {
        id: 'mine',
        authorId: 'u1',
        authorName: 'Phillip',
        text: 'waiting',
        mentions: [],
        at: '2026-11-21T03:00:00Z',
        columnId: 'c',
        sheet: { state: 'failed', error: 'Allow editing Google Sheets first.' },
      },
    ],
    {
      comments: [
        {
          id: 'copy-1',
          text: taskCopyText('Ana', 'Retest'),
          createdAt: '2026-11-21T01:00:00Z',
          createdBy: '',
          createdByName: 'Ana',
          kind: 'User',
        },
      ],
    },
  )
  assert.deepEqual(
    entries.map(entry => [entry.id, entry.source]),
    [
      ['s1', 'sheet'],
      ['mine', 'cell'],
    ],
  )
  assert.equal(entries[1].notInSheet, 'Allow editing Google Sheets first.')
})

/** A tiny .xlsx (stored, not compressed) with a threaded comment, a reply, and a note. */
function workbook(files: Record<string, string>) {
  const locals: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text, 'utf8')
    const nameBytes = Buffer.from(name, 'utf8')
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(0, 8)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    locals.push(local, nameBytes, data)
    const entry = Buffer.alloc(46)
    entry.writeUInt32LE(0x02014b50, 0)
    entry.writeUInt16LE(0, 10)
    entry.writeUInt32LE(data.length, 20)
    entry.writeUInt32LE(data.length, 24)
    entry.writeUInt16LE(nameBytes.length, 28)
    entry.writeUInt32LE(offset, 42)
    central.push(entry, nameBytes)
    offset += 30 + nameBytes.length + data.length
  }
  const directory = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(Object.keys(files).length, 8)
  end.writeUInt16LE(Object.keys(files).length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}

test('Excel comments are read: threaded comments with replies and resolved state, and notes', () => {
  const file = workbook({
    'xl/workbook.xml': '<workbook><sheets><sheet name="Sites" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels':
      '<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId9" Type="http://schemas.microsoft.com/office/2017/10/relationships/person" Target="persons/person.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Task</t></is></c></row></sheetData></worksheet>',
    'xl/worksheets/_rels/sheet1.xml.rels':
      '<Relationships><Relationship Id="r1" Type="http://schemas.microsoft.com/office/2017/10/relationships/threadedComment" Target="../threadedComments/threadedComment1.xml"/><Relationship Id="r2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="../comments1.xml"/></Relationships>',
    'xl/persons/person.xml': '<personList><person displayName="Ana Cruz" id="{P1}"/><person displayName="Ben" id="{P2}"/></personList>',
    'xl/threadedComments/threadedComment1.xml':
      '<ThreadedComments><threadedComment ref="B2" dT="2026-11-21T01:00:00.00" personId="{P1}" id="{T1}" done="1"><text>Retest &amp; sign</text></threadedComment><threadedComment ref="B2" dT="2026-11-21T02:00:00.00" personId="{P2}" id="{T2}" parentId="{T1}"><text>ok</text></threadedComment></ThreadedComments>',
    'xl/comments1.xml':
      '<comments><authors><author>tc={T1}</author><author>Old Note</author></authors><commentList><comment ref="B2" authorId="0"><text><t>[Threaded comment]</t></text></comment><comment ref="C3" authorId="1"><text><r><t>Note </t></r><r><t>text</t></r></text></comment></commentList></comments>',
  })
  const posts = readXlsx(file).comments('Sites')
  assert.deepEqual(
    posts.map(item => [item.postId, item.threadId, item.head, item.rowIndex, item.columnIndex, item.author, item.text, item.resolved]),
    [
      ['{T1}', '{T1}', true, 1, 1, 'Ana Cruz', 'Retest & sign', true],
      ['{T2}', '{T1}', false, 1, 1, 'Ben', 'ok', true],
      ['note:C3', 'note:C3', true, 2, 2, 'Old Note', 'Note text', false],
    ],
  )
  assert.deepEqual(readXlsx(file).comments('Nope'), [])
})

test('comments sync with the Sheet in the sync, and tracker comments go to the Sheet', () => {
  const sync = read('server/trackers/tracker-sync.ts')
  assert.match(sync, /sheetComments\s*\n?\s*\.syncComments\(/)
  assert.match(sync, /Never fails the sync/)
  const sheet = read('server/trackers/tracker-sheet-comments.ts')
  assert.match(sheet, /insertComment: \{ content: sheet\.text, coordinate: \{ sheetId, rowIndex, columnIndex \} \}/)
  assert.match(sheet, /addCommentReply: \{ commentId: open\.threadId/)
  assert.match(sheet, /if \(!excel && read\.sheetId !== null && canWriteSheets\(scope\)\)/, 'Excel is only read')
  assert.match(sheet, /taskCopyText\(entry\.post\.author, entry\.post\.text\)/)
  const routes = read('server/trackers/tracker-comments.ts')
  assert.match(routes, /'\/api\/trackers\/:id\/rows\/:rowId\/sheet-comments'/)
  assert.match(routes, /void sheet\?\.sendNow\(tenant, tracker, entry\.id\)/)
  assert.match(read('src/features/trackers/trackerChangeSummary.ts'), /'sheet_comment', 'sheet_out'/)
})
