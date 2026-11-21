import { test, expect } from "./journey";

test("pause and resume a build", async ({ page }) => {
  const name = `Journey Pause ${Date.now()}`;
  await page.goto("/");
  await page.getByRole("textbox", { name: "Name" }).fill(name);
  await page.getByRole("textbox", { name: "Idea" }).fill("A todo web app.");
  await page.getByRole("button", { name: "Create product" }).click();
  await expect(page.getByRole("heading", { name, level: 1 })).toBeVisible();

  await page.getByRole("button", { name: "Edit" }).click();
  await page.getByRole("textbox", { name: "PRD markdown" }).fill("# Pause PRD\n\nA todo web app.\n");
  await page.getByRole("button", { name: "Save" }).click();
  await page.getByRole("button", { name: "Hand off to orchestrator" }).click();
  await page.getByRole("button", { name: "Hand off", exact: true }).click();

  await page.getByRole("tab", { name: "Build" }).click();
  await expect(page.getByRole("button", { name: "Pause build" })).toBeVisible();
  await page.getByRole("button", { name: "Pause build" }).click();

  await expect(page.getByText("Paused by you")).toBeVisible();
  await expect(page.getByRole("button", { name: "Resume build" })).toBeVisible();

  await page.getByRole("button", { name: "Resume build" }).click();
  await expect(page.getByRole("button", { name: "Pause build" })).toBeVisible();
  await expect(page.getByText("Paused by you")).toBeHidden();
});
