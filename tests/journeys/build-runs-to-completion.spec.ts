import { test, expect } from './journey';

test('a handed-off build runs to completion and lands in the inbox', async ({ page }) => {
  const name = `Journey Build ${Date.now()}`;
  await page.goto('/');
  await page.getByRole('textbox', { name: 'Name' }).fill(name);
  await page
    .getByRole('textbox', { name: 'Idea' })
    .fill('A todo web app with tasks I can add and complete.');
  await page.getByRole('button', { name: 'Create product' }).click();
  await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible();

  await page.getByRole('button', { name: 'Edit' }).click();
  await page
    .getByRole('textbox', { name: 'PRD markdown' })
    .fill('# Build PRD\n\nA todo web app.\n');
  await page.getByRole('button', { name: 'Save' }).click();
  await page.getByRole('button', { name: 'Hand off to orchestrator' }).click();
  await page.getByRole('button', { name: 'Hand off', exact: true }).click();

  await page.getByRole('link', { name: 'Inbox' }).click();
  await expect(page.getByRole('link', { name: `${name} is complete` }).first()).toBeVisible();

  await page.getByRole('link', { name: 'Products' }).click();
  await page.getByRole('link', { name }).click();
  await page.getByRole('tab', { name: 'Build' }).click();
  const completed = page.getByRole('list', { name: 'Completed' });
  await expect(completed.getByRole('link').first()).toBeVisible();
  await expect(page.getByText('No agents are running.')).toBeVisible();
});
