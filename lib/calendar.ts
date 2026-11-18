// Price calendar for the form (Google Flights' GetCalendarGraph): the lowest fare per departure day,
// one-way or round trip, for the main airport pairs of a search. Indicative (Google, through tickets),
// cached 6 h; the search itself prices separate tickets.
import { AP } from "./airports";
import { withDeparture } from "./departure";
import { addDays, monthEnd } from "./time";
import type { SearchParams } from "./types";
import { cachedJson, pace, politeFetch, randomUA } from "./sources/http";

export type Day = { date: string; price: number };
export type Cell = { out: string; ret: string; price: number };

const BIG = "WAW BER KRK PRG VIE GDN KTW WRO POZ BUD".split(" ");

/** The airports the calendar asks about: home first, then the biggest departure options. */
export function calendarPairs(p: SearchParams): { from: string[]; to: string[] } {
  const d = withDeparture(p);
  const pool = [...d.origin, ...(d.ground ?? [])];
  const from = [...new Set([...(p.access === false ? [] : [d.origin[0]]), ...BIG.filter((c) => pool.includes(c)), ...pool])].slice(0, 3);
  return { from, to: p.dest.filter((c) => AP[c]).slice(0, 2) };
}

async function graph(from: string, to: string, d0: string, d1: string, rt: { min: number; max: number } | null): Promise<Cell[] | null> {
  const key = `g:cal:${from}:${to}:${d0}:${d1}:${rt ? rt.min + "-" + rt.max : "ow"}`;
  const { value } = await cachedJson<Cell[]>(key, 6 * 3600, async () => {
    await pace("gcal", 250 + Math.random() * 200);
    const wrap = (c: string) => [[[c, 0]]];
    const seg = (x: string, y: string, d: string) => [wrap(x), wrap(y), null, 0, null, null, d, null, null, null, null, null, null, null, 3];
    const legs = rt ? [seg(from, to, d0), seg(to, from, addDays(d0, rt.min))] : [seg(from, to, d0)];
    const filters = [null, [null, null, rt ? 1 : 2, null, [], 1, [1, 0, 0, 0], null, null, null, null, null, null, legs, null, null, null, 1], [d0, d1], null, rt ? [rt.min, rt.max] : null];
    const text = await politeFetch(
      "https://www.google.com/_/FlightsFrontendUi/data/travel.frontend.flights.FlightsFrontendService/GetCalendarGraph?hl=en&curr=PLN",
      { method: "POST", body: "f.req=" + encodeURIComponent(JSON.stringify([null, JSON.stringify(filters)])),
        headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8", "user-agent": randomUA() } }, "google", 2);
    if (!text) return null;
    try {
      const line = text.replace(/^\)\]\}'\s*/, "").split("\n").find((l) => l.startsWith("[["));
      const inner = line ? JSON.parse(JSON.parse(line)[0][2] ?? "null") : null;
      const rows = (inner && inner[inner.length - 1]) || [];
      return (rows as [string, string | null, [[null, number]] | null][])
        .filter((r) => r[2]?.[0]?.[1])
        .map((r) => ({ out: r[0], ret: r[1] ?? "", price: r[2]![0][1] }));
    } catch { return null; }
  });
  return value;
}

const months = (start: string, n: number) => Array.from({ length: n }, (_, i) => {
  const d = new Date(Date.parse(start.slice(0, 7) + "-01") + 0);
  d.setUTCMonth(d.getUTCMonth() + i);
  return d.toISOString().slice(0, 7);
});

/** Lowest price per departure day over `n` months from `start` (YYYY-MM). */
export async function priceCalendar(p: SearchParams, start: string, n: number, tomorrow: string): Promise<{ days: Day[]; from: string[]; to: string[] }> {
  const pairs = calendarPairs(p);
  // the two main departure airports and the main destination, all months in parallel
  const from = pairs.from.slice(0, 2), to = pairs.to.slice(0, 1);
  const rt = p.oneWay ? null : { min: p.stayMin, max: Math.min(p.stayMax, p.stayMin + 3) };
  const best = new Map<string, number>();
  const jobs: Promise<Cell[] | null>[] = [];
  for (const m of months(start, n)) {
    const d0 = `${m}-01` < tomorrow ? tomorrow : `${m}-01`, d1 = monthEnd(m);
    if (d0 > d1) continue;
    for (const f of from) for (const t of to) jobs.push(graph(f, t, d0, d1, rt));
  }
  for (const list of await Promise.all(jobs)) {
    for (const c of list ?? []) if (!best.has(c.out) || c.price < best.get(c.out)!) best.set(c.out, c.price);
  }
  return { days: [...best].map(([date, price]) => ({ date, price })).sort((a, b) => a.date.localeCompare(b.date)), from, to };
}

/** Departure × return grid around a departure day (±7 days), every stay length in the range. */
export async function priceGrid(p: SearchParams, around: string, tomorrow: string): Promise<Cell[]> {
  const { from, to } = calendarPairs(p);
  const d0 = addDays(around, -7) < tomorrow ? tomorrow : addDays(around, -7), d1 = addDays(around, 7);
  const best = new Map<string, Cell>();
  const jobs: Promise<Cell[] | null>[] = [];
  for (let a = p.stayMin; a <= p.stayMax; a += 4) jobs.push(graph(from[0], to[0], d0, d1, { min: a, max: Math.min(p.stayMax, a + 3) }));
  for (const list of await Promise.all(jobs)) {
    for (const c of list ?? []) {
      const k = c.out + c.ret;
      if (!best.has(k) || c.price < best.get(k)!.price) best.set(k, c);
    }
  }
  return [...best.values()];
}
