import { existsSync } from 'node:fs';
import { defineConfig } from '@playwright/test';

/**
 * Flow tests against a running, seeded stack:
 *   npm run db:reset && npm run db:seed && npm run dev   (from the repo root)
 *   npm run test:e2e --workspace=@ajpwer/frontend
 */
const localChromium = '/opt/pw-browsers/chromium';

export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:5173',
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
    launchOptions: existsSync(localChromium) && !process.env.PW_USE_BUNDLED ? { executablePath: localChromium } : {},
  },
});
