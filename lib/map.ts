// The "world map": cached lower-bound edges between ~300 airports, refreshed daily.
import { AIRPORTS, AP, EXTRA_AIRPORTS, groundTransfers, km } from "./airports";
import { flixCity } from "./sources/flixbus";
import { config } from "./config";
import knownRoutes from "./data/known-routes.json";
import { db, type Edge } from "./db";
import { explore, hasSerp } from "./sources/paid";
import { Meter, cachedJson, fetchJson, pace, randomUA } from "./sources/http";
import { kiwiAnywhere, kiwiOneWay } from "./sources/kiwi";
import { ryanairMap, wizzMap, wizzRoutes } from "./sources/lowcost";
import { addDays, isoDay, monthEnd, monthsBetween } from "./time";

const CODES = new Set(AIRPORTS.map((a) => a.iata));

export function nextMonths(n = config.mapMonths): string[] {
  const today = isoDay(Date.now());
  return monthsBetween(today, addDays(today, 31 * (n - 1))).slice(0, n);
}

async function ryanairAirports(meter: Meter): Promise<Set<string>> {
  const { value } = await cachedJson<string[]>("fr:airports", 24 * 3600, async () => {
    if (!meter.canFree()) return null;
    await pace("ryanair");
    meter.add("ryanair", false);
    const d = (await fetchJson("https://www.ryanair.com/api/views/locate/5/airports/en/active", {
      headers: { "user-agent": randomUA() },
    })) as { code: string }[];
    return d.map((a) => a.code);
  });
  return new Set((value ?? []).filter((c) => CODES.has(c)));
}

function toEdges(origin: string, fares: { to: string; price: number; date: string | null }[], months: string[], source: Edge["source"]): Edge[] {
  const now = Date.now();
  const out: Edge[] = [];
  for (const f of fares) {
    if (!CODES.has(f.to) || !Number.isFinite(f.price)) continue;
    // A multi-month minimum is a valid lower bound for every month in that range.
    for (const month of months) out.push({ from: origin, to: f.to, month, price: Math.round(f.price), source, date: f.date, updatedAt: now });
  }
  return out;
}

