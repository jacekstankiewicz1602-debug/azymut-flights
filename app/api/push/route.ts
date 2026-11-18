import { NextResponse } from "next/server";
import { publicKey, subscribe, unsubscribe } from "@/lib/push";

export async function GET() {
  return NextResponse.json({ key: await publicKey() });
}

export async function POST(req: Request) {
  const sub = await req.json().catch(() => null);
  if (!sub?.endpoint || !sub?.keys) return NextResponse.json({ error: "bad subscription" }, { status: 400 });
  await subscribe(sub);
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: Request) {
  const { endpoint } = (await req.json().catch(() => ({}))) as { endpoint?: string };
  if (endpoint) await unsubscribe(endpoint);
  return NextResponse.json({ ok: true });
}
