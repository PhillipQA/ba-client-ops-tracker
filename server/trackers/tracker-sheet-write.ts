/**
 * Writing tracker edits back to the connected Sheet: single cells, whole rows and appended rows, with the
 * problems each write can meet.
 */
import { TrackerError, type Cell, type TrackerColumn } from '../../src/features/trackers/trackerModel'
import { tabRange } from '../../src/features/trackers/trackerSync'
import {
  type SheetIssueCode,
  type SheetIssue,
  SHEET_ISSUES,
  locateSheetCell,
  sheetTextMatches,
  columnLetter,
  sheetTextFor,
} from '../../src/features/trackers/trackerAutoDone'
import { type InputOption, planAppend, planCellWrites } from '../../src/features/trackers/trackerTwoWay'
import type { TrackerCore } from './tracker-core'
import type { TrackerSheetAccess } from './tracker-source'

// ---- done when its tasks are done ----
// After every workspace save: rows linked to a task or subtask whose completed state changed get their auto-done
// column updated (see trackerAutoDone). A column that comes from the connected Sheet is written to the Sheet first,
// as the person who connected it; a row whose Sheet cell could not be written keeps its value and says why.
export type Actor = { id: string; name: string }
export type SheetResult = { ok: true; text: string } | { ok: false; code: SheetIssueCode }

