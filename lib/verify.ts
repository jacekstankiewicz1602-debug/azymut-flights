// Live verification of one path: fetch concrete departures per leg (flights and buses), then pick
// the cheapest feasible combination under the self-transfer rules (dynamic programming over time).
// Every price in a verified itinerary comes from a live source; nothing is estimated.
import { accessLimitH } from "./departure";
import { AP, km, VISA_NOTE } from "./airports";
import { config } from "./config";
import type { Arc } from "./map";
import type { Path } from "./paths";
import { flixRides, localTransfer } from "./sources/flixbus";
import { googleOneWay } from "./sources/google";
import type { Meter } from "./sources/http";
import { KIWI_MAX, kiwiOneWay, type KItin } from "./sources/kiwi";
import { chunks, ryanairDays, wizzDays } from "./sources/lowcost";
import { duffel, googleFlights, hasDuffel, hasSerp } from "./sources/paid";
import { addDays, DAY, HOUR, isoDay, utcToLocal } from "./time";
import { optionBagFee } from "./bags";
import type { FlightOption, Saving, SearchParams } from "./types";

/** hotel: estimated cost of the nights at the connection before this leg (nights of them). */
export type Leg = FlightOption & { layoverH?: number; overnight?: boolean; hotel?: number; nights?: number };

export type Itinerary = {
  legs: Leg[];
  price: number;
  firstDep: number;
  lastArr: number;
  estimated: boolean;
  overnights: number;
  savings?: Saving[]; // techniques that built this itinerary (e.g. a split at a far hub)
};

export type VerifyResult =
  | { status: "ok"; itineraries: Itinerary[]; minPrice: number }
  | { status: "infeasible"; reason: string; deadArc?: string; unverified?: boolean }
  | { status: "pruned"; bound: number };

export type Ctx = {
  params: SearchParams; meter: Meter; threshold: () => number; signal?: AbortSignal;
  /** Verified cheapest price per arc over this direction's window: a tighter, still valid lower bound. */
  legMins: Map<string, number>;
  /** One "everywhere from X" query that tightens the bounds of all of X's routes at once. */
  prefetch?: (from: string) => Promise<void>;
  /** Whole-window options already fetched for some arcs (e.g. Kiwi long-haul), keyed from+to. */
  preOptions?: Map<string, FlightOption[]>;
  /** One Kiwi query pricing all of X's non-calendar routes for the whole window. */
  batch?: (from: string) => Promise<void>;
};

/** Every leg of a direction is searched over the same window (keeps per-leg minima reusable). */
export function legWindow(d0: string, d1: string, maxLegs: number, stopoverDays = 0): [string, string] {
  // with no connection limit (maxLegs 8) the total travel time bounds a direction, not the leg count
  return [addDays(d0, -1), addDays(d1, Math.ceil(Math.min(maxLegs, 5) * 1.3) + Math.min(7, Math.ceil(stopoverDays * 2)))];
}

/** Longest connection (h): the usual self-transfer limit, or the stopover the user allows. */
export const maxLayH = (p: SearchParams) => Math.max(config.rules.maxLayoverH, (p.stopoverDays ?? 0) * 24 + 6);
/** Longest time per direction (h): stopovers add to the usual limit. */
export const maxDirH = (p: SearchParams) => p.maxTripH + (p.stopoverDays ?? 0) * 48;
/** Hotel estimate at a connection; in the price only when the user counts it. */
export const hotelPrice = (p: SearchParams, nights: number, region: string) => nights * (config.hotelByRegion[region] ?? 250);
export const counted = (p: SearchParams, hotel: number) => (p.countHotel === false ? 0 : hotel);

const isCalendar = (a: Arc) => a.sources.includes("ryanair") || a.sources.includes("wizz");
const isKiwi = (a: Arc) => a.sources.includes("kiwi");

type Kind = "flight" | "bus" | "local";
type Seg = { arc: Arc; kind: Kind; from: string; to: string; options?: FlightOption[] };
const kindOf = (a: Arc): Kind => (a.kind === "flight" ? "flight" : a.mode === "flix" ? "bus" : "local");

