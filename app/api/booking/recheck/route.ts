import { NextResponse } from "next/server";
import type { Trip } from "@/lib/engine";
import { recheckTrip } from "@/lib/recheck";
import { sqlClient } from "@/lib/db";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** "Zarezerwuj": every ticket of the trip priced again live before the person buys. */
export async function POST(req: Request) {
  const { id, trip } = (await req.json().catch(() => ({}))) as { id?: string; trip?: Trip };
  if (!trip?.legs?.length) return NextResponse.json({ error: "missing trip" }, { status: 400 });
  let pax = 1;
  if (id) {
    const sql = await sqlClient();
    const [r] = sql ? await sql`select params->>'pax' as pax from live_searches where id = ${id}`.catch(() => []) : [];
    pax = Number((r as { pax?: string } | undefined)?.pax ?? 1) || 1;
  }
  return NextResponse.json(await recheckTrip(trip, pax));
}