/** All map jobs (one per airport/source/window), the same list the worker and the coverage use. */
export function buildJobs(meter: Meter, nets: { fr: Set<string>; w6: Set<string> }, months: string[], span: [string, string]): Job[] {
  const monthSpan = (m: string): [string, string] => [m + "-01" < span[0] ? span[0] : m + "-01", monthEnd(m)];
  const jobs: Job[] = [];
  const windows = [months.slice(0, 2), months.slice(2, 4), months.slice(4, 6)].filter((w) => w.length);
  const winSpan = (w: string[]): [string, string] => [monthSpan(w[0])[0], monthEnd(w[w.length - 1])];
  for (const a of AIRPORTS) {
    const o = a.iata;
    if (nets.fr.has(o)) jobs.push({ key: `fr:${o}`, run: async () => toEdges(o, await ryanairMap(o, span[0], span[1], meter), months, "ryanair") });
    if (nets.w6.has(o)) jobs.push({ key: `w6:${o}`, run: async () => toEdges(o, await wizzMap(o, meter), months, "wizz") });
    // "anywhere" from European airports and from the far gateways (regional low-cost hops);
    // small far-away airports are covered as destinations of those queries
    if (a.region === "EUR" || FAR_GATEWAYS.includes(o)) windows.forEach((w) => jobs.push({ key: `kw:${o}:${w[0]}`, run: async () => {
      const [d0, d1] = winSpan(w);
      return toEdges(o, (await kiwiAnywhere(o, d0, d1, meter)) ?? [], w, "kiwi");
    } }));
  }
  for (const o of [...GATEWAYS, ...FAR_GATEWAYS]) {
    const home = Object.entries(CONTINENTS).find(([, regs]) => regs.includes(AP[o].region))?.[0];
    for (const cont of Object.keys(CONTINENTS)) {
      if (cont === home || (FAR_GATEWAYS.includes(o) && cont !== "europe")) continue;
      for (const w of windows) jobs.push({ key: `kc:${o}:${cont}:${w[0]}`, run: async () => {
        const its = await kiwiOneWay([o], [], winSpan(w)[0], winSpan(w)[1], 300, meter, false, [`Continent:${cont}`]);
        const best = new Map<string, { to: string; price: number; date: string }>();
        for (const it of its ?? []) {
          const to = it.segs[it.segs.length - 1].to;
          if (AP[to] && (!best.has(to) || it.price < best.get(to)!.price)) best.set(to, { to, price: it.price, date: it.segs[0].depLocal.slice(0, 10) });
        }
        return toEdges(o, [...best.values()], w, "kiwi");
      } });
    }
  }
  const kxRun = (froms: string[], cc: string, w: string[]) => async () => {
    const its = await kiwiOneWay(froms, [], winSpan(w)[0], winSpan(w)[1], 300, meter, false, [`Country:${cc}`]);
    const best = new Map<string, { from: string; to: string; price: number; date: string }>();
    for (const it of its ?? []) {
      const from = it.segs[0].from, to = it.segs[it.segs.length - 1].to;
      if (AP[from] && AP[to] && (!best.has(from + to) || it.price < best.get(from + to)!.price)) best.set(from + to, { from, to, price: it.price, date: it.segs[0].depLocal.slice(0, 10) });
    }
    const byFrom = new Map<string, { to: string; price: number; date: string }[]>();
    for (const b of best.values()) { if (!byFrom.has(b.from)) byFrom.set(b.from, []); byFrom.get(b.from)!.push(b); }
    return [...byFrom].flatMap(([from, fares]) => toEdges(from, fares, w, "kiwi"));
  };
  for (const cc of ASIA_COUNTRIES) for (const w of windows) {
    jobs.push({ key: `kx:EU:${cc}:${w[0]}`, run: kxRun(KX_EU, cc, w) });
    jobs.push({ key: `kx:AS:${cc}:${w[0]}`, run: kxRun(ASIA_FEEDERS.filter((c) => AP[c]?.cc !== cc), cc, w) });
  }
  if (hasSerp()) for (const o of GATEWAYS) for (const m of months) {
    jobs.push({ key: `sx:${o}:${m}`, run: async () => toEdges(o, (await explore(o, m, meter)) ?? [], [m], "explore") });
  }

  return jobs;
}

/** Coverage of the map right now (no external calls: networks come from the response cache). */
export async function currentCoverage(): Promise<MapSummary> {
  const meter = new Meter(0, 100_000);
  meter.limits = {};
  const nets = await lowcostNetworks(meter);
  const today = isoDay(Date.now());
  const months = nextMonths();
  const keys = buildJobs(meter, nets, months, [addDays(today, 1), monthEnd(months[months.length - 1])]).map((j) => j.key);
  const last = await db.jobTimes();
  const hot = await db.hotAirports();
  return mapSummary(keys, last, (k) => (hot[k.split(":")[1]] ? HOT_MS : COLD_MS));
}

/** Refresh low-cost edges for one origin over a date span (used by cron and on demand by searches). */
export async function refreshLowcostOrigin(
  origin: string, from: string, to: string, meter: Meter, nets: { fr: Set<string>; w6: Set<string> },
): Promise<number> {
  const months = monthsBetween(from, to);
  let edges: Edge[] = [];
  if (nets.fr.has(origin)) edges = edges.concat(toEdges(origin, await ryanairMap(origin, from, to, meter).catch(() => []), months, "ryanair"));
  if (nets.w6.has(origin)) edges = edges.concat(toEdges(origin, await wizzMap(origin, meter).catch(() => []), months, "wizz"));
  await db.upsertEdges(edges);
  return edges.length;
}

