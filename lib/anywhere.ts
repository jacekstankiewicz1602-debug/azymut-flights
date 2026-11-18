// "Anywhere cheap": only a budget and a date range. Returns the cheapest destinations (the whole world
// for "gdziekolwiek", far ones for "poza Europą"), one trip
// per city, each priced live:
//  1. Kiwi per continent and per Asian country from all home airports (one query covers the whole
//     window and every destination in it; self-transfer combinations included)
//  2. map candidates the Kiwi answers missed (bound under the budget), queried in batches of 25
//  3. for destinations whose map bound is well under the best live price, the cheapest map paths
//     are verified leg by leg (separate tickets the way the main engine builds them)
import { AP, km } from "./airports";
import { config } from "./config";
import { dijkstra, type Emit, type RunOptions, type SearchResult, type Trip, type TripLeg } from "./engine";
import { withDeparture } from "./departure";
import { buildGraph } from "./map";
import { PathEnumerator } from "./paths";
import { flixRides } from "./sources/flixbus";
import { Meter } from "./sources/http";
import { KIWI_MAX, kiwiLegs, kiwiOneWay, type KItin } from "./sources/kiwi";
import { addDays, HOUR, isoDay, monthsBetween, utcToLocal } from "./time";
import type { FlightOption, SearchParams } from "./types";
import { riskFlags, verifyPath, type Itinerary } from "./verify";

const CONTINENTS = ["south-america", "north-america", "asia", "africa", "oceania"];
const COUNTRIES = "TH VN ID PH LK IN JP CN AE EG US MX DO BR".split(" ");
// Kiwi's continent/country answers come in groups of 4 departure airports: the trip's origin and the
// biggest airports within reach keep it to two groups per query
const ANY_HOME = "WAW BER KRK WMI KTW WRO GDN PRG VIE BUD".split(" ");

