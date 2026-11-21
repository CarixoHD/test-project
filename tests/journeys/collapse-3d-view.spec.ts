import { test, expect } from "./journey";

test("the 3D view can be collapsed and expanded", async ({ page }) => {
  const name = `Journey Scene ${Date.now()}`;
  await page.goto("/");
  await page.getByRole("textbox", { name: "Name" }).fill(name);
  await page.getByRole("textbox", { name: "Idea" }).fill("A todo web app.");
  await page.getByRole("button", { name: "Create product" }).click();
  await expect(page.getByRole("heading", { name, level: 1 })).toBeVisible();

  await page.getByRole("tab", { name: "Build" }).click();
  const toggle = page.getByRole("button", { name: "3D view" });
  const scene = page.locator("canvas").first();

  if ((await toggle.getAttribute("aria-expanded")) === "false") {
    await toggle.click();
  }
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(scene).toBeVisible();

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(scene).toBeHidden();

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(scene).toBeVisible();
});
