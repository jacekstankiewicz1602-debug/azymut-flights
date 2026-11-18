// "Szybki wynik ~30 s, pełne szukanie ~15 min": how long similar searches took before. Similar =
// same kind of destination (one place / a region of several cities), same depth, comparable date span.
import { destCities } from "./engine";
import { sqlClient } from "./db";
import type { SearchParams } from "./types";

export type Estimate = { quickSec: number; fullSec: number; samples: number };

const spanDays = (p: SearchParams) => Math.max(1, Math.round((Date.parse(p.dateTo) - Date.parse(p.dateFrom)) / 86400_000) + 1);
const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };

export async function estimate(p: SearchParams): Promise<Estimate> {
  const region = destCities(p.dest).size >= 3;
  const deep = p.depth === "deep";
  // defaults when there is no history yet: a quick answer within half a minute, the full search by kind
  const def: Estimate = { quickSec: 30, fullSec: deep ? 3 * 3600 : region ? 40 * 60 : 15 * 60, samples: 0 };
  const sql = await sqlClient().catch(() => null);
  if (!sql) return def;
  const rows = await sql`select params, stats, status, extract(epoch from (updated_at - created_at))::int as sec from live_searches
    where status in ('done', 'limit', 'stopped') and runner = 'worker' and created_at > now() - interval '30 days' order by created_at desc limit 300`.catch(() => []);
  const span = spanDays(p);
  const similar = (rows as unknown as { params: SearchParams; stats: { firstSec?: number } | null; status: string; sec: number }[]).filter((r) => {
    const q = r.params;
    if (!q?.dest?.length || q.mode === "anywhere") return false;
    if ((destCities(q.dest).size >= 3) !== region || (q.depth === "deep") !== deep) return false;
    const s = spanDays(q);
    return s >= span / 2.5 && s <= span * 2.5;
  });
  const quick = similar.map((r) => r.stats?.firstSec).filter((x): x is number => typeof x === "number" && x > 0);
  // the full time: finished searches (proven or at their limit); stopped ones only say "at least"
  const full = similar.filter((r) => r.status !== "stopped").map((r) => r.sec).filter((x) => x > 0);
  return {
    quickSec: quick.length ? Math.max(5, Math.round(median(quick))) : def.quickSec,
    fullSec: full.length >= 2 ? Math.round(median(full)) : full.length ? Math.round((full[0] + def.fullSec) / 2) : def.fullSec,
    samples: full.length,
  };
}
