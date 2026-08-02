import { NextRequest, NextResponse } from "next/server";
import { ZodError } from "zod";
import { createRoom, GameError, getState, joinRoom, mutateGame } from "@/lib/game/server";
import { gameActionSchema, stateQuerySchema } from "@/lib/game/validation";
import { getAdminClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

function errorResponse(error: unknown) {
  if (error instanceof ZodError) return NextResponse.json({ error: error.issues[0]?.message ?? "Invalid request" }, { status: 400 });
  if (error instanceof GameError) return NextResponse.json({ error: error.message }, { status: error.status });
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
    const action = gameActionSchema.parse(await request.json());
    const db = getAdminClient();
    if (action.action === "create") return NextResponse.json(await createRoom(db, action.name, action.avatar), { status: 201 });
    if (action.action === "join") return NextResponse.json(await joinRoom(db, action.name, action.code, action.avatar), { status: 201 });
    const playerId = request.headers.get("x-player-id");
    const token = request.headers.get("x-player-token");
    if (!playerId || !token) throw new GameError("Missing room session", 401);
    await mutateGame(db, action, playerId, token);
    const state = await getState(db, action.code, playerId, token);
    return NextResponse.json({ state });
  } catch (error) { return errorResponse(error); }
}
