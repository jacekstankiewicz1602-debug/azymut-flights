// Hubs ranked from the map's data by the radar worker (table hub_rank), read by the engine.
import { AP } from "./airports";
import { sqlClient } from "./db";

/** Top ranked hubs for the regions of a search's destinations. */
export async function hubsFor(dest: string[], top = 30): Promise<string[]> {
  const s = await sqlClient();
  if (!s) return [];
  const regions = [...new Set(dest.map((c) => AP[c]?.region).filter(Boolean))] as string[];
  if (!regions.length) return [];
  const rows = await s`select hub from hub_rank where region in ${s(regions)} and rank <= ${top} order by rank`.catch(() => []);
  return [...new Set(rows.map((r) => r.hub as string))];
}
