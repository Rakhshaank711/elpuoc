import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { ZodError } from "zod";
import { createRoom, GameError, getState, joinRoom, mutateGame } from "@/lib/game/server";
import { gameActionSchema, stateQuerySchema } from "@/lib/game/validation";
import { getAdminClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

async function broadcastChange(
  db: ReturnType<typeof getAdminClient>,
  roomId: string,
  actorId: string,
) {
  const channel = db.channel(`room:${roomId}`);
  try {
    const result = await channel.httpSend("state_changed", { actorId }, { timeout: 2_500 });
    if (!result.success) console.error("Realtime game sync failed", result.status, result.error);
  } catch (error) {
    // The persistent mutation succeeded, so a transient broadcast failure must not
    // turn it into a failed action. Clients reconcile on focus and on the interval.
    console.error("Realtime game sync failed", error);
  } finally {
    await db.removeChannel(channel).catch(() => undefined);
  }
}

async function enforceEntryRateLimit(request: NextRequest, db: ReturnType<typeof getAdminClient>, scope: string) {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const ip = forwarded || request.headers.get("x-real-ip") || "unknown";
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY || "local";
  const key = createHash("sha256").update(`${secret}:${scope}:${ip}`).digest("hex");
  const { data, error } = await db.rpc("consume_api_rate_limit", {
    p_key: key,
    p_limit: scope === "create" ? 10 : 40,
    p_window_seconds: 3600,
  });
  if (error) throw new GameError("Could not verify the request limit", 503);
  if (!data) throw new GameError("Too many attempts — please try again later", 429);
}

function rejectCrossSiteRequest(request: NextRequest) {
  const site = request.headers.get("sec-fetch-site");
  if (site === "cross-site") throw new GameError("Cross-site requests are not allowed", 403);
}

function errorResponse(error: unknown) {
  if (error instanceof ZodError) return NextResponse.json({ error: error.issues[0]?.message ?? "Invalid request" }, { status: 400 });
  if (error instanceof GameError) return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
  if (error instanceof Error && error.message === "SUPABASE_NOT_CONFIGURED") {
    return NextResponse.json({ error: "Supabase is not configured yet. Add the environment variables from .env.example." }, { status: 503 });
  }
  console.error(error);
  return NextResponse.json({ error: "Something went wrong" }, { status: 500 });
}

export async function GET(request: NextRequest) {
  try {
    const query = stateQuerySchema.parse(Object.fromEntries(request.nextUrl.searchParams));
    const token = request.headers.get("x-player-token");
    if (!token) throw new GameError("Missing room session", 401);
    const state = await getState(getAdminClient(), query.code, query.playerId, token);
    return NextResponse.json({ state }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: NextRequest) {
  try {
    rejectCrossSiteRequest(request);
    const action = gameActionSchema.parse(await request.json());
    const db = getAdminClient();
    if (action.action === "create") {
      await enforceEntryRateLimit(request, db, "create");
      return NextResponse.json(await createRoom(db, action.name, action.avatar), { status: 201 });
    }
    if (action.action === "join") {
      await enforceEntryRateLimit(request, db, "join");
      const result = await joinRoom(db, action.name, action.code, action.avatar);
      const state = await getState(db, action.code, result.session.playerId, result.session.token);
      await broadcastChange(db, state.roomId, result.session.playerId);
      return NextResponse.json(result, { status: 201 });
    }
    const playerId = request.headers.get("x-player-id");
    const token = request.headers.get("x-player-token");
    if (!playerId || !token) throw new GameError("Missing room session", 401);
    try {
      const mutation = await mutateGame(db, action, playerId, token);
      if (!mutation?.roomId) throw new GameError("Could not synchronize the room", 500);
      const [state] = await Promise.all([
        getState(db, action.code, playerId, token),
        broadcastChange(db, mutation.roomId, playerId),
      ]);
      return NextResponse.json({ state });
    } catch (error) {
      if (error instanceof GameError && error.code === "WRONG_GUESS") {
        const state = await getState(db, action.code, playerId, token);
        await broadcastChange(db, state.roomId, playerId);
        return NextResponse.json({ error: error.message, code: error.code, state }, { status: error.status });
      }
      throw error;
    }
  } catch (error) { return errorResponse(error); }
}
