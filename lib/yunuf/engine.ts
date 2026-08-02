import type { Card, DiscardPlay, HandResolution, YunufGameState, YunufPlayer } from "./types";
import {
  DEFAULT_ELIMINATION_SCORE, DEFAULT_FAILED_SHOW_PENALTY, DEFAULT_TURN_SECONDS, MIN_ROUNDS_BEFORE_SHOW,
  STARTING_HAND_SIZE, createDeck, determineMatchWinners, eligibleDiscardDrawIds,
  highestDeterministicCard, resolveShow, shuffleDeck, validateDiscard,
} from "./rules";

type EngineOptions = { now?: number; random?: () => number; id?: () => string };
const inactiveShow = { active: false, declarerId: null, resolveAfterPlayerId: null, declaredAtTurnNumber: null } as const;
const option = (options?: EngineOptions) => ({
  now: options?.now ?? Date.now(), random: options?.random ?? Math.random,
  id: options?.id ?? (() => crypto.randomUUID()),
});

export class YunufRuleError extends Error {
  constructor(message: string, public code = "INVALID_ACTION", public status = 400) { super(message); }
}

export function createLobbyState(players: YunufPlayer[], eliminationScore = DEFAULT_ELIMINATION_SCORE, turnDurationSeconds = DEFAULT_TURN_SECONDS): YunufGameState {
  return {
    status: "lobby", handNumber: 0, players, activePlayerIds: players.map((player) => player.id),
    currentPlayerId: null, startingPlayerId: null, turnNumber: 0, turnPhase: "discard", turnStartedAt: null,
    turnDurationSeconds, completedRounds: 0, playersWhoActedThisRound: [], drawPile: [], discardHistory: [],
    latestDiscard: null, drawSourceDiscard: null, showState: inactiveShow, eliminationScore,
    failedShowPenalty: DEFAULT_FAILED_SHOW_PENALTY, result: null,
  };
}

function dealFreshHand(state: YunufGameState, startingPlayerId: string, options?: EngineOptions): YunufGameState {
  const settings = option(options);
  const deck = shuffleDeck(createDeck(), settings.random);
  const activeIds = state.players.filter((player) => !player.eliminated).sort((a, b) => a.seatIndex - b.seatIndex).map((player) => player.id);
  const hands = new Map(activeIds.map((id) => [id, [] as Card[]]));
  for (let count = 0; count < STARTING_HAND_SIZE; count++) {
    for (const id of activeIds) hands.get(id)!.push(deck.pop()!);
  }
  const initialCard = deck.pop()!;
  const initialDiscard: DiscardPlay = { id: settings.id(), playerId: "deck", cards: [initialCard], playType: "single", createdAt: settings.now };
  return {
    ...state, status: "playing", handNumber: state.handNumber + 1,
    players: state.players.map((player) => ({ ...player, hand: hands.get(player.id) ?? [], ready: false, roundScore: 0 })),
    activePlayerIds: activeIds, currentPlayerId: startingPlayerId, startingPlayerId, turnNumber: 1,
    turnPhase: "discard", turnStartedAt: settings.now, completedRounds: 0, playersWhoActedThisRound: [],
    drawPile: deck, discardHistory: [initialDiscard], latestDiscard: initialDiscard, drawSourceDiscard: initialDiscard,
    showState: inactiveShow, result: null,
  };
}

export function startMatch(state: YunufGameState, options?: EngineOptions) {
  if (state.status !== "lobby") throw new YunufRuleError("The match has already started.");
  const active = state.players.filter((player) => !player.eliminated);
  if (active.length < 2) throw new YunufRuleError("At least two players are required.");
  if (active.some((player) => !player.ready)) throw new YunufRuleError("Every player must be ready.");
  const settings = option(options);
  const first = active[Math.floor(settings.random() * active.length)];
  return dealFreshHand(state, first.id, settings);
}

function currentPlayer(state: YunufGameState) {
  const player = state.players.find((item) => item.id === state.currentPlayerId);
  if (!player) throw new YunufRuleError("There is no active player.", "INVALID_STATE", 500);
  return player;
}

function assertTurn(state: YunufGameState, playerId: string, phase?: YunufGameState["turnPhase"]) {
  if (state.status !== "playing" && state.status !== "finishing_round_after_show") throw new YunufRuleError("This hand is not accepting moves.");
  if (state.currentPlayerId !== playerId) throw new YunufRuleError("It is not your turn.", "NOT_YOUR_TURN", 409);
  if (phase && state.turnPhase !== phase) {
    if (state.turnPhase === "discard") throw new YunufRuleError("Discard before drawing.");
    if (state.turnPhase === "draw") throw new YunufRuleError("Draw exactly one card now.");
    throw new YunufRuleError(phase === "decision" ? "Finish your discard and draw first." : "You already drew a card.");
  }
}

