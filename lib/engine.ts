// Search orchestration.
//  1. Kiwi's own combinations give real, bookable trips up front: the first incumbent.
//  2. Coarse phase: paths on the lower-bound map in increasing bound order (A*).
//  3. Exact phase: branch and bound with live verification; anything whose bound reaches the
//     incumbent is cut without queries. Stops when no candidate below the incumbent is left.
//  4. Round-trip tickets at the long-haul hub are tried on the best trips (often cheaper than
//     two one-ways), then the Google Flights baseline for the same dates.
import { AP, isCore, km } from "./airports";
import { getHeapStatistics } from "node:v8";
import { config } from "./config";
import { db } from "./db";
import { accessLimitH, withDeparture } from "./departure";
import { googleTrip, improvable, improveTrip, radarSavings, recallTrips, rememberTrips, withSeparateSaving } from "./techniques";
import { summarize } from "./llm";
import { googleBaseline, type BaselineOffer, type BaselineSource, type BaselineStatus } from "./baseline";
import { buildGraph, connectSmall, lowcostNetworks, refreshLowcostOrigin } from "./map";
import { Heap, PathEnumerator, type Path } from "./paths";
import { googleOneWay, googleOneWayCheapest, googleOwGrid, googleRoundTrip, googleRtGrid, viaOf, type GridRow } from "./sources/google";
import { Meter } from "./sources/http";
import { aviasalesDirect } from "./sources/aviasales";
import { kayakExplore, type KayakHint } from "./sources/kayak";
import { KIWI_MAX, kiwiLegs, kiwiOneWay, kiwiReturn, type KItin, type KReturn, type KSeg } from "./sources/kiwi";
import { ryanairMap } from "./sources/lowcost";
import { hubsFor } from "./hubs";
import { pathThrough, propose, record as recordHypotheses, type HypoOutcome, type Hypothesis } from "./strategist";
import { flixRides } from "./sources/flixbus";
import { hasDuffel, hasSerp } from "./sources/paid";
import { recheckTrip } from "./recheck";
import { withBags } from "./bags";
import { addDays, DAY, HOUR, isoDay, localToUtc, monthEnd, monthsBetween, utcToLocal } from "./time";
import type { Saving, SearchParams } from "./types";
import { counted, hotelPrice, kiwiToOptions, legWindow, maxDirH, maxLayH, nightsAt, riskFlags, verifyPath, type Itinerary, type Leg, type VerifyResult } from "./verify";
import type { FlightOption } from "./types";
import type { Graph } from "./map";

/** ticket: legs with the same number are one booking (protected connections); a new number is a separate ticket */
export type TripLeg = Leg & { dir: "out" | "ret"; ticket?: number };
export type Trip = {
  id: string; price: number; lb: number; legs: TripLeg[]; nodes: string[]; flags: string[]; origin: "azymut" | "kiwi" | "hub-rt";
  /** number of separate bookings (see TripLeg.ticket) */
  tickets?: number;
  estimated: boolean; travelH: number; outDate: string; retDate: string | null; stayDays: number | null;
  savings?: Saving[];        // per-technique breakdown vs the plain offer
  google?: boolean;          // the Google baseline itself won ("najtaniej wychodzi zwykła oferta")
  /** every direction's flights are one booking (protected connections) */
  oneTicket?: boolean;
  /** total with one checked bag (20–23 kg) per person on every ticket; bagEstimated: a fee is an estimate */
  bagPrice?: number; bagEstimated?: boolean;
  /** links to book it (added when the status is read, see lib/booking.ts) */
  booking?: import("./booking").Booking;
};
/**
 * The Google baseline: the cheapest ordinary offer for the same search. `price` is what it costs door
 * to door like an Azymut trip (the offer plus the bus from home to its airport and back when access is
 * counted); `flight` is Google's own price, `access` the difference.
 */
export type Baseline = {
  price: number; url: string; summary: string; origins: string[]; outDate: string; retDate: string | null; access?: number;
  flight?: number; source?: BaselineSource; from?: string; to?: string; bagPrice?: number;
} | null;
export type SearchResult = {
  trips: Trip[]; baseline: Baseline; savings: number | null; provenOptimal: boolean; gap: number | null;
  summary: string; stats: ReturnType<Meter["snapshot"]> & { checked: number; pruned: number; ms: number; destinations?: DestStat[];
    progress?: { pct: number; etaSec: number | null; combos: number }; baselineStatus?: BaselineStatus; ticketWins?: { combined: number; separate: number }; prelim?: { price: number; sec: number }; oneTicket?: Trip }; notes: string[];
  /** true when this step stopped on its time slice; a resumed step continues the same search */
  paused: boolean;
  /** lowest bound of anything not yet checked (best - lowerBound = gap to the optimum) */
  lowerBound: number | null;
  /** variants a source did not answer for, and whether the map search hit its memory cap */
  unverified: number;
  truncated: boolean;
  /** cheapest trip with at most 24 h and 3 connections per direction (null when none was found) */
  reasonable?: Trip | null;
  strategist?: { checked: number; hypotheses: HypoOutcome[] };
  baselineStatus?: BaselineStatus;
  stopped?: boolean;
};
export type RunOptions = {
  deadline?: number;          // end of this step
  hardStop?: number;          // absolute end of the grace phases after the deadline
  incumbents?: Trip[];        // best trips from earlier steps
  meterBase?: Record<string, number>; // calls already spent by earlier steps (budgets are per search)
  final?: boolean;            // write the summary text
  outWindow?: [string, string]; // deep mode: this round searches only these outbound days
  round?: number;             // deep mode: round number (more strategist hypotheses each round)
  /** laptop worker: no time limit, no connection-count limit, the larger (deep) budgets */
  unlimited?: boolean;
  /** multiplies the map search's memory cap (states per direction) */
  capScale?: number;
};

/** Outbound departure window of a search (flex days / whole month applied, never before tomorrow). */
export function outboundWindow(p: SearchParams): [string, string] {
  const tomorrow = isoDay(Date.now() + 86400_000);
  const flex = p.flexMode === "month" || p.flexMode === "exact" ? 0 : config.flexDays;
  const d0 = p.flexMode === "month" ? p.dateFrom.slice(0, 8) + "01" : p.dateFrom;
  const d1 = p.flexMode === "month" ? monthEnd(p.dateTo.slice(0, 7)) : p.dateTo;
  const a = addDays(d0, -flex);
  return [a > tomorrow ? a : tomorrow, addDays(d1, flex)];
}

/** "Rozsądna": at most 24 h door to door and at most 3 connections (4 flights) per direction. */
export function isReasonable(t: Trip): boolean {
  for (const dir of ["out", "ret"] as const) {
    const legs = t.legs.filter((l) => l.dir === dir);
    if (!legs.length) continue;
    if (legs[legs.length - 1].arr - legs[0].dep > 24 * HOUR) return false;
    if (legs.filter((l) => l.source !== "flixbus" && l.source !== "local" && l.source !== "ground").length > 4) return false;
  }
  return true;
}
/** City a destination airport belongs to (metro airports merged): the unit of a region's result list. */
export const cityKey = (code: string) => AP[code]?.metro ?? AP[code]?.city ?? code;
const isGroundLeg = (l: { source: string }) => l.source === "flixbus" || l.source === "local" || l.source === "ground";
/** Where a trip goes: the arrival of its last outbound flight (a bus at the far end does not count). */
export function tripDest(t: Trip): string {
  const out = t.legs.filter((l) => l.dir === "out" && !isGroundLeg(l));
  return out.length ? out[out.length - 1].to : t.nodes[t.nodes.length - 1];
}
/**
 * Booking numbers per leg: a priced leg starts a ticket; a leg at price 0 with the same booking link as
 * an earlier leg (the rest of a Kiwi booking, the return half of a round-trip ticket) belongs to it.
 * Bus and transfer legs are separate tickets.
 */
/** A Google leg with stops ("GDN → KKN, 1 przes.") as its flights through the transfer airports Google
 *  names (GDN → OSL → KKN): the map, the timeline and the flight animation then show where the change is.
 *  Google gives only the first departure, the last arrival and each layover's length, so the flight times
 *  in between are split by distance (marked as estimated); the price stays on the first flight, the rest
 *  ride on the same ticket. */
export function expandVias(t: Trip): Trip {
  if (!t.legs.some((l) => l.via?.length)) return t;
  const legs: TripLeg[] = t.legs.flatMap((l) => {
    const via = l.via;
    if (!via?.length || via.some((v) => !AP[v.iata]) || !AP[l.from] || !AP[l.to]) return [l];
    const pts = [l.from, ...via.map((v) => v.iata), l.to];
    const dist = pts.slice(1).map((c, i) => Math.max(1, km(AP[pts[i]], AP[c])));
    const air = l.arr - l.dep - via.reduce((s, v) => s + v.min * 60_000, 0);
    if (air <= 0) return [l];
    const total = dist.reduce((a, b) => a + b, 0);
    let at = l.dep;
    return dist.map((d, i) => {
      const dep = at, arr = i === dist.length - 1 ? l.arr : Math.round(dep + air * d / total);
      at = arr + (via[i]?.min ?? 0) * 60_000;
      const { via: _v, stops: _s, ...rest } = l;
      return {
        ...rest, from: pts[i], to: pts[i + 1], dep, arr,
        depLocal: i === 0 ? l.depLocal : utcToLocal(dep, AP[pts[i]].tz), arrLocal: i === dist.length - 1 ? l.arrLocal : utcToLocal(arr, AP[pts[i + 1]].tz),
        price: i === 0 ? l.price : 0, bag: i === 0 ? l.bag : undefined, flightNo: "",
        arrEstimated: i < dist.length - 1 ? true : l.arrEstimated,
        layoverH: i === 0 ? (l as Leg).layoverH : via[i - 1].min / 60,
        overnight: i === 0 ? (l as Leg).overnight : undefined, hotel: i === 0 ? (l as Leg).hotel : undefined,
        note: i === 0 ? l.note : `przesiadka w tej samej rezerwacji (godziny lotów między przesiadkami szacunkowe)`,
      } as TripLeg;
    });
  });
  return { ...t, legs, nodes: [...nodesOf(legs.filter((l) => l.dir === "out")), ...nodesOf(legs.filter((l) => l.dir === "ret"))] };
}

export function withTickets(t: Trip): Trip {
  let n = 0;
  const byLink = new Map<string, number>();
  const legs = t.legs.map((l) => {
    // (a checked-bag fee added onto a leg does not make it a ticket of its own)
    const same = !isGroundLeg(l) && l.price - (l.bag ?? 0) === 0 && !!l.link && byLink.has(l.link);
    const k = same ? byLink.get(l.link)! : ++n;
    if (!isGroundLeg(l) && l.link && !byLink.has(l.link)) byLink.set(l.link, k);
    return l.ticket === k ? l : { ...l, ticket: k };
  });
  // one booking per direction: all flights of each direction carry the same ticket number
  const oneTicket = (["out", "ret"] as const).every((d) => new Set(legs.filter((l) => l.dir === d && !isGroundLeg(l)).map((l) => l.ticket)).size <= 1);
  return { ...t, legs, tickets: n, oneTicket };
}

/** Destination cities of a search, each with its airports. */
export function destCities(dest: string[]): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const d of dest) { const k = cityKey(d); if (!m.has(k)) m.set(k, []); m.get(k)!.push(d); }
  return m;
}
export const REGION_MIN_CITIES = 3;
/** Cities a fast region search sweeps one by one (core and large airports first). */
const REGION_SWEEP = 14;
/** After a country pass: the cheapest cities a fast search takes deeper (separate tickets, bus from home). */
const REGION_DEEPEN = 60;
/** Stage 1 (the quick, preliminary answer) ends after this long at the latest; stage 2 goes on without a limit. */
const STAGE1_MS = 55_000;
/** Paths verified at the same time in the branch and bound (each mostly waits on the network). */
const VERIFY_PAR = Number(process.env.VERIFY_PAR ?? 4);
export const PER_CITY = 3; // the best trip per city plus two variants
/** The result list: for a region (3+ destination cities) the best trip of every city reached plus a
 *  couple of variants each, cheapest first; for one destination simply the k cheapest. */
export function pickTrips(trips: Trip[], dest: string[], k: number): Trip[] {
  // by price; at the same price one booking per direction first
  const sorted = [...trips].filter((t) => Number.isFinite(t.price)).sort((a, b) => a.price - b.price || Number(!!b.oneTicket) - Number(!!a.oneTicket));
  const cities = destCities(dest);
  if (cities.size < REGION_MIN_CITIES) return sorted.slice(0, k);
  const n = new Map<string, number>(), seen = new Set<string>();
  const out: Trip[] = [];
  for (const t of sorted) {
    const c = cityKey(tripDest(t));
    const sig = t.legs.map((l) => l.from + l.to + l.depLocal.slice(0, 10)).join("|");
    if ((n.get(c) ?? 0) >= PER_CITY || seen.has(sig)) continue;
    n.set(c, (n.get(c) ?? 0) + 1); seen.add(sig);
    out.push(t);
  }
  return out.slice(0, Math.max(k, cities.size * PER_CITY));
}
export type DestStat = { code: string; city: string; checked: boolean; best: number | null };

const DEEP_BUDGET = 8; // deep searches may use this many times the per-search source budgets
export type Emit = (event: string, data: unknown) => void;

/** Hubs whose own return fares to far places are often far cheaper than from Poland (hub split). */
/** Hubs for a separate ticket: near home (cheap long-haul fares out of Istanbul, Baku, Tashkent…) and near
 *  the far side (Singapore, Kuala Lumpur, Bali, Darwin for Timor; Bogotá, Panama, Miami for South America…). */
const MOSCOW = ["SVO", "VKO", "DME"];
/** Foreign hubs with direct flights into Russia (Turkish, Armenian, Azerbaijani and Gulf carriers). */
const RU_HUBS = ["IST", "SAW", "EVN", "GYD", "DXB"];
const SPLIT_HUBS = ("IST SAW TAS ALA GYD TBS DXB AUH SHJ DOH CAI TLV MXP FCO ATH LHR AMS BRU CDG MAD CPH HEL FRA VIE LIS OSL " +
  "SIN KUL BKK DMK DPS CGK HKG MNL TPE ICN NRT KIX DEL BOM CMB MLE DRW PER SYD MEL AKL " +
  "JFK EWR MIA FLL LAX MEX CUN BOG PTY SDQ GRU EZE LIM NBO ADD JNB CMN").split(" ");
const BIG_ORIGINS = "WAW BER PRG VIE BUD KRK KTW WRO GDN WMI LEJ HAM CPH".split(" ");

/** The airports a Google baseline searches from: the origin plus the biggest airports nearby. */
const baselineOrigins = (origin: string[]) => {
  const o = AP[origin[0]];
  const near = BIG_ORIGINS.filter((c) => !origin.includes(c) && km(o, AP[c]) <= 330);
  return [...origin, ...near].slice(0, 3);
};

function overnightAt(arr: number, dep: number, airport: string): boolean {
  if (dep - arr < 6 * HOUR) return false;
  for (let t = arr; t <= dep; t += HOUR) { const h = Number(utcToLocal(t, AP[airport].tz).slice(11, 13)); if (h >= 1 && h <= 4) return true; }
  return false;
}

/** Cheapest bound from the sources to every node (or to the sources, when reverse). */
export function dijkstra(g: Graph, sources: string[], reverse: boolean): Map<string, number> {
  const adj = new Map<string, { to: string; w: number }[]>();
  for (const [from, arcs] of g) for (const a of arcs) {
    const [x, y] = reverse ? [a.to, from] : [from, a.to];
    if (!adj.has(x)) adj.set(x, []);
    adj.get(x)!.push({ to: y, w: a.lb });
  }
  const dist = new Map<string, number>();
  const h = new Heap<[string, number]>((x) => x[1]);
  for (const s of sources) { dist.set(s, 0); h.push([s, 0]); }
  while (h.size) {
    const [n, d] = h.pop()!;
    if (d > (dist.get(n) ?? Infinity)) continue;
    for (const { to, w } of adj.get(n) ?? []) if (d + w < (dist.get(to) ?? Infinity)) { dist.set(to, d + w); h.push([to, d + w]); }
  }
  return dist;
}

const nodesOf = (legs: { from: string; to: string }[]) => (legs.length ? [legs[0].from, ...legs.map((l) => l.to)] : []);

/** Kiwi itineraries through airports outside our list are skipped (no coordinates, time zone, rules). */
const knownKiwi = (it: { segs: KSeg[] }) => it.segs.every((x) => AP[x.from] && AP[x.to]);

function itineraryFromKiwi(segs: KSeg[], price: number, link: string): Itinerary {
  const legs = kiwiLegs(segs, price, link).map((l, i, a) => ({
    ...l, note: a.length > 1 ? (i === 0 ? `cena za całą rezerwację Kiwi (${a.length} odc.)` : "w cenie rezerwacji Kiwi") : undefined,
    layoverH: i ? (l.dep - a[i - 1].arr) / HOUR : undefined,
  }));
  return { legs, price: Math.round(price), firstDep: legs[0].dep, lastArr: legs[legs.length - 1].arr, estimated: false, overnights: 0 };
}

/** A path stream that merges the map enumerator with ready-made (Kiwi) paths, in lower-bound order. */
class Stream {
  private buf: Path | null | undefined;
  constructor(private e: PathEnumerator | null, private extra: Path[]) { this.extra.sort((a, b) => a.lb - b.lb); }
  get outOfTime() { return this.e?.outOfTime ?? false; }
  async next(): Promise<Path | null> {
    if (this.buf === undefined) { this.buf = (await this.e?.next()) ?? null; if (this.outOfTime) { this.buf = undefined; return null; } }
    const x = this.extra[0];
    if (x && (!this.buf || x.lb <= this.buf.lb)) return this.extra.shift()!;
    const b = this.buf;
    this.buf = undefined;
    return b;
  }
  get truncated() { return this.e?.truncated ?? false; }
  /** Lowest bound of states the memory cap dropped (Infinity: none dropped). */
  get evictedLb() { return this.e?.evictedLb ?? Infinity; }
  /** Dropped states cannot beat `price` (in this direction's share of the trip). */
  provenBelow(price: number) { return !this.e || !this.e.truncated || this.e.provenBelow(price); }
}

/** Per-direction queue keyed by (possibly tightened) lower bounds, fed lazily by a Stream. */
class DirQueue {
  private heap = new Heap<{ path: Path; key: number }>((x) => x.key);
  private nextPath: Path | null | undefined;
  lastKey = 0;
  constructor(private s: Stream) {}
  get outOfTime() { return this.s.outOfTime; }
  private async peekStream() {
    if (this.nextPath === undefined) { const x = await this.s.next(); if (this.s.outOfTime) return null; this.nextPath = x; }
    return this.nextPath;
  }
  async topKey() { return Math.min(this.heap.peek()?.key ?? Infinity, (await this.peekStream())?.lb ?? Infinity); }
  async pop(): Promise<Path | null> {
    const a = this.heap.peek(), b = await this.peekStream();
    if (a && (!b || a.key <= b.lb)) { this.lastKey = a.key; return this.heap.pop()!.path; }
    if (b) { this.lastKey = b.lb; this.nextPath = undefined; return b; }
    return null;
  }
  /** Lowest key of the paths dropped when the queue grew too big (they still bound what is left). */
  evicted = Infinity;
  push(path: Path, key: number) {
    this.heap.push({ path, key });
    // re-queued paths are whole objects (nodes, arcs): past QUEUE_MAX the worse half goes, its lowest key kept
    if (this.heap.size > QUEUE_MAX) this.evicted = Math.min(this.evicted, this.heap.shrink(QUEUE_MAX >> 1));
  }
}
const QUEUE_MAX = 400_000;

