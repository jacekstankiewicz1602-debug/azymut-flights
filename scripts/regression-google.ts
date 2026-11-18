// Regression: Azymut's best trip must never cost more than the Google baseline for the same search.
//   npx tsx scripts/regression-google.ts [minutesPerRoute] [onlyIndex]
// Runs the engine locally, one route at a time, each with a time cap; prints a table.
import { parseQuery } from "../lib/parse";
import { runSearch } from "../lib/engine";

const ROUTES = [
  "z Poznania do Lizbony, marzec, w jedną stronę",
  "z Polski do Barcelony, maj, tam i z powrotem",
  "z Polski do Reykjaviku, kwiecień, tam i z powrotem",
  "z Polski do Kirkenes, kwiecień, tam i z powrotem",
  "z Polski do Longyearbyen, kwiecień, tam i z powrotem",
  "z Polski do Tokio, marzec, w jedną stronę",
  "z Polski do Bangkoku, luty, tam i z powrotem",
  "z Polski do Nowego Jorku, kwiecień, tam i z powrotem",
  "z Polski do Limy, luty, tam i z powrotem",
  "z Polski do Dubaju, marzec, tam i z powrotem",
];

(async () => {
  const minutes = Number(process.argv[2] ?? 6);
  const only = process.argv[3] !== undefined ? Number(process.argv[3]) : null;
  const rows: { route: string; azymut: number | null; google: number | null; flight: number | null; source: string; ok: string; min: number; tickets: string }[] = [];
  for (const [i, q] of ROUTES.entries()) {
    if (only !== null && i !== only) continue;
    const t0 = Date.now();
    const { params } = await parseQuery(q);
    const r = await runSearch(params, () => {}, undefined, { deadline: Date.now() + minutes * 60_000, hardStop: Date.now() + (minutes + 4) * 60_000 }).catch((e) => { console.error(q, e); return null; });
    const best = r?.trips[0]?.price ?? null, g = r?.baseline?.price ?? null;
    const row = { route: q, azymut: best, google: g, flight: r?.baseline?.flight ?? null, source: r?.baselineStatus?.ok ? r.baselineStatus.source ?? "" : `BRAK: ${r?.baselineStatus?.note ?? "?"}`,
      ok: best === null ? "brak trasy" : g === null ? "bez Google" : best <= g ? "tak" : "NIE", min: Math.round((Date.now() - t0) / 6000) / 10,
      tickets: r ? `${r.stats.ticketWins?.combined ?? 0}/${r.stats.ticketWins?.separate ?? 0}` : "" };
    rows.push(row);
    console.log(JSON.stringify(row));
  }
  console.table(rows);
  process.exit(0);
})();
