// Prints the far "Gdziekolwiek tanio" top 20 and the largest number of rows per country.
import { listAnywhereCheap } from "../lib/anywhere-cheap";
import { AP } from "../lib/airports";

async function main() {
  const r = await listAnywhereCheap({ far: true });
  console.log("rows", r.rows.length, "hidden by the per-country cap", r.hidden);
  for (const x of r.rows.slice(0, 20)) console.log(`${x.dest} ${AP[x.dest].city} (${AP[x.dest].cc}) ${x.price ?? "~" + x.lb}`);
  const c = new Map<string, number>();
  for (const x of r.rows) c.set(AP[x.dest].cc, (c.get(AP[x.dest].cc) ?? 0) + 1);
  console.log("max per country", Math.max(...c.values()));
  process.exit(0);
}
void main();
