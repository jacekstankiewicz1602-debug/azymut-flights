// GitHub Actions map worker: one batch of the world-map refresh, then exit.
// MAP_WORKER_SECONDS bounds the batch; jobs left over run in the next scheduled batch.
import { refreshMap } from "../lib/map";

async function main() {
  const seconds = Number(process.env.MAP_WORKER_SECONDS ?? 330);
  const t0 = Date.now();
  const r = await refreshMap(t0 + seconds * 1000, (s) => console.log(s));
  console.log(JSON.stringify(r));
  console.log(`took ${Math.round((Date.now() - t0) / 1000)} s`);
  process.exit(0);
}
main().catch((e) => { console.error("worker error (non-fatal):", e); process.exit(0); });
