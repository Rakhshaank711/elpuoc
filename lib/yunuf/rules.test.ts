import { describe, expect, it } from "vitest";
import { RANKS, type Card, type Rank, type Suit, type YunufPlayer } from "./types";
import {
  calculateHandValue, createDeck, determineMatchWinners, eligibleDiscardDrawIds, getCardValue,
  getRemainingPlayersInRound, highestDeterministicCard, isValidPair, resolveCircularSequence,
  resolveShow, validateDiscard,
} from "./rules";

const card = (rank: Rank, suit: Suit = "hearts"): Card => ({ id: `${suit}-${rank}`, rank, suit });
const cards = (...ranks: Rank[]) => ranks.map((rank, index) => card(rank, ["hearts", "diamonds", "clubs", "spades"][index % 4] as Suit));
const player = (id: string, hand: Card[], score = 0, eliminated = false): YunufPlayer => ({
  id, name: id, avatar: 0, seatIndex: 0, hand, ready: true, connected: true, eliminated,
  totalScore: score, roundScore: 0, handsWon: 0, jointWins: 0, showsDeclared: 0,
  successfulShows: 0, failedShows: 0, revealHandTotalSum: 0, reveals: 0,
});

describe("Yunuf cards", () => {
  it("creates one unique standard 52-card deck", () => {
    const deck = createDeck();
    expect(deck).toHaveLength(52);
    expect(new Set(deck.map((item) => item.id))).toHaveLength(52);
  });
  it.each([["A", 1], ["2", 2], ["10", 10], ["J", 10], ["Q", 10], ["K", 10]] as const)("values %s as %i", (rank, value) => expect(getCardValue(rank)).toBe(value));
  it("totals a hand", () => expect(calculateHandValue(cards("A", "3", "7", "K"))).toBe(21));
});

describe("discard validation", () => {
  it("rejects no cards and accepts any single", () => {
    expect(validateDiscard([]).valid).toBe(false);
    expect(validateDiscard(cards("K"))).toMatchObject({ valid: true, playType: "single" });
  });
  it.each([["7", "7"], ["Q", "Q"], ["A", "A"]] as const)("accepts a %s pair", (left, right) => expect(isValidPair(cards(left, right))).toBe(true));
  it("rejects mismatched, same-value, and oversized groups", () => {
    expect(validateDiscard(cards("5", "6")).valid).toBe(false);
    expect(validateDiscard(cards("10", "J")).valid).toBe(false);
    expect(validateDiscard(cards("7", "7", "7")).valid).toBe(false);
    expect(validateDiscard(cards("7", "7", "7", "7")).valid).toBe(false);
  });
  it.each([
    ["4", "5", "6"], ["8", "9", "10"], ["9", "10", "J"], ["10", "J", "Q"],
    ["J", "Q", "K"], ["Q", "K", "A"], ["K", "A", "2"], ["Q", "K", "A", "2"],
    ["10", "J", "Q", "K", "A", "2"],
  ] as Rank[][])("accepts circular sequence %s", (...ranks) => expect(resolveCircularSequence(cards(...ranks))?.map((item) => item.rank)).toEqual(ranks));
  it("orders an arbitrarily selected circular sequence", () => expect(resolveCircularSequence(cards("A", "Q", "K"))?.map((item) => item.rank)).toEqual(["Q", "K", "A"]));
  it.each([["4", "6", "7"], ["10", "Q", "K"], ["4", "4", "5"], ["K", "2", "3"]] as Rank[][])("rejects invalid sequence %s", (...ranks) => expect(resolveCircularSequence(cards(...ranks))).toBeNull());
  it("rejects sequences longer than the rank cycle", () => expect(resolveCircularSequence([...cards(...RANKS), card("A", "spades")])).toBeNull());
});

describe("drawing and timeout helpers", () => {
  it("allows both pair cards but only sequence ends", () => {
    const pair = cards("5", "5");
    const sequence = cards("Q", "K", "A", "2");
    expect(eligibleDiscardDrawIds(pair, "pair")).toEqual(pair.map((item) => item.id));
    expect(eligibleDiscardDrawIds(sequence, "sequence")).toEqual([sequence[0].id, sequence[3].id]);
  });
  it("deterministically selects the highest card", () => expect(highestDeterministicCard([card("K", "clubs"), card("Q", "spades"), card("K", "spades")])?.id).toBe("spades-K"));
});

describe("Show scoring and round timing", () => {
  it("awards all lowest ties zero and does not penalise a tied declarer", () => {
    const result = resolveShow([player("a", cards("4")), player("b", cards("4")), player("c", cards("8"))], "a");
    expect(result.winnerIds).toEqual(["a", "b"]);
    expect(result.roundScores).toEqual({ a: 0, b: 0, c: 8 });
    expect(result.declarerWon).toBe(true);
  });
  it("adds exactly ten to a losing declarer", () => {
    const result = resolveShow([player("a", cards("6")), player("b", cards("4")), player("c", cards("9"))], "a");
    expect(result.roundScores).toEqual({ a: 16, b: 0, c: 9 });
  });
  it("returns only players who have not acted after the declarer", () => expect(getRemainingPlayersInRound(["a", "b", "c", "d"], ["a", "b"], "b")).toEqual(["c", "d"]));
  it("uses total, then final-round score, then a joint match win", () => {
    expect(determineMatchWinners([player("a", [], 101, true), player("b", [], 101, true)], { a: 8, b: 5 })).toEqual(["b"]);
    expect(determineMatchWinners([player("a", [], 101, true), player("b", [], 101, true)], { a: 5, b: 5 })).toEqual(["a", "b"]);
  });
});
