// Departure airports and access estimates for a query: npx tsx scripts/departures-check.ts "<query>" [maxAccessH] [abroad]
import { parseQuery } from "../lib/parse";
import { accessEstH, withDeparture } from "../lib/departure";
(async () => {
  const { params } = await parseQuery(process.argv[2]);
  if (process.argv[3]) params.maxAccessH = Number(process.argv[3]);
  if (process.argv[4]) params.abroad = process.argv[4] === "1";
  const d = withDeparture(params);
  const home = d.home ?? d.origin[0];
  console.log(`limit ${params.maxAccessH ?? 4} h, abroad ${params.abroad}:`, [...d.origin, ...(d.ground ?? [])].map((c) => `${c} ${accessEstH(home, c).toFixed(1)}h`).join(", "));
  process.exit(0);
})();
