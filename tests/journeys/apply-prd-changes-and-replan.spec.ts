import { test, expect } from './journey';

test('apply PRD changes after handoff and replan', async ({ page }) => {
  const name = `Journey Replan ${Date.now()}`;
  await page.goto('/');
  await page.getByRole('textbox', { name: 'Name' }).fill(name);
  await page.getByRole('textbox', { name: 'Idea' }).fill('A todo web app with tasks.');
  await page.getByRole('button', { name: 'Create product' }).click();
  await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible();

  await page.getByRole('button', { name: 'Edit' }).click();
  await page
    .getByRole('textbox', { name: 'PRD markdown' })
    .fill('# Replan PRD\n\nA todo web app.\n');
  await page.getByRole('button', { name: 'Save' }).click();
  await page.getByRole('button', { name: 'Hand off to orchestrator' }).click();
  await page.getByRole('button', { name: 'Hand off', exact: true }).click();
  await expect(page.getByText('No unapplied changes: the draft is PRD v1.')).toBeVisible();

  await page.getByRole('button', { name: 'Edit' }).click();
  await page
    .getByRole('textbox', { name: 'PRD markdown' })
    .fill('# Replan PRD\n\nA todo web app.\n\n## Added\n- Due dates on tasks\n');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Unapplied changes since v1')).toBeVisible();

  await page.getByRole('button', { name: 'Apply changes' }).click();
  await page.getByRole('button', { name: 'Apply', exact: true }).click();

  await expect(page.getByText('No unapplied changes: the draft is PRD v2.')).toBeVisible();
  await expect(
    page.getByRole('list', { name: 'PRD versions' }).getByText('v2', { exact: true }),
  ).toBeVisible();

  await page.getByRole('link', { name: 'Inbox' }).click();
  await expect(page.getByRole('link', { name: `Plan updated for ${name}` }).first()).toBeVisible();
});
