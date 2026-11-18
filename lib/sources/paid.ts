// SerpAPI (Google Travel Explore + Google Flights) and Duffel (search only, never booking).
import { AP } from "../airports";
import { config } from "../config";
import { localToUtc } from "../time";
import type { FlightOption } from "../types";
import { cachedJson, fetchJson, Meter } from "./http";

export const hasSerp = () => !!config.keys.serpapi;
// Duffel test tokens return fictional airlines, so Duffel stays off until a live token is set.
export const hasDuffel = () => !!config.keys.duffel && config.duffelLive;

const SERP = "https://serpapi.com/search.json";

async function serp(params: Record<string, string>, meter: Meter): Promise<Record<string, unknown> | null> {
  if (!hasSerp() || !meter.canPaid()) return null;
  meter.add("serpapi", true, config.cost.serpapiPerCall);
  const qs = new URLSearchParams({ ...params, api_key: config.keys.serpapi, currency: "PLN", hl: "pl", gl: "pl" });
  return (await fetchJson(`${SERP}?${qs}`, {}, 40000)) as Record<string, unknown>;
}

export type ExploreFare = { to: string; price: number; date: string | null; stops: number | null };

/** Google Travel Explore: cheapest one-way prices from `origin` to hundreds of destinations in a month. */
export async function explore(origin: string, month: string, meter: Meter): Promise<ExploreFare[] | null> {
  const [, m] = month.split("-");
  const { value } = await cachedJson<ExploreFare[]>(`serp:explore:${origin}:${month}`, 20 * 3600, async () => {
    const d = await serp({ engine: "google_travel_explore", departure_id: origin, type: "2", month: String(Number(m)) }, meter);
    if (!d) return null;
    const dests = (d.destinations as Record<string, any>[] | undefined) ?? [];
    return dests
      .map((x) => ({
        to: x.destination_airport?.code ?? x.destination_airport_code,
        price: Number(x.flight_price ?? x.price),
        date: x.start_date ?? null,
        stops: x.number_of_stops ?? null,
      }))
      .filter((x) => x.to && AP[x.to] && Number.isFinite(x.price));
  });
  return value;
}

type GFlight = {
  flights: { departure_airport: { id: string; time: string }; arrival_airport: { id: string; time: string }; airline: string; flight_number: string }[];
  price: number; total_duration: number;
};

/** Google Flights one-way on a date. Returns the cheapest few itineraries as single-ticket options. */
export async function googleFlights(
  from: string, to: string, date: string, meter: Meter,
): Promise<FlightOption[] | null> {
  const { value } = await cachedJson<FlightOption[]>(`serp:gf:${from}:${to}:${date}`, 6 * 3600, async () => {
    const d = await serp({ engine: "google_flights", departure_id: from, arrival_id: to, outbound_date: date, type: "2" }, meter);
    if (!d) return null;
    const url = (d.search_metadata as { google_flights_url?: string } | undefined)?.google_flights_url
      ?? `https://www.google.com/travel/flights?q=${encodeURIComponent(`flights ${from} to ${to} ${date} one way`)}`;
    const all = [...((d.best_flights as GFlight[]) ?? []), ...((d.other_flights as GFlight[]) ?? [])]
      .filter((f) => f.price && f.flights?.length)
      .sort((a, b) => a.price - b.price)
      .slice(0, 6);
    return all.map((f) => {
      const first = f.flights[0], last = f.flights[f.flights.length - 1];
      const fromAp = AP[first.departure_airport.id] ?? AP[from], toAp = AP[last.arrival_airport.id] ?? AP[to];
      return {
        from, to,
        dep: localToUtc(first.departure_airport.time, fromAp.tz), arr: localToUtc(last.arrival_airport.time, toAp.tz),
        depLocal: first.departure_airport.time.replace(" ", "T"), arrLocal: last.arrival_airport.time.replace(" ", "T"),
        price: Math.round(f.price), carrier: [...new Set(f.flights.map((x) => x.airline))].join(" + "),
        flightNo: f.flights.map((x) => x.flight_number).join(" / "), source: "google" as const, link: url,
        stops: f.flights.length - 1,
      };
    });
  });
  return value;
}

