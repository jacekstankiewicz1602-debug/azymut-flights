import { after, NextResponse } from "next/server";
import { runStep } from "@/lib/live";
import { triggerStep } from "./trigger";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// One ~165 s slice of a background search. Called by /start and by the previous step (self-chain).
export async function POST(req: Request) {
  if (!process.env.CRON_SECRET || req.headers.get("x-step-key") !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = (await req.json()) as { id: string };
  const origin = new URL(req.url).origin;
  after(async () => {
    const more = await runStep(id);
    if (more) await triggerStep(origin, id);
  });
  return NextResponse.json({ accepted: true }, { status: 202 });
}
