import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';

// Account settings, product budget/parallelism and the owner password, in demo mode.
// Runs in the `settings` project against its own server and data dir (playwright.config.ts):
// the keys, role defaults and password set here never reach the other specs.
// Serial: the password test runs last, because once a password is set every request needs a
// session.

test.describe.configure({ mode: 'serial' });

const section = (page: Page, name: string): Locator =>
  page.getByRole('region', { name, exact: true });

interface AccountSettings {
  keys: { provider: string; last4: string | null }[];
  roleDefaults: Record<string, { provider: string; model: string } | undefined>;
}

async function serverSettings(request: APIRequestContext): Promise<AccountSettings> {
  const res = await request.get('/api/settings');
  expect(res.ok()).toBe(true);
  return (await res.json()) as AccountSettings;
}

test('an entered API key is only ever shown as its last 4 characters', async ({
  page,
  request,
}) => {
  const key = `sk-ant-e2e-${String(Date.now())}-SECRETwxyz`;
  await page.goto('/settings');
  const anthropic = section(page, 'Providers').getByRole('group', { name: 'Anthropic' });
  await anthropic.getByLabel('Anthropic API key').fill(key);
  await anthropic.getByRole('button', { name: 'Save Anthropic key' }).click();

  await expect(anthropic.getByText('Key ending in wxyz', { exact: true })).toBeVisible();
  await expect(anthropic.getByRole('status')).toHaveText('Anthropic key saved.');
  await expect(anthropic.getByLabel('Anthropic API key')).toHaveCount(0);
  expect(await page.content()).not.toContain(key);
  expect(await page.content()).not.toContain('SECRET');

  // The server only ever hands back the ending, and a reload shows the same masked key.
  const settings = await serverSettings(request);
  expect(settings.keys).toContainEqual({ provider: 'anthropic', last4: 'wxyz' });
  expect(JSON.stringify(settings)).not.toContain(key);
  await page.reload();
  await expect(anthropic.getByText('Key ending in wxyz', { exact: true })).toBeVisible();
  expect(await page.content()).not.toContain(key);
});

test('role defaults are saved and shown again after a reload', async ({ page, request }) => {
  await page.goto('/settings');
  const models = section(page, 'Models');
  const implementer = models.getByRole('group', { name: 'Implementer' });
  await implementer.getByLabel('Provider').selectOption('anthropic');
  await implementer.getByLabel('Model').fill('claude-e2e-implementer');
  const reviewer = models.getByRole('group', { name: 'Reviewer' });
  await reviewer.getByLabel('Provider').selectOption('openai');
  await reviewer.getByLabel('Model').fill('gpt-e2e-reviewer');
  await models.getByRole('button', { name: 'Save models' }).click();
  await expect(models.getByRole('status')).toHaveText('Models saved.');

  const settings = await serverSettings(request);
  expect(settings.roleDefaults['implementer']).toEqual({
    provider: 'anthropic',
    model: 'claude-e2e-implementer',
  });
  expect(settings.roleDefaults['reviewer']).toEqual({
    provider: 'openai',
    model: 'gpt-e2e-reviewer',
  });

  await page.reload();
  await expect(implementer.getByLabel('Provider')).toHaveValue('anthropic');
  await expect(implementer.getByLabel('Model')).toHaveValue('claude-e2e-implementer');
  await expect(reviewer.getByLabel('Provider')).toHaveValue('openai');
  await expect(reviewer.getByLabel('Model')).toHaveValue('gpt-e2e-reviewer');
  // Roles without their own model stay unset (they use the default).
  await expect(models.getByRole('group', { name: 'Sparring' }).getByLabel('Model')).toHaveValue('');
});

