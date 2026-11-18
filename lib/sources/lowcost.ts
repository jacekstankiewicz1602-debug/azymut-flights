// Ryanair and Wizz Air public fare-finder endpoints. Low volume, cached, paced, rotating UA.
import { AP, flightHours } from "../airports";
import { config } from "../config";
import { addDays, HOUR, localToUtc, utcToLocal } from "../time";
import type { FlightOption } from "../types";
import { knownDuration, recordDuration } from "../durations";
import { cachedJson, priceTtl, fetchJson, limited, Meter, pace, randomUA } from "./http";

const toPln = (amount: number, cur: string) => amount * (config.fx[cur] ?? NaN);
const bag = (carrier: string, checked: boolean) => (checked ? config.bagFee[carrier] ?? 0 : 0);

// ---------------- Ryanair ----------------

const FR = "https://www.ryanair.com/api/farfnd/v4";
const frHeaders = () => ({ "user-agent": randomUA(), accept: "application/json", "accept-language": "pl-PL,pl;q=0.9" });

export type MapFare = { to: string; price: number; date: string | null };

/** Cheapest one-way fare from `origin` to every Ryanair destination within a date range. */
export async function ryanairMap(origin: string, from: string, to: string, meter: Meter): Promise<MapFare[]> {
  const key = `fr:map:${origin}:${from}:${to}`;
  const { value, cached } = await cachedJson<MapFare[]>(key, 20 * 3600, async () => {
    if (!meter.can("ryanair")) return null;
    await pace("ryanair");
    meter.add("ryanair", false);
    const url = `${FR}/oneWayFares?departureAirportIataCode=${origin}&outboundDepartureDateFrom=${from}&outboundDepartureDateTo=${to}&currency=PLN&market=pl-pl`;
    const d = (await limited("ryanair", () => fetchJson(url, { headers: frHeaders() }))) as {
      fares: { outbound: { arrivalAirport: { iataCode: string }; departureDate: string; price: { value: number; currencyCode: string } } }[];
    };
    return d.fares.map((f) => ({
      to: f.outbound.arrivalAirport.iataCode,
      price: toPln(f.outbound.price.value, f.outbound.price.currencyCode),
      date: f.outbound.departureDate?.slice(0, 10) ?? null,
    }));
  });
  void cached;
  return value ?? [];
}

/** Cheapest Ryanair flight per day on one route. */
export async function ryanairDays(
  from: string, to: string, dayFrom: string, dayTo: string, checked: boolean, meter: Meter,
): Promise<FlightOption[] | null> {
  const key = `fr:days:${from}:${to}:${dayFrom}:${dayTo}`;
  const { value } = await cachedJson<{ day: string; dep: string; arr: string; price: number; cur: string }[]>(key, priceTtl(dayFrom), async () => {
    if (!meter.can("ryanair")) return null;
    await pace("ryanair");
    meter.add("ryanair", false);
    const url = `${FR}/oneWayFares/${from}/${to}/cheapestPerDay?outboundDateFrom=${dayFrom}&outboundDateTo=${dayTo}&currency=PLN`;
    const d = (await limited("ryanair", () => fetchJson(url, { headers: frHeaders() }))) as {
      outbound: { fares: { day: string; departureDate: string | null; arrivalDate: string | null; price: { value: number; currencyCode: string } | null; unavailable: boolean; soldOut: boolean }[] };
    };
    return d.outbound.fares
      .filter((f) => f.price && f.departureDate && f.arrivalDate && !f.unavailable && !f.soldOut)
      .map((f) => ({ day: f.day, dep: f.departureDate!, arr: f.arrivalDate!, price: f.price!.value, cur: f.price!.currencyCode }));
  });
  if (!value) return null;
  const A = AP[from], B = AP[to];
  if (value[0]) void recordDuration(from, to, (localToUtc(value[0].arr, B.tz) - localToUtc(value[0].dep, A.tz)) / 60_000);
  return value.map((f) => {
    const dep = localToUtc(f.dep, A.tz), arr = localToUtc(f.arr, B.tz);
    return {
      from, to, dep, arr, depLocal: f.dep.slice(0, 16), arrLocal: f.arr.slice(0, 16),
      price: Math.round(toPln(f.price, f.cur) + bag("ryanair", checked)),
      carrier: "Ryanair", flightNo: "FR", source: "ryanair" as const,
      link: `https://www.ryanair.com/pl/pl/trip/flights/select?adults=1&teens=0&children=0&infants=0&dateOut=${f.day}&isConnectedFlight=false&isReturn=false&discount=0&originIata=${from}&destinationIata=${to}`,
    };
  });
}

// ---------------- Wizz Air ----------------

const wizzHeaders = () => ({
  "user-agent": randomUA(), "content-type": "application/json", accept: "application/json",
  origin: "https://wizzair.com", referer: "https://wizzair.com/",
});

