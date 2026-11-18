// Follows a live search every 10 s until it ends: elapsed, trips, phase, progress, ETA, gap.
// npx tsx scripts/watch-search.ts <id>
import { sqlClient } from "../lib/db";
(async () => {
  const sql = (await sqlClient())!;
  const id = process.argv[2];
  for (;;) {
    const [r] = await sql`select status, jsonb_array_length(trips) n, trips->0->>'price' best, stats->>'phase' phase, stats->'progress' pr, stats->>'firstSec' first, stats->'prelim' prelim, stats->'oneTicket'->>'price' one,
      gap, baseline->>'price' g, message, extract(epoch from (now() - created_at))::int el from live_searches where id = ${id}`;
    const pr = r.pr as { pct: number; etaSec: number | null; combos: number } | null;
    console.log(`${r.el}s ${r.status} trips=${r.n} best=${r.best} google=${r.g} phase=${r.phase} first=${r.first} prelim=${r.prelim ? `${r.prelim.price}@${r.prelim.sec}s` : "-"} one=${r.one} pct=${pr?.pct} eta=${pr?.etaSec} combos=${pr?.combos} gap=${r.gap} | ${String(r.message).slice(0, 70)}`);
    if (r.status !== "running") break;
    await new Promise((x) => setTimeout(x, 10_000));
  }
  process.exit(0);
})();
