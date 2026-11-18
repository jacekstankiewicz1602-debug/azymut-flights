import { NextResponse } from "next/server";
import { bellValue } from "@/lib/bell";

export const dynamic = "force-dynamic";

// Polled by the idle laptop worker (Authorization: Bearer $CRON_SECRET); no database access.
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return NextResponse.json({ bell: await bellValue() });
}
