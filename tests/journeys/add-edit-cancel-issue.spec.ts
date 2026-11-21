import { test, expect } from "./journey";

test("add, edit and cancel an issue", async ({ page }) => {
  const name = `Journey Issues ${Date.now()}`;
  await page.goto("/");
  await page.getByRole("textbox", { name: "Name" }).fill(name);
  await page.getByRole("textbox", { name: "Idea" }).fill("A tool to keep track of my tasks.");
  await page.getByRole("button", { name: "Create product" }).click();
  await expect(page.getByRole("heading", { name, level: 1 })).toBeVisible();

  await page.getByRole("tab", { name: "Build" }).click();
  await page.getByRole("button", { name: "Add issue" }).click();
  await page.getByRole("textbox", { name: "Title" }).fill("Add a README with setup instructions");
  await page.getByRole("textbox", { name: "Body (markdown)" }).fill("Describe how to install and run the app.");
  await page.getByRole("button", { name: "Create issue" }).click();

  const openList = page.getByRole("list", { name: "Open" });
  await expect(openList.getByRole("link", { name: /Add a README with setup instructions/ })).toBeVisible();
  await openList.getByRole("link", { name: /Add a README/ }).click();

  await expect(page.getByRole("heading", { name: /Add a README with setup instructions/, level: 1 })).toBeVisible();
  await expect(page.getByText("Open", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: /Edit issue/ }).click();
  await page.getByRole("textbox", { name: "Title" }).fill("Add a README with setup and test instructions");
  await page.getByRole("combobox", { name: "Priority" }).selectOption("High");
  await page.getByRole("button", { name: "Save changes" }).click();

  await expect(page.getByRole("heading", { name: /Add a README with setup and test instructions/, level: 1 })).toBeVisible();
  await expect(page.getByText("High", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: /Cancel issue/ }).click();
  await page.getByRole("button", { name: "Cancel issue", exact: true }).click();
  await expect(page.getByText("Cancelled", { exact: true })).toBeVisible();
});
