// Doorbell for the laptop worker without touching Postgres: a value in Vercel's shared data cache that
// changes whenever a worker search is queued. The idle worker reads it over HTTP every few seconds and
// only then queries Neon, so the database can suspend between searches (the free plan's compute quota
// ran out when the worker polled it every 3 s around the clock).
import { revalidateTag, unstable_cache } from "next/cache";

const TAG = "worker-bell";

/** The time of the last ring (or of the first read after it); changes on every ring. */
export const bellValue = unstable_cache(async () => Date.now(), [TAG], { tags: [TAG] });

/** Call from a request handler after queueing a worker search. */
export function ring() {
  try {
    revalidateTag(TAG);
  } catch (e) {
    console.error("bell", (e as Error).message); // outside a request (scripts): the worker's periodic sweep picks it up
  }
}
