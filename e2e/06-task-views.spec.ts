/** One filtered list of tasks shown four ways: Table, Board, Calendar and Timeline. */
import { expect, test } from '@playwright/test'
import { ADMIN_STATE, businessToday, createClient, createTask, shot } from './support/app'

test.use({ storageState: ADMIN_STATE })

test('the same task in the Table, Board, Calendar and Timeline views', async ({ page }, testInfo) => {
  const client = await createClient(page)
  const title = await createTask(page, { client, status: 'In Progress', dueDate: businessToday() })
  // Show only this task, so each view is easy to read in the screenshots.
  await page.getByLabel('Search tasks').fill(title)

  await page.getByRole('button', { name: 'Board' }).click()
  await expect(page.getByRole('button', { name: title }).first()).toBeVisible()
  await shot(page, testInfo, '01-board')

  await page.getByRole('button', { name: 'Calendar' }).click()
  await expect(page.locator('.task-cal-chip', { hasText: title })).toBeVisible()
  await shot(page, testInfo, '02-calendar')

  await page.getByRole('button', { name: 'Timeline' }).click()
  await expect(page.locator('.task-tl-label', { hasText: title })).toBeVisible()
  await shot(page, testInfo, '03-timeline')

  await page.getByRole('button', { name: 'Table' }).click()
  await expect(page.getByRole('row').filter({ hasText: title })).toBeVisible()
  await shot(page, testInfo, '04-table')
})
