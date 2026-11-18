// Prints world-map coverage from Postgres: npx tsx scripts/map-status.ts (needs DATABASE_URL)
import postgres from "postgres";
async function main() {
  const sql = postgres(process.env.DATABASE_URL!, { ssl: "require", onnotice: () => {} });
  const [j] = await sql`select count(*)::int as n, max(ran_at) as last from map_jobs`;
  const bySrc = await sql`select source, count(*)::int as n from edges group by source order by n desc`;
  console.log("jobs done:", j.n, "last:", j.last?.toISOString?.() ?? j.last);
  console.log("edges:", bySrc.map((r) => `${r.source}=${r.n}`).join(" "));
  await sql.end();
}
main();
