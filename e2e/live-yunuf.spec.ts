import { expect, test, type Page } from "@playwright/test";

test.describe("live Yunuf multiplayer", () => {
  test.skip(!process.env.LIVE_YUNUF_E2E, "Set LIVE_YUNUF_E2E=1 after applying migration 005");

  test("plays through Show, scoring, elimination, and match victory", async ({ browser, baseURL }) => {
    test.setTimeout(180_000);
    const hostContext = await browser.newContext(); const guestContext = await browser.newContext();
    const host = await hostContext.newPage(); const guest = await guestContext.newPage();
    await host.goto(`${baseURL}/games/yunuf`);
    await host.getByRole("button", { name: /Create a room/i }).click();
    await host.getByLabel("Your name").fill("Live Rakh");
    await host.getByLabel("Elimination score").selectOption("25");
    await host.getByRole("button", { name: "Create table" }).click();
    await expect(host.getByText("Waiting for players")).toBeVisible({ timeout: 15_000 });
    await guest.goto(host.url());
    await guest.getByLabel("Your name").fill("Live Arman");
    await guest.getByRole("button", { name: "Join table" }).click();
    await expect(host.getByText("Live Arman")).toBeVisible({ timeout: 10_000 });
    await Promise.all([host.getByRole("button", { name: "Mark myself ready" }).click(), guest.getByRole("button", { name: "Ready up" }).click()]);
    const firstHand = host.getByText("Hand 1", { exact: true });
    for (let attempt = 0; attempt < 3 && !await firstHand.isVisible(); attempt++) {
      await host.getByRole("button", { name: "Start match" }).click();
      await firstHand.waitFor({ state: "visible", timeout: 4_000 }).catch(() => undefined);
    }
    await expect(firstHand).toBeVisible({ timeout: 10_000 });

    const pages = [host, guest];
    let showDeclaredThisHand = false;
    for (let step = 0; step < 180; step++) {
      const victory = await Promise.all(pages.map((page) => page.getByText(/wins Yunuf|Joint champions/i).isVisible().catch(() => false)));
      if (victory.some(Boolean)) {
        await expect(host.getByRole("button", { name: /Play again/i })).toBeVisible();
        await hostContext.close(); await guestContext.close(); return;
      }
      if (await host.getByRole("button", { name: /Deal next hand/i }).isVisible().catch(() => false)) {
        if (await safeClick(host.getByRole("button", { name: /Deal next hand/i }))) showDeclaredThisHand = false;
        continue;
      }
      let acted = false;
      for (const page of pages) {
        if (!await page.getByText("YOUR TURN", { exact: true }).isVisible().catch(() => false)) continue;
        acted = await takeAction(page, showDeclaredThisHand);
        if (acted && await page.getByRole("button", { name: "Confirm Show" }).isVisible().catch(() => false)) {
          if (await safeClick(page.getByRole("button", { name: "Confirm Show" }))) showDeclaredThisHand = true;
        }
        break;
      }
      if (!acted) await host.waitForTimeout(150);
    }
    throw new Error("Yunuf live match did not resolve within 180 actions");
  });
});

async function takeAction(page: Page, showAlreadyDeclared: boolean) {
  const discard = page.getByRole("button", { name: /^Discard / });
  if (await discard.isVisible().catch(() => false)) {
    const firstCard = page.locator('button[aria-pressed="false"]:not([disabled])').first();
    // The authoritative turn timer can advance while this test is choosing a card.
    // Keep that expected race from consuming the timeout for the whole match.
    try {
      await firstCard.click({ timeout: 2_000 });
      await page.getByRole("button", { name: /^Discard 1/ }).click({ timeout: 2_000 });
      return true;
    } catch {
      return false;
    }
  }
  if (await page.getByText("DRAW ONE CARD", { exact: true }).isVisible().catch(() => false)) {
    return safeClick(page.getByRole("button", { name: /DRAW PILE/i }));
  }
  const show = page.getByRole("button", { name: "Declare Show" });
  if (!showAlreadyDeclared && await show.isEnabled().catch(() => false)) return safeClick(show);
  const end = page.getByRole("button", { name: /End turn/i });
  if (await end.isVisible().catch(() => false)) return safeClick(end);
  return false;
}

async function safeClick(locator: ReturnType<Page["getByRole"]>) {
  try { await locator.click({ timeout: 2_000 }); return true; }
  catch { return false; }
}