async function calendarOptions(s: Seg, d0: string, d1: string, ctx: Ctx): Promise<FlightOption[] | null> {
  const checked = ctx.params.baggage === "checked";
  // every chunk and both airlines at once (each source has its own request pool)
  const calls: Promise<FlightOption[] | null>[] = [];
  for (const [x, y] of chunks(d0, d1, 45)) {
    if (s.arc.sources.includes("ryanair")) calls.push(ryanairDays(s.from, s.to, x, y, checked, ctx.meter).catch(() => null));
    if (s.arc.sources.includes("wizz")) calls.push(wizzDays(s.from, s.to, x, y, checked, ctx.meter).catch(() => null));
  }
  const res = await Promise.all(calls);
  return res.some(Boolean) ? res.flatMap((r) => r ?? []) : null;
}

/** Kiwi itineraries from -> to as single options (connections inside one Kiwi booking). */
export function kiwiToOptions(its: KItin[], from: string, to: string): FlightOption[] {
  return its
    .filter((it) => it.segs[0].from === from && it.segs[it.segs.length - 1].to === to)
    .map((it) => {
      const f = it.segs[0], l = it.segs[it.segs.length - 1];
      return {
        from, to, dep: f.dep, arr: l.arr, depLocal: f.depLocal, arrLocal: l.arrLocal, price: Math.round(it.price),
        carrier: [...new Set(it.segs.map((x) => x.carrier))].join(" + "), flightNo: it.segs.map((x) => x.flightNo).join(" / "),
        source: "kiwi" as const, link: it.link, stops: it.segs.length - 1,
        note: it.segs.length > 1 ? `przez ${it.segs.slice(0, -1).map((x) => x.to).join(", ")} (rezerwacja Kiwi)` : undefined,
      };
    });
}

async function kiwiOptions(s: Seg, d0: string, d1: string, ctx: Ctx): Promise<FlightOption[] | null> {
  const bags = ctx.params.baggage === "checked";
  const its = await kiwiOneWay([s.from], [s.to], d0, d1, KIWI_MAX, ctx.meter, bags);
  if (!its) return null;
  // Kiwi caps an answer at 50 itineraries: over a whole month that is the cheapest few days only.
  // "Whole month" means every day, so a full answer on a long leg is re-asked week by week.
  if (ctx.params.flexMode === "month" && its.length >= KIWI_MAX && km(AP[s.from], AP[s.to]) > 2500 && Date.parse(d1) - Date.parse(d0) <= 45 * DAY) {
    const all = [...its];
    for (let a = d0; a <= d1; a = addDays(a, 7)) {
      const b = addDays(a, 6) < d1 ? addDays(a, 6) : d1;
      const part = await kiwiOneWay([s.from], [s.to], a, b, KIWI_MAX, ctx.meter, bags);
      if (part) all.push(...part);
    }
    const seen = new Set<string>();
    return kiwiToOptions(all.filter((it) => { const k = it.segs.map((x) => x.flightNo + x.dep).join("|"); if (seen.has(k)) return false; seen.add(k); return true; }), s.from, s.to);
  }
  return kiwiToOptions(its, s.from, s.to);
}

async function dayOptions(s: Seg, days: string[], ctx: Ctx): Promise<FlightOption[] | null> {
  // all days at once (Google's pool keeps the pace)
  const per = await Promise.all(days.map(async (d) => {
    const parts: FlightOption[][] = [];
    const g = await googleOneWay(s.from, s.to, d, ctx.meter).catch(() => null);
    // with a checked bag: Google's fares plus the bag fee where the carrier charges it (like for like)
    if (g) parts.push(ctx.params.baggage === "checked" ? g.map((o) => { const bag = optionBagFee(o); return { ...o, price: o.price + bag, bag }; }) : g);
    if (hasSerp() && !g) { const sg = await googleFlights(s.from, s.to, d, ctx.meter).catch(() => null); if (sg) parts.push(sg); }
    if (hasDuffel()) { const du = await duffel(s.from, s.to, d, ctx.meter).catch(() => null); if (du) parts.push(du); }
    return parts.length ? parts.flat() : null;
  }));
  return per.some(Boolean) ? per.flatMap((x) => x ?? []) : null;
}

/** Nights spent at a place between arrival and departure (each 2 a.m. local passed, gaps over 6 h). */
export function nightsAt(arr: number, dep: number, tz: string): number {
  if (dep - arr < 6 * HOUR) return 0;
  let n = 0;
  for (let t = arr; t <= dep; t += HOUR) if (utcToLocal(t, tz).slice(11, 13) === "02") n++;
  return n;
}

