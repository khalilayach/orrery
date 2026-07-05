// @ts-check
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  retries: 1,               // canvas timing can flake on slow machines
  use: {
    headless: true,
    viewport: { width: 1280, height: 720 },
  },
  // mock agent backend for the terminal e2e tests (deterministic, no API calls)
  webServer: {
    command: 'node server/agent-server.mjs',
    url: 'http://127.0.0.1:57312/health',
    env: { MOCK_CLAUDE: '1', PORT: '57312' },
    reuseExistingServer: true,
  },
  reporter: [['list']],
});
