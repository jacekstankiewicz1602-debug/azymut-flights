// Live re-check of a stored trip: npx tsx scripts/recheck-check.ts <search id> [trip index]
import { sqlClient } from "../lib/db";
import { recheckTrip } from "../lib/recheck";
import type { Trip } from "../lib/engine";
(async () => {
  const sql = (await sqlClient())!;
  const [r] = await sql`select trips from live_searches where id = ${process.argv[2]}`;
  const t = (r.trips as Trip[])[Number(process.argv[3] ?? 0)];
  const t0 = Date.now();
  console.log(t.nodes.join("-"), t.price, JSON.stringify(await recheckTrip(t)), `${Date.now() - t0} ms`);
  process.exit(0);
})();
