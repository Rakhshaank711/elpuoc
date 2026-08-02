import { expect, test } from "@playwright/test";

const session = { playerId: "22222222-2222-4222-8222-222222222222", token: "test-token", code: "LOVE42", name: "Sam", role: "guest" };
const playingState = {
  roomId: "11111111-1111-4111-8111-111111111111", code: "LOVE42", status: "playing", currentRound: 1,
  currentWordIndex: 0, cluesUsed: 2, clueLimit: 15, version: 1,
  messages: [{ id: "44444444-4444-4444-8444-444444444444", senderId: "33333333-3333-4333-8333-333333333333", wordIndex: 0, type: "clue", body: "six strings", wordCount: 2, createdAt: new Date().toISOString() }],
  players: [
    { id: "33333333-3333-4333-8333-333333333333", name: "Alex", role: "host", avatar: 0, ready: false, round1Score: 0, round2Score: 0 },
    { id: session.playerId, name: "Sam", role: "guest", avatar: 1, ready: false, round1Score: 0, round2Score: 0 },
  ],
  you: { id: session.playerId, role: "guest", roundRole: "guesser" },
  round: {
    giverId: "33333333-3333-4333-8333-333333333333", guesserId: session.playerId,
    words: Array.from({ length: 8 }, (_, index) => ({ index, status: index === 0 ? "active" : "pending" })),
    latestClue: "six strings", score: 0,
  },
};

test("organises games for couples and friends", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /Pick a game for your favourite people/i })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Couples" })).toBeVisible();
  await expect(page.getByText("2 players", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Friends" })).toBeVisible();
  await expect(page.getByText("2+ players", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: /15 Words/i }).click();
  await expect(page.getByRole("heading", { name: /Can your partner read your mind/i })).toBeVisible();
});

test("creates a polished mobile-first room entry flow", async ({ page }) => {
  page.on("pageerror", (error) => console.error(`Browser error: ${error.message}`));
  await page.goto("/games/15-words");
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

test("gives immediate, rewarding feedback for guesses", async ({ page }) => {
  await page.addInitScript((storedSession) => localStorage.setItem("15words:LOVE42", JSON.stringify(storedSession)), session);
  await page.route("**/api/game?**", (route) => route.fulfill({ json: { state: playingState } }));
  await page.route("**/api/game", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const body = route.request().postDataJSON();
    await new Promise((resolve) => setTimeout(resolve, 350));
    if (body.guess === "piano") return route.fulfill({ status: 422, json: { error: "Not quite — try again", code: "WRONG_GUESS" } });
    return route.fulfill({ json: { state: { ...playingState, currentWordIndex: 1, version: 2, round: { ...playingState.round, score: 1 } } } });
  });

  await page.goto("/?room=LOVE42");
  await expect(page.getByText("six strings")).toBeVisible();
  await page.getByLabel("Your guess").fill("piano");
  await page.getByRole("button", { name: "Submit guess" }).click();
  await expect(page.getByText("Sending…")).toBeVisible();
  await expect(page.getByText("Not quite — keep going!")).toBeVisible();
  await expect(page.getByRole("button", { name: "Ask for a clue" })).toBeVisible();
  await expect(page.getByLabel("Your guess")).toHaveValue("piano");

  await page.getByLabel("Your guess").fill("guitar");
  await page.getByRole("button", { name: "Submit guess" }).click();
  await expect(page.getByText("That’s it — one point closer!")).toBeVisible();
  await expect(page.getByText("1 pts")).toBeVisible();
});

test("lets the clue giver offer more help or move to another word", async ({ page }) => {
  const giverSession = { ...session, playerId: playingState.players[0].id, name: "Alex", role: "host" };
  const giverState = {
    ...playingState,
    you: { id: giverSession.playerId, role: "host", roundRole: "giver" },
    round: {
      ...playingState.round,
      words: Array.from({ length: 8 }, (_, index) => ({ index, word: index === 0 ? "Guitar" : `Word ${index + 1}`, status: index === 0 ? "active" : "pending" })),
    },
  };
  await page.addInitScript((storedSession) => localStorage.setItem("15words:LOVE42", JSON.stringify(storedSession)), giverSession);
  await page.route("**/api/game?**", (route) => route.fulfill({ json: { state: giverState } }));
  await page.route("**/api/game", (route) => route.request().method() === "POST" ? route.fulfill({ json: { state: giverState } }) : route.continue());

  await page.goto("/?room=LOVE42");
  await expect(page.getByText("Take your time")).toBeVisible();
  await expect(page.getByRole("button", { name: "Offer Another Clue" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Try Another Word" })).toBeVisible();
  await page.getByRole("button", { name: "Offer Another Clue" }).click();
  await expect(page.getByRole("button", { name: "Offer Sent" })).toBeVisible();

  await page.getByRole("button", { name: "Go to home" }).click();
  await expect(page.getByRole("heading", { name: "Go back home?" })).toBeVisible();
  await page.getByRole("button", { name: "Stay Here" }).click();
  await expect(page.getByRole("heading", { name: "Go back home?" })).not.toBeVisible();
  await page.getByRole("button", { name: "Go to home" }).click();
  await page.getByRole("button", { name: "Go Home" }).click();
  await expect(page.getByRole("heading", { name: /Pick a game for your favourite people/i })).toBeVisible();
});