export async function lowcostNetworks(meter: Meter) {
  const fr = await ryanairAirports(meter).catch(() => new Set<string>());
  const routes = await wizzRoutes(meter).catch(() => new Set<string>());
  const w6 = new Set<string>();
  for (const r of routes) if (CODES.has(r.slice(0, 3))) w6.add(r.slice(0, 3));
  return { fr, w6, wizzRoutes: routes };
}

// Long-haul gateways: their intercontinental fares are fetched per continent (Kiwi), because an
// "anywhere" search ranked by price is dominated by short hops.
const GATEWAYS = "WAW BER FRA MUC AMS CDG ORY LHR LGW MAD BCN LIS OPO FCO MXP IST SAW ZRH VIE CPH HEL BRU CRL OSL ARN ATH BUD PRG KRK KEF TFS".split(" ");
const FAR_GATEWAYS = [...new Set([..."JFK EWR MIA FLL MCO MEX CUN BOG MDE LIM GRU EZE SCL PTY SDQ PUJ SJO UIO DXB AUH SHJ DOH MCT BKK DMK SIN KUL HKG DEL BOM CMB CAI RAK CMN ADD NBO JNB TAS ALA KUT EVN GYD MNL SGN".split(" "),
  ...config.lowcostHubs.filter((h) => !GATEWAYS.includes(h))])];
// Kiwi caps an answer at 50 itineraries, so "Continent:asia" returns only cheap Middle East fares.
// South, South-East and East Asia get per-country jobs from all gateways at once instead.
const ASIA_COUNTRIES = "TH VN MY SG ID PH KH LK IN MV NP JP KR CN TW HK UZ KZ".split(" ");
const ASIA_FEEDERS = "IST SAW DXB AUH SHJ DOH MCT TAS ALA DEL BOM CMB KUL BKK SIN".split(" ");
const KX_EU = "WAW BER FRA MUC AMS CDG LHR MAD MXP FCO VIE BUD".split(" ");
const CONTINENTS: Record<string, string[]> = {
  europe: ["EUR", "CAU"], "south-america": ["SAM"], "north-america": ["NAM", "CAR"], asia: ["SAS", "SEA", "EAS", "CAS", "MEA"],
  africa: ["AFR", "NAF"], oceania: ["OCE"],
};

type Job = { key: string; run: () => Promise<Edge[]> };

const HOT_MS = 24 * 3600_000, COLD_MS = 7 * 86400_000;

export type MapSummary = { coverage: number; medianAgeH: number | null; jobs: number; fresh: number; at: number };

/** Share of map jobs refreshed within their target age, and how old the data typically is. */
export function mapSummary(keys: string[], last: Record<string, number>, target: (k: string) => number): MapSummary {
  const now = Date.now();
  const ages = keys.map((k) => (last[k] ? now - last[k] : Infinity));
  const fresh = keys.filter((k, i) => ages[i] <= target(k)).length;
  const known = ages.filter(Number.isFinite).sort((a, b) => a - b);
  return {
    coverage: keys.length ? Math.round((100 * fresh) / keys.length) : 0,
    medianAgeH: known.length ? Math.round(known[Math.floor(known.length / 2)] / 3600_000) : null,
    jobs: keys.length, fresh, at: now,
  };
}

/**
 * One batch of map refresh work, oldest jobs first, within a time budget. Used by the GitHub
 * Actions worker (all day, in small batches). Sources that block are backed off, never fatal.
 */
