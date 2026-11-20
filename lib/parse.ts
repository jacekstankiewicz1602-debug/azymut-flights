// Polish query -> SearchParams. Rule-based parser, optionally refined by Claude.
import { AIRPORTS, AP, COUNTRY_PL, EXTRA_AIRPORTS, REGION_ALIASES, REGIONS } from "./airports";
import { config } from "./config";
import { COUNTRY_AIRPORTS } from "./departure";
import { llmParse } from "./llm";
import { addDays, isoDay, monthEnd } from "./time";
import type { SearchParams } from "./types";

const fold = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/ł/g, "l").replace(/ø/g, "o").replace(/æ/g, "ae").replace(/ß/g, "ss").replace(/ı/g, "i");

const SIZE_RANK: Record<string, number> = { L: 0, M: 1, S: 2 };
/** Extra (non-core) airports of a region that a region search includes: the large ones. */
const regionExtras = (pred: (r: string) => boolean) => EXTRA_AIRPORTS.filter((a) => a.size === "L" && pred(a.region)).map((a) => a.iata);
const regionCodes = (pred: (r: string) => boolean) => [...AIRPORTS.filter((a) => pred(a.region)).map((a) => a.iata), ...regionExtras(pred)];
/** A country's airports: the core first, then every other airport with scheduled service (large first), capped. */
export function countryCodes(cc: string, cap = 60): string[] {
  if (COUNTRY_AIRPORTS[cc]) return COUNTRY_AIRPORTS[cc];
  const extra = EXTRA_AIRPORTS.filter((a) => a.cc === cc).sort((a, b) => (SIZE_RANK[a.size ?? "S"] - SIZE_RANK[b.size ?? "S"]) || a.iata.localeCompare(b.iata));
  return [...AIRPORTS.filter((a) => a.cc === cc).map((a) => a.iata), ...extra.map((a) => a.iata)].slice(0, cap);
}
const regionNamesPl = new Intl.DisplayNames(["pl"], { type: "region" });
/** Polish names of every country with an airport (Intl), for countries outside COUNTRY_PL. */
let otherCountries: [string, string][] | null = null;
const countriesByName = () => otherCountries ??= [...new Set(EXTRA_AIRPORTS.map((a) => a.cc))].filter((cc) => !COUNTRY_PL[cc])
  .map((cc): [string, string] => { try { return [cc, regionNamesPl.of(cc) ?? cc]; } catch { return [cc, cc]; } });

type Place = { codes: string[]; label: string; country?: string };

// English names (the interface in English, its autocomplete): regions and countries. The label stays
// Polish, as everywhere downstream; the client shows it in English.
const EN_REGIONS: [string, string][] = [
  ["southeast asia", "SEA"], ["south east asia", "SEA"], ["south-east asia", "SEA"], ["south america", "SAM"], ["latin america", "SAM"],
  ["caribbean and central america", "CAR"], ["central america", "CAR"], ["caribbean", "CAR"], ["south asia", "SAS"],
  ["east asia", "EAS"], ["far east", "EAS"], ["central asia", "CAS"], ["middle east", "MEA"], ["north africa", "NAF"],
  ["africa", "AFR"], ["oceania", "OCE"], ["north america", "NAM"], ["caucasus", "CAU"], ["europe", "EUR"],
];
const EN_COUNTRY_ALIASES: Record<string, string> = { usa: "US", "u.s.": "US", us: "US", america: "US", "united states of america": "US", uk: "GB", britain: "GB", "great britain": "GB", england: "GB", uae: "AE", emirates: "AE", "czech republic": "CZ", holland: "NL", "south korea": "KR", korea: "KR", turkey: "TR" };
const regionNamesEn = new Intl.DisplayNames(["en"], { type: "region" });
let enCountries: Map<string, string> | null = null;
const countryEn = (name: string) => (enCountries ??= new Map([...new Set([...AIRPORTS, ...EXTRA_AIRPORTS].map((a) => a.cc))]
  .flatMap((cc): [string, string][] => { try { const n = regionNamesEn.of(cc); return n && n !== cc ? [[fold(n), cc]] : []; } catch { return []; } })
  .concat(Object.entries(EN_COUNTRY_ALIASES)))).get(name);
const countryPlName = (cc: string) => COUNTRY_PL[cc]?.[0] ?? (() => { try { return regionNamesPl.of(cc) ?? cc; } catch { return cc; } })();

