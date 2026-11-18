// Price techniques applied to finished trips, and the per-technique savings shown with each trip:
//  - market: the same flight bought on another point of sale (Kiwi market + currency), in PLN
//  - rt-as-ow: a return ticket on a long leg used one way when it is cheaper than the one-way
//  - memory: the best routes of earlier similar searches, re-verified live as a starting price
//  - google: the plain Google offer as a trip, so a result is never worse than the baseline
import { AP, km } from "./airports";
import { sqlClient } from "./db";
import type { Trip, TripLeg } from "./engine";
import { MARKETS, ratesPln, toPln } from "./fx";
import type { Meter } from "./sources/http";
import { viaOf, type GResult } from "./sources/google";
import { kiwiOneWay, kiwiReturn, type KSeg } from "./sources/kiwi";
import { addDays, HOUR, localToUtc } from "./time";
import type { Saving, SearchParams } from "./types";

const ground = (l: { source: string }) => l.source === "flixbus" || l.source === "local" || l.source === "ground";
const LONG_KM = 2500;

/** The Kiwi itinerary that is exactly this leg's flight(s): same flight numbers, else same times. */
function sameFlight(l: TripLeg, segs: KSeg[]): boolean {
  if (segs[0].from !== l.from || segs[segs.length - 1].to !== l.to) return false;
  const nos = segs.map((s) => s.flightNo).join(" / ");
  if (l.flightNo && /^[A-Z0-9]{2}\d/.test(l.flightNo)) return nos === l.flightNo;
  return Math.abs(segs[0].dep - l.dep) < 10 * 60_000 && Math.abs(segs[segs.length - 1].arr - l.arr) < 10 * 60_000;
}

/** Tickets of a trip: a priced flight leg plus the legs inside the same Kiwi booking (price 0).
 *  Hub return tickets and legs already changed by a technique are left out. */
function tickets(legs: TripLeg[]): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < legs.length; i++) {
    const l = legs[i];
    if (ground(l) || l.price <= 0 || l.note?.startsWith("bilet powrotny") || l.market || l.rtAsOw || l.source === "google" && /oferta Google/.test(l.note ?? "")) continue;
    let j = i;
    while (legs[j + 1] && legs[j + 1].price === 0 && legs[j + 1].note?.includes("rezerwacji Kiwi") && legs[j + 1].dir === l.dir) j++;
    // a return booking (price on the outbound, the inbound at 0 with the same link) is not a one-way ticket
    if (!legs.some((x, k) => (k < i || k > j) && x.price === 0 && x.link === l.link && !ground(x))) out.push([i, j]);
  }
  return out;
}

/** Whether a trip has a long ticket the market / return-ticket checks can work on. */
export const improvable = (t: Trip) => tickets(t.legs).some(([i, j]) => t.legs.slice(i, j + 1).some((x) => km(AP[x.from], AP[x.to]) >= LONG_KM));

/**
 * Market and return-ticket checks on a trip's long tickets. Each check is one Kiwi query per market
 * (cached), so this runs on the few best trips only.
 */