async function wizzBase(meter: Meter): Promise<string | null> {
  const { value } = await cachedJson<string>("wizz:base", 12 * 3600, async () => {
    if (!meter.can("wizz")) return null;
    await pace("wizz");
    meter.add("wizz", false);
    const res = await fetch("https://www.wizzair.com/buildnumber", {
      headers: { "user-agent": randomUA(), accept: "text/html,application/xhtml+xml", "accept-language": "pl-PL,pl;q=0.9" },
      cache: "no-store",
    }).catch(() => null);
    const m = res ? (await res.text()).match(/be\.wizzair\.com\/[0-9.]+/) : null;
    return `https://${m ? m[0] : "be.wizzair.com/29.25.0"}`; // last known version as fallback
  });
  return value;
}

/** Wizz route network: set of "FROMTO" strings. */
export async function wizzRoutes(meter: Meter): Promise<Set<string>> {
  const base = await wizzBase(meter);
  if (!base) return new Set();
  const { value } = await cachedJson<string[]>("wizz:routes", 24 * 3600, async () => {
    if (!meter.can("wizz")) return null;
    await pace("wizz");
    meter.add("wizz", false);
    const d = (await limited("wizz", () => fetchJson(`${base}/Api/asset/map?languageCode=en-gb`, { headers: wizzHeaders() }))) as {
      cities: { iata: string; connections: { iata: string }[] }[];
    };
    return d.cities.flatMap((c) => c.connections.map((x) => c.iata + x.iata));
  });
  return new Set(value ?? []);
}

/** Cheapest Wizz fare per destination over the next 6 months from `origin`. */
export async function wizzMap(origin: string, meter: Meter): Promise<MapFare[]> {
  const base = await wizzBase(meter);
  if (!base) return [];
  const { value } = await cachedJson<MapFare[]>(`wizz:map:${origin}`, 20 * 3600, async () => {
    if (!meter.can("wizz")) return null;
    await pace("wizz");
    meter.add("wizz", false);
    const d = (await limited("wizz", () => fetchJson(`${base}/Api/search/CheapFlights`, {
      method: "POST", headers: wizzHeaders(),
      body: JSON.stringify({ departureStation: origin, months: 6, discountedOnly: false }),
    }))) as { items: { arrivalStation: string; std: string; regularPrice: { amount: number; currencyCode: string } }[] };
    return d.items.map((i) => ({
      to: i.arrivalStation, price: toPln(i.regularPrice.amount, i.regularPrice.currencyCode), date: i.std?.slice(0, 10) ?? null,
    }));
  });
  return value ?? [];
}

/** Wizz flights per day on one route (timetable gives exact departure times, arrival is estimated). */
export async function wizzDays(
  from: string, to: string, dayFrom: string, dayTo: string, checked: boolean, meter: Meter,
): Promise<FlightOption[] | null> {
  const base = await wizzBase(meter);
  if (!base) return null;
  const key = `wizz:days:${from}:${to}:${dayFrom}:${dayTo}`;
  const { value } = await cachedJson<{ dep: string; price: number; cur: string }[]>(key, priceTtl(dayFrom), async () => {
    if (!meter.can("wizz")) return null;
    await pace("wizz");
    meter.add("wizz", false);
    const d = (await limited("wizz", () => fetchJson(`${base}/Api/search/timetable`, {
      method: "POST", headers: wizzHeaders(),
      body: JSON.stringify({
        flightList: [{ departureStation: from, arrivalStation: to, from: dayFrom, to: dayTo }],
        priceType: "regular", adultCount: 1, childCount: 0, infantCount: 0,
      }),
    }))) as { outboundFlights: { priceType: string; price: { amount: number; currencyCode: string }; departureDates: string[] }[] };
    return (d.outboundFlights ?? [])
      .filter((f) => f.priceType === "price" && f.price?.amount > 0)
      .flatMap((f) => f.departureDates.map((dep) => ({ dep, price: f.price.amount, cur: f.price.currencyCode })));
  });
  if (!value) return null;
  const A = AP[from], B = AP[to];
  const known = await knownDuration(from, to);
  const block = known ? known * 60_000 : flightHours(A, B) * HOUR;
  return value.map((f) => {
    const dep = localToUtc(f.dep, A.tz);
    const arr = dep + block;
    return {
      from, to, dep, arr, depLocal: f.dep.slice(0, 16), arrLocal: utcToLocal(arr, B.tz),
      price: Math.round(toPln(f.price, f.cur) + bag("wizz", checked)),
      carrier: "Wizz Air", flightNo: "W6", source: "wizz" as const, arrEstimated: !known,
      link: `https://wizzair.com/pl-pl/booking/select-flight/${from}/${to}/${f.dep.slice(0, 10)}/null/1/0/0/null`,
    };
  });
}

/** Split [from, to] into chunks of at most `n` days (the airline endpoints dislike long ranges). */
export function chunks(from: string, to: string, n = 30): [string, string][] {
  const out: [string, string][] = [];
  let a = from;
  while (a <= to) {
    const b = addDays(a, n - 1) < to ? addDays(a, n - 1) : to;
    out.push([a, b]);
    a = addDays(b, 1);
  }
  return out;
}
