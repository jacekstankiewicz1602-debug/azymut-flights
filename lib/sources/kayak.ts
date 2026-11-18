// Kayak's "explore" map (no key): the cheapest cached round-trip fare from one airport to every
// destination around given dates, with the dates and the airline. Only a hint: the engine prices the
// hinted dates again (Kiwi, Google) before a trip is shown.
import { cachedJson, Meter, politeFetch, randomUA } from "./http";

export type KayakHint = { from: string; to: string; out: string; ret: string; price: number; airline: string | null; stops: number | null };

type Raw = { destinations?: { airport?: { shortName?: string }; departd?: string; returnd?: string; airlineCode?: string | null; flightMaxStops?: number;
  flightInfo?: { price?: number; priceless?: boolean; predicted?: boolean } }[] };

const iso = (d: string) => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
const compact = (d: string) => d.replace(/-/g, "");

/** Every destination's cheapest round trip from `from` near [out, ret] (PLN, real cached fares only). */
export async function kayakExplore(from: string, out: string, ret: string, meter: Meter): Promise<KayakHint[] | null> {
  const { value } = await cachedJson<KayakHint[]>(`kayak:explore:${from}:${out}:${ret}`, 6 * 3600, async () => {
    if (!meter.can("kayak")) return null;
    meter.add("kayak", false);
    const url = `https://www.kayak.pl/s/horizon/exploreapi/destinations?airport=${from}&depart=${compact(out)}&return=${compact(ret)}&exactDates=false&budget=&duration=&flightMaxStops=&stopsFilterActive=false&topRightLat=&topRightLon=&bottomLeftLat=&bottomLeftLon=&zoomLevel=2&selectedMarker=&themeCode=&selectedDestination=`;
    const text = await politeFetch(url, { headers: { "user-agent": randomUA(), accept: "application/json" } }, "kayak", 2, 30_000);
    let j: Raw | null = null;
    try { j = text ? JSON.parse(text) : null; } catch { j = null; }
    if (!j?.destinations) return null;
    return j.destinations
      .filter((d) => d.airport?.shortName && d.departd && d.returnd && d.flightInfo?.price && !d.flightInfo.priceless && !d.flightInfo.predicted)
      .map((d) => ({ from, to: d.airport!.shortName!, out: iso(d.departd!), ret: iso(d.returnd!), price: Math.round(d.flightInfo!.price!), airline: d.airlineCode ?? null, stops: d.flightMaxStops ?? null }));
  });
  return value;
}
