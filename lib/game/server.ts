import { createHash, randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { CLUE_WORD_LIMIT, ROUND_SECONDS, WORD_BANK, WORDS_PER_ROUND } from "./constants";
import { canUseClue, countClueWords, isCorrectGuess, normalizeWord, scoreStatuses } from "./rules";
import type { GameAction } from "./validation";
import type { GameState, PlayerRole, RoomStatus } from "./types";

type RoomRow = {
  id: string; code: string; status: RoomStatus; current_round: 1 | 2;
  current_word_index: number; clues_used: number; round_ends_at: string | null; version: number;
};
type PlayerRow = {
  id: string; room_id: string; name: string; role: PlayerRole; seat: number; avatar: number;
  token_hash: string; ready: boolean; round1_score: number; round2_score: number;
};
type RoundRow = {
  id: string; room_id: string; round_number: 1 | 2; giver_id: string; guesser_id: string;
  words: string[]; statuses: string[]; latest_clue: string | null; clues: unknown[]; score: number;
  started_at: string; ends_at: string; completed_at: string | null;
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

async function authenticate(db: SupabaseClient, code: string, playerId: string, token: string) {
  const { data, error } = await db
    .from("players")
    .select("*, rooms!inner(*)")
    .eq("id", playerId)
    .eq("rooms.code", code)
    .maybeSingle();
  if (error) throw new GameError("Could not validate this room session", 500);
  if (!data || hashToken(token) !== data.token_hash) throw new GameError("Your room session is no longer valid", 401);
  const joined = data as unknown as PlayerRow & { rooms: RoomRow };
  const { rooms: room, ...player } = joined;
  return { room, player };
}

async function activeRound(db: SupabaseClient, room: RoomRow) {
  const { data, error } = await db.from("rounds").select("*").eq("room_id", room.id).eq("round_number", room.current_round).maybeSingle();
  if (error) throw new GameError("Could not load this round", 500);
  return data as RoundRow | null;
}

async function startRound(db: SupabaseClient, room: RoomRow, players: PlayerRow[], roundNumber: 1 | 2) {
  if (players.length !== 2) throw new GameError("Your partner has not joined yet");
  const giver = roundNumber === 1 ? players[0] : players[1];
  const guesser = roundNumber === 1 ? players[1] : players[0];
  const endsAt = new Date(Date.now() + ROUND_SECONDS * 1000).toISOString();
  const { error: roundError } = await db.from("rounds").insert({
    room_id: room.id, round_number: roundNumber, giver_id: giver.id, guesser_id: guesser.id,
    words: chooseWords(), ends_at: endsAt,
  });
  if (roundError && roundError.code !== "23505") throw new GameError("Could not start the round", 500);
  const { error } = await db.from("rooms").update({
    status: "playing", current_round: roundNumber, current_word_index: 0,
    clues_used: 0, round_ends_at: endsAt, version: room.version + 1,
  }).eq("id", room.id).eq("version", room.version);
  if (error) throw new GameError("Could not start the round", 500);
  await db.from("players").update({ ready: false }).eq("room_id", room.id);
}

async function finishRound(db: SupabaseClient, room: RoomRow, round: RoundRow) {
  const score = scoreStatuses(round.statuses);
  await db.from("rounds").update({ score, completed_at: new Date().toISOString() }).eq("id", round.id);
  const field = room.current_round === 1 ? "round1_score" : "round2_score";
  await db.from("players").update({ [field]: score, ready: false }).eq("id", round.guesser_id);
  await db.from("rooms").update({
    status: "round_result", current_word_index: Math.min(room.current_word_index, WORDS_PER_ROUND),
    round_ends_at: null, version: room.version + 1,
  }).eq("id", room.id);
}

async function expireIfNeeded(db: SupabaseClient, room: RoomRow) {
  if (room.status !== "playing" || !room.round_ends_at || new Date(room.round_ends_at).getTime() > Date.now()) return room;
  const round = await activeRound(db, room);
  if (round) await finishRound(db, room, round);
  return roomByCode(db, room.code);
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
  const authenticated = await authenticate(db, code, playerId, token);
  let { room } = authenticated;
  const { player } = authenticated;
  room = await expireIfNeeded(db, room);
  const [players, round] = await Promise.all([
    playersFor(db, room.id),
    room.status === "lobby" ? Promise.resolve(null) : activeRound(db, room),
  ]);
  const revealWords = !!round && (round.giver_id === player.id || room.status !== "playing");
  return {
    roomId: room.id, code: room.code, status: room.status, currentRound: room.current_round,
    currentWordIndex: room.current_word_index, cluesUsed: room.clues_used, clueLimit: CLUE_WORD_LIMIT,
    roundEndsAt: room.round_ends_at, version: room.version,
    players: players.map((p) => ({
      id: p.id, name: p.name, role: p.role, avatar: p.avatar, ready: p.ready,
      round1Score: p.round1_score, round2Score: p.round2_score,
    })),
    you: { id: player.id, role: player.role, roundRole: !round ? null : round.giver_id === player.id ? "giver" : "guesser" },
    round: !round ? null : {
      giverId: round.giver_id, guesserId: round.guesser_id, latestClue: round.latest_clue, score: round.score,
      words: round.words.map((word, index) => ({ index, ...(revealWords ? { word } : {}), status: (round.statuses[index] ?? "pending") as GameState["round"] extends infer R ? R extends {words: (infer W)[]} ? W extends {status: infer S} ? S : never : never : never })),
    },
  };
}

export async function mutateGame(db: SupabaseClient, action: Exclude<GameAction, { action: "create" | "join" }>, playerId: string, token: string) {
  const authenticated = await authenticate(db, action.code, playerId, token);
  let { room } = authenticated;
  const { player } = authenticated;
  room = await expireIfNeeded(db, room);
  if (action.action === "ready") {
    if (room.status !== "lobby") throw new GameError("The game has already started", 409);
    await db.from("players").update({ ready: action.ready }).eq("id", player.id);
    const refreshed = await playersFor(db, room.id);
    if (refreshed.length === 2 && refreshed.every((p) => p.ready)) await startRound(db, room, refreshed, 1);
    return;
  }

  if (action.action === "expire") return;

  if (action.action === "continue") {
    if (room.status !== "round_result") throw new GameError("This round is not over yet", 409);
    await db.from("players").update({ ready: true }).eq("id", player.id);
    const refreshed = await playersFor(db, room.id);
    if (refreshed.every((p) => p.ready)) {
      if (room.current_round === 1) await startRound(db, room, refreshed, 2);
      else {
        await db.from("players").update({ ready: false }).eq("room_id", room.id);
        await db.from("rooms").update({ status: "finished", version: room.version + 1 }).eq("id", room.id);
      }
    }
    return;
  }

  if (action.action === "play_again") {
    if (room.status !== "finished") throw new GameError("Finish this game first", 409);
    await db.from("players").update({ ready: true }).eq("id", player.id);
    const refreshed = await playersFor(db, room.id);
    if (refreshed.every((p) => p.ready)) {
      await db.from("rounds").delete().eq("room_id", room.id);
      await db.from("players").update({ ready: false, round1_score: 0, round2_score: 0 }).eq("room_id", room.id);
      await db.from("rooms").update({ status: "lobby", current_round: 1, current_word_index: 0, clues_used: 0, round_ends_at: null, version: room.version + 1 }).eq("id", room.id);
    }
    return;
  }

  if (room.status !== "playing") throw new GameError("The round is not active", 409);
  const round = await activeRound(db, room);
  if (!round) throw new GameError("Round data is missing", 500);
  const answer = round.words[room.current_word_index];

  if (action.action === "clue") {
    if (round.giver_id !== player.id) throw new GameError("Only the clue giver can send clues", 403);
    if (!canUseClue(action.clue, room.clues_used)) throw new GameError(`You have ${CLUE_WORD_LIMIT - room.clues_used} clue words left`);
    if (normalizeWord(action.clue).includes(normalizeWord(answer))) throw new GameError("Your clue cannot contain the secret word");
    const amount = countClueWords(action.clue);
    const { data: claimed, error } = await db.from("rooms").update({ clues_used: room.clues_used + amount, version: room.version + 1 }).eq("id", room.id).eq("version", room.version).select("id").maybeSingle();
    if (error || !claimed) throw new GameError("The room changed. Try that clue again.", 409);
    await db.from("rounds").update({ latest_clue: action.clue, clues: [...(round.clues ?? []), { text: action.clue, at: new Date().toISOString() }] }).eq("id", round.id);
    return;
  }

  if (action.action === "guess") {
    if (round.guesser_id !== player.id) throw new GameError("Only the guesser can submit guesses", 403);
    if (!isCorrectGuess(action.guess, answer)) throw new GameError("Not quite — try again", 422, "WRONG_GUESS");
  } else if (action.action === "skip") {
    if (round.giver_id !== player.id) throw new GameError("Only the clue giver can skip", 403);
  } else return;

  const statuses = [...round.statuses];
  statuses[room.current_word_index] = action.action === "guess" ? "guessed" : "skipped";
  const nextIndex = room.current_word_index + 1;
  if (nextIndex < WORDS_PER_ROUND) statuses[nextIndex] = "active";
  const score = scoreStatuses(statuses);
  await db.from("rounds").update({ statuses, score, latest_clue: null }).eq("id", round.id);
  if (nextIndex >= WORDS_PER_ROUND) await finishRound(db, { ...room, current_word_index: nextIndex }, { ...round, statuses, score });
  else await db.from("rooms").update({ current_word_index: nextIndex, version: room.version + 1 }).eq("id", room.id);
}
