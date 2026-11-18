// "Gdziekolwiek tanio z Polski": the cheapest round trip from Poland to every destination on the map,
// for the next 6 months, stay 5–21 days, with and without the bus from the home city. Computed by
// the laptop worker once a night, in three resumable phases:
//  1. bounds:  per month, Dijkstra on the price map out and back (a lower bound for every destination)
//  2. kiwi:    for the destinations with the lowest bounds, Kiwi's own return combinations
//              (self-transfer included) over two 3-month windows, from two groups of 4 airports
//  3. compose: for the cheapest far destinations, the full engine (separate tickets via hubs, hub
//              return tickets, split at the far hub, the Google offer) on the best month
// Rows live in `anywhere_cheap`; the page reads them through /api/anywhere-cheap.
import { AIRPORTS, AP, km } from "./airports";
import { COUNTRY_AIRPORTS, withDeparture } from "./departure";
import { sqlClient } from "./db";
import { dijkstra, runSearch, type Trip } from "./engine";
import { buildGraph, nextMonths } from "./map";
import { parseForm } from "./parse";
import { flixRides } from "./sources/flixbus";
import { kiwiReturn, type KReturn, type KSeg } from "./sources/kiwi";
import { Meter } from "./sources/http";
import { addDays, isoDay, monthEnd, monthsBetween } from "./time";
import type { SearchParams } from "./types";

export const HOME = "POZ";
export type Variant = "on" | "off"; // bus access from HOME counted / not counted
export type StayBucket = "5-9" | "10-14" | "15-21";
const BUCKETS: [StayBucket, number, number][] = [["5-9", 5, 9], ["10-14", 10, 14], ["15-21", 15, 21]];
const bucketOf = (n: number) => BUCKETS.find(([, a, b]) => n >= a && n <= b)?.[0] ?? null;

// Kiwi answers at most 4 departure airports at a time (see kiwiOneWay): the two groups that hold
// nearly every cheap departure from Poland and its neighbours
/** "Far" (dalekie): outside Europe and at least 3500 km from Warsaw – long-haul, not North Africa, the
 *  Levant or the Caucasus (and not the Canaries, which the map files under Europe). */
export const isFar = (c: string) => !!AP[c] && AP[c].region !== "EUR" && km(AP.WAW, AP[c]) >= 3500;

/** "Gdziekolwiek" means the whole world, each part with its own idea of cheap (round trip from Poland). */
export type Zone = "eu" | "near" | "world" | "long";
export const ZONES: { zone: Zone; label: string; limit: number; cap: number }[] = [
  { zone: "eu", label: "Europa", limit: 400, cap: 400 },
  { zone: "near", label: "Blisko poza Europą", limit: 1500, cap: 1500 },
  { zone: "world", label: "Reszta świata", limit: 3000, cap: 3300 }, // "3000 z kawałkiem" still counts
  { zone: "long", label: "Ameryka Płd. i Australia", limit: 4000, cap: 4000 },
];
export function zoneOf(c: string): Zone {
  const a = AP[c];
  if (!a || a.region === "EUR") return "eu";
  if (a.region === "SAM" || a.region === "OCE") return "long";
  return isFar(c) ? "world" : "near";
}

const GROUPS = [["WAW", "KRK", "POZ", "BER"], ["WMI", "KTW", "GDN", "WRO"]];

/** The nightly list's trips that fit a search (from HOME, its dates and stay, its destinations): a wide
 *  search starts from them, so the full engine's cheapest separate-ticket trips are on its list at once. */
export async function nightlyTrips(p: SearchParams, outFrom: string, outTo: string, starts: string[]): Promise<Trip[]> {
  if (p.oneWay || p.home !== HOME || p.destRet?.length) return [];
  const s = await sqlClient();
  if (!s) return [];
  const variant: Variant = p.access === false ? "off" : "on";
  const from = new Set(starts);
  const rows = await s`select trip from anywhere_cheap where variant = ${variant} and month = any(${monthsBetween(outFrom, outTo)})
    and stay <> 'any' and trip is not null and dest = any(${p.dest}) and out_date >= ${outFrom} and out_date <= ${outTo}`.catch(() => []);
  return rows.map((r) => r.trip as Trip)
    .filter((t) => t.legs?.length && from.has(t.legs[0].from) && t.stayDays !== null && t.stayDays >= p.stayMin && t.stayDays <= p.stayMax)
    .map((t) => ({ ...t, id: `nightly-${t.id}`, flags: ["cena z nocnego sprawdzenia", ...t.flags.filter((f) => f !== "cena z nocnego sprawdzenia")] }));
}

