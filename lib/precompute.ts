// Popular directions computed overnight: the top directions from the search history and the
// "Gdziekolwiek tanio" list each get a short fast search for the next months; a later search of the same
// direction shows these trips at once (marked as overnight prices) while the live search runs.
import { sqlClient } from "./db";
import { pickTrips, runSearch, type Trip } from "./engine";
import { parseQuery } from "./parse";
import type { SearchParams } from "./types";

const MONTHS_PL = ["styczeń", "luty", "marzec", "kwiecień", "maj", "czerwiec", "lipiec", "sierpień", "wrzesień", "październik", "listopad", "grudzień"];
export const directionKey = (p: Pick<SearchParams, "dest" | "oneWay">) => `${[...p.dest].sort().join(",")}|${p.oneWay ? "ow" : "rt"}`;

async function ensure() {
  const s = await sqlClient();
  if (!s) return null;
  await s`create table if not exists precomputed (key text not null, month text not null, params jsonb not null, trips jsonb not null, computed_at timestamptz not null default now(), primary key (key, month))`;
  return s;
}

export async function precomputeDue(): Promise<boolean> {
  const s = await ensure();
  if (!s) return false;
  const [r] = await s`select max(computed_at) as last from precomputed`;
  const hour = new Date().getHours();
  const age = r?.last ? Date.now() - new Date(r.last).getTime() : Infinity;
  return hour >= 1 && hour < 8 && age > 20 * 3600_000;
}

/** Top directions: the ones watched on the radar, the most searched in the last 60 days, then the cheapest far ones of the nightly list. */
async function popular(limit: number): Promise<string[]> {
  const s = (await ensure())!;
  const hist = await s`select params->>'destLabel' as label, count(*)::int as n from live_searches
    where created_at > now() - interval '60 days' and coalesce(params->>'mode', 'route') <> 'anywhere' and params->>'destLabel' is not null
    group by 1 order by 2 desc limit ${limit}`.catch(() => []);
  const any = await s`select dest from anywhere_cheap where price is not null order by price asc limit ${limit}`.catch(() => []);
  const watched = await s`select label from radar_watch order by created_at desc`.catch(() => []);
  const out: string[] = [];
  for (const r of watched as unknown as { label: string }[]) if (r.label && !out.includes(r.label)) out.push(r.label);
  for (const r of hist as unknown as { label: string }[]) if (r.label && !out.includes(r.label)) out.push(r.label);
  for (const r of any as unknown as { dest: string }[]) if (!out.includes(r.dest)) out.push(r.dest);
  return out.slice(0, limit);
}

/** One short search per popular direction and month (next month and the one after). */
export async function runPrecompute(interrupted: () => Promise<boolean>, log: (s: string) => void, limit = 100, secondsEach = 60) {
  const s = await ensure();
  if (!s) return;
  const dirs = await popular(limit);
  const now = new Date();
  const months = [1, 2].map((k) => new Date(Date.UTC(now.getFullYear(), now.getMonth() + k, 1)));
  log(`${dirs.length} kierunków × ${months.length} mies.`);
  for (const d of dirs) for (const m of months) {
    if (await interrupted()) { log("przerwane: czeka wyszukiwanie"); return; }
    const month = m.toISOString().slice(0, 7);
    const parsed = await parseQuery(`z Polski do ${d}, ${MONTHS_PL[m.getUTCMonth()]} ${m.getUTCFullYear()}, tam i z powrotem`).catch(() => null);
    const p = parsed?.params;
    if (!p?.dest?.length) continue;
    const t0 = Date.now();
    const r = await runSearch(p, () => {}, undefined, { deadline: t0 + secondsEach * 1000, hardStop: t0 + (secondsEach + 30) * 1000, final: false }).catch(() => null);
    if (!r?.trips.length) continue;
    const trips = pickTrips(r.trips, p.dest, 5);
    await s`insert into precomputed (key, month, params, trips) values (${directionKey(p)}, ${month}, ${s.json(p as never)}, ${s.json(trips as never)})
      on conflict (key, month) do update set params = excluded.params, trips = excluded.trips, computed_at = now()`;
    log(`${d} ${month}: od ${trips[0].price} zł (${Math.round((Date.now() - t0) / 1000)} s)`);
  }
  await s`delete from precomputed where computed_at < now() - interval '3 days'`;
}

