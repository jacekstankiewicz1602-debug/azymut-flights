// Booking links of the best trips of a search: npx tsx scripts/booking-links.ts <search id> [n]
import { sqlClient } from "../lib/db";
import { bookingFor } from "../lib/booking";
import type { Trip } from "../lib/engine";
(async () => {
  const sql = (await sqlClient())!;
  const [r] = await sql`select trips, params from live_searches where id = ${process.argv[2]}`;
  for (const t of (r.trips as Trip[]).slice(0, Number(process.argv[3] ?? 3))) {
    const b = bookingFor(t, (r.params as { pax?: number }).pax ?? 1);
    console.log(`\n${t.price} zł ${t.nodes.join("-")}`);
    if (b.whole) console.log(`  CAŁOŚĆ ${b.whole.source} ${b.whole.price}: ${b.whole.url}`);
    for (const k of b.tickets) console.log(`  #${k.ticket} ${k.source} ${k.from}-${k.to} ${k.date} ${k.price} zł ${k.risk}: ${k.url}`);
  }
  process.exit(0);
})();