export type Row = {
  dest: string; variant: Variant; month: string; stay: StayBucket | "any";
  price: number | null; lb: number | null; nodes: string[] | null; outDate: string | null; retDate: string | null;
  connections: number | null; travelH: number | null; verified: boolean; source: string;
  access: number | null; google: number | null; deal: boolean; norm: number | null; trip: Trip | null; updatedAt: number; zone?: Zone;
};

async function ensure() {
  const s = await sqlClient();
  if (!s) throw new Error("anywhere-cheap needs DATABASE_URL");
  await s`create table if not exists anywhere_cheap (
    dest text not null, variant text not null, month text not null, stay text not null,
    price int, lb int, nodes text[], out_date text, ret_date text, connections int, travel_h int,
    verified boolean not null default false, source text not null default 'bound', access int, google int,
    deal boolean not null default false, norm int, trip jsonb, updated_at timestamptz not null default now(),
    primary key (dest, variant, month, stay))`;
  await s`create table if not exists anywhere_runs (id text primary key, started_at timestamptz not null default now(),
    finished_at timestamptz, phase text not null, cursor int not null default 0, stats jsonb)`;
  return s;
}

const hoursOf = (segs: KSeg[]) => (segs[segs.length - 1].arr - segs[0].dep) / 3600_000;

/** Round-trip bus from HOME to each departure airport (cheapest FlixBus ride on sample days, ×2). */
async function accessCosts(meter: Meter, log: (s: string) => void): Promise<Record<string, number>> {
  const out: Record<string, number> = { [HOME]: 0 };
  const days = [7, 21, 45].map((d) => addDays(isoDay(Date.now()), d));
  for (const c of new Set(GROUPS.flat())) {
    if (c === HOME) continue;
    let best = Infinity;
    for (const d of days) for (const r of (await flixRides(HOME, c, d, meter)) ?? []) best = Math.min(best, r.price);
    if (Number.isFinite(best)) out[c] = Math.round(best * 2);
  }
  log(`access from ${HOME}: ${JSON.stringify(out)}`);
  return out;
}

/** Phase 1: lower bounds per destination and month, both variants. */
async function bounds(log: (s: string) => void) {
  const s = await ensure();
  const months = nextMonths(6);
  let n = 0;
  for (const variant of ["on", "off"] as Variant[]) {
    const p = withDeparture({ origin: [HOME], departs: COUNTRY_AIRPORTS.PL, home: HOME, access: variant === "on", abroad: false, maxAccessH: 4 } as SearchParams);
    for (const m of months) {
      const g = await buildGraph([m], false, p.origin, p.ground);
      const out = dijkstra(g.graph, p.origin, false), back = dijkstra(g.graph, p.origin, true);
      const rows = AIRPORTS.filter((a) => a.cc !== "PL" && out.has(a.iata) && back.has(a.iata))
        .map((a) => ({ dest: a.iata, variant, month: m, stay: "any", lb: Math.round(out.get(a.iata)! + back.get(a.iata)!) }));
      for (let i = 0; i < rows.length; i += 200) {
        await s`insert into anywhere_cheap ${s(rows.slice(i, i + 200) as never, "dest", "variant", "month", "stay", "lb")}
          on conflict (dest, variant, month, stay) do update set lb = excluded.lb, updated_at = now()`;
      }
      n += rows.length;
    }
  }
  log(`bounds: ${n} rows`);
}

type Best = { price: number; it: KReturn; nights: number; from: string; to: string };

