import { createHash } from "node:crypto";
import { after, NextRequest, NextResponse } from "next/server";
import { ZodError } from "zod";
import { getAdminClient } from "@/lib/supabase/server";
import { createYunufRoom, endYunufRoom, getYunufHistory, getYunufState, joinYunufRoom, mutateYunuf, YunufServerError } from "@/lib/yunuf/server";
import { yunufActionSchema, yunufQuerySchema } from "@/lib/yunuf/validation";

export const runtime = "nodejs";

async function broadcast(db: ReturnType<typeof getAdminClient>, roomId: string, event: "state_changed" | "room_ended", payload: Record<string, string>) {
  const channel = db.channel(`yunuf:${roomId}`);
  try { await channel.httpSend(event, payload, { timeout: 2_500 }); }
  catch (error) { console.error("Yunuf realtime broadcast failed", error); }
  finally { await db.removeChannel(channel).catch(() => undefined); }
}

async function rateLimit(request: NextRequest, scope: "create" | "join", db: ReturnType<typeof getAdminClient>) {
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || "unknown";
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY || "local";
  const key = createHash("sha256").update(`${secret}:yunuf:${scope}:${ip}`).digest("hex");
  const { data, error } = await db.rpc("consume_api_rate_limit", { p_key: key, p_limit: scope === "create" ? 10 : 50, p_window_seconds: 3600 });
  if (error) throw new YunufServerError("Could not verify the request limit.", 503);
  if (!data) throw new YunufServerError("Too many attempts — please try again later.", 429);
}

function errorResponse(error: unknown) {
  if (error instanceof ZodError) return NextResponse.json({ error: error.issues[0]?.message ?? "Invalid request." }, { status: 400 });
  if (error instanceof YunufServerError) return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
  if (error instanceof Error && error.message === "SUPABASE_NOT_CONFIGURED") return NextResponse.json({ error: "Supabase is not configured." }, { status: 503 });
  console.error(error);
  return NextResponse.json({ error: "Something went wrong." }, { status: 500 });
}

export async function GET(request: NextRequest) {
  try {
    const query = yunufQuerySchema.parse(Object.fromEntries(request.nextUrl.searchParams));
    const token = request.headers.get("x-player-token");
    if (!token) throw new YunufServerError("Missing Yunuf room session.", 401);
    if (query.view === "log") {
      const events = await getYunufHistory(getAdminClient(), query.code, query.playerId, token);
      return NextResponse.json({ events }, { headers: { "Cache-Control": "no-store" } });
    }
    const state = await getYunufState(getAdminClient(), query.code, query.playerId, token);
    return NextResponse.json({ state }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: NextRequest) {
  try {
    if (request.headers.get("sec-fetch-site") === "cross-site") throw new YunufServerError("Cross-site requests are not allowed.", 403);
    const action = yunufActionSchema.parse(await request.json());
    const db = getAdminClient();
    if (action.action === "create") {
      await rateLimit(request, "create", db);
      return NextResponse.json(await createYunufRoom(db, action.name, action.avatar, action.eliminationScore, action.turnDurationSeconds), { status: 201 });
    }
    if (action.action === "join") {
      await rateLimit(request, "join", db);
      const result = await joinYunufRoom(db, action.name, action.avatar, action.code);
      const state = await getYunufState(db, action.code, result.session.playerId, result.session.token);
      after(() => broadcast(db, state.roomId, "state_changed", { actorId: result.session.playerId }));
      return NextResponse.json(result, { status: 201 });
    }
    const playerId = request.headers.get("x-player-id");
    const token = request.headers.get("x-player-token");
    if (!playerId || !token) throw new YunufServerError("Missing Yunuf room session.", 401);
    if (action.action === "end_room") {
      const ended = await endYunufRoom(db, action.code, playerId, token, action.expectedVersion);
      after(() => broadcast(db, ended.roomId, "room_ended", { actorId: playerId, actorName: ended.actorName }));
      return NextResponse.json({ ended: true });
    }
    const mutation = await mutateYunuf(db, action, playerId, token);
    const state = "state" in mutation ? mutation.state : await getYunufState(db, action.code, playerId, token);
    after(() => broadcast(db, mutation.roomId, "state_changed", { actorId: playerId }));
    return NextResponse.json({ state });
  } catch (error) { return errorResponse(error); }
}
