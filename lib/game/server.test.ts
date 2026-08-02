import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { getState, mutateGame } from "./server";

const actionId = "00000000-0000-4000-8000-000000000001";
const playerId = "00000000-0000-4000-8000-000000000002";

describe("transactional game mutations", () => {
  it("loads and validates a complete state through one RPC", async () => {
    const roomId = "00000000-0000-4000-8000-000000000003";
    const state = {
      roomId, code: "LOVE42", status: "lobby", currentRound: 1, currentWordIndex: 0,
      cluesUsed: 0, clueLimit: 15, version: 1, messages: [], round: null,
      players: [{ id: playerId, name: "Alex", role: "host", avatar: 0, ready: false, round1Score: 0, round2Score: 0 }],
      you: { id: playerId, role: "host", roundRole: null },
    };
    const rpc = vi.fn().mockResolvedValue({ data: state, error: null });
    await expect(getState({ rpc } as unknown as SupabaseClient, "LOVE42", playerId, "token")).resolves.toEqual(state);
    expect(rpc).toHaveBeenCalledOnce();
  });

  it("sends a clue through one idempotent RPC with server-counted words", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { outcome: "ok", roomId: "room-1", version: 2 }, error: null });
    const db = { rpc } as unknown as SupabaseClient;
    await expect(mutateGame(db, { action: "clue", actionId, code: "LOVE42", clue: "six bright strings" }, playerId, "token"))
      .resolves.toMatchObject({ outcome: "ok", roomId: "room-1" });
    expect(rpc).toHaveBeenCalledOnce();
    expect(rpc).toHaveBeenCalledWith("mutate_game", expect.objectContaining({
      p_action_id: actionId,
      p_action: "clue",
      p_text: "six bright strings",
      p_word_count: 3,
    }));
  });

  it("preserves an authoritative wrong guess while returning typed feedback", async () => {
    const db = { rpc: vi.fn().mockResolvedValue({ data: { outcome: "wrong_guess", roomId: "room-1", version: 3 }, error: null }) } as unknown as SupabaseClient;
    await expect(mutateGame(db, { action: "guess", actionId, code: "LOVE42", guess: "Piano" }, playerId, "token"))
      .rejects.toMatchObject({ code: "WRONG_GUESS", status: 422 });
  });

  it("maps database authorization failures without exposing internals", async () => {
    const db = { rpc: vi.fn().mockResolvedValue({ data: null, error: { message: "GAME_403|Only the clue giver can skip" } }) } as unknown as SupabaseClient;
    await expect(mutateGame(db, { action: "skip", actionId, code: "LOVE42" }, playerId, "token"))
      .rejects.toEqual(expect.objectContaining({ status: 403, message: "Only the clue giver can skip" }));
  });
});