/** Phase 2: Kiwi return combinations for the destinations with the lowest bounds. */
async function kiwiPhase(limit: number, startAt: number, meter: Meter, access: Record<string, number>, interrupted: () => Promise<boolean>,
  log: (s: string) => void, progress: (i: number) => Promise<void>): Promise<boolean> {
  const s = await ensure();
  const today = isoDay(Date.now());
  const d0 = addDays(today, 1), mid = addDays(today, 91), end = addDays(today, 182);
  // far destinations deeper (~3/5 of the slots), the rest for Europe and the near abroad
  const lbs = await s`select dest, min(lb) lb from anywhere_cheap where variant = 'off' and stay = 'any' and lb is not null group by dest order by min(lb)`;
  const far = lbs.filter((r) => isFar(r.dest)).map((r) => r.dest as string);
  const near = lbs.filter((r) => !isFar(r.dest)).map((r) => r.dest as string);
  const list = [...far.slice(0, Math.round(limit * 0.6)), ...near.slice(0, Math.round(limit * 0.4))];
  log(`kiwi: ${list.length} destinations (${Math.min(far.length, Math.round(limit * 0.6))} far), from #${startAt}`);
  const norms = await radarNorms();
  for (let i = startAt; i < list.length; i++) {
    if (await interrupted()) { await progress(i); return false; }
    const dest = list[i];
    // per variant, month and stay bucket: the cheapest combination
    const best = new Map<string, Best>();
    for (const [o0, o1] of [[d0, mid], [addDays(mid, 1), end]] as [string, string][]) {
      for (const from of GROUPS) {
        const its = await kiwiReturn(from, [dest], o0, o1, addDays(o0, 5), addDays(o1, 21), meter);
        for (const it of its ?? []) {
          if (!it.out.length || !it.ret.length || !it.out.every((x) => AP[x.from] && AP[x.to])) continue;
          const nights = Math.round((Date.parse(it.ret[0].depLocal.slice(0, 10)) - Date.parse(it.out[it.out.length - 1].arrLocal.slice(0, 10))) / 86400_000);
          const b = bucketOf(nights);
          if (!b) continue;
          const start = it.out[0].from, home = it.ret[it.ret.length - 1].to;
          const month = it.out[0].depLocal.slice(0, 7);
          for (const variant of ["on", "off"] as Variant[]) {
            let price = it.price;
            if (variant === "on") {
              const a = access[start], z = access[home];
              if (a === undefined || z === undefined) continue; // no bus from home: not reachable this way
              price += (a + z) / 2;
            }
            for (const key of [`${variant}|${month}|${b}`, `${variant}|${month}|any`]) {
              const cur = best.get(key);
              if (!cur || price < cur.price) best.set(key, { price: Math.round(price), it, nights, from: start, to: home });
            }
          }
        }
      }
    }
    const rows = [...best.entries()].map(([k, v]) => {
      const [variant, month, stay] = k.split("|");
      const norm = norms.get(dest) ?? null;
      return {
        dest, variant, month, stay, price: v.price, nodes: [v.it.out[0].from, ...v.it.out.map((x) => x.to), ...v.it.ret.map((x) => x.to)],
        out_date: v.it.out[0].depLocal.slice(0, 10), ret_date: v.it.ret[0].depLocal.slice(0, 10),
        connections: Math.max(v.it.out.length, v.it.ret.length) - 1, travel_h: Math.round(Math.max(hoursOf(v.it.out), hoursOf(v.it.ret))),
        verified: true, source: "kiwi", access: variant === "on" ? Math.round(((access[v.from] ?? 0) + (access[v.to] ?? 0)) / 2) : null,
        deal: norm !== null && v.price - (variant === "on" ? (access[v.from] ?? 0) : 0) <= norm * 0.8, norm,
        trip: kiwiTrip(dest, v, variant === "on" ? access : null),
      };
    });
    if (rows.length) {
      // a better composed trip from phase 3 stays: only replace a row when this one is cheaper or the row is older than 2 days
      await s`insert into anywhere_cheap ${s(rows as never)}
        on conflict (dest, variant, month, stay) do update set price = excluded.price, nodes = excluded.nodes, out_date = excluded.out_date,
          ret_date = excluded.ret_date, connections = excluded.connections, travel_h = excluded.travel_h, verified = true,
          source = excluded.source, access = excluded.access, deal = excluded.deal, norm = excluded.norm, trip = excluded.trip, updated_at = now()
        where anywhere_cheap.price is null or excluded.price <= anywhere_cheap.price or anywhere_cheap.updated_at < now() - interval '2 days'`;
    }
    if (i % 10 === 9) { log(`kiwi: ${i + 1}/${list.length} (${JSON.stringify(meter.snapshot().bySource)})`); await progress(i + 1); }
  }
  return true;
}

