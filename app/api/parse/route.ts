import { NextResponse } from "next/server";
import { parseForm, parseQuery, type SearchForm } from "@/lib/parse";
import type { SearchParams } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const { q, overrides, from, home, form } = (await req.json()) as { q: string; overrides?: Partial<SearchParams>; from?: string; home?: string; form?: SearchForm };
  if (form) return NextResponse.json(parseForm(form));
  if (!q?.trim()) return NextResponse.json({ error: "empty query" }, { status: 400 });
  return NextResponse.json(await parseQuery(q.slice(0, 400), overrides, from?.slice(0, 80), home?.slice(0, 80)));
}
