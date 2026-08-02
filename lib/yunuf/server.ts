import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  autoPlayExpiredTurn, createLobbyState, declareShow, discardCards, drawFromDeck, drawFromDiscard,
  endTurn, startMatch, startNextHand, YunufRuleError,
} from "./engine";
import type { YunufGameEvent, YunufGameState, YunufPlayer, YunufSession, YunufViewState } from "./types";
import { yunufGameEventSchema, yunufGameStateSchema, type YunufAction } from "./validation";

type RoomRow = { id: string; code: string; status: YunufGameState["status"]; host_player_id: string; version: number; elimination_score: number; turn_duration_seconds: number; game_state: unknown };
type PlayerRow = { id: string; room_id: string; name: string; avatar: number; seat: number; role: "host" | "guest"; token_hash: string; ready: boolean };

export class YunufServerError extends Error {
  constructor(message: string, public status = 400, public code?: string) { super(message); }
}

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
const makeToken = () => randomBytes(32).toString("base64url");
const makeCode = () => Array.from(randomBytes(6), (byte) => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[byte % 32]).join("");
const freshPlayer = (row: PlayerRow): YunufPlayer => ({
  id: row.id, name: row.name, avatar: row.avatar, seatIndex: row.seat, hand: [], ready: row.ready,
  connected: false, eliminated: false, totalScore: 0, roundScore: 0, handsWon: 0, jointWins: 0,
  showsDeclared: 0, successfulShows: 0, failedShows: 0, revealHandTotalSum: 0, reveals: 0,
});

function databaseError(message: string, fallback: string) {
  const match = message.match(/YUNUF_(\d+)\|([^\n]+)/);
  return new YunufServerError(match?.[2] || fallback, match ? Number(match[1]) : 500);
}

async function roomByCode(db: SupabaseClient, code: string) {
  const { data, error } = await db.from("yunuf_rooms").select("*").eq("code", code).maybeSingle();
  if (error) throw new YunufServerError("Could not load this Yunuf room.", 500);
  if (!data) throw new YunufServerError("Room not found.", 404);
  return data as RoomRow;
}

async function playerRows(db: SupabaseClient, roomId: string) {
  const { data, error } = await db.from("yunuf_players").select("*").eq("room_id", roomId).order("seat");
  if (error) throw new YunufServerError("Could not load the players.", 500);
  return (data ?? []) as PlayerRow[];
}

async function authenticate(db: SupabaseClient, room: RoomRow, playerId: string, token: string) {
  const { data, error } = await db.from("yunuf_players").select("*").eq("id", playerId).eq("room_id", room.id).maybeSingle();
  const player = data as PlayerRow | null;
  if (error || !player || player.token_hash !== hashToken(token)) throw new YunufServerError("Your Yunuf room session is no longer valid.", 401);
  return player;
}

async function playerById(db: SupabaseClient, playerId: string) {
  const { data, error } = await db.from("yunuf_players").select("*").eq("id", playerId).maybeSingle();
  if (error || !data) throw new YunufServerError("Your Yunuf room session is no longer valid.", 401);
  return data as PlayerRow;
}

function verifyPlayer(room: RoomRow, player: PlayerRow, token: string) {
  if (player.room_id !== room.id || player.token_hash !== hashToken(token)) throw new YunufServerError("Your Yunuf room session is no longer valid.", 401);
  return player;
}

function parseState(room: RoomRow) {
  const parsed = yunufGameStateSchema.safeParse(room.game_state);
  if (!parsed.success) {
    console.error("Invalid Yunuf state", parsed.error.flatten());
    throw new YunufServerError("The saved Yunuf room is invalid.", 500);
  }
  return parsed.data as YunufGameState;
}

async function hydrateLobby(db: SupabaseClient, room: RoomRow, state: YunufGameState) {
  if (room.status !== "lobby") return state;
  const rows = await playerRows(db, room.id);
  return { ...state, players: rows.map(freshPlayer), activePlayerIds: rows.map((row) => row.id) };
}

