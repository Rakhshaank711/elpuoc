import { describe, expect, it } from "vitest";
import { createLobbyState, discardCards, drawFromDeck, startMatch } from "./engine";
import { createYunufEvents, redactYunufState } from "./server";
import type { YunufPlayer } from "./types";
import { yunufActionSchema } from "./validation";

const ids = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];
const player = (id: string, seatIndex: number): YunufPlayer => ({ id, name: `Player ${seatIndex}`, avatar: 0, seatIndex, hand: [], ready: true, connected: true, eliminated: false, totalScore: 0, roundScore: 0, handsWon: 0, jointWins: 0, showsDeclared: 0, successfulShows: 0, failedShows: 0, revealHandTotalSum: 0, reveals: 0 });

describe("Yunuf server boundaries", () => {
  it("removes deck order and opponent hands from an active response", () => {
    const state = startMatch(createLobbyState(ids.map(player)), { random: () => .3, now: 1, id: () => "initial" });
    const room = { id: "33333333-3333-4333-8333-333333333333", code: "YUNUF5", status: state.status, host_player_id: ids[0], version: 2, elimination_score: 100, turn_duration_seconds: 30, game_state: state };
    const actor = { id: ids[0], room_id: room.id, name: "Player 0", avatar: 0, seat: 0, role: "host" as const, token_hash: "x".repeat(64), ready: true };
    const view = redactYunufState(room, actor, state);
    expect("drawPile" in view).toBe(false);
    expect(view.drawPileCount).toBe(41);
    expect(view.players[0].hand).toHaveLength(5);
    expect(view.players[1].hand).toBeUndefined();
    expect(view.players[1].cardCount).toBe(5);
  });

  it("reveals every hand only after resolution", () => {
    const active = startMatch(createLobbyState(ids.map(player)), { random: () => .3, now: 1, id: () => "initial" });
    const state = { ...active, status: "hand_results" as const };
    const room = { id: "33333333-3333-4333-8333-333333333333", code: "YUNUF5", status: state.status, host_player_id: ids[0], version: 3, elimination_score: 100, turn_duration_seconds: 30, game_state: state };
    const actor = { id: ids[0], room_id: room.id, name: "Player 0", avatar: 0, seat: 0, role: "host" as const, token_hash: "x".repeat(64), ready: true };
    expect(redactYunufState(room, actor, state).players.every((item) => item.hand?.length === 5)).toBe(true);
  });

  it("requires version and idempotency IDs for important moves", () => {
    expect(yunufActionSchema.safeParse({ action: "discard", code: "YUNUF5", cardIds: ["hearts-A"] }).success).toBe(false);
    expect(yunufActionSchema.safeParse({ action: "discard", code: "YUNUF5", cardIds: ["hearts-A"], expectedVersion: 2, actionId: "44444444-4444-4444-8444-444444444444" }).success).toBe(true);
    expect(yunufActionSchema.safeParse({ action: "end_room", code: "YUNUF5", expectedVersion: 2, actionId: "44444444-4444-4444-8444-444444444444" }).success).toBe(true);
    expect(yunufActionSchema.safeParse({ action: "end_room", code: "YUNUF5", expectedVersion: 2 }).success).toBe(false);
  });

  it("keeps a public server-authored audit without leaking deck draws", () => {
    const active = startMatch(createLobbyState(ids.map(player)), { random: () => .3, now: 1, id: () => "initial" });
    const actorId = active.currentPlayerId!; const owned = active.players.find((item) => item.id === actorId)!.hand[0];
    const discarded = discardCards(active, actorId, [owned.id], { now: 2, id: () => "discard" });
    const discardAction = { action: "discard" as const, code: "YUNUF5", expectedVersion: 2, actionId: "44444444-4444-4444-8444-444444444444", cardIds: [owned.id] };
    const discardEvents = createYunufEvents(active, discarded, discardAction, actorId);
    const drawn = drawFromDeck(discarded, actorId, { now: 3, random: () => .2 });
    const drawAction = { action: "draw_deck" as const, code: "YUNUF5", expectedVersion: 3, actionId: "55555555-5555-4555-8555-555555555555" };
    const drawEvents = createYunufEvents(discarded, drawn, drawAction, actorId);
    expect([...discardEvents, ...drawEvents].map((event) => event.type)).toEqual(["discard", "draw_deck", "turn_ended"]);
    expect(discardEvents[0].cards).toEqual([owned]);
    expect(drawEvents[0].cards).toBeUndefined();
  });
});