/** A Trip the globe journey can play, from a Kiwi return combination (+ the bus, as a note). */
function kiwiTrip(dest: string, v: Best, access: Record<string, number> | null): Trip {
  const leg = (x: KSeg, i: number, dir: "out" | "ret") => ({
    from: x.from, to: x.to, dep: x.dep, arr: x.arr, depLocal: x.depLocal, arrLocal: x.arrLocal,
    price: dir === "out" && i === 0 ? v.it.price : 0, carrier: x.carrier, flightNo: x.flightNo, source: "kiwi" as const, link: v.it.link, dir,
  });
  const legs = [...v.it.out.map((x, i) => leg(x, i, "out")), ...v.it.ret.map((x, i) => leg(x, i, "ret"))];
  const flags = ["kombinacja Kiwi"];
  if (access && (v.from !== HOME || v.to !== HOME)) flags.push(`dojazd z Poznania ~${Math.round(((access[v.from] ?? 0) + (access[v.to] ?? 0)) / 2)} zł (szac.)`);
  return {
    id: `ac-${dest}-${v.it.out[0].depLocal.slice(0, 10)}`, price: v.price, lb: v.price, legs, nodes: [legs[0].from, ...legs.map((l) => l.to)], flags,
    origin: "kiwi", estimated: false, travelH: Math.round(Math.max(hoursOf(v.it.out), hoursOf(v.it.ret))),
    outDate: v.it.out[0].depLocal.slice(0, 10), retDate: v.it.ret[0].depLocal.slice(0, 10), stayDays: v.nights,
  };
}

/** Radar norm (typical price) per destination, from Polish airports: the deal threshold. */
async function radarNorms(): Promise<Map<string, number>> {
  const s = await ensure();
  const rows = await s`select dest, min(norm) norm from radar_deals where origin in ${s(COUNTRY_AIRPORTS.PL)} and norm is not null group by dest`.catch(() => []);
  // a radar norm is one-way: twice that for a round trip
  return new Map(rows.map((r) => [r.dest as string, Number(r.norm) * 2]));
}

/** Phase 3: the full engine on the best month for the cheapest far destinations (both variants share the run). */
async function composePhase(limit: number, startAt: number, stepSeconds: number, interrupted: () => Promise<boolean>,
  log: (s: string) => void, progress: (i: number) => Promise<void>): Promise<boolean> {
  const s = await ensure();
  const cand = await s`select dest, month, price, lb from (
      select dest, month, coalesce(price, lb) v, price, lb, row_number() over (partition by dest order by coalesce(price, lb)) rn
      from anywhere_cheap where variant = 'on' and stay = 'any' and coalesce(price, lb) is not null) x
    where rn = 1 order by v`;
  const far = cand.filter((r) => isFar(r.dest)).slice(0, limit);
  log(`compose: ${far.length} far destinations, from #${startAt}`);
  for (let i = startAt; i < far.length; i++) {
    if (await interrupted()) { await progress(i); return false; }
    const { dest, month } = far[i];
    const { params } = parseForm({ from: "Polska", to: dest, type: "rt", dateMode: "month", dateFrom: `${month}-01`, dateTo: monthEnd(month),
      stayMin: 5, stayMax: 21, home: "Poznań", access: true, abroad: false, maxAccessH: 4, depth: "fast" });
    if (!params) continue;
    const t0 = Date.now();
    const r = await runSearch(params, () => {}, undefined, { deadline: t0 + stepSeconds * 1000, hardStop: t0 + (stepSeconds + 60) * 1000, final: false })
      .catch((e) => { log(`compose ${dest}: ${(e as Error).message}`); return null; });
    const t = r?.trips[0];
    if (!r || !t) continue;
    const google = r.baseline ? Math.round(r.baseline.price + (r.baseline.access ?? 0)) : null;
    const norm = (await radarNorms()).get(dest) ?? null;
    const outLegs = t.legs.filter((l) => l.dir === "out" && l.source !== "flixbus" && l.source !== "local").length;
    const retLegs = t.legs.filter((l) => l.dir === "ret" && l.source !== "flixbus" && l.source !== "local").length;
    const stay = t.stayDays !== null ? bucketOf(t.stayDays) : null;
    const row = {
      dest, variant: "on", month: t.outDate.slice(0, 7), price: t.price, nodes: t.nodes, out_date: t.outDate, ret_date: t.retDate,
      connections: Math.max(outLegs, retLegs) - 1, travel_h: Math.round(t.travelH), verified: !t.estimated, source: t.google ? "google" : "azymut",
      access: null, google, deal: norm !== null && t.price <= norm * 0.8, norm, trip: t,
    };
    for (const st of ["any", ...(stay ? [stay] : [])]) {
      await s`insert into anywhere_cheap ${s({ ...row, stay: st } as never)}
        on conflict (dest, variant, month, stay) do update set price = excluded.price, nodes = excluded.nodes, out_date = excluded.out_date,
          ret_date = excluded.ret_date, connections = excluded.connections, travel_h = excluded.travel_h, verified = excluded.verified,
          source = excluded.source, google = excluded.google, deal = excluded.deal, norm = excluded.norm, trip = excluded.trip, updated_at = now()
        where anywhere_cheap.price is null or excluded.price < anywhere_cheap.price or anywhere_cheap.updated_at < now() - interval '2 days'`;
      // the Google price is useful even when the composed trip did not win
      if (google) await s`update anywhere_cheap set google = ${google} where dest = ${dest} and variant = 'on' and month = ${row.month} and stay = ${st}`;
    }
    log(`compose ${i + 1}/${far.length} ${dest} ${month}: ${t.price} zł (${t.nodes.join("-")}) google ${google ?? "-"} ${Math.round((Date.now() - t0) / 1000)} s`);
    await progress(i + 1);
  }
  return true;
}

