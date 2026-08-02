import { expect, test } from "@playwright/test";

const hostId = "11111111-1111-4111-8111-111111111111";
const guestId = "22222222-2222-4222-8222-222222222222";
const roomId = "33333333-3333-4333-8333-333333333333";
const session = { playerId: hostId, token: "test-token", code: "YUNUF5", name: "Rakh", role: "host" };
const card = (id: string, rank: string, suit: string) => ({ id, rank, suit });
const hand = [card("h-q", "Q", "hearts"), card("c-k", "K", "clubs"), card("d-a", "A", "diamonds"), card("s-2", "2", "spades"), card("h-7", "7", "hearts")];
const opponentHand = [card("s-3", "3", "spades"), card("s-4", "4", "spades"), card("s-5", "5", "spades"), card("s-9", "9", "spades"), card("s-j", "J", "spades")];
const baseState = {
  roomId, code: "YUNUF5", version: 1, hostPlayerId: hostId, you: { id: hostId, role: "host" },
  status: "playing", handNumber: 1, activePlayerIds: [hostId, guestId], currentPlayerId: hostId, startingPlayerId: hostId,
  turnNumber: 1, turnPhase: "discard", turnStartedAt: Date.now(), turnDurationSeconds: 30, completedRounds: 0,
  playersWhoActedThisRound: [], drawPileCount: 40, discardHistory: [],
  latestDiscard: { id: "initial", playerId: "deck", cards: [card("c-8", "8", "clubs")], playType: "single", createdAt: Date.now() },
  drawSourceDiscard: { id: "initial", playerId: "deck", cards: [card("c-8", "8", "clubs")], playType: "single", createdAt: Date.now() },
  showState: { active: false, declarerId: null, resolveAfterPlayerId: null, declaredAtTurnNumber: null },
  eliminationScore: 100, failedShowPenalty: 10, result: null,
  players: [
    { id: hostId, name: "Rakh", avatar: 0, seatIndex: 1, hand, cardCount: 5, ready: false, connected: true, eliminated: false, totalScore: 0, roundScore: 0, handsWon: 0, jointWins: 0, showsDeclared: 0, successfulShows: 0, failedShows: 0, revealHandTotalSum: 0, reveals: 0 },
    { id: guestId, name: "Arman", avatar: 1, seatIndex: 2, cardCount: 5, ready: false, connected: true, eliminated: false, totalScore: 0, roundScore: 0, handsWon: 0, jointWins: 0, showsDeclared: 0, successfulShows: 0, failedShows: 0, revealHandTotalSum: 0, reveals: 0 },
  ],
};

test("opens Yunuf from the friends category", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: /Yunuf/i }).click();
  await expect(page.getByRole("heading", { name: /Drop cards/i })).toBeVisible();
  await expect(page.getByText("2–5 players", { exact: false })).toBeVisible();
});

test("opens shared Yunuf links in the join flow", async ({ page }) => {
  await page.goto("/games/yunuf?room=YUNUF5");
  await expect(page.getByRole("heading", { name: "Join the table." })).toBeVisible();
  await expect(page.getByLabel("Room code")).toHaveValue("YUNUF5");
});

test("shows the persistent server game history", async ({ page }) => {
  await page.addInitScript((stored) => localStorage.setItem("yunuf:YUNUF5", JSON.stringify(stored)), session);
  await page.route("**/api/yunuf?**", (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("view") === "log") return route.fulfill({ json: { events: [{ id: "44444444-4444-4444-8444-444444444444", type: "match_started", playerId: hostId, handNumber: 1, turnNumber: 1, createdAt: Date.now(), cards: [card("c-8", "8", "clubs")] }] } });
    return route.fulfill({ json: { state: baseState } });
  });
  await page.goto("/games/yunuf?room=YUNUF5");
  await page.getByRole("button", { name: "Open game log" }).click();
  await expect(page.getByRole("heading", { name: "Game history" })).toBeVisible();
  await expect(page.getByText(/Rakh started the match · 8♣ opened the pile/)).toBeVisible();
  await expect(page.getByText(/deck-card identities remain private/)).toBeVisible();
  await page.getByRole("button", { name: "Close game log" }).click();
  await expect(page.getByRole("heading", { name: "Game history" })).not.toBeVisible();
});

