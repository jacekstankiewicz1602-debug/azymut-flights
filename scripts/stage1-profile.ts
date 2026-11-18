// Where stage 1 (the quick answer) spends its time: phases, requests per source (pool wait, request
// time), Neon round trips and event-loop stalls, until the engine leaves the quick phase.
//   node --import tsx scripts/stage1-profile.ts "z Polski do Peru, luty" [--fresh] [--full]
import { db } from "../lib/db";
import { runSearch } from "../lib/engine";
import { parseQuery } from "../lib/parse";
import { fresh, netStats } from "../lib/sources/http";

(async () => {
  const q = process.argv[2];
  const full = process.argv.includes("--full");
  const { params } = (await parseQuery(q)) as { params: Parameters<typeof runSearch>[0] };
  const neon = { n: 0, ms: 0 };
  for (const k of Object.keys(db) as (keyof typeof db)[]) {
    const f = db[k] as (...a: unknown[]) => Promise<unknown>;
    (db as unknown as Record<string, unknown>)[k] = async (...a: unknown[]) => { const t = Date.now(); try { return await f(...a); } finally { neon.n++; neon.ms += Date.now() - t; } };
  }
  let lag = 0, lagMax = 0, last = Date.now();
  const tick = setInterval(() => { const d = Date.now() - last - 100; if (d > 50) { lag += d; lagMax = Math.max(lagMax, d); } last = Date.now(); }, 100);
  const t0 = Date.now();
  const at = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(6) + "s";
  const ctrl = new AbortController();
  let gseen = false;
  let phaseAt = t0, phaseName = "start", first: number | null = null, best = Infinity, prelim: unknown = null;
  const rows: string[] = [];
  const snap = () => JSON.stringify(Object.fromEntries(Object.entries(netStats).map(([k, v]) => [k, `${v.n} req, wait ${Math.round(v.waitMs / 1000)} s, req ${Math.round(v.fetchMs / 1000)} s, fail ${v.fail}`])));
  const emit = (ev: string, data: unknown) => {
    const d = data as Record<string, unknown>;
    if (ev === "status" && d.phase && d.phase !== phaseName) {
      rows.push(`${phaseName.padEnd(11)} ${((Date.now() - phaseAt) / 1000).toFixed(1).padStart(6)} s`);
      console.log(`${at()} phase ${d.phase}: ${String(d.message).slice(0, 80)}`);
      phaseName = String(d.phase); phaseAt = Date.now();
    }
    if (ev === "best" && typeof d.price === "number") { best = d.price; first ??= Date.now() - t0; console.log(`${at()} best ${d.price} (${d.origin})`); }
    if (ev === "stats" && d.baselineNow && !gseen) { gseen = true; console.log(`${at()} google ${(d.baselineNow as { price: number }).price}`); }
    if (ev === "stats" && d.prelim && !prelim) { prelim = d.prelim; console.log(`${at()} prelim ${JSON.stringify(d.prelim)}`); }
    if (ev === "stats" && d.phase === "full" && !full) ctrl.abort();
  };
  const run = () => runSearch(params, emit, ctrl.signal, { unlimited: true, deadline: Infinity, hardStop: Infinity });
  await (process.argv.includes("--fresh") ? fresh(run) : run()).catch((e) => console.log("end:", (e as Error).message));
  rows.push(`${phaseName.padEnd(11)} ${((Date.now() - phaseAt) / 1000).toFixed(1).padStart(6)} s`);
  clearInterval(tick);
  console.log(`\nstage 1 ${((Date.now() - t0) / 1000).toFixed(1)} s, first trip ${first === null ? "-" : (first / 1000).toFixed(1) + " s"}, best ${best}`);
  console.log("phases:\n  " + rows.join("\n  "));
  console.log("sources:", snap());
  console.log(`neon: ${neon.n} calls, ${(neon.ms / 1000).toFixed(1)} s; event loop stalls ${(lag / 1000).toFixed(1)} s (max ${lagMax} ms)`);
  process.exit(0);
})();