export async function improveTrip(t: Trip, p: SearchParams, meter: Meter, until: number): Promise<Trip> {
  const rates = await ratesPln();
  const legs = t.legs.map((l) => ({ ...l }));
  const savings: Saving[] = [...(t.savings ?? [])];
  const bags = p.baggage === "checked";
  for (const [i, j] of tickets(legs)) {
    const part = legs.slice(i, j + 1);
    if (!part.some((x) => km(AP[x.from], AP[x.to]) >= LONG_KM)) continue;
    // the ticket as one leg: first departure to last arrival, all flight numbers
    const l: TripLeg = { ...legs[i], to: legs[j].to, arr: legs[j].arr, flightNo: part.map((x) => x.flightNo).join(" / ") };
    if (j > i && !/^[A-Z0-9]{2}\d/.test(legs[i].flightNo)) continue;
    const day = l.depLocal.slice(0, 10);
    const route = `${l.from}–${l.to}`;
    // 1) point of sale: the same flight(s) on each market, converted at today's rate
    if (rates) {
      let best: { price: number; m: (typeof MARKETS)[number]; local: number; link: string } | null = null;
      for (const m of MARKETS) {
        if (Date.now() > until || !meter.can("kiwi")) break;
        const its = await kiwiOneWay([l.from], [l.to], day, day, 50, meter, bags, [], { cc: m.cc, currency: m.currency });
        const hit = (its ?? []).filter((it) => sameFlight(l, it.segs)).sort((a, b) => a.price - b.price)[0];
        if (process.env.AZ_DEBUG) console.log("MARKET", route, day, m.cc, its?.length ?? null, hit ? `${hit.price} ${m.currency} = ${Math.round(toPln(hit.price, m.currency, rates))} zł (ticket ${l.price})` : "no same flight");
        if (!hit) continue;
        const pln = Math.round(toPln(hit.price, m.currency, rates));
        if (!best || pln < best.price) best = { price: pln, m, local: Math.round(hit.price), link: hit.link };
      }
      // only a real difference counts (rounding of the conversion is ~1%)
      if (best && best.m.cc !== "pl" && best.price < l.price - Math.max(5, l.price * 0.01)) {
        const saved = l.price - best.price;
        savings.push({ technique: "market", label: `rynek ${best.m.cc.toUpperCase()} (${best.m.currency}) ${route}`, pln: saved });
        legs[i] = { ...legs[i], price: best.price, link: best.link, market: { cc: best.m.cc, currency: best.m.currency, label: best.m.label, local: best.local },
          note: `kup na rynku ${best.m.label} w ${best.m.currency} (${best.local.toLocaleString("pl-PL")} ${best.m.currency})${j > i ? `, rezerwacja ${route}` : ""}` };
      }
    }
    // 2) a return ticket on the same flight(s), cheaper than the one-way: fly out, skip the return
    if (Date.now() > until || !meter.can("kiwi")) continue;
    const cur = legs[i].price;
    const rts = await kiwiReturn([l.from], [l.to], day, day, addDays(day, 3), addDays(day, 30), meter, bags);
    const rt = (rts ?? []).filter((r) => sameFlight(l, r.out)).sort((a, b) => a.price - b.price)[0];
    if (process.env.AZ_DEBUG) console.log("RT-AS-OW", route, day, rts?.length ?? null, rt ? `return ${Math.round(rt.price)} vs one-way ${cur}` : "no same flight");
    if (rt && rt.price < cur - Math.max(10, cur * 0.02)) {
      const saved = Math.round(cur - rt.price);
      savings.push({ technique: "rt-as-ow", label: `bilet powrotny jako w jedną stronę ${route}`, pln: saved });
      legs[i] = { ...legs[i], price: Math.round(rt.price), link: rt.link, rtAsOw: true, market: undefined,
        note: `bilet powrotny ${l.from}–${l.to}–${l.from} użyty w jedną stronę: nie leć powrotnym (linia anuluje tylko ten odcinek)` };
    }
  }
  const added = savings.length - (t.savings?.length ?? 0);
  if (!added) return t;
  const price = Math.round(t.price - savings.slice(-added).reduce((s, x) => s + x.pln, 0));
  const flags = [...t.flags];
  if (legs.some((l) => l.rtAsOw)) flags.push("bilet powrotny w jedną stronę (powrót przepada)");
  if (legs.some((l) => l.market)) flags.push(`zakup na rynku ${legs.find((l) => l.market)!.market!.label}`);
  return { ...t, id: t.id + "|x", legs, price, savings, flags };
}

// ---------------------------------------------------------------- route memory

type MemRow = { out_nodes: string[]; out_kinds: string; ret_nodes: string[] | null; ret_kinds: string | null; price: number };
let memReady: Promise<void> | null = null;
async function mem() {
  const s = await sqlClient();
  if (!s) return null;
  memReady ??= (async () => {
    await s`create table if not exists route_memory (origins text[] not null, dests text[] not null, month text not null,
      out_nodes text[] not null, out_kinds text not null, ret_nodes text[], ret_kinds text, price int not null,
      updated_at timestamptz not null default now(), primary key (month, out_nodes, out_kinds, ret_nodes, ret_kinds))`.catch(() => {});
    await s`delete from route_memory where updated_at < now() - interval '30 days'`.catch(() => {});
  })();
  await memReady;
  return s;
}

