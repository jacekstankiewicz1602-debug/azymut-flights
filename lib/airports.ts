import raw from "./data/airports.json";
import extra from "./data/airports-extra.json";

export type Airport = {
  iata: string; name: string; city: string; cityEn: string; country: string; cc: string;
  region: string; lat: number; lon: number; tz: string; metro: string | null; land: string;
  /** only on airports outside the core: OurAirports size (L large, M medium, S small) and search aliases */
  size?: "L" | "M" | "S"; aliases?: string[];
};

/** The curated core: airports the price map, radar and nightly jobs scan. */
export const AIRPORTS = raw as Airport[];
/** Every airport with scheduled passenger service and an IATA code (OurAirports): the core plus the rest. */
export const EXTRA_AIRPORTS = extra as Airport[];
export const ALL_AIRPORTS: Airport[] = [...AIRPORTS, ...EXTRA_AIRPORTS];
export const AP: Record<string, Airport> = Object.fromEntries(ALL_AIRPORTS.map((a) => [a.iata, a]));
export const isCore = (iata: string) => CORE.has(iata);
const CORE = new Set(AIRPORTS.map((a) => a.iata));

export const REGIONS: Record<string, string> = {
  EUR: "Europa", CAU: "Kaukaz", MEA: "Bliski Wschód", NAF: "Afryka Płn.", AFR: "Afryka",
  SAS: "Azja Płd.", SEA: "Azja Płd.-Wsch.", EAS: "Azja Wsch.", CAS: "Azja Środk.", OCE: "Oceania",
  NAM: "Ameryka Płn.", CAR: "Karaiby i Ameryka Śr.", SAM: "Ameryka Płd.",
};

// Polish country names with the stems that cover common declensions ("do Peru", "w Tajlandii").
export const COUNTRY_PL: Record<string, [string, string[]]> = {
  PL: ["Polska", ["polsk"]], DE: ["Niemcy", ["niemc", "niemiec"]], GB: ["Wielka Brytania", ["brytani", "angli"]],
  IE: ["Irlandia", ["irlandi"]], FR: ["Francja", ["francj", "francji"]], NL: ["Holandia", ["holandi"]],
  BE: ["Belgia", ["belgi"]], ES: ["Hiszpania", ["hiszpani"]], PT: ["Portugalia", ["portugali"]],
  IT: ["Włochy", ["włoch", "wloch"]], CH: ["Szwajcaria", ["szwajcari"]], AT: ["Austria", ["austri"]],
  DK: ["Dania", ["dani"]], SE: ["Szwecja", ["szwecj"]], NO: ["Norwegia", ["norwegi"]], FI: ["Finlandia", ["finlandi"]],
  GR: ["Grecja", ["grecj"]], CY: ["Cypr", ["cypr"]], MT: ["Malta", ["malt"]], TR: ["Turcja", ["turcj"]],
  GE: ["Gruzja", ["gruzj"]], AM: ["Armenia", ["armeni"]], AZ: ["Azerbejdżan", ["azerbejdżan", "azerbejdzan"]],
  AE: ["Zjednoczone Emiraty Arabskie", ["emirat", "zea"]], QA: ["Katar", ["katar"]], OM: ["Oman", ["oman"]],
  SA: ["Arabia Saudyjska", ["arabi saud", "arabii saud"]], JO: ["Jordania", ["jordani"]], IL: ["Izrael", ["izrael"]],
  EG: ["Egipt", ["egipt"]], MA: ["Maroko", ["marok"]], TN: ["Tunezja", ["tunezj"]], KE: ["Kenia", ["keni"]],
  TZ: ["Tanzania", ["tanzani"]], ZA: ["RPA", ["rpa", "afryki płd", "afryka płd"]], ET: ["Etiopia", ["etiopi"]],
  MU: ["Mauritius", ["mauritius"]], SC: ["Seszele", ["seszel"]], IN: ["Indie", ["indi"]], LK: ["Sri Lanka", ["sri lank"]],
  MV: ["Malediwy", ["malediw"]], NP: ["Nepal", ["nepal"]], TH: ["Tajlandia", ["tajlandi"]], MY: ["Malezja", ["malezj"]],
  SG: ["Singapur", ["singapur"]], ID: ["Indonezja", ["indonezj"]], VN: ["Wietnam", ["wietnam"]],
  PH: ["Filipiny", ["filipin"]], KH: ["Kambodża", ["kambodż", "kambodz"]], MM: ["Mjanma", ["mjanm", "birm"]],
  LA: ["Laos", ["laos"]], CN: ["Chiny", ["chin"]], JP: ["Japonia", ["japoni"]], KR: ["Korea Płd.", ["kore"]],
  TW: ["Tajwan", ["tajwan"]], HK: ["Hongkong", ["hongkong"]], KZ: ["Kazachstan", ["kazachstan"]],
  UZ: ["Uzbekistan", ["uzbekistan"]], AU: ["Australia", ["australi"]], NZ: ["Nowa Zelandia", ["zelandi"]],
  US: ["USA", ["usa", "stany", "stanów", "ameryk"]], CA: ["Kanada", ["kanad"]], MX: ["Meksyk", ["meksyk"]],
  DO: ["Dominikana", ["dominikan"]], CU: ["Kuba", ["kub"]], JM: ["Jamajka", ["jamajk"]], PA: ["Panama", ["panam"]],
  CR: ["Kostaryka", ["kostaryk"]], CO: ["Kolumbia", ["kolumbi"]], PE: ["Peru", ["peru"]], EC: ["Ekwador", ["ekwador"]],
  CL: ["Chile", ["chile"]], AR: ["Argentyna", ["argentyn"]], BR: ["Brazylia", ["brazyli"]], UY: ["Urugwaj", ["urugwaj"]],
  PY: ["Paragwaj", ["paragwaj"]], BO: ["Boliwia", ["boliwi"]], VE: ["Wenezuela", ["wenezuel"]],
  HR: ["Chorwacja", ["chorwacj"]], AL: ["Albania", ["albani"]], ME: ["Czarnogóra", ["czarnog"]],
  BG: ["Bułgaria", ["bułgari", "bulgari"]], RO: ["Rumunia", ["rumuni"]], HU: ["Węgry", ["węgr", "wegr"]],
  CZ: ["Czechy", ["czech"]], SK: ["Słowacja", ["słowacj"]], IS: ["Islandia", ["islandi"]],
};

