import { AsyncLocalStorage } from "node:async_hooks";
import { config } from "../config";
import { db } from "../db";

/** Counts API calls and their cost for one search (or one cron run) and enforces the budget. */
export class Meter {
  paid = 0;
  free = 0;
  costUsd = 0;
  bySource: Record<string, number> = {};
  /** Per-source and total call limits for one whole search (all resumed steps together). */
  limits: Record<string, number> = { ...config.sourceLimits };
  constructor(
    public paidLimit = config.maxPaidCallsPerSearch, public freeLimit = config.maxFreeCallsPerSearch,
    base: Record<string, number> = {},
  ) {
    for (const [k, v] of Object.entries(base)) {
      this.bySource[k] = v;
      if (k === "serpapi" || k === "duffel") this.paid += v; else this.free += v;
    }
  }
  canPaid() { return this.paid < this.paidLimit; }
  canFree() { return this.free < this.freeLimit; }
  /** May this source be called again? (total and per-source budget) */
  can(src: string, reserve = 0) { return this.canFree() && (this.bySource[src] ?? 0) < (this.limits[src] ?? Infinity) - reserve; }
  canGoogle(reserve = 0) { return this.can("google", reserve); }
  set kiwiLimit(n: number) { this.limits.kiwi = n; }
  add(source: string, paid: boolean, usd = 0) {
    if (paid) this.paid++; else this.free++;
    this.costUsd += usd;
    this.bySource[source] = (this.bySource[source] ?? 0) + 1;
  }
  snapshot() {
    return { paid: this.paid, free: this.free, costUsd: +this.costUsd.toFixed(4), bySource: { ...this.bySource } };
  }
}

const UAS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
];
export const randomUA = () => UAS[Math.floor(Math.random() * UAS.length)];

// Separate request pools per source: different sources run in parallel, each one with its own cap on
// requests in flight (pace() still spaces the starts, so a source never sees a burst).
// Google's date graph has its own pool: on a route without cached fares it answers in ~30 s and must not
// hold up the result pages
const POOL_MAX: Record<string, number> = { google: 2, "google-grid": 2, kiwi: 3, ryanair: 3, wizz: 2, flixbus: 2 };
const pools = new Map<string, { active: number; waiting: (() => void)[] }>();
export async function limited<T>(src: string, fn: () => Promise<T>): Promise<T> {
  const max = POOL_MAX[src] ?? 3;
  let pl = pools.get(src);
  if (!pl) { pl = { active: 0, waiting: [] }; pools.set(src, pl); }
  const q = Date.now();
  if (pl.active >= max) await new Promise<void>((r) => pl!.waiting.push(r));
  pl.active++;
  const t = Date.now();
  let ok = false;
  try { const r = await fn(); ok = r !== null; return r; } finally {
    pl.active--;
    pl.waiting.shift()?.();
    netLog(src, t - q, Date.now() - t, ok);
  }
}

// Polite per-host pacing for the airlines' public endpoints.
const lastHit = new Map<string, number>();
export async function pace(host: string, minGapMs = config.freeApiDelayMs) {
  const now = Date.now();
  const next = Math.max(now, (lastHit.get(host) ?? 0) + minGapMs);
  lastHit.set(host, next);
  if (next > now) await new Promise((r) => setTimeout(r, next - now));
}

// In-process layer over the Postgres response cache. A resumed search step preloads all the
// answers its search used before (one read), so replaying earlier work costs no round trips.
const mem = new Map<string, { v: unknown; exp: number }>();
// answers can be large (a Kiwi answer holds 50 itineraries): a long worker search must not keep them all
const MEM_MAX = 4_000;
export const touched = new Set<string>();

export function preloadCache(entries: Record<string, { v: unknown; exp: number }>) {
  for (const [k, e] of Object.entries(entries)) if (e.exp > Date.now()) mem.set(k, e);
}
export function exportCache(keys: Iterable<string>): Record<string, { v: unknown; exp: number }> {
  const out: Record<string, { v: unknown; exp: number }> = {};
  for (const k of keys) { const e = mem.get(k); if (e && e.exp > Date.now()) out[k] = e; }
  return out;
}

// Inside fresh() every price is fetched live (the cache is written, never read): the re-check before booking.
const freshCtx = new AsyncLocalStorage<boolean>();
export const fresh = <T,>(fn: () => Promise<T>) => freshCtx.run(true, fn);

/** How long a fare stays fresh: fares close to departure move fast, far ones slowly.
 *  ≤ 14 days ahead: 1.5 h; ≤ 60 days: 6 h; further: 12 h. */
export function priceTtl(date: string): number {
  const days = (Date.parse(date) - Date.now()) / 86400_000;
  return days <= 14 ? 5400 : days <= 60 ? 6 * 3600 : 12 * 3600;
}

/** Cache-through fetch of JSON. Cached hits are free and not counted. */
/** The running search's query log: every source question (its cache key), answered live or from the
 *  shared cache, for the feed shown while searching. Memory hits (replays) are not reported. */
export const queryLog = new AsyncLocalStorage<(key: string, cached: boolean, ms: number, n: number | null) => void>();
const sizeOf = (v: unknown) => (Array.isArray(v) ? v.length : v == null ? 0 : null);