const shape = (legs: TripLeg[], dir: "out" | "ret") => {
  const ls = legs.filter((l) => l.dir === dir);
  return ls.length ? { nodes: [ls[0].from, ...ls.map((l) => l.to)], kinds: ls.map((l) => (ground(l) ? "g" : "f")).join("") } : null;
};

/** Keep the top 20 trips of a search (route shapes, not schedules: they are re-verified live). */
export async function rememberTrips(p: SearchParams, trips: Trip[]) {
  const s = await mem().catch(() => null);
  if (!s) return;
  for (const t of trips.filter((x) => !x.google).slice(0, 20)) {
    const o = shape(t.legs, "out"), r = shape(t.legs, "ret");
    if (!o) continue;
    await s`insert into route_memory (origins, dests, month, out_nodes, out_kinds, ret_nodes, ret_kinds, price)
      values (${p.origin}, ${p.dest.slice(0, 200)}, ${t.outDate.slice(0, 7)}, ${o.nodes}, ${o.kinds}, ${r?.nodes ?? []}, ${r?.kinds ?? ""}, ${t.price})
      on conflict (month, out_nodes, out_kinds, ret_nodes, ret_kinds) do update set price = least(route_memory.price, excluded.price), updated_at = now()`.catch(() => {});
  }
}

/** Remembered route shapes for a similar search (overlapping origins and destinations, same months). */
export async function recallTrips(p: SearchParams, months: string[], limit = 8): Promise<{ out: { nodes: string[]; kinds: string }; ret: { nodes: string[]; kinds: string } | null; price: number }[]> {
  const s = await mem().catch(() => null);
  if (!s) return [];
  const rows = (await s`select out_nodes, out_kinds, ret_nodes, ret_kinds, price from route_memory
    where month = any(${months}) and origins && ${p.origin} and dests && ${p.dest.slice(0, 200)}
      and (${p.oneWay} = (coalesce(ret_kinds, '') = '')) order by price limit ${limit * 10}`.catch(() => [])) as unknown as MemRow[];
  // a row of a wide search (a region, "gdziekolwiek") overlaps almost any destination list: only routes
  // that really end here (and come back from here) belong to this search
  const dest = new Set(p.dest), back = new Set(p.destRet?.length ? p.destRet : p.dest), home = new Set([...p.origin, ...(p.ground ?? [])]);
  const fits = (r: MemRow) => dest.has(r.out_nodes[r.out_nodes.length - 1]) && home.has(r.out_nodes[0])
    && (!r.ret_kinds || (back.has(r.ret_nodes![0]) && home.has(r.ret_nodes![r.ret_nodes!.length - 1])));
  return rows.filter(fits).slice(0, limit).map((r) => ({ out: { nodes: r.out_nodes, kinds: r.out_kinds }, ret: r.ret_kinds ? { nodes: r.ret_nodes!, kinds: r.ret_kinds } : null, price: r.price }));
}

// ---------------------------------------------------------------- the plain Google offer as a trip

