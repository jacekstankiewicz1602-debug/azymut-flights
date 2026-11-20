// Polish place names inside text ("Radom → Islandia", "Radom – Szardża – Male") → English: the airport
// cities with an English name of their own, and every country (Intl, pl → en). The app (English
// interface) and the server (notifications for a phone set to English) both use it.
import airports from "./data/airports.json";
import extra from "./data/airports-extra-pos.json";

let PLACES: [RegExp, Record<string, string>] | null = null;
function places(): [RegExp, Record<string, string>] {
  if (PLACES) return PLACES;
  const map: Record<string, string> = {};
  for (const a of airports as { city: string; cityEn?: string }[]) for (const [pl, en] of [[a.city, a.cityEn], [a.city.split("-")[0], a.cityEn?.split("-")[0]]]) if (pl && en && pl !== en) map[pl] = en;
  try {
    const pl = new Intl.DisplayNames(["pl"], { type: "region" }), en = new Intl.DisplayNames(["en"], { type: "region" });
    const ccs = new Set([...(airports as { cc: string }[]).map((a) => a.cc), ...(extra as string[][]).map((a) => a[4])]);
    for (const cc of ccs) { const p = pl.of(cc), e = en.of(cc); if (p && e && p !== e && p !== cc) map[p] = e; }
  } catch { /* no Intl.DisplayNames */ }
  // the parser's labels for regions and the wide destinations
  Object.assign(map, {
    "gdziekolwiek": "anywhere", "poza Europą": "outside Europe", "Azja": "Asia", "Europa": "Europe", "Kaukaz": "Caucasus",
    "Bliski Wschód": "Middle East", "Afryka Płn.": "North Africa", "Afryka": "Africa", "Azja Płd.": "South Asia", "Azja Płd.-Wsch.": "Southeast Asia",
    "Azja Wsch.": "East Asia", "Azja Środk.": "Central Asia", "Oceania": "Oceania", "Ameryka Płn.": "North America",
    "Karaiby i Ameryka Śr.": "Caribbean and Central America", "Ameryka Płd.": "South America",
  });
  const keys = Object.keys(map).sort((a, b) => b.length - a.length).map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  // a label may end in a dot ("Azja Płd."): no letter may follow either way
  PLACES = [new RegExp(`(?<![\\p{L}])(${keys.join("|")})(?![\\p{L}])`, "gu"), map];
  return PLACES;
}

export function placesEn(text: string): string {
  const [re, map] = places();
  return text.replace(re, (m) => map[m] ?? m);
}
