import airports from "@/lib/data/airports.json";
import extra from "@/lib/data/airports-extra-pos.json";
import { getLang } from "./i18n";

type Pos = { lat: number; lon: number; city: string; cc: string; tz: string; region: string };
/** Every airport with scheduled service: the curated core plus the compact rest ([iata, lat, lon, city, cc, tz, region]). */
export const AIRPORT_POS: Record<string, Pos> = Object.fromEntries([
  ...(extra as [string, number, number, string, string, string, string][]).map(([iata, lat, lon, city, cc, tz, region]) => [iata, { lat, lon, city, cc, tz, region }]),
  ...(airports as ({ iata: string } & Pos)[]).map((a) => [a.iata, a]),
]);

export const fmtPln = (n: number) => `${Math.round(n).toLocaleString("pl-PL").replace(/,/g, " ")} zł`;
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
