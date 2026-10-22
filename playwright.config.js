import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser',
  timeout: 30000,
  workers: process.env.CI ? 2 : 1,
  use: {
    baseURL: process.env.TEST_BASE_URL || 'http://127.0.0.1:8080',
    channel: process.platform === 'win32' ? 'chrome' : undefined,
    launchOptions: { args: ['--enable-unsafe-swiftshader'] },
    trace: 'retain-on-failure',
  },
  webServer: {
    command: process.env.TEST_SERVER_COMMAND || 'uv run uvicorn app.main:app --host 127.0.0.1 --port 8080 --no-access-log',
    url: 'http://127.0.0.1:8080/api/health',
    reuseExistingServer: false,
    env: { CEREBRAS_API_KEY: 'browser-test-key', MEDISEARCH_API_KEY: 'browser-test-key' },
  },
});