export function redactYunufState(room: RoomRow, player: PlayerRow, state: YunufGameState): YunufViewState {
  const reveal = state.status === "hand_results" || state.status === "match_over";
  const { drawPile, players, ...publicState } = state;
  return {
    ...publicState, roomId: room.id, code: room.code, version: room.version, hostPlayerId: room.host_player_id,
    you: { id: player.id, role: player.role }, drawPileCount: drawPile.length,
    players: players.map((item) => {
      const { hand, ...safe } = item;
      return { ...safe, cardCount: hand.length, ...(reveal || item.id === player.id ? { hand } : {}) };
    }),
  };
}

async function commitState(db: SupabaseClient, room: RoomRow, playerId: string, actionId: string, state: YunufGameState, events: YunufGameEvent[] = []) {
  const { data, error } = await db.rpc("commit_yunuf_action", {
    p_room_id: room.id, p_player_id: playerId, p_action_id: actionId,
    p_expected_version: room.version, p_status: state.status, p_state: state, p_events: events,
  });
  if (error) throw databaseError(error.message, "Could not update the Yunuf match.");
  return data as { roomId: string; version: number };
}

async function loadFresh(db: SupabaseClient, code: string) { return roomByCode(db, code); }

function makeEvent(state: YunufGameState, type: YunufGameEvent["type"], playerId: string | null, detail: Partial<YunufGameEvent> = {}): YunufGameEvent {
  return { id: randomUUID(), type, playerId, handNumber: state.handNumber, turnNumber: state.turnNumber, createdAt: Date.now(), ...detail };
}

function resolutionEvent(state: YunufGameState) {
  if (!state.result) return null;
  return makeEvent(state, "hand_resolved", state.result.declarerId, {
    winnerIds: state.result.winnerIds, eliminatedIds: state.result.eliminatedIds,
    handValues: state.result.handValues, roundScores: state.result.roundScores,
  });
}

export function createYunufEvents(before: YunufGameState, after: YunufGameState, action: Exclude<YunufAction, { action: "create" | "join" | "ready" }>, playerId: string) {
  const events: YunufGameEvent[] = [];
  switch (action.action) {
    case "start": events.push(makeEvent(after, "match_started", playerId, { cards: after.latestDiscard?.cards })); break;
    case "discard": events.push(makeEvent(after, "discard", playerId, { cards: after.latestDiscard?.cards })); break;
    case "draw_deck": events.push(makeEvent(after, "draw_deck", playerId)); break;
    case "draw_discard": events.push(makeEvent(after, "draw_discard", playerId, { cards: before.drawSourceDiscard?.cards.filter((card) => card.id === action.cardId) })); break;
    case "end_turn": events.push(makeEvent(after, "turn_ended", playerId)); break;
    case "declare_show": events.push(makeEvent(after, "show_declared", playerId)); break;
    case "continue": events.push(makeEvent(after, "hand_started", playerId, { cards: after.latestDiscard?.cards })); break;
    case "reset": events.push(makeEvent(after, "match_reset", playerId)); break;
  }
  if (!before.result && after.result) events.push(resolutionEvent(after)!);
  return events;
}

export async function createYunufRoom(db: SupabaseClient, name: string, avatar: number, eliminationScore: number, turnDurationSeconds: number) {
  const token = makeToken();
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = makeCode();
    const initial = createLobbyState([], eliminationScore, turnDurationSeconds);
    const { data: roomData, error } = await db.from("yunuf_rooms").insert({ code, elimination_score: eliminationScore, turn_duration_seconds: turnDurationSeconds, game_state: initial }).select("*").single();
    if (error?.code === "23505") continue;
    if (error || !roomData) throw new YunufServerError("Could not create a Yunuf room.", 500);
    const room = roomData as RoomRow;
    const { data, error: playerError } = await db.from("yunuf_players").insert({ room_id: room.id, name, avatar, seat: 1, role: "host", token_hash: hashToken(token) }).select("*").single();
    if (playerError || !data) { await db.from("yunuf_rooms").delete().eq("id", room.id); throw databaseError(playerError?.message ?? "", "Could not create the host."); }
    const player = data as PlayerRow;
    await db.from("yunuf_rooms").update({ host_player_id: player.id }).eq("id", room.id);
    return { session: { playerId: player.id, token, code, name, role: "host" } satisfies YunufSession };
  }
  throw new YunufServerError("Could not reserve a room code. Try again.", 503);
}

