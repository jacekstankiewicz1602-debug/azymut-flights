import { after, NextResponse } from "next/server";
import { startLive } from "@/lib/live";
import type { SearchParams } from "@/lib/types";
import { triggerStep } from "../step/trigger";

export const dynamic = "force-dynamic";

/** Start a resumable background search; returns its id. Progress: /api/search/status?id=… */
export async function POST(req: Request) {
  // notify: the push endpoint of the device starting the search, kept apart from the search's params
  const { notify, ...params } = (await req.json()) as SearchParams & { notify?: string | null };
  if (!params?.origin?.length || !params?.dest?.length) return NextResponse.json({ error: "missing airports" }, { status: 400 });
  const { id, runner } = await startLive(params, typeof notify === "string" ? notify : null);
  const origin = new URL(req.url).origin;
  if (runner === "vercel") after(() => triggerStep(origin, id));
  return NextResponse.json({ id, runner });
}
