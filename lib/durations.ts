// Block times per route, learned from sources that report real arrivals (Kiwi, Google, Ryanair).
// Wizz's timetable has departures only, so its arrivals use these when known.
import { db } from "./db";

const mem = new Map<string, number>();

export async function recordDuration(from: string, to: string, minutes: number) {
  if (!(minutes > 15 && minutes < 20 * 60)) return;
  const k = from + to;
  if (mem.get(k) === minutes) return;
  mem.set(k, minutes);
  await db.cacheSet(`dur:${k}`, minutes, 120 * 86400).catch(() => {});
}

export async function knownDuration(from: string, to: string): Promise<number | null> {
  const k = from + to;
  if (mem.has(k)) return mem.get(k)!;
  const v = await db.cacheGet<number>(`dur:${k}`).catch(() => null);
  if (v) mem.set(k, v);
  return v ?? null;
}