export function discardCards(state: YunufGameState, playerId: string, cardIds: string[], options?: EngineOptions) {
  assertTurn(state, playerId, "discard");
  const player = currentPlayer(state);
  if (new Set(cardIds).size !== cardIds.length) throw new YunufRuleError("A card can only be selected once.");
  const selected = cardIds.map((id) => player.hand.find((card) => card.id === id));
  if (selected.some((card) => !card)) throw new YunufRuleError("One of those cards is not in your hand.");
  const validation = validateDiscard(selected as Card[]);
  if (!validation.valid) throw new YunufRuleError(validation.error, "INVALID_DISCARD", 422);
  const settings = option(options);
  // Selection order is public game state: the last selected card lands on top.
  const play: DiscardPlay = { id: settings.id(), playerId, cards: selected as Card[], playType: validation.playType, createdAt: settings.now };
  return {
    ...state, turnPhase: "draw" as const, latestDiscard: play,
    players: state.players.map((item) => item.id === playerId ? { ...item, hand: item.hand.filter((card) => !cardIds.includes(card.id)) } : item),
    discardHistory: [...state.discardHistory, play],
  };
}

function recycleDrawPile(state: YunufGameState, random: () => number) {
  if (state.drawPile.length > 0) return state;
  const protectedIds = new Set([...(state.latestDiscard?.cards ?? []), ...(state.drawSourceDiscard?.cards ?? [])].map((card) => card.id));
  const recyclable = state.discardHistory.flatMap((play) => play.cards).filter((card) => !protectedIds.has(card.id));
  if (recyclable.length === 0) throw new YunufRuleError("There are no cards available to draw.", "EMPTY_DECK", 409);
  const history = state.discardHistory.map((play) => ({ ...play, cards: play.cards.filter((card) => protectedIds.has(card.id)) })).filter((play) => play.cards.length > 0);
  return { ...state, drawPile: shuffleDeck(recyclable, random), discardHistory: history };
}

function addDrawnCard(state: YunufGameState, playerId: string, card: Card) {
  return {
    ...state, turnPhase: "decision" as const,
    players: state.players.map((player) => player.id === playerId ? { ...player, hand: [...player.hand, card] } : player),
  };
}

export function drawFromDeck(state: YunufGameState, playerId: string, options?: EngineOptions) {
  assertTurn(state, playerId, "draw");
  const settings = option(options);
  const replenished = recycleDrawPile(state, settings.random);
  const drawPile = [...replenished.drawPile];
  const card = drawPile.pop();
  if (!card) throw new YunufRuleError("There are no cards available to draw.", "EMPTY_DECK", 409);
  return addDrawnCard({ ...replenished, drawPile }, playerId, card);
}

export function drawFromDiscard(state: YunufGameState, playerId: string, cardId: string) {
  assertTurn(state, playerId, "draw");
  const source = state.drawSourceDiscard;
  if (!source || !eligibleDiscardDrawIds(source.cards).includes(cardId)) throw new YunufRuleError("Only the top card of the previous discard can be drawn.", "INVALID_DRAW", 422);
  const card = source.cards.find((item) => item.id === cardId)!;
  const reducedSource = { ...source, cards: source.cards.filter((item) => item.id !== cardId) };
  const discardHistory = state.discardHistory.map((play) => play.id === source.id ? reducedSource : play).filter((play) => play.cards.length > 0);
  return addDrawnCard({ ...state, discardHistory, drawSourceDiscard: reducedSource.cards.length ? reducedSource : null }, playerId, card);
}

function resolveHand(state: YunufGameState): YunufGameState {
  if (!state.showState.active) throw new YunufRuleError("Show resolution has no declarer.", "INVALID_STATE", 500);
  const scoring = resolveShow(state.players, state.showState.declarerId, state.failedShowPenalty);
  let players = state.players.map((player) => {
    if (player.eliminated) return player;
    const handValue = scoring.handValues[player.id];
    const won = scoring.winnerIds.includes(player.id);
    const declared = player.id === scoring.declarerId;
    const totalScore = player.totalScore + scoring.roundScores[player.id];
    return {
      ...player, roundScore: scoring.roundScores[player.id], totalScore,
      handsWon: player.handsWon + (won ? 1 : 0), jointWins: player.jointWins + (won && scoring.winnerIds.length > 1 ? 1 : 0),
      successfulShows: player.successfulShows + (declared && won ? 1 : 0), failedShows: player.failedShows + (declared && !won ? 1 : 0),
      revealHandTotalSum: player.revealHandTotalSum + handValue, reveals: player.reveals + 1,
    };
  });
  players = players.map((player) => ({ ...player, eliminated: player.eliminated || player.totalScore >= state.eliminationScore }));
  const eliminatedIds = players.filter((player) => !state.players.find((old) => old.id === player.id)!.eliminated && player.eliminated).map((player) => player.id);
  const matchWinnerIds = determineMatchWinners(players, scoring.roundScores);
  const result: HandResolution = { ...scoring, eliminatedIds, matchWinnerIds };
  return { ...state, status: matchWinnerIds.length ? "match_over" : "hand_results", players, currentPlayerId: null, turnStartedAt: null, result };
}

