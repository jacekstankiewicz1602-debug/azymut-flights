// Prints a live search's status, its destination cities and the trip list (one line each).
import { liveStatus } from "../lib/live";
import { AP } from "../lib/airports";
import { cityKey, tripDest } from "../lib/engine";

async function main() {
  const s = await liveStatus(process.argv[2], 0);
  if (!s) { console.log("not found"); process.exit(1); }
  const st = s.stats as { destinations?: { code: string; city: string; checked: boolean; best: number | null }[]; free?: number } | null;
  console.log(s.status, s.message, `${s.elapsed}s`, "steps", s.steps, "free", st?.free, "baseline", (s.baseline as { price?: number } | null)?.price ?? null);
  for (const d of st?.destinations ?? []) console.log(" ", d.code, d.city, d.checked ? "checked" : "-", d.best);
  const cities = new Set(s.trips.map((t) => cityKey(tripDest(t))));
  console.log("trips", s.trips.length, "cities", cities.size);
  for (const t of s.trips) console.log(" ", t.price, AP[tripDest(t)]?.city, t.outDate, t.retDate, t.nodes.join("-"));
  process.exit(0);
}
void main();
