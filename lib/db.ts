import postgres from "postgres";
import { config } from "./config";

/** One "world map" edge: cheapest known one-way price from -> to within a month. A lower bound. */
export type Edge = {
  from: string; to: string; month: string; price: number;
  source: "explore" | "ryanair" | "wizz" | "kiwi" | "estimate" | "deal";
  date?: string | null; updatedAt: number;
};

export type SearchLog = {
  query: string; params: unknown; best: number | null; baseline: number | null;
  paidCalls: number; freeCalls: number; costUsd: number; ms: number; result: unknown;
};

interface Store {
  edges(months: string[]): Promise<Edge[]>;
  upsertEdges(edges: Edge[]): Promise<void>;
  cacheGet<T>(key: string): Promise<T | null>;
  cacheSet(key: string, value: unknown, ttlSec: number): Promise<void>;
  logSearch(s: SearchLog): Promise<void>;
  meta(): Promise<{ edges: number; newest: number | null; backend: string }>;
  originsFreshness(source: string): Promise<Record<string, number>>;
  jobTimes(): Promise<Record<string, number>>;
  markJob(key: string): Promise<void>;
  /** Airports that searches actually used, with the last time (drives map refresh priority). */
  hitAirports(codes: string[]): Promise<void>;
  hotAirports(): Promise<Record<string, number>>;
}

let sql: postgres.Sql | null = null;
let ready: Promise<void> | null = null;

function pg(): postgres.Sql {
  if (!sql) {
    // the worker runs many requests at once (each one reads the response cache first): more connections there
    // a local database (npm run local: embedded Postgres) has no TLS
    const local = /@(localhost|127\.0\.0\.1)[:/]/.test(config.databaseUrl);
    sql = postgres(config.databaseUrl, { max: process.env.VERCEL ? 3 : 8, idle_timeout: 20, prepare: false, ssl: local ? false : "require", onnotice: () => {} });
  }
  if (!ready) {
    const s = sql;
    ready = (async () => {
      await s`create table if not exists edges (
        origin text not null, dest text not null, month text not null, min_price numeric not null,
        source text not null, flight_date text, updated_at timestamptz not null default now(),
        primary key (origin, dest, month, source))`;
      await s`create index if not exists edges_month on edges(month)`;
      await s`create table if not exists api_cache (key text primary key, value jsonb not null, expires_at timestamptz not null)`;
      await s`create table if not exists map_jobs (key text primary key, ran_at timestamptz not null)`;
      await s`create table if not exists live_searches (
        id text primary key, params jsonb not null, status text not null, created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(), steps int not null default 0, meter jsonb not null default '{}'::jsonb,
        trips jsonb not null default '[]'::jsonb, stats jsonb, gap numeric, lower_bound numeric, notes jsonb, baseline jsonb,
        summary text, error text, message text, seq int not null default 0)`;
      await s`alter table live_searches add column if not exists cache jsonb`;
      // runner: 'vercel' (chained function steps) or 'worker' (the long-running process on the laptop)
      await s`alter table live_searches add column if not exists runner text not null default 'vercel'`;
      await s`alter table live_searches add column if not exists claimed_by text`;
      // "Zatrzymaj i pokaż wynik": the runner finishes the current check and saves the best trips
      await s`alter table live_searches add column if not exists stop_requested boolean not null default false`;
      // push endpoints of the devices that started this search (or asked for its notification): nobody else gets it
      await s`alter table live_searches add column if not exists notify text[] not null default '{}'`;
      await s`create table if not exists workers (id text primary key, seen_at timestamptz not null, info jsonb)`;
      await s`create table if not exists live_events (search_id text not null, seq int not null, data jsonb not null, primary key (search_id, seq))`;
      await s`create table if not exists app_kv (key text primary key, value jsonb not null)`;
      await s`create table if not exists push_subs (endpoint text primary key, sub jsonb not null, created_at timestamptz not null default now())`;
      // the device's interface language and price currency: its notifications are written in them
      await s`alter table push_subs add column if not exists lang text not null default 'pl'`;
      await s`alter table push_subs add column if not exists cur text not null default 'PLN'`;
      await s`create table if not exists airport_hits (iata text primary key, hits int not null default 0, last_hit timestamptz not null)`;
      await s`create table if not exists searches (
        id bigserial primary key, created_at timestamptz not null default now(), query text, params jsonb,
        best_price numeric, baseline_price numeric, paid_calls int, free_calls int, cost_usd numeric, ms int, result jsonb)`;
    })();
  }
  return sql;
}