function resolveEnglish(t: string): Place | null {
  const bare = t.replace(/^(from|to|in)\s+/, "").replace(/^the\s+/, "").trim();
  if (/^(anywhere|everywhere|worldwide|the whole world|whole world|any destination)$/.test(bare)) return { codes: AIRPORTS.map((a) => a.iata), label: "gdziekolwiek" };
  if (/^(outside|beyond|out of|non-)\s*europe(an)?$/.test(bare)) return { codes: AIRPORTS.filter((a) => a.region !== "EUR").map((a) => a.iata), label: "poza Europą" };
  if (bare === "asia") return { codes: AIRPORTS.filter((a) => ["SAS", "SEA", "EAS", "CAS"].includes(a.region)).map((a) => a.iata), label: "Azja" };
  const reg = EN_REGIONS.find(([n]) => bare === n)?.[1];
  if (reg) return { codes: regionCodes((r) => r === reg || (reg === "AFR" && r === "NAF")), label: REGIONS[reg] };
  const cc = countryEn(bare);
  if (cc) {
    const codes = countryCodes(cc);
    if (codes.length) return { codes, label: countryPlName(cc), country: cc };
  }
  return null;
}

export function resolvePlace(text: string): Place | null {
  const raw = text.trim();
  if (!raw) return null;
  const t = fold(raw);
  // a three-letter word that is a country's name ("USA") means the country, not the airport with that
  // code (USA = Concord, NC); an airport picked from the list comes as "Concord USA"
  const core = t.replace(/^(z|ze|do|na|w|we|od|przez)\s+/, "");
  if (/^[a-z]{3}$/.test(core)) {
    const cc = Object.entries(COUNTRY_PL).find(([, [name, stems]]) => fold(name) === core || stems.some((x) => fold(x) === core))?.[0];
    const codes = cc ? countryCodes(cc) : [];
    if (cc && codes.length) return { codes, label: COUNTRY_PL[cc][0], country: cc };
  }
  if (/^[A-Z]{3}$/.test(raw) && AP[raw]) return { codes: [raw], label: AP[raw].city };
  const iatas = raw.match(/\b[A-Z]{3}\b/g)?.filter((c) => AP[c]);
  if (iatas?.length) return { codes: iatas, label: iatas.length === 1 ? AP[iatas[0]].city : iatas.join("/") };
  const en = resolveEnglish(t);
  if (en) return en;
  if (/^(gdziekolwiek|dokadkolwiek|dowolnie|dowolne miejsce|wszedzie|anywhere|caly swiat|swiat)$/.test(t)) {
    return { codes: AIRPORTS.map((a) => a.iata), label: "gdziekolwiek" };
  }
  if (/poza europ|spoza europ|poza kontynent/.test(t)) {
    return { codes: AIRPORTS.filter((a) => a.region !== "EUR").map((a) => a.iata), label: "poza Europą" };
  }
  if (/^(SEA|SAM|CAR|SAS|EAS|MEA|AFR|OCE|NAM|EUR|NAF|CAU|CAS)$/.test(raw)) {
    return { codes: regionCodes((r) => r === raw), label: REGIONS[raw] };
  }
  for (const [reg, aliases] of REGION_ALIASES) {
    if (aliases.some((a) => t.includes(fold(a)))) {
      const codes = regionCodes((r) => r === reg || (reg === "AFR" && r === "NAF"));
      return { codes, label: REGIONS[reg] };
    }
  }
  const words = t.split(/[^a-z0-9]+/).filter(Boolean);
  if (words.some((w) => /^azj/.test(w))) {
    return { codes: AIRPORTS.filter((a) => ["SAS", "SEA", "EAS", "CAS"].includes(a.region)).map((a) => a.iata), label: "Azja" };
  }
  // cities (Polish and English names, tolerant to declension)
  const cityHits = new Map<string, string[]>();
  for (const a of AIRPORTS) {
    for (const name of [a.city.split("-")[0], a.cityEn]) {
      const n = fold(name);
      const parts = n.split(" ");
      const stem = parts[parts.length - 1].length > 4 ? n.slice(0, -1) : n.slice(0, Math.max(3, n.length - 1));
      const joined = words.join(" ");
      // several words: each declined on its own ("Nowego Jorku", "Nowym Jorku" -> Nowy Jork)
      const each = parts.length > 1 && parts.every((pt) => words.some((w) => w.startsWith(pt.slice(0, Math.max(3, pt.length - 1))) && w.length <= pt.length + 4));
      const hit = parts.length > 1
        ? joined.includes(n) || joined.includes(stem) || each
        : words.some((w) => w.startsWith(stem) && w.length <= stem.length + 3);
      if (hit) {
        const key = a.city.split("-")[0];
        if (!cityHits.has(key)) cityHits.set(key, []);
        cityHits.get(key)!.push(a.iata);
        break;
      }
    }
  }
  if (cityHits.size) {
    const [label, codes] = [...cityHits.entries()].sort((x, y) => y[0].length - x[0].length)[0];
    return { codes: [...new Set(codes)], label };
  }
  // every other airport with scheduled service: city, English name, airport name or alias, matched
  // strictly (the whole text, or a whole word of a one-word name) so short words never hit by accident
  const bare = t.replace(/^(do|na|w|we|z|ze|od|przez)\s+/, "").trim();
  const extraHits = EXTRA_AIRPORTS.filter((a) => [a.city, a.cityEn, a.name, ...(a.aliases ?? [])].some((n) => {
    const f = fold(n);
    return f === bare || (f.length >= 4 && !f.includes(" ") && words.includes(f)) || (bare.length >= 5 && f.startsWith(bare + " "));
  })).sort((a, b) => SIZE_RANK[a.size ?? "S"] - SIZE_RANK[b.size ?? "S"]);
  if (extraHits.length) {
    const city = extraHits[0].city;
    const codes = extraHits.filter((a) => a.city === city).map((a) => a.iata);
    return { codes, label: city };
  }
  for (const [cc, [name, stems]] of Object.entries(COUNTRY_PL)) {
    if (stems.some((s) => words.some((w) => w.startsWith(fold(s))) || (" " + t).includes(" " + fold(s)))) {
      const codes = countryCodes(cc);
      if (codes.length) return { codes, label: name, country: cc };
    }
  }
  for (const [cc, name] of countriesByName()) {
    const f = fold(name);
    const stem = f.length > 5 ? f.slice(0, -1) : f;
    if (bare === f || (stem.length >= 4 && (" " + bare).includes(" " + stem))) {
      const codes = countryCodes(cc);
      if (codes.length) return { codes, label: name, country: cc };
    }
  }
  return null;
}