export type RunOpts = { kiwiLimit?: number; composeLimit?: number; composeSeconds?: number; force?: boolean };

/** One full (or resumed) run. Returns false when it yielded to a user search; the next call resumes. */
export async function runAnywhereCheap(interrupted: () => Promise<boolean>, log: (s: string) => void = console.log, o: RunOpts = {}): Promise<boolean> {
  const s = await ensure();
  const [last] = await s`select * from anywhere_runs order by started_at desc limit 1`;
  type RunRow = { id: string; phase: string; cursor: number };
  let run = (last && !last.finished_at ? last : null) as RunRow | null;
  if (!run) {
    const id = `run-${Date.now()}`;
    run = (await s`insert into anywhere_runs (id, phase) values (${id}, 'bounds') returning *`)[0] as RunRow;
  }
  const cur = run;
  const t0 = Date.now();
  const meter = new Meter(0, 100000);
  meter.limits = { google: 2500, kiwi: 3000, flixbus: 400, ryanair: 1500, wizz: 1500 };
  const setPhase = async (phase: string, cursor = 0) => { await s`update anywhere_runs set phase = ${phase}, cursor = ${cursor} where id = ${cur.id}`; cur.phase = phase; cur.cursor = cursor; };
  const progress = (i: number) => s`update anywhere_runs set cursor = ${i}, stats = ${s.json(meter.snapshot() as never)} where id = ${cur.id}`.then(() => {});
  log(`${run.id} phase ${run.phase} #${run.cursor}`);
  if (run.phase === "bounds") { await bounds(log); await setPhase("kiwi"); }
  if (run.phase === "kiwi") {
    const access = await accessCosts(meter, log);
    if (!(await kiwiPhase(o.kiwiLimit ?? Number(process.env.ANYWHERE_KIWI_LIMIT ?? 200), run.cursor, meter, access, interrupted, log, progress))) return false;
    await setPhase("compose");
  }
  if (run.phase === "compose") {
    if (!(await composePhase(o.composeLimit ?? Number(process.env.ANYWHERE_COMPOSE_LIMIT ?? 30), run.cursor, o.composeSeconds ?? 120, interrupted, log, progress))) return false;
  }
  await s`update anywhere_runs set finished_at = now(), phase = 'done', stats = ${s.json({ ...meter.snapshot(), ms: Date.now() - t0 } as never)} where id = ${run.id}`;
  // rows from destinations or months that dropped out of the window
  await s`delete from anywhere_cheap where month < ${isoDay(Date.now()).slice(0, 7)}`;
  log(`done in ${Math.round((Date.now() - t0) / 60000)} min ${JSON.stringify(meter.snapshot().bySource)}`);
  return true;
}

