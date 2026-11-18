// Kiwi.com public GraphQL (the one kiwi.com itself uses). Gives long-haul fares, "anywhere"
// searches for the world map and its own self-transfer combinations.
import { AP } from "../airports";
import { recordDuration } from "../durations";
import type { FlightOption } from "../types";
import { cachedJson, priceTtl, Meter, pace, politeFetch, randomUA } from "./http";

/** Kiwi returns at most this many itineraries per query, whatever limit is asked for. */
export const KIWI_MAX = 50;

const SEG = `segment { source { localTime utcTime station { code } } destination { localTime utcTime station { code } } carrier { code name } code }`;

const ONEWAY = `query SearchOneWayItinerariesQuery($search: SearchOnewayInput, $filter: ItinerariesFilterInput, $options: ItinerariesOptionsInput) {
  onewayItineraries(search: $search, filter: $filter, options: $options) {
    __typename
    ... on AppError { error: message }
    ... on Itineraries { itineraries { __typename ... on ItineraryOneWay {
      id price { amount } bookingOptions { edges { node { bookingUrl } } } sector { sectorSegments { ${SEG} } } } } }
  }
}`;

const RETURN = `query SearchReturnItinerariesQuery($search: SearchReturnInput, $filter: ItinerariesFilterInput, $options: ItinerariesOptionsInput) {
  returnItineraries(search: $search, filter: $filter, options: $options) {
    __typename
    ... on AppError { error: message }
    ... on Itineraries { itineraries { __typename ... on ItineraryReturn {
      id price { amount } bookingOptions { edges { node { bookingUrl } } }
      outbound { sectorSegments { ${SEG} } } inbound { sectorSegments { ${SEG} } } } } }
  }
}`;

export type KSeg = { from: string; to: string; depLocal: string; arrLocal: string; dep: number; arr: number; carrier: string; flightNo: string };
export type KItin = { price: number; segs: KSeg[]; link: string };
export type KReturn = { price: number; out: KSeg[]; ret: KSeg[]; link: string };

type RawSeg = { segment: { source: { localTime: string; utcTime: string; station: { code: string } }; destination: { localTime: string; utcTime: string; station: { code: string } }; carrier: { code: string; name: string }; code: string } };
const seg = (s: RawSeg): KSeg => ({
  from: s.segment.source.station.code, to: s.segment.destination.station.code,
  depLocal: s.segment.source.localTime.slice(0, 16), arrLocal: s.segment.destination.localTime.slice(0, 16),
  dep: Date.parse(s.segment.source.utcTime), arr: Date.parse(s.segment.destination.utcTime),
  carrier: s.segment.carrier.name, flightNo: s.segment.carrier.code + s.segment.code,
});
const link = (it: { bookingOptions?: { edges: { node: { bookingUrl: string } }[] } }) => {
  const u = it.bookingOptions?.edges?.[0]?.node?.bookingUrl;
  return u ? (u.startsWith("http") ? u : `https://www.kiwi.com${u}`) : "https://www.kiwi.com/pl/";
};

function learn(segs: KSeg[]) {
  const seen = new Set<string>();
  for (const s of segs) if (!seen.has(s.from + s.to)) { seen.add(s.from + s.to); void recordDuration(s.from, s.to, (s.arr - s.dep) / 60_000); }
}

const ids = (codes: string[]) => codes.map((c) => `Station:airport:${c}`);
const passengers = { adults: 1, children: 0, infants: 0, adultsHoldBags: [0], adultsHandBags: [0], childrenHoldBags: [], childrenHandBags: [] };
const options = { sortBy: "PRICE", mergePriceDiffRule: "INCREASED", currency: "pln", locale: "en", market: "pl", partner: "skypicker", partnerMarket: "pl", storeSearch: false, searchStrategy: "REDUCED", abTestInput: {} };
const filter = (limit: number, bags: boolean) => ({
  allowDifferentStationConnection: true, enableSelfTransfer: true, enableThrowAwayTicketing: false, enableTrueHiddenCity: false,
  transportTypes: ["FLIGHT"], contentProviders: ["KIWI", "FRESH", "KAYAK"], limit, ...(bags ? {} : {}),
});

async function gql<T>(feature: string, query: string, variables: unknown, meter: Meter): Promise<T | null> {
  if (!meter.can("kiwi")) return null;
  await pace("kiwi", 500 + Math.random() * 500);
  meter.add("kiwi", false);
  const text = await politeFetch(`https://api.skypicker.com/umbrella/v2/graphql?featureName=${feature}`, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": randomUA(), origin: "https://www.kiwi.com", referer: "https://www.kiwi.com/" },
    body: JSON.stringify({ query, variables }),
  }, "kiwi");
  if (!text) return null;
  try {
    const j = JSON.parse(text);
    if (j.errors) { console.warn("[kiwi]", JSON.stringify(j.errors).slice(0, 200)); return null; }
    return j.data as T;
  } catch { return null; }
}

/** Point of sale: Kiwi's market and the currency prices come in (default Poland, PLN). */
export type KMarket = { cc: string; currency: string };

/** One-way itineraries between airport sets over a date window, cheapest first. With a market,
 *  prices are in that market's currency (convert with lib/fx). */
