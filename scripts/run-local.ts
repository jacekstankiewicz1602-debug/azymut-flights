// Runs a queued search in this process exactly like the worker does (no time limit), claimed under
// another name so the worker leaves it alone:  npx tsx scripts/run-local.ts <id>
import { sqlClient } from "../lib/db";
import { runStep } from "../lib/live";

(async () => {
  const id = process.argv[2];
  const sql = (await sqlClient())!;
  await sql`update live_searches set claimed_by = 'local-run', updated_at = now() where id = ${id} and status = 'running'`;
  const t0 = Date.now();
  for (let round = 1; ; round++) {
    const more = await runStep(id, { stepSeconds: Infinity, hardSeconds: Infinity, maxMinutes: Infinity, unlimited: true });
    const [r] = await sql`select status, trips->0->>'price' best, baseline->>'price' g, stats->'progress' pr from live_searches where id = ${id}`;
    console.log(`[local] ${id} round ${round}: ${r.status} best ${r.best} google ${r.g} ${JSON.stringify(r.pr)} (${Math.round((Date.now() - t0) / 60000)} min)`);
    if (!more) break;
  }
  process.exit(0);
})();