/** Airport code from a Google airport name among the candidates (token overlap with our names). */
export function airportByName(name: string | undefined, cands: string[]): string {
  if (!name) return cands[0];
  const toks = (s: string) => new Set(s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").split(/[^a-z]+/).filter((w) => w.length > 2 && w !== "airport" && w !== "international"));
  const g = toks(name);
  let best = cands[0], score = -1;
  for (const c of cands) {
    const a = AP[c];
    if (!a) continue;
    const mine = toks(`${a.name} ${a.city} ${a.cityEn}`);
    const sc = [...g].filter((w) => mine.has(w)).length;
    if (sc > score) { score = sc; best = c; }
  }
  return best;
}

export type GoogleOffer = {
  price: number; url: string; carriers: string; stops: number; depLocal: string; arrLocal: string;
  fromName?: string; toName?: string; retDate: string | null; layovers?: GResult["layovers"];
};

/** A trip made of the Google baseline offer (one ticket; the return's times are Google's, not shown here). */
export function googleTrip(g: GoogleOffer, origins: string[], dests: string[]): Trip {
  const from = airportByName(g.fromName, origins), to = airportByName(g.toName, dests);
  const dep = localToUtc(g.depLocal, AP[from].tz), arr = localToUtc(g.arrLocal, AP[to].tz);
  const legs: TripLeg[] = [{
    from, to, dep, arr, depLocal: g.depLocal, arrLocal: g.arrLocal, price: g.price, carrier: g.carriers, flightNo: g.stops ? `${g.stops} przes.` : "",
    source: "google", link: g.url, stops: g.stops, via: viaOf(g as GResult), dir: "out", note: g.retDate ? "zwykła oferta Google, cena za oba kierunki" : "zwykła oferta Google",
  }];
  if (g.retDate) {
    const t0 = localToUtc(`${g.retDate}T12:00`, AP[to].tz);
    legs.push({ from: to, to: from, dep: t0, arr: t0 + 12 * HOUR, depLocal: `${g.retDate}T12:00`, arrLocal: `${g.retDate}T12:00`, price: 0, carrier: g.carriers,
      flightNo: "", source: "google", link: g.url, dir: "ret", arrEstimated: true, note: "powrót w tej samej rezerwacji Google: godziny w ofercie" });
  }
  return {
    id: `google-${from}-${to}-${g.depLocal.slice(0, 10)}-${g.retDate ?? ""}`, price: g.price, lb: g.price, legs, nodes: [from, to, ...(g.retDate ? [from] : [])],
    flags: ["najtaniej wychodzi zwykła oferta", "jeden bilet"], origin: "azymut", estimated: false, travelH: Math.round((arr - dep) / HOUR),
    outDate: g.depLocal.slice(0, 10), retDate: g.retDate, stayDays: g.retDate ? Math.round((Date.parse(g.retDate) - Date.parse(g.depLocal.slice(0, 10))) / 86400_000) : null,
    google: true, savings: [],
  };
}

/** The rest of the difference to the plain offer: separate tickets themselves (never negative, never invented). */
export function withSeparateSaving(t: Trip, baseline: number | null): Trip {
  if (t.google || baseline === null) return t;
  const known = (t.savings ?? []).filter((s) => s.technique !== "separate");
  const rest = Math.round(baseline - t.price - known.reduce((s, x) => s + x.pln, 0));
  return { ...t, savings: rest > 0 ? [...known, { technique: "separate", label: "osobne bilety zamiast jednej oferty Google", pln: rest }] : known };
}

// ---------------------------------------------------------------- radar deals used by a trip

/** Legs that fly a verified radar deal (feed or anomaly): saving vs the route's norm price. */
export async function radarSavings(t: Trip): Promise<Saving[]> {
  const s = await sqlClient();
  if (!s) return [];
  const legs = t.legs.filter((l) => !ground(l) && l.price > 0);
  if (!legs.length) return [];
  const rows = (await s`select origin, dest, date, price, norm from radar_deals where active and norm is not null
    and origin = any(${legs.map((l) => l.from)}) and dest = any(${legs.map((l) => l.to)})`.catch(() => [])) as unknown as { origin: string; dest: string; date: string | null; price: number; norm: number }[];
  const out: Saving[] = [];
  for (const l of legs) {
    const d = rows.find((r) => r.origin === l.from && r.dest === l.to && (!r.date || Math.abs(Date.parse(r.date) - Date.parse(l.depLocal.slice(0, 10))) <= 3 * 86400_000));
    if (d && d.norm > l.price) out.push({ technique: "radar", label: `okazja z Radaru ${l.from}–${l.to} (norma ${d.norm} zł)`, pln: Math.round(d.norm - l.price) });
  }
  return out;
}
