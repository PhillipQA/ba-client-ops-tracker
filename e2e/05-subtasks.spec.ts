/** Subtasks: add one, and closing the task asks to close its open subtask too. */
import { expect, test } from '@playwright/test'
import { ADMIN_STATE, createClient, createTask, dialog, saved, shot, taskRow, unique } from './support/app'

test.use({ storageState: ADMIN_STATE })

test('a task with an open subtask asks before closing both', async ({ page }, testInfo) => {
  const client = await createClient(page)
  const title = await createTask(page, { client })
  const subtask = unique('E2E Subtask')

  await taskRow(page, title).getByRole('button', { name: 'Create subtask' }).click()
  const form = dialog(page, 'Add subtask')
  await form.getByLabel('Subtask title').fill(subtask)
  await form.getByRole('button', { name: 'Create subtask' }).click()
  await expect(form).toBeHidden()
  await saved(page)
  await expect(taskRow(page, subtask)).toBeVisible()
  await shot(page, testInfo, '01-subtask-added')

  await taskRow(page, title).getByRole('button', { name: 'Mark task completed' }).click()
  const confirm = dialog(page, /^Close task with 1 open subtask/)
  await expect(confirm).toBeVisible()
  await expect(confirm).toContainText(subtask)
  await shot(page, testInfo, '02-close-with-subtask')
  const word = (await confirm.getByLabel(/^Type .* to confirm$/).getAttribute('aria-label'))?.replace(
    /^Type | to confirm$/g,
    '',
  )
  await confirm.getByLabel(/^Type .* to confirm$/).fill(word || '')
  await confirm.getByRole('button', { name: /^Close task and 1 subtask/ }).click()
  await expect(confirm).toBeHidden()
  await saved(page)
  await expect(taskRow(page, title).getByRole('button', { name: 'Archive task' })).toBeVisible()
  await shot(page, testInfo, '03-both-closed')
})
