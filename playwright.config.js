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
  reporter: [['list']],
});
