import { test, expect } from './journey';

test('spar with the agent and get an interview question', async ({ page }) => {
  const name = `Journey Spar ${Date.now()}`;
  await page.goto('/');
  await page.getByRole('textbox', { name: 'Name' }).fill(name);
  await page.getByRole('textbox', { name: 'Idea' }).fill('A todo web app.');
  await page.getByRole('button', { name: 'Create product' }).click();
  await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible();

  const message = 'I also want due dates on tasks.';
  await page.getByRole('textbox', { name: 'Your message' }).fill(message);
  await page.getByRole('button', { name: 'Send' }).click();

  const conversation = page.getByRole('list', { name: 'Conversation' });
  await expect(conversation.getByText(message)).toBeVisible();
  await expect(conversation.getByText('Sparring agent')).toBeVisible();
  await expect(page.getByText('Sparring agent replied:')).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Your message' })).toHaveValue('');
});
