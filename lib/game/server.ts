import { createHash, randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { WORD_BANK, WORDS_PER_ROUND } from "./constants";
import { countClueWords } from "./rules";
import { gameStateSchema, type GameAction } from "./validation";
import type { GameState, PlayerRole, RoomStatus } from "./types";

type RoomRow = {
  id: string; code: string; status: RoomStatus; current_round: 1 | 2;
  current_word_index: number; clues_used: number; version: number;
};
type PlayerRow = {
  id: string; room_id: string; name: string; role: PlayerRole; seat: number; avatar: number;
  token_hash: string; ready: boolean; round1_score: number; round2_score: number;
};

export class GameError extends Error {
  constructor(message: string, public status = 400, public code?: string) { super(message); }
}

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function makeToken() { return randomBytes(32).toString("base64url"); }

function makeCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from(randomBytes(6), (byte) => alphabet[byte % alphabet.length]).join("");
}

function chooseWords() {
  const copy = [...WORD_BANK];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = randomBytes(2).readUInt16BE() % (i + 1);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, WORDS_PER_ROUND);
}

async function roomByCode(db: SupabaseClient, code: string) {
  const { data, error } = await db.from("rooms").select("*").eq("code", code).maybeSingle();
  if (error) throw new GameError("Could not load this room", 500);
  if (!data) throw new GameError("Room not found", 404);
  return data as RoomRow;
}

async function playersFor(db: SupabaseClient, roomId: string) {
  const { data, error } = await db.from("players").select("*").eq("room_id", roomId).order("seat");
  if (error) throw new GameError("Could not load players", 500);
  return (data ?? []) as PlayerRow[];
}

function rpcGameError(message: string, fallback: string) {
  const [tag, detail] = message.split("|", 2);
  const status = Number(tag?.replace("GAME_", ""));
  return new GameError(detail || fallback, Number.isFinite(status) ? status : 500);
}

export async function createRoom(db: SupabaseClient, name: string, avatar: number) {
  const token = makeToken();
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = makeCode();
    const { data: room, error } = await db.from("rooms").insert({ code }).select("*").single();
    if (error?.code === "23505") continue;
    if (error || !room) throw new GameError("Could not create a room", 500);
    const { data: player, error: playerError } = await db.from("players").insert({
      room_id: room.id, name, role: "host", seat: 1, avatar, token_hash: hashToken(token),
    }).select("*").single();
    if (playerError || !player) {
      await db.from("rooms").delete().eq("id", room.id);
      throw new GameError("Could not create a player", 500);
    }
    return { session: { playerId: player.id, token, code, name, role: "host" as const } };
  }
  throw new GameError("Could not reserve a room code. Try again.", 503);
}

export async function joinRoom(db: SupabaseClient, name: string, code: string, avatar: number) {
  const room = await roomByCode(db, code);
  if (room.status !== "lobby") throw new GameError("That game has already started", 409);
  const existing = await playersFor(db, room.id);
  if (existing.length >= 2) throw new GameError("This room is full", 409);
  const token = makeToken();
  const { data: player, error } = await db.from("players").insert({
    room_id: room.id, name, role: "guest", seat: 2, avatar, token_hash: hashToken(token),
  }).select("*").single();
  if (error || !player) throw new GameError(error?.code === "23505" ? "This room is full" : "Could not join this room", error?.code === "23505" ? 409 : 500);
  return { session: { playerId: player.id, token, code, name, role: "guest" as const } };
}

export async function getState(db: SupabaseClient, code: string, playerId: string, token: string): Promise<GameState> {
  const { data, error } = await db.rpc("get_game_state", { p_code: code, p_player_id: playerId, p_token: token });
  if (error) throw rpcGameError(error.message, "Could not load this room");
  const parsed = gameStateSchema.safeParse(data);
  if (!parsed.success) throw new GameError("The saved room state is invalid", 500);
  return parsed.data;
}

export async function mutateGame(db: SupabaseClient, action: Exclude<GameAction, { action: "create" | "join" }>, playerId: string, token: string) {
  const text = action.action === "clue" ? action.clue : action.action === "guess" ? action.guess : null;
  const { data, error } = await db.rpc("mutate_game", {
    p_code: action.code,
    p_player_id: playerId,
    p_token: token,
    p_action_id: action.actionId,
    p_action: action.action,
    p_text: text,
    p_ready: action.action === "ready" ? action.ready : null,
    p_word_count: action.action === "clue" ? countClueWords(action.clue) : null,
    p_words: action.action === "ready" || action.action === "continue" ? chooseWords() : null,
  });
  if (error) {
    throw rpcGameError(error.message, "Could not update the game");
  }
  const result = data as { outcome?: string; roomId?: string; version?: number } | null;
  if (result?.outcome === "wrong_guess") throw new GameError("Not quite — try again", 422, "WRONG_GUESS");
  return result;
}