export async function runAnywhere(params: SearchParams, emit: Emit, signal?: AbortSignal, opts: RunOptions = {}): Promise<SearchResult> {
  const p = withDeparture(params);
  const t0 = Date.now();
  const deadline = opts.deadline ?? t0 + config.maxSearchSeconds * 1000;
  const meter = new Meter(undefined, undefined, opts.meterBase);
  const budget = p.budget ?? 1500;
  const destSet = new Set(p.dest);
  const tomorrow = isoDay(Date.now() + 86400_000);
  const d0 = p.dateFrom < tomorrow ? tomorrow : p.dateFrom, d1 = p.dateTo;
  const pool = new Set([...p.origin, ...p.ground!]);
  const home = [...new Set([...(p.access === false ? [] : p.origin), ...ANY_HOME.filter((c) => pool.has(c)), ...pool])].slice(0, 8);
  const checked = p.baggage === "checked";
  const notes: string[] = [];

  emit("status", { phase: "kiwi", message: "Najtańsze kierunki: Kiwi po kontynentach i krajach, z wszystkich lotnisk wylotu" });
  const best = new Map<string, KItin>(); // per destination airport
  const take = (its: KItin[] | null) => {
    for (const it of its ?? []) {
      const to = it.segs[it.segs.length - 1].to;
      if (!destSet.has(to) || !it.segs.every((x) => AP[x.from] && AP[x.to])) continue;
      const cur = best.get(to);
      if (!cur || it.price < cur.price) best.set(to, it);
    }
  };
  const withEurope = p.dest.some((c) => AP[c]?.region === "EUR");
  for (const c of withEurope ? ["europe", ...CONTINENTS] : CONTINENTS) {
    if (signal?.aborted || Date.now() > deadline - 30_000) break;
    take(await kiwiOneWay(home, [], d0, d1, KIWI_MAX, meter, checked, [`Continent:${c}`]));
  }
  for (const cc of COUNTRIES) {
    if (signal?.aborted || Date.now() > deadline - 30_000) break;
    take(await kiwiOneWay(home, [], d0, d1, KIWI_MAX, meter, checked, [`Country:${cc}`]));
  }

  // map candidates under the budget that no answer covered yet
  const months = monthsBetween(d0, d1);
  const g = await buildGraph(months, checked, p.origin, p.ground);
  const reach = dijkstra(g.graph, p.origin, false);
  const cands = p.dest.filter((c) => (reach.get(c) ?? Infinity) <= budget).sort((a, b) => reach.get(a)! - reach.get(b)!);
  const missing = cands.filter((c) => !best.has(c));
  emit("status", { phase: "search", message: `Mapa: ${cands.length} kierunków z dolną granicą poniżej ${budget} zł, dopytuję brakujące` });
  for (let k = 0; k < missing.length && k < 150; k += 25) {
    if (signal?.aborted || Date.now() > deadline - 30_000) break;
    take(await kiwiOneWay(home, missing.slice(k, k + 25), d0, d1, KIWI_MAX, meter, checked));
  }

  // bus from home to the airport the itinerary starts at (real FlixBus ride, the day before or same day)
  async function toItinerary(it: KItin): Promise<Itinerary | null> {
    const legs: FlightOption[] = kiwiLegs(it.segs, it.price, it.link).map((l, i, a) => ({
      ...l, note: a.length > 1 ? (i === 0 ? `cena za całą rezerwację Kiwi (${a.length} odc.)` : "w cenie rezerwacji Kiwi") : undefined,
    }));
    let price = Math.round(it.price);
    const first = legs[0];
    if (!p.origin.includes(first.from)) {
      const day = utcToLocal(first.dep, AP[first.from].tz).slice(0, 10);
      let ride: FlightOption | null = null;
      for (const d of [addDays(day, -1), day]) {
        for (const r of (await flixRides(p.origin[0], first.from, d, meter)) ?? []) {
          if (r.arr + 2.5 * HOUR <= first.dep && first.dep - r.arr < 30 * HOUR && (!ride || r.price < ride.price)) ride = r;
        }
      }
      if (!ride) return null;
      legs.unshift(ride);
      price += ride.price;
    }
    const withLay = legs.map((l, i) => ({ ...l, layoverH: i ? (l.dep - legs[i - 1].arr) / HOUR : undefined }));
    return { legs: withLay, price, firstDep: withLay[0].dep, lastArr: withLay[withLay.length - 1].arr, estimated: false, overnights: 0 };
  }

  const trips = new Map<string, Trip>(); // per destination city
  const accept = (dest: string, it: Itinerary, origin: Trip["origin"]) => {
    const city = AP[dest].city.split("-")[0];
    const cur = trips.get(city);
    if (cur && cur.price <= it.price) return;
    const legs: TripLeg[] = it.legs.map((l) => ({ ...l, dir: "out" as const }));
    const t: Trip = {
      id: `any-${dest}`, price: Math.round(it.price), lb: Math.round(reach.get(dest) ?? it.price), legs,
      nodes: [legs[0].from, ...legs.map((l) => l.to)], flags: riskFlags(legs, p, AP[dest].cc), origin,
      estimated: false, travelH: Math.round((it.lastArr - it.firstDep) / HOUR),
      outDate: utcToLocal(it.firstDep, AP[legs[0].from].tz).slice(0, 10), retDate: null, stayDays: null,
    };
    if (origin === "kiwi") t.flags.unshift("kombinacja Kiwi");
    trips.set(city, t);
    emit("best", t);
  };
  const ranked = [...best.entries()].filter(([, it]) => it.price <= budget * 1.1).sort((a, b) => a[1].price - b[1].price).slice(0, 60);
  for (const [dest, it] of ranked) {
    if (Date.now() > deadline - 15_000) break;
    const iti = await toItinerary(it);
    if (iti && iti.price <= budget) accept(dest, iti, "kiwi");
  }

  // separate-ticket paths from the map where the bound promises clearly less than the live best
  emit("status", { phase: "search", message: "Sprawdzam trasy z osobnych biletów tam, gdzie mapa obiecuje mniej" });
  const promising = cands.filter((c) => {
    const live = trips.get(AP[c].city.split("-")[0])?.price ?? budget;
    return (reach.get(c) ?? Infinity) < live - 80;
  }).slice(0, 10);
  let checkedCount = 0;
  const vEnd = d1 < addDays(d0, 45) ? d1 : addDays(d0, 45); // one month and a half of calendars per leg
  for (const dest of promising) {
    if (signal?.aborted || Date.now() > deadline - 20_000) break;
    const cap = () => Math.min(budget, trips.get(AP[dest].city.split("-")[0])?.price ?? budget);
    const e = new PathEnumerator(g.graph, p.origin, new Set([dest]), p.maxLegs, cap, 200_000, 200_000);
    e.deadline = deadline - 20_000;
    for (let k = 0; k < 2; k++) {
      const path = await e.next();
      if (!path) break;
      checkedCount++;
      const r = await verifyPath(path, d0, vEnd, { params: p, meter, threshold: cap, signal, legMins: new Map() }, (from, to, state) => emit("leg", { from, to, state }));
      if (r.status === "ok") accept(dest, r.itineraries[0], "azymut");
    }
  }

  const list = [...trips.values()].filter((t) => t.price <= budget).sort((a, b) => a.price - b.price);
  notes.push(`Tryb „gdziekolwiek tanio”: ${list.length} kierunków ${withEurope ? "na całym świecie" : "poza Europą"} w budżecie ${budget} zł (${d0} – ${d1}); jeden, najtańszy wynik na miasto.`);
  if (!list.length) notes.push("Nic w budżecie: spróbuj wyższej kwoty albo szerszego okna dat.");
  const stats = { ...meter.snapshot(), checked: best.size + checkedCount, pruned: 0, ms: Date.now() - t0 };
  return {
    trips: list.slice(0, 30), baseline: null, savings: null, provenOptimal: false, gap: null, summary: "", stats, notes,
    paused: Date.now() > deadline - 20_000, lowerBound: null, unverified: 0, truncated: false,
  };
}
