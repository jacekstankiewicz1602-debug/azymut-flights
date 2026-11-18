// Local smoke test of parser + engine: npx tsx scripts/test-engine.ts "query" ['{"access":false}']
// AZ_SECONDS limits the search time. Regression check: the result is never worse than Google.
import { runSearch } from "../lib/engine";
import { parseQuery } from "../lib/parse";

const T0 = Date.now();
async function main() {
const q = process.argv[2] ?? "Poznań → Lima, luty 2027, 14–21 dni, max 3 przesiadki, tylko podręczny";
const parsed = await parseQuery(q, process.argv[3] ? JSON.parse(process.argv[3]) : {});
const { via, problems } = parsed;
const params = parsed.params;
console.log("parsed via", via, problems, JSON.stringify({ ...params, dest: params.dest.length > 8 ? params.dest.length + " airports" : params.dest }));
const counts: Record<string, number> = {};
const r = await runSearch(params, (ev, d) => {
  counts[ev] = (counts[ev] ?? 0) + 1;
  if (ev === "best") console.log("BEST", (d as any).price, (d as any).nodes.join(" "));
  if (ev === "status" || ev === "meta") console.log(((Date.now() - T0) / 1000).toFixed(1) + "s", ev, JSON.stringify(d).slice(0, 140));
}, undefined, process.env.AZ_SECONDS ? { deadline: Date.now() + Number(process.env.AZ_SECONDS) * 1000 } : {});
console.log("events", counts);
for (const t of r.trips.slice(0, 5)) {
  console.log(`\n${t.price} zł  lb=${Math.round(t.lb)}  ${t.outDate} → ${t.retDate}  ${t.travelH}h  [${t.flags.join("; ")}]`);
  if (t.savings?.length) console.log("   savings:", t.savings.map((x) => `${x.label}: −${x.pln} zł`).join(" | "));
  for (const l of t.legs) console.log(`   ${l.dir} ${l.from}-${l.to} ${l.depLocal} → ${l.arrLocal} ${l.carrier} ${l.flightNo} ${l.price} zł ${l.source}${l.layoverH ? ` (przesiadka ${l.layoverH.toFixed(1)}h)` : ""}`);
}
console.log("\nbaseline", r.baseline?.price ?? null, r.baseline?.outDate, r.baseline?.retDate);
// Google's price plus the bus to its airport when the offer starts away from home (access on)
const floor = r.baseline ? r.baseline.price + (r.baseline.access ?? 0) : Infinity;
if (r.baseline && r.trips[0] && r.trips[0].price > floor) { console.error(`REGRESSION: ${r.trips[0].price} zł > Google ${r.baseline.price} zł + dojazd ${r.baseline.access ?? 0} zł`); process.exitCode = 1; }
else if (r.baseline && r.trips[0]) console.log(`OK: ${r.trips[0].price} zł <= Google ${r.baseline.price} zł + dojazd ${r.baseline.access ?? 0} zł`);
console.log("\nproven", r.provenOptimal, "gap", r.gap, "stats", JSON.stringify(r.stats), "\nnotes", r.notes, "\n", r.summary);
}
main();
