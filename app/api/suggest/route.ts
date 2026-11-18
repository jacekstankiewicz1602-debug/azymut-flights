import { NextResponse } from "next/server";
import { suggest } from "@/lib/suggest";

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams.get("q") ?? "";
  return NextResponse.json(suggest(q.slice(0, 60)), { headers: { "cache-control": "private, max-age=3600" } });
}
