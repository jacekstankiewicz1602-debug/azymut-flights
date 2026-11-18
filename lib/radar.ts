// Price radar: anomalies on the world map (fares far below the route's norm), deals from free
// RSS feeds, and data-driven hub rankings. Runs in the GitHub Actions worker, outside Vercel.
//  - norm of a route = median of its prices: daily history (route_history, last 60 days) plus
//    every current month/source price; routes with few observations fall back to the median
//    price per km of similar routes (same regions, same distance band)
//  - anomaly = price < 50% of the norm or z-score < -2.5, verified live (Kiwi) before it is listed
//  - every listed fare is priced together with the cheapest way to get there from Poland
import { AIRPORTS, AP, km } from "./airports";
import { config } from "./config";
import { db, sqlClient, type Edge } from "./db";
import { dijkstra } from "./engine";
import { sendMail } from "./mail";
import { buildGraph, nextMonths } from "./map";
import { resolvePlace } from "./parse";
import { Meter, politeFetch, randomUA } from "./sources/http";
import { kiwiOneWay, type KItin } from "./sources/kiwi";
import { addDays, isoDay, monthEnd } from "./time";

export const PL = AIRPORTS.filter((a) => a.cc === "PL").map((a) => a.iata);

export type Deal = {
  id: string; kind: "anomaly" | "deal"; origin: string; dest: string; month: string | null; date: string | null;
  price: number; norm: number | null; pct: number | null; z: number | null;
  feederFrom: string | null; feederPrice: number | null; total: number;
  source: string; link: string; title: string | null; verified: boolean; foundAt: number; verifiedAt: number | null;
};

async function ensure() {
  const s = await sqlClient();
  if (!s) throw new Error("radar needs DATABASE_URL");
  await s`create table if not exists route_history (origin text not null, dest text not null, day date not null, price int not null, primary key (origin, dest, day))`;
  await s`create table if not exists radar_deals (
    id text primary key, kind text not null, origin text not null, dest text not null, month text, date text,
    price int not null, norm int, pct int, z numeric, feeder_from text, feeder_price int, total int not null,
    source text not null, link text not null, title text, verified boolean not null default false,
    found_at timestamptz not null default now(), verified_at timestamptz, active boolean not null default true,
    mailed boolean not null default false)`;
  await s`create table if not exists radar_watch (id serial primary key, label text not null, codes text[] not null, created_at timestamptz not null default now())`;
  await s`create table if not exists hub_rank (region text not null, hub text not null, rank int not null, score int not null,
    feed int not null, onward int not null, onward_to text, updated_at timestamptz not null default now(), primary key (region, hub))`;
  await s`create table if not exists feed_seen (url text primary key, seen_at timestamptz not null default now())`;
  return s;
}

/** Housekeeping: the free Postgres tier is small; old response caches and event logs go. */
export async function cleanup(log: (s: string) => void = () => {}) {
  const s = await ensure();
  const a = await s`delete from api_cache where expires_at < now()`;
  const b = await s`delete from live_events where search_id in (select id from live_searches where updated_at < now() - interval '3 days')`;
  const c = await s`update live_searches set cache = null where cache is not null and status <> 'running' and updated_at < now() - interval '1 day'`;
  await s`delete from route_history where day < current_date - 70`;
  await s`delete from feed_seen where seen_at < now() - interval '30 days'`;
  log(`cleanup: cache ${a.count}, events ${b.count}, packs ${c.count}`);
}

/** One row per route and day: the cheapest price the map knows today (any month, any source). */
export async function recordHistory() {
  const s = await ensure();
  await s`insert into route_history (origin, dest, day, price)
    select origin, dest, current_date, min(min_price)::int from edges where updated_at > now() - interval '2 days' group by origin, dest
    on conflict (origin, dest, day) do update set price = least(route_history.price, excluded.price)`;
}