/** Minimum and maximum time (h) between two timed legs on separate tickets. */
function connRule(prev: Kind, next: Kind, local: Arc | undefined, p: SearchParams): [number, number] {
  const max = maxLayH(p);
  if (local) return [Math.max(next === "flight" ? p.minConnChangeH : 1, (local.hours ?? 1) + (next === "flight" ? 2 : 0.5)), max];
  if (prev === "flight" && next === "flight") return [p.minConnSameH, max];
  if (prev === "bus" && next === "flight") return [2.5, Math.max(36, max)]; // positioning by bus, possibly the day before
  if (prev === "flight" && next === "bus") return [1.25, max];
  return [0.5, max];
}

type St = { opt: FlightOption; cost: number; prev: St | null; firstDep: number; local?: FlightOption; hotel: number; nights: number; lay: number };

/** Combine per-leg options into the cheapest itinerary for each first-departure day. */
function schedule(segs: Seg[], p: SearchParams): Itinerary[] {
  const timed = segs.filter((s) => s.kind !== "local");
  const localBefore = (ti: number): Seg | undefined => {
    const idx = segs.indexOf(timed[ti]);
    return idx > 0 && segs[idx - 1].kind === "local" ? segs[idx - 1] : undefined;
  };
  const lead = localBefore(0);
  const tail = segs[segs.length - 1].kind === "local" ? segs[segs.length - 1] : undefined;

  let layer = new Map<string, St[]>();
  for (const o of timed[0].options!) {
    let local: FlightOption | undefined;
    if (lead) {
      // leave early enough, in daytime, to be at the first departure with 2 h to spare
      const lt = localTransfer(lead.from, lead.to, o.dep - ((lead.arc.hours ?? 1) + 2.5) * HOUR, lead.arc.hours ?? 1, lead.arc.lb);
      if (!lt || lt.arr + 2 * HOUR > o.dep) continue;
      local = lt;
    }
    const g = isoDay(o.dep);
    const st: St = { opt: o, cost: o.price + (local?.price ?? 0), prev: null, firstDep: local?.dep ?? o.dep, local, hotel: 0, nights: 0, lay: 0 };
    if (!layer.has(g)) layer.set(g, []);
    layer.get(g)!.push(st);
  }
  for (let ti = 1; ti < timed.length; ti++) {
    const lb = localBefore(ti);
    const [minH, maxH] = connRule(timed[ti - 1].kind, timed[ti].kind, lb?.arc, p);
    const ap = AP[timed[ti].from];
    const next = new Map<string, St[]>();
    for (const [g, states] of layer) {
      const out: St[] = [];
      for (const o of timed[ti].options!) {
        let best: St | null = null;
        for (const s of states) {
          const gap = o.dep - s.opt.arr;
          if (gap < minH * HOUR || gap > maxH * HOUR) continue;
          if (o.arr - s.firstDep > maxDirH(p) * HOUR) continue;
          let local: FlightOption | undefined;
          if (lb) {
            const lt = localTransfer(lb.from, lb.to, s.opt.arr + 0.75 * HOUR, lb.arc.hours ?? 1, lb.arc.lb);
            if (!lt || lt.arr + (timed[ti].kind === "flight" ? 2 : 0.5) * HOUR > o.dep) continue;
            local = lt;
          }
          const nights = nightsAt(s.opt.arr, o.dep, ap.tz);
          if (nights && !p.allowOvernight) continue;
          const hotel = hotelPrice(p, nights, ap.region);
          const cost = s.cost + o.price + counted(p, hotel) + (local?.price ?? 0);
          if (!best || cost < best.cost) best = { opt: o, cost, prev: s, firstDep: s.firstDep, local, hotel, nights, lay: gap / HOUR };
        }
        if (best) out.push(best);
      }
      if (out.length) next.set(g, out);
    }
    layer = next;
  }
  const result: Itinerary[] = [];
  for (const states of layer.values()) {
    const end = states.reduce((a, b) => (b.cost < a.cost ? b : a));
    let tailLeg: FlightOption | undefined;
    if (tail) {
      const lt = localTransfer(tail.from, tail.to, end.opt.arr + 0.75 * HOUR, tail.arc.hours ?? 1, tail.arc.lb);
      if (!lt) continue;
      tailLeg = lt;
    }
    const chain: St[] = [];
    for (let s: St | null = end; s; s = s.prev) chain.unshift(s);
    const legs: Leg[] = [];
    chain.forEach((s, k) => {
      if (s.local) legs.push(s.local);
      legs.push({ ...s.opt, layoverH: k ? s.lay : undefined, overnight: s.nights > 0 || undefined, hotel: s.hotel || undefined, nights: s.nights || undefined });
    });
    if (tailLeg) legs.push(tailLeg);
    result.push({
      legs, price: Math.round(end.cost + (tailLeg?.price ?? 0)), firstDep: legs[0].dep,
      lastArr: legs[legs.length - 1].arr, estimated: legs.some((l) => l.estimated),
      overnights: chain.reduce((n, s) => n + s.nights, 0),
    });
  }
  return result.sort((a, b) => a.price - b.price);
}

