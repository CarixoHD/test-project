import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

// E2E runs the production server (built SPA + API) in demo mode on a throwaway data dir.
const PORT = 4327;
const DATA_DIR = mkdtempSync(join(tmpdir(), 'vibecode-e2e-'));

export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  reporter: 'list',
  use: {
    baseURL: `http://127.0.0.1:${String(PORT)}`,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run build && node src/server/main.ts',
    url: `http://127.0.0.1:${String(PORT)}/api/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      VIBECODE_HOST: '127.0.0.1',
      VIBECODE_PORT: String(PORT),
      VIBECODE_DEMO: '1',
      VIBECODE_FAKE_DOCKER: '1',
      VIBECODE_DATA_DIR: DATA_DIR,
    },
  },
});
