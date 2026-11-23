/**
 * Shared steps for the end-to-end tests: who signs in, saved screenshots, reaching a page, and making the records a
 * test needs (each test makes its own, with a unique name, so tests don't depend on each other).
 */
import { expect, type Locator, type Page, type TestInfo } from '@playwright/test'
import path from 'node:path'

/** The workspace account and its Administrator, from the environment (CI sets test values; never real ones). */
export const ACCOUNT = process.env.E2E_ACCOUNT || 'BXI-Core'
export const USER = process.env.E2E_USER || 'Admin'
export const PASSWORD = process.env.E2E_PASSWORD || process.env.BXI_CORE_BOOTSTRAP_PASSWORD || ''
export const ADMIN_STATE = path.join(import.meta.dirname, '..', '.auth', 'admin.json')

if (!PASSWORD) throw new Error('Set E2E_PASSWORD (or BXI_CORE_BOOTSTRAP_PASSWORD) for the end-to-end tests.')

/** A name no other run uses, so records from earlier runs never get in the way: "E2E Client 7f3a". */
export const unique = (label: string) => `${label} ${Date.now().toString(36).slice(-5)}`

/** Today in the app's business time zone (Asia/Manila unless FOLLOW_UP_TIME_ZONE says otherwise). */
export const businessToday = () =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: process.env.FOLLOW_UP_TIME_ZONE || 'Asia/Manila',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date())

/**
 * Saves a screenshot to e2e/screenshots/<spec>/<name>.png. These files are kept in git: CI commits new ones to the
 * pull request, so what each step looked like can be reviewed there.
 */
export async function shot(page: Page, testInfo: TestInfo, name: string) {
  const spec = path.basename(testInfo.file).replace(/\.spec\.ts$/, '')
  const file = path.join(import.meta.dirname, '..', 'screenshots', spec, `${name}.png`)
  await page.screenshot({ path: file, fullPage: true, animations: 'disabled', caret: 'hide' })
  await testInfo.attach(name, { path: file, contentType: 'image/png' })
}

/** The two-step workspace sign-in: account first, then user and password. */
export async function signIn(page: Page, user = USER, password = PASSWORD, account = ACCOUNT) {
  await page.goto('/')
  await page.getByLabel('Account').fill(account)
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByLabel('User', { exact: true }).fill(user)
  await page.getByLabel('Password', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'Sign in' }).click()
}

/**
 * The guided tour starts by itself at a person's first sign-in in a browser (and covers the page). Skips it if it
 * appears; the browser then remembers it, and the saved session carries that to the other tests.
 */
export async function skipTour(page: Page) {
  const skip = page.getByRole('button', { name: 'Skip the tour' })
  try {
    await skip.waitFor({ state: 'visible', timeout: 5_000 })
  } catch {
    return
  }
  await skip.click()
  await expect(skip).toBeHidden()
}

/** The page's main heading, once the app has loaded the page. */
export const heading = (page: Page, name: string | RegExp) => page.getByRole('heading', { level: 1, name }).first()

/** Opens a page by its address and waits for its heading. */
export async function open(page: Page, address: string, title: string | RegExp) {
  await page.goto(address)
  await expect(heading(page, title)).toBeVisible()
  await expect(page.getByText('Something went wrong on this screen')).toHaveCount(0)
}

/** Waits until the workspace has been saved to the database. */
export async function saved(page: Page) {
  await expect(page.getByText('Database synced').first()).toBeVisible({ timeout: 20_000 })
}

/**
 * A dropdown by its label. A <select> inside its <label> is named by the label plus the chosen option ("Status
 * Open"), so the label is matched at the start. Labels here are plain words.
 */
export const dropdown = (scope: Page | Locator, label: string) =>
  scope.getByRole('combobox', { name: new RegExp(`^${label}\\b`) })

/** The dialog with this title. */
export const dialog = (page: Page, title: string | RegExp) => page.getByRole('dialog', { name: title })

/** Makes a client through Clients › New client and returns its name. */
export async function createClient(page: Page, name = unique('E2E Client')) {
  await open(page, '/clients', 'Clients')
  await page.getByRole('button', { name: 'New client' }).click()
  const form = dialog(page, 'Add client')
  await form.getByLabel('Client name').fill(name)
  await form.getByLabel('Primary contact').fill('Pat Tester')
  await form.getByLabel('Email').fill('pat.tester@example.com')
  await form.getByRole('button', { name: 'Create client' }).click()
  await expect(form).toBeHidden()
  await saved(page)
  return name
}

/** Makes a task through Tasks › New task, assigned to the signed-in Administrator, and returns its title. */
export async function createTask(
  page: Page,
  options: { client: string; title?: string; dueDate?: string; status?: string },
) {
  const title = options.title || unique('E2E Task')
  await open(page, '/tasks', 'Tasks')
  await page.getByRole('button', { name: 'New task' }).click()
  const form = dialog(page, 'Add task')
  await form.getByLabel('Task title').fill(title)
  await dropdown(form, 'Client').selectOption({ label: options.client })
  if (options.status) await dropdown(form, 'Status').selectOption(options.status)
  if (options.dueDate) await form.getByLabel('Due date').fill(options.dueDate)
  const assignee = form.getByLabel('Assigned to')
  const first = await assignee.locator('option', { hasText: '·' }).first().getAttribute('value')
  if (first) await assignee.selectOption(first)
  await form.getByRole('button', { name: 'Create task' }).click()
  await expect(form).toBeHidden()
  await saved(page)
  return title
}

/** A task's row in the Tasks table. */
export const taskRow = (page: Page, title: string) => page.getByRole('row').filter({ hasText: title }).first()
