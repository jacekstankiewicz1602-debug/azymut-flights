// Saved results from before Google's transfer airports were read: fill them in (and the Google round
// trip's return flight instead of the placeholder 12:00), then split the legs like a new search would.
//   node --import tsx scripts/backfill-vias.ts [search id prefix…]   (env from .env.local)
import { sqlClient } from "../lib/db";
import { expandVias, withTickets, type Trip, type TripLeg } from "../lib/engine";
import { googleOneWay } from "../lib/sources/google";
import { Meter } from "../lib/sources/http";

const meter = new Meter(0, 100_000);
const air = (c: string) => c.split(" + ")[0].trim().toLowerCase();

async function fill(t: Trip): Promise<Trip> {
  const legs: TripLeg[] = [];
  for (const l of t.legs) {
    if (l.source !== "google" || l.via) { legs.push(l); continue; }
    const date = l.depLocal.slice(0, 10);
    if (l.stops && !l.arrEstimated) {
      const same = (await googleOneWay(l.from, l.to, date, meter).catch(() => null))?.find((o) => o.depLocal === l.depLocal && o.arrLocal === l.arrLocal);
      legs.push(same?.via ? { ...l, via: same.via } : l);
    } else if (l.arrEstimated && l.dir === "ret") {
      const pick = ((await googleOneWay(l.from, l.to, date, meter).catch(() => null)) ?? []).filter((o) => air(o.carrier) === air(l.carrier))
        .sort((a, b) => (a.stops ?? 0) - (b.stops ?? 0) || a.price - b.price)[0];
      legs.push(pick ? { ...l, dep: pick.dep, arr: pick.arr, depLocal: pick.depLocal, arrLocal: pick.arrLocal, stops: pick.stops, via: pick.via, flightNo: pick.flightNo,
        arrEstimated: undefined, note: "powrót w tej samej rezerwacji: lot tej linii wg rozkładu Google, potwierdź godzinę przy rezerwacji" } : l);
    } else legs.push(l);
  }
  return withTickets(expandVias({ ...t, legs }));
}

(async () => {
  const sql = (await sqlClient())!;
  const ids = process.argv.slice(2);
  const rows = ids.length
    ? (await Promise.all(ids.map((i) => sql`select id, trips, stats from live_searches where id like ${i + "%"}`))).flat()
    : await sql`select id, trips, stats from live_searches where status <> 'running' and trips::text like '%"source": "google"%' order by created_at desc limit 20`;
  for (const r of rows) {
    const trips = await Promise.all((r.trips as Trip[]).map(fill));
    const st = r.stats as { oneTicket?: Trip | null } | null;
    const ot = st?.oneTicket ? await fill(st.oneTicket) : null;
    const n = trips.filter((t, i) => t.legs.length !== (r.trips as Trip[])[i].legs.length).length;
    await sql`update live_searches set trips = ${sql.json(trips as never)}, stats = ${sql.json({ ...(st ?? {}), ...(ot ? { oneTicket: ot } : {}) } as never)} where id = ${r.id}`;
    console.log(r.id, `${n}/${trips.length} tras z przesiadkami uzupełnionymi`);
  }
  process.exit(0);
})();
