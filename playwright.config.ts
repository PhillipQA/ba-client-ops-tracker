/**
 * End-to-end tests: the real app (built, `npm start`) against a real database, driven in Chromium.
 *
 * - CI (.github/workflows/e2e.yml) runs them headed under a virtual display, on a fresh database, and commits the
 *   screenshots in e2e/screenshots/ to the pull request so they can be looked at and kept in git.
 * - Locally: `npm run e2e:headed` (or `npm run e2e`) with the server's settings in your environment; see
 *   e2e/README.md. Never point these tests at a live workspace: they create clients, tasks and users.
 */
import { defineConfig, devices } from '@playwright/test'

const port = Number(process.env.E2E_PORT || 5173)
const baseURL = process.env.E2E_BASE_URL || `http://localhost:${port}`

export default defineConfig({
  testDir: './e2e',
  // One shared workspace: tests run one at a time, in file order, each creating its own uniquely named records.
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL,
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    timezoneId: 'Asia/Manila',
    locale: 'en-US',
  },
  projects: [
    { name: 'setup', testMatch: /auth\.setup\.ts/ },
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
      dependencies: ['setup'],
      testIgnore: /auth\.setup\.ts/,
    },
  ],
  // Starts the built app unless one is already running at baseURL (E2E_BASE_URL points at another server).
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: 'npm start',
        url: `${baseURL}/api/auth/session`,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
        stdout: 'pipe',
        stderr: 'pipe',
      },
})
