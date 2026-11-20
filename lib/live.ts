// Resumable searches. A search runs as a chain of ~165 s steps (Vercel function slices). Each step
// replays the search deterministically: every external answer from earlier steps is in the
// Postgres response cache, so the replay costs no queries and takes seconds, then the step
// continues where the previous one stopped. The best trips found so far are carried over as
// the incumbent, so later steps prune more. Progress (best trips, gap, stats, recent arcs) is
// checkpointed about every 20 s; the UI polls it.
import { getHeapStatistics } from "node:v8";
import { randomUUID } from "node:crypto";
import { config } from "./config";
import { db, sqlClient } from "./db";
import { isReasonable, outboundWindow, pickTrips, runSearch, type DestStat, type Trip } from "./engine";
import { addDays } from "./time";
import { runAnywhere } from "./anywhere";
import type { SearchParams } from "./types";
import { exportCache, preloadCache, queryLog, touched } from "./sources/http";
import { bookingFor } from "./booking";
import { precomputedFor } from "./precompute";
import { pushSearch } from "./push";

export type LiveStatus = "running" | "done" | "limit" | "stopped" | "error";

type Row = {
  id: string; params: SearchParams; status: LiveStatus; created_at: Date; steps: number; meter: Record<string, number>;
  trips: Trip[]; stats: unknown; gap: number | null; lower_bound: number | null; notes: string[] | null; baseline: unknown;
  summary: string | null; error: string | null; message: string | null; seq: number; updated_at: Date;
};

/** The laptop worker, if one reported in the last minute. */
export async function workerOnline(): Promise<{ id: string; seenAt: number; info: unknown } | null> {
  const sql = await sqlClient();
  if (!sql) return null;
  const [w] = await sql`select id, seen_at, info from workers where seen_at > now() - make_interval(secs => ${config.worker.onlineSeconds}) order by seen_at desc limit 1`;
  return w ? { id: w.id as string, seenAt: new Date(w.seen_at).getTime(), info: w.info } : null;
}

/** Queue a search. With the worker online every search runs there; deep searches always wait for it. */
export async function startLive(params: SearchParams, notify?: string | null): Promise<{ id: string; runner: "vercel" | "worker" }> {
  const sql = await sqlClient();
  if (!sql) throw new Error("live searches need DATABASE_URL");
  const id = randomUUID().slice(0, 12);
  const online = await workerOnline();
  const runner = online || params.depth === "deep" ? "worker" : "vercel";
  const message = runner === "vercel" ? "start" : online ? "w kolejce na workerze" : "czekam na worker na laptopie (npm run worker)";
  await sql`insert into live_searches (id, params, status, message, runner, notify) values (${id}, ${sql.json(params as never)}, 'running', ${message}, ${runner}, ${notify ? [notify] : []})`;
  if (runner === "worker") (await import("./bell")).ring(); // next/cache only in request handlers, not in the worker
  return { id, runner };
}

/** unlimited: the laptop worker; no step deadline, deep budgets, rounds until the optimum is proven or the user stops */
export type StepOptions = { stepSeconds?: number; hardSeconds?: number; maxMinutes?: number; unlimited?: boolean };

/** Ask a search to stop and show its best result: it is marked stopped at once with the best trips
 *  saved so far (the page shows them right away); a worker still running it aborts within seconds
 *  (it polls the flag) and writes its final best trips over them. */
export async function requestStop(id: string): Promise<boolean> {
  const sql = await sqlClient();
  if (!sql) return false;
  const [r] = await sql`update live_searches set stop_requested = true where id = ${id} and status = 'running' returning runner, claimed_by`;
  if (!r) return false;
  await sql`update live_searches set status = 'stopped', message = 'zatrzymano – pokazuję najlepszy znaleziony wynik', updated_at = now() where id = ${id} and status = 'running'`;
  return true;
}

