import { describe, expect, it } from "vitest";
import type { Card, Rank, Suit, YunufGameState, YunufPlayer } from "./types";
import { autoPlayExpiredTurn, createLobbyState, declareShow, discardCards, drawFromDeck, drawFromDiscard, endTurn, startMatch, YunufRuleError } from "./engine";
import { eligibleDiscardDrawIds } from "./rules";

const card = (rank: Rank, suit: Suit = "hearts"): Card => ({ id: `${suit}-${rank}`, suit, rank });
const player = (id: string, hand: Card[] = []): YunufPlayer => ({ id, name: id, avatar: 0, seatIndex: id.charCodeAt(0), hand, ready: true, connected: true, eliminated: false, totalScore: 0, roundScore: 0, handsWon: 0, jointWins: 0, showsDeclared: 0, successfulShows: 0, failedShows: 0, revealHandTotalSum: 0, reveals: 0 });
const started = () => startMatch(createLobbyState([player("a"), player("b"), player("c")]), { now: 1000, random: () => 0.2, id: () => "discard-0" });

describe("Yunuf turn engine", () => {
  it("deals five private cards and opens one discard", () => {
    const state = started();
    expect(state.players.every((item) => item.hand.length === 5)).toBe(true);
    expect(state.drawPile).toHaveLength(36);
    expect(state.latestDiscard?.cards).toHaveLength(1);
    expect(state.turnPhase).toBe("discard");
  });
  it("enforces discard then one draw then end", () => {
    const state = started();
    const current = state.players.find((item) => item.id === state.currentPlayerId)!;
    expect(() => drawFromDeck(state, current.id)).toThrow("Discard before drawing");
    const discarded = discardCards(state, current.id, [current.hand[0].id], { now: 1100, id: () => "play" });
    expect(discarded.turnPhase).toBe("draw");
    const drawn = drawFromDeck(discarded, current.id);
    expect(drawn.turnPhase).toBe("decision");
    expect(drawn.players.find((item) => item.id === current.id)?.hand).toHaveLength(5);
    expect(() => drawFromDeck(drawn, current.id)).toThrow("already drew");
    expect(endTurn(drawn, current.id, { now: 1200 }).currentPlayerId).not.toBe(current.id);
  });
  it("draws only the top card of the previous combination", () => {
    const state = started();
    const current = state.players.find((item) => item.id === state.currentPlayerId)!;
    const source = { id: "source", playerId: "z", cards: [card("Q"), card("K"), card("A")], playType: "sequence" as const, createdAt: 0 };
    const prepared: YunufGameState = { ...state, drawSourceDiscard: source, discardHistory: [source], players: state.players.map((item) => item.id === current.id ? { ...item, hand: [card("3"), ...item.hand.slice(1)] } : item) };
    const discarded = discardCards(prepared, current.id, ["hearts-3"], { id: () => "new" });
    expect(() => drawFromDiscard(discarded, current.id, "hearts-Q")).toThrow("Only the top card");
    expect(drawFromDiscard(discarded, current.id, "hearts-A").turnPhase).toBe("decision");
  });
  it("keeps selection order so the last selected card is on top", () => {
    const state = started(); const current = state.players.find((item) => item.id === state.currentPlayerId)!;
    const sequence = [card("A", "diamonds"), card("Q", "clubs"), card("K", "spades")];
    const prepared = { ...state, players: state.players.map((item) => item.id === current.id ? { ...item, hand: [...sequence, ...item.hand.slice(3)] } : item) };
    const discarded = discardCards(prepared, current.id, sequence.map((item) => item.id), { id: () => "ordered" });
    expect(discarded.latestDiscard?.cards.map((item) => item.id)).toEqual(sequence.map((item) => item.id));
    expect(eligibleDiscardDrawIds(discarded.latestDiscard!.cards)).toEqual(["spades-K"]);
  });
  it("tracks full rotations and unlocks Show only after three", () => {
    let state = started();
    for (let turn = 0; turn < 9; turn++) {
      const id = state.currentPlayerId!;
      const hand = state.players.find((item) => item.id === id)!.hand;
      state = discardCards(state, id, [hand[0].id], { id: () => `d-${turn}` });
      state = drawFromDeck(state, id);
      if (turn === 8) break;
      state = endTurn(state, id, { now: 2000 + turn });
    }
    expect(state.completedRounds).toBe(2);
    expect(() => declareShow(state, state.currentPlayerId!)).toThrow(YunufRuleError);
    state = endTurn(state, state.currentPlayerId!, { now: 3000 });
    expect(state.completedRounds).toBe(3);
  });
  it("lets only remaining players act after Show and then reveals", () => {
    let state = started();
    state = { ...state, completedRounds: 3, playersWhoActedThisRound: ["a"], currentPlayerId: "b", turnPhase: "decision" };
    state = declareShow(state, "b", { now: 5000 });
    expect(state.status).toBe("finishing_round_after_show");
    expect(state.currentPlayerId).toBe("c");
    expect(state.showState.resolveAfterPlayerId).toBe("c");
    const cHand = state.players.find((item) => item.id === "c")!.hand;
    state = discardCards(state, "c", [cHand[0].id], { id: () => "final" });
    state = drawFromDeck(state, "c");
    state = endTurn(state, "c");
    expect(["hand_results", "match_over"]).toContain(state.status);
    expect(state.result?.handValues).toBeDefined();
  });
  it("resolves immediately when the last player in a round declares", () => {
    const state = { ...started(), completedRounds: 3, playersWhoActedThisRound: ["a", "b"], currentPlayerId: "c", turnPhase: "decision" as const };
    expect(["hand_results", "match_over"]).toContain(declareShow(state, "c").status);
  });
  it("auto-plays the deterministic discard and draw after timeout", () => {
    const state = { ...started(), turnStartedAt: 1000, turnDurationSeconds: 30 };
    const next = autoPlayExpiredTurn(state, { now: 31_001, id: () => "timeout" });
    expect(next.turnNumber).toBe(2);
    expect(next.turnPhase).toBe("discard");
  });
  it("allows Show with a high-value hand but only after discard and draw", () => {
    const state = { ...started(), completedRounds: 3, currentPlayerId: "a", playersWhoActedThisRound: ["b", "c"] };
    expect(() => declareShow({ ...state, turnPhase: "discard" }, "a")).toThrow("Discard before drawing");
    const resolved = declareShow({ ...state, turnPhase: "decision", players: state.players.map((item) => item.id === "a" ? { ...item, hand: [card("K"), card("Q"), card("J")] } : item) }, "a");
    expect(resolved.result?.handValues.a).toBe(30);
  });
  it("eliminates a losing declarer at the limit and ends with one survivor", () => {
    const initial = startMatch(createLobbyState([player("a"), player("b")]), { now: 1, random: () => .1, id: () => "initial" });
    const state = {
      ...initial, completedRounds: 3, currentPlayerId: "a", playersWhoActedThisRound: ["b"], turnPhase: "decision" as const,
      players: initial.players.map((item) => item.id === "a" ? { ...item, totalScore: 90, hand: [card("K")] } : { ...item, hand: [card("A")] }),
    };
    const resolved = declareShow(state, "a");
    expect(resolved.status).toBe("match_over");
    expect(resolved.result?.roundScores.a).toBe(20);
    expect(resolved.result?.eliminatedIds).toEqual(["a"]);
    expect(resolved.result?.matchWinnerIds).toEqual(["b"]);
  });
  it("continues when an elimination leaves at least two active players", () => {
    const initial = started();
    const state = {
      ...initial, completedRounds: 3, currentPlayerId: "a", playersWhoActedThisRound: ["b", "c"], turnPhase: "decision" as const,
      players: initial.players.map((item) => item.id === "a" ? { ...item, totalScore: 90, hand: [card("K")] } : item.id === "b" ? { ...item, hand: [card("A")] } : { ...item, hand: [card("2")] }),
    };
    const resolved = declareShow(state, "a");
    expect(resolved.status).toBe("hand_results");
    expect(resolved.players.filter((item) => !item.eliminated).map((item) => item.id)).toEqual(["b", "c"]);
  });
  it("recycles only older discards when the draw pile is empty", () => {
    const state = started(); const id = state.currentPlayerId!; const owned = state.players.find((item) => item.id === id)!.hand[0];
    const discarded = discardCards(state, id, [owned.id], { id: () => "latest" });
    const older = { id: "older", playerId: "x", cards: [card("3", "clubs")], playType: "single" as const, createdAt: 0 };
    const prepared = { ...discarded, drawPile: [], discardHistory: [older, ...discarded.discardHistory] };
    const drawn = drawFromDeck(prepared, id, { random: () => .5 });
    expect(drawn.players.find((item) => item.id === id)?.hand.some((item) => item.id === "clubs-3")).toBe(true);
    expect(drawn.drawSourceDiscard?.cards).toEqual(discarded.drawSourceDiscard?.cards);
    expect(drawn.latestDiscard?.cards).toEqual(discarded.latestDiscard?.cards);
  });
});
