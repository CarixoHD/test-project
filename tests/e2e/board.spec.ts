import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';

// Live board in demo mode (fake LLM, fake container runtime, no keys, no Docker):
// create → spar → handoff → the planned issues appear and reach Completed without a reload;
// then add, edit and cancel issues, ride out an SSE outage, and work through the inbox.
// Every step waits on what the owner sees; `page.reload()` is never called.

const PIPELINE_TIMEOUT_MS = 90_000;
const PLANNED = ['Scaffold', 'Core feature', 'Polish'] as const;

test.describe.configure({ mode: 'serial' });

/** The product the first test creates; the later tests continue with it. */
const product = { id: '', name: '' };

/** The board's list for one status column (each column is a list named after it). */
const column = (page: Page, label: string): Locator =>
  page.getByRole('region', { name: 'Issues' }).getByRole('list', { name: label, exact: true });

const card = (page: Page, label: string, title: string): Locator =>
  column(page, label)
    .getByRole('listitem')
    .filter({ has: page.getByRole('link', { name: new RegExp(` ${escapeRegExp(title)}$`) }) });

/** Board column label per issue status (labels as on the board). */
const ISSUE_COLUMN: Partial<Record<string, string>> = {
  open: 'Open',
  in_progress: 'In progress',
  in_review: 'In review',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

const columnCounts = (issues: readonly ServerIssue[]): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const label of Object.values(ISSUE_COLUMN)) if (label !== undefined) counts[label] = 0;
  for (const issue of issues) {
    const label = ISSUE_COLUMN[issue.status];
    if (label !== undefined) counts[label] = (counts[label] ?? 0) + 1;
  }
  return counts;
};

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
  // A new product opens on the Spec tab, where sparring happens.
  await expect(page).toHaveURL(/\/products\/[^/]+\/spec$/);
  await expect(page.getByRole('tab', { name: 'Spec' })).toHaveAttribute('aria-selected', 'true');
  const productId = page.url().split('/products/')[1]?.split('/')[0] ?? '';
  expect(productId).not.toBe('');
  product.id = productId;
  product.name = name;

  // It is listed on the products page and opens from there.
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Products' })
    .click();
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
  await page
    .getByRole('dialog', { name: 'Hand off to orchestrator?' })
    .getByRole('button', { name: 'Hand off', exact: true })
    .click();
  await page.getByRole('tab', { name: 'Build' }).click();

  for (const title of PLANNED) {
    // Scoped to the board: a running issue is also linked from the "Running agents" list.
    const onBoard = page
      .getByRole('region', { name: 'Issues' })
      .getByRole('link', { name: new RegExp(` ${title}$`) });
    await expect(onBoard).toBeVisible({
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

/** Opens the product's Build tab and waits for the live connection. */
async function openBoard(page: Page): Promise<void> {
  expect(product.id, 'the first test creates the product').not.toBe('');
  await page.goto(`/products/${product.id}`);
  await expect(page.getByRole('status').filter({ hasText: 'Live' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: product.name })).toBeVisible();
  await markDocument(page);
}

/** The collapsed Cancelled column, expanded so its cards are visible. */
async function expandCancelled(page: Page): Promise<void> {
  const details = page.getByRole('region', { name: 'Issues' }).locator('details');
  if ((await details.getAttribute('open')) === null) {
    await details.locator('summary').click();
  }
}

async function addIssue(page: Page, title: string, body: string): Promise<void> {
  await page.getByRole('button', { name: 'Add issue' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add issue' });
  await dialog.getByLabel('Title').fill(title);
  await dialog.getByLabel('Body (markdown)').fill(body);
  await dialog.getByRole('button', { name: 'Create issue' }).click();
  await expect(dialog).toBeHidden();
  await expect(card(page, 'Open', title)).toBeVisible();
}

const issueNumber = async (page: Page, label: string, title: string): Promise<string> => {
  const text = await card(page, label, title).getByRole('link').first().textContent();
  const match = /^#(\d+) /.exec(text ?? '');
  expect(match, `card "${title}" shows its number`).not.toBeNull();
  return match?.[1] ?? '';
};

test('add, edit and cancel issues on the live board', async ({ page, request }) => {
  await openBoard(page);

  // Pause so the new issues stay open while they are edited and cancelled.
  await page.getByRole('button', { name: 'Pause build' }).click();
  await expect(page.getByText('Paused by you')).toBeVisible();

  await addIssue(page, 'Streak export', 'Export the streaks.');
  await addIssue(page, 'Dark mode', 'A dark theme.');

  // Edit: the card shows the new title live.
  const exportNumber = await issueNumber(page, 'Open', 'Streak export');
  await page.getByRole('button', { name: `Edit issue #${exportNumber}` }).click();
  const edit = page.getByRole('dialog', { name: `Edit issue #${exportNumber}` });
  await edit.getByLabel('Title').fill('Streak export as CSV');
  await edit.getByRole('button', { name: 'Save changes' }).click();
  await expect(edit).toBeHidden();
  await expect(card(page, 'Open', 'Streak export as CSV')).toBeVisible();
  await expect(card(page, 'Open', 'Streak export')).toHaveCount(0);

  // Cancel: the card moves to the Cancelled column live.
  const darkNumber = await issueNumber(page, 'Open', 'Dark mode');
  await page.getByRole('button', { name: `Cancel issue #${darkNumber}` }).click();
  await page
    .getByRole('dialog', { name: `Cancel issue #${darkNumber}?` })
    .getByRole('button', { name: 'Cancel issue' })
    .click();
  await expect(card(page, 'Open', 'Dark mode')).toHaveCount(0);
  await expandCancelled(page);
  await expect(card(page, 'Cancelled', 'Dark mode')).toBeVisible();

  // Resume: the edited issue is built and reaches Completed live.
  await page.getByRole('button', { name: 'Resume build' }).click();
  await expect(card(page, 'Completed', 'Streak export as CSV')).toBeVisible({
    timeout: PIPELINE_TIMEOUT_MS,
  });
  await expectSameDocument(page);

  const byTitle = Object.fromEntries(
    (await serverIssues(request, product.id)).map((i) => [i.title, i.status]),
  );
  expect(byTitle).toMatchObject({
    'Streak export as CSV': 'completed',
    'Dark mode': 'cancelled',
  });
});

/** Records every non-empty text of the board's live region, from now on. */
async function recordAnnouncements(page: Page): Promise<void> {
  await page.evaluate(() => {
    const region = document.querySelector('[data-testid="board-announcer"]');
    if (region === null) throw new Error('board announcer missing');
    const seen: string[] = [];
    (window as unknown as { __announcements: string[] }).__announcements = seen;
    new MutationObserver(() => {
      const text = region.textContent ?? '';
      if (text !== '' && seen.at(-1) !== text) seen.push(text);
    }).observe(region, { childList: true, characterData: true, subtree: true });
  });
}

const announcements = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as unknown as { __announcements: string[] }).__announcements);

/**
 * Keeps every EventSource the page opens, so the test can drop the live stream. Chromium's
 * offline emulation leaves open streams alone, so the drop is: refuse new /api/events requests,
 * close the open stream and fire the `error` the browser fires when a connection is lost.
 */
async function trackEventSources(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const opened: EventSource[] = [];
    (window as unknown as { __eventSources: EventSource[] }).__eventSources = opened;
    const Native = window.EventSource;
    window.EventSource = class extends Native {
      constructor(url: string | URL, init?: EventSourceInit) {
        super(url, init);
        opened.push(this);
      }
    };
  });
}

async function dropEventStream(page: Page): Promise<void> {
  await page.route('**/api/events', (route) => route.abort('connectionreset'));
  await page.evaluate(() => {
    for (const es of (window as unknown as { __eventSources: EventSource[] }).__eventSources) {
      if (es.readyState === EventSource.CLOSED) continue;
      es.close();
      es.dispatchEvent(new Event('error'));
    }
  });
}

test('after an SSE outage the board reloads its snapshot and matches the server', async ({
  page,
  request,
}) => {
  await trackEventSources(page);
  await openBoard(page);
  const before = new Set((await serverIssues(request, product.id)).map((i) => i.id));
  const api = `/api/products/${product.id}`;
  const addIssueViaApi = async (title: string): Promise<string> => {
    const res = await request.post(`${api}/issues`, { data: { title, body: '' } });
    expect(res.ok()).toBe(true);
    return ((await res.json()) as { issueId: string }).issueId;
  };

  // Paused, so issues stay open; two of them are on the board before the outage.
  expect((await request.post(`${api}/pause`, { data: {} })).ok()).toBe(true);
  const known = [await addIssueViaApi('Offline B'), await addIssueViaApi('Offline C')];
  await expect(card(page, 'Open', 'Offline B')).toBeVisible();
  await expect(card(page, 'Open', 'Offline C')).toBeVisible();
  await recordAnnouncements(page);

  // Drop the stream; while it is down the server's issues change.
  await dropEventStream(page);
  await expect(page.getByRole('status').filter({ hasText: 'Reconnecting…' })).toBeVisible();
  const snapshotReload = page.waitForRequest('**/api/state', { timeout: 60_000 });
  await addIssueViaApi('Offline A');
  for (const id of known) {
    expect((await request.post(`/api/issues/${id}/cancel`, { data: {} })).ok()).toBe(true);
  }
  await expect(card(page, 'Open', 'Offline A')).toHaveCount(0);
  await expect(card(page, 'Open', 'Offline B')).toBeVisible();

  // Reconnects keep failing until the store gives up on them and reloads the snapshot.
  await snapshotReload;
  await page.unroute('**/api/events');
  await expect(page.getByRole('status').filter({ hasText: 'Live' })).toBeVisible({
    timeout: 60_000,
  });

  // The board matches the server, without a page reload.
  await expandCancelled(page);
  await expect(card(page, 'Open', 'Offline A')).toBeVisible();
  await expect(card(page, 'Cancelled', 'Offline B')).toBeVisible();
  await expect(card(page, 'Cancelled', 'Offline C')).toBeVisible();
  const server = await serverIssues(request, product.id);
  expect(server.filter((i) => !before.has(i.id)).map((i) => [i.title, i.status])).toEqual(
    expect.arrayContaining([
      ['Offline A', 'open'],
      ['Offline B', 'cancelled'],
      ['Offline C', 'cancelled'],
    ]),
  );
  for (const issue of server) {
    const label = ISSUE_COLUMN[issue.status];
    expect(label, `column for status ${issue.status}`).toBeDefined();
    await expect(card(page, label ?? '', issue.title)).toHaveCount(1);
  }
  for (const [label, count] of Object.entries(columnCounts(server))) {
    await expect(column(page, label).getByRole('listitem')).toHaveCount(count);
  }
  await expectSameDocument(page);

  // The catch-up is not announced as a flood: both cancellations arrive in one grouped message.
  // A per-change flood would record one of them alone first, so this list never matches.
  await expect
    .poll(() => announcements(page))
    .toEqual([
      expect.stringMatching(
        /^(?=.*Offline B is now Cancelled\.)(?=.*Offline C is now Cancelled\.)/,
      ),
    ]);

  expect((await request.post(`${api}/resume`, { data: {} })).ok()).toBe(true);
});

interface ServerInboxItem {
  productId: string | null;
  kind: string;
  title: string;
  read: boolean;
}

async function serverSnapshot(
  request: APIRequestContext,
): Promise<{ phase: string; inbox: ServerInboxItem[] }> {
  const res = await request.get('/api/state');
  expect(res.ok()).toBe(true);
  const { state } = (await res.json()) as {
    state: {
      products: Record<string, { phase: string }>;
      inbox: Record<string, ServerInboxItem>;
    };
  };
  return { phase: state.products[product.id]?.phase ?? '', inbox: Object.values(state.inbox) };
}

test('the inbox badge shows the completion and items can be marked read', async ({
  page,
  request,
}) => {
  await openBoard(page);
  // The previous test resumed the build: let it finish so no new items arrive meanwhile.
  await expect
    .poll(async () => (await serverSnapshot(request)).phase, { timeout: PIPELINE_TIMEOUT_MS })
    .toBe('complete');
  const { inbox } = await serverSnapshot(request);
  const unread = inbox.filter((i) => !i.read).length;
  const completionTitle = `${product.name} is complete`;
  expect(inbox.some((i) => i.kind === 'complete' && i.title === completionTitle && !i.read)).toBe(
    true,
  );

  const nav = page.getByRole('navigation', { name: 'Main' });
  const badgeFor = (n: number) =>
    nav.getByRole('link', { name: n === 0 ? 'Inbox' : `Inbox, ${String(n)} unread`, exact: true });
  await expect(badgeFor(unread)).toBeVisible();

  await badgeFor(unread).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Inbox' })).toBeVisible();
  const items = page.getByRole('list', { name: 'Inbox items' }).getByRole('listitem');
  const markCompletionRead = page.getByRole('button', { name: `Mark read: ${completionTitle}` });
  const unreadCompletions = await markCompletionRead.count();
  expect(unreadCompletions).toBeGreaterThan(0);
  await expect(items.filter({ hasText: completionTitle }).first()).toContainText(
    'Every issue is merged to main.',
  );

  // Mark one completion read: its button goes and the badge counts down, live.
  await markCompletionRead.first().click();
  await expect(markCompletionRead).toHaveCount(unreadCompletions - 1);
  await expect(badgeFor(unread - 1)).toBeVisible();

  await page.getByRole('button', { name: 'Mark all read' }).click();
  await expect(page.getByText('All caught up.')).toBeVisible();
  await expect(badgeFor(0)).toBeVisible();
  await expect(items.filter({ hasText: 'Unread' })).toHaveCount(0);
  await expectSameDocument(page);
  expect((await serverSnapshot(request)).inbox.every((i) => i.read)).toBe(true);
});
