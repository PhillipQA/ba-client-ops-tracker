import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
const restored = new Map()
for (const [key, value] of Object.entries({
  window: dom.window,
  document: dom.window.document,
  localStorage: dom.window.localStorage,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  HTMLInputElement: dom.window.HTMLInputElement,
  HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
  HTMLSelectElement: dom.window.HTMLSelectElement,
  MouseEvent: dom.window.MouseEvent,
  KeyboardEvent: dom.window.KeyboardEvent,
  FocusEvent: dom.window.FocusEvent,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  requestAnimationFrame: callback => setTimeout(callback, 0),
  cancelAnimationFrame: clearTimeout,
  IS_REACT_ACT_ENVIRONMENT: true,
})) {
  restored.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
}
dom.window.matchMedia = () => ({ matches: true })
dom.window.HTMLElement.prototype.scrollIntoView = () => {}

const React = await import('react')
const { createRoot } = await import('react-dom/client')
const { default: WorkHub } = await import('../src/features/work-hub/WorkHub.tsx')
const { workHubSync } = await import('../src/features/work-hub/workHubSync.ts')
after(() => {
  dom.window.close()
  for (const [key, descriptor] of restored) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor)
    else delete globalThis[key]
  }
})

async function fixture({ tasks = [], serverDuplicate = false, refreshFails = false, validationFails = false } = {}) {
  const originalFetch = globalThis.fetch,
    originalAlert = window.alert
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container),
    calls = [],
    popups = [],
    created = []
  let refreshCount = 0
  const email = {
    id: 'email-one',
    source: 'Gmail',
    subject: 'Account manager requests',
    body: 'Private email with several requests',
    sender: 'manager@example.com',
    status: 'New',
    received_at: '2026-10-12T00:00:00Z',
  }
  const props = {
    clients: [{ id: 'client', name: 'Client' }],
    projects: [{ id: 'project', name: 'Project' }],
    accounts: [
      { id: 'user-a', name: 'Alice', status: 'Active', role: 'Contributor' },
      { id: 'user-b', name: 'Bob', status: 'Active', role: 'Contributor' },
    ],
    currentUser: { id: 'user-a', organizationId: 'tenant', status: 'Active', role: 'Contributor' },
    tasks,
    onTaskCreated: async () => {
      refreshCount++
      if (refreshFails) throw new Error('Refresh unavailable')
      root.render(React.createElement(WorkHub, { ...props, tasks: [...tasks, ...created] }))
    },
  }
  window.alert = text => popups.push(text)
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : undefined })
    if (url === '/api/communications/settings')
      return Response.json({ gmailLabels: [], gmailLabelCatalog: [], gmailConnected: false })
    if (url.includes('/thread?')) return Response.json({ items: [email], total: 1 })
    if (url.startsWith('/api/communications?')) return Response.json({ items: [email], total: 1 })
    if (url === '/api/communications/email-one/create-task') {
      if (serverDuplicate) {
        serverDuplicate = false
        return Response.json({ code: 'DUPLICATE_TASK', error: 'Task already exists.' }, { status: 409 })
      }
      if (validationFails) return Response.json({ error: 'Select an active client and project.' }, { status: 400 })
      const task = { ...JSON.parse(init.body), id: `task-${created.length + 1}`, type: 'Task' }
      created.push(task)
      return Response.json({ task }, { status: 201 })
    }
    throw new Error(`Unexpected request: ${url}`)
  }
  workHubSync.invalidate('gmail')
  await React.act(async () => {
    root.render(React.createElement(WorkHub, props))
  })
  const field = text =>
    [...container.querySelectorAll('.communication-task-form label')]
      .find(label => label.firstChild.textContent === text)
      ?.querySelector('input,select,textarea')
  const fill = async (label, value) => {
    const element = field(label)
    assert(element, `Missing field ${label}`)
    await React.act(async () => {
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value').set
      setter.call(element, value)
      element.dispatchEvent(new window.Event(element.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }))
      // Type-to-search fields (Client) choose the typed name when the field is left, as a person tabbing on does.
      if (element.getAttribute('role') === 'combobox')
        element.dispatchEvent(new window.FocusEvent('focusout', { bubbles: true }))
    })
  }
  const createButton = () =>
    [...container.querySelectorAll('button')].find(
      button => button.textContent === 'Create task without sharing thread',
    )
  const create = async (clicks = 1) => {
    await React.act(async () => {
      for (let i = 0; i < clicks; i++) createButton().click()
    })
  }
  await React.act(async () => {
    container.querySelector('.communication-card').click()
  })
  await fill('Client', 'client')
  await fill('Project', 'project')
  await fill('Assign to', 'user-b')
  return {
    container,
    calls,
    popups,
    created,
    field,
    fill,
    create,
    getRefreshCount: () => refreshCount,
    cleanup: async () => {
      await React.act(async () => root.unmount())
      container.remove()
      globalThis.fetch = originalFetch
      window.alert = originalAlert
      workHubSync.invalidate('gmail')
    },
  }
}

