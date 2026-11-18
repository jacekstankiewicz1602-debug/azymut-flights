import { NextResponse } from "next/server";
import { requestStop } from "@/lib/live";

export const dynamic = "force-dynamic";

/** "Zatrzymaj i pokaż wynik": the search stops after the check in progress and keeps its best trips. */
export async function POST(req: Request) {
  const { id } = (await req.json().catch(() => ({}))) as { id?: string };
  if (!id) return NextResponse.json({ error: "missing id" }, { status: 400 });
  const ok = await requestStop(id);
  return NextResponse.json({ ok });
}
