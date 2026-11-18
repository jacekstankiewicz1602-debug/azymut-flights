// npx tsx scripts/export-map.ts: the price map (edges) as data/map-snapshot.json.gz, the seed for a
// local install (npm run local loads it into an empty database)
import { writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { sqlClient } from "../lib/db";

(async () => {
  const sql = (await sqlClient())!;
  const rows = await sql`select origin, dest, month, min_price, source, flight_date, updated_at from edges where month >= to_char(now(), 'YYYY-MM') order by origin, dest, month, source`;
  const out = rows.map((r) => [r.origin, r.dest, r.month, Number(r.min_price), r.source, r.flight_date, new Date(r.updated_at).toISOString().slice(0, 10)]);
  const gz = gzipSync(JSON.stringify(out), { level: 9 });
  writeFileSync("data/map-snapshot.json.gz", gz);
  console.log(`${out.length} edges, ${(gz.length / 1e6).toFixed(2)} MB`);
  process.exit(0);
})();
