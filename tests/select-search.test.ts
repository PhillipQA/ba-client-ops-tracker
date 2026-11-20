import assert from 'node:assert/strict'
import test from 'node:test'
import { SEARCH_AFTER, matchOptions, usesSearch } from '../src/shared/ui/selectSearch'

const select = (length: number, extra: Partial<Parameters<typeof usesSearch>[0]> = {}) => ({
  multiple: false,
  size: 0,
  disabled: false,
  dataset: {},
  options: Array.from({ length }, () => ({ hidden: false })),
  ...extra,
})

test('a dropdown searches only past the cut-off, and only when it is a plain single choice', () => {
  assert.equal(SEARCH_AFTER, 10)
  assert.equal(usesSearch(select(10)), false, '10 choices stay a dropdown')
  assert.equal(usesSearch(select(11)), true)
  assert.equal(usesSearch(select(40, { multiple: true })), false)
  assert.equal(usesSearch(select(40, { size: 6 })), false, 'a list box already shows its rows')
  assert.equal(usesSearch(select(40, { disabled: true })), false)
  assert.equal(usesSearch(select(40, { dataset: { native: '' } })), false, 'data-native keeps the browser list')
  const placeholder = [{ hidden: true }, ...Array.from({ length: 10 }, () => ({ hidden: false }))]
  assert.equal(usesSearch(select(0, { options: placeholder })), false, 'a hidden placeholder is not a choice')
})

test('typing narrows by every word, names starting with it first, groups kept together', () => {
  const options = [
    { label: 'Special Leaves', group: 'From Seeds' },
    { label: 'Retina Ongoing Support', group: 'From Seeds' },
    { label: 'CLP Ongoing Support', group: 'From Seeds' },
    { label: 'Ongoing Audit', group: 'Before Seeds' },
    { label: 'Admin Work', group: 'Before Seeds' },
  ]
  assert.equal(matchOptions(options, '  '), options)
  assert.deepEqual(
    matchOptions(options, 'ongoing').map(option => option.label),
    ['Retina Ongoing Support', 'CLP Ongoing Support', 'Ongoing Audit'],
  )
  assert.deepEqual(
    matchOptions(options, 'support clp').map(option => option.label),
    ['CLP Ongoing Support'],
  )
  assert.deepEqual(
    matchOptions(options, 'before').map(option => option.label),
    ['Ongoing Audit', 'Admin Work'],
    'the group name is searched too',
  )
  const plain = [{ label: 'Meetings' }, { label: 'Admin Meetings' }, { label: 'Leaves' }]
  assert.deepEqual(
    matchOptions(plain, 'meet').map(option => option.label),
    ['Meetings', 'Admin Meetings'],
  )
})
