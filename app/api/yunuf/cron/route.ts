import { NextRequest, NextResponse } from "next/server";
import { getAdminClient } from "@/lib/supabase/server";
import { processExpiredYunufRooms } from "@/lib/yunuf/server";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try { return NextResponse.json({ advanced: await processExpiredYunufRooms(getAdminClient()) }); }
  catch (error) { console.error(error); return NextResponse.json({ error: "Timeout processing failed" }, { status: 500 }); }
}
