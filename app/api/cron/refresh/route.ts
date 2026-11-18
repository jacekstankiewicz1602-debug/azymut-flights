import { NextResponse } from "next/server";
import { refreshMap } from "@/lib/map";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Daily world-map refresh (Vercel Cron sends Authorization: Bearer $CRON_SECRET).
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const log: string[] = [];
  const calls = await refreshMap(Date.now() + 280_000, (s) => log.push(s));
  return NextResponse.json({ ok: true, calls, log });
}
