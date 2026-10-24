import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SIDEBAR_COLLAPSED_KEY, readSidebarCollapsed, writeSidebarCollapsed } from '../src/app/sidebarState'

function fakeStore(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial))
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value)
    },
    data,
  }
}

test('the menu starts expanded when nothing has been saved', () => {
  assert.equal(readSidebarCollapsed(fakeStore()), false)
})

test('a saved collapsed choice is read back, and expanding clears it', () => {
  const store = fakeStore()
  writeSidebarCollapsed(true, store)
  assert.equal(store.data.get(SIDEBAR_COLLAPSED_KEY), '1')
  assert.equal(readSidebarCollapsed(store), true)
  writeSidebarCollapsed(false, store)
  assert.equal(store.data.get(SIDEBAR_COLLAPSED_KEY), '0')
  assert.equal(readSidebarCollapsed(store), false)
})

test('an unexpected stored value is treated as expanded', () => {
  assert.equal(readSidebarCollapsed(fakeStore({ [SIDEBAR_COLLAPSED_KEY]: 'yes' })), false)
})

test('blocked or missing storage never throws and just means the choice is not remembered', () => {
  const blocked = {
    getItem: () => {
      throw new Error('blocked')
    },
    setItem: () => {
      throw new Error('quota')
    },
  }
  assert.equal(readSidebarCollapsed(blocked), false)
  assert.doesNotThrow(() => writeSidebarCollapsed(true, blocked))
  assert.equal(readSidebarCollapsed(null), false)
  assert.doesNotThrow(() => writeSidebarCollapsed(true, null))
})
