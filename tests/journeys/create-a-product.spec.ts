import { test, expect } from "./journey";

test("create a product from the products page", async ({ page }) => {
  const name = `Journey Product ${Date.now()}`;
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Products", level: 1 })).toBeVisible();
  await expect(page.getByRole("banner").getByRole("status")).toHaveText("Live");

  await page.getByRole("textbox", { name: "Name" }).fill(name);
  await page.getByRole("textbox", { name: "Idea" }).fill("A small todo web app used to check the product flow.");
  await page.getByRole("button", { name: "Create product" }).click();

  await expect(page.getByRole("heading", { name, level: 1 })).toBeVisible();
  await expect(page.getByText("No PRD draft yet")).toBeVisible();
  await expect(page.getByRole("button", { name: "Hand off to orchestrator" })).toBeDisabled();

  await page.getByRole("link", { name: "Products" }).click();
  await expect(page.getByRole("link", { name })).toBeVisible();
  await expect(page.getByText("Sparring").first()).toBeVisible();
});
