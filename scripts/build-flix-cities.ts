// Maps airports to FlixBus city ids (autocomplete), within 60 km of the airport. Run once.
import { writeFileSync } from "node:fs";
import { AIRPORTS, km } from "../lib/airports";

async function main() {
  const out: Record<string, { id: string; name: string; km: number }> = {};
  for (const a of AIRPORTS.filter((x) => ["EUR", "NAM", "CAU"].includes(x.region))) {
    const q = a.cityEn.split(/[-/(]/)[0].trim();
    const r = await fetch(`https://global.api.flixbus.com/search/autocomplete/cities?q=${encodeURIComponent(q)}&lang=en&flixbus_cities_only=false`, {
      headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0 Safari/537.36" },
    }).catch(() => null);
    const list = r && r.ok ? ((await r.json()) as { id: string; name: string; country: string; location: { lat: number; lon: number } }[]) : [];
    const pick = list
      .filter((c) => c.country?.toUpperCase() === a.cc)
      .map((c) => ({ c, d: km(a, { ...a, lat: c.location.lat, lon: c.location.lon }) }))
      .filter((x) => x.d <= 60)
      .sort((x, y) => x.d - y.d)[0];
    if (pick) out[a.iata] = { id: pick.c.id, name: pick.c.name, km: Math.round(pick.d) };
    await new Promise((res) => setTimeout(res, 350));
  }
  writeFileSync("lib/data/flix-cities.json", JSON.stringify(out));
  console.log("mapped", Object.keys(out).length);
}
main();