test('a product budget and max parallel agents are saved and shown on the Build tab', async ({
  page,
  request,
}) => {
  const name = `Budget check ${String(Date.now())}`;
  const created = await request.post('/api/products', {
    data: { name, idea: 'A product to try the per-product settings on.' },
  });
  expect(created.status()).toBe(201);
  const { id } = (await created.json()) as { id: string };

  await page.goto(`/products/${id}`);
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
  const costs = page.getByRole('region', { name: 'Costs' });
  await expect(costs).toContainText('no budget set');

  await page.getByRole('tab', { name: 'Settings' }).click();
  const form = page.getByRole('form', { name: `Settings for ${name}` });
  await form.getByLabel('Budget (USD)').fill('12.5');
  await form.getByLabel('Parallel agents').fill('2');
  await form.getByRole('button', { name: 'Save settings' }).click();
  await expect(form.getByRole('status')).toHaveText('Settings saved.');

  // The server stored both, and the board's cost bar now measures spend against the budget.
  const res = await request.get('/api/state');
  expect(res.ok()).toBe(true);
  const body = (await res.json()) as {
    state: {
      products: Record<string, { settings: { budgetUsd: number | null; maxParallel: number } }>;
    };
  };
  expect(body.state.products[id]?.settings).toMatchObject({ budgetUsd: 12.5, maxParallel: 2 });

  await page.getByRole('tab', { name: 'Build' }).click();
  await expect(costs).toContainText('of US$12.50');
  await expect(costs.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0');

  // A reload shows the saved values in the form.
  await page.reload();
  await page.getByRole('tab', { name: 'Settings' }).click();
  await expect(form.getByLabel('Budget (USD)')).toHaveValue('12.5');
  await expect(form.getByLabel('Parallel agents')).toHaveValue('2');

  // Out-of-range parallelism is refused inline and nothing is saved.
  await form.getByLabel('Parallel agents').fill('11');
  await form.getByRole('button', { name: 'Save settings' }).click();
  await expect(form.getByLabel('Parallel agents')).toHaveAttribute('aria-invalid', 'true');
  await expect(form.getByLabel('Parallel agents')).toBeFocused();
});

test('set a password, then log out, fail once, log in and log out again', async ({ page }) => {
  const password = 'e2e correct horse battery';
  const loginHeading = page.getByRole('heading', { level: 1, name: 'Log in to Vibecode' });
  const logOut = page.getByRole('button', { name: 'Log out' });

  await page.goto('/settings');
  const pwd = section(page, 'Password');
  await expect(pwd.getByText('No password is set.')).toBeVisible();
  await expect(logOut).toHaveCount(0);
  await pwd.getByLabel('New password', { exact: true }).fill(password);
  await pwd.getByLabel('Confirm new password').fill(password);
  await pwd.getByRole('button', { name: 'Set password' }).click();
  await expect(pwd.getByRole('status')).toHaveText('Password set. Log in with it from now on.');
  await expect(logOut).toBeVisible();

  // The browser that set the password keeps its session across a reload.
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
  await expect(pwd.getByText('A password is set.')).toBeVisible();

  // Without a session, a reload shows only the Login page.
  await logOut.click();
  await expect(loginHeading).toBeVisible();
  await page.reload();
  await expect(loginHeading).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Main' })).toHaveCount(0);
  const status = await page.request.get('/api/state');
  expect(status.status()).toBe(401);

  // A wrong password is refused with an error on the field.
  const field = page.getByLabel('Password');
  await field.fill('not the password');
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.getByText('Wrong password. Try again.')).toBeVisible();
  await expect(field).toHaveAttribute('aria-invalid', 'true');
  await expect(loginHeading).toBeVisible();

  // The right one opens the app again.
  await field.fill(password);
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(loginHeading).toHaveCount(0);
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
  expect((await page.request.get('/api/state')).ok()).toBe(true);

  // Logging out ends the session: back to Login, also after a reload.
  await logOut.click();
  await expect(loginHeading).toBeVisible();
  await page.reload();
  await expect(loginHeading).toBeVisible();
  expect((await page.request.get('/api/state')).status()).toBe(401);
});
