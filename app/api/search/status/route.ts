import { after, NextResponse } from "next/server";
import { claimStale, liveStatus, workerOnline } from "@/lib/live";
import { triggerStep } from "../step/trigger";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const u = new URL(req.url);
  const id = u.searchParams.get("id") ?? "";
  const s = await liveStatus(id, Number(u.searchParams.get("since") ?? 0));
  if (!s) return NextResponse.json({ error: "not found" }, { status: 404 });
  // watchdog: a step that died without handing over is resumed from the last checkpoint
  if (s.status === "running" && (await claimStale(id))) after(() => triggerStep(u.origin, id));
  const worker = s.runner === "worker" && s.status === "running" ? await workerOnline().catch(() => null) : null;
  return NextResponse.json({ ...s, worker: worker ? { online: true, busyWith: (worker.info as { current?: string } | null)?.current ?? null } : s.runner === "worker" ? { online: false } : null });
}
