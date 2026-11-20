// Autocomplete for the from / to fields: "gdziekolwiek", regions, countries, cities, airports.
// Polish names with declension ("z Polski", "do Peru", "w Tajlandii") via the parser's stems.
import { ALL_AIRPORTS as AIRPORTS, COUNTRY_PL, REGION_ALIASES, REGIONS, isCore } from "./airports";
import { COUNTRY_AIRPORTS } from "./departure";

export type Suggestion = { kind: "any" | "region" | "country" | "city" | "airport"; label: string; sub: string; value: string };

const fold = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/ł/g, "l").replace(/ø/g, "o").replace(/æ/g, "ae").replace(/ß/g, "ss").replace(/ı/g, "i").trim();
const plCountry = new Intl.DisplayNames(["pl"], { type: "region" });
const countryPl = (cc: string) => COUNTRY_PL[cc]?.[0] ?? (() => { try { return plCountry.of(cc) ?? cc; } catch { return cc; } })();
const PREP = /^(z|ze|do|na|w|we|od|przez)\s+/;

// the English list: the same entries with English labels (the parser reads both languages)
type En = { label: string; sub: string; value: string };
type Entry = Suggestion & { keys: string[]; rank: number; en: En };
const enCountry = new Intl.DisplayNames(["en"], { type: "region" });
const countryEn = (cc: string) => { try { return enCountry.of(cc) ?? cc; } catch { return cc; } };
const REGION_EN: Record<string, string> = {
  EUR: "Europe", CAU: "Caucasus", MEA: "Middle East", NAF: "North Africa", AFR: "Africa", SAS: "South Asia", SEA: "Southeast Asia",
  EAS: "East Asia", CAS: "Central Asia", OCE: "Oceania", NAM: "North America", CAR: "Caribbean and Central America", SAM: "South America",
};
const airportsEn = (n: number) => `${n} ${n === 1 ? "airport" : "airports"}`;
let index: Entry[] | null = null;

function build(): Entry[] {
  const out: Entry[] = [];
  out.push({ kind: "any", label: "Gdziekolwiek", sub: "najtańsze kierunki na całym świecie", value: "gdziekolwiek", keys: ["gdziekolwiek", "dowolnie", "wszedzie", "anywhere", "caly swiat", "everywhere", "worldwide"], rank: 0,
    en: { label: "Anywhere", sub: "the cheapest destinations worldwide", value: "Anywhere" } });
  const regionCount = (r: string) => AIRPORTS.filter((a) => a.region === r).length;
  for (const [r, name] of Object.entries(REGIONS)) {
    const aliases = REGION_ALIASES.find(([k]) => k === r)?.[1] ?? [];
    out.push({ kind: "region", label: name, sub: `region · ${regionCount(r)} lotnisk`, value: name, keys: [fold(name), ...aliases.map(fold), fold(REGION_EN[r])], rank: 1,
      en: { label: REGION_EN[r], sub: `region · ${airportsEn(regionCount(r))}`, value: REGION_EN[r] } });
  }
  out.push({ kind: "region", label: "Azja", sub: "region · cała Azja", value: "Azja", keys: ["azja", "azji", "azj", "asia"], rank: 1, en: { label: "Asia", sub: "region · all of Asia", value: "Asia" } });
  out.push({ kind: "region", label: "Poza Europą", sub: "wszystkie kierunki pozaeuropejskie", value: "poza Europą", keys: ["poza europa", "poza europe", "outside europe"], rank: 1,
    en: { label: "Outside Europe", sub: "every destination outside Europe", value: "Outside Europe" } });
  const ccs = new Set(AIRPORTS.map((a) => a.cc));
  for (const cc of ccs) {
    const [name, stems] = COUNTRY_PL[cc] ?? [countryPl(cc), []];
    const n = AIRPORTS.filter((a) => a.cc === cc).length;
    if (!n) continue;
    out.push({ kind: "country", label: name, sub: `kraj · ${n} ${n === 1 ? "lotnisko" : n < 5 ? "lotniska" : "lotnisk"}`, value: name, keys: [fold(name), ...stems.map(fold), fold(countryEn(cc))], rank: 2,
      en: { label: countryEn(cc), sub: `country · ${airportsEn(n)}`, value: countryEn(cc) } });
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
      const ce = a.cityEn.split("-")[0];
      out.push({ kind: "city", label: c, sub: `${countryPl(a.cc)} · wszystkie lotniska (${codes.join(", ")})`, value: c, keys: [fold(c), fold(a.cityEn)], rank: 3,
        en: { label: ce, sub: `${countryEn(a.cc)} · all airports (${codes.join(", ")})`, value: ce } });
    }
    // airports outside the core rank a little lower (small and medium ones lower still), so "Oslo" lists OSL first
    const rank = isCore(a.iata) ? 4 : a.size === "L" ? 4.5 : a.size === "M" ? 5 : 6;
    out.push({ kind: "airport", label: `${a.city} ${a.iata}`, sub: `${a.name}, ${countryPl(a.cc)}`, value: a.iata, keys: [a.iata.toLowerCase(), fold(a.city), fold(a.cityEn), fold(a.name), ...(a.aliases ?? []).map(fold)], rank,
      en: { label: `${a.cityEn || a.city} ${a.iata}`, sub: `${a.name}, ${countryEn(a.cc)}`, value: a.iata } });
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

export function suggest(raw: string, limit = 8, lang: "pl" | "en" = "pl"): Suggestion[] {
  index ??= build();
  const strip = lang === "en" ? stripEn : stripPl;
  const q = fold(raw).replace(PREP, "").replace(/^(from|to|in)\s+/, "");
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

const stripPl = ({ kind, label, sub, value }: Entry): Suggestion => ({ kind, label, sub, value });
const stripEn = ({ kind, en }: Entry): Suggestion => ({ kind, ...en });