/**
 * Verify a path for first departures within [d0, d1]. Calendars and Kiwi (one query per window)
 * come first; the bound is re-checked before every further query, so hopeless paths are cut early.
 */
export async function verifyPath(path: Path, d0: string, d1: string, ctx: Ctx, onLeg?: (from: string, to: string, state: string) => void): Promise<VerifyResult> {
  const segs: Seg[] = path.arcs.map((arc, i) => ({ arc, kind: kindOf(arc), from: path.nodes[i], to: path.nodes[i + 1] }));
  const [w0, w1] = legWindow(d0, d1, ctx.params.maxLegs, ctx.params.stopoverDays);
  const known = (s: Seg) => s.options ? Math.min(...s.options.map((o) => o.price)) : Math.max(s.arc.lb, ctx.legMins.get(s.from + s.to) ?? 0);
  const optimistic = () => segs.reduce((t, s) => t + known(s), 0);
  const prune = (): VerifyResult | null => { const b = optimistic(); return b >= ctx.threshold() ? { status: "pruned", bound: b } : null; };
  const dead = (s: Seg, why: string): VerifyResult => {
    onLeg?.(s.from, s.to, "dead");
    ctx.legMins.set(s.from + s.to, Infinity);
    return { status: "infeasible", reason: why, deadArc: s.from + s.to };
  };
  const unverified = (s: Seg): VerifyResult => {
    onLeg?.(s.from, s.to, "dead");
    return { status: "infeasible", reason: `nie udało się sprawdzić ${s.from}-${s.to}`, unverified: true };
  };
  const setOpts = (s: Seg, opts: FlightOption[], exactWindow: boolean) => {
    s.options = opts;
    if (exactWindow) ctx.legMins.set(s.from + s.to, Math.min(...opts.map((o) => o.price)));
    onLeg?.(s.from, s.to, "ok");
  };
  const locals = segs.filter((s) => s.kind === "local");
  for (const s of locals) s.options = []; // priced inside the schedule

  // 0) arcs already priced for the whole window
  for (const s of segs) {
    const pre = s.kind === "flight" ? ctx.preOptions?.get(s.from + s.to) : undefined;
    if (!pre) continue;
    if (!pre.length) return dead(s, `brak lotów ${s.from}-${s.to}`);
    setOpts(s, pre, true);
  }
  // 1a) bounds first: one "everything from X" query per airport (Ryanair window, Kiwi batch)
  // prices most arcs at once, so most hopeless paths are cut before any per-route calendar
  for (const s of segs) {
    if (s.kind !== "flight" || s.options) continue;
    await ctx.prefetch?.(s.from);
    await ctx.batch?.(s.from);
    const pre = ctx.preOptions?.get(s.from + s.to);
    if (pre) {
      if (!pre.length) return dead(s, `brak lotów ${s.from}-${s.to}`);
      setOpts(s, pre, true);
    }
    const p = prune(); if (p) return p;
  }
  // 1b) low-cost calendars, whole window: all legs of the path at once
  const calSegs = segs.filter((s) => s.kind === "flight" && !s.options && isCalendar(s.arc));
  for (const s of calSegs) await ctx.prefetch?.(s.from);
  { const p = prune(); if (p) return p; }
  calSegs.forEach((s) => onLeg?.(s.from, s.to, "checking"));
  const calRes = new Map(await Promise.all(calSegs.map(async (s) => [s, await calendarOptions(s, w0, w1, ctx)] as const)));
  for (const s of calSegs) {
    const p = prune(); if (p) return p;
    const opts = calRes.get(s)!;
    if (opts === null) { if (!isKiwi(s.arc)) return unverified(s); continue; }
    if (!opts.length) { if (!isKiwi(s.arc)) return dead(s, `brak lotów ${s.from}-${s.to}`); continue; }
    setOpts(s, opts, true);
  }
  // 2) Kiwi, whole window (covers airlines without public calendars); batched per airport
  for (const s of segs) {
    if (s.kind !== "flight" || s.options) continue;
    await ctx.batch?.(s.from);
    const pre = ctx.preOptions?.get(s.from + s.to);
    if (pre) {
      if (!pre.length) return dead(s, `brak lotów ${s.from}-${s.to}`);
      setOpts(s, pre, true);
      continue;
    }
    if (!isKiwi(s.arc)) continue;
    const p = prune(); if (p) return p;
    onLeg?.(s.from, s.to, "checking");
    const opts = await kiwiOptions(s, w0, w1, ctx);
    if (opts === null) continue; // fall through to Google
    if (!opts.length) return dead(s, `brak lotów ${s.from}-${s.to}`);
    setOpts(s, opts, true);
  }
  // 3) Google Flights on the most promising days (sampled, so it does not tighten arc bounds)
  for (let k = 0; k < segs.length; k++) {
    const s = segs[k];
    if (s.kind !== "flight" || s.options) continue;
    const p = prune(); if (p) return p;
    if (!ctx.meter.canGoogle(config.googleReserve)) return unverified(s);
    onLeg?.(s.from, s.to, "checking");
    const days = pickDays(segs, k, w0, w1, ctx.params);
    const opts = await dayOptions(s, days, ctx);
    if (opts === null) return unverified(s);
    if (!opts.length) return dead(s, `brak lotów ${s.from}-${s.to} w sprawdzonych dniach`);
    setOpts(s, opts, false);
  }
  // 4) buses, on the days the neighbouring flights need
  for (let k = 0; k < segs.length; k++) {
    const s = segs[k];
    if (s.kind !== "bus") continue;
    const p = prune(); if (p) return p;
    onLeg?.(s.from, s.to, "checking");
    const days = busDays(segs, k);
    const res = await Promise.all(days.map((d) => flixRides(s.from, s.to, d, ctx.meter)));
    const reached = res.some(Boolean);
    // the ride from home to the departure airport (or back) within the access-time limit, by its real timetable
    const access = ctx.params.origin.includes(s.from) || ctx.params.origin.includes(s.to);
    const lim = accessLimitH(ctx.params);
    const opts: FlightOption[] = res.flatMap((r) => r ?? []).filter((o) => !access || (o.arr - o.dep) / 3_600_000 <= lim);
    if (!reached) return unverified(s);
    if (!opts.length) return dead(s, `brak autobusu ${s.from}-${s.to}`);
    setOpts(s, opts, false);
  }
  const p = prune(); if (p) return p;
  // later legs may fly after the window, the trip itself starts in it (a bus to the airport a day early)
  const its = schedule(segs, ctx.params).filter((it) => { const d = utcToLocal(it.firstDep, AP[it.legs[0].from].tz).slice(0, 10); return d >= addDays(d0, -1) && d <= d1; });
  if (!its.length) return { status: "infeasible", reason: "nie da się spiąć przesiadek w tych dniach" };
  return { status: "ok", itineraries: its, minPrice: its[0].price };
}

