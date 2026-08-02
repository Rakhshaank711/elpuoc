import { expect, test } from "@playwright/test";

test.describe("live Supabase multiplayer", () => {
  test.skip(!process.env.LIVE_E2E, "Set LIVE_E2E=1 to run against the configured Supabase project");

  test("plays a complete two-device game, switches roles, and starts again", async ({ browser, baseURL }) => {
    const hostContext = await browser.newContext();
    const guestContext = await browser.newContext();
    const host = await hostContext.newPage();
    const guest = await guestContext.newPage();

    await host.goto(baseURL!);
    await host.getByRole("button", { name: /Create a Game/i }).click();
    await host.getByLabel("Your name").fill("Live Host");
    await host.getByRole("button", { name: /Create Our Room/i }).click();
    await expect(host.getByText("Your private room is ready")).toBeVisible({ timeout: 15_000 });

    const inviteUrl = host.url();
    await guest.goto(inviteUrl);
    await guest.getByLabel("Your name").fill("Live Guest");
    await guest.getByRole("button", { name: /Join Their Room/i }).click();
    await expect(guest.getByText("Your private room is ready")).toBeVisible({ timeout: 15_000 });
    await expect(host.getByText("Live Guest")).toBeVisible({ timeout: 10_000 });

    await Promise.all([
      host.getByRole("button", { name: "I'm Ready" }).click(),
      guest.getByRole("button", { name: "I'm Ready" }).click(),
    ]);
    await expect(host.getByText("Round 1")).toBeVisible({ timeout: 10_000 });
    await expect(guest.getByText("Round 1")).toBeVisible({ timeout: 10_000 });

    await guest.getByLabel("Your guess").fill("definitelywrong");
    await guest.getByRole("button", { name: "Submit guess" }).click();
    await expect(guest.getByText("Not quite — keep going!", { exact: true })).toBeVisible();
    await expect(host.getByText(/Live Guest guessed/)).toBeVisible({ timeout: 10_000 });

    for (let word = 0; word < 8; word++) {
      await host.getByRole("button", { name: "Try Another Word" }).click();
      if (word < 7) await expect(host.getByText(`Word ${word + 2} of 8`)).toBeVisible();
    }
    await expect(host.getByText("You survived Round 1")).toBeVisible({ timeout: 10_000 });
    await expect(guest.getByText("You survived Round 1")).toBeVisible({ timeout: 10_000 });

    await Promise.all([
      host.getByRole("button", { name: /Switch Roles/i }).click(),
      guest.getByRole("button", { name: /Switch Roles/i }).click(),
    ]);
    await expect(guest.getByText("Round 2")).toBeVisible({ timeout: 10_000 });

    for (let word = 0; word < 8; word++) {
      await guest.getByRole("button", { name: "Try Another Word" }).click();
      if (word < 7) await expect(guest.getByText(`Word ${word + 2} of 8`)).toBeVisible();
    }
    await expect(host.getByText("You survived Round 2")).toBeVisible({ timeout: 10_000 });

    await Promise.all([
      host.getByRole("button", { name: "See Our Results" }).click(),
      guest.getByRole("button", { name: "See Our Results" }).click(),
    ]);
    await expect(host.getByText("Your couple score")).toBeVisible({ timeout: 10_000 });

    await Promise.all([
      host.getByRole("button", { name: /Play Again/i }).click(),
      guest.getByRole("button", { name: /Play Again/i }).click(),
    ]);
    await expect(host.getByText("Your private room is ready")).toBeVisible({ timeout: 10_000 });

    await hostContext.close();
    await guestContext.close();
  });
});