export async function runSearch(params: SearchParams, emit: Emit, signal?: AbortSignal, opts: RunOptions = {}): Promise<SearchResult> {
  // deep: up to 8 flights, at most 72 h per direction (less if the user set less), stopovers up to 3 days;
  // the laptop worker (unlimited): no connection-count limit either, only the user's total travel time
  const p = params.depth === "deep"
    ? { ...withDeparture(params), maxLegs: 8, maxTripH: Math.min(params.maxTripH || 72, 72), stopoverDays: Math.min(params.stopoverDays ?? 3, 3) }
    : opts.unlimited ? { ...withDeparture(params), maxLegs: 8 } : withDeparture(params);
  if (!p.dest.length) throw new Error("brak lotnisk docelowych (nie rozpoznano celu)");
  const t0 = Date.now();
  const deadline = opts.deadline ?? t0 + config.maxSearchSeconds * 1000;
  // grace phases after the deadline may never run past this: the step function is killed at 300 s
  const hardStop = opts.hardStop ?? (opts.deadline ? t0 + config.stepHardSeconds * 1000 : Infinity);
  const grace = (ms: number) => Math.min(deadline + ms, hardStop);
  const deep = params.depth === "deep";
  // budgets, caps and sweep sizes: the deep ones for deep searches and for anything on the worker
  const big = deep || !!opts.unlimited;
  const D = (fast: number, d: number) => (big ? d : fast);
  const meter = new Meter(undefined, config.maxFreeCallsPerSearch * D(1, DEEP_BUDGET), opts.meterBase);
  if (big) for (const k of Object.keys(meter.limits)) meter.limits[k] *= DEEP_BUDGET;
  // Progress for the UI: share of the candidate space checked or cut by lower bounds. The setup phases
  // take the first SETUP %, the branch and bound the rest: (lb - lb0) / (best - lb0), where lb is the
  // lowest bound still unchecked. Monotonic; the ETA comes from the rate of the last minutes.
  const SETUP = 18;
  const prog = { pct: 0, lb0: NaN, samples: [] as [number, number][], eta: null as number | null, etaAt: 0 };
  const setPct = (v: number) => {
    v = Math.max(prog.pct, Math.min(100, v));
    prog.pct = v;
    const now = Date.now();
    // one sample a second at most: it is called on every branch-and-bound step, and millions of samples
    // made the shift below quadratic (the worker stalled for minutes, progress and the stop flag with it)
    const last = prog.samples[prog.samples.length - 1];
    if (last && now - last[0] < 1000) { last[1] = v; return; }
    prog.samples.push([now, v]);
    while (prog.samples.length > 2 && now - prog.samples[0][0] > 10 * 60_000) prog.samples.shift();
  };
  const PHASE_PCT: Record<string, number> = { map: 1, kiwi: 3, region: 5, baseline: 8, longhaul: 10, strategist: 12, hub: 14, split: 16, search: SETUP };
  const emitRaw = emit;
  emit = (event, data) => {
    if (event === "status") { const ph = (data as { phase?: string }).phase; if (ph && PHASE_PCT[ph] !== undefined) setPct(PHASE_PCT[ph]); }
    emitRaw(event, data);
  };
  const eta = (): number | null => {
    const s = prog.samples;
    if (prog.pct >= 100) return 0;
    if (s.length < 2 || prog.pct < SETUP) return null;
    const [t0, v0] = s[0], [t1, v1] = s[s.length - 1];
    if (v1 <= v0 || t1 - t0 < 20_000) return prog.eta === null ? null : Math.max(5, Math.round(prog.eta - (Date.now() - prog.etaAt) / 1000));
    const raw = ((100 - v1) * (t1 - t0)) / (v1 - v0) / 1000;
    // calibrated, not jumpy: the previous estimate counted down by the time passed, blended with the new rate
    const now = Date.now();
    const prev = prog.eta === null ? raw : Math.max(0, prog.eta - (now - prog.etaAt) / 1000);
    prog.eta = 0.8 * prev + 0.2 * raw;
    prog.etaAt = now;
    return Math.round(prog.eta);
  };
  const notes: string[] = [];
  const destSet = new Set(p.dest);
  const cities = destCities(p.dest); // 3+ cities: a region, one result per city
  // open-jaw: the return starts from destRet (default: the same destinations)
  const retDest = p.destRet?.length ? p.destRet : p.dest;
  const retSet = new Set(retDest);
  const openJaw = !!p.destRet?.length;
  const originSet = new Set(p.origin);
  const checked = p.baggage === "checked";
  let best = Infinity;
  let baseline: Baseline = null;
  let googleCand: Trip | null = null; // the plain offer: always a candidate (never worse than Google)
  let baselineStatus: BaselineStatus | null = null;
  // "quick": the first answer (Kiwi's ready trips, the plain Google offer) within seconds; then "full"
  let phase: "quick" | "full" = opts.incumbents?.length ? "full" : "quick";
  // the best price when stage 1 ended (the UI shows it as "Wstępnie" and the saving against it)
  let prelim: { price: number; sec: number } | null = null;
  const ticketWins = { combined: 0, separate: 0 }; // one through ticket vs separate tickets, per segment compared

  // Flexible dates: every bound of the requested range moves by FLEX_DAYS.
  const tomorrow = isoDay(Date.now() + 86400_000);
  const maxD = (a: string, b: string) => (a > b ? a : b);
  // "month": the whole calendar month(s) of the range, plus the usual days at the edges
  const flex = p.flexMode === "month" || p.flexMode === "exact" ? 0 : config.flexDays; // "month": exactly the whole month(s); "exact": the dates as given
  const d0 = p.flexMode === "month" ? p.dateFrom.slice(0, 8) + "01" : p.dateFrom;
  const d1 = p.flexMode === "month" ? monthEnd(p.dateTo.slice(0, 7)) : p.dateTo;
  let outFrom = maxD(addDays(d0, -flex), tomorrow), outTo = addDays(d1, flex);
  let retFrom = maxD(addDays(d0, p.stayMin - flex), tomorrow), retTo = addDays(d1, p.stayMax + flex);
  // the Google baseline always covers the whole search window (a deep round may search one week)
  const fullWin = { outFrom, outTo, retFrom, retTo };
  if (process.env.AZ_DEBUG) console.log("WINDOW", outFrom, outTo, retFrom, retTo, p.oneWay);
  // deep mode works the date range one week per round: every day gets the full search
  if (opts.outWindow) {
    outFrom = maxD(outFrom, opts.outWindow[0]); outTo = opts.outWindow[1] < outTo ? opts.outWindow[1] : outTo;
    retFrom = maxD(addDays(outFrom, p.stayMin), tomorrow); retTo = addDays(outTo, p.stayMax);
  }
  const outMonths = monthsBetween(outFrom, addDays(outTo, 4));
  const retMonths = p.oneWay ? [] : monthsBetween(retFrom, addDays(retTo, 4));

  // 0) refresh low-cost edges around the endpoints for the exact months (cheap, cached)
  emit("status", { phase: "map", message: "Aktualizuję mapę cen wokół punktów startu i celu" });
  const nets = await lowcostNetworks(meter);
  const span = (ms: string[]): [string, string] => [maxD(ms[0] + "-01", tomorrow), monthEnd(ms[ms.length - 1])];
  // the low-cost refresh (Ryanair, Wizz) runs alongside the Kiwi queries below (separate source pools);
  // the map is needed only from the graph phase on
  const mapRefresh = (async () => {
    await Promise.all(p.origin.map((o) => refreshLowcostOrigin(o, ...span(outMonths), meter, nets).catch(() => 0)));
    if (!p.oneWay) await Promise.all(retDest.slice(0, 4).map((o) => refreshLowcostOrigin(o, ...span(retMonths), meter, nets).catch(() => 0)));
  })();

  // 1) Kiwi combinations: real trips, used as the first incumbent and as extra candidates
  emit("status", { phase: "kiwi", message: "Pobieram gotowe kombinacje Kiwi (punkt odniesienia dla odcinania)" });
  const found = new Map<string, Trip>();
  const verified = new Map<string, VerifyResult>();
  const kiwiDest = p.dest.slice(0, 30);
  // departure airports reachable by bus (FlixBus) widen the choice; one query covers all of them
  const homeAirports = [...new Set([...p.origin, ...p.ground!])];
  // Kiwi's return tickets: from home and the biggest airports reachable from it (Warsaw, Berlin, …),
  // the bus there and back added on top; from home alone the cheap long-haul fares were never seen
  const bigFirst = (a: string, b: string) => (BIG_ORIGINS.indexOf(a) + 1 || 99) - (BIG_ORIGINS.indexOf(b) + 1 || 99);
  const rtFrom = [...p.origin].sort(bigFirst).slice(0, 4);
  const rtFromAll = [...new Set([...rtFrom, ...homeAirports.filter((c) => !p.origin.includes(c) && (BIG_ORIGINS.includes(c) || isCore(c))).sort(bigFirst)])].slice(0, 8);
  // the three Kiwi queries at once; a Kiwi return ticket flies back from where it landed: no use for open-jaw
  const kiwiAll = Promise.all([
    kiwiOneWay(homeAirports, kiwiDest, outFrom, outTo, KIWI_MAX, meter, checked),
    p.oneWay ? null : kiwiOneWay(retDest.slice(0, 30), homeAirports, retFrom, retTo, KIWI_MAX, meter, checked),
    p.oneWay || openJaw ? null : kiwiReturn(rtFromAll, kiwiDest, outFrom, outTo, retFrom, retTo, meter, checked),
  ]);
  /** Add the real bus ride between home and the airport a Kiwi itinerary starts / ends at. */
  const rideMemo = new Map<string, Promise<FlightOption[] | null>>();
  const rides = (from: string, to: string, d: string) => {
    const k = from + to + d;
    if (!rideMemo.has(k)) rideMemo.set(k, flixRides(from, to, d, meter));
    return rideMemo.get(k)!;
  };
  async function withBus(it: Itinerary, dir: "out" | "ret"): Promise<Itinerary | null> {
    const home = p.origin[0];
    const first = it.legs[0], last = it.legs[it.legs.length - 1];
    const airport = dir === "out" ? first.from : last.to;
    if (p.origin.includes(airport)) return it;
    const tz = AP[airport].tz;
    const day = utcToLocal(dir === "out" ? first.dep : last.arr, tz).slice(0, 10);
    const days = dir === "out" ? [addDays(day, -1), day] : [day, addDays(day, 1)];
    let bestRide: FlightOption | null = null;
    for (const d of days) {
      const list = dir === "out" ? await rides(home, airport, d) : await rides(airport, home, d);
      for (const r of list ?? []) {
        if ((r.arr - r.dep) / HOUR > accessLimitH(p)) continue; // longer than the access limit (real timetable)
        const ok = dir === "out" ? r.arr + 2.5 * HOUR <= first.dep && first.dep - r.arr < 30 * HOUR : r.dep >= last.arr + 1.25 * HOUR && r.dep - last.arr < 30 * HOUR;
        if (ok && (!bestRide || r.price < bestRide.price)) bestRide = r;
      }
    }
    if (!bestRide) return null;
    // a night between the bus and the flight means a hotel near the airport
    const night = dir === "out" ? overnightAt(bestRide.arr, first.dep, airport) : overnightAt(last.arr, bestRide.dep, airport);
    const hotel = night && p.countHotel !== false ? config.hotelByRegion[AP[airport].region] ?? 220 : 0;
    const legs: Leg[] = dir === "out"
      ? [bestRide, { ...first, layoverH: (first.dep - bestRide.arr) / HOUR, overnight: night || undefined, hotel: hotel || undefined }, ...it.legs.slice(1)]
      : [...it.legs, { ...bestRide, layoverH: (bestRide.dep - last.arr) / HOUR, overnight: night || undefined, hotel: hotel || undefined }];
    return { ...it, legs, price: it.price + bestRide.price + hotel, firstDep: legs[0].dep, lastArr: legs[legs.length - 1].arr, overnights: it.overnights + (night ? 1 : 0) };
  }
  const pseudo = async (dir: "out" | "ret", its: { segs: KSeg[]; price: number; link: string }[] | null): Promise<Path[]> => {
    const list = (its ?? []).filter((it) => it.segs.length && it.segs.length <= p.maxLegs * 2 && knownKiwi(it));
    if (!list.length) return [];
    // at most 3 per departure airport: one airport without a bus from home must not crowd out the rest
    const perFrom = new Map<string, number>();
    const raw = list.map((it) => itineraryFromKiwi(it.segs, it.price, it.link)).sort((a, b) => a.price - b.price)
      .filter((it) => { const f = it.legs[0].from; const n = perFrom.get(f) ?? 0; perFrom.set(f, n + 1); return n < 3; }).slice(0, 10);
    // the bus rides for all of them at once (the FlixBus pool caps the requests in flight)
    const itins = (await Promise.all(raw.map((it) => withBus(it, dir)))).filter((b): b is Itinerary => !!b);
    if (!itins.length) return [];
    itins.sort((a, b) => a.price - b.price);
    const path: Path = { id: `kiwi-${dir}`, nodes: nodesOf(itins[0].legs), arcs: [], lb: itins[0].price, flights: itins[0].legs.length };
    verified.set(dir + path.id, { status: "ok", itineraries: itins, minPrice: itins[0].price });
    return [path];
  };

  const stayOf = (o: Itinerary, r: Itinerary) => Math.round((Date.parse(isoDay(r.firstDep)) - Date.parse(isoDay(o.lastArr))) / 86400_000);
  /** A Kiwi return ticket as a trip, with the bus from home to its airport and back; null when it does not fit. */
  const rtTrip = async (id: string, it: KReturn): Promise<Trip | null> => {
    const o0 = itineraryFromKiwi(it.out, it.price, it.link), r0 = itineraryFromKiwi(it.ret, 0, it.link);
    const stay = stayOf(o0, r0);
    if (stay < p.stayMin || stay > p.stayMax || p.maxLegs * 2 < Math.max(it.out.length, it.ret.length)) return null;
    const o = await busOrEst(o0, "out"), r = o && await busOrEst(r0, "ret");
    return o && r ? makeTrip(id, o, r, it.price, "kiwi") : null;
  };
  /** The live bus ride; with a country as the origin (any of its airports is fine) an estimated ride
   *  where FlixBus has none (Poznań → Praga, Budapeszt: train or a change on the way). */
  const busOrEst = async (it: Itinerary, dir: "out" | "ret") => (await withBus(it, dir)) ?? (p.departs?.length ? estBus(it, dir) : null);
  const far = (codes: string[]) => km(AP[p.home ?? p.origin[0]], AP[codes[0]]) > 2500;
  /**
   * Separate one-way tickets there and back, landing and leaving from any of the given airports
   * (Zhengzhou in, Changchun out): far away often hundreds cheaper than one return ticket. The cheapest
   * flights each way rarely fall a stay apart, so for the 3 cheapest departures (different days) the
   * way back is searched exactly within their stay window, and the same the other way round.
   */
  const oneWayPair = async (id: string, codes: string[]): Promise<Trip | null> => {
    const ok = (x: KItin) => knownKiwi(x) && x.segs.length <= p.maxLegs * 2;
    const bus = async (list: KItin[] | null, dir: "out" | "ret") =>
      (await Promise.all((list ?? []).filter(ok).slice(0, 10).map((it) => busOrEst(itineraryFromKiwi(it.segs, it.price, it.link), dir)))).filter((x): x is Itinerary => !!x);
    const there = (a: string, b: string) => kiwiOneWay(rtFromAll, codes, a, b, KIWI_MAX, meter, checked).catch(() => null).then((l) => bus(l, "out"));
    const back = (a: string, b: string) => kiwiOneWay(codes, rtFromAll, a, b, KIWI_MAX, meter, checked).catch(() => null).then((l) => bus(l, "ret"));
    const [os0, rs0] = await Promise.all([there(outFrom, outTo), back(retFrom, retTo)]);
    const spread = (its: Itinerary[], at: (it: Itinerary) => number) => {
      const days: string[] = [];
      for (const it of [...its].sort((x, y) => x.price - y.price)) {
        const d = isoDay(at(it));
        if (days.length < 3 && !days.some((x) => Math.abs(Date.parse(x) - Date.parse(d)) < 3 * 86400_000)) days.push(d);
      }
      return days;
    };
    const [rMore, oMore] = await Promise.all([
      Promise.all(spread(os0, (o) => o.lastArr).map((d) => back(addDays(d, p.stayMin), addDays(d, p.stayMax)))),
      Promise.all(spread(rs0, (r) => r.firstDep).map((d) => there(addDays(d, -p.stayMax - 1), addDays(d, -p.stayMin)))),
    ]);
    const os = [...os0, ...oMore.flat()], rs = [...rs0, ...rMore.flat()];
    let pair: [Itinerary, Itinerary] | null = null;
    for (const o of os) for (const r of rs) {
      const stay = stayOf(o, r);
      if (r.firstDep > o.lastArr && stay >= p.stayMin && stay <= p.stayMax && (!pair || o.price + r.price < pair[0].price + pair[1].price)) pair = [o, r];
    }
    return pair ? makeTrip(id, pair[0], pair[1], pair[0].price + pair[1].price, "kiwi") : null;
  };
  /** Two itineraries back to back with a self-transfer: 3 h up to the allowed stopover days there,
   *  every night there a hotel. */
  const stopDays = Math.max(1, p.stopoverDays ?? 1);
  const joinAt = (a: Itinerary, b: Itinerary): Itinerary | null => {
    const gap = b.firstDep - a.lastArr, at = a.legs[a.legs.length - 1].to;
    if (gap < 3 * HOUR || gap > Math.max(30, stopDays * 24 + 12) * HOUR || at !== b.legs[0].from) return null;
    const nights = Math.max(overnightAt(a.lastArr, b.firstDep, at) ? 1 : 0, Math.floor(gap / (24 * HOUR)));
    const night = nights > 0;
    const hotel = night && p.countHotel !== false ? (config.hotelByRegion[AP[at].region] ?? 220) * nights : 0;
    const legs = [...a.legs, { ...b.legs[0], layoverH: gap / HOUR, overnight: night || undefined, hotel: hotel || undefined }, ...b.legs.slice(1)];
    return { legs, price: a.price + b.price + hotel, firstDep: a.firstDep, lastArr: b.lastArr, estimated: a.estimated || b.estimated, overnights: a.overnights + b.overnights + nights };
  };
  /**
   * A return ticket from a hub where the far fares are cheap (Tashkent, Almaty, Istanbul: China for
   * ~1200–1900 zł) plus a separate return ticket from home to that hub around it. Every hub's cheapest
   * return first (one Kiwi query each), then the way to the 8 cheapest hubs for their best dates.
   */
  const hubSplit = async (id: string, codes: string[]): Promise<Trip | null> => {
    const homeKm = km(AP[p.home ?? p.origin[0]], AP[codes[0]]);
    // the 20 closest to the destination of those nearer to it than home: one query each
    const hubs = SPLIT_HUBS.filter((h) => AP[h] && !homeAirports.includes(h) && !codes.includes(h) && km(AP[h], AP[codes[0]]) < homeKm)
      .sort((a, b) => km(AP[a], AP[codes[0]]) - km(AP[b], AP[codes[0]])).slice(0, 20);
    const cands = (await Promise.all(hubs.map(async (h) => {
      const rts = await kiwiReturn([h], codes, outFrom, addDays(outTo, 1), retFrom, retTo, meter, checked).catch(() => null);
      return (rts ?? []).filter((x) => knownKiwi({ segs: [...x.out, ...x.ret] }) && x.out[0].from === h && x.ret[x.ret.length - 1].to === h)
        .map((x) => ({ h, o: itineraryFromKiwi(x.out, x.price, x.link), r: itineraryFromKiwi(x.ret, 0, x.link) }))
        .filter(({ o, r }) => { const st = stayOf(o, r); return st >= p.stayMin && st <= p.stayMax; }).slice(0, 2);
    }))).flat().sort((a, b) => a.o.price - b.o.price);
    const hubBest = new Map<string, number>();
    const top = cands.filter((c) => { const n = hubBest.get(c.h) ?? 0; hubBest.set(c.h, n + 1); return n < 2; }).filter((c) => [...hubBest.keys()].indexOf(c.h) < 8).slice(0, 12);
    if (process.env.AZ_DEBUG) console.log("HUBS", hubs.join(" "), "TOP", top.map((c) => `${c.h}:${c.o.price}`).join(" "));
    let best: [Itinerary, Itinerary] | null = null;
    await Promise.all(top.map(async ({ h, o: ho, r: hr }) => {
      if (best && ho.price >= best[0].price + best[1].price) return;
      const d0 = isoDay(ho.firstDep), d1 = isoDay(hr.lastArr);
      const fits = (o: Itinerary | null, r: Itinerary | null): o is Itinerary => !!o && !!r && o.legs.length <= p.maxLegs * 2 + 1 && r.legs.length <= p.maxLegs * 2 + 1;
      const take = (o: Itinerary, r: Itinerary) => { if (!best || o.price + r.price < best[0].price + best[1].price) best = [o, r]; };
      // to the hub and back: one return ticket, or two one-ways (low-cost both ways, other airports)
      const [pos, posOut, posRet] = await Promise.all([
        kiwiReturn(rtFromAll, [h], addDays(d0, -stopDays), d0, d1, addDays(d1, stopDays), meter, checked).catch(() => null),
        kiwiOneWay(rtFromAll, [h], addDays(d0, -stopDays), d0, KIWI_MAX, meter, checked).catch(() => null),
        kiwiOneWay([h], rtFromAll, d1, addDays(d1, stopDays), KIWI_MAX, meter, checked).catch(() => null),
      ]);
      for (const x of (pos ?? []).filter((y) => knownKiwi({ segs: [...y.out, ...y.ret] })).slice(0, 12)) {
        const po = await busOrEst(itineraryFromKiwi(x.out, x.price, x.link), "out"), pr = po && await busOrEst(itineraryFromKiwi(x.ret, 0, x.link), "ret");
        const o = po && joinAt(po, ho), r = pr && joinAt(hr, pr);
        if (fits(o, r)) { take(o, r!); break; } // sorted by price: the first that connects is the cheapest
      }
      const first = async (list: KItin[] | null, dir: "out" | "ret") => {
        let bestJ: Itinerary | null = null;
        for (const x of (list ?? []).filter(knownKiwi).slice(0, 12)) {
          const b = await busOrEst(itineraryFromKiwi(x.segs, x.price, x.link), dir);
          const j = b && (dir === "out" ? joinAt(b, ho) : joinAt(hr, b));
          if (j && (!bestJ || j.price < bestJ.price)) bestJ = j;
        }
        return bestJ;
      };
      const [o1, r1] = await Promise.all([first(posOut, "out"), first(posRet, "ret")]);
      if (fits(o1, r1)) take(o1, r1!);
    }));
    // the other way round: the cheapest return to each of the 4 best hubs over the whole window, then
    // the hub ticket inside it (Dili: Berlin-Kuala Lumpur in February, Kuala Lumpur-Dili around it)
    await Promise.all([...hubBest.keys()].slice(0, 4).map(async (h) => {
      const pos = await kiwiReturn(rtFromAll, [h], outFrom, outTo, retFrom, retTo, meter, checked).catch(() => null);
      const seen = new Set<string>();
      for (const x of (pos ?? []).filter((y) => knownKiwi({ segs: [...y.out, ...y.ret] })).slice(0, 15)) {
        if (seen.size >= 2) break;
        const a = isoDay(x.out[x.out.length - 1].arr), z = isoDay(x.ret[0].dep), key = `${a}:${z}`;
        if (seen.has(key)) continue;
        const po = await busOrEst(itineraryFromKiwi(x.out, x.price, x.link), "out"), pr = po && await busOrEst(itineraryFromKiwi(x.ret, 0, x.link), "ret");
        if (!po || !pr) continue;
        seen.add(key);
        if (best && po.price >= best[0].price + best[1].price) continue;
        const inner = await kiwiReturn([h], codes, a, addDays(a, stopDays), addDays(z, -stopDays), z, meter, checked).catch(() => null);
        for (const y of (inner ?? []).filter((w) => knownKiwi({ segs: [...w.out, ...w.ret] }) && w.out[0].from === h && w.ret[w.ret.length - 1].to === h).slice(0, 8)) {
          const o = joinAt(po, itineraryFromKiwi(y.out, y.price, y.link)), r = joinAt(itineraryFromKiwi(y.ret, 0, y.link), pr);
          if (!o || !r || o.legs.length > p.maxLegs * 2 + 1 || r.legs.length > p.maxLegs * 2 + 1) continue;
          const st = stayOf(o, r);
          if (st < p.stayMin || st > p.stayMax) continue;
          if (!best || o.price + r.price < best[0].price + best[1].price) best = [o, r];
          break;
        }
      }
    }));
    const b = best as [Itinerary, Itinerary] | null;
    if (process.env.AZ_DEBUG) console.log("HUBSPLIT", id, b ? b[0].price + b[1].price : null, b?.[0].legs.map((l) => l.from).join("-"));
    if (!b) return null;
    const t = makeTrip(id, b[0], b[1], b[0].price + b[1].price, "kiwi");
    return { ...t, flags: [`osobny bilet do ${AP[b[0].legs.find((l) => l.layoverH && l.layoverH >= 3)?.from ?? ""]?.city ?? "hubu"} (samodzielna przesiadka)`, ...t.flags] };
  };
  /**
   * Google Flights for what Kiwi does not sell (Russia: Berlin-Moscow on AJet via Istanbul; carriers
   * Kiwi lacks): Google's one-way date graph from the 4 biggest departure airports to the 2 biggest
   * destination airports and back, the cheapest days with a valid stay, then those days' flights.
   */
  /** Google's one-way price for every day of [a, b] (the date graph, ~100 days per request). */
  const gDays = async (f: string, t: string, a: string, b: string) => {
    const w: [string, string][] = [];
    for (let d = a; d <= b; d = addDays(d, 100)) w.push([d, addDays(d, 99) < b ? addDays(d, 99) : b]);
    return (await Promise.all(w.map(([x, y]) => googleOwGrid(f, t, x, y, meter).catch(() => null)))).flatMap((r) => r ?? []).map((r) => ({ f, t, day: r.out, price: r.price }));
  };
  /** Google's flights on one day as one-ticket itineraries (cheapest first). */
  const gItins = async (f: string, t: string, day: string): Promise<Itinerary[]> =>
    ((await googleOneWay(f, t, day, meter).catch(() => null)) ?? []).map((opt) => ({
      legs: [{ ...opt, note: opt.stops ? "jeden bilet z przesiadką (Google): przesiadka chroniona" : undefined }], price: opt.price, firstDep: opt.dep, lastArr: opt.arr, estimated: false, overnights: 0 }));
  const googleLane = async (id: string, codes: string[]): Promise<Trip | null> => {
    const froms = rtFromAll.slice(0, 4), tos = codes.slice(0, 2);
    const days = gDays;
    const [outs, rets] = await Promise.all([
      Promise.all(froms.flatMap((f) => tos.map((t) => days(f, t, outFrom, outTo)))),
      Promise.all(froms.flatMap((f) => tos.map((t) => days(t, f, retFrom, retTo)))),
    ]).then((x) => x.map((l) => l.flat().sort((a, b) => a.price - b.price).slice(0, 60)));
    const combos = outs.flatMap((o) => rets.map((r) => ({ o, r, stay: (Date.parse(r.day) - Date.parse(o.day)) / DAY })))
      .filter((c) => c.stay >= p.stayMin && c.stay <= p.stayMax).sort((a, b) => a.o.price + a.r.price - b.o.price - b.r.price);
    const legOf = async (x: { f: string; t: string; day: string }, dir: "out" | "ret") => {
      const it = (await gItins(x.f, x.t, x.day))[0];
      return it ? busOrEst(it, dir) : null;
    };
    let best: Trip | null = null;
    const tried = new Set<string>();
    for (const c of combos) {
      if (tried.size >= 3 || signal?.aborted || Date.now() > grace(0)) break;
      const k = `${c.o.f}${c.o.t}${c.o.day}${c.r.f}${c.r.t}${c.r.day}`;
      if (tried.has(k)) continue;
      tried.add(k);
      const [o, r] = await Promise.all([legOf(c.o, "out"), legOf(c.r, "ret")]);
      if (!o || !r) continue;
      const st = stayOf(o, r);
      if (st < p.stayMin || st > p.stayMax) continue;
      const t = makeTrip(id, o, r, o.price + r.price, "azymut");
      if (!best || t.price < best.price) best = t;
    }
    if (process.env.AZ_DEBUG) console.log("GOOGLE", id, outs.length, rets.length, combos[0] && combos[0].o.price + combos[0].r.price, best?.price);
    return best;
  };
  /**
   * Russia beyond Moscow (Kamczatka, Władywostok): only Russian carriers fly there, on neither Kiwi
   * nor Google. Google to Moscow (via Istanbul, Belgrade…) on a separate ticket, then Aviasales'
   * direct domestic flight within the stopover days; back the same way.
   */
  const ruLane = async (id: string, codes: string[]): Promise<Trip | null> => {
    const dests = codes.filter((c) => AP[c]?.cc === "RU" && !MOSCOW.includes(c)).slice(0, 2);
    if (!dests.length || p.oneWay) return null;
    const froms = rtFromAll.slice(0, 4);
    const dom = async (a: string[], b: string[], d0: string, d1: string) => (await Promise.all(a.flatMap((x) => b.map((y) => aviasalesDirect(x, y, d0, d1, meter).catch(() => null)))))
      .flatMap((r) => r ?? []).filter((f) => AP[f.from] && AP[f.to]).sort((x, y) => x.price - y.price);
    const [dOut, dRet] = await Promise.all([dom(["SVO"], dests, outFrom, addDays(outTo, stopDays + 1)), dom(dests, ["SVO"], retFrom, retTo)]);
    if (!dOut.length || !dRet.length) return null;
    // any Moscow airport (Wnukowo has the cheap Turkish flights, Kamczatka leaves from Szeremietiewo)
    const mos = ["SVO", "VKO"];
    const [gOut, gRet] = await Promise.all([
      Promise.all(froms.flatMap((f) => mos.map((m) => gDays(f, m, outFrom, outTo)))).then((x) => x.flat()),
      Promise.all(froms.flatMap((f) => mos.map((m) => gDays(m, f, retFrom, addDays(retTo, stopDays + 1))))).then((x) => x.flat()),
    ]);
    // a change of Moscow airport: Aeroexpress / taxi, ~2 h and ~80 zł
    const move = (a: string, b: string, at: number): Leg => ({ from: a, to: b, dep: at, arr: at + 2 * HOUR, depLocal: utcToLocal(at, AP[a].tz), arrLocal: utcToLocal(at + 2 * HOUR, AP[b].tz),
      price: 80, carrier: "transfer lokalny", flightNo: "", source: "local", link: "", estimated: true, note: `zmiana lotniska ${a} → ${b} (szacunkowo)` });
    const tail = (it: Itinerary, to: string): Itinerary => { const at = it.legs[it.legs.length - 1].to; if (at === to) return it; const l = move(at, to, it.lastArr + HOUR); return { ...it, legs: [...it.legs, { ...l, layoverH: 1 }], price: it.price + l.price, lastArr: l.arr }; };
    const asIt = (f: FlightOption): Itinerary => ({ legs: [{ ...f, note: f.estimated ? "cena orientacyjna z kalendarza Aviasales" : "cena z kalendarza Aviasales (Rosja: kup na miejscu lub przez pośrednika)" }], price: f.price, firstDep: f.dep, lastArr: f.arr, estimated: !!f.estimated, overnights: 0 });
    const dayMs = (d: string) => Date.parse(d);
    type Cand = { g: { f: string; t: string; day: string; price: number }; d: FlightOption; est: number };
    // per direction: each domestic flight with the cheapest Google day that reaches it (or leaves after it)
    const cands = (dir: "out" | "ret"): Cand[] => {
      const out: Cand[] = [];
      for (const d of (dir === "out" ? dOut : dRet).slice(0, 40)) {
        const day = isoDay(dir === "out" ? d.dep : d.arr);
        const g = (dir === "out" ? gOut : gRet).filter((x) => { const gap = (dir === "out" ? dayMs(day) - dayMs(x.day) : dayMs(x.day) - dayMs(day)); return gap >= 0 && gap <= stopDays * DAY; })
          .sort((a, b) => a.price - b.price)[0];
        if (g) out.push({ g, d, est: g.price + d.price + ((dir === "out" ? g.t === d.from : g.f === d.to) ? 0 : 80) });
      }
      return out;
    };
    const memo = new Map<Cand, Promise<Itinerary | null>>();
    const real = (c: Cand, dir: "out" | "ret") => {
      if (!memo.has(c)) memo.set(c, (async () => {
        const gis = await gItins(c.g.f, c.g.t, c.g.day);
        if (process.env.AZ_DEBUG) console.log("RU real", dir, c.g.f, c.g.t, c.g.day, c.g.price, "google itins", gis.length, gis.slice(0, 3).map((x) => `${x.price} ${x.legs[0].depLocal}-${x.legs[0].arrLocal}`).join(" | "), "dom", c.d.from, c.d.to, c.d.depLocal, c.d.price);
        for (const gi of gis.slice(0, 4)) {
          const g = await busOrEst(gi, dir);
          const j = g && (dir === "out" ? joinAt(tail(g, c.d.from), asIt(c.d)) : joinAt(tail(asIt(c.d), g.legs[0].from), g));
          if (j) return j;
        }
        return null;
      })());
      return memo.get(c)!;
    };
    // pairs whose stay at the destination fits, cheapest estimate first; the 5 best realized
    const co = cands("out"), cr = cands("ret");
    const pairs = co.flatMap((o) => cr.map((r) => ({ o, r, stay: (r.d.dep - o.d.arr) / DAY, est: o.est + r.est })))
      .filter((x) => x.stay >= p.stayMin - 1 && x.stay <= p.stayMax + 1).sort((a, b) => a.est - b.est).slice(0, 5);
    let best: Trip | null = null;
    for (const x of pairs) {
      if (signal?.aborted || Date.now() > grace(0)) break;
      const [o, r] = await Promise.all([real(x.o, "out"), real(x.r, "ret")]);
      if (!o || !r) continue;
      const st = stayOf(o, r);
      if (st < p.stayMin || st > p.stayMax) continue;
      const t = makeTrip(id, o, r, o.price + r.price, "azymut");
      if (!best || t.price < best.price) best = { ...t, flags: ["lot krajowy w Rosji z kalendarza Aviasales (osobny bilet)", ...t.flags] };
    }
    if (process.env.AZ_DEBUG) console.log("RU", id, dOut.length, dRet.length, gOut.length, gRet.length, pairs.map((x) => Math.round(x.est)).join(","), best?.price);
    return best;
  };
  /**
   * Russia through a foreign hub (Mineralnye Wody, Soczi, Kazań…): Russian and Turkish carriers fly
   * there straight from Istanbul, Yerevan, Baku, Dubai (Azimuth Istanbul–Mineralnye Wody ~390 zł) on
   * neither Kiwi nor Google. The direct flight from Aviasales, the way to and from the hub on Kiwi,
   * joined as separate tickets within the stopover days.
   */
  const ruHubLane = async (id: string, codes: string[]): Promise<Trip | null> => {
    const dests = codes.filter((c) => AP[c]?.cc === "RU" && !MOSCOW.includes(c)).slice(0, 2);
    if (!dests.length || p.oneWay) return null;
    let best: Trip | null = null;
    await Promise.all(RU_HUBS.map(async (h) => {
      const dir = async (a: string[], b: string[], d0: string, d1: string) => (await Promise.all(a.flatMap((x) => b.map((y) => aviasalesDirect(x, y, d0, d1, meter).catch(() => null)))))
        .flatMap((r) => r ?? []).filter((f) => AP[f.from] && AP[f.to]).sort((x, y) => x.price - y.price).slice(0, 30);
      const [dOut, dRet] = await Promise.all([dir([h], dests, outFrom, addDays(outTo, stopDays + 1)), dir(dests, [h], retFrom, retTo)]);
      if (process.env.AZ_DEBUG) console.log("RUHUB", h, dOut.length, dRet.length, dOut[0]?.price, dRet[0]?.price);
      if (!dOut.length || !dRet.length || signal?.aborted || Date.now() > grace(0)) return;
      const [kOut, kRet] = await Promise.all([
        kiwiOneWay(rtFromAll, [h], addDays(outFrom, -stopDays), addDays(outTo, stopDays), KIWI_MAX, meter, checked).catch(() => null),
        kiwiOneWay([h], rtFromAll, retFrom, addDays(retTo, stopDays + 1), KIWI_MAX, meter, checked).catch(() => null),
      ]);
      const pos = async (list: KItin[] | null, dirn: "out" | "ret") => {
        const its: Itinerary[] = [];
        for (const x of (list ?? []).filter(knownKiwi).slice(0, 40)) { const b = await busOrEst(itineraryFromKiwi(x.segs, x.price, x.link), dirn); if (b) its.push(b); }
        return its;
      };
      const [pOut, pRet] = await Promise.all([pos(kOut, "out"), pos(kRet, "ret")]);
      const asIt = (f: FlightOption): Itinerary => ({ legs: [{ ...f, note: "lot z kalendarza Aviasales (osobny bilet; Rosja: kup przez Aviasales lub pośrednika)" }], price: f.price, firstDep: f.dep, lastArr: f.arr, estimated: !!f.estimated, overnights: 0 });
      // per hub flight: the cheapest way there (or back) that connects to it
      const outs: Itinerary[] = [], rets: Itinerary[] = [];
      for (const d of dOut) { let b: Itinerary | null = null; for (const q of pOut) { const j = joinAt(q, asIt(d)); if (j && (!b || j.price < b.price)) b = j; } if (b) outs.push(b); }
      for (const d of dRet) { let b: Itinerary | null = null; for (const q of pRet) { const j = joinAt(asIt(d), q); if (j && (!b || j.price < b.price)) b = j; } if (b) rets.push(b); }
      for (const o of outs) for (const r of rets) {
        if (o.legs.length > p.maxLegs * 2 + 1 || r.legs.length > p.maxLegs * 2 + 1) continue;
        const st = stayOf(o, r);
        if (st < p.stayMin || st > p.stayMax) continue;
        if (best && o.price + r.price >= best.price) continue;
        const t = makeTrip(id, o, r, o.price + r.price, "azymut");
        best = { ...t, flags: [`osobny bilet do ${AP[h]?.city ?? h} i lot z kalendarza Aviasales (samodzielna przesiadka)`, ...t.flags] };
      }
    }));
    if (process.env.AZ_DEBUG) console.log("RUHUB best", id, (best as Trip | null)?.price);
    return best;
  };
  /** Kayak's explore map from the 4 biggest departure airports on up to 4 sample dates over the window
   *  (one request covers every destination), cached fares with a valid stay. Fetched once per search. */
  let kayakAll: Promise<KayakHint[]> | null = null;
  const kayakHints = () => (kayakAll ??= (async () => {
    const span = (Date.parse(outTo) - Date.parse(outFrom)) / DAY, mid = Math.round((p.stayMin + p.stayMax) / 2);
    const samples = [...new Set([0, 0.33, 0.66, 1].map((k) => addDays(outFrom, Math.round(span * k))))].slice(0, span > 10 ? 4 : 1);
    const res = await Promise.all(rtFromAll.slice(0, 4).flatMap((f) => samples.map((d) => kayakExplore(f, d, addDays(d, mid), meter).catch(() => null))));
    return res.flatMap((r) => r ?? []).filter((h) => {
      const st = (Date.parse(h.ret) - Date.parse(h.out)) / DAY;
      return AP[h.to] && h.out >= outFrom && h.out <= outTo && st >= p.stayMin && st <= p.stayMax;
    }).sort((a, b) => a.price - b.price);
  })());
  /**
   * The cheapest Kayak round trips to these airports (or their cities), priced again for the hinted
   * dates: Kiwi's return ticket on exactly those days, and Google's round trip (its outbound as shown,
   * the way back the same airline's flight that day, in the ticket price).
   */
  const kayakLane = async (id: string, codes: string[], below = Infinity): Promise<Trip[]> => {
    const want = new Set(codes), cityOf = new Set(codes.map((c) => AP[c]?.city));
    const seen = new Set<string>();
    const hints = (await kayakHints()).filter((h) => (want.has(h.to) || cityOf.has(AP[h.to].city)) && h.price < below)
      .filter((h) => { const k = h.from + h.to + h.out + h.ret; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 3);
    const out: Trip[] = [];
    await Promise.all(hints.map(async (h, k) => {
      const rts = await kiwiReturn([h.from], [h.to], h.out, h.out, h.ret, h.ret, meter, checked).catch(() => null);
      for (const x of (rts ?? []).filter((y) => knownKiwi({ segs: [...y.out, ...y.ret] })).slice(0, 3)) {
        const t = await rtTrip(`${id}-k${k}`, x);
        if (t) { out.push(t); break; }
      }
      const g = await googleRoundTrip([h.from], [h.to], h.out, h.ret, meter).catch(() => null);
      if (!g) return;
      const A = AP[h.from], B = AP[h.to];
      const dep = localToUtc(g.outbound.depLocal, A.tz), arr = localToUtc(g.outbound.arrLocal, B.tz);
      const back = (await gItins(h.to, h.from, h.ret)).find((it) => it.legs[0].carrier === g.outbound.carriers) ?? (await gItins(h.to, h.from, h.ret))[0];
      if (!back) return;
      const o0: Itinerary = { legs: [{ from: h.from, to: h.to, dep, arr, depLocal: g.outbound.depLocal, arrLocal: g.outbound.arrLocal, price: g.price, carrier: g.outbound.carriers,
        flightNo: g.outbound.stops ? `${g.outbound.stops} przes.` : "", source: "google", link: g.url, note: `bilet powrotny (Google, ślad z Kayaka)${g.outbound.stops ? ": przesiadki chronione" : ""}` }], price: g.price, firstDep: dep, lastArr: arr, estimated: false, overnights: 0 };
      const r0: Itinerary = { ...back, legs: back.legs.map((l) => ({ ...l, price: 0, link: g.url, note: "lot powrotny w cenie biletu: potwierdź godzinę przy rezerwacji" })), price: 0 };
      const o = await busOrEst(o0, "out"), r = o && await busOrEst(r0, "ret");
      if (o && r) { const st = stayOf(o, r); if (st >= p.stayMin && st <= p.stayMax) out.push(makeTrip(`${id}-g${k}`, o, r, o.price + r.price, "azymut")); }
    }));
    if (process.env.AZ_DEBUG) console.log("KAYAK", id, hints.map((h) => `${h.from}-${h.to} ${h.out}/${h.ret} ${h.price} ${h.airline}`).join(" | "), "->", out.map((t) => t.price).join(","));
    return out;
  };
  function makeTrip(id: string, o: Itinerary, r: Itinerary | null, lb: number, origin: Trip["origin"], price = o.price + (r?.price ?? 0)): Trip {
    const legs: TripLeg[] = [...o.legs.map((l) => ({ ...l, dir: "out" as const })), ...(r?.legs.map((l) => ({ ...l, dir: "ret" as const })) ?? [])];
    const destAp = AP[o.legs[o.legs.length - 1].to];
    const flags = riskFlags(legs, p, destAp?.cc, { from: p.dateFrom, to: p.dateTo });
    if (origin === "kiwi") flags.unshift("kombinacja Kiwi");
    if (r && o.legs[o.legs.length - 1].to !== r.legs[0].from) flags.push(`open-jaw: przylot ${o.legs[o.legs.length - 1].to}, powrót z ${r.legs[0].from}`);
    const cheapCarrier = legs.find((l) => l.price > 0 && km(AP[l.from], AP[l.to]) > 2500 && config.lowcostLongHaul.some((c) => l.carrier.toLowerCase().includes(c.toLowerCase())));
    if (cheapCarrier) flags.push(`tania linia długodystansowa: ${cheapCarrier.carrier}`);
    return {
      savings: [...(o.savings ?? []), ...(r?.savings ?? [])],
      id, price: Math.round(price), lb, legs, nodes: [...nodesOf(o.legs), ...(r ? nodesOf(r.legs) : [])], flags, origin,
      estimated: legs.some((l) => l.estimated),
      travelH: Math.round(((o.lastArr - o.firstDep) + (r ? r.lastArr - r.firstDep : 0)) / HOUR),
      outDate: utcToLocal(o.firstDep, AP[o.legs[0].from].tz).slice(0, 10),
      retDate: r ? utcToLocal(r.firstDep, AP[r.legs[0].from].tz).slice(0, 10) : null,
      stayDays: r ? stayOf(o, r) : null,
    };
  }
  // the cheapest trip whose every direction is one booking (shown next to the cheapest overall)
  let oneTicketBest: Trip | null = null;
  const noteOneTicket = (t: Trip) => { if (t.oneTicket && Number.isFinite(t.price) && (!oneTicketBest || t.price < oneTicketBest.price)) oneTicketBest = t; };
  const accept = (t: Trip) => {
    // whatever a trip came from (memory, Kiwi, an earlier step), it must really go to this search's destination
    const outs = t.legs.filter((l) => l.dir === "out"), rets = t.legs.filter((l) => l.dir === "ret");
    if (outs.length && !destSet.has(outs[outs.length - 1].to)) return;
    if (rets.length && !retSet.has(rets[0].from)) return;
    // ...and fly on this search's dates (a remembered trip or a widened leg window must not slip a day early)
    const day = (ls: TripLeg[]) => { const f = ls.find((l) => !isGroundLeg(l)) ?? ls[0]; return utcToLocal(f.dep, AP[f.from].tz).slice(0, 10); };
    if (outs.length && (day(outs) < fullWin.outFrom || day(outs) > fullWin.outTo)) return;
    if (rets.length && (day(rets) < fullWin.retFrom || day(rets) > fullWin.retTo)) return;
    t = withBags(withTickets(expandVias(t)), p);
    noteOneTicket(t);
    found.set(t.id, t);
    if (t.price < best || (t.price === best && t.oneTicket)) { best = t.price; emit("best", t); }
    else if (cities.size >= REGION_MIN_CITIES) emit("trip", t); // a region lists every city's best trip, not only improvements
  };
  /** Stats before the branch and bound exists (the quick answer). */
  const emitEarly = () => emit("stats", { ...meter.snapshot(), checked: found.size, pruned: 0, best: Number.isFinite(best) ? best : null, phase, prelim: prelim ?? undefined, oneTicket: oneTicketBest ?? undefined,
    progress: { pct: Math.round(prog.pct * 10) / 10, etaSec: null, combos: found.size }, baselineStatus: baselineStatus ?? undefined, baselineNow: baseline ?? undefined });
  for (const t of opts.incumbents ?? []) accept(t);
  emitEarly();
  let kiwiOutPaths: Path[] = [], kiwiRetPaths: Path[] = [];
  // Kiwi's ready trips first (the quick answer), then the separate one-way tickets with the bus from home
  const kiwiFirst = (async () => {
    const [kOut, kRet, kRt] = await kiwiAll;
    let nRt = 0;
    for (const [k, it] of (kRt ?? []).filter((x) => knownKiwi({ segs: [...x.out, ...x.ret] })).slice(0, 12).entries()) {
      const t = await rtTrip(`kiwi-rt-${k}`, it);
      if (t) accept(t);
      if (t && ++nRt >= 3) break;
    }
    emitEarly();
    return [kOut, kRet] as const;
  })();
  const kiwiTask = kiwiFirst.then(async ([kOut, kRet]) => {
    [kiwiOutPaths, kiwiRetPaths] = await Promise.all([pseudo("out", kOut), p.oneWay ? Promise.resolve([]) : pseudo("ret", kRet)]);
  });
  // 2) the price map (needed by the stage-1 map candidates and everything after)
  let accessGraph: Graph | null = null;
  const graphTask = (async () => {
    await mapRefresh;
    const gOut = await buildGraph(outMonths, checked, p.origin, p.ground);
    const gRet = p.oneWay ? null : await buildGraph(retMonths, checked, p.origin, p.ground);
    // destinations outside the price map (small and regional airports) join the graph via their nearest hubs
    connectSmall(gOut.graph, [...p.dest, ...retDest]);
    if (gRet) connectSmall(gRet.graph, [...p.dest, ...retDest]);
    accessGraph = gOut.graph;
    return { gOut, gRet };
  })();

  // The Google baseline for the same search, early: the plain offer is a candidate (often a strong
  // incumbent for the pruning below), and the result can never end up more expensive than Google.
  /** Bus from home to an airport: the map's ground arc, else a distance estimate. */
  const accessEst = (ap: string): number => {
    if (p.origin.includes(ap) || p.access === false) return 0;
    let m = Infinity;
    for (const o of p.origin) for (const a of accessGraph?.get(o) ?? []) if (a.kind === "ground" && a.to === ap) m = Math.min(m, a.lb);
    return Number.isFinite(m) ? m : Math.round(30 + km(AP[p.origin[0]], AP[ap]) * 0.12);
  };
  /** An estimated bus leg between home and an airport (when no live ride was found). */
  const estBus = (it: Itinerary, dir: "out" | "ret"): Itinerary => {
    const home = p.origin[0];
    const ap = dir === "out" ? it.legs[0].from : it.legs[it.legs.length - 1].to;
    const price = accessEst(ap), hours = Math.max(1, km(AP[home], AP[ap]) / 70);
    const dep = dir === "out" ? it.firstDep - (3 + hours) * HOUR : it.lastArr + 1.5 * HOUR;
    const [from, to] = dir === "out" ? [home, ap] : [ap, home];
    const leg: Leg = { from, to, dep, arr: dep + hours * HOUR, depLocal: utcToLocal(dep, AP[from].tz), arrLocal: utcToLocal(dep + hours * HOUR, AP[to].tz),
      price, carrier: "autobus / pociąg", flightNo: "", source: "ground", link: "", estimated: true, note: "dojazd szacunkowy (brak kursu na żywo)" };
    const legs = dir === "out" ? [leg, ...it.legs] : [...it.legs, leg];
    return { ...it, legs, price: it.price + price, firstDep: legs[0].dep, lastArr: legs[legs.length - 1].arr, estimated: true };
  };
  /** The baseline offer as a trip, door to door (the bus to Google's airport and back counted like ours). */
  async function offerTrip(o: BaselineOffer): Promise<Trip | null> {
    if (o.kiwiOw || o.kiwiRt) {
      let out = itineraryFromKiwi(o.kiwiRt ? o.kiwiRt.out : o.kiwiOw!.segs, o.price, o.url);
      out = (await withBus(out, "out")) ?? estBus(out, "out");
      let ret = o.kiwiRt ? itineraryFromKiwi(o.kiwiRt.ret, 0, o.url) : null;
      if (ret) ret = (await withBus(ret, "ret")) ?? estBus(ret, "ret");
      const t = makeTrip(`google-kiwi-${o.outDate}-${o.retDate ?? ""}`, out, ret, o.price, "kiwi");
      return { ...t, flags: ["cena bazowa (Kiwi, jedna rezerwacja)", ...t.flags] };
    }
    if (!o.outbound) return null;
    let gt = googleTrip({ ...o.outbound, price: o.price, url: o.url, retDate: o.retDate }, o.origins, o.dests);
    // the return half: Google's result page shows only the outbound, so take the same airline's flight
    // that day from a one-way search (times and transfers; the price stays in the round-trip ticket)
    const rl = gt.legs[1];
    if (rl?.arrEstimated && o.retDate) {
      const air = (c: string) => c.split(" + ")[0].trim().toLowerCase();
      const opts = ((await googleOneWay(rl.from, rl.to, o.retDate, meter).catch(() => null)) ?? []).filter((x) => air(x.carrier) === air(rl.carrier));
      const pick = opts.sort((a, b) => (a.stops ?? 0) - (b.stops ?? 0) || a.price - b.price)[0];
      if (pick) gt = { ...gt, legs: [gt.legs[0], { ...rl, dep: pick.dep, arr: pick.arr, depLocal: pick.depLocal, arrLocal: pick.arrLocal, stops: pick.stops, via: pick.via,
        flightNo: pick.flightNo, arrEstimated: undefined, note: "powrót w tej samej rezerwacji: lot tej linii wg rozkładu Google, potwierdź godzinę przy rezerwacji" }, ...gt.legs.slice(2)],
        travelH: Math.round((gt.legs[0].arr - gt.legs[0].dep + pick.arr - pick.dep) / HOUR) };
    }
    const first = gt.legs[0];
    if (p.origin.includes(first.from) || p.access === false) return gt;
    const it0: Itinerary = { legs: [first], price: first.price, firstDep: first.dep, lastArr: first.arr, estimated: false, overnights: 0 };
    const it = (await withBus(it0, "out")) ?? estBus(it0, "out");
    let back: TripLeg | null = null;
    if (o.retDate) {
      let ride: FlightOption | null = null;
      for (const r of (await rides(first.from, p.origin[0], o.retDate)) ?? []) if (!ride || r.price < ride.price) ride = r;
      if (ride) back = { ...ride, dir: "ret", note: "dojazd do domu: najtańszy kurs w dniu powrotu (godzina wg przylotu)" };
      else {
        const est = estBus({ legs: [gt.legs[1]], price: 0, firstDep: gt.legs[1].dep, lastArr: gt.legs[1].arr, estimated: true, overnights: 0 }, "ret");
        back = { ...est.legs[1], dir: "ret" };
      }
    }
    const legs: TripLeg[] = [...it.legs.map((l) => ({ ...l, dir: "out" as const })), ...gt.legs.slice(1), ...(back ? [back] : [])];
    gt = { ...gt, legs, price: Math.round(it.price + (back?.price ?? 0)), estimated: legs.some((l) => l.estimated), nodes: [p.origin[0], ...gt.nodes, ...(back ? [p.origin[0]] : [])] };
    return gt;
  }
  /** quick: stage 1 (result pages for the best dates, seconds); full: the date graph and every airport
   *  (in the background, minutes on routes Google has little cached); final: the dates of the best trips. */
  async function runBaseline(mode: "quick" | "full" | "final") {
    const final = mode === "final";
    if (mode !== "full") emit("status", { phase: final ? "final" : "baseline", message: final ? "Sprawdzam Google na daty najlepszych tras" : "Cena Google Flights: te same lotniska wylotu, daty i typ podróży" });
    const origins = [...new Set([...p.origin, ...(p.ground ?? [])])].filter((c) => AP[c]).sort((a, b) => accessEst(a) - accessEst(b));
    const top = [...found.values()].filter((t) => Number.isFinite(t.price) && !t.google).sort((a, b) => a.price - b.price);
    // destinations: those of the best trips first, then the search's own order
    const dests = [...new Set([...top.slice(0, 6).map((t) => tripDest(t)), ...p.dest])].filter((c) => AP[c] && destSet.has(c));
    const hint = top.slice(0, final ? 4 : 2).map((t) => [t.outDate, t.retDate] as [string, string | null]);
    // quick and final: Google's result page for the best trips' dates; full: the date graph first
    const r = await googleBaseline(origins, dests, { ...fullWin, stayMin: p.stayMin, stayMax: p.stayMax, oneWay: p.oneWay }, hint, meter,
      (m) => { if (process.env.AZ_DEBUG) console.log(m); }, mode !== "full");
    if (r.status.ok || !baselineStatus?.ok) baselineStatus = { ...r.status, queried: r.status.queried + (baselineStatus?.queried ?? 0), source: r.status.source ?? baselineStatus?.source ?? null };
    for (const o of r.offers.slice(0, 4)) {
      const t = await offerTrip(o).catch(() => null);
      if (!t || !Number.isFinite(t.price)) continue;
      // with a checked bag the offer is compared with the bag fee its carriers charge (tb.price); without, tb.price = t.price
      const tb = withBags(withTickets(t), p);
      noteOneTicket(tb); // Google's offer is one booking: a candidate for the one-ticket trip even when pricier
      if (!googleCand || tb.price < googleCand.price) {
        googleCand = tb;
        baseline = { price: tb.price, flight: o.price, access: t.price - o.price, url: o.url, summary: "", origins: o.origins, outDate: o.outDate, retDate: o.retDate,
          source: o.source, from: t.legs.find((l) => !isGroundLeg(l))?.from, to: tripDest(t), bagPrice: tb.bagPrice };
      }
      if (tb.price <= best || cities.size >= REGION_MIN_CITIES) accept(tb);
    }
    if (mode !== "quick" && baselineStatus?.note && !notes.includes(baselineStatus.note)) notes.push(baselineStatus.note);
    if (phase === "quick") emitEarly();
  }

  /** Stage 1: trips found by earlier searches of the same direction (and the overnight list), priced again live. */
  async function recheckRemembered() {
    // the live re-check prices without the bag: with a checked bag the search finds its own
    if (checked) return;
    const { rememberedTrips } = await import("./precompute");
    const prev = await rememberedTrips(p).catch(() => [] as Trip[]);
    const rs = await Promise.all(prev.map((t) => recheckTrip(t, 1, 15_000).then((r) => ({ t, r })).catch(() => null)));
    for (const x of rs) {
      if (!x || x.r.newTotal === null || signal?.aborted) continue;
      const legs = x.t.legs.map((l, i) => { const c = x.r.legs.find((y) => y.index === i); return c && c.now !== null ? { ...l, price: c.now } : l; });
      accept({ ...x.t, id: `mem-${x.t.id}`, legs, price: Math.round(x.r.newTotal),
        flags: ["zapamiętana trasa – cena sprawdzona teraz", ...x.t.flags.filter((f) => !f.startsWith("ceny z nocnego") && !f.startsWith("zapamiętana"))] });
    }
  }
  /** Stage 1: the cheapest few paths of the price map per direction, checked live at once. */
  async function quickMap(go: Graph, gr: Graph | null) {
    const K = 4;
    const take = async (g: Graph, from: string[], to: Set<string>) => {
      const e = new PathEnumerator(g, from, to, p.maxLegs, () => Infinity, 200_000, 100_000);
      e.deadline = t0 + STAGE1_MS;
      const out: Path[] = [];
      while (out.length < K) { const x = await e.next(); if (!x) break; out.push(x); }
      return out;
    };
    const check = async (path: Path, dir: "out" | "ret") => {
      const [a, b] = dir === "out" ? [outFrom, outTo] : [retFrom, retTo];
      const r = await verifyPath(path, a, b, { params: p, meter, threshold: () => Infinity, signal, legMins: new Map() }).catch(() => null);
      return r?.status === "ok" ? r.itineraries : [];
    };
    const [po, pr] = await Promise.all([take(go, p.origin, destSet), gr ? take(gr, retDest, originSet) : Promise.resolve([] as Path[])]);
    const [oi, ri] = await Promise.all([Promise.all(po.map((x) => check(x, "out"))), Promise.all(pr.map((x) => check(x, "ret")))]);
    const outs = oi.flat().sort((a, b) => a.price - b.price).slice(0, 20), rets = ri.flat().sort((a, b) => a.price - b.price).slice(0, 20);
    if (p.oneWay) { outs.slice(0, 2).forEach((o, k) => accept(makeTrip(`quick-map-${k}`, o, null, o.price, "azymut"))); return; }
    const pairs: [Itinerary, Itinerary][] = [];
    for (const o of outs) for (const r of rets) {
      const stay = stayOf(o, r);
      if (r.firstDep > o.lastArr && stay >= p.stayMin && stay <= p.stayMax) pairs.push([o, r]);
    }
    pairs.sort((a, b) => a[0].price + a[1].price - b[0].price - b[1].price).slice(0, 2)
      .forEach(([o, r], k) => accept(makeTrip(`quick-map-${k}`, o, r, o.price + r.price, "azymut")));
  }

  // Stage 1, the quick answer (at most STAGE1_MS): Kiwi's ready trips, the Google price for their dates,
  // remembered trips and the cheapest map paths, all checked live at once. Whatever is still running then
  // finishes in the background and feeds stage 2, which starts from this price as its upper bound.
  // the Google price as soon as Kiwi's ready trips give it their dates
  const quickBase = kiwiFirst.catch(() => {}).then(() => runBaseline("quick")).catch(() => {});
  // the map candidates after the Google price (Google requests are paced one after another; its few result
  // pages must not queue behind the map candidates' calendar checks)
  const stage1 = Promise.allSettled([kiwiTask, quickBase, recheckRemembered(),
    Promise.all([graphTask, quickBase]).then(([g]) => quickMap(g.gOut.graph, g.gRet?.graph ?? null))]);
  let stage1Timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([stage1, new Promise<void>((r) => { stage1Timer = setTimeout(r, Math.max(0, t0 + STAGE1_MS - Date.now())); })]);
  clearTimeout(stage1Timer);
  if (phase === "quick" && Number.isFinite(best)) prelim = { price: best, sec: Math.round((Date.now() - t0) / 1000) };
  phase = "full";
  emitEarly();

  const { gOut, gRet } = await graphTask;
  await kiwiTask.catch(() => {});
  const [kOut, kRet] = await kiwiAll.catch(() => [null, null, null] as const);
  const meta = await db.meta();
  emit("meta", { edges: meta.edges, backend: meta.backend, newest: meta.newest, sources: { serpapi: hasSerp(), duffel: hasDuffel(), llm: !!config.keys.anthropic, google: true, kiwi: true, flixbus: true } });
  if (gOut.stale) notes.push("Mapa cen jest starsza niż 3 dni.");
  // the full Google comparison (date graph, every airport) runs alongside stage 2; awaited before the end
  const fullBase = quickBase.then(() => runBaseline("full")).catch(() => {});

  // 1b) a region: every destination city gets its own queries (an even share of the budget), so the
  // list shows the best trip to each one, not twenty variants to the city cheapest on the map
  const swept = new Set<string>();
  let sideLanes: Promise<void> = Promise.resolve();
  if (cities.size >= REGION_MIN_CITIES && !openJaw) {
    emit("status", { phase: "region", message: `Każde miasto regionu osobno: ${cities.size} kierunków` });
    const perFrom = (list: KItin[], end: (it: KItin) => string) => {
      const c = new Map<string, number>();
      return list.filter(knownKiwi).filter((it) => { const k = end(it); const v = c.get(k) ?? 0; c.set(k, v + 1); return v < 2; }).slice(0, 6);
    };
    // many countries (a continent, "gdziekolwiek"): first a shallow pass, one Kiwi query per country
    // for its cheapest round trips (or one-ways out), all countries side by side within Kiwi's pool.
    // Every country gets its cheapest cities on the list within a minute or two; a fast search then
    // skips the slow city-by-city sweep (a deep one still does it)
    const byCc = new Map<string, string[]>();
    for (const [, codes] of cities) { const cc = AP[codes[0]]?.cc ?? "?"; byCc.set(cc, [...(byCc.get(cc) ?? []), ...codes]); }
    const countrySweep = byCc.size >= 4;
    // the nightly "gdziekolwiek tanio" list: full-engine trips from home for these dates, a ready start
    {
      const { nightlyTrips } = await import("./anywhere-cheap");
      const night = await nightlyTrips(p, outFrom, outTo, [p.home ?? "", ...homeAirports]).catch(() => [] as Trip[]);
      for (const t of night) accept(t);
      if (night.length) notes.push(`Nocna lista „Gdziekolwiek tanio”: ${night.length} tras na start (ceny sprawdzone dziś w nocy, potwierdź przed rezerwacją).`);
    }
    if (countrySweep) {
      let doneCc = 0;
      emit("status", { phase: "region", message: `Szybki przegląd: najtańsze loty do każdego kraju (${byCc.size} krajów)` });
      const big = (c: string) => (isCore(c) ? 0 : ({ L: 1, M: 2, S: 3 } as Record<string, number>)[AP[c]?.size ?? "S"]);
      await Promise.all([...byCc].map(async ([cc, all]) => {
        const codes = [...all].sort((a, b) => big(a) - big(b)).slice(0, 25);
        if (signal?.aborted || Date.now() > grace(0)) return;
        const perCity = new Map<string, number>();
        const fresh = (to: string) => { const c = cityKey(to); const n = perCity.get(c) ?? 0; perCity.set(c, n + 1); return n < 1; };
        if (!p.oneWay) {
          const rts = await kiwiReturn(rtFromAll, codes, outFrom, outTo, retFrom, retTo, meter, checked).catch(() => null);
          // cheapest first; one trip per city (the bus there and back included), at most 5 cities
          let tries = 0;
          for (const [k, it] of (rts ?? []).filter((x) => knownKiwi({ segs: [...x.out, ...x.ret] })).entries()) {
            const c = cityKey(it.out[it.out.length - 1].to);
            if (perCity.has(c)) continue;
            if (perCity.size >= 5 || ++tries > 12) break;
            const t = await rtTrip(`kiwi-cc-${cc}-${k}`, it);
            if (t && fresh(it.out[it.out.length - 1].to)) accept(t);
          }
          // far countries: separate one-way tickets there and back (see oneWayPair)
          if (far(codes)) {
            const t = await oneWayPair(`kiwi-ccow-${cc}`, codes);
            if (t) { perCity.set(cityKey(tripDest(t)), 1); accept(t); }
          }
        } else {
          const outs = await kiwiOneWay(rtFromAll, codes, outFrom, outTo, KIWI_MAX, meter, checked).catch(() => null);
          for (const [k, it] of (outs ?? []).filter(knownKiwi).entries()) {
            if (it.segs.length > p.maxLegs * 2 || !fresh(it.segs[it.segs.length - 1].to) || perCity.size > 4) continue;
            const o = await withBus(itineraryFromKiwi(it.segs, it.price, it.link), "out");
            if (o) accept(makeTrip(`kiwi-cc-${cc}-${k}`, o, null, o.price, "kiwi"));
          }
        }
        for (const [city, cs] of cities) if (cs.some((c) => AP[c]?.cc === cc) && perCity.has(city)) swept.add(city);
        emit("status", { phase: "region", message: `Szybki przegląd: ${++doneCc}/${byCc.size} krajów` });
      }));
    }
    let ci = 0;
    // core and large airports first; a fast search sweeps at most REGION_SWEEP cities (the rest still
    // come through the map search), a deep one sweeps them all
    const prio = (codes: string[]) => Math.min(...codes.map((c) => (isCore(c) ? 0 : ({ L: 1, M: 2, S: 3 } as Record<string, number>)[AP[c]?.size ?? "S"])));
    // after the country pass (fast search): the cities with the cheapest trips so far go deeper first
    // (separate tickets out and back, with the bus from home), several side by side
    const cityBest = (city: string) => Math.min(...[...found.values()].filter((t) => cityKey(tripDest(t)) === city).map((t) => t.price));
    const sweepList = countrySweep && !deep
      ? [...cities].filter(([c]) => Number.isFinite(cityBest(c))).sort((a, b) => cityBest(a[0]) - cityBest(b[0])).slice(0, REGION_DEEPEN)
      : [...cities].sort((a, b) => prio(a[1]) - prio(b[1])).slice(0, deep ? Infinity : REGION_SWEEP);
    const sweepEnd = countrySweep && !deep ? grace(0) - (grace(0) - Date.now()) / 2 : grace(0); // half the time left stays for the rest
    const sweepCity = async ([city, codes]: [string, string[]]) => {
      if (signal?.aborted || Date.now() > sweepEnd) return;
      emit("status", { phase: "region", message: `Kierunek ${++ci}/${sweepList.length}: ${AP[codes[0]]?.city ?? city}` });
      const before = [...found.values()].filter((t) => cityKey(tripDest(t)) === city).length;
      // Kiwi's own return combinations from the biggest departure airports
      if (!p.oneWay) {
        const rts = await kiwiReturn(rtFromAll, codes, outFrom, outTo, retFrom, retTo, meter, checked).catch(() => null);
        let n = 0;
        for (const [k, it] of (rts ?? []).filter((x) => knownKiwi({ segs: [...x.out, ...x.ret] })).slice(0, 10).entries()) {
          const t = await rtTrip(`kiwi-rt-${city}-${k}`, it);
          if (t) accept(t);
          if (t && ++n >= 2) break;
        }
      }
      // separate one-way tickets from every departure airport (with the bus from home) and back
      const outs = await kiwiOneWay(homeAirports, codes, outFrom, outTo, KIWI_MAX, meter, checked).catch(() => null);
      const rets = p.oneWay ? null : await kiwiOneWay(codes, homeAirports, retFrom, retTo, KIWI_MAX, meter, checked).catch(() => null);
      const oIts: Itinerary[] = [], rIts: Itinerary[] = [];
      for (const it of perFrom((outs ?? []).filter((x) => x.segs.length <= p.maxLegs * 2), (x) => x.segs[0].from)) { const b = await withBus(itineraryFromKiwi(it.segs, it.price, it.link), "out"); if (b) oIts.push(b); }
      for (const it of perFrom((rets ?? []).filter((x) => x.segs.length <= p.maxLegs * 2), (x) => x.segs[x.segs.length - 1].to)) { const b = await withBus(itineraryFromKiwi(it.segs, it.price, it.link), "ret"); if (b) rIts.push(b); }
      if (p.oneWay) oIts.slice(0, 2).forEach((o, k) => accept(makeTrip(`region-${city}-${k}`, o, null, o.price, "kiwi")));
      else {
        const pairs: [Itinerary, Itinerary][] = [];
        for (const o of oIts) for (const r of rIts) {
          const stay = stayOf(o, r);
          if (r.firstDep > o.lastArr && stay >= p.stayMin && stay <= p.stayMax) pairs.push([o, r]);
        }
        pairs.sort((a, b) => a[0].price + a[1].price - b[0].price - b[1].price).slice(0, 2)
          .forEach(([o, r], k) => accept(makeTrip(`region-${city}-${k}`, o, r, o.price + r.price, "kiwi")));
      }
      swept.add(city);
      if (process.env.AZ_DEBUG) console.log("REGION", city, "rt/ow trips", [...found.values()].filter((t) => cityKey(tripDest(t)) === city).length - before);
    };
    const lanes = countrySweep && !deep ? 3 : 1;
    let next = 0;
    await Promise.all(Array.from({ length: lanes }, async () => { while (next < sweepList.length) await sweepCity(sweepList[next++]); }));
    // one or a few countries (Polska → Chiny): the separate one-ways per far country too
    if (!countrySweep && !p.oneWay) {
      const big = (c: string) => (isCore(c) ? 0 : ({ L: 1, M: 2, S: 3 } as Record<string, number>)[AP[c]?.size ?? "S"]);
      // Google for every country (Russia is near but not on Kiwi), the split tickets for far ones
      await Promise.all([...byCc].map(async ([cc, all]) => {
        if (signal?.aborted || Date.now() > grace(0)) return;
        const codes = [...all].sort((a, b) => big(a) - big(b)).slice(0, 25);
        const lanes = far(codes) ? [oneWayPair(`kiwi-ow2-${cc}`, codes), hubSplit(`hub-split-${cc}`, codes)] : [];
        for (const t of await Promise.all([...lanes, googleLane(`google-${cc}`, codes), ruLane(`ru-${cc}`, codes), ruHubLane(`ru-hub-${cc}`, codes)])) if (t) accept(t);
        if (!p.oneWay) for (const t of await kayakLane(`kayak-${cc}`, codes)) accept(t);
      }));
    }
    // many countries: Google only for those Kiwi left without any trip (Russia, Belarus…)
    if (countrySweep && !p.oneWay) {
      const have = new Set([...found.values()].map((t) => AP[tripDest(t)]?.cc));
      const big = (c: string) => (isCore(c) ? 0 : ({ L: 1, M: 2, S: 3 } as Record<string, number>)[AP[c]?.size ?? "S"]);
      await Promise.all([...byCc].filter(([cc]) => !have.has(cc)).slice(0, 6).map(async ([cc, all]) => {
        if (signal?.aborted || Date.now() > grace(0)) return;
        const codes = [...all].sort((a, b) => big(a) - big(b));
        for (const t of await Promise.all([googleLane(`google-${cc}`, codes), ruLane(`ru-${cc}`, codes), ruHubLane(`ru-hub-${cc}`, codes)])) if (t) accept(t);
      }));
      // Kayak's map: the countries where it knows a round trip at least 5% below what was found, checked again
      const bestCc = new Map<string, number>();
      for (const t of found.values()) { const cc = AP[tripDest(t)]?.cc; if (cc && t.price < (bestCc.get(cc) ?? Infinity)) bestCc.set(cc, t.price); }
      const hints = await kayakHints();
      const cheaper = [...byCc].filter(([cc]) => hints.some((h) => AP[h.to].cc === cc && h.price < 0.95 * (bestCc.get(cc) ?? Infinity))).slice(0, 10);
      await Promise.all(cheaper.map(async ([cc, all]) => {
        if (signal?.aborted || Date.now() > grace(0)) return;
        for (const t of await kayakLane(`kayak-${cc}`, [...all], 0.95 * (bestCc.get(cc) ?? Infinity))) accept(t);
      }));
    }
  } else if (!openJaw && !p.oneWay) {
    // a single city: Google's own fares, and for a far one (Seul) the separate one-ways there and back.
    // They run beside the map search below (Google answers one request at a time: Mineralnye Wody took
    // ~8 min of a 10 min search while everything else waited); each trip is accepted as it comes
    const codes = p.dest.slice(0, 30);
    const lanes = far(p.dest) ? [oneWayPair("kiwi-ow2", codes), hubSplit("hub-split", codes)] : [];
    // Russia first: its lane needs Google's Moscow flights before the general Google lane fills the queue
    const one = (pr: Promise<Trip | null>) => pr.then((t) => { if (t) accept(t); }).catch(() => {});
    sideLanes = Promise.all([one(ruLane("ru", codes)), one(ruHubLane("ru-hub", codes)), ...lanes.map(one), one(googleLane("google", codes)),
      kayakLane("kayak", codes).then((ts) => ts.forEach(accept)).catch(() => {})]).then(() => {});
  }


  // Long-haul arcs: one Kiwi query per hub prices every day of the window, which replaces the
  // optimistic distance-based bound by the exact minimum (or removes the arc when nothing flies).
  const preOptions = { out: new Map<string, FlightOption[]>(), ret: new Map<string, FlightOption[]>() };
  // Verified per-arc minima are written straight into the graph too, so the A* stops generating
  // paths through arcs already known to be expensive or dead (no churn of pop-then-prune).
  class ArcBounds extends Map<string, number> {
    constructor(private g: () => Graph | null) { super(); }
    set(key: string, v: number) {
      super.set(key, v);
      const arc = this.g()?.get(key.slice(0, 3))?.find((a) => a.kind === "flight" && a.to === key.slice(3, 6));
      if (arc && v > arc.lb) arc.lb = v;
      return this;
    }
  }
  const legMins = { out: new ArcBounds(() => gOut.graph), ret: new ArcBounds(() => gRet?.graph ?? null) };
  /**
   * Apply one multi-airport Kiwi answer to a set of arcs. Results are sorted by price, so the first
   * hit per pair is that pair's exact minimum, and a full answer (KIWI_MAX rows) bounds every pair
   * it does not contain by its last price. Only a short answer proves "nothing flies".
   */
  function applyKiwi(dir: "out" | "ret", g: Graph, its: KItin[], pairs: [string, string][], completeOptions: boolean) {
    const full = its.length >= KIWI_MAX;
    const floor = full ? its[its.length - 1].price : Infinity;
    for (const [from, to] of pairs) {
      const opts = kiwiToOptions(its, from, to);
      const key = from + to;
      const lb = opts.length ? Math.min(...opts.map((o) => o.price)) : floor;
      legMins[dir].set(key, Math.max(legMins[dir].get(key) ?? 0, lb));
      if (completeOptions && !full) preOptions[dir].set(key, opts);
      const arc = g.get(from)?.find((x) => x.kind === "flight" && x.to === to);
      if (arc) { arc.lb = Math.max(arc.lb, lb); if (!arc.sources.includes("kiwi")) arc.sources.push("kiwi"); }
    }
  }
  // Long-haul arcs: a few multi-airport Kiwi queries replace the distance-based bounds of every
  // intercontinental arc by exact minima (or by the answer's price floor).
  async function tightenLongHaul(g: Graph, dir: "out" | "ret") {
    const [w0, w1] = dir === "out" ? legWindow(outFrom, outTo, p.maxLegs, p.stopoverDays) : legWindow(retFrom, retTo, p.maxLegs, p.stopoverDays);
    const reach = dijkstra(g, p.origin, dir === "ret");
    const far: [string, string][] = [];
    for (const [from, arcs] of g) for (const a of arcs) {
      if (a.kind === "flight" && km(AP[from], AP[a.to]) > 2500 && Number.isFinite(reach.get(dir === "out" ? from : a.to) ?? Infinity)) far.push([from, a.to]);
    }
    const ends = dir === "out" ? destSet : retSet;
    const touchesEnd = (x: [string, string]) => (dir === "out" ? ends.has(x[1]) : ends.has(x[0]));
    // Separate answers per direction group give tighter price floors (a floor only covers its group).
    const eur = (c: string) => AP[c].region === "EUR";
    const rest = far.filter((x) => !touchesEnd(x));
    const groups = [
      far.filter(touchesEnd),
      rest.filter(([a, b]) => eur(a) && !eur(b)),
      rest.filter(([a, b]) => !eur(a) && eur(b)),
      rest.filter(([a, b]) => !eur(a) && !eur(b)),
    ];
    for (const pairs of groups) {
      if (!pairs.length || signal?.aborted) continue;
      const rank = (c: string) => reach.get(c) ?? Infinity;
      // Kiwi answers many departure airports in groups of 4 (see kiwiOneWay), so 12 at most (3 calls):
      // the 8 cheapest to reach plus up to 4 low-cost long-haul hubs, which always make the cut.
      // Arcs from airports left out keep their distance bound (weaker, still valid).
      const allFroms = [...new Set(pairs.map((x) => x[0]))].sort((x, y) => rank(x) - rank(y));
      const froms = [...new Set([...allFroms.slice(0, D(8, 20)), ...allFroms.filter((c) => config.lowcostHubs.includes(c)).slice(0, D(4, 13))])];
      const tos = [...new Set(pairs.map((x) => x[1]))].sort((x, y) => rank(x) - rank(y)).slice(0, D(40, 80));
      const its = await kiwiOneWay(froms, tos, w0, w1, KIWI_MAX, meter, checked);
      if (!its) continue;
      applyKiwi(dir, g, its, pairs.filter(([f, t]) => froms.includes(f) && tos.includes(t)), false);
    }
    for (const [from, arcs] of g) g.set(from, arcs.filter((a) => Number.isFinite(a.lb)));
  }
  emit("status", { phase: "longhaul", message: "Wyceniam odcinki długodystansowe na całe okno dat (Kiwi)" });
  await tightenLongHaul(gOut.graph, "out");
  if (gRet) await tightenLongHaul(gRet.graph, "ret");

  // Lower bound of each direction's cheapest possible cost (updated every iteration).
  const cheapest = { out: 0, ret: 0 };
  // deep: 4M states per direction (~200 MB each in typed arrays); fast keeps the 1.5M step-replay cap
  // the worker may double it once when a round hits it (capScale 2: ~1.6 GB for both directions)
  const cap = D(1_500_000, 4_000_000) * (opts.capScale ?? 1);
  const outE = new PathEnumerator(gOut.graph, p.origin, destSet, p.maxLegs, () => best - cheapest.ret, cap * 4, cap);
  const retE = gRet ? new PathEnumerator(gRet.graph, retDest, originSet, p.maxLegs, () => best - cheapest.out, cap * 4, cap) : null;
  const outS = new Stream(outE, []);
  const retS = gRet ? new Stream(retE, []) : null;
  const queues = { out: new DirQueue(outS), ret: retS ? new DirQueue(retS) : null };

  emit("status", { phase: "search", message: "Branch and bound: sprawdzam trasy od najtańszej dolnej granicy" });

  const deadArcs = new Set<string>();
  const windowed = { out: new Set<string>(), ret: new Set<string>() };
  async function prefetch(dir: "out" | "ret", from: string) {
    if (windowed[dir].has(from) || !nets.fr.has(from) || !meter.canFree()) return;
    windowed[dir].add(from);
    const [a, b] = dir === "out" ? legWindow(outFrom, outTo, p.maxLegs, p.stopoverDays) : legWindow(retFrom, retTo, p.maxLegs, p.stopoverDays);
    const fares = await ryanairMap(from, a, b, meter).catch(() => null);
    if (!fares) return;
    const fee = checked ? config.bagFee.ryanair : 0;
    const byTo = new Map(fares.map((f) => [f.to, Math.round(f.price) + fee]));
    const g = (dir === "out" ? gOut : gRet!).graph;
    for (const arc of g.get(from) ?? []) {
      if (arc.kind !== "flight" || arc.sources.length !== 1 || arc.sources[0] !== "ryanair") continue;
      const key = from + arc.to;
      legMins[dir].set(key, Math.max(legMins[dir].get(key) ?? 0, byTo.get(arc.to) ?? Infinity));
    }
  }
  const batched = { out: new Set<string>(), ret: new Set<string>() };
  async function batch(dir: "out" | "ret", from: string) {
    if (batched[dir].has(from)) return;
    batched[dir].add(from);
    const g = (dir === "out" ? gOut : gRet!).graph;
    const [w0, w1] = dir === "out" ? legWindow(outFrom, outTo, p.maxLegs, p.stopoverDays) : legWindow(retFrom, retTo, p.maxLegs, p.stopoverDays);
    // all flight arcs, low-cost ones included: Kiwi carries Ryanair/Wizz too, and one answer bounds
    // up to 25 routes, which spares most per-route calendar calls
    const targets = (g.get(from) ?? []).filter((a) => a.kind === "flight" && !preOptions[dir].has(from + a.to))
      .sort((a, b) => a.lb - b.lb).map((a) => a.to);
    for (let k = 0; k < targets.length && k < D(50, 100); k += 25) {
      const chunk = targets.slice(k, k + 25);
      const its = await kiwiOneWay([from], chunk, w0, w1, KIWI_MAX, meter, checked);
      if (!its) return;
      applyKiwi(dir, g, its, chunk.map((t) => [from, t] as [string, string]), true);
    }
  }
  let checkedCount = 0, pruned = 0, unverified = 0;
  let stopLb = Infinity;
  let exhausted = false;
  let outOfMemory = false;
  let paused = false;

  /** Every destination city of a region: checked or not, and its cheapest trip so far. */
  const regionDest = (): DestStat[] | undefined => cities.size >= REGION_MIN_CITIES ? [...cities].map(([city, codes]) => {
    const mine = [...found.values()].filter((t) => Number.isFinite(t.price) && cityKey(tripDest(t)) === city);
    return { code: codes[0], city: AP[codes[0]]?.city ?? city, checked: swept.has(city) || mine.length > 0, best: mine.length ? Math.min(...mine.map((t) => t.price)) : null };
  }).sort((a, b) => (a.best ?? Infinity) - (b.best ?? Infinity)) : undefined;
  const progress = () => ({ pct: Math.round(prog.pct * 10) / 10, etaSec: eta(), combos: checkedCount + pruned + found.size });
  const stats = () => ({ ...meter.snapshot(), phase, prelim: prelim ?? undefined, oneTicket: oneTicketBest ?? undefined, checked: checkedCount + found.size, pruned, best: Number.isFinite(best) ? best : null, destinations: regionDest(),
    progress: progress(), baselineStatus: baselineStatus ?? undefined, ticketWins, baselineNow: baseline ?? undefined });
  let lastStats = 0;
  const emitStats = (force = false) => {
    if (!force && Date.now() - lastStats < 250) return;
    lastStats = Date.now();
    emit("stats", stats());
  };
  emitStats(true);

  async function verify(path: Path, dir: "out" | "ret"): Promise<VerifyResult> {
    const key = dir + path.id;
    const cached = verified.get(key);
    if (cached) return cached;
    const [a, b] = dir === "out" ? [outFrom, outTo] : [retFrom, retTo];
    const other = dir === "out" ? cheapest.ret : cheapest.out;
    const r = await verifyPath(path, a, b, { params: p, meter, threshold: () => best - other, signal, legMins: legMins[dir], prefetch: (from) => prefetch(dir, from), preOptions: preOptions[dir], batch: (from) => batch(dir, from) },
      (from, to, state) => emit("leg", { from, to, state }));
    if (r.status === "infeasible" && r.deadArc) deadArcs.add(r.deadArc);
    if (r.status === "infeasible" && r.unverified) unverified++;
    // a pruned result is only a bound: the path goes back to the queue with it, and checking it again costs
    // no query (the per-arc minima decide). Millions of them must not stay in memory.
    if (r.status !== "pruned") verified.set(key, r);
    // dead ends are cheap to find again (their dead arcs are known): the oldest go when the map grows large
    if (verified.size > 300_000) {
      let n = 0;
      for (const [k, v] of verified) { if (v.status !== "ok" && !k.includes("kiwi-")) { verified.delete(k); if (++n >= 100_000) break; } }
    }
    return r;
  }

  // Path lower bound tightened by everything verified so far (per-arc minima, per-path results).
  const refined = (path: Path | null, dir: "out" | "ret") => {
    if (!path) return 0;
    const r = verified.get(dir + path.id);
    if (r?.status === "ok") return Math.max(path.lb, r.minPrice);
    if (r?.status === "infeasible") return Infinity;
    let arcSum = 0;
    path.arcs.forEach((a, i) => { arcSum += Math.max(a.lb, legMins[dir].get(path.nodes[i] + path.nodes[i + 1]) ?? 0); });
    return Math.max(arcSum, r?.status === "pruned" ? r.bound : 0);
  };
  const hasDead = (path: Path) => path.arcs.some((a, i) => deadArcs.has(path.nodes[i] + path.nodes[i + 1]) && a.kind === "flight");

  // Two-queue branch and bound. A new trip needs an unverified path in at least one direction, so
  //   bound = min(top_out + cheapest_ret, top_ret + cheapest_out)
  // where cheapest_x = min(top_x, cheapest verified itinerary in x). Stop when bound >= best.
  const done = { out: [] as { path: Path; its: Itinerary[] }[], ret: [] as { path: Path; its: Itinerary[] }[] };
  const minVerified = { out: Infinity, ret: Infinity };
  function combine(dir: "out" | "ret", path: Path, its: Itinerary[]) {
    if (!queues.ret) {
      accept(makeTrip(path.id, its[0], null, its[0].price, path.id.startsWith("kiwi") ? "kiwi" : "azymut"));
      return;
    }
    for (const other of done[dir === "out" ? "ret" : "out"]) {
      const [op, rp] = dir === "out" ? [path, other.path] : [other.path, path];
      const [oi, ri] = dir === "out" ? [its, other.its] : [other.its, its];
      let pick: { o: Itinerary; r: Itinerary; price: number } | null = null;
      for (const o of oi) for (const r of ri) {
        if (pick && o.price + r.price >= pick.price) continue;
        const stay = stayOf(o, r);
        if (stay < p.stayMin || stay > p.stayMax || r.firstDep < o.lastArr + 6 * HOUR) continue;
        pick = { o, r, price: o.price + r.price };
      }
      if (!pick) continue;
      const origin = op.id.startsWith("kiwi") && rp.id.startsWith("kiwi") ? "kiwi" : "azymut";
      accept(makeTrip(op.id + "|" + rp.id, pick.o, pick.r, op.lb + rp.lb, origin));
    }
  }

  const destRegions = new Set([...p.dest, ...retDest].map((d) => AP[d]?.region));
  // Route memory: the best routes of earlier similar searches, re-verified live on this window first
  const memIds = new Set<string>();
  const memPaths = { out: [] as Path[], ret: [] as Path[] };
  {
    const pathOf = (g: Graph, m: { nodes: string[]; kinds: string }): Path | null => {
      const arcs = [];
      for (let i = 0; i < m.nodes.length - 1; i++) {
        const arc = g.get(m.nodes[i])?.find((a) => a.to === m.nodes[i + 1] && (a.kind === "flight") === (m.kinds[i] === "f"));
        if (!arc) return null;
        arcs.push(arc);
      }
      return { id: m.nodes.join("-") + ":" + m.kinds, nodes: m.nodes, arcs, lb: arcs.reduce((s, a) => s + a.lb, 0), flights: m.kinds.split("").filter((k) => k === "f").length };
    };
    for (const m of await recallTrips(p, outMonths, 6).catch(() => [])) {
      if (signal?.aborted || Date.now() > deadline) break;
      const op = pathOf(gOut.graph, m.out), rp = m.ret && gRet ? pathOf(gRet.graph, m.ret) : null;
      if (!op || (!p.oneWay && !rp)) continue;
      for (const [dir, path] of [["out", op], ["ret", rp]] as const) {
        if (!path || memPaths[dir].some((x) => x.id === path.id)) continue;
        const r = await verify(path, dir);
        if (r.status === "ok") { memPaths[dir].push(path); memIds.add(path.id); }
      }
    }
    if (memIds.size) notes.push(`Pamięć tras: ${memIds.size} odcinków z wcześniejszych podobnych wyszukiwań sprawdzonych na żywo jako punkt startu.`);
  }

  // The strategist: unusual hub sequences (odd hubs, positioning flights, low-cost chains across
  // continents, open-jaw + ground) become concrete map paths, verified live first. More each deep round.
  const hypoPaths = { out: [] as Path[], ret: [] as Path[] };
  const hypoOf = new Map<string, Hypothesis>(); // path id -> hypothesis
  const hypos: (HypoOutcome & { paths: string[] })[] = [];
  {
    emit("status", { phase: "strategist", message: "Strateg: sprawdzam nietypowe huby i loty pozycjonujące" });
    const ctx = { g: gOut.graph, origin: p.origin, dest: p.dest, departs: homeAirports, fromHome: dijkstra(gOut.graph, p.origin, false), toDest: dijkstra(gOut.graph, p.dest, true) };
    const limit = deep ? 12 + 6 * Math.max(0, (opts.round ?? 1) - 1) : 4;
    // a time budget per round: verification of odd paths is slow (many legs, paced sources), and the
    // branch and bound needs the rest of the round; hypotheses not reached come first next round
    const until = Math.min(deadline - 30_000, Date.now() + D(30_000, 4 * 60_000));
    for (const h of await propose(ctx, limit).catch(() => [] as Hypothesis[])) {
      if (signal?.aborted || Date.now() > until) break;
      const out: HypoOutcome & { paths: string[] } = { ...h, lb: null, price: null, won: false, status: "nopath", paths: [] };
      hypos.push(out);
      const dirs = p.oneWay || !gRet ? (["out"] as const) : (["out", "ret"] as const);
      // a hypothesis is its hubs plus short feeders: at most 3 flights more than hubs (fast to verify)
      const hypoLegs = Math.min(p.maxLegs, h.via.length + 3);
      for (const dir of dirs) {
        const path = dir === "out"
          ? await pathThrough(gOut.graph, p.origin, p.dest, h.via, hypoLegs)
          : await pathThrough(gRet!.graph, retDest, p.origin, [...h.via].reverse(), hypoLegs);
        if (!path) continue;
        out.lb = (out.lb ?? 0) + path.lb;
        if (path.lb >= best) { if (out.status === "nopath") out.status = "bound"; continue; } // cannot beat the incumbent: no query spent
        const r = await verify(path, dir);
        if (r.status !== "ok") { if (out.status !== "ok") out.status = r.status === "pruned" ? "bound" : "dead"; continue; }
        out.status = "ok";
        hypoPaths[dir].push(path);
        hypoOf.set(path.id, h);
        out.paths.push(path.id);
      }
    }
    const tried = hypos.filter((h) => h.status !== "nopath").length;
    if (hypos.length) notes.push(`Strateg: ${hypos.length} hipotez (${tried} z trasą na mapie, ${hypos.filter((h) => h.status === "ok").length} potwierdzonych na żywo).`);
  }

  // Round-trip tickets between a European hub H and a gateway G on the other side (G is the
  // destination itself, or e.g. BOG/PTY/IST/DXB with a separate ticket onwards), plus separate
  // feeders from home. They are a third branch-and-bound queue, so the proof covers them too:
  //   bound(H,G) = cheapest RT fare H<->G in the window + cheapest way home->H and H->home + tails.
  // The RT minimum comes from Google's date grid (every departure day x every trip length). Pairs
  // not queried yet are bounded by the assumption "a round trip costs at least the cheapest one-way
  // on that route"; a pair is queried as soon as that bound is the lowest one left.
  // gateways on the other side: a fixed core plus the hubs the radar ranks daily for these regions
  // (cheapest way there from Poland + cheapest flight on into the region, from the map)
  const FAR_HUBS = new Set([..."BOG PTY SDQ CUN MEX GRU EZE SCL MIA FLL JFK EWR LIM UIO MDE SJO HAV PUJ IST SAW DXB AUH SHJ DOH MCT TAS ALA KUT EVN GYD DEL BOM CMB KUL SIN BKK DMK CAI RAK CMN MNL".split(" "),
    ...config.lowcostHubs.filter((h) => AP[h] && AP[h].region !== "EUR"), ...[...destRegions].flatMap((r) => config.splitHubs[r] ?? []),
    ...(await hubsFor(p.dest).catch(() => [])).filter((h) => AP[h] && AP[h].region !== "EUR")]);
  const hotelAt = (ap: string) => (p.countHotel === false ? 0 : config.hotelByRegion[AP[ap].region] ?? 220);
  async function realizeRt(h: string, g: string, od: string, rd: string): Promise<boolean> {
    const rt = await googleRoundTrip([h], [g], od, rd, meter);
    if (!rt) return false;
    const [rw0, rw1] = legWindow(retFrom, retTo, 2);
    const retIts = preOptions.ret.get(g + h) ?? kiwiToOptions((await kiwiOneWay([g], [h], rw0, rw1, KIWI_MAX, meter, checked)) ?? [], g, h);
      const dep = localToUtc(rt.outbound.depLocal, AP[h].tz), arr = localToUtc(rt.outbound.arrLocal, AP[g].tz);
      // return flight times: the matching one-way on that day (same airline when possible)
      const retDay = retIts.filter((o) => utcToLocal(o.dep, AP[g].tz).startsWith(rd));
      const sameAirline = (o: FlightOption) => rt.outbound.carriers.split(" + ").some((c) => o.carrier.includes(c));
      let back = retDay.find(sameAirline);
      if (!back) back = (await googleOneWay(g, h, rd, meter))?.find(sameAirline);
      if (!back) { // Google throttled or silent: Kiwi's flights that day
        const day = kiwiToOptions((await kiwiOneWay([g], [h], rd, rd, KIWI_MAX, meter, checked)) ?? [], g, h);
        back = day.find(sameAirline) ?? day.sort((a, b) => a.price - b.price)[0];
      }
      if (!back) back = retDay.sort((a, b) => a.price - b.price)[0];
      if (!back) { if (process.env.AZ_DEBUG) console.log("HUB no return flight", h, g, rd); return false; }
      // onward tails G -> destination and back, on separate (often low-cost) tickets
      let tailOut: Leg | null = null, tailRet: Leg | null = null;
      // open-jaw: the outbound tail exists when G is not a destination, the return tail when G is
      // not a return airport (each side on its own)
      if (!destSet.has(g) || !retSet.has(g)) {
        const arrDay = utcToLocal(arr, AP[g].tz).slice(0, 10);
        const to = destSet.has(g) ? null : await kiwiOneWay([g], p.dest.slice(0, 20), arrDay, addDays(arrDay, 1), KIWI_MAX, meter, checked);
        const cost = (o: FlightOption) => o.price + (overnightAt(arr, o.dep, g) ? hotelAt(g) : 0);
        for (const o of p.dest.flatMap((d) => kiwiToOptions(to ?? [], g, d))) {
          if (o.dep >= arr + p.minConnSameH * HOUR && o.dep - arr < 30 * HOUR && (!tailOut || cost(o) < cost(tailOut))) tailOut = o;
        }
        const backDay = utcToLocal(back.dep, AP[g].tz).slice(0, 10);
        const tr = retSet.has(g) ? null : await kiwiOneWay(retDest.slice(0, 20), [g], addDays(backDay, -1), backDay, KIWI_MAX, meter, checked);
        const costR = (o: FlightOption) => o.price + (overnightAt(o.arr, back!.dep, g) ? hotelAt(g) : 0);
        for (const o of retDest.flatMap((d) => kiwiToOptions(tr ?? [], d, g))) {
          if (o.arr + p.minConnSameH * HOUR <= back.dep && back.dep - o.arr < 30 * HOUR && (!tailRet || costR(o) < costR(tailRet))) tailRet = o;
        }
        if ((!destSet.has(g) && !tailOut) || (!retSet.has(g) && !tailRet)) { if (process.env.AZ_DEBUG) console.log("HUB no tail", h, g, !!tailOut, !!tailRet); return false; }
        if (tailOut) {
          const hOut = overnightAt(arr, tailOut.dep, g) ? hotelAt(g) : 0;
          tailOut = { ...tailOut, layoverH: (tailOut.dep - arr) / HOUR, overnight: hOut ? true : undefined, hotel: hOut || undefined };
        }
        if (tailRet) {
          const hRet = overnightAt(tailRet.arr, back.dep, g) ? hotelAt(g) : 0;
          tailRet = { ...tailRet, hotel: hRet || undefined, overnight: hRet ? true : undefined };
        }
      }
      // feeders: one Kiwi query from all home airports, plus the real bus ride when needed
      const fo = await kiwiOneWay(homeAirports, [h], addDays(od, -1), od, KIWI_MAX, meter, checked);
      let feedOut: Itinerary | null = null;
      for (const it of (fo ?? []).filter(knownKiwi).slice(0, 16)) {
        const iti = await withBus(itineraryFromKiwi(it.segs, it.price, it.link), "out");
        const cost = (x: Itinerary) => x.price + (overnightAt(x.lastArr, dep, h) ? hotelAt(h) : 0);
        if (iti && iti.lastArr + p.minConnSameH * HOUR <= dep && dep - iti.lastArr < 30 * HOUR && (!feedOut || cost(iti) < cost(feedOut))) feedOut = iti;
      }
      const backDay = utcToLocal(back.arr, AP[h].tz).slice(0, 10);
      const fr = await kiwiOneWay([h], homeAirports, backDay, addDays(backDay, 1), KIWI_MAX, meter, checked);
      let feedRet: Itinerary | null = null;
      for (const it of (fr ?? []).filter(knownKiwi).slice(0, 16)) {
        const iti = await withBus(itineraryFromKiwi(it.segs, it.price, it.link), "ret");
        const cost = (x: Itinerary) => x.price + (overnightAt(back!.arr, x.firstDep, h) ? hotelAt(h) : 0);
        if (iti && iti.firstDep >= back.arr + p.minConnSameH * HOUR && iti.firstDep - back.arr < 30 * HOUR && (!feedRet || cost(iti) < cost(feedRet))) feedRet = iti;
      }
      if (!feedOut || !feedRet) { if (process.env.AZ_DEBUG) console.log("HUB no feeder", h, g, !!feedOut, !!feedRet); return false; }
      const hotelOut = overnightAt(feedOut.lastArr, dep, h) ? hotelAt(h) : 0;
      const hotelRet = overnightAt(back.arr, feedRet.firstDep, h) ? hotelAt(h) : 0;
      const rtOut: Leg = { from: h, to: g, dep, arr, depLocal: rt.outbound.depLocal, arrLocal: rt.outbound.arrLocal, price: rt.price, carrier: rt.outbound.carriers,
        flightNo: rt.outbound.stops ? `${rt.outbound.stops} przes.` : "", source: "google", link: rt.url, via: viaOf(rt.outbound), note: `bilet powrotny ${h}–${g} (cena za oba kierunki)`,
        layoverH: (dep - feedOut.lastArr) / HOUR, overnight: hotelOut ? true : undefined, hotel: hotelOut || undefined };
      const rtBack: Leg = { ...back, price: 0, source: "google", link: rt.url, note: `bilet powrotny ${h}–${g}: lot powrotny wg rozkładu, potwierdź przy rezerwacji`,
        layoverH: tailRet ? (back.dep - tailRet.arr) / HOUR : undefined };
      const tailCost = (tailOut ? tailOut.price + (tailOut.hotel ?? 0) : 0);
      const o: Itinerary = { legs: [...feedOut.legs, rtOut, ...(tailOut ? [tailOut] : [])], price: feedOut.price + rt.price + hotelOut + tailCost,
        firstDep: feedOut.firstDep, lastArr: tailOut ? tailOut.arr : arr, estimated: false, overnights: (hotelOut ? 1 : 0) + (tailOut?.hotel ? 1 : 0) };
      const fl = feedRet.legs.map((l, i) => (i === 0 ? { ...l, layoverH: (l.dep - back!.arr) / HOUR, overnight: hotelRet ? true : undefined, hotel: hotelRet || undefined } : l));
      const r: Itinerary = { legs: [...(tailRet ? [tailRet] : []), rtBack, ...fl], price: feedRet.price + hotelRet + (tailRet ? tailRet.price + (tailRet.hotel ?? 0) : 0),
        firstDep: tailRet ? tailRet.dep : back.dep, lastArr: feedRet.lastArr, estimated: false, overnights: (hotelRet ? 1 : 0) + (tailRet?.hotel ? 1 : 0) };
      const stay = stayOf(o, r);
      if (stay < p.stayMin || stay > p.stayMax) { if (process.env.AZ_DEBUG) console.log("HUB stay", h, g, stay); return false; }
      accept(makeTrip(`hubrt-${h}-${g}-${od}-${rd}`, o, r, o.price + r.price, "hub-rt"));
      return true;
  }

  type RtPair = { h: string; g: string; lb: number; rows: GridRow[] | null; next: number; queried: boolean; owTried?: boolean };
  let rtQueried = 0, rtRealized = 0;
  const rtHeap = new Heap<RtPair>((x) => x.lb);
  let rtReach: { out: Map<string, number>; ret: Map<string, number> } | null = null;
  let rtReachAt = 0;
  const arcLbOf = (g: Graph, a: string, b: string, dir: "out" | "ret") => {
    const arc = g.get(a)?.find((x) => x.kind === "flight" && x.to === b);
    return arc ? Math.max(arc.lb, legMins[dir].get(a + b) ?? 0) : Infinity;
  };
  /** Lower bound of everything around the RT ticket: feeders and the onward tails. */
  function rtBase(h: string, g: string): number {
    if (!rtReach || Date.now() - rtReachAt > 5000) {
      rtReach = { out: dijkstra(gOut.graph, p.origin, false), ret: dijkstra(gRet!.graph, p.origin, true) };
      rtReachAt = Date.now();
    }
    const tail = (destSet.has(g) ? 0 : Math.min(...p.dest.map((d) => arcLbOf(gOut.graph, g, d, "out"))))
      + (retSet.has(g) ? 0 : Math.min(...retDest.map((d) => arcLbOf(gRet!.graph, d, g, "ret"))));
    return (rtReach.out.get(h) ?? Infinity) + (rtReach.ret.get(h) ?? Infinity) + tail;
  }
  // cheapest one-way H->G and G->H with any connections (Kiwi multi-airport answers; floor when absent)
  const owMin = new Map<string, number>();
  const owOf = (a: string, b: string, g: Graph, dir: "out" | "ret") => {
    const k = owMin.get(a + b);
    if (k !== undefined) return k;
    const arc = arcLbOf(g, a, b, dir);
    return Number.isFinite(arc) ? arc : 0;
  };
  const rtLb = (x: RtPair) => rtBase(x.h, x.g) + (x.queried
    ? (x.rows && x.next < x.rows.length ? x.rows[x.next].price : Infinity)
    : Math.max(owOf(x.h, x.g, gOut.graph, "out"), owOf(x.g, x.h, gRet!.graph, "ret")));
  if (!p.oneWay) {
    const gateways = [...new Set([...p.dest, ...[...FAR_HUBS].filter((g) => AP[g] && !destSet.has(g))])];
    // exact one-way minima between the gateways and European hubs (both directions), so the
    // "RT >= cheapest one-way" bound of unqueried pairs is tight: two multi-airport Kiwi answers
    {
      const reachOut = dijkstra(gOut.graph, p.origin, false);
      const hubs = [...gOut.graph.keys()].filter((h) => AP[h].region === "EUR" && (gOut.graph.get(h) ?? []).some((a) => a.kind === "flight" && gateways.includes(a.to) && km(AP[h], AP[a.to]) > 2500))
        .sort((a, b) => (reachOut.get(a) ?? Infinity) - (reachOut.get(b) ?? Infinity)).slice(0, D(40, 80)); // exact minima for many hubs keep the RT bounds tight
      const gw = gateways.slice(0, D(40, 80));
      const [ow0, ow1] = legWindow(outFrom, outTo, 2), [rw0, rw1] = legWindow(retFrom, retTo, 2);
      const record = (its: KItin[] | null, froms: string[], tos: string[]) => {
        if (!its) return;
        const floor = its.length >= KIWI_MAX ? its[its.length - 1].price : Infinity;
        for (const a of froms) for (const b of tos) {
          const hit = its.filter((it) => it.segs[0].from === a && it.segs[it.segs.length - 1].to === b);
          // absent from a short answer proves nothing for a round-trip fare: leave the pair unbounded here
          if (hit.length) owMin.set(a + b, Math.min(...hit.map((it) => it.price)));
          else if (Number.isFinite(floor)) owMin.set(a + b, floor);
        }
      };
      // destinations and other gateways separately: a price floor only covers its own answer
      for (const set of [gw.filter((g) => destSet.has(g)), gw.filter((g) => !destSet.has(g))]) {
        if (!set.length) continue;
        record(await kiwiOneWay(hubs, set, ow0, ow1, KIWI_MAX, meter, checked), hubs, set);
        record(await kiwiOneWay(set, hubs, rw0, rw1, KIWI_MAX, meter, checked), set, hubs);
      }
    }
    const pairs: RtPair[] = [];
    for (const g of gateways) for (const [h, arcs] of gOut.graph) {
      if (AP[h].region !== "EUR" || km(AP[h], AP[g]) < 2500 || !arcs.some((a) => a.kind === "flight" && a.to === g)) continue;
      const pair: RtPair = { h, g, lb: 0, rows: null, next: 0, queried: false };
      pair.lb = rtLb(pair);
      if (Number.isFinite(pair.lb)) pairs.push(pair);
    }
    // warm start: the two most promising hub <-> destination pairs get their date grid and their two
    // cheapest dates realized right away, so pruning starts from a strong incumbent
    emit("status", { phase: "hub", message: "Bilety powrotne w hubach: siatka dat Google dla najlepszych par" });
    const toDest = pairs.filter((q) => destSet.has(q.g)).sort((a, b) => a.lb - b.lb);
    // plus the best pair through a low-cost long-haul hub (Level BCN, French bee ORY, Norse OSL/LGW...)
    const lowcostPair = pairs.filter((q) => config.lowcostHubs.includes(q.h) || config.lowcostHubs.includes(q.g)).sort((a, b) => a.lb - b.lb)[0];
    if (process.env.AZ_DEBUG) console.log("HUB warm", toDest.slice(0, 3).map((x) => `${x.h}-${x.g}:${Math.round(x.lb)}`).join(" "), "lowcost", lowcostPair ? `${lowcostPair.h}-${lowcostPair.g}:${Math.round(lowcostPair.lb)}` : "-");
    for (const x of [...new Set([...toDest.slice(0, D(2, 4)), ...(lowcostPair ? [lowcostPair] : [])])]) {
      if (signal?.aborted || Date.now() > deadline) break;
      const [w0, w1] = legWindow(outFrom, outTo, 2);
      const rows = (await googleRtGrid(x.h, x.g, w0, w1, p.stayMin, p.stayMax + 1, meter)) ?? (unverified++, await sampleRows(x.h, x.g));
      x.queried = true;
      rtQueried++;
      if (!rows) continue;
      x.rows = rows.sort((a, b) => a.price - b.price);
      for (let k = 0; k < 4 && x.next < x.rows.length && Date.now() < grace(20_000); k++) { const row = x.rows[x.next++]; rtRealized++; await realizeRt(x.h, x.g, row.out, row.ret); }
    }
    for (const x of pairs) { x.lb = rtLb(x); if (Number.isFinite(x.lb)) rtHeap.push(x); }
  }
  /**
   * Without Google's date grid (it answers errors at times), a pair still gets a few concrete date
   * pairs: the cheapest one-way days each way (Kiwi, whole window) that make a valid stay. Their
   * "price" is only the one-way bound, for ordering; realizeRt prices the real round trip.
   */
  async function sampleRows(h: string, g: string): Promise<GridRow[] | null> {
    const [ow0, ow1] = legWindow(outFrom, outTo, 2), [rw0, rw1] = legWindow(retFrom, retTo, 2);
    const day = (it: KItin, end: boolean) => (end ? it.segs[it.segs.length - 1] : it.segs[0]).depLocal.slice(0, 10);
    const outs = (await kiwiOneWay([h], [g], ow0, ow1, KIWI_MAX, meter, checked)) ?? [];
    const rets = (await kiwiOneWay([g], [h], rw0, rw1, KIWI_MAX, meter, checked)) ?? [];
    const od = [...new Set(outs.filter((i) => i.segs[0].from === h).map((i) => day(i, false)))].slice(0, 4);
    const rd = [...new Set(rets.filter((i) => i.segs[0].from === g).map((i) => day(i, false)))];
    const rows: GridRow[] = [];
    for (const o of od) {
      const r = rd.find((d) => { const s = (Date.parse(d) - Date.parse(o)) / 86400_000; return s >= p.stayMin && s <= p.stayMax; });
      if (r) rows.push({ out: o, ret: r, price: Math.max(owOf(h, g, gOut.graph, "out"), owOf(g, h, gRet!.graph, "ret")) });
    }
    return rows.length ? rows.slice(0, 3) : null;
  }
  /** One unit of round-trip work: query a pair's date grid, or realize its next cheapest date pair. */
  async function rtStep() {
    const x = rtHeap.pop()!;
    const fresh = rtLb(x);
    if (fresh > x.lb + 0.5) { x.lb = fresh; if (Number.isFinite(fresh)) rtHeap.push(x); return; } // lazy update
    if (!x.queried && !x.owTried && (!owMin.has(x.h + x.g) || !owMin.has(x.g + x.h))) {
      // cheap step first: exact one-way minima both ways (Kiwi), which usually rules the pair out
      x.owTried = true;
      const [ow0, ow1] = legWindow(outFrom, outTo, 2), [rw0, rw1] = legWindow(retFrom, retTo, 2);
      for (const [a, b, d0, d1] of [[x.h, x.g, ow0, ow1], [x.g, x.h, rw0, rw1]] as const) {
        if (owMin.has(a + b)) continue;
        const its = await kiwiOneWay([a], [b], d0, d1, KIWI_MAX, meter, checked);
        if (!its) continue;
        const hit = its.filter((it) => it.segs[0].from === a && it.segs[it.segs.length - 1].to === b);
        // a complete answer with nothing in it means no service at all between the two airports
        owMin.set(a + b, hit.length ? Math.min(...hit.map((it) => it.price)) : its.length < KIWI_MAX ? Infinity : its[its.length - 1].price);
      }
      x.lb = rtLb(x);
      if (Number.isFinite(x.lb)) rtHeap.push(x);
      return;
    }
    if (!x.queried) {
      emit("leg", { from: x.h, to: x.g, state: "checking" });
      const [w0, w1] = legWindow(outFrom, outTo, 2);
      const extra = destSet.has(x.g) ? 1 : 4; // days the trip length may exceed the stay (tails, overnight arrival)
      const grid = await googleRtGrid(x.h, x.g, w0, w1, p.stayMin, p.stayMax + extra, meter);
      if (grid === null) unverified++; // grid unavailable: the pair stays unproven, sampled dates instead
      const rows = grid ?? (await sampleRows(x.h, x.g));
      x.queried = true;
      rtQueried++;
      if (rows === null) return;
      x.rows = rows.sort((a, b) => a.price - b.price);
      emit("leg", { from: x.h, to: x.g, state: rows.length ? "ok" : "dead" });
    } else {
      const row = x.rows![x.next++];
      rtRealized++;
      await realizeRt(x.h, x.g, row.out, row.ret);
    }
    x.lb = rtLb(x);
    if (Number.isFinite(x.lb)) rtHeap.push(x);
  }
  // Far-side split, always (even when a direct flight exists): the inbound ends at a big hub on the
  // other side (BOG, GRU, SCL, KUL, BKK...) and a separate local ticket goes on to the destination.
  // Two multi-airport Kiwi answers per direction; the best combination per hub becomes a ready path.
  const splitPaths = { out: [] as Path[], ret: [] as Path[] };
  emit("status", { phase: "split", message: "Rozbicie po drugiej stronie: dolot do dużego hubu i osobny lokalny bilet" });
  {
    const hubs = [...new Set([...destRegions].flatMap((r) => config.splitHubs[r] ?? []))].filter((h) => AP[h] && !destSet.has(h)).slice(0, D(12, 24));
    const firstDay = (it: Itinerary) => utcToLocal(it.firstDep, AP[it.legs[0].from].tz).slice(0, 10);
    for (const dir of (p.oneWay ? ["out"] : ["out", "ret"]) as ("out" | "ret")[]) {
      // a later step replays the cached answers and finishes what this one had no time for
      if (!hubs.length || signal?.aborted || Date.now() > grace(20_000)) break;
      const [w0, w1] = dir === "out" ? legWindow(outFrom, outTo, 2) : legWindow(retFrom, retTo, 2);
      const ends = dir === "out" ? p.dest.slice(0, 25) : retDest.slice(0, 25);
      // One answer for all hubs is dominated by the cheapest one (e.g. 50 x BUD-IST): the long flight
      // is asked per hub instead, for the 5 hubs the map rates cheapest, from the 8 departure airports
      // cheapest to reach from home (bus bound from the map; with the access toggle off, all are 0).
      const g = dir === "out" ? gOut.graph : gRet!.graph;
      const reachHome = dijkstra(g, p.origin, dir === "ret");
      const viaHub = dijkstra(g, hubs, dir === "out");
      const topHubs = [...hubs].sort((x, y) => (reachHome.get(x) ?? Infinity) - (reachHome.get(y) ?? Infinity)).slice(0, D(5, 10));
      const starts = [...homeAirports].sort((x, y) => (reachHome.get(x) ?? Infinity) - (reachHome.get(y) ?? Infinity) || (viaHub.get(x) ?? Infinity) - (viaHub.get(y) ?? Infinity)).slice(0, D(8, 12));
      const far: KItin[] = [];
      const late = () => signal?.aborted || Date.now() > grace(20_000);
      for (const hub of topHubs) {
        if (late()) break;
        const r = dir === "out"
          ? await kiwiOneWay(starts, [hub], w0, w1, KIWI_MAX, meter, checked)
          : await kiwiOneWay([hub], starts, w0, addDays(w1, 3), KIWI_MAX, meter, checked);
        if (r) far.push(...r);
      }
      far.sort((x, y) => x.price - y.price);
      const loc = dir === "out"
        ? await kiwiOneWay(hubs, ends, w0, addDays(w1, 3), KIWI_MAX, meter, checked)
        : await kiwiOneWay(ends, hubs, w0, w1, KIWI_MAX, meter, checked);
      if (process.env.AZ_DEBUG) console.log("SPLIT", dir, topHubs.join(" "), "from", starts.join(" "), "far", far.length, "loc", loc?.length ?? null);
      if (!far.length || !loc) continue;
      const through = dir === "out" ? kOut : kRet; // what the same journey costs without the split
      const bestPer = new Map<string, Itinerary>();
      // the multi-hub answers are the cheapest rows overall and rarely line up in time: the local
      // leg is also asked for the exact days of each hub's three cheapest long flights
      const perHub = new Map<string, KItin[]>();
      for (const fit of far.filter(knownKiwi)) {
        const hub = dir === "out" ? fit.segs[fit.segs.length - 1].to : fit.segs[0].from;
        if (!perHub.has(hub)) perHub.set(hub, []);
        if (perHub.get(hub)!.length < 5) perHub.get(hub)!.push(fit); // some start where no bus from home goes
      }
      const extraLoc: KItin[] = [];
      for (const [hub, fits] of [...perHub].slice(0, D(4, 8))) {
        for (const day of [...new Set(fits.map((f) => dir === "out" ? f.segs[f.segs.length - 1].arrLocal.slice(0, 10) : f.segs[0].depLocal.slice(0, 10)))].slice(0, 3)) {
          if (late()) break;
          const r = dir === "out"
            ? await kiwiOneWay([hub], ends, day, addDays(day, 1), KIWI_MAX, meter, checked)
            : await kiwiOneWay(ends, [hub], addDays(day, -1), day, KIWI_MAX, meter, checked);
          if (r) extraLoc.push(...r);
        }
      }
      const locAll = [...loc, ...extraLoc];
      if (process.env.AZ_DEBUG) console.log("SPLIT", dir, "hubs", [...perHub].map(([h, f]) => `${h}:${f.length}:${f.map((x) => x.segs[0].from + x.price).join("/")}`).join(" "), "extraLoc", extraLoc.length, "loc to hubs", locAll.filter((x) => perHub.has(dir === "out" ? x.segs[0].from : x.segs[x.segs.length - 1].to)).length);
      for (const fit of [...perHub.values()].flat()) {
        if (late()) break;
        const farIt = await withBus(itineraryFromKiwi(fit.segs, fit.price, fit.link), dir);
        if (!farIt) continue;
        const hub = dir === "out" ? fit.segs[fit.segs.length - 1].to : fit.segs[0].from;
        for (const lit of locAll.filter(knownKiwi)) {
          const lf = lit.segs[0].from, lt = lit.segs[lit.segs.length - 1].to;
          if (dir === "out" ? lf !== hub : lt !== hub) continue;
          const locIt = itineraryFromKiwi(lit.segs, lit.price, lit.link);
          const [a, b] = dir === "out" ? [farIt, locIt] : [locIt, farIt];
          const gap = b.firstDep - a.lastArr;
          if (gap < p.minConnSameH * HOUR || gap > maxLayH(p) * HOUR || b.lastArr - a.firstDep > maxDirH(p) * HOUR) continue;
          const nights = nightsAt(a.lastArr, b.firstDep, AP[hub].tz);
          if (nights && !p.allowOvernight) continue;
          const hotel = counted(p, hotelPrice(p, nights, AP[hub].region));
          const price = a.price + b.price + hotel;
          const cur = bestPer.get(hub);
          if (cur && cur.price <= price) continue;
          const legs: Leg[] = [...a.legs, ...b.legs.map((l, i) => (i === 0 ? { ...l, layoverH: gap / HOUR, overnight: nights > 0 || undefined, hotel: hotel || undefined, nights: nights || undefined } : l))];
          const it: Itinerary = { legs, price, firstDep: a.firstDep, lastArr: b.lastArr, estimated: false, overnights: a.overnights + nights };
          // the same trip as one booking or Kiwi combination from the same airport on the same day, if any
          const first = it.legs.find((l) => l.source !== "flixbus" && l.source !== "local")!;
          const lastTo = it.legs[it.legs.length - 1].to;
          const alt = (through ?? []).filter((x) => x.segs[0].from === first.from && x.segs[x.segs.length - 1].to === lastTo && x.segs[0].depLocal.slice(0, 10) === first.depLocal.slice(0, 10))
            .sort((x, y) => x.price - y.price)[0];
          const flightCost = fit.price + lit.price;
          if (alt && alt.price > flightCost) it.savings = [{ technique: "split", label: `rozbicie w ${hub} (${AP[hub].city})`, pln: Math.round(alt.price - flightCost) }];
          bestPer.set(hub, it);
        }
      }
      if (process.env.AZ_DEBUG) console.log("SPLIT", dir, [...bestPer].map(([h, it]) => `${h}:${it.price}${it.savings ? "(−" + it.savings[0].pln + ")" : ""}`).join(" "));
      for (const [hub, it] of bestPer) {
        const path: Path = { id: `split-${dir}-${hub}-${firstDay(it)}`, nodes: nodesOf(it.legs), arcs: [], lb: it.price, flights: it.legs.length };
        verified.set(dir + path.id, { status: "ok", itineraries: [it], minPrice: it.price });
        splitPaths[dir].push(path);
      }
    }
  }

  emit("status", { phase: "search", message: "Branch and bound: bilety w jedną stronę i powrotne w hubach, od najniższej dolnej granicy" });

  // ready-made (Kiwi, split, memory) paths are already verified: combine them before spending any query
  for (const [dir, list] of [["out", [...kiwiOutPaths, ...splitPaths.out, ...memPaths.out, ...hypoPaths.out]], ["ret", [...kiwiRetPaths, ...splitPaths.ret, ...memPaths.ret, ...hypoPaths.ret]]] as const) {
    for (const path of list) {
      const r = verified.get(dir + path.id);
      if (r?.status !== "ok") continue;
      done[dir].push({ path, its: r.itineraries });
      minVerified[dir] = Math.min(minVerified[dir], r.minPrice);
      combine(dir, path, r.itineraries);
    }
  }
  emitStats(true);

  let lastLb = 0, iter = 0, memAt = 0;
  for (;;) {
    if (signal?.aborted) break;
    if (process.env.AZ_MEMLOG && Date.now() - memAt > 20_000) {
      memAt = Date.now();
      const m = process.memoryUsage();
      console.log(`[mem] heap ${Math.round(m.heapUsed / 1e6)} MB ext ${Math.round(m.external / 1e6)} MB | verified ${verified.size} found ${found.size} done ${done.out.length}/${done.ret.length} | out ${JSON.stringify(outE.sizes)} ret ${JSON.stringify(retE?.sizes ?? null)} | checked ${checkedCount} pruned ${pruned} legMins ${legMins.out.size}/${legMins.ret.size}`);
    }
    if (++iter % 25 === 0) {
      await new Promise((r) => setImmediate(r)); // let checkpoints run
      // near the heap limit the process spends its time collecting garbage and the progress writes and
      // the stop flag stop getting through: end here with the bound so far (gap shown, not proven)
      const h = getHeapStatistics();
      if (h.used_heap_size > 0.75 * h.heap_size_limit) { stopLb = lastLb; outOfMemory = true; break; }
    }
    const tOut = await queues.out.topKey(), tRet = queues.ret ? await queues.ret.topKey() : Infinity;
    // enumeration stopped by the step deadline: pause (never mistake it for an exhausted search)
    if (queues.out.outOfTime || queues.ret?.outOfTime || Date.now() > deadline) { stopLb = lastLb; paused = true; break; }
    // states the memory cap dropped still bound what is left (they just cannot be popped any more)
    const eOut = Math.min(outS.evictedLb, queues.out.evicted), eRet = retS ? Math.min(retS.evictedLb, queues.ret!.evicted) : Infinity;
    cheapest.out = Math.min(tOut, eOut, minVerified.out);
    cheapest.ret = queues.ret ? Math.min(tRet, eRet, minVerified.ret) : 0;
    const lbOut = Math.min(tOut, eOut) + cheapest.ret, lbRet = queues.ret ? Math.min(tRet, eRet) + cheapest.out : Infinity;
    const lbOneWay = Math.min(lbOut, lbRet);
    const rtTop = rtHeap.peek()?.lb ?? Infinity;
    const lb = Math.min(lbOneWay, rtTop);
    // what can still be popped: when only dropped states remain below the best, stop (unproven, gap shown)
    const lbLive = Math.min(tOut + cheapest.ret, queues.ret ? tRet + cheapest.out : Infinity, rtTop);
    if (!Number.isFinite(lbLive) || lbLive >= best) { stopLb = Math.min(lb, lbLive); lastLb = Number.isFinite(stopLb) ? stopLb : lastLb; break; }
    lastLb = Number.isFinite(lb) ? lb : lastLb;
    if (Number.isFinite(lb) && Number.isFinite(best)) {
      if (Number.isNaN(prog.lb0)) prog.lb0 = Math.min(lb, best);
      const span = best - prog.lb0;
      setPct(SETUP + (100 - SETUP - 2) * (span > 0 ? Math.max(0, Math.min(1, (lb - prog.lb0) / span)) : 1));
    }
    if (!Number.isFinite(lb) || lb >= best) { stopLb = lb; break; } // nothing left can beat the incumbent
    if (Date.now() > deadline) { stopLb = lb; paused = true; break; }
    if (!meter.canFree()) { stopLb = lb; exhausted = true; break; }
    // round-trip work goes first when its bound is lowest, and every third iteration anyway while it can
    // still beat the incumbent: the order does not change the proof, but it finds good trips sooner
    if (rtTop < best && (rtTop <= lbOneWay || iter % 3 === 0)) { await rtStep(); emitStats(); continue; }
    // ties are common (both bounds equal top_out + top_ret): alternate so neither side starves
    const dir: "out" | "ret" = Math.abs(lbOut - lbRet) < 1 ? (done.out.length <= done.ret.length ? "out" : "ret") : lbOut < lbRet ? "out" : "ret";
    const q = queues[dir]!;
    // the next few cheapest paths are verified at once: each waits mostly on the network, and the
    // sources' own pools (lib/sources/http) keep every source within its limit. The proof is unchanged:
    // every popped path is either verified or pushed back with its bound before the next bound check.
    const other = dir === "out" ? cheapest.ret : cheapest.out;
    const batchPaths: Path[] = [];
    for (let k = 0; k < VERIFY_PAR; k++) {
      if (k > 0 && !((await q.topKey()) + other < best)) break;
      const path = await q.pop();
      if (!path) break;
      const key = q.lastKey;
      const r = hasDead(path) ? Infinity : refined(path, dir);
      if (r > key + 0.5) { // bound tightened since it was queued: requeue (lazy update) or drop
        if (Number.isFinite(r)) q.push(path, r);
        pruned++;
        if (pruned % 50 === 1) emit("verified", { id: path.id, nodes: path.nodes, status: "pruned" });
        continue;
      }
      checkedCount++;
      emit("candidate", { id: path.id, nodes: path.nodes, lb: key + other });
      batchPaths.push(path);
    }
    if (!batchPaths.length) { emitStats(); continue; }
    const results = await Promise.all(batchPaths.map((path) => verify(path, dir)));
    results.forEach((res, k) => {
      const path = batchPaths[k];
      if (res.status === "pruned") { q.push(path, res.bound); pruned++; emit("verified", { id: path.id, nodes: path.nodes, status: "pruned" }); return; }
      if (res.status !== "ok") { emit("verified", { id: path.id, nodes: path.nodes, status: res.status }); return; }
      done[dir].push({ path, its: res.itineraries });
      minVerified[dir] = Math.min(minVerified[dir], res.minPrice);
      emit("verified", { id: path.id, nodes: path.nodes, status: "ok", price: res.minPrice });
      combine(dir, path, res.itineraries);
    });
    emitStats(true);
  }

  if (process.env.AZ_DEBUG) {
    console.log("RT queried", rtQueried, "realized", rtRealized, "heap", rtHeap.size, "top", Math.round(rtHeap.peek()?.lb ?? -1), rtHeap.peek()?.h, rtHeap.peek()?.g);
    console.log("DONE out", done.out.length, Math.round(minVerified.out), done.out.slice(0, 5).map((d) => d.path.id + ":" + d.its[0].price).join(" "));
    console.log("DONE ret", done.ret.length, Math.round(minVerified.ret), done.ret.slice(0, 5).map((d) => d.path.id + ":" + d.its[0].price).join(" "));
    const reasons = new Map<string, number>();
    for (const [k, v] of verified) if (v.status === "infeasible") { const r = k.slice(0, 3) + " " + v.reason.replace(/[A-Z]{3}-[A-Z]{3}/, "X-Y"); reasons.set(r, (reasons.get(r) ?? 0) + 1); }
    console.log("INFEASIBLE", JSON.stringify([...reasons]));
  }
  // 4) round-trip ticket at the long-haul hub instead of two one-ways
  if (!p.oneWay && Date.now() < grace(20_000)) {
    emit("status", { phase: "hub", message: "Sprawdzam bilety powrotne w hubach przesiadkowych" });
    const tried = new Set<string>();
    for (const t of [...found.values()].sort((a, b) => a.price - b.price).slice(0, D(8, 16))) {
      if (signal?.aborted || !meter.canGoogle() || Date.now() > grace(20_000)) break;
      const longest = (dir: "out" | "ret") => t.legs.filter((l) => l.dir === dir && l.price > 0 && l.source !== "flixbus" && l.source !== "local")
        .sort((a, b) => km(AP[b.from], AP[b.to]) - km(AP[a.from], AP[a.to]))[0];
      const lo = longest("out"), lr = longest("ret");
      if (!lo || !lr || lo.from !== lr.to || lo.to !== lr.from || km(AP[lo.from], AP[lo.to]) < 2500) continue;
      const outDate = lo.depLocal.slice(0, 10), retDate = lr.depLocal.slice(0, 10);
      const key = `${lo.from}${lo.to}${outDate}${retDate}`;
      if (tried.has(key)) continue;
      tried.add(key);
      const rt = await googleRoundTrip([lo.from], [lo.to], outDate, retDate, meter);
      if (!rt || rt.price >= lo.price + lr.price) continue;
      // The round-trip's outbound must still fit between the feeder legs.
      const idx = t.legs.indexOf(lo);
      const dep = localToUtc(rt.outbound.depLocal, AP[lo.from].tz), arr = localToUtc(rt.outbound.arrLocal, AP[lo.to].tz);
      const prev = t.legs[idx - 1], next = t.legs[idx + 1];
      if ((prev && prev.dir === "out" && dep < prev.arr + p.minConnSameH * HOUR) || (next && next.dir === "out" && arr > next.dep - p.minConnSameH * HOUR)) continue;
      const legs = t.legs.map((l): TripLeg => {
        if (l === lo) return { ...l, dep, arr, depLocal: rt.outbound.depLocal, arrLocal: rt.outbound.arrLocal, carrier: rt.outbound.carriers, price: rt.price, source: "google", link: rt.url, note: `bilet powrotny ${lo.from}–${lo.to} (cena za oba kierunki)` };
        if (l === lr) return { ...l, price: 0, source: "google", link: rt.url, note: `bilet powrotny ${lo.from}–${lo.to}: lot powrotny wg rozkładu, potwierdź przy rezerwacji` };
        return l;
      });
      const price = t.price - lo.price - lr.price + rt.price;
      const nt: Trip = { ...t, id: t.id + "|rt", price, legs, origin: "hub-rt", flags: riskFlags(legs, p, AP[lo.to].cc, { from: p.dateFrom, to: p.dateTo }),
        savings: [...(t.savings ?? []), { technique: "hub-rt", label: `bilet powrotny ${lo.from}–${lo.to} zamiast dwóch w jedną stronę`, pln: Math.round(lo.price + lr.price - rt.price) }] };
      accept(nt);
    }
  }

  // 4a) one ticket vs separate tickets on every stretch of the best trips: for each pair of airports
  // on a direction (A->C, A->D, B->D...) that is now flown on 2+ separate tickets, the cheapest single
  // booking for that stretch (Kiwi, Google; connections inside protected) that still fits between the
  // neighbouring legs. A dynamic program then picks the cheapest mix per direction.
  {
    emit("status", { phase: "tickets", message: "Bilety łączone vs osobne: każdy fragment trasy jako jedna rezerwacja" });
    const until = grace(90_000);
    const memo = new Map<string, Promise<{ legs: Leg[]; price: number }[]>>();
    const through = (from: string, to: string, day: string) => {
      const k = from + to + day;
      if (!memo.has(k)) memo.set(k, (async () => {
        const out: { legs: Leg[]; price: number }[] = [];
        const its = await kiwiOneWay([from], [to], day, day, KIWI_MAX, meter, checked).catch(() => null);
        for (const it of (its ?? []).filter(knownKiwi).slice(0, 20)) { const x = itineraryFromKiwi(it.segs, it.price, it.link); out.push({ legs: x.legs, price: x.price }); }
        const g = await googleOneWay(from, to, day, meter).catch(() => null);
        for (const o of g ?? []) out.push({ legs: [{ ...o, note: o.stops ? "jeden bilet z przesiadką (Google): przesiadka chroniona" : undefined }], price: o.price });
        return out;
      })());
      return memo.get(k)!;
    };
    let segBudget = D(30, 80);
    for (const t0 of [...found.values()].filter((x) => Number.isFinite(x.price) && !x.google).sort((a, b) => a.price - b.price).slice(0, D(6, 12))) {
      if (signal?.aborted || Date.now() > until || segBudget <= 0) break;
      const t = withTickets(t0);
      let legs = t.legs.map((l) => ({ ...l }));
      let saved = 0;
      const labels: string[] = [];
      for (const dir of ["out", "ret"] as const) {
        const idx = legs.map((l, i) => [l, i] as const).filter(([l]) => l.dir === dir).map(([, i]) => i);
        if (idx.length < 2) continue;
        const L = idx.map((i) => legs[i]);
        // a stretch [a..b] may be replaced only on ticket boundaries and only across flights
        const startsTicket = (k: number) => k === 0 || L[k].ticket !== L[k - 1].ticket;
        const endsTicket = (k: number) => k === L.length - 1 || L[k].ticket !== L[k + 1].ticket;
        const costOf = (a: number, b: number) => L.slice(a, b + 1).reduce((x, l, k) => x + l.price + (k > 0 ? counted(p, l.hotel ?? 0) : 0), 0);
        type Opt = { legs: Leg[]; price: number } | null;
        const repl = new Map<string, Opt>();
        for (let a = 0; a < L.length; a++) for (let b = a + 1; b < L.length && b - a <= 3; b++) {
          if (!startsTicket(a) || !endsTicket(b) || L.slice(a, b + 1).some(isGroundLeg)) continue;
          // a ticket that also covers legs outside the stretch (a round-trip fare: its return leg rides at
          // 0 in the other direction) cannot be replaced, or that leg would be left unpaid
          const inside = new Set(L.slice(a, b + 1));
          if (L.slice(a, b + 1).some((l) => legs.some((x) => x.ticket === l.ticket && !inside.has(x)))) continue;
          if (new Set(L.slice(a, b + 1).map((l) => l.ticket)).size < 2) continue; // already one booking
          if (segBudget-- <= 0 || Date.now() > until) break;
          const prev = L[a - 1], next = L[b + 1];
          const opts = await through(L[a].from, L[b].to, L[a].depLocal.slice(0, 10));
          const fit = opts.filter((o) => {
            const d = o.legs[0].dep, e = o.legs[o.legs.length - 1].arr;
            return (!prev || d >= prev.arr + p.minConnSameH * HOUR) && (!next || e + p.minConnSameH * HOUR <= next.dep);
          }).sort((x, y) => x.price - y.price)[0] ?? null;
          const sep = costOf(a, b);
          if (fit && fit.price < sep) ticketWins.combined++; else ticketWins.separate++;
          repl.set(`${a}-${b}`, fit && fit.price < sep ? fit : null);
        }
        // cheapest partition: keep each original leg, or a through ticket over [a..b]
        const best2 = new Array<number>(L.length + 1).fill(Infinity), how = new Array<[number, Opt]>(L.length + 1);
        best2[0] = 0;
        for (let k = 0; k < L.length; k++) {
          if (!Number.isFinite(best2[k])) continue;
          const keep = best2[k] + L[k].price + (k > 0 ? counted(p, L[k].hotel ?? 0) : 0);
          if (keep < best2[k + 1]) { best2[k + 1] = keep; how[k + 1] = [k, null]; }
          for (let b = k + 1; b < L.length; b++) {
            const o = repl.get(`${k}-${b}`);
            if (!o) continue;
            const c = best2[k] + o.price;
            if (c < best2[b + 1]) { best2[b + 1] = c; how[b + 1] = [k, o]; }
          }
        }
        const before = costOf(0, L.length - 1);
        if (best2[L.length] >= before - 0.5) continue;
        // rebuild the direction
        const parts: Leg[][] = [];
        for (let k = L.length; k > 0;) { const [a, o] = how[k]; parts.unshift(o ? o.legs.map((x, i) => ({ ...x, note: i === 0 ? (x.note ?? `jeden bilet ${L[a].from}–${L[k - 1].to} zamiast osobnych`) : x.note })) : [L[a]]); if (o) labels.push(`${L[a].from}–${L[k - 1].to}`); k = a; }
        const flat = parts.flat().map((l, i, arr) => ({ ...l, dir, layoverH: i ? (l.dep - arr[i - 1].arr) / HOUR : l.layoverH } as TripLeg));
        saved += before - best2[L.length];
        legs = [...legs.slice(0, idx[0]), ...flat, ...legs.slice(idx[idx.length - 1] + 1)];
      }
      if (saved < 1) continue;
      const nt: Trip = { ...t, id: t.id + "|tix", price: Math.round(t.price - saved), legs, nodes: nodesOf(legs.filter((l) => l.dir === "out")).concat(nodesOf(legs.filter((l) => l.dir === "ret"))),
        flags: riskFlags(legs, p, AP[tripDest(t)]?.cc, { from: p.dateFrom, to: p.dateTo }),
        savings: [...(t.savings ?? []), { technique: "through", label: `jeden bilet zamiast osobnych: ${labels.join(", ")}`, pln: Math.round(saved) }] };
      accept(nt);
    }
  }

  // 4b) the same long flights on other markets / as a return ticket used one way (best trips only)
  {
    const until = grace(60_000); // the step must end well inside the 300 s function limit
    const seen = new Set<string>();
    for (const t of [...found.values()].sort((a, b) => a.price - b.price).filter(improvable).slice(0, D(6, 12))) {
      if (signal?.aborted || Date.now() > until || seen.size >= D(3, 8)) break;
      const k = t.legs.map((l) => l.flightNo + l.dep).join("|");
      if (seen.has(k)) continue;
      seen.add(k);
      const nt = await improveTrip(t, p, meter, until).catch(() => t);
      if (nt !== t) accept(nt);
    }
  }

  let trips = pickTrips([...found.values()], p.dest, config.resultsK);
  // states dropped by the memory cap (highest bounds first) bound everything they would have led to:
  // a dropped outbound state costs at least evictedLb + the cheapest return, and vice versa
  const evOut = Math.min(outS.evictedLb, queues.out.evicted), evRet = retS ? Math.min(retS.evictedLb, queues.ret!.evicted) : Infinity;
  const evictBound = Math.min(evOut + (retS ? cheapest.ret : 0), retS ? evRet + cheapest.out : Infinity);
  if (Number.isFinite(evictBound)) stopLb = Math.min(stopLb, evictBound);
  const truncated = !outS.provenBelow(best - (retS ? cheapest.ret : 0)) || (retS ? !retS.provenBelow(best - cheapest.out) : false)
    || queues.out.evicted < best - (retS ? cheapest.ret : 0) || (retS ? queues.ret!.evicted < best - cheapest.out : false);
  const provenOptimal = trips.length > 0 && !paused && !exhausted && !outOfMemory && !truncated && !signal?.aborted && unverified === 0 && stopLb >= Math.min(best, trips[0].price);
  const gap = trips.length && !provenOptimal && Number.isFinite(stopLb) ? Math.max(0, best - stopLb) : null;
  if (provenOptimal && !p.oneWay) notes.push(`Dowód obejmuje bilety w jedną stronę, kombinacje Kiwi i bilety powrotne Europa ↔ hub (${rtQueried} par z pełną siatką dat, ${rtRealized} terminów sprawdzonych; dla pozostałych par założenie: bilet powrotny nie jest tańszy niż najtańszy bilet w jedną stronę na tej trasie).`);
  if (outOfMemory) notes.push(`Koniec pamięci workera: optimum nie jest udowodnione (najniższa niesprawdzona dolna granica: ${Math.round(stopLb)} zł).`);
  if (exhausted) notes.push(`Wyczerpany limit zapytań: optimum nie jest udowodnione (najniższa niesprawdzona dolna granica: ${Math.round(stopLb)} zł).`);
  if (unverified) notes.push(`${unverified} wariantów nie dało się sprawdzić (źródło nie odpowiedziało), więc nie ma dowodu optymalności.`);
  if (truncated) notes.push("Przeszukiwanie mapy osiągnęło limit bezpieczeństwa pamięci, więc nie ma dowodu optymalności.");

  // 5) Google once more on the dates of the best trips (the early pass priced the cheapest calendar
  // dates); the plain offer stays a candidate, so the result is never more expensive than Google
  // the full Google comparison must be in before the end (a stopped search does not wait for it)
  if (!signal?.aborted) await fullBase;
  // the single-city side lanes: whatever they found by the deadline
  await Promise.race([sideLanes, new Promise<void>((r) => setTimeout(r, Math.max(0, grace(0) - Date.now())))]);
  await runBaseline("final").catch(() => {});
  const base = baseline as Baseline; // assigned inside runBaseline (TS does not see closure writes)
  const gCand = googleCand as Trip | null;
  trips = pickTrips([...found.values()], p.dest, config.resultsK);
  if (trips[0]?.google) notes.push("Najtaniej wychodzi zwykła oferta Google: osobne bilety nie dały tu niższej ceny.");
  if (base && trips[0] && trips[0].price > base.price) {
    // cannot happen while the Google candidate is in the list; kept as a guard with an explanation
    notes.push(`Uwaga: najlepsza trasa (${trips[0].price} zł) wyszła drożej niż Google (${base.price} zł).`);
  }
  // per-technique savings: radar deals and memory where they supplied the trip, the rest vs Google
  {
    const fromMem = (x: Trip) => [...memIds].some((id) => x.id.includes(id));
    const hypoIn = (x: Trip) => { for (const [id, h] of hypoOf) if (x.id.split("|").includes(id)) return h; return null; };
    const bestNonHypo = Math.min(...[...found.values()].filter((x) => !hypoIn(x)).map((x) => x.price));
    for (const h of hypos) {
      const mine = [...found.values()].filter((x) => h.paths.some((id) => x.id.split("|").includes(id)));
      h.price = mine.length ? Math.min(...mine.map((x) => x.price)) : null;
      h.won = !!trips[0] && h.paths.some((id) => trips[0].id.split("|").includes(id)) && !(bestNonHypo <= trips[0].price);
    }
    // learning: log each hypothesis once per search (a fast search logs on its last step, a deep
    // round only the hypotheses it added; earlier rounds replay theirs from the cache)
    const fresh = deep ? hypos.slice((opts.round ?? 1) > 1 ? 12 + 6 * ((opts.round ?? 1) - 2) : 0) : paused ? [] : hypos;
    if (opts.final !== false) await recordHypotheses(p.query, fresh, bestNonHypo).catch(() => {});
    const bestOther = Math.min(...[...found.values()].filter((x) => !fromMem(x)).map((x) => x.price));
    for (let i = 0; i < trips.length; i++) {
      let t = trips[i];
      const extra = [...(await radarSavings(t).catch(() => []))];
      if (i === 0 && fromMem(t) && Number.isFinite(bestOther) && bestOther > t.price) extra.push({ technique: "memory", label: "trasa z pamięci wcześniejszych wyszukiwań", pln: Math.round(bestOther - t.price) });
      const hy = hypoIn(t);
      if (i === 0 && hy && Number.isFinite(bestNonHypo) && bestNonHypo > t.price) extra.push({ technique: "strategist", label: `strateg: ${hy.label}`, pln: Math.round(bestNonHypo - t.price) });
      if (extra.length) t = { ...t, savings: [...(t.savings ?? []), ...extra] };
      trips[i] = withSeparateSaving(t, base?.price ?? null);
    }
    if (opts.final !== false) await rememberTrips(p, trips).catch(() => {});
  }
  const savings = base && trips[0] ? Math.round(base.price - trips[0].price) : null;

  // every destination city of a region: checked or not, and its cheapest trip
  const destinations = regionDest();
  if (provenOptimal) setPct(100); else setPct(Math.min(99, prog.pct));
  const finalStats = { ...meter.snapshot(), checked: checkedCount + found.size, pruned, ms: Date.now() - t0, destinations, progress: progress(), baselineStatus: baselineStatus ?? undefined, ticketWins, prelim: prelim ?? undefined, oneTicket: oneTicketBest ?? undefined };
  let summary = "";
  try {
    const s = opts.final === false ? { text: "", usd: 0 } : await summarize(p, trips.slice(0, 3), baseline, provenOptimal);
    summary = s.text;
    if (s.usd) { meter.costUsd += s.usd; finalStats.costUsd = +meter.costUsd.toFixed(4); }
  } catch { summary = ""; }

  const reasonable = [...found.values(), ...(gCand ? [gCand] : [])].filter((t) => Number.isFinite(t.price) && isReasonable(t)).sort((a, b) => a.price - b.price)[0] ?? null;
  const result: SearchResult = {
    trips, baseline: base, savings, provenOptimal, gap, summary, stats: finalStats, notes, paused, reasonable, baselineStatus: baselineStatus ?? undefined, stopped: !!signal?.aborted,
    strategist: { checked: hypos.length, hypotheses: hypos.map(({ paths: _paths, ...h }) => h) },
    lowerBound: Number.isFinite(stopLb) ? Math.round(stopLb) : null,
    unverified, truncated,
  };
  await db.logSearch({
    query: p.query, params: p, best: trips[0]?.price ?? null, baseline: base?.price ?? null,
    paidCalls: finalStats.paid, freeCalls: finalStats.free, costUsd: finalStats.costUsd, ms: finalStats.ms, result,
  }).catch(() => {});
  return result;
}