/** Overnight trips for this search's direction inside its date window (at most a day old). */
export async function precomputedFor(p: SearchParams): Promise<Trip[]> {
  if (p.mode === "anywhere") return [];
  const s = await ensure();
  if (!s) return [];
  const rows = await s`select trips from precomputed where key = ${directionKey(p)} and computed_at > now() - interval '30 hours'`.catch(() => []);
  const lo = new Date(Date.parse(p.dateFrom) - 3 * 86400_000).toISOString().slice(0, 10);
  const hi = new Date(Date.parse(p.dateTo) + 3 * 86400_000).toISOString().slice(0, 10);
  const trips = (rows as unknown as { trips: Trip[] }[]).flatMap((r) => r.trips)
    .filter((t) => t.outDate >= lo && t.outDate <= hi && (p.oneWay || (t.stayDays !== null && t.stayDays >= p.stayMin && t.stayDays <= p.stayMax)));
  return trips.sort((a, b) => a.price - b.price).slice(0, 5)
    .map((t) => ({ ...t, id: `pre-${t.id}`, flags: ["ceny z nocnego przeliczenia – sprawdzam aktualne", ...t.flags.filter((f) => !f.startsWith("ceny z nocnego"))] }));
}

/** Remembered trips for a search: the overnight ones and the best of other searches of the same direction
 *  and settings from the last two days (the engine prices them again live in its first stage). */
export async function rememberedTrips(p: SearchParams, n = 4): Promise<Trip[]> {
  if (p.mode === "anywhere") return [];
  const s = await sqlClient();
  if (!s) return [];
  const same = (q: SearchParams) => directionKey(q) === directionKey(p) && [...(q.departs ?? q.origin)].sort().join() === [...(p.departs ?? p.origin)].sort().join()
    && q.origin[0] === p.origin[0] && (q.baggage ?? "cabin") === (p.baggage ?? "cabin") && !!q.abroad === !!p.abroad && (q.maxAccessH ?? 4) === (p.maxAccessH ?? 4);
  const rows = await s`select params, trips from live_searches where created_at > now() - interval '2 days' and status <> 'error'
    and jsonb_array_length(trips) > 0 order by created_at desc limit 40`.catch(() => []);
  const lo = new Date(Date.parse(p.dateFrom) - 3 * 86400_000).toISOString().slice(0, 10);
  const hi = new Date(Date.parse(p.dateTo) + 3 * 86400_000).toISOString().slice(0, 10);
  // and only trips that really start at this search's departures and reach its destinations (an earlier
  // search of the same direction may have had other departures)
  const home = new Set([...p.origin, ...(p.ground ?? [])]), dest = new Set([...p.dest, ...(p.destRet ?? [])]);
  const ends = (t: Trip) => {
    const out = t.legs.filter((l) => l.dir === "out"), ret = t.legs.filter((l) => l.dir === "ret");
    return !!out.length && home.has(out[0].from) && dest.has(out[out.length - 1].to) && (p.oneWay || (!!ret.length && dest.has(ret[0].from) && home.has(ret[ret.length - 1].to)));
  };
  const fits = (t: Trip) => t.outDate >= lo && t.outDate <= hi && (p.oneWay || (t.stayDays !== null && t.stayDays >= p.stayMin && t.stayDays <= p.stayMax)) && ends(t);
  const seen = new Set<string>();
  return [...(await precomputedFor(p).catch(() => [] as Trip[])), ...(rows as unknown as { params: SearchParams; trips: Trip[] }[]).filter((r) => same(r.params)).flatMap((r) => r.trips)]
    .filter((t) => Number.isFinite(t.price) && !t.google && fits(t))
    .sort((a, b) => a.price - b.price)
    .filter((t) => { const k = t.legs.map((l) => `${l.from}${l.to}${l.depLocal}`).join("|"); if (seen.has(k)) return false; seen.add(k); return true; })
    .slice(0, n);
}