const MONTHS: [RegExp, number][] = [
  [/\bstyczn?\w*|\bstyczen\b/, 1], [/\blut\w*/, 2], [/\bmar(zec|ca|cu)\b/, 3], [/\bkwie\w*/, 4], [/\bmaj\w*\b/, 5],
  [/\bczerw\w*/, 6], [/\blip\w*/, 7], [/\bsierp\w*/, 8], [/\bwrze\w*/, 9], [/\bpazdzier\w*/, 10], [/\blistopad\w*/, 11], [/\bgrud\w*/, 12],
];

export function ruleParse(q: string, today = isoDay(Date.now())): Partial<SearchParams> & { originText?: string; destText?: string } {
  let t = fold(q);
  const out: Partial<SearchParams> & { originText?: string; destText?: string } = {};
  // places
  const head = q.split(/,/)[0];
  let m = head.split(/\s*(?:→|->|–>|—>|=>)\s*/);
  if (m.length < 2) {
    const mm = head.match(/^\s*(?:z\s+)?(.+?)\s+(?:do|na)\s+(.+)$/i);
    if (mm) m = [mm[1], mm[2]];
  }
  if (m.length >= 2) {
    out.originText = m[0].replace(/^\s*z\s+/i, "");
    out.destText = m.slice(1).join(" ").replace(/^(dowolne miejsce|gdziekolwiek|dowolnie)\s+(w|na)\s+/i, "");
  } else if (/poza europ|gdziekolwiek|dokadkolwiek|dowoln\w* kierun/.test(fold(head))) {
    out.destText = /poza europ/.test(fold(head)) ? "poza Europą" : "gdziekolwiek";
  }
  // stopovers ("przesiadki do 3 dni") are read first, so their days are not taken for the stay
  const so = t.match(/(?:przesiad\w*|stopover\w*|postoj\w*)\s*(?:do|max\.?|maks\.?|nawet)?\s*(\d)\s*(?:dni|dzien|dnia|doby)/);
  if (so) { out.stopoverDays = Math.min(7, Number(so[1])); t = t.replace(so[0], " "); }
  const bud = t.match(/(?:do|max\.?|maks\.?|budzet|ponizej|za)\s*(\d[\d\s]{1,6}\d)\s*(?:zl|pln)/);
  if (bud) out.budget = Number(bud[1].replace(/\s/g, ""));
  // month window
  const year = t.match(/\b(20\d\d)\b/)?.[1];
  // one month, a range ("luty–marzec"), or "until" ("dowolnie do maja": from tomorrow)
  const hits = MONTHS.map(([re, mon]) => { const x = re.exec(t); return x ? { i: x.index, mon } : null; })
    .filter((x): x is { i: number; mon: number } => !!x).sort((a, b) => a.i - b.i);
  if (hits.length) {
    const monthOf = (mon: number, after?: string) => {
      let y = year ? Number(year) : Number(today.slice(0, 4));
      const ms = (yy: number) => `${yy}-${String(mon).padStart(2, "0")}`;
      if (!year && ms(y) < today.slice(0, 7)) y++;
      if (after && ms(y) < after) y++;
      return ms(y);
    };
    const first = monthOf(hits[0].mon);
    const last = hits.length > 1 ? monthOf(hits[hits.length - 1].mon, first) : first;
    const until = hits.length === 1 && /\bdo\s*$/.test(t.slice(0, hits[0].i));
    out.dateFrom = until || `${first}-01` < addDays(today, 1) ? addDays(today, 1) : `${first}-01`;
    out.dateTo = monthEnd(last);
    if (hits.length > 1 || until) out.flexMode = "days";
  }
  const dr = t.match(/(\d{1,2})\s*(?:[-–—]|do)\s*(\d{1,2})\s*(dni|dzien|tyg)/);
  if (dr) {
    const k = dr[3].startsWith("tyg") ? 7 : 1;
    out.stayMin = Number(dr[1]) * k; out.stayMax = Number(dr[2]) * k;
  } else {
    const d1 = t.match(/(\d{1,2})\s*(dni|tyg)/);
    if (d1) { const k = d1[2].startsWith("tyg") ? 7 : 1; out.stayMin = out.stayMax = Number(d1[1]) * k; }
    else if (/\btydzien\b/.test(t)) { out.stayMin = 6; out.stayMax = 8; }
    else if (/weekend/.test(t)) { out.stayMin = 2; out.stayMax = 3; }
  }
  if (/w jedna strone|jednokierunk|one[- ]way|bez powrotu/.test(t)) out.oneWay = true;
  if (/caly miesiac|calym miesiacu|elastycz/.test(t)) out.flexMode = "month";
  const mx = t.match(/(?:max\.?|maks\.?|maksymalnie|do)\s*(\d)\s*przesiad/);
  if (mx) out.maxLegs = Number(mx[1]) + 1;
  else if (/bez przesiadek|bezposredni/.test(t)) out.maxLegs = 1;
  if (/rejestrowan|walizk|bagaz rej|z bagazem/.test(t)) out.baggage = "checked";
  else if (/podreczn/.test(t)) out.baggage = "cabin";
  if (/bez noclegu|bez nocowania/.test(t)) out.allowOvernight = false;
  const mh = t.match(/max\.?\s*(\d{2,3})\s*(h|godz)/);
  if (mh) out.maxTripH = Number(mh[1]);
  return out;
}

