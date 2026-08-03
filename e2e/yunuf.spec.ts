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
    if (body.action === "draw_discard") { await new Promise((resolve) => setTimeout(resolve, 1_200)); mockedState = { ...afterDiscardState, version: 3, currentPlayerId: guestId, turnNumber: 2, turnPhase: "discard", players: [{ ...baseState.players[0], hand: [hand[4], card("c-8", "8", "clubs")], cardCount: 2 }, baseState.players[1]], drawSourceDiscard: afterDiscardState.latestDiscard }; }
    return route.fulfill({ json: { state: mockedState } });
  });
  await page.goto("/games/yunuf?room=YUNUF5");
  await expect(page.getByLabel("5 cards in hand")).toHaveCount(2);
  for (const label of ["Q of hearts", "K of clubs", "A of diamonds", "2 of spades"]) await page.getByRole("button", { name: label }).click();
  await expect(page.getByText("TOP", { exact: true })).toBeVisible();
  await expect(page.getByText(/Valid sequence · 2 will stay on top/)).toBeVisible();
  await page.getByRole("button", { name: "Discard 4 · 2 on top" }).click();
  const discardOrigins = await page.waitForFunction(() => {
    const elements = [...document.querySelectorAll<HTMLElement>(".yunuf-card-motion-discard.yunuf-card-motion-large")];
    return elements.length === 4 ? elements.map((element) => Number(element.style.getPropertyValue("--from-x").replace("px", ""))) : null;
  }).then((handle) => handle.jsonValue());
  if (!discardOrigins) throw new Error("Discard animation did not start.");
  expect(Math.max(...discardOrigins) - Math.min(...discardOrigins)).toBeGreaterThan(120);
  await expect(page.getByText("DRAW ONE CARD")).toBeVisible();
  await expect(page.getByLabel("Current discard: 2 of spades")).toBeVisible();
  const topDiscard = page.getByRole("button", { name: "Draw top discard: 8 of clubs" });
  await expect(topDiscard).toBeEnabled();
  await expect(topDiscard.getByText("DRAWABLE TOP")).toBeVisible();
  const deckBox = await page.getByRole("button", { name: "Draw from face-down deck" }).boundingBox();
  const topBox = await topDiscard.boundingBox();
  const currentDiscard = page.getByLabel("Current discard: 2 of spades");
  const currentBox = await currentDiscard.boundingBox();
  const badgeBox = await currentDiscard.getByText("4", { exact: true }).boundingBox();
  expect(Math.abs((deckBox!.x + deckBox!.width / 2) - (topBox!.x + topBox!.width / 2))).toBeLessThan(110);
  expect(currentBox!.x).toBeGreaterThan(topBox!.x);
  expect(badgeBox!.x).toBeGreaterThan(currentBox!.x + currentBox!.width - badgeBox!.width);
  expect(badgeBox!.y).toBeLessThan(currentBox!.y + 4);
  await topDiscard.click();
  await expect(page.locator(".yunuf-card-motion-draw")).toHaveCount(1);
  await expect(page.locator(".yunuf-card-motion-merge")).toHaveCount(4);
  await expect(page.locator(".yunuf-incoming-hand-card")).toBeVisible({ timeout: 900 });
  await expect(topDiscard.getByText("8", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Your hand · 15 points")).toBeVisible();
  await expect(page.getByRole("button", { name: "8 of clubs" })).toBeVisible({ timeout: 2_000 });
});

test("shows observers a new discard before the active player draws", async ({ page }) => {
  const guestSession = { playerId: guestId, token: "guest-token", code: "YUNUF5", name: "Arman", role: "guest" };
  const observerState = {
    ...baseState,
    version: 2,
    you: { id: guestId, role: "guest" },
    turnPhase: "draw",
    latestDiscard: { id: "fresh-discard", playerId: hostId, cards: [card("h-q", "Q", "hearts")], playType: "single", createdAt: Date.now() },
    players: [
      { ...baseState.players[0], hand: undefined, cardCount: 4 },
      { ...baseState.players[1], hand: opponentHand, cardCount: 5 },
    ],
  };
  await page.addInitScript((stored) => localStorage.setItem("yunuf:YUNUF5", JSON.stringify(stored)), guestSession);
  await page.route("**/api/yunuf?**", (route) => route.fulfill({ json: { state: observerState } }));

  await page.goto("/games/yunuf?room=YUNUF5");

  await expect(page.getByLabel("Current discard: Q of hearts")).toBeVisible();
  const drawablePile = page.getByRole("button", { name: "Draw top discard: 8 of clubs" });
  await expect(drawablePile).toBeDisabled();
  await expect(drawablePile.getByText("DRAWABLE TOP")).toBeVisible();
});

