/** Clients and Projects: make one of each and find them in their lists. */
import { expect, test } from '@playwright/test'
import { ADMIN_STATE, createClient, dialog, open, saved, shot, unique } from './support/app'

test.use({ storageState: ADMIN_STATE })

test('add a client and a project', async ({ page }, testInfo) => {
  const client = await createClient(page)
  await expect(page.getByText(client).first()).toBeVisible()
  await shot(page, testInfo, '01-client-added')

  const project = unique('E2E Project')
  await open(page, '/projects', 'Projects')
  await page.getByRole('button', { name: 'New project' }).click()
  const form = dialog(page, 'Add project')
  await form.getByLabel('Project name').fill(project)
  await form.getByLabel('Summary').fill('Created by the end-to-end tests.')
  await shot(page, testInfo, '02-project-form')
  await form.getByRole('button', { name: 'Create project' }).click()
  await expect(form).toBeHidden()
  await saved(page)
  await expect(page.getByText(project).first()).toBeVisible()
  await shot(page, testInfo, '03-project-added')
})