export async function kiwiOneWay(
  from: string[], to: string[], d0: string, d1: string, limit: number, meter: Meter, bags = false, rawDest: string[] = [], market?: KMarket,
): Promise<KItin[] | null> {
  // With more than ~4 departure airports Kiwi silently returns fewer rows, or none, and drops
  // cheap ones (27 origins -> Poland-Asia March: cheapest 1182 zł; the same 4 big airports alone:
  // 1052 zł). Such queries go in groups of 4, merged by price: the merged top 50 is still a valid
  // price floor, and a failed group makes the whole answer unknown.
  if (from.length > 4) {
    // the groups of four at once (the Kiwi pool caps the requests in flight)
    const groups = Array.from({ length: Math.ceil(from.length / 4) }, (_, i) => from.slice(i * 4, i * 4 + 4));
    const parts = await Promise.all(groups.map((g) => kiwiOneWay(g, to, d0, d1, limit, meter, bags, rawDest, market)));
    if (parts.every((r) => !r)) return null;
    return parts.flatMap((r) => r ?? []).sort((a, b) => a.price - b.price).slice(0, KIWI_MAX);
  }
  const mk = market && market.cc !== "pl" ? `:${market.cc}` : "";
  const opts = mk ? { ...options, currency: market!.currency.toLowerCase(), market: market!.cc, partnerMarket: market!.cc } : options;
  const key = `kiwi:ow:${from.join(",")}:${[...to, ...rawDest].join(",") || "ANY"}:${d0}:${d1}:${limit}:${bags}${mk}`;
  const { value } = await cachedJson<KItin[]>(key, priceTtl(d0), async () => {
    const data = await gql<{ onewayItineraries: { itineraries?: { price: { amount: string }; sector: { sectorSegments: RawSeg[] } }[] } }>(
      "SearchOneWayItinerariesQuery", ONEWAY, {
        search: { itinerary: { source: { ids: ids(from) }, destination: { ids: [...ids(to), ...rawDest] }, outboundDepartureDate: { start: `${d0}T00:00:00`, end: `${d1}T23:59:59` } },
          passengers: { ...passengers, adultsHoldBags: [bags ? 1 : 0] }, cabinClass: { cabinClass: "ECONOMY", applyMixedClasses: false } },
        filter: filter(limit, bags), options: opts,
      }, meter);
    const its = data?.onewayItineraries?.itineraries;
    if (!its) return null;
    const out = its.map((it) => ({ price: Number(it.price.amount), segs: it.sector.sectorSegments.map(seg), link: link(it as never) }))
      .filter((it) => it.segs.every((s) => Number.isFinite(s.dep)));
    learn(out.flatMap((it) => it.segs));
    return out;
  });
  return value;
}

/** Kiwi's own return combinations (including self-transfer), cheapest first. */
export async function kiwiReturn(
  from: string[], to: string[], out0: string, out1: string, in0: string, in1: string, meter: Meter, bags = false,
): Promise<KReturn[] | null> {
  const key = `kiwi:rt:${from.join(",")}:${to.join(",")}:${out0}:${out1}:${in0}:${in1}:${bags}`;
  const { value } = await cachedJson<KReturn[]>(key, priceTtl(out0), async () => {
    const data = await gql<{ returnItineraries: { itineraries?: { price: { amount: string }; outbound: { sectorSegments: RawSeg[] }; inbound: { sectorSegments: RawSeg[] } }[] } }>(
      "SearchReturnItinerariesQuery", RETURN, {
        search: { itinerary: { source: { ids: ids(from) }, destination: { ids: ids(to) },
          outboundDepartureDate: { start: `${out0}T00:00:00`, end: `${out1}T23:59:59` }, inboundDepartureDate: { start: `${in0}T00:00:00`, end: `${in1}T23:59:59` } },
          passengers: { ...passengers, adultsHoldBags: [bags ? 1 : 0] }, cabinClass: { cabinClass: "ECONOMY", applyMixedClasses: false } },
        filter: filter(60, bags), options,
      }, meter);
    const its = data?.returnItineraries?.itineraries;
    if (!its) return null;
    const out = its.map((it) => ({ price: Number(it.price.amount), out: it.outbound.sectorSegments.map(seg), ret: it.inbound.sectorSegments.map(seg), link: link(it as never) }));
    learn(out.flatMap((it) => [...it.out, ...it.ret]));
    return out;
  });
  return value;
}

/** Cheapest fare per destination from one airport over a window ("anywhere"), for the world map. */
export async function kiwiAnywhere(origin: string, d0: string, d1: string, meter: Meter): Promise<{ to: string; price: number; date: string; direct: boolean }[] | null> {
  const its = await kiwiOneWay([origin], [], d0, d1, 500, meter);
  if (!its) return null;
  const best = new Map<string, { to: string; price: number; date: string; direct: boolean }>();
  for (const it of its) {
    const last = it.segs[it.segs.length - 1].to;
    if (!AP[last]) continue;
    const cur = best.get(last);
    if (!cur || it.price < cur.price) best.set(last, { to: last, price: it.price, date: it.segs[0].depLocal.slice(0, 10), direct: it.segs.length === 1 });
  }
  return [...best.values()];
}

/** Kiwi segments as flight legs; the ticket price sits on the first segment of each Kiwi booking. */
export function kiwiLegs(segs: KSeg[], price: number, linkUrl: string): FlightOption[] {
  return segs.map((s, i) => ({
    from: s.from, to: s.to, dep: s.dep, arr: s.arr, depLocal: s.depLocal, arrLocal: s.arrLocal,
    price: i === 0 ? price : 0, carrier: s.carrier, flightNo: s.flightNo, source: "kiwi" as const, link: linkUrl,
  }));
}
