import { NextResponse } from "next/server";
import { sqlClient } from "@/lib/db";

export const dynamic = "force-dynamic";

/** The latest searches for the "Ostatnie" menu: label, state and the cheapest price found. */
export async function GET() {
  const sql = await sqlClient();
  if (!sql) return NextResponse.json({ items: [] });
  const rows = await sql`select id, params->>'originLabel' as o, params->>'destLabel' as d, params->>'query' as q, params->>'depth' as depth,
      status, (trips->0->>'price')::int as price, created_at from live_searches order by created_at desc limit 20`.catch(() => []);
  return NextResponse.json({ items: rows.map((r) => ({ id: r.id, label: r.o && r.d ? `${r.o} → ${r.d}` : r.q, status: r.status, price: r.price ?? null, deep: r.depth === "deep", at: r.created_at })) });
}