const median = (xs: number[]) => { const a = [...xs].sort((x, y) => x - y); const m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
const band = (d: number) => (d < 800 ? 0 : d < 1500 ? 1 : d < 2500 ? 2 : d < 4500 ? 3 : d < 7000 ? 4 : d < 10000 ? 5 : 6);

type Norm = { norm: number; mean: number; std: number; n: number; peer: boolean };

/** Norm per route from history + current prices; peers (regions x distance band) for thin routes. */
export function routeNorms(edges: Edge[], history: { origin: string; dest: string; price: number }[]): Map<string, Norm> {
  const obs = new Map<string, Set<string>>();
  const put = (k: string, tag: string) => { if (!obs.has(k)) obs.set(k, new Set()); obs.get(k)!.add(tag); };
  // the map writes one window minimum into every month of the window: deduplicate by fare
  for (const e of edges) if (e.source !== "estimate" && e.source !== "deal") put(e.from + e.to, `${e.source}|${e.date ?? e.month}|${e.price}`);
  for (const h of history) put(h.origin + h.dest, `h|${h.price}|${Math.random()}`);
  const peers = new Map<string, number[]>();
  const out = new Map<string, Norm>();
  for (const [k, set] of obs) {
    const prices = [...set].map((t) => Number(t.split("|")[t.startsWith("h|") ? 1 : 2])).filter((x) => x > 0);
    if (!prices.length) continue;
    const mean = prices.reduce((a, b) => a + b, 0) / prices.length;
    const std = Math.sqrt(prices.reduce((a, b) => a + (b - mean) ** 2, 0) / prices.length);
    out.set(k, { norm: median(prices), mean, std, n: prices.length, peer: false });
    const a = AP[k.slice(0, 3)], b = AP[k.slice(3)];
    if (!a || !b) continue;
    const d = km(a, b);
    const pk = `${a.region}|${b.region}|${band(d)}`;
    if (!peers.has(pk)) peers.set(pk, []);
    peers.get(pk)!.push(median(prices) / Math.max(d, 200));
  }
  for (const [k, n] of out) {
    if (n.n >= 4) continue;
    const a = AP[k.slice(0, 3)], b = AP[k.slice(3)];
    if (!a || !b) continue;
    const d = km(a, b);
    const pp = peers.get(`${a.region}|${b.region}|${band(d)}`);
    if (pp && pp.length >= 8) out.set(k, { ...n, norm: Math.round(median(pp) * Math.max(d, 200)), peer: true });
  }
  return out;
}

/** Cheapest way from Poland to an airport around a date: a live Kiwi query, the map bound as fallback. */
async function feeder(to: string, date: string | null, reach: Map<string, number>, meter: Meter): Promise<{ from: string | null; price: number }> {
  if (PL.includes(to)) return { from: null, price: 0 };
  const day = date ?? addDays(isoDay(Date.now()), 30);
  const its = await kiwiOneWay(PL, [to], addDays(day, -3), addDays(day, -1), 20, meter).catch(() => null);
  const best = (its ?? []).filter((it) => it.segs[it.segs.length - 1].to === to).sort((a, b) => a.price - b.price)[0];
  if (best) return { from: best.segs[0].from, price: Math.round(best.price) };
  const lb = reach.get(to);
  return { from: null, price: Number.isFinite(lb ?? Infinity) ? Math.round(lb!) : 9999 };
}

async function liveMin(from: string, to: string, d0: string, d1: string, meter: Meter): Promise<KItin | null> {
  const its = await kiwiOneWay([from], [to], d0, d1, 10, meter).catch(() => null);
  return (its ?? []).filter((it) => it.segs[0].from === from && it.segs[it.segs.length - 1].to === to).sort((a, b) => a.price - b.price)[0] ?? null;
}

async function saveDeal(d: Deal) {
  const s = await ensure();
  await s`insert into radar_deals ${s({
    id: d.id, kind: d.kind, origin: d.origin, dest: d.dest, month: d.month, date: d.date, price: d.price, norm: d.norm, pct: d.pct,
    z: d.z, feeder_from: d.feederFrom, feeder_price: d.feederPrice, total: d.total, source: d.source, link: d.link, title: d.title,
    verified: d.verified, verified_at: d.verifiedAt ? new Date(d.verifiedAt) : null, active: true,
  } as never)} on conflict (id) do update set price = excluded.price, norm = excluded.norm, pct = excluded.pct, z = excluded.z,
    feeder_from = excluded.feeder_from, feeder_price = excluded.feeder_price, total = excluded.total, link = excluded.link,
    verified = excluded.verified, verified_at = excluded.verified_at, date = excluded.date, active = true`;
}

/**
 * Daily scan of the whole map. Candidates are ranked by how far below the norm they are; the top
 * ones are verified live (Kiwi, the fare's month) and priced with a feeder from Poland.
 */
export async function scanAnomalies(deadline: number, log: (s: string) => void = () => {}, maxVerify = 40) {
  const s = await ensure();
  const months = nextMonths();
  const edges = await db.edges(months);
  const history = (await s`select origin, dest, price from route_history where day > current_date - 60`) as unknown as { origin: string; dest: string; price: number }[];
  const norms = routeNorms(edges, history);
  const g = await buildGraph(months, false, PL);
  const reach = dijkstra(g.graph, PL, false);
  const cands: { e: Edge; n: Norm; ratio: number; z: number }[] = [];
  const seen = new Set<string>();
  for (const e of edges) {
    if (e.source === "estimate" || e.source === "deal" || !AP[e.from] || !AP[e.to]) continue;
    const n = norms.get(e.from + e.to);
    if (!n || n.norm <= 0) continue;
    const ratio = e.price / n.norm;
    const z = n.std > 0 && n.n >= 5 ? (e.price - n.mean) / n.std : 0;
    // the rule from the brief, plus a minimum saving so 19 zł vs 45 zł hops do not flood the list
    if (!(ratio < 0.5 || z < -2.5) || n.norm - e.price < 150) continue;
    const k = `${e.from}${e.to}${e.date ?? e.month}`;
    if (seen.has(k)) continue;
    seen.add(k);
    cands.push({ e, n, ratio, z });
  }
  // long-haul and reachable from Poland first: those are the ones that matter for trips from here
  const reachOf = (c: string) => (PL.includes(c) ? 0 : reach.get(c) ?? 9999);
  cands.sort((a, b) => (a.ratio + reachOf(a.e.from) / 4000) - (b.ratio + reachOf(b.e.from) / 4000));
  log(`radar: ${edges.length} edges, ${norms.size} routes with a norm, ${cands.length} anomaly candidates`);
  const meter = new Meter(0, 100_000);
  meter.limits = {};
  const found: Deal[] = [];
  for (const c of cands.slice(0, maxVerify)) {
    if (Date.now() > deadline - 20_000) break;
    const { e, n } = c;
    const d0 = e.date ? addDays(e.date, -2) : `${e.month}-01`, d1 = e.date ? addDays(e.date, 2) : monthEnd(e.month);
    const live = await liveMin(e.from, e.to, d0 < isoDay(Date.now() + 86400_000) ? isoDay(Date.now() + 86400_000) : d0, d1, meter);
    const price = live ? Math.round(live.price) : e.price;
    const date = live ? live.segs[0].depLocal.slice(0, 10) : e.date ?? null;
    const ratio = price / n.norm;
    const z = n.std > 0 && n.n >= 5 ? (price - n.mean) / n.std : null;
    const still = live && (ratio < 0.6 || (z !== null && z < -2));
    if (!still) { await s`update radar_deals set active = false where id = ${"a:" + e.from + e.to + (e.date ?? e.month)}`; continue; }
    const f = await feeder(e.from, date, reach, meter);
    const deal: Deal = {
      id: "a:" + e.from + e.to + (e.date ?? e.month), kind: "anomaly", origin: e.from, dest: e.to, month: (date ?? e.month).slice(0, 7), date,
      price, norm: Math.round(n.norm), pct: Math.round(100 * (1 - ratio)), z: z === null ? null : Math.round(z * 10) / 10,
      feederFrom: f.from, feederPrice: f.price, total: price + f.price, source: `${e.source}${n.peer ? " / norma z podobnych tras" : ""}`,
      link: live!.link, title: null, verified: true, foundAt: Date.now(), verifiedAt: Date.now(),
    };
    await saveDeal(deal);
    // the verified fare goes into the map as a "deal" arc: searches see it at its real price at once
    if (date) await db.upsertEdges([{ from: e.from, to: e.to, month: date.slice(0, 7), price, source: "deal", date, updatedAt: Date.now() }]).catch(() => {});
    found.push(deal);
  }
  log(`radar: ${found.length} verified anomalies; queries ${JSON.stringify(meter.snapshot().bySource)}`);
  return { candidates: cands.length, verified: found };
}

// ---------------------------------------------------------------- deal feeds

const FEEDS: { name: string; url: string; lang: "pl" | "en" }[] = [
  { name: "Fly4free", url: "https://www.fly4free.pl/feed/", lang: "pl" },
  { name: "Secret Flying", url: "https://www.secretflying.com/europe-deals/feed/", lang: "en" },
  { name: "HolidayPirates", url: "https://www.holidaypirates.com/feed", lang: "en" },
  { name: "The Flight Deal", url: "https://www.theflightdeal.com/feed/", lang: "en" },
];

const decode = (s: string) => s.replace(/<!\[CDATA\[|\]\]>/g, "").replace(/&#8211;|&ndash;/g, "–").replace(/&#8217;/g, "'").replace(/&amp;/g, "&")
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/<[^>]+>/g, "").trim();

/** Route and price from a deal headline (Polish or English). */
export function parseDealTitle(title: string, lang: "pl" | "en"): { from: string[] | null; to: string[]; price: number | null; rt: boolean } | null {
  const t = title.replace(/\s+/g, " ");
  if (/hotel|nocy|noclegi|all[- ]inclusive|wycieczk|resort|cruise|rejs|wakacje z |package/i.test(t)) return null;
  const pm = t.match(/(\d[\d\s.,]{1,7})\s*(PLN|zł|EUR|€|USD|\$|GBP|£)/i) ?? t.match(/(€|\$|£)\s*(\d[\d.,]{1,6})/);
  let price: number | null = null;
  if (pm) {
    const [num, cur] = /\d/.test(pm[1]) ? [pm[1], pm[2]] : [pm[2], pm[1]];
    const v = Number(num.replace(/[\s.]/g, "").replace(",", "."));
    const fx = /pln|zł/i.test(cur) ? 1 : /eur|€/i.test(cur) ? config.fx.EUR : /gbp|£/i.test(cur) ? config.fx.GBP : config.fx.USD;
    if (Number.isFinite(v)) price = Math.round(v * fx);
  }
  const rt = /roundtrip|return|w obie strony|tam i z powrotem/i.test(t);
  let fromTxt: string | null = null, toTxt: string | null = null;
  if (lang === "pl") {
    fromTxt = t.match(/\bz ([A-ZŁŚŻŹĆ][\wąćęłńóśźż-]+(?: [A-ZŁŚŻŹĆ][\wąćęłńóśźż-]+)?)/)?.[1] ?? null;
    toTxt = t.match(/\b(?:do|na) ([A-ZŁŚŻŹĆ][\wąćęłńóśźż-]+(?: [A-ZŁŚŻŹĆ][\wąćęłńóśźż-]+)?)/)?.[1] ?? null;
  } else {
    const m = t.match(/from ([A-Z][\w .'-]+?)(?:,[^,]*?)? to ([A-Z][\w .'-]+?)(?:,| for| from|\.|$)/) ?? t.match(/:\s*([A-Z][\w .'-]+?) [–-] ([A-Z][\w .'-]+?)(?:,|\.|$)/);
    if (m) { fromTxt = m[1]; toTxt = m[2]; }
    else toTxt = t.match(/to ([A-Z][\w .'-]+?)(?:,| for| from|\.|$)/)?.[1] ?? null;
  }
  const to = toTxt ? resolvePlace(toTxt) : null;
  if (!to || to.codes.length > 12) return null;
  const from = fromTxt ? resolvePlace(fromTxt) : null;
  return { from: from && from.codes.length <= 6 ? from.codes : null, to: to.codes, price, rt };
}

/** New feed items: parse, verify live (Kiwi, next 4 months), add to the map with the "deal" flag. */
export async function scanFeeds(deadline: number, log: (s: string) => void = () => {}) {
  const s = await ensure();
  const meter = new Meter(0, 100_000);
  meter.limits = {};
  const reach = dijkstra((await buildGraph(nextMonths(), false, PL)).graph, PL, false);
  const today = isoDay(Date.now() + 86400_000);
  const out: Deal[] = [];
  const stat: Record<string, string> = {};
  for (const f of FEEDS) {
    if (Date.now() > deadline - 20_000) break;
    const xml = await politeFetch(f.url, { headers: { "user-agent": randomUA(), accept: "application/rss+xml,text/xml" } }, `feed:${f.name}`, 2).catch(() => null);
    if (!xml) { stat[f.name] = "niedostępny"; continue; }
    const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => ({
      title: decode(m[1].match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? ""), link: decode(m[1].match(/<link>([\s\S]*?)<\/link>/)?.[1] ?? ""),
      cats: [...m[1].matchAll(/<category>([\s\S]*?)<\/category>/g)].map((c) => decode(c[1])),
    })).filter((x) => x.title && x.link);
    let parsed = 0, verified = 0;
    for (const it of items.slice(0, 30)) {
      if (Date.now() > deadline - 20_000) break;
      const [seen] = await s`select 1 from feed_seen where url = ${it.link}`;
      if (seen) continue;
      await s`insert into feed_seen (url) values (${it.link}) on conflict do nothing`;
      const r = parseDealTitle(it.title, f.lang);
      if (!r) continue;
      parsed++;
      // Fly4free tags departure cities as categories ("z Berlina", "z Warszawy")
      const catFrom = it.cats.filter((c) => /^z [A-ZŁŚŻ]/.test(c)).map((c) => resolvePlace(c.slice(2))).filter((x) => x && x.codes.length <= 4).flatMap((x) => x!.codes);
      const from = r.from ?? (catFrom.length ? [...new Set(catFrom)] : f.lang === "pl" ? PL : null);
      if (!from) continue;
      const its = await kiwiOneWay(from.slice(0, 8), r.to.slice(0, 12), today, addDays(today, 120), 20, meter).catch(() => null);
      const best = (its ?? []).sort((a, b) => a.price - b.price)[0];
      if (!best) continue;
      verified++;
      const o = best.segs[0].from, d = best.segs[best.segs.length - 1].to, date = best.segs[0].depLocal.slice(0, 10);
      const fd = await feeder(o, date, reach, meter);
      const deal: Deal = {
        id: `d:${o}${d}:${it.link.slice(-60)}`, kind: "deal", origin: o, dest: d, month: date.slice(0, 7), date, price: Math.round(best.price),
        norm: null, pct: null, z: null, feederFrom: fd.from, feederPrice: fd.price, total: Math.round(best.price) + fd.price,
        source: f.name, link: it.link, title: `${it.title}${r.price ? ` (w ogłoszeniu ${r.price} zł${r.rt ? ", w obie strony" : ""})` : ""}`,
        verified: true, foundAt: Date.now(), verifiedAt: Date.now(),
      };
      await saveDeal(deal);
      if (AP[o] && AP[d]) await db.upsertEdges([{ from: o, to: d, month: date.slice(0, 7), price: deal.price, source: "deal", date, updatedAt: Date.now() }]);
      out.push(deal);
    }
    stat[f.name] = `${items.length} wpisów, ${parsed} tras, ${verified} potwierdzonych`;
  }
  log(`feeds: ${JSON.stringify(stat)}`);
  return { deals: out, feeds: stat };
}

// ---------------------------------------------------------------- hubs

const TARGET_REGIONS = ["SAM", "CAR", "NAM", "SEA", "SAS", "EAS", "CAS", "MEA", "AFR", "NAF", "OCE", "CAU"];

/**
 * Hub score per destination region: cheapest way from Poland to the hub (map, any connections)
 * + its cheapest flight into the region. Priced map edges only (no distance estimates).
 */
export async function rankHubs(log: (s: string) => void = () => {}) {
  const s = await ensure();
  const months = nextMonths();
  const g = (await buildGraph(months, false, PL)).graph;
  for (const [from, arcs] of g) g.set(from, arcs.filter((a) => a.kind === "ground" || a.sources.some((x) => x !== "estimate")));
  const reach = dijkstra(g, PL, false);
  const rows: { region: string; hub: string; rank: number; score: number; feed: number; onward: number; onward_to: string }[] = [];
  for (const region of TARGET_REGIONS) {
    const scored: { hub: string; feed: number; onward: number; to: string }[] = [];
    for (const [hub, arcs] of g) {
      if (PL.includes(hub) || !AP[hub]) continue;
      const feed = reach.get(hub);
      if (feed === undefined || !Number.isFinite(feed)) continue;
      let onward = Infinity, to = "";
      for (const a of arcs) if (a.kind === "flight" && AP[a.to]?.region === region && a.to !== hub && a.lb < onward) { onward = a.lb; to = a.to; }
      if (Number.isFinite(onward)) scored.push({ hub, feed, onward, to });
    }
    scored.sort((a, b) => a.feed + a.onward - (b.feed + b.onward));
    scored.slice(0, 30).forEach((x, i) => rows.push({ region, hub: x.hub, rank: i + 1, score: Math.round(x.feed + x.onward), feed: Math.round(x.feed), onward: Math.round(x.onward), onward_to: x.to }));
  }
  await s`delete from hub_rank`;
  if (rows.length) await s`insert into hub_rank ${s(rows as never)}`;
  // keep the best hubs' fares fresh daily (map refresh priority)
  await db.hitAirports([...new Set(rows.filter((r) => r.rank <= 10).map((r) => r.hub))]).catch(() => {});
  log(`hubs: ${rows.length} ranked (${TARGET_REGIONS.length} regions)`);
  return rows;
}

// ---------------------------------------------------------------- listing and alerts

export async function listDeals(sort: "price" | "pct" = "price", limit = 80): Promise<Deal[]> {
  const s = await ensure();
  const rows = await s`select * from radar_deals where active and found_at > now() - interval '14 days'
    and (feeder_price is null or feeder_price <= 700 or origin in ${s(PL)})
    order by ${sort === "pct" ? s`pct desc nulls last, total` : s`total`} limit ${limit}`;
  return rows.map((r) => ({
    id: r.id, kind: r.kind, origin: r.origin, dest: r.dest, month: r.month, date: r.date, price: r.price, norm: r.norm, pct: r.pct,
    z: r.z === null ? null : Number(r.z), feederFrom: r.feeder_from, feederPrice: r.feeder_price, total: r.total, source: r.source,
    link: r.link, title: r.title, verified: r.verified, foundAt: new Date(r.found_at).getTime(), verifiedAt: r.verified_at ? new Date(r.verified_at).getTime() : null,
  }));
}

export async function watches() {
  const s = await ensure();
  return (await s`select id, label, codes from radar_watch order by id`).map((r) => ({ id: r.id as number, label: r.label as string, codes: r.codes as string[] }));
}
export async function addWatch(text: string) {
  const p = resolvePlace(text);
  if (!p) return null;
  const s = await ensure();
  await s`insert into radar_watch (label, codes) values (${p.label}, ${p.codes})`;
  return p;
}
export async function removeWatch(id: number) {
  const s = await ensure();
  await s`delete from radar_watch where id = ${id}`;
}

/** Mail every new fare at least 50% below its norm on a watched destination (once per fare). */
export async function alert(log: (s: string) => void = () => {}) {
  const s = await ensure();
  const w = await watches();
  const codes = new Set(w.flatMap((x) => x.codes));
  if (!codes.size) return 0;
  const rows = await s`select * from radar_deals where active and not mailed and pct >= 50 and dest in ${s([...codes])}`;
  if (!rows.length) return 0;
  const line = (r: Record<string, unknown>) => `${r.origin}→${r.dest} ${r.price} zł (norma ${r.norm} zł, −${r.pct}%)${r.feeder_price ? ` + dolot z ${r.feeder_from ?? "Polski"} ${r.feeder_price} zł` : ""}, ${r.date ?? r.month}\n${r.link}`;
  const ok = await sendMail(`Azymut radar: ${rows.length} okazji poniżej 50% normy`, rows.map(line).join("\n\n"));
  if (ok) await s`update radar_deals set mailed = true where id in ${s(rows.map((r) => r.id as string))}`;
  log(`alerts: ${rows.length} fares, mail ${ok ? "sent" : "not configured or failed"}`);
  return ok ? rows.length : 0;
}

export async function ranked(region?: string) {
  const s = await ensure();
  return region ? s`select * from hub_rank where region = ${region} order by rank` : s`select * from hub_rank order by region, rank`;
}
