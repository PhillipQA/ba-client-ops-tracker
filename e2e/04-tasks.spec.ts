/** Tasks: create one, change it in the editor, complete it, and archive it. */
import { expect, test } from '@playwright/test'
import { ADMIN_STATE, createClient, createTask, dialog, dropdown, saved, shot, taskRow } from './support/app'

test.use({ storageState: ADMIN_STATE })

test('create, edit, complete and archive a task', async ({ page }, testInfo) => {
  const client = await createClient(page)
  const title = await createTask(page, { client })
  const row = taskRow(page, title)
  await expect(row).toBeVisible()
  await expect(row).toContainText(client)
  await shot(page, testInfo, '01-task-created')

  await row.getByRole('button', { name: 'Edit task' }).click()
  const editor = dialog(page, 'Edit task')
  await expect(editor).toBeVisible()
  // Priority is under Details, which starts folded.
  await editor.locator('summary', { hasText: 'Details' }).click()
  await dropdown(editor, 'Priority').selectOption('High')
  await shot(page, testInfo, '02-task-editor')
  await editor.getByRole('button', { name: 'Save changes' }).click()
  await expect(editor).toBeHidden()
  await saved(page)
  await expect(row).toContainText('High')

  await row.getByRole('button', { name: 'Mark task completed' }).click()
  await saved(page)
  await expect(row.getByRole('button', { name: 'Archive task' })).toBeVisible()
  await shot(page, testInfo, '03-task-completed')

  await row.getByRole('button', { name: 'Archive task' }).click()
  await saved(page)
  await expect(taskRow(page, title)).toHaveCount(0)
  await page.getByRole('button', { name: /^Archived/ }).click()
  await expect(taskRow(page, title)).toBeVisible()
  await shot(page, testInfo, '04-task-archived')
})
