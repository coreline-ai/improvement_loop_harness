import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.pw.ts',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: 'http://127.0.0.1:4314',
    trace: 'retain-on-failure'
  },
  webServer: [
    {
      command: 'node tests/mock-api-server.mjs',
      url: 'http://127.0.0.1:4313/api/projects',
      reuseExistingServer: false,
      timeout: 15_000,
      env: { VIBELOOP_API_TOKEN: 'test-token' }
    },
    {
      command: 'corepack pnpm dev --hostname 127.0.0.1 --port 4314',
      url: 'http://127.0.0.1:4314/projects',
      reuseExistingServer: false,
      timeout: 30_000,
      env: {
        VIBELOOP_API_URL: 'http://127.0.0.1:4313',
        VIBELOOP_API_TOKEN: 'test-token'
      }
    }
  ],
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }]
});
