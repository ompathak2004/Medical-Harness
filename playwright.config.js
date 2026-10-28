import { defineConfig } from '@playwright/test';

const port = process.env.TEST_PORT || 8080;

export default defineConfig({
  testDir: './tests/browser',
  timeout: 30000,
  workers: process.env.CI ? 2 : 1,
  use: {
    baseURL: process.env.TEST_BASE_URL || `http://127.0.0.1:${port}`,
    channel: process.platform === 'win32' ? 'chrome' : undefined,
    launchOptions: { args: ['--enable-unsafe-swiftshader'] },
    trace: 'retain-on-failure',
  },
  webServer: {
    command: process.env.TEST_SERVER_COMMAND || `uv run uvicorn app.main:app --host 127.0.0.1 --port ${port} --no-access-log`,
    url: `http://127.0.0.1:${port}/api/health`,
    reuseExistingServer: false,
    env: { CEREBRAS_API_KEY: 'browser-test-key', MEDISEARCH_API_KEY: 'browser-test-key' },
  },
});
