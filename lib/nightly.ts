// Periodic jobs the laptop worker runs when it is idle. Each job decides itself whether it is due.
import { anywhereCheapDue, runAnywhereCheap } from "./anywhere-cheap";
import { sqlClient } from "./db";
import { precomputeDue, runPrecompute } from "./precompute";

let lastCleanup = 0;
/** Keeps the free Neon database (1 GB) from filling up: expired API cache rows, resume checkpoints of
 *  finished searches, and live-search events older than 7 days. Runs at most every 6 hours. */
async function cleanup() {
  if (Date.now() - lastCleanup < 6 * 3600_000) return;
  lastCleanup = Date.now();
  const s = await sqlClient();
  if (!s) return;
  const a = await s`delete from api_cache where expires_at < now()`;
  const b = await s`update live_searches set cache = null where status <> 'running' and cache is not null`;
  const c = await s`delete from live_events where search_id in (select id from live_searches where status <> 'running' and updated_at < now() - interval '7 days')`;
  await s.unsafe("vacuum api_cache");
  await s.unsafe("vacuum live_searches");
  await s.unsafe("vacuum live_events");
  console.log(`[cleanup] cache ${a.count}, checkpoints ${b.count}, events ${c.count}`);
}

/** `interrupted` lets a long job yield when a user search is waiting; it resumes on the next idle call. */
export async function nightlyJobs(interrupted: () => Promise<boolean>): Promise<void> {
  await cleanup().catch((e) => console.error("cleanup", e));
  if (await anywhereCheapDue()) await runAnywhereCheap(interrupted, (s) => console.log(`[anywhere-cheap] ${s}`));
  // popular directions after the nightly list (it feeds the far destinations)
  else if (await precomputeDue()) await runPrecompute(interrupted, (s) => console.log(`[precompute] ${s}`));
}
