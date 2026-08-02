import { z } from "zod";

const name = z.string().trim().min(1, "Enter your name").max(24, "Keep your name under 24 characters");
const code = z.string().trim().toUpperCase().regex(/^[A-Z0-9]{6}$/, "Enter a valid 6-character room code");

export const gameActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create"), name, avatar: z.number().int().min(0).max(3).default(0) }),
  z.object({ action: z.literal("join"), name, code, avatar: z.number().int().min(0).max(3).default(1) }),
  z.object({ action: z.literal("ready"), code, ready: z.boolean() }),
  z.object({ action: z.literal("clue"), code, clue: z.string().trim().min(1).max(100) }),
  z.object({ action: z.literal("guess"), code, guess: z.string().trim().min(1).max(60) }),
  z.object({ action: z.literal("skip"), code }),
  z.object({ action: z.literal("continue"), code }),
  z.object({ action: z.literal("play_again"), code }),
  z.object({ action: z.literal("expire"), code }),
]);

export const stateQuerySchema = z.object({ code, playerId: z.string().uuid() });

export type GameAction = z.infer<typeof gameActionSchema>;
