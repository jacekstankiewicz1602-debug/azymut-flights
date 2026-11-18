import { NextResponse } from "next/server";
import { priceCalendar, priceGrid } from "@/lib/calendar";
import { parseForm, type SearchForm } from "@/lib/parse";
import { addDays, isoDay } from "@/lib/time";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** POST { form, start: "YYYY-MM", months } -> lowest price per day; { form, grid: "YYYY-MM-DD" } -> date grid. */
export async function POST(req: Request) {
  const { form, start, months, grid } = (await req.json()) as { form: SearchForm; start?: string; months?: number; grid?: string };
  const { params, problems } = parseForm(form);
  if (!params.dest.length) return NextResponse.json({ error: problems.join(" · ") || "brak celu" }, { status: 400 });
  const tomorrow = addDays(isoDay(Date.now()), 1);
  if (grid) return NextResponse.json({ cells: await priceGrid(params, grid, tomorrow) });
  return NextResponse.json(await priceCalendar(params, start ?? tomorrow.slice(0, 7), Math.min(6, months ?? 2), tomorrow));
}
