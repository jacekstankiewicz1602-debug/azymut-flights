// Pushes the bundled map snapshot into Postgres: npx tsx --env-file=.env.local scripts/seed-db.ts
import snap from "../lib/data/seed-edges.json";
import { db, type Edge } from "../lib/db";

async function main() {
  await db.upsertEdges(snap as Edge[]);
  console.log(await db.meta());
  process.exit(0);
}
main();