test('Gmail task creation stays open and creates a second task with the same context', async () => {
  const f = await fixture()
  try {
    await f.fill('Task title', 'First request')
    await f.fill('Shared task description', 'First shared summary')
    await f.create()
    assert(f.container.querySelector('.communication-task-form'))
    assert.match(f.container.textContent, /Private email with several requests/)
    assert.equal(f.field('Task title').value, '')
    assert.equal(f.field('Shared task description').value, '')
    for (const [label, value] of [
      ['Client', 'client'],
      ['Project', 'project'],
      ['Assign to', 'user-b'],
    ])
      assert.equal(f.field(label).value, value)
    assert.equal(document.activeElement, f.field('Task title'))
    await f.fill('Task title', 'Second request')
    await f.fill('Shared task description', 'Second shared summary')
    await f.create()
    assert.deepEqual(
      f.created.map(task => task.title),
      ['First request', 'Second request'],
    )
    assert.equal(f.getRefreshCount(), 2)
    assert.equal(f.calls.filter(call => call.method === 'POST').length, 2)
    assert(!f.calls.some(call => call.url.includes('/sync')))
    assert(f.container.querySelector('.communication-task-form'))
    assert.equal(f.popups.length, 0)
  } finally {
    await f.cleanup()
  }
})

test('an existing task title shows a duplicate popup without saving or clearing the draft', async () => {
  const f = await fixture({
    tasks: [{ id: 'existing', type: 'Task', title: 'Verify rollout', clientId: 'client', projectId: 'project' }],
  })
  try {
    await f.fill('Task title', '  VERIFY   rollout ')
    await f.fill('Shared task description', 'Keep my draft')
    await f.create()
    assert.equal(f.popups.length, 1)
    assert.match(f.popups[0], /Duplicate task/)
    assert.equal(f.created.length, 0)
    assert.equal(f.calls.filter(call => call.method === 'POST').length, 0)
    assert.equal(f.field('Task title').value, '  VERIFY   rollout ')
    assert.equal(f.field('Shared task description').value, 'Keep my draft')
    await f.fill('Task title', 'Verify another rollout')
    await f.create()
    assert.equal(f.created.length, 1)
  } finally {
    await f.cleanup()
  }
})

test('a server duplicate response keeps the email and draft open and allows a renamed task', async () => {
  const f = await fixture({ serverDuplicate: true })
  try {
    await f.fill('Task title', 'Already created')
    await f.fill('Shared task description', 'Keep details')
    await f.create()
    assert.equal(f.popups.length, 1)
    assert.equal(f.getRefreshCount(), 0)
    assert.equal(f.field('Task title').value, 'Already created')
    assert.equal(f.field('Shared task description').value, 'Keep details')
    await f.fill('Task title', 'New request')
    await f.create()
    assert.deepEqual(
      f.created.map(task => task.title),
      ['New request'],
    )
  } finally {
    await f.cleanup()
  }
})

test('rapid repeated clicks send only one task creation request', async () => {
  const f = await fixture()
  try {
    await f.fill('Task title', 'Single request')
    await f.create(2)
    assert.equal(f.calls.filter(call => call.method === 'POST').length, 1)
    assert.equal(f.created.length, 1)
    assert(f.container.querySelector('.communication-task-form'))
  } finally {
    await f.cleanup()
  }
})

test('a workspace refresh failure reports the saved task and permits the next task', async () => {
  const f = await fixture({ refreshFails: true })
  try {
    await f.fill('Task title', 'Saved first request')
    await f.create()
    assert.match(f.container.textContent, /Saved first request.*created/)
    assert.match(f.container.textContent, /workspace list could not refresh/)
    assert.equal(f.field('Task title').value, '')
    assert(f.container.querySelector('.communication-task-form'))
    await f.fill('Task title', 'Saved second request')
    await f.create()
    assert.equal(f.created.length, 2)
  } finally {
    await f.cleanup()
  }
})

test('server validation errors preserve the task inputs for correction', async () => {
  const f = await fixture({ validationFails: true })
  try {
    await f.fill('Task title', 'Unsaved request')
    await f.fill('Shared task description', 'Retain summary')
    await f.create()
    assert.match(f.container.textContent, /Select an active client and project/)
    assert.equal(f.created.length, 0)
    assert.equal(f.field('Task title').value, 'Unsaved request')
    assert.equal(f.field('Shared task description').value, 'Retain summary')
    assert(f.container.querySelector('.communication-task-form'))
  } finally {
    await f.cleanup()
  }
})
