import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';

// Live board in demo mode (fake LLM, fake container runtime, no keys, no Docker):
// create → spar → handoff → the planned issues appear and reach Completed without a reload;
// then add, edit and cancel issues, ride out an SSE outage, and work through the inbox.
// Every step waits on what the owner sees; `page.reload()` is never called.

const PIPELINE_TIMEOUT_MS = 90_000;
const PLANNED = ['Scaffold', 'Core feature', 'Polish'] as const;

test.describe.configure({ mode: 'serial' });

/** The board's list for one status column (each column is a list named after it). */
const column = (page: Page, label: string): Locator =>
  page.getByRole('region', { name: 'Issues' }).getByRole('list', { name: label, exact: true });

const card = (page: Page, label: string, title: string): Locator =>
  column(page, label)
    .getByRole('listitem')
    .filter({ has: page.getByRole('link', { name: new RegExp(` ${escapeRegExp(title)}$`) }) });

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

interface ServerIssue {
  id: string;
  productId: string;
  number: number;
  title: string;
  status: string;
}

/** The server's issue statuses for one product, straight from GET /api/state. */
async function serverIssues(request: APIRequestContext, productId: string): Promise<ServerIssue[]> {
  const res = await request.get('/api/state');
  expect(res.ok()).toBe(true);
  const body = (await res.json()) as { state: { issues: Record<string, ServerIssue> } };
  return Object.values(body.state.issues).filter((i) => i.productId === productId);
}

/** Tags the loaded document; a reload or full navigation would drop the tag. */
async function markDocument(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.documentElement.dataset['e2eDocument'] = 'original';
  });
}

async function expectSameDocument(page: Page): Promise<void> {
  await expect(page.locator('html')).toHaveAttribute('data-e2e-document', 'original');
}

async function spar(page: Page, message: string): Promise<void> {
  const chat = page.getByRole('region', { name: 'Sparring' });
  const replies = chat.getByText('Sparring agent', { exact: true });
  const before = await replies.count();
  await chat.getByLabel('Your message').fill(message);
  await chat.getByRole('button', { name: 'Send' }).click();
  await expect(replies).toHaveCount(before + 1, { timeout: 30_000 });
}

test('create a product, spar, hand off and watch the board complete without reloading', async ({
  page,
  request,
}) => {
  await page.goto('/');
  await expect(page.getByRole('status').filter({ hasText: 'Live' })).toBeVisible();
  await markDocument(page);

  // Create from the products page.
  const name = `Habit tracker ${String(Date.now())}`;
  await page.getByLabel('Name').fill(name);
  await page.getByLabel('Idea').fill('Track daily habits and show streaks.');
  await page.getByRole('button', { name: 'Create product' }).click();
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
  const productUrl = page.url();
  const productId = productUrl.split('/products/')[1] ?? '';
  expect(productId).not.toBe('');

  // It is listed on the products page and opens from there.
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Products' }).click();
  const listed = page.getByRole('list', { name: 'Products' }).getByRole('link', { name });
  await expect(listed).toBeVisible();
  await listed.click();
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();

  // Spar until the PRD draft exists: two questions, then the draft.
  await page.getByRole('tab', { name: 'Spec' }).click();
  await spar(page, 'People who want to build habits.');
  await spar(page, 'Show the current streak per habit.');
  await spar(page, 'That is all, please write the PRD.');
  const handoff = page.getByRole('button', { name: 'Hand off to orchestrator' });
  await expect(handoff).not.toHaveAttribute('aria-disabled', 'true');

  // Hand off, then follow the board live.
  await handoff.click();
  await page.getByRole('dialog', { name: 'Hand off to orchestrator?' }).getByRole('button', { name: 'Hand off', exact: true }).click();
  await page.getByRole('tab', { name: 'Build' }).click();

  for (const title of PLANNED) {
    await expect(page.getByRole('link', { name: new RegExp(` ${title}$`) })).toBeVisible({
      timeout: PIPELINE_TIMEOUT_MS,
    });
  }
  for (const title of PLANNED) {
    await expect(card(page, 'Completed', title)).toBeVisible({ timeout: PIPELINE_TIMEOUT_MS });
  }
  await expect(page.getByRole('heading', { level: 3, name: 'Completed (3)' })).toBeVisible();

  // The completion lands in the inbox badge live.
  await expect(
    page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Inbox, 1 unread' }),
  ).toBeVisible({ timeout: PIPELINE_TIMEOUT_MS });

  await expectSameDocument(page);
  expect((await serverIssues(request, productId)).map((i) => i.status).sort()).toEqual([
    'completed',
    'completed',
    'completed',
  ]);
});
