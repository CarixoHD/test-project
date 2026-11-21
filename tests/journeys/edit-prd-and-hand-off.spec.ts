import { test, expect } from "./journey";

test("edit the PRD and hand off to the orchestrator", async ({ page }) => {
  const name = `Journey Spec ${Date.now()}`;
  await page.goto("/");
  await page.getByRole("textbox", { name: "Name" }).fill(name);
  await page.getByRole("textbox", { name: "Idea" }).fill("A todo web app with tasks I can add and complete.");
  await page.getByRole("button", { name: "Create product" }).click();
  await expect(page.getByRole("heading", { name, level: 1 })).toBeVisible();

  await page.getByRole("button", { name: "Edit" }).click();
  await page
    .getByRole("textbox", { name: "PRD markdown" })
    .fill("# Todo PRD\n\n## Features\n- Add tasks\n- Complete tasks\n");
  await page.getByRole("button", { name: "Save" }).click();

  await expect(page.getByRole("heading", { name: "Todo PRD", level: 1 })).toBeVisible();
  await expect(page.getByRole("button", { name: "Hand off to orchestrator" })).toBeEnabled();

  await page.getByRole("button", { name: "Hand off to orchestrator" }).click();
  await page.getByRole("button", { name: "Hand off", exact: true }).click();

  await expect(page.getByRole("region", { name: "PRD changes" })).toBeVisible();
  await expect(page.getByText("No unapplied changes: the draft is PRD v1.")).toBeVisible();
  await expect(page.getByText("Handed off to the orchestrator.")).toBeVisible();
});
