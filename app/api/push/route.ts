import { NextResponse } from "next/server";
import { notifySearch, publicKey, subscribe, unsubscribe } from "@/lib/push";

export async function GET() {
  return NextResponse.json({ key: await publicKey() });
}

export async function POST(req: Request) {
  const { search, lang, cur, ...sub } = (await req.json().catch(() => ({}))) as { search?: string; lang?: string; cur?: string; endpoint?: string; keys?: unknown };
  if (!sub?.endpoint || !sub?.keys) return NextResponse.json({ error: "bad subscription" }, { status: 400 });
  await subscribe(sub as never, lang === "en" ? "en" : "pl", typeof cur === "string" && /^[A-Z]{3}$/.test(cur) ? cur : "PLN");
  // "Powiadom mnie" tapped during a search: this device gets that search's notification
  if (typeof search === "string" && search) await notifySearch(search, sub.endpoint);
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: Request) {
  const { endpoint } = (await req.json().catch(() => ({}))) as { endpoint?: string };
  if (endpoint) await unsubscribe(endpoint);
  return NextResponse.json({ ok: true });
}