/** Due: a run is unfinished, or after 01:00 local time when the last finished more than 20 h ago. */
export async function anywhereCheapDue(): Promise<boolean> {
  const s = await ensure();
  const [last] = await s`select started_at, finished_at from anywhere_runs order by started_at desc limit 1`;
  if (last && !last.finished_at) return true;
  const hour = new Date().getHours();
  const age = last ? Date.now() - new Date(last.finished_at).getTime() : Infinity;
  return hour >= 1 && hour < 7 && age > 20 * 3600_000;
}

export type Filters = { month?: string; stay?: StayBucket; region?: string; maxPrice?: number; maxConn?: number; far?: boolean; access?: boolean; perCountry?: number;
  /** each zone's own price limit (ZONES); an explicit maxPrice replaces it */
  zones?: boolean };

/** The page's list: one row per destination (its cheapest month/stay matching the filters). */
export async function listAnywhereCheap(f: Filters) {
  const s = await ensure();
  const variant = f.access === false ? "off" : "on";
  const rows = await s`select * from anywhere_cheap where variant = ${variant} and stay = ${f.stay ?? "any"}
    ${f.month ? s`and month = ${f.month}` : s``} and month >= ${isoDay(Date.now()).slice(0, 7)}`;
  const best = new Map<string, Row>();
  for (const r of rows) {
    const a = AP[r.dest];
    if (!a) continue;
    if (f.far && !isFar(r.dest)) continue;
    if (f.region && a.region !== f.region) continue;
    const price = r.price ?? null;
    const v = price ?? r.lb;
    if (v === null) continue;
    if (f.maxPrice && v > f.maxPrice) continue;
    if (f.zones && !f.maxPrice && v > ZONES.find((z) => z.zone === zoneOf(r.dest))!.cap) continue;
    if (f.maxConn !== undefined && r.connections !== null && r.connections > f.maxConn) continue;
    if (f.maxConn !== undefined && r.connections === null) continue;
    const row: Row = {
      dest: r.dest, variant, month: r.month, stay: r.stay, price, lb: r.lb, nodes: r.nodes, outDate: r.out_date, retDate: r.ret_date,
      connections: r.connections, travelH: r.travel_h, verified: r.verified, source: r.source, access: r.access, google: r.google,
      deal: r.deal, norm: r.norm, trip: null, zone: zoneOf(r.dest), updatedAt: new Date(r.updated_at).getTime(),
    };
    const cur = best.get(r.dest);
    const key = (x: Row) => (x.verified ? 0 : 1e6) + (x.price ?? x.lb ?? Infinity); // verified prices first, bounds after
    if (!cur || key(row) < key(cur)) best.set(r.dest, row);
  }
  const [run] = await s`select started_at, finished_at, phase from anywhere_runs order by started_at desc limit 1`;
  const sorted = [...best.values()].sort((a, b) => (a.verified === b.verified ? 0 : a.verified ? -1 : 1) || (a.price ?? a.lb ?? 0) - (b.price ?? b.lb ?? 0));
  // at most perCountry destinations per country (default 2): the list is not just the Emirates
  const cap = f.perCountry ?? 2;
  const perCc = new Map<string, number>();
  let hidden = 0;
  const rowsOut = cap > 0 ? sorted.filter((r) => {
    const cc = AP[r.dest].cc, n = perCc.get(cc) ?? 0;
    perCc.set(cc, n + 1);
    if (n < cap) return true;
    hidden++;
    return false;
  }) : sorted;
  return {
    rows: rowsOut, hidden, perCountry: cap,
    run: run ? { startedAt: new Date(run.started_at).getTime(), finishedAt: run.finished_at ? new Date(run.finished_at).getTime() : null, phase: run.phase } : null,
  };
}

/** The stored trip (for the journey animation) of one destination row. */
export async function anywhereTrip(dest: string, variant: Variant, month: string, stay: string): Promise<Trip | null> {
  const s = await ensure();
  const [r] = await s`select trip from anywhere_cheap where dest = ${dest} and variant = ${variant} and month = ${month} and stay = ${stay}`;
  return (r?.trip as Trip) ?? null;
}
