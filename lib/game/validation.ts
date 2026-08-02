import { z } from "zod";

const name = z.string().trim().min(1, "Enter your name").max(24, "Keep your name under 24 characters");
const code = z.string().trim().toUpperCase().regex(/^[A-Z0-9]{6}$/, "Enter a valid 6-character room code");
const actionId = z.string().uuid();

export const gameActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create"), name, avatar: z.number().int().min(0).max(3).default(0) }),
  z.object({ action: z.literal("join"), name, code, avatar: z.number().int().min(0).max(3).default(1) }),
  z.object({ action: z.literal("ready"), actionId, code, ready: z.boolean() }),
  z.object({ action: z.literal("clue"), actionId, code, clue: z.string().trim().min(1).max(100) }),
  z.object({ action: z.literal("guess"), actionId, code, guess: z.string().trim().min(1).max(60) }),
  z.object({ action: z.literal("clue_request"), actionId, code }),
  z.object({ action: z.literal("clue_offer"), actionId, code }),
  z.object({ action: z.literal("skip"), actionId, code }),
  z.object({ action: z.literal("continue"), actionId, code }),
  z.object({ action: z.literal("play_again"), actionId, code }),
]);

export const stateQuerySchema = z.object({ code, playerId: z.string().uuid() });

const publicPlayerSchema = z.object({
  id: z.string().uuid(), name: z.string().max(24), role: z.enum(["host", "guest"]),
  avatar: z.number().int().min(0).max(3), ready: z.boolean(), connected: z.boolean().optional(),
  round1Score: z.number().int().min(0).max(8), round2Score: z.number().int().min(0).max(8),
});

const messageSchema = z.object({
  id: z.string().uuid(), senderId: z.string().uuid().nullable(), wordIndex: z.number().int().min(0).max(7),
  type: z.enum(["clue", "guess", "wrong", "correct", "clue_request", "clue_offer", "skipped"]),
  body: z.string().max(100).nullable(), wordCount: z.number().int().min(0).max(15), createdAt: z.string(),
});

export const gameStateSchema = z.object({
  roomId: z.string().uuid(), code, status: z.enum(["lobby", "playing", "round_result", "finished"]),
  currentRound: z.union([z.literal(1), z.literal(2)]), currentWordIndex: z.number().int().min(0).max(8),
  cluesUsed: z.number().int().min(0).max(15), clueLimit: z.literal(15), version: z.number().int().positive(),
  messages: z.array(messageSchema), players: z.array(publicPlayerSchema).min(1).max(2),
  you: z.object({ id: z.string().uuid(), role: z.enum(["host", "guest"]), roundRole: z.enum(["giver", "guesser"]).nullable() }),
  round: z.object({
    giverId: z.string().uuid(), guesserId: z.string().uuid(), latestClue: z.string().max(100).nullable(),
    score: z.number().int().min(0).max(8),
    words: z.array(z.object({ index: z.number().int().min(0).max(7), word: z.string().optional(), status: z.enum(["active", "guessed", "skipped", "pending"]) })).length(8),
  }).nullable(),
});

export type GameAction = z.infer<typeof gameActionSchema>;