test("validates a circular mixed-suit run and advances to drawing", async ({ page }) => {
  const afterDiscardState = { ...baseState, version: 2, turnPhase: "draw", players: [{ ...baseState.players[0], hand: [hand[4]], cardCount: 1 }, baseState.players[1]], latestDiscard: { id: "play", playerId: hostId, cards: hand.slice(0, 4), playType: "sequence", createdAt: Date.now() } };
  let mockedState: unknown = baseState;
  await page.addInitScript((stored) => localStorage.setItem("yunuf:YUNUF5", JSON.stringify(stored)), session);
  await page.route("**/api/yunuf?**", (route) => route.fulfill({ json: { state: mockedState } }));
  await page.route("**/api/yunuf", async (route) => {
    const body = route.request().postDataJSON();
    if (body.action === "discard") mockedState = afterDiscardState;
    if (body.action === "draw_discard") { await new Promise((resolve) => setTimeout(resolve, 1_200)); mockedState = { ...afterDiscardState, version: 3, turnPhase: "decision", players: [{ ...baseState.players[0], hand: [hand[4], card("c-8", "8", "clubs")], cardCount: 2 }, baseState.players[1]], drawSourceDiscard: null }; }
    return route.fulfill({ json: { state: mockedState } });
  });
  await page.goto("/games/yunuf?room=YUNUF5");
  await expect(page.getByLabel("5 cards in hand")).toHaveCount(2);
  for (const label of ["Q of hearts", "K of clubs", "A of diamonds", "2 of spades"]) await page.getByRole("button", { name: label }).click();
  await expect(page.getByText("TOP", { exact: true })).toBeVisible();
  await expect(page.getByText(/Valid sequence · 2 will stay on top/)).toBeVisible();
  await page.getByRole("button", { name: "Discard 4 · 2 on top" }).click();
  await expect(page.locator(".yunuf-card-motion-discard")).toHaveCount(4);
  const discardOrigins = await page.locator(".yunuf-card-motion-discard").evaluateAll((elements) => elements.map((element) => Number((element as HTMLElement).style.getPropertyValue("--from-x").replace("px", ""))));
  expect(Math.max(...discardOrigins) - Math.min(...discardOrigins)).toBeGreaterThan(120);
  await expect(page.locator(".yunuf-card-motion-large")).toHaveCount(4);
  await expect(page.getByText("DRAW ONE CARD")).toBeVisible();
  const topDiscard = page.getByRole("button", { name: "Draw top discard: 8 of clubs" });
  await expect(topDiscard).toBeEnabled();
  await topDiscard.click();
  await expect(page.locator(".yunuf-card-motion-draw")).toHaveCount(1);
  await expect(page.locator(".yunuf-incoming-hand-card")).toBeVisible({ timeout: 900 });
  await expect(topDiscard.getByText("8", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Your hand · 15 points")).toBeVisible();
  await expect(page.getByRole("button", { name: "8 of clubs" })).toBeVisible({ timeout: 2_000 });
});

test("reveals every hand and scores after Show", async ({ page }) => {
  const resultState = {
    ...baseState, status: "hand_results", version: 4, currentPlayerId: null, turnStartedAt: null,
    players: [{ ...baseState.players[0], hand, cardCount: 5, totalScore: 0 }, { ...baseState.players[1], hand: opponentHand, cardCount: 5, roundScore: 19, totalScore: 19 }],
    result: { declarerId: hostId, handValues: { [hostId]: 31, [guestId]: 31 }, winnerIds: [hostId, guestId], declarerWon: true, roundScores: { [hostId]: 0, [guestId]: 0 }, eliminatedIds: [], matchWinnerIds: [] },
  };
  await page.addInitScript((stored) => localStorage.setItem("yunuf:YUNUF5", JSON.stringify(stored)), session);
  await page.route("**/api/yunuf?**", (route) => route.fulfill({ json: { state: resultState } }));
  await page.goto("/games/yunuf?room=YUNUF5");
  await expect(page.getByRole("heading", { name: "Joint winners!" })).toBeVisible();
  await expect(page.getByText("Hand 1 revealed")).toBeVisible();
  await expect(page.getByRole("button", { name: /Deal next hand/i })).toBeVisible();
});

test("offers a database-free rules lab", async ({ page }) => {
  await page.goto("/games/yunuf/demo");
  await expect(page.getByText("RULES LAB")).toBeVisible();
  await page.getByRole("button", { name: "Inject Q–K–A–2" }).click();
  await expect(page.getByText("Local-only simulation", { exact: false })).toBeVisible();
  await expect(page.getByText("30 pts")).toBeVisible();
});