function finishTurn(state: YunufGameState, playerId: string, now: number) {
  assertTurn(state, playerId, "decision");
  const acted = [...new Set([...state.playersWhoActedThisRound, playerId])];
  if (state.showState.active && state.showState.resolveAfterPlayerId === playerId) return resolveHand({ ...state, playersWhoActedThisRound: acted });
  const roundCompleted = state.activePlayerIds.every((id) => acted.includes(id));
  const completedRounds = state.completedRounds + (roundCompleted ? 1 : 0);
  const playersWhoActedThisRound = roundCompleted ? [] : acted;
  const currentIndex = state.activePlayerIds.indexOf(playerId);
  const currentPlayerId = state.activePlayerIds[(currentIndex + 1) % state.activePlayerIds.length];
  return {
    ...state, currentPlayerId, turnNumber: state.turnNumber + 1, turnPhase: "discard" as const,
    turnStartedAt: now, completedRounds, playersWhoActedThisRound, drawSourceDiscard: state.latestDiscard,
  };
}

export function endTurn(state: YunufGameState, playerId: string, options?: EngineOptions) {
  return finishTurn(state, playerId, option(options).now);
}

export function declareShow(state: YunufGameState, playerId: string, options?: EngineOptions) {
  assertTurn(state, playerId, "decision");
  if (state.showState.active) throw new YunufRuleError("Show has already been declared.", "SHOW_ACTIVE", 409);
  if (state.completedRounds < MIN_ROUNDS_BEFORE_SHOW) throw new YunufRuleError("Show is available only after three complete rounds.", "SHOW_LOCKED", 422);
  const declarerIndex = state.activePlayerIds.indexOf(playerId);
  const remaining = [...state.activePlayerIds.slice(declarerIndex + 1), ...state.activePlayerIds.slice(0, declarerIndex)];
  const resolveAfterPlayerId = remaining.at(-1) ?? playerId;
  const showState = { active: true as const, declarerId: playerId, resolveAfterPlayerId, declaredAtTurnNumber: state.turnNumber };
  const players = state.players.map((player) => player.id === playerId ? { ...player, showsDeclared: player.showsDeclared + 1 } : player);
  const prepared = { ...state, status: remaining.length ? "finishing_round_after_show" as const : state.status, showState, players, playersWhoActedThisRound: [] };
  return remaining.length ? finishTurn(prepared, playerId, option(options).now) : resolveHand(prepared);
}

export function autoPlayExpiredTurn(state: YunufGameState, options?: EngineOptions) {
  const settings = option(options);
  if (!state.currentPlayerId || !state.turnStartedAt || settings.now < state.turnStartedAt + state.turnDurationSeconds * 1000) return state;
  let next = state;
  if (next.turnPhase === "discard") {
    const highest = highestDeterministicCard(currentPlayer(next).hand);
    if (!highest) throw new YunufRuleError("The current player has no card to discard.", "INVALID_STATE", 500);
    next = discardCards(next, next.currentPlayerId!, [highest.id], settings);
  }
  if (next.turnPhase === "draw") next = drawFromDeck(next, next.currentPlayerId!, settings);
  return finishTurn(next, next.currentPlayerId!, settings.now);
}

export function startNextHand(state: YunufGameState, options?: EngineOptions) {
  if (state.status !== "hand_results") throw new YunufRuleError("The next hand cannot begin yet.");
  const active = state.players.filter((player) => !player.eliminated).sort((a, b) => a.seatIndex - b.seatIndex);
  const oldStartSeat = state.players.find((player) => player.id === state.startingPlayerId)?.seatIndex ?? -1;
  const next = active.find((player) => player.seatIndex > oldStartSeat) ?? active[0];
  if (!next) throw new YunufRuleError("No active player remains.", "INVALID_STATE", 500);
  return dealFreshHand(state, next.id, options);
}