/** The cheapest one-booking trip (stats.oneTicket) is always in the list, after the others when it is pricier. */
function withOneTicket(trips: Trip[], stats: unknown): Trip[] {
  const one = (stats as { oneTicket?: Trip } | null)?.oneTicket;
  return one && !trips.some((t) => t.id === one.id) ? [...trips, one] : trips;
}

export async function liveStatus(id: string, since: number) {
  const sql = await sqlClient();
  if (!sql) return null;
  const [row] = (await sql`select id, params, status, created_at, updated_at, steps, meter, trips, stats, gap, lower_bound, notes, baseline, summary, error, message, seq, runner from live_searches where id = ${id}`) as unknown as (Row & { runner: string })[];
  if (!row) return null;
  const events = await sql`select seq, data from live_events where search_id = ${id} and seq > ${since} order by seq limit 400`;
  const elapsed = (new Date(row.updated_at).getTime() - new Date(row.created_at).getTime()) / 1000;
  return {
    id, status: row.status, params: row.params, steps: row.steps, stats: row.stats, meter: row.meter,
    // booking links are derived on read (nothing extra stored in the free database)
    trips: row.trips.map((t) => ({ ...t, booking: bookingFor(t, row.params.pax ?? 1) })),
    gap: row.gap === null ? null : Number(row.gap), lowerBound: row.lower_bound === null ? null : Number(row.lower_bound),
    notes: row.notes ?? [], baseline: row.baseline, summary: row.summary, error: row.error, message: row.message,
    runner: row.runner, elapsed: Math.round(elapsed), events: events.map((e) => ({ seq: e.seq as number, ...(e.data as object) })),
  };
}

/** Run one step of a live search; returns true when another step should follow. */
/** Extra minutes for a quick search that hit its time limit with a gap (see `extend` in runStep). */
export const EXTEND_MIN = 60;

