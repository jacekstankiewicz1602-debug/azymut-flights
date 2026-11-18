// FlixBus public search API: real departures and prices for ground legs (no key).
import cities from "../data/flix-cities.json";
import { AP, km } from "../airports";
import { HOUR, utcToLocal } from "../time";
import type { FlightOption } from "../types";
import { cachedJson, priceTtl, Meter, pace, politeFetch, randomUA } from "./http";

const FLIX = cities as Record<string, { id: string; name: string; km: number }>;
export const flixCity = (iata: string) => FLIX[iata];

// City bus station <-> airport: typical local transfer added to every bus leg.
export const AIRPORT_ACCESS = { minutes: 50, price: 20 };

const access = (stop: string) => (/airport/i.test(stop) ? { minutes: 10, price: 0 } : AIRPORT_ACCESS);

type Ride = { dep: string; arr: string; price: number };

const fmt = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;

/** Bus rides between the cities of two airports on one date. */
export async function flixRides(from: string, to: string, date: string, meter: Meter): Promise<FlightOption[] | null> {
  const a = FLIX[from], b = FLIX[to];
  if (!a || !b || a.id === b.id) return null;
  const { value } = await cachedJson<Ride[]>(`flix:${a.id}:${b.id}:${date}`, priceTtl(date), async () => {
    if (!meter.can("flixbus")) return null;
    await pace("flixbus", 250 + Math.random() * 250);
    meter.add("flixbus", false);
    const url = `https://global.api.flixbus.com/search/service/v4/search?from_city_id=${a.id}&to_city_id=${b.id}&departure_date=${fmt(date)}&products=%7B%22adult%22%3A1%7D&currency=PLN&locale=pl&search_by=cities&include_after_midnight_rides=1`;
    const text = await politeFetch(url, { headers: { "user-agent": randomUA(), accept: "application/json" } }, "flixbus");
    if (!text) return null;
    try {
      const d = JSON.parse(text) as { trips?: { results: Record<string, { departure: { date: string }; arrival: { date: string }; price: { total: number }; status: string }> }[] };
      return (d.trips ?? []).flatMap((t) => Object.values(t.results))
        .filter((r) => r.status === "available" && r.price?.total > 0)
        .map((r) => ({ dep: r.departure.date, arr: r.arrival.date, price: r.price.total }));
    } catch { return null; }
  });
  if (!value) return null;
  const link = `https://shop.flixbus.pl/search?departureCity=${a.id}&arrivalCity=${b.id}&rideDate=${fmt(date)}&adult=1&_locale=pl`;
  const maxH = 2 + km(AP[from], AP[to]) / 55; // no detours through half of Europe
  return value.filter((r) => (Date.parse(r.arr) - Date.parse(r.dep)) / HOUR <= maxH).map((r) => {
    // ride times carry their UTC offset; add the city <-> airport transfer where the stop is not at the airport
    const accA = access(a.name), accB = access(b.name);
    const dep = Date.parse(r.dep) - accA.minutes * 60_000;
    const arr = Date.parse(r.arr) + accB.minutes * 60_000;
    return {
      from, to, dep, arr, depLocal: r.dep.slice(0, 16), arrLocal: r.arr.slice(0, 16),
      price: Math.round(r.price + accA.price + accB.price), carrier: "FlixBus", flightNo: `${a.name} → ${b.name}`,
      source: "flixbus" as const, link, note: accA.price + accB.price ? "z dojazdem miasto–lotnisko (szac.)" : undefined,
    };
  });
}

/** Same-city airport change (shuttle / metro). Runs only in daytime; no invented night buses. */
export function localTransfer(from: string, to: string, earliest: number, hours: number, price: number): FlightOption | null {
  const tz = AP[from].tz;
  let dep = earliest;
  for (let k = 0; k < 10; k++) {
    const h = Number(new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", hourCycle: "h23" }).format(new Date(dep)));
    if (h >= 5 && h < 23) break;
    dep += HOUR;
  }
  const arr = dep + hours * HOUR;
  return {
    from, to, dep, arr, depLocal: utcToLocal(dep, tz), arrLocal: utcToLocal(arr, AP[to].tz), price, carrier: "Transfer lokalny", flightNo: "",
    source: "local", link: `https://www.rome2rio.com/map/${encodeURIComponent(AP[from].cityEn + " " + from)}/${encodeURIComponent(AP[to].cityEn + " " + to)}`,
    note: "czas i koszt szacunkowy (kursy codziennie 5–23)",
  };
}
