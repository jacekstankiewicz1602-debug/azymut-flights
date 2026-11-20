import { NextResponse } from "next/server";
import { rates } from "@/lib/rates";

export const dynamic = "force-dynamic";

/** PLN → every currency, for the price display. */
export async function GET() {
  const r = await rates();
  if (!r) return NextResponse.json({ error: "no rates" }, { status: 503 });
  return NextResponse.json(r, { headers: { "cache-control": "private, max-age=3600" } });
}