export async function runStep(id: string, o: StepOptions = {}): Promise<boolean> {
  const sql = await sqlClient();
  if (!sql) return false;
  const [row] = (await sql`select id, params, status, created_at, updated_at, steps, meter, trips, stats, gap, lower_bound, notes, baseline, summary, error, message, seq from live_searches where id = ${id}`) as unknown as Row[];
  if (!row || row.status !== "running") return false;
  // answers this search already used: one read instead of hundreds of cache round trips
  const [c] = await sql`select cache from live_searches where id = ${id}`;
  if (c?.cache) preloadCache(c.cache as Record<string, { v: unknown; exp: number }>);
  touched.clear();
  const startedAt = new Date(row.created_at).getTime();
  const maxMinutes = o.maxMinutes ?? config.maxSearchMinutes;
  const hardEnd = startedAt + maxMinutes * 60_000;
  const stepEnd = Math.min(Date.now() + (o.stepSeconds ?? config.stepSeconds) * 1000, hardEnd);
  const hardStop = o.hardSeconds ? Math.min(Date.now() + o.hardSeconds * 1000, hardEnd + 120_000) : undefined;
  const anywhere = row.params.mode === "anywhere";
  const K = anywhere ? 30 : config.resultsK;

  // deep: rounds over the whole outbound range; each round replays earlier answers from the cache and
  // goes deeper. Only if the map search hits its memory cap is the range split into 7-day chunks, one
  // chunk per round; a chunk whose optimum is proven (nothing in it beats the best trip found anywhere)
  // is not searched again
  type DeepState = { chunks: [string, string][]; proven: boolean[]; lbs: (number | null)[]; round: number; chunk: number; stale?: number; capScale?: number; capped?: boolean };
  const prevStats = (row.stats ?? {}) as { deep?: DeepState; reasonable?: Trip | null; strategist?: { checked: number; hypotheses: unknown[] }; destinations?: DestStat[] };
  let deepState: DeepState | undefined = prevStats.deep;
  const rounds = (row.params.depth === "deep" || !!o.unlimited) && !anywhere;
  if (rounds) {
    if (!deepState) {
      deepState = { chunks: [outboundWindow(row.params)], proven: [false], lbs: [null], round: 0, chunk: -1 };
    }
    const n = deepState.chunks.length;
    let next = (deepState.chunk + 1) % n;
    for (let k = 0; k < n && deepState.proven[next]; k++) next = (next + 1) % n;
    deepState = { ...deepState, round: deepState.round + 1, chunk: next };
  }
  // seconds from the start to the first trip shown (the "quick answer"), for the time estimates
  let firstSec = (prevStats as { firstSec?: number }).firstSec ?? null;
  // the stage-1 price of the first round stays (later rounds start in stage 2)
  const extra = () => ({ firstSec, prelim: (lastStats as { prelim?: unknown } | null)?.prelim ?? (prevStats as { prelim?: unknown }).prelim, deep: deepState, reasonable: prevStats.reasonable ?? null, strategist: prevStats.strategist, destinations: (lastStats as { destinations?: DestStat[] } | null)?.destinations ?? prevStats.destinations });

  // events: buffered, written in small batches; the replay of earlier work is not re-emitted
  let seq = row.seq;
  const EVENTS_FULL = 3000;
  let evN = 0, lastEvAt = 0;
  let buf: { seq: number; data: unknown }[] = [];
  let best = row.trips[0]?.price ?? Infinity;
  const liveTrips = new Map<string, Trip>(row.trips.map((t) => [t.id, t]));
  let lastStats: unknown = row.stats;
  const ctrl = new AbortController();
  let stopAsked = false;
  let message = row.message ?? "";
  // a popular direction: the overnight trips are shown at once (marked), until the live search has its own
  if (row.steps === 0 && !row.trips.length) {
    const pre = await precomputedFor(row.params).catch(() => [] as Trip[]);
    if (pre.length) await sql`update live_searches set trips = ${sql.json(pre as never)}, message = 'ceny z nocnego przeliczenia – szukam aktualnych', updated_at = now() where id = ${id}`.catch(() => {});
  }
  const replayUntil = Date.now() + 4000;
  const stepT0 = Date.now();
  // the quick answer is written at once (not on the next 15 s checkpoint): the first trips and the end of
  // the quick phase show within seconds
  let lastCp = 0, lastPhase = "";
  const soon = () => { if (Date.now() - lastCp > 2500) { lastCp = Date.now(); void checkpoint(); } };
  // the query feed: at most ~3 lines a second reach the page (the counters in stats cover the rest)
  let lastQ = 0;
  const onQuery = (key: string, cached: boolean, ms: number, n: number | null) => {
    if (Date.now() < replayUntil) return;
    const now = Date.now();
    if (now - lastQ < 330) return;
    lastQ = now;
    buf.push({ seq: ++seq, data: { event: "q", key: key.slice(0, 120), cached, ms, n } });
  };
  const emit = (event: string, data: unknown) => {
    if (event === "stats") {
      lastStats = data;
      const ph = (data as { phase?: string }).phase ?? "";
      if (ph !== lastPhase) { lastPhase = ph; soon(); }
      return;
    }
    if ((event === "best" || event === "trip") && lastPhase === "quick") queueMicrotask(soon);
    if (event === "status") {
      message = (data as { message: string }).message;
      if (process.env.AZ_PHASELOG) console.log(`[phase] ${id} +${Math.round((Date.now() - stepT0) / 1000)}s ${(data as { phase?: string }).phase ?? ""}: ${message}`);
      return;
    }
    if ((event === "best" || event === "trip") && firstSec === null) firstSec = Math.round((Date.now() - startedAt) / 1000);
    if (event === "best") { best = Math.min(best, (data as Trip).price); liveTrips.set((data as Trip).id, data as Trip); }
    if (event === "trip") { liveTrips.set((data as Trip).id, data as Trip); return; }
    if (event === "leg" && Date.now() < replayUntil) return;
    // the arcs on the globe: every event at first, then at most ~10 a second (a long search checks tens of
    // thousands of paths a second; one row each queued inserts that held every connection, so the progress
    // writes and the stop flag stopped getting through)
    if (event !== "best" && ++evN > EVENTS_FULL) { const now = Date.now(); if (now - lastEvAt < 100) return; lastEvAt = now; }
    if (event === "candidate" || event === "verified" || event === "leg" || event === "best") {
      buf.push({ seq: ++seq, data: { event, ...(event === "best" ? { price: (data as Trip).price, nodes: (data as Trip).nodes } : (data as object)) } });
    }
  };
  let flushing = false;
  const flush = async () => {
    if (!buf.length || flushing) return;
    flushing = true;
    const rows = buf.map((b) => ({ search_id: id, seq: b.seq, data: b.data }));
    buf = [];
    try { await sql`insert into live_events ${sql(rows as never)} on conflict do nothing`.catch(() => {}); } finally { flushing = false; }
  };
  let cps = 0;
  // The response pack makes a resumed Vercel step fast. The worker keeps its state in memory and the
  // answers sit in the shared cache anyway, so it saves the pack rarely and small (Neon free: 1 GB).
  const savePack = async () => {
    // the worker runs a search in one process with no time limit: a pack of everything it touched can
    // grow to hundreds of MB (out of memory while serialising it); a resumed worker search reads the
    // shared response cache instead
    if (o.unlimited) return;
    const pack = exportCache(touched);
    const json = JSON.stringify(pack);
    if (json.length < (o.unlimited ? 3_000_000 : 12_000_000)) await sql`update live_searches set cache = ${sql.json(pack as never)} where id = ${id}`.catch(() => {});
  };
  const progressOf = () => {
    const pr0 = (lastStats as { progress?: { pct: number; etaSec: number | null; combos: number } } | null)?.progress;
    if (!pr0) return pr0;
    // combinations of earlier rounds count too
    const pr = { ...pr0, combos: ((row.stats as { combosTotal?: number } | null)?.combosTotal ?? 0) + pr0.combos };
    // never backwards across rounds (each round replays the search and climbs again); 100 only when proven
    const prevPct = Math.min(99, (row.stats as { progress?: { pct: number } } | null)?.progress?.pct ?? 0);
    if (!deepState || deepState.chunks.length < 2) return { ...pr, pct: Math.max(prevPct, Math.min(99.5, pr.pct)) };
    // weeks: proven ones count in full, the current one by its own progress
    const done = deepState.proven.filter(Boolean).length;
    const pct = Math.round(((done + (deepState.proven[deepState.chunk] ? 0 : pr.pct / 100)) / deepState.chunks.length) * 1000) / 10;
    return { ...pr, pct: Math.max(prevPct, Math.min(99.5, pct)), etaSec: null };
  };
  // light write every 5 s: progress, stats and the message (the UI polls them); the stop flag is read back
  const pulse = async () => {
    // the Google baseline as soon as the engine has it (the UI shows it next to the best price)
    const bNow = (lastStats as { baselineNow?: { price: number } } | null)?.baselineNow;
    const bOld = row.baseline as { price: number } | null;
    const bKeep = bNow && (!bOld || bNow.price < bOld.price) ? bNow : bOld;
    const [r] = await sql`update live_searches set stats = ${sql.json({ ...(lastStats as object), ...extra(), progress: progressOf() } as never)}, message = ${message},
      baseline = ${sql.json((bKeep ?? null) as never)}, updated_at = now() where id = ${id} returning stop_requested`.catch(() => [] as never[]);
    if ((r as { stop_requested?: boolean } | undefined)?.stop_requested && !stopAsked) { stopAsked = true; message = "zatrzymuję – zapisuję najlepszy wynik"; ctrl.abort(); }
  };
  const checkpoint = async () => {
    lastCp = Date.now();
    await flush();
    if (++cps % (o.unlimited ? 40 : 4) === 0) await savePack();
    const top = withOneTicket(anywhere ? [...liveTrips.values()].sort((a, b) => a.price - b.price).slice(0, K) : pickTrips([...liveTrips.values()], row.params.dest, K), lastStats);
    // no trip of its own yet: keep what is shown (the overnight trips of a popular direction)
    if (top.length) await sql`update live_searches set stats = ${sql.json({ ...(lastStats as object), ...extra(), progress: progressOf() } as never)}, trips = ${sql.json(top as never)}, seq = ${seq}, message = ${message}, updated_at = now() where id = ${id}`.catch(() => {});
    else await sql`update live_searches set stats = ${sql.json({ ...(lastStats as object), ...extra(), progress: progressOf() } as never)}, seq = ${seq}, message = ${message}, updated_at = now() where id = ${id}`.catch(() => {});
  };
  const timer = setInterval(() => { void checkpoint(); }, 15_000);
  const fast = setInterval(() => { void flush(); }, 2_000);
  const beat = setInterval(() => { void pulse(); }, 5_000);

  try {
    // "Zatrzymaj i pokaż wynik" does not wait for the engine to wind down (requests in flight can take a
    // minute): the best trips seen so far are the result, and the runner is free for the next search
    const aborted = new Promise<null>((res) => ctrl.signal.addEventListener("abort", () => res(null)));
    const r = await Promise.race([aborted, queryLog.run(onQuery, () => (anywhere ? runAnywhere : runSearch)(row.params, emit, ctrl.signal, { deadline: stepEnd, hardStop, incumbents: row.trips, meterBase: row.meter, final: true, unlimited: o.unlimited, capScale: deepState?.capScale,
      ...(deepState ? { outWindow: deepState.chunks.length > 1 ? deepState.chunks[deepState.chunk] : undefined, round: deepState.round } : {}) }))]);
    clearInterval(timer); clearInterval(fast); clearInterval(beat);
    await flush();
    if (!r) {
      const top = withOneTicket(anywhere ? [...liveTrips.values()].sort((a, b) => a.price - b.price).slice(0, K) : pickTrips([...liveTrips.values()], row.params.dest, K), lastStats);
      await sql`update live_searches set status = 'stopped', steps = steps + 1, cache = null, seq = ${seq},
        stats = ${sql.json({ ...(lastStats as object), ...extra(), best: top[0]?.price ?? null, progress: progressOf() } as never)},
        ${top.length ? sql`trips = ${sql.json(top as never)},` : sql``} message = 'zatrzymano – pokazuję najlepszy znaleziony wynik', updated_at = now() where id = ${id}`;
      return false;
    }
    const [sr] = await sql`select stop_requested from live_searches where id = ${id}`.catch(() => [] as never[]);
    if ((sr as { stop_requested?: boolean } | undefined)?.stop_requested) stopAsked = true;
    // keep going while there is time and budget: a paused step, or variants a source did not answer
    // for (retried after its backoff), or a capped map search
    const timeUp = Date.now() >= hardEnd - 5000;
    const budgetLeft = (r.stats.free ?? 0) < config.maxFreeCallsPerSearch * (deepState ? 8 : 1);
    const retryable = r.paused || r.unverified > 0 || r.truncated;
    // anywhere: a ranked list, not an optimum; it is finished once a step ran to the end
    // a round improved something: a cheaper trip, a higher bound for its week, or a first visit of the week
    let improved = true;
    if (deepState) {
      const prevChunkLb = deepState.lbs[deepState.chunk];
      const firstVisit = deepState.round <= deepState.chunks.length && prevChunkLb === null && !deepState.proven[deepState.chunk];
      improved = firstVisit || (r.trips[0]?.price ?? Infinity) < (row.trips[0]?.price ?? Infinity) - 0.5 || (r.lowerBound ?? 0) > (prevChunkLb ?? Infinity) + 0.5 || r.provenOptimal;
      deepState.proven[deepState.chunk] = r.provenOptimal;
      deepState.lbs[deepState.chunk] = r.provenOptimal ? null : r.lowerBound;
      // memory cap of the map search: the same graph serves every week, so first a round with twice the cap
      // (only with room for it: twice the cap needs ~1.6 GB more, a 3 GB heap ends in garbage-collection stalls)
      if (r.truncated && (deepState.capScale ?? 1) < 2 && getHeapStatistics().heap_size_limit > 6e9) { deepState.capScale = 2; improved = true; }
      else if (r.truncated && row.params.depth !== "deep") deepState.capped = true;
      else if (r.truncated && deepState.chunks.length === 1) { // deep: memory cap on the whole range, go week by week
        const [a, b] = deepState.chunks[0];
        const chunks: [string, string][] = [];
        for (let d = a; d <= b; d = addDays(d, 7)) chunks.push([d, addDays(d, 6) < b ? addDays(d, 6) : b]);
        deepState = { ...deepState, chunks, proven: chunks.map(() => false), lbs: chunks.map(() => null), chunk: -1 };
      }
    }
    const allProven = deepState ? deepState.proven.every(Boolean) : r.provenOptimal;
    // a deep search goes on round after round (next week, or the same week further) until every week is proven
    // rounds that improve nothing on every week twice over: stop, nothing left to gain
    if (deepState) deepState.stale = improved ? 0 : (deepState.stale ?? 0) + 1;
    const stuck = !!deepState && ((deepState.stale ?? 0) >= Math.max(2, deepState.chunks.length * 2) || !!deepState.capped);
    let status: LiveStatus = stopAsked ? "stopped" : anywhere ? (r.paused && !timeUp && budgetLeft ? "running" : "done")
      : allProven ? "done" : !timeUp && budgetLeft && !stuck && (retryable || !!deepState) ? "running" : "limit";
    if (deepState?.capped && !allProven) r.notes.push(`Przeszukiwanie mapy przekroczyło limit pamięci nawet przy podwojonym limicie (bez limitu przesiadek tras do sprawdzenia jest za dużo): część wariantów odpadła bez sprawdzenia, więc optimum nie jest udowodnione${r.lowerBound ? ` (sprawdzona część: nic tańszego niż ${Math.round(r.lowerBound)} zł)` : ""}.`);
    else if (stuck && !allProven) r.notes.push("Kolejne rundy nie poprawiały już ani ceny, ani dolnej granicy: część wariantów nie daje się sprawdzić (źródło nie odpowiada), więc optimum nie jest udowodnione.");
    if (!budgetLeft && !allProven) r.notes.push("Wyczerpany budżet zapytań do darmowych źródeł (ochrona przed blokadą): optimum nie jest udowodnione.");
    // the cheapest "rozsądna" trip: across rounds, the best one seen so far stays
    const prevR = prevStats.reasonable ?? null;
    const reasonable = [r.reasonable ?? null, prevR, ...r.trips.filter(isReasonable)].filter((t): t is Trip => !!t).sort((a, b) => a.price - b.price)[0] ?? null;
    const strategist = r.strategist ? { checked: Math.max(r.strategist.checked, prevStats.strategist?.checked ?? 0), hypotheses: r.strategist.hypotheses.slice(0, 40) } : prevStats.strategist;
    const notes = [...r.notes];
    const top0 = r.trips[0]?.price;
    const lbAll = Math.max(Number(row.lower_bound ?? 0), r.lowerBound ?? 0);
    if (timeUp && !r.provenOptimal && !anywhere) notes.push(`Limit ${maxMinutes} min na wyszukiwanie: optimum nie jest udowodnione, luka ≤ ${top0 && lbAll ? Math.max(0, top0 - lbAll) : "?"} zł.`);
    // a finished search needs no response pack (Neon free plan: 1 GB)
    if (status === "running") await savePack(); else await sql`update live_searches set cache = null where id = ${id}`.catch(() => {});
    lastStats = r.stats;
    const progress = status === "done" ? { ...(progressOf() ?? { etaSec: 0, combos: 0 }), pct: 100, etaSec: 0 } : progressOf();
    // keep only the best trips as the incumbent for the next step
    const keep = withOneTicket(anywhere ? r.trips.slice(0, K) : pickTrips(r.trips, row.params.dest, K), r.stats);
    // a region: every city with its best price, merged over steps (a city checked once stays checked)
    const prevD = (row.stats as { destinations?: DestStat[] } | null)?.destinations ?? [];
    const destinations = r.stats.destinations?.map((d) => {
      const o = prevD.find((x) => x.code === d.code);
      const b = [d.best, o?.best ?? null].filter((x): x is number => x !== null);
      return { ...d, checked: d.checked || !!o?.checked, best: b.length ? Math.min(...b) : null };
    }).sort((a, b) => (a.best ?? Infinity) - (b.best ?? Infinity)) ?? (prevD.length ? prevD : undefined);
    // a lower bound proven in any step stays valid: keep the best one (a cut-short step proves little)
    // deep: the bound is the lowest over weeks not yet proven (unknown while some week is unvisited)
    const deepLbs = deepState ? deepState.lbs.filter((_, i) => !deepState!.proven[i]) : [];
    const lb = deepState ? (allProven || deepLbs.some((x) => x === null) ? null : Math.min(...(deepLbs as number[])))
      : Math.max(Number(row.lower_bound ?? 0), r.lowerBound ?? 0) || null;
    // a bound from a search that dropped states (memory cap) does not bound the dropped part: no gap then
    // a capped map search drops its most expensive states and keeps their lowest bound, so lb stays valid
    const gap = allProven ? 0 : keep[0] && lb !== null ? Math.max(0, keep[0].price - lb) : deepState ? null : r.gap;
    // a quick search on the worker that ran out of time with a real gap does not stop there: it goes on in the
    // background (up to EXTEND_MIN more) until the optimum is proven, and the phone hears about it
    const extend = status === "limit" && timeUp && budgetLeft && !stuck && !!o.unlimited && !anywhere && row.params.depth !== "deep"
      && !row.params.extended && !!keep[0] && (gap === null || gap >= Math.max(100, keep[0].price * 0.05));
    if (extend) {
      status = "running";
      const i = notes.findIndex((n) => n.startsWith("Limit "));
      if (i >= 0) notes.splice(i, 1);
      await savePack();
    }
    await sql`update live_searches set status = ${status}, steps = steps + 1, meter = ${sql.json(r.stats.bySource as never)},
      trips = ${sql.json(keep as never)}, stats = ${sql.json({ ...r.stats, best: keep[0]?.price ?? null,
        checked: Math.max(r.stats.checked, (row.stats as { checked?: number } | null)?.checked ?? 0),
        pruned: Math.max(r.stats.pruned, (row.stats as { pruned?: number } | null)?.pruned ?? 0), deep: deepState, reasonable, strategist, destinations, progress, firstSec,
        prelim: r.stats.prelim ?? (row.stats as { prelim?: unknown } | null)?.prelim,
        combosTotal: ((row.stats as { combosTotal?: number } | null)?.combosTotal ?? 0) + (r.stats.progress?.combos ?? 0),
        ticketWins: { combined: ((row.stats as { ticketWins?: { combined: number } } | null)?.ticketWins?.combined ?? 0) + (r.stats.ticketWins?.combined ?? 0),
          separate: ((row.stats as { ticketWins?: { separate: number } } | null)?.ticketWins?.separate ?? 0) + (r.stats.ticketWins?.separate ?? 0) } } as never)},
      gap = ${gap}, lower_bound = ${lb}, notes = ${sql.json(notes as never)},
      baseline = ${sql.json(([r.baseline, row.baseline as typeof r.baseline].filter(Boolean).sort((x, y) => x!.price - y!.price)[0] ?? null) as never)}, summary = ${r.summary || null}, seq = ${seq},
      message = ${status === "running" ? (deepState ? `runda ${deepState.round + 1}${deepState.chunks.length > 1 ? `: ${deepState.proven.filter(Boolean).length}/${deepState.chunks.length} tygodni z dowodem` : ": dalej w głąb"}` : `krok ${row.steps + 2}: dalsze przeszukiwanie`) : status === "done" ? (anywhere ? "lista gotowa" : "optimum udowodnione") : status === "stopped" ? "zatrzymano – pokazuję najlepszy znaleziony wynik" : "zatrzymano na limicie"},
      updated_at = now() where id = ${id}`;
    await db.hitAirports([...new Set([...row.params.origin, ...row.params.dest.slice(0, 10), ...keep.flatMap((t) => t.nodes)])]).catch(() => {});
    if (extend) {
      const pr = row.params;
      await sql`update live_searches set params = params || ${sql.json({ extended: EXTEND_MIN } as never)},
        message = ${`szybkie ${maxMinutes} min nie wystarczyło – szukam dalej w tle (do ${EXTEND_MIN} min)`} where id = ${id}`;
      const pax = pr.pax ?? 1, price = keep[0]!.price;
      await pushSearch(id, ({ en, money, place }) => ({ title: `${money(price * pax)} · ${place(`${pr.originLabel} → ${pr.destLabel}`)}`,
        body: en
          ? `Preliminary result after ${maxMinutes} min${gap ? ` – could be up to ${money(gap * pax)} cheaper` : ""}. Searching on in the background (up to an hour), I'll let you know.`
          : `Wstępny wynik po ${maxMinutes} min${gap ? ` – może być do ${money(gap * pax)} taniej` : ""}. Szukam dalej w tle (do godziny), dam znać.`,
        url: `/#s=${id}`, tag: id })).catch(() => {});
    }
    // the phone: one notification when the search ends on its own (not after "Zatrzymaj", the user is there)
    if (status === "done" || status === "limit") {
      const pr = row.params, best = keep[0]?.price, pax = pr.pax ?? 1;
      await pushSearch(id, ({ en, money, place }) => {
        const route = anywhere ? `${place(pr.originLabel)}: ${en ? "anywhere cheap" : "gdziekolwiek tanio"}` : place(`${pr.originLabel} → ${pr.destLabel}`);
        return { title: best ? `${money(best * pax)} · ${route}` : route,
          body: en
            ? (best ? (status === "done" ? "Search finished – everything checked." : "Search finished at the time limit.") : "Search finished, no routes found.")
            : (best ? (status === "done" ? "Wyszukiwanie zakończone – sprawdzone wszystko." : "Wyszukiwanie zakończone na limicie czasu.") : "Wyszukiwanie zakończone, brak tras."),
          url: `/#s=${id}`, tag: id };
      }).catch(() => {});
    }
    return status === "running";
  } catch (e) {
    clearInterval(timer); clearInterval(fast); clearInterval(beat);
    await sql`update live_searches set status = 'error', error = ${(e as Error).message.slice(0, 400)}, updated_at = now() where id = ${id}`.catch(() => {});
    return false;
  }
}

/** If a running search has not checkpointed for 4 minutes, claim it for a restart (atomic). */
export async function claimStale(id: string): Promise<boolean> {
  const sql = await sqlClient();
  if (!sql) return false;
  const rows = await sql`update live_searches set updated_at = now(), message = 'wznawiam po przerwie'
    where id = ${id} and status = 'running' and runner = 'vercel' and updated_at < now() - interval '240 seconds' returning id`;
  return rows.length > 0;
}