export type ParseResult = { params: SearchParams; via: "llm" | "rules"; usd: number; problems: string[] };

/** from: the "skąd" field (overrides the origin in the text); homeText: the home city for the bus access. */
export async function parseQuery(q: string, overrides: Partial<SearchParams> = {}, from?: string, homeText?: string): Promise<ParseResult> {
  const today = isoDay(Date.now());
  const r = ruleParse(q, today);
  let via: "llm" | "rules" = "rules";
  let usd = 0;
  const problems: string[] = [];
  if (from?.trim()) {
    r.originText = from.trim();
    if (!r.destText) r.destText = q.split(/,/)[0].replace(/^\s*(?:do|na)\s+/i, "");
  }
  let originText = r.originText, destText = r.destText;
  // Rules first; Claude (cheapest model) only when the rules cannot resolve the places.
  const rulesOk = !!(r.destText && resolvePlace(r.destText)) && (!r.originText || !!resolvePlace(r.originText));
  try {
    const l = rulesOk ? null : await llmParse(q, today);
    if (l) {
      via = "llm"; usd = l.usd;
      const d = l.data;
      originText = d.origin || originText; destText = d.destination || destText;
      if (d.date_from) r.dateFrom = d.date_from < addDays(today, 1) ? addDays(today, 1) : d.date_from;
      if (d.date_to) r.dateTo = d.date_to;
      if (d.one_way !== null) r.oneWay = d.one_way;
      if (d.stay_min_days !== null) r.stayMin = d.stay_min_days;
      if (d.stay_max_days !== null) r.stayMax = d.stay_max_days;
      if (d.max_connections !== null) r.maxLegs = d.max_connections + 1;
      if (d.baggage) r.baggage = d.baggage;
      if (d.allow_overnight !== null) r.allowOvernight = d.allow_overnight;
    }
  } catch (e) {
    problems.push(`LLM niedostępny (${(e as Error).message.slice(0, 80)}), użyto parsera regułowego`);
  }
  let origin = resolvePlace(originText ?? "") ?? (originText ? null : { codes: ["POZ"], label: "Poznań" });
  let dest = resolvePlace(destText ?? "");
  // Rule parser as a safety net when the model's wording does not resolve.
  if (!origin && r.originText) origin = resolvePlace(r.originText);
  if (!dest && r.destText) dest = resolvePlace(r.destText);
  if (!origin) problems.push(`Nie rozpoznano miejsca startu: "${originText ?? ""}"`);
  if (!dest) problems.push(`Nie rozpoznano celu: "${destText ?? ""}"`);
  // a country as the origin: every airport in it is a departure option, the bus starts from home
  const homePlace = homeText?.trim() ? resolvePlace(homeText) : null;
  if (homeText?.trim() && !homePlace) problems.push(`Nie rozpoznano miasta startowego: "${homeText}"`);
  const home = homePlace?.codes[0] ?? overrides.home ?? (origin?.country ? (origin.codes.includes("POZ") ? "POZ" : origin.codes[0]) : origin?.codes[0] ?? "POZ");
  const dateFrom = r.dateFrom ?? addDays(today, 14);
  const params: SearchParams = {
    query: q,
    origin: origin?.country ? [home] : origin?.codes ?? ["POZ"],
    originLabel: origin?.label ?? "Poznań",
    ...(origin?.country ? { departs: origin.codes } : {}),
    home, access: false, abroad: false, maxAccessH: 4,
    dest: (dest?.codes ?? []).filter((c) => !(origin?.codes ?? []).includes(c)),
    destLabel: dest?.label ?? "?",
    dateFrom,
    dateTo: r.dateTo ?? addDays(dateFrom, 30),
    oneWay: r.oneWay ?? false,
    stayMin: r.stayMin ?? 7,
    stayMax: r.stayMax ?? Math.max(r.stayMin ?? 7, 21),
    // no connection limit by default: the total travel time is the limit
    maxLegs: Math.min(8, Math.max(1, r.maxLegs ?? 8)),
    baggage: r.baggage ?? "cabin",
    allowOvernight: r.allowOvernight ?? true,
    maxTripH: r.maxTripH ?? 96,
    minConnSameH: config.rules.minConnSameH,
    minConnChangeH: config.rules.minConnChangeH,
    flexMode: r.flexMode,
    stopoverDays: r.stopoverDays ?? 3,
    countHotel: true,
    ...(r.budget && (dest?.codes.length ?? 0) > 40 ? { mode: "anywhere" as const, budget: r.budget } : r.budget ? { budget: r.budget } : {}),
    ...overrides,
  };
  if (homePlace) params.home = home;
  return { params, via, usd, problems };
}