export const REGION_ALIASES: [string, string[]][] = [
  ["SEA", ["azja płd.-wsch", "azji płd.-wsch", "azja południowo-wschodnia", "azji południowo-wschodniej", "azja pd-wsch", "azji pd.-wsch", "azja płd-wsch", "azji płd-wsch", "south east asia", "sea"]],
  ["SAM", ["ameryka płd", "ameryki płd", "ameryka południowa", "ameryki południowej", "ameryce południowej"]],
  ["CAR", ["karaib", "ameryka środkowa", "ameryki środkowej"]],
  ["SAS", ["azja płd.", "azji płd.", "azja południowa", "azji południowej"]],
  ["EAS", ["azja wsch", "azji wsch", "dalekiego wschodu", "daleki wschód"]],
  ["MEA", ["bliski wschód", "bliskiego wschodu", "zatok"]],
  ["AFR", ["afryk"]],
  ["OCE", ["oceani"]],
  ["NAM", ["ameryka płn", "ameryki płn", "ameryka północna", "ameryki północnej"]],
  ["EUR", ["europ"]],
];

// Entry requirements for Polish passport holders. Separate tickets usually mean leaving
// the airside area, so every connection country counts. Indicative only.
export const VISA_NOTE: Record<string, string> = {
  US: "ESTA", CA: "eTA", GB: "UK ETA", AU: "eVisitor", NZ: "NZeTA", IN: "e-Visa", LK: "ETA",
  KH: "e-Visa", MM: "e-Visa", BD: "wiza", NP: "wiza na lotnisku", KE: "eTA", TZ: "wiza", ET: "e-Visa",
  EG: "wiza na lotnisku", SA: "e-Visa", KW: "e-Visa", BH: "e-Visa", IL: "ETA-IL", JO: "wiza na lotnisku",
  CN: "sprawdź ruch bezwizowy", CU: "karta turysty", LA: "wiza na lotnisku",
};

const R = 6371;
export function km(a: Airport, b: Airport): number {
  const p = Math.PI / 180;
  const dLat = (b.lat - a.lat) * p, dLon = (b.lon - a.lon) * p;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * p) * Math.cos(b.lat * p) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Block time estimate in hours from great-circle distance. */
export function flightHours(a: Airport, b: Airport): number {
  return 0.6 + km(a, b) / 800;
}

export type Ground = { from: string; to: string; price: number; hours: number; kind: "metro" };

let groundCache: Ground[] | null = null;
/** Same-city airport changes (shuttle, metro, train). Longer ground legs come from FlixBus. */
export function groundTransfers(): Ground[] {
  if (groundCache) return groundCache;
  const out: Ground[] = [];
  for (const a of AIRPORTS) for (const b of AIRPORTS) {
    if (a !== b && a.metro && a.metro === b.metro) {
      const d = km(a, b);
      out.push({ from: a.iata, to: b.iata, price: Math.round(45 + d * 0.3), hours: 1 + d / 70, kind: "metro" });
    }
  }
  groundCache = out;
  return out;
}

export function label(iata: string): string {
  const a = AP[iata];
  return a ? `${a.city} (${iata})` : iata;
}
