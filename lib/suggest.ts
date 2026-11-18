// Autocomplete for the from / to fields: "gdziekolwiek", regions, countries, cities, airports.
// Polish names with declension ("z Polski", "do Peru", "w Tajlandii") via the parser's stems.
import { ALL_AIRPORTS as AIRPORTS, COUNTRY_PL, REGION_ALIASES, REGIONS, isCore } from "./airports";
import { COUNTRY_AIRPORTS } from "./departure";

export type Suggestion = { kind: "any" | "region" | "country" | "city" | "airport"; label: string; sub: string; value: string };

const fold = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/ł/g, "l").replace(/ø/g, "o").replace(/æ/g, "ae").replace(/ß/g, "ss").replace(/ı/g, "i").trim();
const plCountry = new Intl.DisplayNames(["pl"], { type: "region" });
const countryPl = (cc: string) => COUNTRY_PL[cc]?.[0] ?? (() => { try { return plCountry.of(cc) ?? cc; } catch { return cc; } })();
const PREP = /^(z|ze|do|na|w|we|od|przez)\s+/;

type Entry = Suggestion & { keys: string[]; rank: number };
let index: Entry[] | null = null;

function build(): Entry[] {
  const out: Entry[] = [];
  out.push({ kind: "any", label: "Gdziekolwiek", sub: "najtańsze kierunki na całym świecie", value: "gdziekolwiek", keys: ["gdziekolwiek", "dowolnie", "wszedzie", "anywhere", "caly swiat"], rank: 0 });
  const regionCount = (r: string) => AIRPORTS.filter((a) => a.region === r).length;
  for (const [r, name] of Object.entries(REGIONS)) {
    const aliases = REGION_ALIASES.find(([k]) => k === r)?.[1] ?? [];
    out.push({ kind: "region", label: name, sub: `region · ${regionCount(r)} lotnisk`, value: name, keys: [fold(name), ...aliases.map(fold)], rank: 1 });
  }
  out.push({ kind: "region", label: "Azja", sub: "region · cała Azja", value: "Azja", keys: ["azja", "azji", "azj"], rank: 1 });
  out.push({ kind: "region", label: "Poza Europą", sub: "wszystkie kierunki pozaeuropejskie", value: "poza Europą", keys: ["poza europa", "poza europe"], rank: 1 });
  const ccs = new Set(AIRPORTS.map((a) => a.cc));
  for (const cc of ccs) {
    const [name, stems] = COUNTRY_PL[cc] ?? [countryPl(cc), []];
    const n = AIRPORTS.filter((a) => a.cc === cc).length;
    if (!n) continue;
    out.push({ kind: "country", label: name, sub: `kraj · ${n} ${n === 1 ? "lotnisko" : n < 5 ? "lotniska" : "lotnisk"}`, value: name, keys: [fold(name), ...stems.map(fold)], rank: 2 });
  }
  const cities = new Map<string, string[]>();
  for (const a of AIRPORTS) {
    const c = a.city.split("-")[0];
    if (!cities.has(c)) cities.set(c, []);
    cities.get(c)!.push(a.iata);
  }
  for (const a of AIRPORTS) {
    const c = a.city.split("-")[0];
    const codes = cities.get(c)!;
    if (codes.length > 1 && codes[0] === a.iata) {
      out.push({ kind: "city", label: c, sub: `${countryPl(a.cc)} · wszystkie lotniska (${codes.join(", ")})`, value: c, keys: [fold(c), fold(a.cityEn)], rank: 3 });
    }
    // airports outside the core rank a little lower (small and medium ones lower still), so "Oslo" lists OSL first
    const rank = isCore(a.iata) ? 4 : a.size === "L" ? 4.5 : a.size === "M" ? 5 : 6;
    out.push({ kind: "airport", label: `${a.city} ${a.iata}`, sub: `${a.name}, ${countryPl(a.cc)}`, value: a.iata, keys: [a.iata.toLowerCase(), fold(a.city), fold(a.cityEn), fold(a.name), ...(a.aliases ?? []).map(fold)], rank });
  }
  return out;
}

/** A key matches when a word of it starts with the query, or the query (declined) starts with the key's stem. */
function score(e: Entry, q: string): number {
  let best = Infinity;
  for (const k of e.keys) {
    if (k === q) best = Math.min(best, 0);
    else if (k.startsWith(q)) best = Math.min(best, 1);
    else if (k.split(/[\s-]+/).some((w) => w.startsWith(q))) best = Math.min(best, 2);
    else {
      // declension: "polski" vs stem "polsk", "tajlandii" vs "tajlandi", "peru" vs "peru"
      const stem = k.length > 4 ? k.slice(0, Math.max(4, k.length - 2)) : k;
      if (q.length >= 4 && q.startsWith(stem) && q.length <= k.length + 3) best = Math.min(best, 1.5);
    }
  }
  return best === Infinity ? best : best * 10 + e.rank;
}

export function suggest(raw: string, limit = 8): Suggestion[] {
  index ??= build();
  const q = fold(raw).replace(PREP, "");
  if (!q) return index.filter((e) => e.kind === "any" || (e.kind === "country" && e.value === "Polska") || e.kind === "region").slice(0, limit).map(strip);
  if (/^[a-z]{3}$/.test(q)) {
    const exact = index.find((e) => e.kind === "airport" && e.value.toLowerCase() === q);
    // a country or region spelled the same way ("USA") stays first, the airport with that code right after
    const named = index.find((e) => (e.kind === "country" || e.kind === "region") && e.keys.includes(q));
    const top = [named, exact].filter((e): e is Entry => !!e);
    if (top.length) return [...top.map(strip), ...rankAll(q).filter((e) => !top.includes(e)).slice(0, limit - top.length).map(strip)];
  }
  return rankAll(q).slice(0, limit).map(strip);
}

function rankAll(q: string): Entry[] {
  return index!.map((e) => ({ e, s: score(e, q) })).filter((x) => x.s < Infinity).sort((a, b) => a.s - b.s || a.e.label.length - b.e.label.length).map((x) => x.e);
}

const strip = ({ kind, label, sub, value }: Entry): Suggestion => ({ kind, label, sub, value });
