import { NextResponse } from "next/server";
import { addWatch, listDeals, ranked, removeWatch, watches } from "@/lib/radar";

export const dynamic = "force-dynamic";

/** Current deals (anomalies and feed deals), watched destinations and the best hubs per region. */
export async function GET(req: Request) {
  const sort = new URL(req.url).searchParams.get("sort") === "pct" ? "pct" : "price";
  const [deals, watch, hubs] = await Promise.all([listDeals(sort), watches(), ranked()]);
  const top: Record<string, { hub: string; score: number; feed: number; onward: number; to: string }[]> = {};
  for (const h of hubs as unknown as { region: string; hub: string; rank: number; score: number; feed: number; onward: number; onward_to: string }[]) {
    if (h.rank > 6) continue;
    (top[h.region] ??= []).push({ hub: h.hub, score: h.score, feed: h.feed, onward: h.onward, to: h.onward_to });
  }
  return NextResponse.json({ deals, watch, hubs: top });
}

/** { watch: "Peru" } adds a watched destination (alerts), { unwatch: id } removes it. */
export async function POST(req: Request) {
  const b = (await req.json()) as { watch?: string; unwatch?: number };
  if (b.unwatch) { await removeWatch(b.unwatch); return NextResponse.json({ ok: true }); }
  if (!b.watch?.trim()) return NextResponse.json({ error: "empty" }, { status: 400 });
  const p = await addWatch(b.watch.slice(0, 80));
  return p ? NextResponse.json({ ok: true, label: p.label, codes: p.codes.length }) : NextResponse.json({ error: "nie rozpoznano miejsca" }, { status: 400 });
}
