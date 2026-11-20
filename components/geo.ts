import airports from "@/lib/data/airports.json";
import extra from "@/lib/data/airports-extra-pos.json";
import { getLang, setPlaceFilter } from "./i18n";
import { money } from "./money";

type Pos = { lat: number; lon: number; city: string; cityEn?: string; cc: string; tz: string; region: string };
/** Every airport with scheduled service: the curated core plus the compact rest ([iata, lat, lon, city, cc, tz, region]). */
export const AIRPORT_POS: Record<string, Pos> = Object.fromEntries([
  ...(extra as [string, number, number, string, string, string, string][]).map(([iata, lat, lon, city, cc, tz, region]) => [iata, { lat, lon, city, cc, tz, region }]),
  ...(airports as ({ iata: string } & Pos)[]).map((a) => [a.iata, a]),
]);

/** City of an airport in the interface language ("Szardża" / "Sharjah"); the rest of the world is in English already. */
export const cityName = (code: string) => { const a = AIRPORT_POS[code]; return !a ? code : getLang() === "en" ? a.cityEn || a.city : a.city; };

// Polish place names inside text from the server ("Radom → Islandia", "Radom – Szardża – Male") → English:
// the airport cities with an English name of their own, and every country (Intl, pl → en)
let PLACES: [RegExp, Record<string, string>] | null = null;
function places(): [RegExp, Record<string, string>] {
  if (PLACES) return PLACES;
  const map: Record<string, string> = {};
  for (const a of airports as { city: string; cityEn?: string }[]) for (const [pl, en] of [[a.city, a.cityEn], [a.city.split("-")[0], a.cityEn?.split("-")[0]]]) if (pl && en && pl !== en) map[pl] = en;
  try {
    const pl = new Intl.DisplayNames(["pl"], { type: "region" }), en = new Intl.DisplayNames(["en"], { type: "region" });
    for (const cc of new Set(Object.values(AIRPORT_POS).map((p) => p.cc))) { const p = pl.of(cc), e = en.of(cc); if (p && e && p !== e && p !== cc) map[p] = e; }
  } catch { /* no Intl.DisplayNames */ }
  const keys = Object.keys(map).sort((a, b) => b.length - a.length).map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  PLACES = [new RegExp(`(?<![\\p{L}])(${keys.join("|")})(?![\\p{L}])`, "gu"), map];
  return PLACES;
}
export function placesEn(text: string): string {
  const [re, map] = places();
  return text.replace(re, (m) => map[m] ?? m);
}
setPlaceFilter(placesEn);

/** A PLN amount in the chosen display currency (money.ts). */
export const fmtPln = (n: number) => money(n);
export const fmtTime = (local: string) => local.slice(11, 16);
export const fmtDate = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}`;
export const fmtDur = (h: number) => `${Math.floor(h)} h ${String(Math.round((h % 1) * 60)).padStart(2, "0")} min`;

/** Great-circle distance in km. */
export function gcKm(a: string, b: string): number {
  const A = AIRPORT_POS[a], B = AIRPORT_POS[b];
  if (!A || !B) return 0;
  const r = Math.PI / 180;
  const h = Math.sin(((B.lat - A.lat) * r) / 2) ** 2 + Math.cos(A.lat * r) * Math.cos(B.lat * r) * Math.sin(((B.lon - A.lon) * r) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
}

// country names in the interface language (one Intl formatter per language)
const regionNames: Partial<Record<string, Intl.DisplayNames | null>> = {};
const namesFor = (l: string) => (regionNames[l] ??= typeof Intl !== "undefined" && "DisplayNames" in Intl ? new Intl.DisplayNames([l], { type: "region" }) : null);
/** Polish country name for an ISO code ("IN" -> "Indie"). */
export const countryName = (cc: string) => { try { return namesFor(getLang())?.of(cc.toUpperCase()) ?? cc; } catch { return cc; } };
/** Country code of an airport. */
export const ccOf = (code: string) => AIRPORT_POS[code]?.cc ?? "";
