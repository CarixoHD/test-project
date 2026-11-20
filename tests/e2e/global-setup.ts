import { chromium } from '@playwright/test';

// Fail loudly, before any spec runs, when the Chromium build Playwright needs is missing.
export default async function globalSetup(): Promise<void> {
  try {
    const browser = await chromium.launch();
    await browser.close();
  } catch (err) {
    const reason = err instanceof Error ? err.message.split('\n')[0] : String(err);
    throw new Error(
      [
        'Playwright cannot start Chromium, so the E2E suite cannot run.',
        'Install it with: npx playwright install --with-deps chromium',
        `Cause: ${reason ?? 'unknown'}`,
      ].join('\n'),
    );
  }
}
