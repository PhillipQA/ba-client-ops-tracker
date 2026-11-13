import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { excelDate, readXlsx, XlsxError } from '../server/trackers/xlsx'

const file = readFileSync(new URL('./fixtures/sites.xlsx', import.meta.url))

test('lists the visible tabs of a workbook', () => {
  const book = readXlsx(file)
  assert.deepEqual(book.tabs, [
    { title: 'Sites & Go-live', rows: 4, columns: 5 },
    { title: 'Notes', rows: 1, columns: 1 },
  ])
})

test('reads a tab as text, the way Google Sheets gives it', () => {
  const grid = readXlsx(file).grid('Sites & Go-live')
  assert.deepEqual(grid, [
    ['Site', 'Go-live', 'Status', 'Progress', 'Live'],
    ['Makati branch', '2026-11-25', 'New', '25%', 'FALSE'],
    [],
    ['Cebu <IT>', '2026-11-26', 'Done', '0.3', 'TRUE'],
  ])
})

test('an empty tab, a missing tab, and limits', () => {
  const book = readXlsx(file)
  assert.deepEqual(book.grid('Notes'), [])
  assert.equal(book.grid('Nope'), null)
  assert.deepEqual(book.grid('Sites & Go-live', { rows: 2, columns: 2 }), [
    ['Site', 'Go-live'],
    ['Makati branch', '2026-11-25'],
  ])
})

test('dates', () => {
  assert.equal(excelDate(46351), '2026-11-25')
  assert.equal(excelDate(46351.5), '2026-11-25 12:00')
  assert.equal(excelDate(44889, true), '2026-11-25')
})

test('a file that is not a workbook is refused', () => {
  assert.throws(() => readXlsx(Buffer.from('not a zip at all, just some text here')), XlsxError)
})

test('an Excel file unchanged in Drive since the last good sync is not read again, unless Sync now', async () => {
  const { unchangedFile } = await import('../src/features/trackers/trackerSync')
  const synced = { last_status: 'ok', last_report: { fileVersion: '2026-11-13T01:00:00.000Z' } as any }
  assert.equal(unchangedFile(synced, '2026-11-13T01:00:00.000Z', false), true)
  assert.equal(unchangedFile(synced, '2026-11-13T01:00:00.000Z', true), false, 'Sync now reads it')
  assert.equal(unchangedFile(synced, '2026-11-13T02:00:00.000Z', false), false, 'changed in Drive')
  assert.equal(unchangedFile({ ...synced, last_status: 'error' }, '2026-11-13T01:00:00.000Z', false), false)
  assert.equal(unchangedFile(synced, '', false), false, 'no version from Drive: read it')
  assert.equal(unchangedFile({ last_status: 'ok', last_report: null }, '2026-11-13T01:00:00.000Z', false), false)
})
