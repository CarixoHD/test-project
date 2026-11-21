import { test, expect } from "./journey";

test("a completed issue shows its attempt log and diff", async ({ page }) => {
  const name = `Journey Attempts ${Date.now()}`;
  await page.goto("/");
  await page.getByRole("textbox", { name: "Name" }).fill(name);
  await page.getByRole("textbox", { name: "Idea" }).fill("A todo web app with tasks.");
  await page.getByRole("button", { name: "Create product" }).click();
  await expect(page.getByRole("heading", { name, level: 1 })).toBeVisible();

  await page.getByRole("button", { name: "Edit" }).click();
  await page.getByRole("textbox", { name: "PRD markdown" }).fill("# Attempts PRD\n\nA todo web app.\n");
  await page.getByRole("button", { name: "Save" }).click();
  await page.getByRole("button", { name: "Hand off to orchestrator" }).click();
  await page.getByRole("button", { name: "Hand off", exact: true }).click();

  await page.getByRole("link", { name: "Inbox" }).click();
  await expect(page.getByRole("link", { name: `${name} is complete` }).first()).toBeVisible();

  await page.getByRole("link", { name: "Products" }).click();
  await page.getByRole("link", { name }).click();
  await page.getByRole("list", { name: "Completed" }).getByRole("link").first().click();

  await expect(page.getByRole("heading", { name: "Attempt 1" })).toBeVisible();
  await expect(page.getByText("Merged", { exact: true })).toBeVisible();
  await expect(page.getByText(/exited ok/).first()).toBeVisible();

  await page.getByRole("tab", { name: "Diff" }).click();
  await expect(page.getByText(/diff --git/).first()).toBeVisible();
});