const pgStore: Store = {
  async hitAirports(codes) {
    if (!codes.length) return;
    const s = pg(); await ready;
    const rows = [...new Set(codes)].map((iata) => ({ iata, hits: 1, last_hit: new Date() }));
    await s`insert into airport_hits ${s(rows)} on conflict (iata) do update set hits = airport_hits.hits + 1, last_hit = now()`;
  },
  async hotAirports() {
    const s = pg(); await ready;
    const rows = await s`select iata, last_hit from airport_hits where last_hit > now() - interval '30 days'`;
    return Object.fromEntries(rows.map((r) => [r.iata, new Date(r.last_hit).getTime()]));
  },
  async jobTimes() {
    const s = pg(); await ready;
    const rows = await s`select key, ran_at from map_jobs`;
    return Object.fromEntries(rows.map((r) => [r.key, new Date(r.ran_at).getTime()]));
  },
  async markJob(key) {
    const s = pg(); await ready;
    await s`insert into map_jobs (key, ran_at) values (${key}, now()) on conflict (key) do update set ran_at = now()`;
  },
  async edges(months) {
    const s = pg(); await ready;
    const rows = await s`select origin, dest, month, min_price, source, flight_date, updated_at
      from edges where month in ${s(months)}`;
    return rows.map((r) => ({
      from: r.origin, to: r.dest, month: r.month, price: Number(r.min_price), source: r.source,
      date: r.flight_date, updatedAt: new Date(r.updated_at).getTime(),
    }));
  },
  async upsertEdges(edges) {
    if (!edges.length) return;
    const s = pg(); await ready;
    for (let i = 0; i < edges.length; i += 500) {
      const chunk = edges.slice(i, i + 500).map((e) => ({
        origin: e.from, dest: e.to, month: e.month, min_price: e.price, source: e.source,
        flight_date: e.date ?? null, updated_at: new Date(e.updatedAt),
      }));
      await s`insert into edges ${s(chunk)} on conflict (origin, dest, month, source) do update set
        min_price = excluded.min_price, flight_date = excluded.flight_date, updated_at = excluded.updated_at`;
    }
  },
  async cacheGet<T>(key: string) {
    const s = pg(); await ready;
    const rows = await s`select value from api_cache where key = ${key} and expires_at > now()`;
    return rows.length ? (rows[0].value as T) : null;
  },
  async cacheSet(key, value, ttlSec) {
    const s = pg(); await ready;
    await s`insert into api_cache (key, value, expires_at) values (${key}, ${s.json(value as never)}, now() + ${ttlSec + " seconds"}::interval)
      on conflict (key) do update set value = excluded.value, expires_at = excluded.expires_at`;
  },
  async logSearch(l) {
    const s = pg(); await ready;
    await s`insert into searches (query, params, best_price, baseline_price, paid_calls, free_calls, cost_usd, ms, result)
      values (${l.query}, ${s.json(l.params as never)}, ${l.best}, ${l.baseline}, ${l.paidCalls}, ${l.freeCalls}, ${l.costUsd}, ${l.ms}, ${s.json(l.result as never)})`;
  },
  async meta() {
    const s = pg(); await ready;
    const [r] = await s`select count(*)::int as n, max(updated_at) as newest from edges`;
    return { edges: r.n, newest: r.newest ? new Date(r.newest).getTime() : null, backend: "postgres" };
  },
  async originsFreshness(source) {
    const s = pg(); await ready;
    const rows = await s`select origin, max(updated_at) as t from edges where source = ${source} group by origin`;
    return Object.fromEntries(rows.map((r) => [r.origin, new Date(r.t).getTime()]));
  },
};

// In-memory fallback (local dev without Postgres). Seeded from a bundled snapshot when present.
const mem = { edges: new Map<string, Edge>(), cache: new Map<string, { v: unknown; exp: number }>(), seeded: false };
async function seed() {
  if (mem.seeded) return;
  mem.seeded = true;
  try {
    const snap = (await import("./data/seed-edges.json")).default as Edge[];
    for (const e of snap) mem.edges.set(`${e.from}|${e.to}|${e.month}|${e.source}`, e);
  } catch { /* no snapshot */ }
}
const jobs = new Map<string, number>();
const hits = new Map<string, number>();
const memStore: Store = {
  async hitAirports(codes) { for (const c of codes) hits.set(c, Date.now()); },
  async hotAirports() { return Object.fromEntries(hits); },
  async jobTimes() { return Object.fromEntries(jobs); },
  async markJob(key) { jobs.set(key, Date.now()); },
  async edges(months) {
    await seed();
    const set = new Set(months);
    return [...mem.edges.values()].filter((e) => set.has(e.month));
  },
  async upsertEdges(edges) {
    await seed();
    for (const e of edges) mem.edges.set(`${e.from}|${e.to}|${e.month}|${e.source}`, e);
  },
  async cacheGet<T>(key: string) {
    const c = mem.cache.get(key);
    return c && c.exp > Date.now() ? (c.v as T) : null;
  },
  async cacheSet(key, v, ttl) { mem.cache.set(key, { v, exp: Date.now() + ttl * 1000 }); },
  async logSearch() {},
  async meta() {
    await seed();
    let newest = 0;
    for (const e of mem.edges.values()) newest = Math.max(newest, e.updatedAt);
    return { edges: mem.edges.size, newest: newest || null, backend: "memory" };
  },
  async originsFreshness(source) {
    await seed();
    const out: Record<string, number> = {};
    for (const e of mem.edges.values()) if (e.source === source) out[e.from] = Math.max(out[e.from] ?? 0, e.updatedAt);
    return out;
  },
};

/** Raw Postgres access for modules with their own tables (null without DATABASE_URL). */
export async function sqlClient(): Promise<postgres.Sql | null> {
  if (!config.databaseUrl) return null;
  const s = pg();
  await ready;
  return s;
}

export const db: Store = config.databaseUrl ? pgStore : memStore;