export async function joinYunufRoom(db: SupabaseClient, name: string, avatar: number, code: string) {
  const room = await roomByCode(db, code);
  if (room.status !== "lobby") throw new YunufServerError("That match has already started.", 409);
  const rows = await playerRows(db, room.id);
  const freeSeat = [1, 2, 3, 4, 5].find((seat) => !rows.some((row) => row.seat === seat));
  if (!freeSeat) throw new YunufServerError("This room is full.", 409);
  const token = makeToken();
  const { data, error } = await db.from("yunuf_players").insert({ room_id: room.id, name, avatar, seat: freeSeat, role: "guest", token_hash: hashToken(token) }).select("*").single();
  if (error || !data) throw databaseError(error?.message ?? "", "Could not join this Yunuf room.");
  const player = data as PlayerRow;
  return { session: { playerId: player.id, token, code, name, role: "guest" } satisfies YunufSession };
}

async function applyExpiredTurn(db: SupabaseClient, room: RoomRow, state: YunufGameState) {
  if (!state.currentPlayerId) return { room, state };
  const advanced = autoPlayExpiredTurn(state);
  if (advanced === state) return { room, state };
  const timedOutPlayer = state.currentPlayerId;
  const events = [makeEvent(advanced, "turn_timed_out", timedOutPlayer, { cards: advanced.latestDiscard?.id !== state.latestDiscard?.id ? advanced.latestDiscard?.cards : undefined })];
  if (!state.result && advanced.result) events.push(resolutionEvent(advanced)!);
  try {
    const result = await commitState(db, room, state.currentPlayerId, randomUUID(), advanced, events);
    return { room: { ...room, version: result.version, status: advanced.status, game_state: advanced }, state: advanced };
  } catch (error) {
    if (error instanceof YunufServerError && error.status === 409) {
      const fresh = await loadFresh(db, room.code);
      return { room: fresh, state: parseState(fresh) };
    }
    throw error;
  }
}

export async function getYunufState(db: SupabaseClient, code: string, playerId: string, token: string) {
  let room = await roomByCode(db, code);
  const player = await authenticate(db, room, playerId, token);
  let state = await hydrateLobby(db, room, parseState(room));
  ({ room, state } = await applyExpiredTurn(db, room, state));
  return redactYunufState(room, player, state);
}

