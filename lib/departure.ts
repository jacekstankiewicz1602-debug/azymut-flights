// Where a trip can start. The origin is a home city (bus to other airports counted) or, with the
// access toggle off, every departure airport at zero access cost. A country as the origin makes all
// its airports departure options; foreign airports within ORIGIN_RADIUS_KM of home are optional.
import { AP, km } from "./airports";
import { config } from "./config";
import type { SearchParams } from "./types";

export const COUNTRY_AIRPORTS: Record<string, string[]> = {
  PL: "WAW WMI KRK KTW GDN WRO POZ SZZ BZG LCJ RZE LUZ IEG SZY RDO".split(" "),
};
/** Big airports just across the border that a country as the origin also flies from (bus from home). */
const COUNTRY_EXTRA: Record<string, string[]> = { PL: ["BER", "PRG", "BUD"] };

/** The access-time limit in hours (default 4; 0 = none). A country as the origin ("Polska") means any
 *  of its airports is fine however long the bus there takes: only the price decides. */
export const accessLimitH = (p: Pick<SearchParams, "maxAccessH" | "departs">) => (p.maxAccessH === 0 || p.departs?.length ? Infinity : p.maxAccessH ?? 4);
/** Optimistic bus/train time between two airports' cities (straight line at 90 km/h plus the transfer):
 *  an airport even this estimate puts beyond the limit is not a departure option; the real schedule
 *  decides for the rest (see verify). */
export const accessEstH = (a: string, b: string) => (a === b ? 0 : km(AP[a], AP[b]) / 90 + 0.3);

export function withDeparture(p: SearchParams): SearchParams {
  if (p.ground) return p; // already expanded
  const d = expand(p);
  // a destination is never also a departure (the trip would stay inside the destination country);
  // not for "gdziekolwiek" and the wide regions, whose list covers home as well
  if (p.mode === "anywhere" || p.dest.length > 100) return d;
  const dest = new Set(p.dest);
  const origin = d.origin.filter((c) => !dest.has(c));
  return origin.length ? { ...d, origin, ground: (d.ground ?? []).filter((c) => !dest.has(c)) } : d;
}

function expand(p: SearchParams): SearchParams {
  // "tylko stąd": the typed city's or country's own airports, nothing around them, no bus
  if (p.strict) return { ...p, origin: p.departs?.length ? p.departs.filter((c) => AP[c]) : p.origin, ground: [] };
  // home counts only when the trip starts there or near it: "Los Angeles → Polska" from a Poznań
  // user starts in LA, and the Polish airports around home must not become departures
  const fromHome = !!p.home && !!AP[p.home] && (p.departs?.length ? p.departs : p.origin).some((c) => AP[c] && km(AP[c], AP[p.home!]) <= config.originRadiusKm);
  const home = fromHome ? p.home! : p.origin[0];
  const h = AP[home];
  const near = (c: string) => !!AP[c] && km(h, AP[c]) <= config.originRadiusKm;
  // a country as the origin: its own airports plus the big ones next door (Polska: Berlin, Praga, Budapeszt);
  // other foreign ones near home only with "+ lotniska za granicą"
  const depCc = p.departs?.length ? AP[p.departs[0]]?.cc : undefined;
  const own = p.departs ? [...p.departs, ...(COUNTRY_EXTRA[depCc ?? ""] ?? [])] : [...new Set([...p.origin, ...config.originAirports.filter((c) => near(c) && AP[c].cc === h.cc)])];
  // another country as the origin (Islandia → Polska): the trip starts at its airports, no bus from home
  if (p.departs && depCc !== h.cc) return { ...p, origin: own.filter((c) => AP[c]), ground: [] };
  const abroad = p.abroad === true ? config.originAirports.filter((c) => near(c) && AP[c].cc !== h.cc) : [];
  const lim = accessLimitH(p);
  // within the access-time limit from home (counted only when the bus is counted; the origin itself always)
  const all = [...new Set([...own, ...abroad])].filter((c) => AP[c] && (p.access === false || c === home || p.origin.includes(c) && !p.departs || accessEstH(home, c) <= lim));
  if (p.access === false) return { ...p, origin: all, ground: [] };
  const origin = p.departs ? [home] : [...new Set([home, ...p.origin])];
  return { ...p, origin, ground: all.filter((c) => !origin.includes(c)) };
}
