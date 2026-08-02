import { expect, test } from "@playwright/test";

test("creates a polished mobile-first room entry flow", async ({ page }) => {
  page.on("pageerror", (error) => console.error(`Browser error: ${error.message}`));
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /Can your partner read your mind/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /Create a Game/i })).toBeVisible();
  await page.getByRole("button", { name: /Create a Game/i }).click();
  await expect(page.getByRole("heading", { name: /what should your partner call you/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /Create Our Room/i })).toBeDisabled();
  await page.getByLabel("Your name").fill("Alex");
  await expect(page.getByRole("button", { name: /Create Our Room/i })).toBeEnabled();
});

test("opens shared room links directly in the join flow", async ({ page }) => {
  page.on("pageerror", (error) => console.error(`Browser error: ${error.message}`));
  await page.goto("/?room=LOVE42");
  await expect(page.getByRole("heading", { name: /Join your favourite person/i })).toBeVisible();
  await expect(page.getByLabel("Room code")).toHaveValue("LOVE42");
});