export function trackerSheetWrite(core: TrackerCore, sheetAccess: TrackerSheetAccess) {
  const { now, columnsOf, db, rowOut } = core
  const { writeAccess, sheetsGet, readTab, asAccount, peopleOf } = sheetAccess
  const issueCode = (error: unknown): SheetIssueCode => {
    if (error instanceof TrackerError) {
      if (error.extra?.needsGoogle) return 'no_access'
      if (error.extra?.noEdit || error.extra?.noAccess) return 'no_edit'
    }
    return 'error'
  }
  const issueOf = (code: SheetIssueCode, value: Cell): SheetIssue => ({
    code,
    message: SHEET_ISSUES[code],
    value,
    at: now(),
  })
  /** Leading = + - @ would make Google read a choice label as a formula; an apostrophe keeps it plain text. */
  const plainText = (text: string) => (/^[=+\-@]/.test(text) ? `'${text}` : text)
  const headerFor = (source: any, columnId: string) =>
    Object.entries<string>(source?.header_map || {}).find(([, id]) => id === columnId)?.[0] || ''

  /** Writes values for several rows of one tracker to its Sheet, with one read and one write. */
  async function writeToSheet(
    tenant: string,
    source: any,
    column: TrackerColumn,
    entries: { row: any; value: Cell }[],
    actor: { id: string } | null = null,
  ): Promise<Map<string, SheetResult>> {
    const results = new Map<string, SheetResult>()
    const failAll = (code: SheetIssueCode) => {
      for (const entry of entries) results.set(entry.row.id, { ok: false, code })
      return results
    }
    const header = headerFor(source, column.id)
    if (!header) return failAll('no_header')
    let access: { token: string }
    try {
      // The person who completed the task, when their Google account may edit Sheets; otherwise the connector's.
      access = await writeAccess(tenant, source, actor, true)
    } catch (error) {
      return failAll(error instanceof TrackerError && error.extra?.excel ? 'read_only' : 'no_access')
    }
    let grid: string[][]
    try {
      const values = await sheetsGet(
        access.token,
        `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(source.spreadsheet_id)}/values/${encodeURIComponent(tabRange(source.tab))}?majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING`,
      )
      grid = (Array.isArray(values.values) ? values.values : []).map((line: unknown[]) =>
        (Array.isArray(line) ? line : []).map(value => String(value ?? '')),
      )
    } catch (error) {
      return failAll(issueCode(error))
    }
    const writes: { id: string; range: string; text: string }[] = []
    for (const entry of entries) {
      const cell = locateSheetCell(grid, source.key_header, String(entry.row.source_key || ''), header)
      if ('error' in cell) {
        results.set(entry.row.id, { ok: false, code: cell.error })
        continue
      }
      if (sheetTextMatches(column, cell.text, entry.value)) {
        results.set(entry.row.id, { ok: true, text: cell.text })
        continue
      }
      // Someone changed the cell in the Sheet after the last sync: their change wins until a person decides.
      const baseline = String(entry.row.source_values?.[header] ?? '')
      if (cell.text.trim() !== baseline.trim()) {
        results.set(entry.row.id, { ok: false, code: 'conflict' })
        continue
      }
      writes.push({
        id: entry.row.id,
        range: `${tabRange(source.tab)}!${columnLetter(cell.column)}${cell.row}`,
        text: sheetTextFor(column, entry.value, cell.text),
      })
    }
    if (writes.length) {
      try {
        await sheetsGet(
          access.token,
          `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(source.spreadsheet_id)}/values:batchUpdate`,
          {
            method: 'POST',
            body: {
              valueInputOption: 'USER_ENTERED',
              data: writes.map(write => ({ range: write.range, values: [[plainText(write.text)]] })),
            },
          },
        )
        for (const write of writes) results.set(write.id, { ok: true, text: write.text })
      } catch (error) {
        const code = issueCode(error)
        for (const write of writes) results.set(write.id, { ok: false, code })
      }
    }
    return results
  }
  /**
   * Writes cells, one request per way Google should read them, and returns each range's text as the Sheet now shows
   * it (a date keeps the cell's own format), which becomes the baseline the next sync compares with.
   */
  async function writeCells(token: string, source: any, cells: { range: string; text: string; input: InputOption }[]) {
    const shown = new Map<string, string>()
    for (const input of ['RAW', 'USER_ENTERED'] as const) {
      const batch = cells.filter(cell => cell.input === input)
      if (!batch.length) continue
      const result = await sheetsGet(
        token,
        `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(source.spreadsheet_id)}/values:batchUpdate`,
        {
          method: 'POST',
          body: {
            valueInputOption: input,
            includeValuesInResponse: true,
            responseValueRenderOption: 'FORMATTED_VALUE',
            data: batch.map(cell => ({ range: cell.range, values: [[cell.text]] })),
          },
        },
      )
      batch.forEach((cell, at) => {
        shown.set(cell.range, String(result?.responses?.[at]?.updatedData?.values?.[0]?.[0] ?? cell.text))
      })
    }
    return shown
  }

  /** Adds rows that have a task name to the bottom of the Sheet tab. Returns row id → the row fields to store. */
  async function appendRowsToSheet(tenant: string, tracker: any, source: any, rows: any[], user: { id: string }) {
    const stored = new Map<string, Record<string, unknown>>()
    const candidates = rows.filter(row => !row.source_key)
    if (!candidates.length) return stored
    const { token, email } = await writeAccess(tenant, source, user)
    const grid = await readTab(token, source).catch(error => asAccount(email, error))
    const plan = planAppend({
      grid,
      keyHeader: source.key_header,
      headerMap: source.header_map || {},
      columns: columnsOf(tracker),
      rows: candidates.map(row => ({ id: row.id, cells: row.data || {} })),
      people: await peopleOf(tenant),
    })
    if (!plan.appends.length) return stored
    // The key goes on the row first, so a sync running meanwhile recognises the new Sheet row instead of adding it again.
    for (const entry of plan.appends)
      await db
        .from('tenant_tracker_rows')
        .update({ source_key: entry.key, source_values: entry.values, review: false })
        .eq('tenant_id', tenant)
        .eq('tracker_id', tracker.id)
        .eq('id', entry.id)
    try {
      const appended = await sheetsGet(
        token,
        `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(source.spreadsheet_id)}/values/${encodeURIComponent(tabRange(source.tab))}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
        { method: 'POST', body: { values: plan.appends.map(entry => entry.line) } },
      )
      const updatedRange = String(appended?.updates?.updatedRange || '')
      const first = Number(/^\$?[A-Z]+\$?(\d+)/.exec(updatedRange.slice(updatedRange.lastIndexOf('!') + 1))?.[1])
      if (!Number.isInteger(first)) throw new TrackerError('Google did not say where the rows were added.', 502)
      const typed = plan.appends.flatMap((entry, at) =>
        entry.typed.map(cell => ({
          range: `${tabRange(source.tab)}!${columnLetter(cell.column)}${first + at}`,
          text: cell.text,
          input: 'USER_ENTERED' as const,
        })),
      )
      const shown = typed.length ? await writeCells(token, source, typed) : new Map<string, string>()
      const headers = (grid[0] || []).map(value => String(value ?? '').trim())
      plan.appends.forEach((entry, at) => {
        const values = { ...entry.values }
        for (const cell of entry.typed) {
          const header = headers[cell.column]
          const text = shown.get(`${tabRange(source.tab)}!${columnLetter(cell.column)}${first + at}`)
          const mapped = Object.keys(values).find(name => name.toLowerCase() === header.toLowerCase())
          if (mapped && text !== undefined) values[mapped] = text
        }
        stored.set(entry.id, { source_key: entry.key, source_values: values, review: false })
      })
      for (const [rowId, fields] of stored)
        await db
          .from('tenant_tracker_rows')
          .update({ source_values: fields.source_values })
          .eq('tenant_id', tenant)
          .eq('tracker_id', tracker.id)
          .eq('id', rowId)
    } catch (error) {
      // Not in the Sheet after all: take the keys off again so the rows stay tracker-only.
      for (const entry of plan.appends)
        await db
          .from('tenant_tracker_rows')
          .update({ source_key: '', source_values: {} })
          .eq('tenant_id', tenant)
          .eq('tracker_id', tracker.id)
          .eq('id', entry.id)
      asAccount(email, error)
    }
    return stored
  }

  /**
   * Writes one row's edited Sheet columns to the Sheet, before the tracker saves them. A row that is not in the Sheet
   * yet is added once it has a task name. Returns the row fields to store with the edit (the new baseline).
   */
  async function writeRowToSheet(
    tenant: string,
    tracker: any,
    source: any,
    current: any,
    edits: Record<string, Cell>,
    data: Record<string, Cell>,
    overwrite: boolean,
    user: { id: string },
  ): Promise<Record<string, unknown>> {
    if (!current.source_key) {
      const added = await appendRowsToSheet(tenant, tracker, source, [{ ...current, data }], user)
      return added.get(current.id) || {}
    }
    const { token, email } = await writeAccess(tenant, source, user)
    const grid = await readTab(token, source).catch(error => asAccount(email, error))
    const columns = columnsOf(tracker)
    const plan = planCellWrites({
      grid,
      keyHeader: source.key_header,
      sourceKey: String(current.source_key),
      headerMap: source.header_map || {},
      columns,
      cells: edits,
      baseline: current.source_values || {},
      people: await peopleOf(tenant),
      overwrite,
    })
    if ('error' in plan)
      throw new TrackerError(
        plan.error === 'no_row'
          ? 'This row was not found in the Google Sheet. It may have been renamed or removed there; sync to see the Sheet as it is now.'
          : 'The key column is no longer in the Google Sheet. Reconnect the Sheet.',
        409,
        { row: rowOut(current, columns) },
      )
    if (plan.conflicts.length)
      throw new TrackerError(
        plan.conflicts.length === 1
          ? `${plan.conflicts[0].name} was changed in the Google Sheet since the last sync.`
          : `${plan.conflicts.map(conflict => conflict.name).join(', ')} were changed in the Google Sheet since the last sync.`,
        409,
        { conflicts: plan.conflicts, row: rowOut(current, columns) },
      )
    const ranges = plan.writes.map(write => ({
      header: write.header,
      range: `${tabRange(source.tab)}!${columnLetter(write.column)}${plan.row}`,
      text: write.text,
      input: write.input,
    }))
    const shown = ranges.length
      ? await writeCells(token, source, ranges).catch(error => asAccount(email, error))
      : new Map<string, string>()
    const values = { ...(current.source_values || {}), ...plan.values }
    for (const write of ranges) values[write.header] = shown.get(write.range) ?? write.text
    return { source_values: values }
  }

  return { headerFor, issueOf, writeToSheet, appendRowsToSheet, writeRowToSheet }
}

export type TrackerSheetWrite = ReturnType<typeof trackerSheetWrite>