export async function cachedJson<T>(
  key: string, ttlSec: number, fn: () => Promise<T | null>,
): Promise<{ value: T | null; cached: boolean }> {
  const log = queryLog.getStore();
  if (log) {
    const t0 = Date.now();
    const r = await cachedJsonRaw(key, ttlSec, fn);
    if (Date.now() - t0 > 2 || !r.cached) log(key, r.cached, Date.now() - t0, sizeOf(r.value));
    return r;
  }
  return cachedJsonRaw(key, ttlSec, fn);
}

async function cachedJsonRaw<T>(
  key: string, ttlSec: number, fn: () => Promise<T | null>,
): Promise<{ value: T | null; cached: boolean }> {
  touched.add(key);
  if (freshCtx.getStore()) {
    const value = await fn();
    if (value !== null) { remember(key, value, ttlSec); writeBehind(key, value, ttlSec); }
    return { value, cached: false };
  }
  const m = mem.get(key);
  if (m && m.exp > Date.now()) return { value: m.v as T, cached: true };
  // the same question already on its way (paths verified side by side share legs): wait for that answer
  const on = inFlight.get(key);
  if (on) return { value: (await on) as T | null, cached: true };
  const job = (async () => {
    const hit = await db.cacheGet<T>(key).catch(() => null);
    if (hit !== null) { remember(key, hit, Math.min(ttlSec, 3600)); return { value: hit, cached: true }; }
    const value = await fn();
    if (value !== null) {
      remember(key, value, ttlSec);
      // written in the background: a large answer takes ~1 s to Neon and the search must not wait for it
      writeBehind(key, value, ttlSec);
    }
    return { value, cached: false };
  })();
  inFlight.set(key, job.then((r) => r.value, () => null));
  try { return await job; } finally { inFlight.delete(key); }
}
const inFlight = new Map<string, Promise<unknown>>();

// Background cache writes: at most 2 at a time, so the search's own queries (progress, stop flag) always find
// a free connection; when Neon is slower than the answers come in, the oldest pending writes are dropped
// (the shared cache is an optimisation, the answer itself is already in memory).
const pending: [string, unknown, number][] = [];
let writing = 0;
function writeBehind(key: string, v: unknown, ttlSec: number) {
  pending.push([key, v, ttlSec]);
  if (pending.length > 300) pending.splice(0, pending.length - 300);
  void drain();
}
async function drain() {
  if (writing >= 2) return;
  const job = pending.shift();
  if (!job) return;
  writing++;
  try { await db.cacheSet(...job).catch(() => {}); } finally { writing--; void drain(); }
}

function remember(key: string, v: unknown, ttlSec: number) {
  if (mem.size >= MEM_MAX) mem.delete(mem.keys().next().value as string);
  mem.set(key, { v, exp: Date.now() + ttlSec * 1000 });
}

export async function fetchJson(url: string, init: RequestInit = {}, timeoutMs = 20000): Promise<unknown> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal, cache: "no-store" });
    if (!res.ok) throw new Error(`${res.status} ${url.split("?")[0]}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

// Sources that answered 403/429 recently are left alone for a while (exponential backoff).
const blocked = new Map<string, { until: number; strikes: number }>();
export function sourceBlocked(src: string) {
  const b = blocked.get(src);
  return !!b && b.until > Date.now();
}

/**
 * Fetch text with retries and exponential backoff. Never throws: on persistent failure it logs and
 * returns null so a search or a map batch degrades instead of crashing.
 */
export async function politeFetch(url: string, init: RequestInit, src: string, tries = 3, timeoutMs = 25_000): Promise<string | null> {
  return limited(src.startsWith("feed:") ? "feed" : src, () => politeFetchRaw(url, init, src, tries, timeoutMs));
}

/** Per-request timing per source (pool wait, request time, failures); AZ_NETLOG=1 prints each request. */
export const netStats: Record<string, { n: number; waitMs: number; fetchMs: number; fail: number }> = {};
function netLog(src: string, waitMs: number, fetchMs: number, ok: boolean) {
  const s = (netStats[src] ??= { n: 0, waitMs: 0, fetchMs: 0, fail: 0 });
  s.n++; s.waitMs += waitMs; s.fetchMs += fetchMs; if (!ok) s.fail++;
  if (process.env.AZ_NETLOG) console.log(`[net] +${process.uptime().toFixed(1)}s ${src} wait ${waitMs} ms fetch ${fetchMs} ms${ok ? "" : " FAIL"}`);
}
async function politeFetchRaw(url: string, init: RequestInit, src: string, tries: number, timeoutMs: number): Promise<string | null> {
  if (sourceBlocked(src)) return null;
  for (let i = 0; i < tries; i++) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      const res = await fetch(url, { ...init, signal: ctrl.signal, cache: "no-store" }).finally(() => clearTimeout(t));
      if (res.ok) {
        blocked.delete(src);
        return await res.text();
      }
      if (res.status === 403 || res.status === 429 || res.status >= 500) {
        const b = blocked.get(src) ?? { until: 0, strikes: 0 };
        b.strikes++;
        const wait = Math.min(60_000, 1500 * 2 ** b.strikes) * (0.7 + Math.random() * 0.6);
        console.warn(`[${src}] HTTP ${res.status}, backoff ${Math.round(wait)} ms`);
        if (b.strikes >= 4) { b.until = Date.now() + 10 * 60_000; blocked.set(src, b); return null; }
        blocked.set(src, b);
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      console.warn(`[${src}] HTTP ${res.status} ${url.split("?")[0]}`);
      return null;
    } catch (e) {
      console.warn(`[${src}] ${(e as Error).message}`);
      await new Promise((r) => setTimeout(r, 1000 * 2 ** i));
    }
  }
  return null;
}