/** Days for a bus leg: around the cheapest departures of the flight after it (or arrivals before it). */
function busDays(segs: Seg[], k: number): string[] {
  const after = segs.slice(k + 1).find((s) => s.kind !== "local");
  const before = [...segs.slice(0, k)].reverse().find((s) => s.kind !== "local");
  const days = new Set<string>();
  const cheapest = (o: FlightOption[] | undefined) => (o ?? []).slice().sort((a, b) => a.price - b.price).slice(0, 2);
  if (after?.options) for (const o of cheapest(after.options)) { const d = utcToLocal(o.dep, AP[after.from].tz).slice(0, 10); days.add(d); days.add(addDays(d, -1)); }
  else if (before?.options) for (const o of cheapest(before.options)) { const d = utcToLocal(o.arr, AP[before.to].tz).slice(0, 10); days.add(d); days.add(addDays(d, 1)); }
  return [...days].sort().slice(0, 4);
}

/** Choose dates for a per-day leg: compatible with neighbouring legs' known departures, cheapest first. */
function pickDays(segs: Seg[], k: number, a: string, b: string, p: SearchParams): string[] {
  const prev = [...segs.slice(0, k)].reverse().find((s) => s.kind === "flight")?.options;
  const next = segs.slice(k + 1).find((s) => s.kind === "flight")?.options;
  const scored: [string, number][] = [];
  const stay = (p.stopoverDays ?? 0) * DAY;
  for (let d = a; d <= b; d = addDays(d, 1)) {
    const t = Date.parse(d + "T12:00:00Z");
    let score = 0;
    if (prev) {
      const ok = prev.filter((o) => o.arr + p.minConnSameH * HOUR <= t + 10 * HOUR && o.arr > t - 1.5 * DAY - stay);
      if (!ok.length) continue;
      score += Math.min(...ok.map((o) => o.price));
    }
    if (next) {
      const ok = next.filter((o) => o.dep >= t && o.dep < t + 2 * DAY + stay);
      if (!ok.length) continue;
      score += Math.min(...ok.map((o) => o.price));
    }
    scored.push([d, score]);
  }
  scored.sort((x, y) => x[1] - y[1] || (x[0] < y[0] ? -1 : 1));
  const picks: string[] = [];
  for (const [d] of scored) {
    if (picks.length >= config.maxSerpDatesPerLeg * (p.flexMode === "month" ? 2 : 1)) break;
    if (!prev && !next && picks.some((q) => Math.abs(Date.parse(q) - Date.parse(d)) < 3 * DAY)) continue; // spread unconstrained picks
    picks.push(d);
  }
  return picks.length ? picks : [a];
}

