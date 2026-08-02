import { z } from "zod";

const code = z.string().trim().toUpperCase().regex(/^[A-Z0-9]{6}$/);
const playerId = z.string().uuid();
const actionId = z.string().uuid();
const expectedVersion = z.number().int().positive();
const baseMutation = { code, actionId, expectedVersion };

export const yunufActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create"), name: z.string().trim().min(1).max(24), avatar: z.number().int().min(0).max(3), eliminationScore: z.number().int().min(25).max(500).default(100), turnDurationSeconds: z.number().int().min(15).max(120).default(30) }),
  z.object({ action: z.literal("join"), name: z.string().trim().min(1).max(24), avatar: z.number().int().min(0).max(3), code }),
  z.object({ action: z.literal("ready"), code, ready: z.boolean() }),
  z.object({ action: z.literal("start"), ...baseMutation }),
  z.object({ action: z.literal("discard"), ...baseMutation, cardIds: z.array(z.string().min(1).max(40)).min(1).max(13) }),
  z.object({ action: z.literal("draw_deck"), ...baseMutation }),
  z.object({ action: z.literal("draw_discard"), ...baseMutation, cardId: z.string().min(1).max(40) }),
  z.object({ action: z.literal("end_turn"), ...baseMutation }),
  z.object({ action: z.literal("declare_show"), ...baseMutation }),
  z.object({ action: z.literal("continue"), ...baseMutation }),
  z.object({ action: z.literal("reset"), ...baseMutation }),
]);

export const yunufQuerySchema = z.object({ code, playerId });

const cardSchema = z.object({ id: z.string(), suit: z.enum(["hearts", "diamonds", "clubs", "spades"]), rank: z.enum(["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"]) });
const playerSchema = z.object({
  id: z.string().uuid(), name: z.string().min(1).max(24), avatar: z.number().int().min(0).max(3), seatIndex: z.number().int(), hand: z.array(cardSchema),
  ready: z.boolean(), connected: z.boolean(), eliminated: z.boolean(), totalScore: z.number().int().nonnegative(), roundScore: z.number().int().nonnegative(),
  handsWon: z.number().int().nonnegative(), jointWins: z.number().int().nonnegative(), showsDeclared: z.number().int().nonnegative(), successfulShows: z.number().int().nonnegative(), failedShows: z.number().int().nonnegative(), revealHandTotalSum: z.number().int().nonnegative(), reveals: z.number().int().nonnegative(),
});
const discardSchema = z.object({ id: z.string(), playerId: z.string(), cards: z.array(cardSchema), playType: z.enum(["single", "pair", "sequence"]), createdAt: z.number() });
const showSchema = z.discriminatedUnion("active", [
  z.object({ active: z.literal(false), declarerId: z.null(), resolveAfterPlayerId: z.null(), declaredAtTurnNumber: z.null() }),
  z.object({ active: z.literal(true), declarerId: z.string().uuid(), resolveAfterPlayerId: z.string().uuid(), declaredAtTurnNumber: z.number().int().positive() }),
]);
const resultSchema = z.object({
  declarerId: z.string().uuid(), handValues: z.record(z.string(), z.number().int().nonnegative()), winnerIds: z.array(z.string().uuid()), declarerWon: z.boolean(),
  roundScores: z.record(z.string(), z.number().int().nonnegative()), eliminatedIds: z.array(z.string().uuid()), matchWinnerIds: z.array(z.string().uuid()),
});

export const yunufGameStateSchema = z.object({
  status: z.enum(["lobby", "playing", "finishing_round_after_show", "hand_results", "match_over"]), handNumber: z.number().int().nonnegative(), players: z.array(playerSchema).max(5), activePlayerIds: z.array(z.string().uuid()).max(5), currentPlayerId: z.string().uuid().nullable(), startingPlayerId: z.string().uuid().nullable(), turnNumber: z.number().int().nonnegative(), turnPhase: z.enum(["discard", "draw", "decision"]), turnStartedAt: z.number().nullable(), turnDurationSeconds: z.number().int().min(15).max(120), completedRounds: z.number().int().nonnegative(), playersWhoActedThisRound: z.array(z.string().uuid()), drawPile: z.array(cardSchema), discardHistory: z.array(discardSchema), latestDiscard: discardSchema.nullable(), drawSourceDiscard: discardSchema.nullable(), showState: showSchema, eliminationScore: z.number().int().min(25).max(500), failedShowPenalty: z.number().int().nonnegative(), result: resultSchema.nullable(),
});

export type YunufAction = z.infer<typeof yunufActionSchema>;
