import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

// E2E runs the production server (built SPA + API) in demo mode on throwaway data dirs:
// fake LLM, fake container runtime, no API keys and no Docker.
const PORT = 4327;
// settings.spec.ts changes account-wide state (keys, role defaults, the owner password), so it
// gets its own server and data dir: a password set there can never lock out the other specs.
const SETTINGS_PORT = 4328;
// Workers load this config again; they inherit the env and so reuse the same data dirs.
const DATA_DIR = (process.env['VIBECODE_E2E_DATA_DIR'] ??= mkdtempSync(
  join(tmpdir(), 'vibecode-e2e-'),
));
const SETTINGS_DATA_DIR = (process.env['VIBECODE_E2E_SETTINGS_DATA_DIR'] ??= mkdtempSync(
  join(tmpdir(), 'vibecode-e2e-settings-'),
));

const SETTINGS_SPEC = /settings\.spec\.ts$/;

const serverEnv = (port: number, dataDir: string): Record<string, string> => ({
  VIBECODE_HOST: '127.0.0.1',
  VIBECODE_PORT: String(port),
  VIBECODE_DEMO: '1',
  VIBECODE_FAKE_DOCKER: '1',
  VIBECODE_DATA_DIR: dataDir,
});

const url = (port: number): string => `http://127.0.0.1:${String(port)}`;

export default defineConfig({
  testDir: 'tests/e2e',
  globalSetup: './tests/e2e/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  // Generous: each test drives real agent runs (fake LLM) and git merges, and CI machines are slow.
  timeout: 240_000,
  expect: { timeout: 15_000 },
  reporter: 'list',
  use: {
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      testIgnore: SETTINGS_SPEC,
      use: { ...devices['Desktop Chrome'], baseURL: url(PORT) },
    },
    {
      name: 'settings',
      testMatch: SETTINGS_SPEC,
      use: { ...devices['Desktop Chrome'], baseURL: url(SETTINGS_PORT) },
    },
  ],
  // Started one after the other: the first builds the SPA, the second serves the same build.
  webServer: [
    {
      command: 'npm run build && node src/server/main.ts',
      url: `${url(PORT)}/api/health`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: serverEnv(PORT, DATA_DIR),
    },
    {
      command: 'node src/server/main.ts',
      url: `${url(SETTINGS_PORT)}/api/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: serverEnv(SETTINGS_PORT, SETTINGS_DATA_DIR),
    },
  ],
});
