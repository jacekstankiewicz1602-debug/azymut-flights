import { NextResponse } from "next/server";
import { config } from "@/lib/config";
import { db } from "@/lib/db";
import { currentCoverage } from "@/lib/map";
import { workerOnline } from "@/lib/live";

export const dynamic = "force-dynamic";

export async function GET() {
  const meta = await db.meta().catch((e) => ({ error: String(e) }));
  const coverage = await currentCoverage().catch(() => db.cacheGet("map:summary").catch(() => null));
  return NextResponse.json({
    map: meta,
    coverage,
    sources: {
      google: true, kiwi: true, ryanair: true, wizz: true, flixbus: true, anthropic: !!config.keys.anthropic,
      serpapi: !!config.keys.serpapi && config.maxPaidCallsPerSearch > 0, duffel: !!config.keys.duffel && config.duffelLive,
    },
    worker: await workerOnline().then((w) => (w ? { online: true, seenAt: w.seenAt } : { online: false })).catch(() => ({ online: false })),
    limits: { paidPerSearch: config.maxPaidCallsPerSearch, freePerSearch: config.maxFreeCallsPerSearch, seconds: config.maxSearchSeconds },
  });
}