export async function mutateYunuf(db: SupabaseClient, action: Exclude<YunufAction, { action: "create" | "join" }>, playerId: string, token: string) {
  const duplicatePromise = action.action === "ready"
    ? Promise.resolve({ data: null, error: null })
    : db.from("processed_yunuf_actions").select("result").eq("id", action.actionId).eq("player_id", playerId).maybeSingle();
  const [room, actorRow, duplicateResult] = await Promise.all([roomByCode(db, action.code), playerById(db, playerId), duplicatePromise]);
  const actor = verifyPlayer(room, actorRow, token);

  if (action.action === "ready") {
    if (room.status !== "lobby") throw new YunufServerError("The match has already started.", 409);
    const { error } = await db.from("yunuf_players").update({ ready: action.ready }).eq("id", playerId);
    if (error) throw new YunufServerError("Could not update your Ready status.", 500);
    const { error: roomError } = await db.rpc("touch_yunuf_lobby", { p_room_id: room.id });
    if (roomError) throw new YunufServerError("Could not synchronize the lobby.", 409);
    return { roomId: room.id };
  }

  const duplicate = duplicateResult.data as { result: { roomId: string; version: number } } | null;
  if (duplicate) {
    const current = await hydrateLobby(db, room, parseState(room));
    return { ...duplicate.result, state: redactYunufState(room, actor, current) };
  }
  if (action.expectedVersion !== room.version) throw new YunufServerError("The game changed. Refreshing the latest turn.", 409, "STALE_VERSION");

  let state = await hydrateLobby(db, room, parseState(room)); const before = state;
  try {
    switch (action.action) {
      case "start": {
        if (room.host_player_id !== actor.id) throw new YunufServerError("Only the host can start the match.", 403);
        const rows = await playerRows(db, room.id);
        if (rows.length < 2) throw new YunufServerError("At least two players are required.", 422);
        state = startMatch({ ...state, players: rows.map(freshPlayer), activePlayerIds: rows.map((row) => row.id) });
        break;
      }
      case "discard": state = discardCards(state, playerId, action.cardIds); break;
      case "draw_deck": state = drawFromDeck(state, playerId); break;
      case "draw_discard": state = drawFromDiscard(state, playerId, action.cardId); break;
      case "end_turn": state = endTurn(state, playerId); break;
      case "declare_show": state = declareShow(state, playerId); break;
      case "continue":
        if (room.host_player_id !== actor.id) throw new YunufServerError("Only the host can start the next hand.", 403);
        state = startNextHand(state); break;
      case "reset": {
        if (room.host_player_id !== actor.id) throw new YunufServerError("Only the host can reset the match.", 403);
        if (state.status !== "match_over") throw new YunufServerError("The match is not over yet.", 409);
        await db.from("yunuf_players").update({ ready: false }).eq("room_id", room.id);
        const rows = (await playerRows(db, room.id)).map((row) => ({ ...row, ready: false }));
        state = createLobbyState(rows.map(freshPlayer), room.elimination_score, room.turn_duration_seconds);
        break;
      }
    }
  } catch (error) {
    if (error instanceof YunufRuleError) throw new YunufServerError(error.message, error.status, error.code);
    throw error;
  }
  const events = createYunufEvents(before, state, action, playerId);
  const result = await commitState(db, room, playerId, action.actionId, state, events);
  const committedRoom = { ...room, version: result.version, status: state.status, game_state: state };
  return { ...result, state: redactYunufState(committedRoom, actor, state) };
}

export async function getYunufHistory(db: SupabaseClient, code: string, playerId: string, token: string) {
  const room = await roomByCode(db, code);
  await authenticate(db, room, playerId, token);
  const { data, error } = await db.from("yunuf_game_events").select("event").eq("room_id", room.id).order("sequence", { ascending: true });
  if (error) throw new YunufServerError("Could not load the game history.", 500);
  return (data ?? []).map((row) => yunufGameEventSchema.parse(row.event));
}

export async function processExpiredYunufRooms(db: SupabaseClient) {
  const { data, error } = await db.from("yunuf_rooms").select("*").in("status", ["playing", "finishing_round_after_show"]).limit(100);
  if (error) throw new YunufServerError("Could not scan expired Yunuf turns.", 500);
  let advanced = 0;
  for (const row of (data ?? []) as RoomRow[]) {
    const state = parseState(row);
    if (!state.currentPlayerId) continue;
    const next = autoPlayExpiredTurn(state);
    if (next === state) continue;
    const events = [makeEvent(next, "turn_timed_out", state.currentPlayerId, { cards: next.latestDiscard?.id !== state.latestDiscard?.id ? next.latestDiscard?.cards : undefined })];
    if (!state.result && next.result) events.push(resolutionEvent(next)!);
    try { await commitState(db, row, state.currentPlayerId, randomUUID(), next, events); advanced++; }
    catch (cause) { if (!(cause instanceof YunufServerError && cause.status === 409)) console.error("Yunuf timeout failed", row.id, cause); }
  }
  return advanced;
}
