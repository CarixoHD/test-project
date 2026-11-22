import { test, expect } from './journey';

test('product settings are saved and survive a reload', async ({ page }) => {
  const name = `Journey Settings ${Date.now()}`;
  await page.goto('/');
  await page.getByRole('textbox', { name: 'Name' }).fill(name);
  await page.getByRole('textbox', { name: 'Idea' }).fill('A small task manager.');
  await page.getByRole('button', { name: 'Create product' }).click();
  await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible();

  await page.getByRole('tab', { name: 'Settings' }).click();
  await page.getByRole('spinbutton', { name: 'Budget (USD)' }).fill('7');
  await page.getByRole('spinbutton', { name: 'Parallel agents' }).fill('4');
  await page.getByRole('spinbutton', { name: 'Attempts per issue' }).fill('2');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.getByText('Settings saved.')).toBeVisible();

  await page.reload();
  await expect(page.getByRole('spinbutton', { name: 'Budget (USD)' })).toHaveValue('7');
  await expect(page.getByRole('spinbutton', { name: 'Parallel agents' })).toHaveValue('4');
  await expect(page.getByRole('spinbutton', { name: 'Attempts per issue' })).toHaveValue('2');

  await page.getByRole('tab', { name: 'Build' }).click();
  await expect(page.getByText('API spend US$0.00 of US$7.00')).toBeVisible();
});
