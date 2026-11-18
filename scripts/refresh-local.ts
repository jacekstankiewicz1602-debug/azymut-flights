// Builds the world map locally and saves it as the bundled seed snapshot.
import { writeFileSync } from "node:fs";
import { db } from "../lib/db";
import { nextMonths, refreshMap } from "../lib/map";

async function main() {
  const snap = await refreshMap(Date.now() + 12 * 60_000, (s) => console.log(s));
  const edges = await db.edges(nextMonths());
  writeFileSync("lib/data/seed-edges.json", JSON.stringify(edges));
  console.log("calls", JSON.stringify(snap), "edges", edges.length);
}
main();