test("never lets a delayed snapshot remove a newly drawn card", async ({ page }) => {
  const remainingCard = card("h-7", "7", "hearts");
  const drawnCard = card("c-8", "8", "clubs");
  const staleState = {
    ...baseState,
    version: 2,
    turnPhase: "draw",
    players: [{ ...baseState.players[0], hand: [remainingCard], cardCount: 1 }, baseState.players[1]],
  };
  const freshState = {
    ...staleState,
    version: 3,
    currentPlayerId: guestId,
    turnNumber: 2,
    turnPhase: "discard",
    players: [{ ...baseState.players[0], hand: [remainingCard, drawnCard], cardCount: 2 }, baseState.players[1]],
  };
  let delayNextGet = false;
  let delayedGetStarted = false;

  await page.addInitScript((stored) => localStorage.setItem("yunuf:YUNUF5", JSON.stringify(stored)), session);
  await page.route("**/api/yunuf?**", async (route) => {
    if (delayNextGet) {
      delayNextGet = false;
      delayedGetStarted = true;
      await new Promise((resolve) => setTimeout(resolve, 1_200));
    }
    await route.fulfill({ json: { state: staleState } });
  });
  await page.route("**/api/yunuf", (route) => route.fulfill({ json: { state: freshState } }));

  await page.goto("/games/yunuf?room=YUNUF5");
  await expect(page.getByText("DRAW ONE CARD")).toBeVisible();
  delayNextGet = true;
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect.poll(() => delayedGetStarted).toBe(true);

  await page.getByRole("button", { name: "Draw top discard: 8 of clubs" }).click();
  await expect(page.getByRole("button", { name: "8 of clubs", exact: true })).toBeVisible();
  await page.waitForTimeout(1_300);
  await expect(page.getByRole("button", { name: "8 of clubs", exact: true })).toBeVisible();
  await expect(page.getByText("Your hand · 15 points")).toBeVisible();
});

test("lets the host permanently end the room after confirmation", async ({ page }) => {
  let receivedAction = "";
  await page.addInitScript((stored) => localStorage.setItem("yunuf:YUNUF5", JSON.stringify(stored)), session);
  await page.route("**/api/yunuf?**", (route) => route.fulfill({ json: { state: baseState } }));
  await page.route("**/api/yunuf", async (route) => {
    receivedAction = route.request().postDataJSON().action;
    return route.fulfill({ json: { ended: true } });
  });
  page.once("dialog", (dialog) => dialog.accept());

  await page.goto("/games/yunuf?room=YUNUF5");
  await page.getByRole("button", { name: "End room", exact: true }).click();

  await expect.poll(() => receivedAction).toBe("end_room");
  await expect(page.getByRole("heading", { name: "This table has ended." })).toBeVisible();
  await expect(page.getByText("You ended the room for everyone.", { exact: false })).toBeVisible();
  await expect(page.evaluate(() => localStorage.getItem("yunuf:YUNUF5"))).resolves.toBeNull();
});

test("recognises a room ended while a player was disconnected", async ({ page }) => {
  await page.addInitScript((stored) => localStorage.setItem("yunuf:YUNUF5", JSON.stringify(stored)), session);
  await page.route("**/api/yunuf?**", (route) => route.fulfill({ status: 404, json: { error: "Room not found." } }));

  await page.goto("/games/yunuf?room=YUNUF5");

  await expect(page.getByRole("heading", { name: "This table has ended." })).toBeVisible();
  await expect(page.getByText("The host ended the room.", { exact: false })).toBeVisible();
});