export async function refreshMap(deadline: number, log: (s: string) => void = () => {}) {
  const meter = new Meter(config.serpExploreDailyBudget, 100_000);
  meter.limits = {}; // the worker is bounded by time, not by per-source budgets
  const nets = await lowcostNetworks(meter);
  const today = isoDay(Date.now());
  const months = nextMonths();
  const span: [string, string] = [addDays(today, 1), monthEnd(months[months.length - 1])];
  const monthSpan = (m: string): [string, string] => [m + "-01" < span[0] ? span[0] : m + "-01", monthEnd(m)];

  const jobs = buildJobs(meter, nets, months, span);

  // Priority: airports that searches actually use are kept fresh daily, the rest weekly.
  const last = await db.jobTimes();
  const hot = await db.hotAirports();
  const airportOf = (key: string) => key.split(":")[1];
  const target = (key: string) => (hot[airportOf(key)] ? HOT_MS : COLD_MS);
  const ratio = (key: string) => (Date.now() - (last[key] ?? 0)) / target(key);
  const todo = jobs.filter((j) => ratio(j.key) >= 1).sort((a, b) => ratio(b.key) - ratio(a.key));
  log(`jobs: ${jobs.length}, due: ${todo.length}, hot airports: ${Object.keys(hot).length}`);
  let done = 0, edges = 0, failed = 0;
  const lane = (prefixes: string[]) => async () => {
    for (const j of todo.filter((x) => prefixes.includes(x.key.split(":")[0]))) {
      if (Date.now() > deadline - 15000) break;
      try {
        const e = await j.run();
        if (e.length) { await db.upsertEdges(e); edges += e.length; }
        await db.markJob(j.key);
        done++;
      } catch (err) {
        failed++;
        log(`job ${j.key} failed: ${(err as Error).message}`);
      }
      await new Promise((r) => setTimeout(r, 150 + Math.random() * 450));
    }
  };
  // Ryanair, Wizz and Kiwi are different hosts with their own pacing: run them side by side
  await Promise.all([lane(["fr"])(), lane(["w6"])(), lane(["kw", "kc", "kx"])(), lane(["sx"])()]);
  log(`done ${done} jobs, ${failed} failed, ${edges} edges`);
  const after = await db.jobTimes();
  const summary = mapSummary(jobs.map((j) => j.key), after, (k) => target(k));
  await db.cacheSet("map:summary", summary, 30 * 86400).catch(() => {});
  log(`coverage ${summary.coverage}%, median age ${summary.medianAgeH} h`);
  return { ...meter.snapshot(), stale: todo.length, done, failed, edges, ...summary };
}

// ---------------- Graph ----------------

export type Arc = { to: string; lb: number; kind: "flight" | "ground"; mode?: "metro" | "flix"; sources: Edge["source"][]; hours?: number };
export type Graph = Map<string, Arc[]>;

/**
 * Typical cheapest one-way fare by distance, for routes no live source covers. Used only when
 * no API key can price the route; legs priced this way are marked as estimates in results.
 */
export function estimatePrice(distKm: number): number {
  return Math.round(120 + distKm * 0.11);
}
/** Conservative lower bound for routes that a paid source can verify later. */
function estimateLowerBound(distKm: number): number {
  return Math.round(60 + distKm * 0.05);
}

const KNOWN = knownRoutes as string[];

/** origins: where trips start; ground: airports a bus from an origin may reach (wider departure choice). */
/**
 * Airports the price map does not cover (small and regional ones, e.g. KKN, LYR) become normal
 * targets: each is joined to the graph through its nearest hubs with optimistic arcs both ways,
 * which the verifier then prices live (Google, Kiwi) like any other leg. Hubs: the nearest core
 * airports and the nearest large airports of the same country (Tromsø for Kirkenes), the latter
 * joined to the core hubs too, so a path like OSL -> TOS -> KKN exists.
 */