/** Cheapest ordinary offer Google shows for the whole trip (several origin/destination airports allowed). */
export async function googleBaseline(
  from: string[], to: string[], outDate: string, retDate: string | null, meter: Meter,
): Promise<{ price: number; url: string; summary: string } | null> {
  const params: Record<string, string> = {
    engine: "google_flights", departure_id: from.join(","), arrival_id: to.slice(0, 7).join(","),
    outbound_date: outDate, type: retDate ? "1" : "2",
  };
  if (retDate) params.return_date = retDate;
  const { value } = await cachedJson<{ price: number; url: string; summary: string }>(
    `serp:base:${JSON.stringify(params)}`, 6 * 3600, async () => {
      const d = await serp(params, meter);
      if (!d) return null;
      const all = [...((d.best_flights as GFlight[]) ?? []), ...((d.other_flights as GFlight[]) ?? [])].filter((f) => f.price);
      if (!all.length) return null;
      const best = all.sort((a, b) => a.price - b.price)[0];
      return {
        price: best.price,
        url: (d.search_metadata as { google_flights_url?: string })?.google_flights_url ?? "https://www.google.com/travel/flights",
        summary: best.flights.map((x) => `${x.departure_airport.id}-${x.arrival_airport.id} ${x.airline}`).join(", "),
      };
    });
  return value;
}

// ---------------- Duffel ----------------

type DuffelOffer = {
  total_amount: string; total_currency: string; owner: { name: string; iata_code: string };
  slices: { segments: { departing_at: string; arriving_at: string; origin: { iata_code: string }; destination: { iata_code: string };
    marketing_carrier: { name: string; iata_code: string }; marketing_carrier_flight_number: string }[] }[];
};

/** Duffel offer request (search only). Prices converted to PLN. */
export async function duffel(from: string, to: string, date: string, meter: Meter): Promise<FlightOption[] | null> {
  if (!hasDuffel()) return null;
  const { value } = await cachedJson<FlightOption[]>(`duffel:${from}:${to}:${date}`, 6 * 3600, async () => {
    if (!meter.canPaid()) return null;
    meter.add("duffel", true, config.cost.duffelPerCall);
    const d = (await fetchJson("https://api.duffel.com/air/offer_requests?return_offers=true&supplier_timeout=15000", {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.keys.duffel}`, "duffel-version": "v2",
        "content-type": "application/json", accept: "application/json",
      },
      body: JSON.stringify({ data: {
        slices: [{ origin: from, destination: to, departure_date: date }],
        passengers: [{ type: "adult" }], cabin_class: "economy", max_connections: 1,
      } }),
    }, 45000)) as { data: { offers: DuffelOffer[] } };
    const A = AP[from], B = AP[to];
    return d.data.offers
      .filter((o) => {
        const segs = o.slices[0].segments;
        return segs[0].origin.iata_code === from && segs[segs.length - 1].destination.iata_code === to;
      })
      .map((o) => ({ o, pln: Number(o.total_amount) * (config.fx[o.total_currency] ?? NaN) }))
      .filter((x) => Number.isFinite(x.pln))
      .sort((a, b) => a.pln - b.pln)
      .slice(0, 6)
      .map(({ o, pln }) => {
        const segs = o.slices[0].segments, first = segs[0], last = segs[segs.length - 1];
        return {
          from, to, dep: localToUtc(first.departing_at, A.tz), arr: localToUtc(last.arriving_at, B.tz),
          depLocal: first.departing_at.slice(0, 16), arrLocal: last.arriving_at.slice(0, 16),
          price: Math.round(pln), carrier: o.owner.name,
          flightNo: segs.map((s) => s.marketing_carrier.iata_code + s.marketing_carrier_flight_number).join(" / "),
          source: "duffel" as const, stops: segs.length - 1,
          link: `https://www.google.com/travel/flights?q=${encodeURIComponent(`flights ${from} to ${to} ${date} ${segs.map((s) => s.marketing_carrier.iata_code + s.marketing_carrier_flight_number).join(" ")}`)}`,
        };
      });
  });
  return value;
}
