import { after, NextResponse } from "next/server";
import { startLive } from "@/lib/live";
import type { SearchParams } from "@/lib/types";
import { triggerStep } from "../step/trigger";

export const dynamic = "force-dynamic";

/** Start a resumable background search; returns its id. Progress: /api/search/status?id=… */
export async function POST(req: Request) {
  const params = (await req.json()) as SearchParams;
  if (!params?.origin?.length || !params?.dest?.length) return NextResponse.json({ error: "missing airports" }, { status: 400 });
  const { id, runner } = await startLive(params);
  const origin = new URL(req.url).origin;
  if (runner === "vercel") after(() => triggerStep(origin, id));
  return NextResponse.json({ id, runner });
}