const isGround = (l: FlightOption) => l.source === "flixbus" || l.source === "local" || l.source === "ground";

export function riskFlags(legs: Leg[], p: SearchParams, destCc?: string, window?: { from: string; to: string }): string[] {
  const flags = new Set<string>();
  const flightLegs = legs.filter((l) => !isGround(l) && l.price > 0);
  const perDir = new Map<string, number>();
  for (const l of flightLegs) { const d = (l as { dir?: string }).dir ?? "out"; perDir.set(d, (perDir.get(d) ?? 0) + 1); }
  if ([...perDir.values()].some((n) => n > 1)) flags.add("osobne bilety");
  if (legs.slice(1, -1).some((l) => l.source === "local")) flags.add("zmiana lotniska");
  if (legs.some((l) => l.source === "flixbus")) flags.add("autobus");
  if (legs.some((l) => l.overnight)) flags.add("nocleg");
  const dirOf = (l: Leg) => (l as { dir?: string }).dir;
  const stops = legs.filter((l, i) => i > 0 && (l.layoverH ?? 0) >= 20 && dirOf(l) === dirOf(legs[i - 1]) && !isGround(l) && !isGround(legs[i - 1]));
  for (const l of stops) flags.add(`${Math.round((l.layoverH ?? 0) / 24) || 1} dni w ${AP[l.from]?.city ?? l.from}`);
  if (legs.some((l, i) => i > 0 && !isGround(l) && (l.layoverH ?? 99) < p.minConnSameH + 1)) flags.add("krótka przesiadka");
  if (legs.some((l) => l.note?.startsWith("bilet powrotny"))) flags.add("bilet powrotny w hubie");
  if (legs.some((l) => l.estimated)) flags.add("cena szacunkowa");
  if (legs.some((l) => l.arrEstimated && !l.estimated)) flags.add("godz. przylotu szacowana");
  if (window && legs[0] && (legs[0].depLocal.slice(0, 10) < window.from || legs[0].depLocal.slice(0, 10) > window.to)) flags.add("data poza zakresem (±3 dni)");
  const countries = new Set(flightLegs.filter((l, i) => flightLegs[i + 1] && (l as { dir?: string }).dir === (flightLegs[i + 1] as { dir?: string }).dir).map((l) => AP[l.to]?.cc).filter((c): c is string => !!c));
  if (destCc) countries.add(destCc);
  for (const cc of countries) if (VISA_NOTE[cc]) flags.add(`wiza/tranzyt: ${cc} ${VISA_NOTE[cc]}`);
  if (p.baggage === "cabin" && flightLegs.some((l) => l.source === "ryanair" || l.source === "wizz")) flags.add("tylko mały bagaż");
  return [...flags];
}
