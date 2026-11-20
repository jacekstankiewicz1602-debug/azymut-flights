import { NextResponse } from "next/server";
import { suggest } from "@/lib/suggest";

export async function GET(req: Request) {
  const u = new URL(req.url).searchParams;
  const q = u.get("q") ?? "";
  return NextResponse.json(suggest(q.slice(0, 60), 8, u.get("lang") === "en" ? "en" : "pl"), { headers: { "cache-control": "private, max-age=3600" } });
}