/** The search form (primary input): structured fields, places resolved like the parser does. */
export type SearchForm = {
  from: string; to: string; toRet?: string;
  type: "rt" | "ow" | "oj";
  dateMode: "exact" | "days" | "month" | "any6";
  dateFrom: string; dateTo?: string; retDate?: string;
  stayMin?: number; stayMax?: number; pax?: number;
  home?: string; access?: boolean; abroad?: boolean; strict?: boolean; maxTripH?: number; stopoverDays?: number; countHotel?: boolean;
  /** longest bus/train ride home -> departure airport (and back): 2, 4 (default), 6, 0 = no limit */
  maxAccessH?: number;
  baggage?: "cabin" | "checked";
  depth?: "fast" | "deep";
  researchMin?: number;
};

export function parseForm(f: SearchForm, today = isoDay(Date.now())): ParseResult {
  const problems: string[] = [];
  const isAny = (s: string) => /gdziekolwiek|dokadkolwiek|dowoln|wszedzie|anywhere/.test(fold(s));
  const origin = resolvePlace(f.from || "Poznań");
  // "gdziekolwiek" is the whole world, Europe included ("poza Europą" stays its own choice)
  const dest = isAny(f.to) ? resolvePlace("gdziekolwiek") : resolvePlace(f.to);
  const destRet = f.type === "oj" && f.toRet ? resolvePlace(f.toRet) : null;
  if (!origin) problems.push(`Nie rozpoznano miejsca startu: "${f.from}"`);
  if (!dest) problems.push(`Nie rozpoznano celu: "${f.to}"`);
  if (f.type === "oj" && f.toRet && !destRet) problems.push(`Nie rozpoznano miejsca powrotu: "${f.toRet}"`);
  const homePlace = f.home ? resolvePlace(f.home) : null;
  const home = homePlace?.codes[0] ?? (origin?.country ? (origin.codes.includes("POZ") ? "POZ" : origin.codes[0]) : origin?.codes[0] ?? "POZ");
  const tomorrow = addDays(today, 1);
  let dateFrom = f.dateFrom && f.dateFrom >= tomorrow ? f.dateFrom : tomorrow;
  let dateTo = f.dateTo && f.dateTo >= dateFrom ? f.dateTo : dateFrom;
  let flexMode: SearchParams["flexMode"] = f.dateMode === "exact" ? "exact" : f.dateMode === "month" ? "month" : "days";
  if (f.dateMode === "month") { dateFrom = dateFrom.slice(0, 8) + "01" < tomorrow ? tomorrow : dateFrom.slice(0, 8) + "01"; dateTo = monthEnd(dateTo.slice(0, 7)); }
  if (f.dateMode === "any6") { dateFrom = tomorrow; dateTo = addDays(today, 182); flexMode = "days"; }
  const oneWay = f.type === "ow";
  // exact dates with a return date: the stay is fixed by the two dates
  let stayMin = f.stayMin ?? 7, stayMax = f.stayMax ?? 21;
  if (!oneWay && f.dateMode === "exact" && f.retDate && f.retDate > dateFrom) {
    stayMin = stayMax = Math.round((Date.parse(f.retDate) - Date.parse(dateFrom)) / 86400_000);
  }
  const big = (dest?.codes.length ?? 0) > 40;
  const params: SearchParams = {
    query: `${f.from} → ${f.to}${destRet ? ` / powrót z ${f.toRet}` : ""}`,
    origin: origin?.country ? [home] : origin?.codes ?? ["POZ"],
    originLabel: origin?.label ?? "Poznań",
    ...(origin?.country ? { departs: origin.codes } : {}),
    home, access: f.access ?? false, abroad: f.abroad ?? false, maxAccessH: f.maxAccessH ?? 4,
    ...(f.strict ? { strict: true } : {}),
    dest: (dest?.codes ?? []).filter((c) => !(origin?.codes ?? []).includes(c)),
    destLabel: dest?.label ?? "?",
    ...(destRet ? { destRet: destRet.codes, destRetLabel: destRet.label } : {}),
    dateFrom, dateTo, oneWay,
    stayMin: Math.min(stayMin, stayMax), stayMax,
    maxLegs: 8,
    baggage: f.baggage ?? "cabin",
    allowOvernight: true,
    maxTripH: f.maxTripH ?? 96,
    minConnSameH: config.rules.minConnSameH,
    minConnChangeH: config.rules.minConnChangeH,
    flexMode, dateMode: f.dateMode, tripType: f.type,
    stopoverDays: f.stopoverDays ?? 3,
    countHotel: f.countHotel ?? true,
    pax: Math.max(1, Math.min(9, f.pax ?? 1)),
    depth: f.depth === "deep" ? "deep" : "fast",
    ...(f.depth === "deep" && f.researchMin ? { researchMin: Math.max(10, Math.min(600, f.researchMin)) } : {}),
    ...(big && oneWay ? { mode: "anywhere" as const, budget: 2000 } : {}),
  };
  return { params, via: "rules", usd: 0, problems };
}
