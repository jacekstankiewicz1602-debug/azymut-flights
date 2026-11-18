// GitHub Actions radar worker (runs after each map batch): housekeeping, price history and deal
// feeds every run; the full anomaly scan and the hub ranking once a day.
import { db } from "../lib/db";
import { alert, cleanup, rankHubs, recordHistory, scanAnomalies, scanFeeds } from "../lib/radar";

async function main() {
  const seconds = Number(process.env.RADAR_SECONDS ?? 200);
  const deadline = Date.now() + seconds * 1000;
  const log = (s: string) => console.log(s);
  await cleanup(log).catch((e) => log(`cleanup failed: ${e.message}`));
  await recordHistory().catch((e) => log(`history failed: ${e.message}`));
  await scanFeeds(Date.now() + Math.min(70, seconds / 3) * 1000, log).catch((e) => log(`feeds failed: ${e.message}`));
  const last = (await db.jobTimes())["radar:daily"] ?? 0;
  if (process.env.RADAR_FORCE === "1" || Date.now() - last > 20 * 3600_000) {
    await rankHubs(log).catch((e) => log(`hubs failed: ${e.message}`));
    const r = await scanAnomalies(deadline, log).catch((e) => { log(`scan failed: ${e.message}`); return null; });
    if (r) await db.markJob("radar:daily");
  }
  await alert(log).catch((e) => log(`alert failed: ${e.message}`));
  process.exit(0);
}
main().catch((e) => { console.error("radar worker error (non-fatal):", e); process.exit(0); });
