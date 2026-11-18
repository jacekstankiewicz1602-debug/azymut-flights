import { NextResponse } from "next/server";
import { estimate } from "@/lib/estimate";
import type { SearchParams } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Before the start: "Szybki wynik ~30 s, pełne szukanie ~15 min", from similar searches. */
export async function POST(req: Request) {
  const p = (await req.json().catch(() => null)) as SearchParams | null;
  if (!p?.dest?.length || !p.dateFrom || !p.dateTo) return NextResponse.json({ error: "missing params" }, { status: 400 });
  return NextResponse.json(await estimate(p));
}