export function connectSmall(graph: Graph, targets: string[]) {
  const arcsTo = (code: string) => { let n = 0; for (const arcs of graph.values()) for (const a of arcs) if (a.to === code && a.kind === "flight") n++; return n; };
  const has = (from: string, to: string) => (graph.get(from) ?? []).some((a) => a.to === to && a.kind === "flight");
  const link = (a: string, b: string) => {
    const d = km(AP[a], AP[b]);
    for (const [x, y] of [[a, b], [b, a]]) {
      if (has(x, y)) continue;
      if (!graph.has(x)) graph.set(x, []);
      graph.get(x)!.push({ to: y, lb: estimateLowerBound(d), kind: "flight", sources: ["estimate"] });
    }
  };
  const core = AIRPORTS.filter((a) => (graph.get(a.iata)?.length ?? 0) > 0);
  for (const t of new Set(targets)) {
    const ap = AP[t];
    if (!ap || CODES.has(t) || arcsTo(t) >= 3) continue;
    const near = (list: typeof AIRPORTS, n: number, max: number) => list.map((a) => ({ a, d: km(ap, a) })).filter((x) => x.a.iata !== t && x.d <= max).sort((x, y) => x.d - y.d).slice(0, n).map((x) => x.a);
    const hubs = near(core, 3, 3000);
    const local = near(EXTRA_AIRPORTS.filter((a) => a.cc === ap.cc && a.size === "L"), 2, 1500);
    for (const h of [...hubs, ...local]) link(h.iata, t);
    for (const l of local) for (const h of hubs) link(h.iata, l.iata);
  }
}

export async function buildGraph(months: string[], checked: boolean, origins: string[] = [], ground: string[] = config.originAirports): Promise<{ graph: Graph; edges: number; stale: boolean }> {
  const edges = await db.edges(months);
  const best = new Map<string, Arc>();
  const add = (from: string, a: Arc) => {
    const k = from + a.to + a.kind;
    const cur = best.get(k);
    if (!cur) best.set(k, { ...a, sources: [...a.sources] });
    else {
      if (a.lb < cur.lb) cur.lb = a.lb;
      for (const s of a.sources) if (!cur.sources.includes(s)) cur.sources.push(s);
    }
  };
  let newest = 0;
  for (const e of edges) {
    if (!AP[e.from] || !AP[e.to]) continue;
    newest = Math.max(newest, e.updatedAt);
    const fee = checked ? config.bagFee[e.source] ?? 0 : 0;
    add(e.from, { to: e.to, lb: e.price + fee, kind: "flight", sources: [e.source] });
  }
  const priced = new Set(best.keys());
  for (const r of KNOWN) {
    const from = r.slice(0, 3), to = r.slice(3);
    if (priced.has(r + "flight") || priced.has(to + from + "flight")) continue;
    const d = km(AP[from], AP[to]);
    add(from, { to, lb: estimateLowerBound(d), kind: "flight", sources: ["estimate"] });
  }
  for (const g of groundTransfers()) add(g.from, { to: g.to, lb: g.price, kind: "ground", mode: "metro", sources: [], hours: g.hours });
  // FlixBus legs: from/to the trip's origin up to ORIGIN_RADIUS_KM (wider choice of departure
  // airports), elsewhere up to 350 km. Bounds are optimistic; real rides are checked live.
  const withFlix = AIRPORTS.filter((a) => flixCity(a.iata));
  for (const a of withFlix) for (const b of withFlix) {
    if (a === b || flixCity(a.iata)!.id === flixCity(b.iata)!.id || a.land !== b.land || a.land === "ISLAND") continue;
    const d = km(a, b);
    // from/to the trip's origin: only towards the listed departure airports (wider choice of
    // flights); elsewhere only short hops between neighbouring airports
    const toOrigin = origins.includes(a.iata) ? b.iata : origins.includes(b.iata) ? a.iata : null;
    if (toOrigin ? !ground.includes(toOrigin) || d > config.originRadiusKm : d > 300) continue;
    add(a.iata, { to: b.iata, lb: Math.round(15 + d * 0.05), kind: "ground", mode: "flix", sources: [], hours: d / 85 });
  }

  const graph: Graph = new Map();
  for (const [k, a] of best) {
    const from = k.slice(0, 3);
    if (!graph.has(from)) graph.set(from, []);
    graph.get(from)!.push(a);
  }
  return { graph, edges: edges.length, stale: Date.now() - newest > 3 * 86400_000 };
}
