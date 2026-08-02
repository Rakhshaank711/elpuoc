import { RANKS, SUITS, type Card, type DiscardValidation, type Rank, type Suit, type YunufPlayer } from "./types";

export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 5;
export const STARTING_HAND_SIZE = 5;
export const MIN_ROUNDS_BEFORE_SHOW = 3;
export const DEFAULT_ELIMINATION_SCORE = 100;
export const DEFAULT_FAILED_SHOW_PENALTY = 10;
export const DEFAULT_TURN_SECONDS = 30;
export const SHOW_DECISION_SECONDS = 5;

export function rankIndex(rank: Rank) { return RANKS.indexOf(rank); }

export function getCardValue(rank: Rank) {
  if (rank === "A") return 1;
  if (rank === "J" || rank === "Q" || rank === "K") return 10;
  return Number(rank);
}

export function calculateHandValue(cards: Card[]) {
  return cards.reduce((total, card) => total + getCardValue(card.rank), 0);
}

export function createDeck(): Card[] {
  return SUITS.flatMap((suit) => RANKS.map((rank) => ({ id: `${suit}-${rank}`, suit, rank })));
}

export function shuffleDeck(cards: Card[], random: () => number = Math.random) {
  const shuffled = [...cards];
  for (let index = shuffled.length - 1; index > 0; index--) {
    const target = Math.floor(random() * (index + 1));
    [shuffled[index], shuffled[target]] = [shuffled[target], shuffled[index]];
  }
  return shuffled;
}

export function isValidPair(cards: Card[]) {
  return cards.length === 2 && cards[0].rank === cards[1].rank;
}

export function resolveCircularSequence(cards: Card[]): Card[] | null {
  if (cards.length < 3 || cards.length > RANKS.length) return null;
  if (new Set(cards.map((card) => card.rank)).size !== cards.length) return null;
  const cardByRank = new Map(cards.map((card) => [card.rank, card]));
  for (let start = 0; start < RANKS.length; start++) {
    const expected = Array.from({ length: cards.length }, (_, offset) => RANKS[(start + offset) % RANKS.length]);
    if (expected.every((rank) => cardByRank.has(rank))) return expected.map((rank) => cardByRank.get(rank)!);
  }
  return null;
}

export function validateDiscard(cards: Card[]): DiscardValidation {
  if (cards.length === 0) return { valid: false, error: "Select at least one card." };
  if (cards.length === 1) return { valid: true, playType: "single", orderedCards: cards };
  if (cards.length === 2) {
    return isValidPair(cards)
      ? { valid: true, playType: "pair", orderedCards: cards }
      : { valid: false, error: "Two cards may only be played as an equal-rank pair." };
  }
  const orderedCards = resolveCircularSequence(cards);
  return orderedCards
    ? { valid: true, playType: "sequence", orderedCards }
    : { valid: false, error: "Play one card, exactly one equal-rank pair, or a sequence of at least three consecutive ranks." };
}

export function eligibleDiscardDrawIds(cards: Card[]) {
  if (cards.length === 0) return [];
  return [cards.at(-1)!.id];
}

const suitPriority: Record<Suit, number> = { spades: 4, hearts: 3, diamonds: 2, clubs: 1 };

export function highestDeterministicCard(cards: Card[]) {
  if (cards.length === 0) return null;
  return [...cards].sort((left, right) =>
    getCardValue(right.rank) - getCardValue(left.rank)
    || rankIndex(right.rank) - rankIndex(left.rank)
    || suitPriority[right.suit] - suitPriority[left.suit],
  )[0];
}

export function resolveShow(players: YunufPlayer[], declarerId: string, failedShowPenalty = DEFAULT_FAILED_SHOW_PENALTY) {
  const active = players.filter((player) => !player.eliminated);
  const handValues = Object.fromEntries(active.map((player) => [player.id, calculateHandValue(player.hand)]));
  const lowest = Math.min(...Object.values(handValues));
  const winnerIds = active.filter((player) => handValues[player.id] === lowest).map((player) => player.id);
  const declarerWon = winnerIds.includes(declarerId);
  const roundScores = Object.fromEntries(active.map((player) => {
    if (winnerIds.includes(player.id)) return [player.id, 0];
    return [player.id, handValues[player.id] + (player.id === declarerId && !declarerWon ? failedShowPenalty : 0)];
  }));
  return { declarerId, handValues, winnerIds, declarerWon, roundScores };
}

export function determineMatchWinners(players: YunufPlayer[], finalRoundScores: Record<string, number>) {
  const remaining = players.filter((player) => !player.eliminated);
  if (remaining.length === 1) return [remaining[0].id];
  if (remaining.length > 1) return [];
  const minimumTotal = Math.min(...players.map((player) => player.totalScore));
  const totalTies = players.filter((player) => player.totalScore === minimumTotal);
  const minimumFinal = Math.min(...totalTies.map((player) => finalRoundScores[player.id] ?? Infinity));
  return totalTies.filter((player) => finalRoundScores[player.id] === minimumFinal).map((player) => player.id);
}

export function getRemainingPlayersInRound(activePlayerIds: string[], playersWhoActed: string[], declarerId: string) {
  const declarerIndex = activePlayerIds.indexOf(declarerId);
  if (declarerIndex < 0) return [];
  const ordered = [...activePlayerIds.slice(declarerIndex + 1), ...activePlayerIds.slice(0, declarerIndex)];
  return ordered.filter((id) => !playersWhoActed.includes(id));
}
