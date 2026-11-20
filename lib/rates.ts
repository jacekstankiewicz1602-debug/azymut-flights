// Exchange rates for showing prices in another currency (the engine stays in PLN). Free, no key:
// open.er-api.com (ExchangeRate-API's open endpoint, ~160 currencies, daily). Kept in Neon for 12 h,
// and the last good set is served when the source is down.
import { sqlClient } from "./db";

export type Rates = { at: number; base: "PLN"; rates: Record<string, number> };
const TTL = 12 * 3600_000;

export async function rates(): Promise<Rates | null> {
  const sql = await sqlClient();
  const [row] = sql ? await sql`select value from app_kv where key = 'fx'`.catch(() => []) : [];
  const cached = row?.value as Rates | undefined;
  if (cached && Date.now() - cached.at < TTL) return cached;
  try {
    const j = (await fetch("https://open.er-api.com/v6/latest/PLN", { signal: AbortSignal.timeout(8000) }).then((r) => r.json())) as { result?: string; rates?: Record<string, number> };
    if (j.result !== "success" || !j.rates?.EUR) throw new Error("rates");
    const fresh: Rates = { at: Date.now(), base: "PLN", rates: j.rates };
    if (sql) await sql`insert into app_kv (key, value) values ('fx', ${sql.json(fresh as never)}) on conflict (key) do update set value = excluded.value`.catch(() => {});
    return fresh;
  } catch {
    return cached ?? null;
  }
}