test("smoothly arranges cards only while arrange mode is active", async ({ page }) => {
  await page.addInitScript((stored) => localStorage.setItem("yunuf:YUNUF5", JSON.stringify(stored)), session);
  await page.route("**/api/yunuf?**", (route) => route.fulfill({ json: { state: baseState } }));
  await page.goto("/games/yunuf?room=YUNUF5");
  const cards = page.locator("[data-hand-card]");
  await expect(cards).toHaveCount(5);
  await cards.first().click();
  await expect(cards.first()).toHaveAttribute("aria-pressed", "true");
  await cards.first().click();
  await page.getByRole("button", { name: "Arrange cards" }).click();
  await expect(page.getByRole("button", { name: "Finish arranging cards" })).toHaveAttribute("aria-pressed", "true");
  const first = cards.first();
  const last = cards.last();
  const firstBox = await first.boundingBox();
  const lastBox = await last.boundingBox();
  expect(firstBox).not.toBeNull();
  expect(lastBox).not.toBeNull();
  await page.mouse.move(firstBox!.x + firstBox!.width / 2, firstBox!.y + firstBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(lastBox!.x + lastBox!.width + 12, lastBox!.y + lastBox!.height / 2, { steps: 8 });
  await expect(page.locator(".yunuf-drag-ghost")).toBeVisible();
  await page.mouse.up();
  await expect(page.locator(".yunuf-drag-ghost")).toHaveCount(0);
  await expect(cards.last()).toHaveAttribute("aria-label", "Q of hearts");
  await expect(cards.last()).toHaveAttribute("aria-pressed", "false");
  await page.getByRole("button", { name: "Finish arranging cards" }).click();
  await cards.last().click();
  await expect(cards.last()).toHaveAttribute("aria-pressed", "true");
});

test("offers five seconds for Show and then passes automatically", async ({ page }) => {
  const decisionState = { ...baseState, version: 5, completedRounds: 3, turnPhase: "decision", turnStartedAt: Date.now() };
  const passedState = { ...decisionState, version: 6, currentPlayerId: guestId, turnNumber: 2, turnPhase: "discard", turnStartedAt: Date.now() + 5_000 };
  let submittedAction = "";
  await page.addInitScript((stored) => localStorage.setItem("yunuf:YUNUF5", JSON.stringify(stored)), session);
  await page.route("**/api/yunuf?**", (route) => route.fulfill({ json: { state: decisionState } }));
  await page.route("**/api/yunuf", (route) => {
    submittedAction = route.request().postDataJSON().action;
    return route.fulfill({ json: { state: passedState } });
  });

  await page.goto("/games/yunuf?room=YUNUF5");
  await expect(page.getByRole("button", { name: "Pass turn" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Declare Show, [1-5] seconds left/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "End turn" })).toHaveCount(0);
  await expect.poll(() => submittedAction, { timeout: 6_500 }).toBe("end_turn");
  await expect(page.getByText("Waiting for Arman")).toBeVisible();
});

test("dramatically announces Show and dims the waiting player table", async ({ page }) => {
  const showState = {
    ...baseState,
    version: 7,
    status: "finishing_round_after_show",
    completedRounds: 3,
    currentPlayerId: guestId,
    showState: { active: true, declarerId: hostId, resolveAfterPlayerId: guestId, declaredAtTurnNumber: 4 },
  };
  await page.addInitScript((stored) => localStorage.setItem("yunuf:YUNUF5", JSON.stringify(stored)), session);
  await page.route("**/api/yunuf?**", (route) => route.fulfill({ json: { state: showState } }));
  await page.goto("/games/yunuf?room=YUNUF5");
  await expect(page.getByText("SHOW!", { exact: true })).toBeVisible();
  await expect(page.getByText("RAKH CALLED SHOW")).toBeVisible();
  await expect(page.locator("main.yunuf-waiting-turn")).toBeVisible();
  const playingTag = page.locator(`[data-player-card="${guestId}"]`).getByText("PLAYING");
  await expect(playingTag).toBeVisible();
  const tagBox = await playingTag.boundingBox();
  const railBox = await page.locator(".yunuf-player-rail").boundingBox();
  expect(tagBox!.y).toBeGreaterThanOrEqual(railBox!.y);
  const dimLevels = await page.evaluate(() => ({
    boardControl: Number(getComputedStyle(document.querySelector(".yunuf-waiting-board > div:nth-child(2)")!).opacity),
    localHand: Number(getComputedStyle(document.querySelector(".yunuf-local-hand")!).opacity),
  }));
  expect(dimLevels.localHand).toBeGreaterThan(dimLevels.boardControl);
  expect(dimLevels.localHand).toBeGreaterThanOrEqual(.8);
  await expect(page.getByText("Waiting for Arman")).toBeVisible();
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
