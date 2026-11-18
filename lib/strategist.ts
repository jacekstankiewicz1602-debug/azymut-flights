// The strategist: route hypotheses the plain branch and bound would reach late or never (odd hubs,
// positioning flights the "wrong" way, low-cost carriers of two continents chained, open-jaw with a
// ground leg). Each hypothesis is a sequence of airports a path must pass through; the engine turns it
// into the cheapest map path obeying that sequence and verifies it live like any other path.
// With ANTHROPIC_API_KEY, Claude Haiku proposes extra hypotheses from a compact price-map summary;
// without it, deterministic heuristics over the same map. Outcomes are logged in Neon and a learned
// score per hub / pattern orders future hypotheses.
import Anthropic from "@anthropic-ai/sdk";
import { AP, km } from "./airports";
import { config } from "./config";
import { sqlClient } from "./db";
import type { Graph } from "./map";
import { PathEnumerator, type Path } from "./paths";

export type HypoKind = "odd-hub" | "positioning" | "lowcost-chain" | "openjaw-ground" | "learned" | "llm";
export type Hypothesis = { id: string; kind: HypoKind; via: string[]; label: string; score: number };
export type HypoOutcome = Hypothesis & { lb: number | null; price: number | null; won: boolean; status: "ok" | "bound" | "dead" | "nopath" };

const ODD_HUBS = "TAS KEF ALA CMB ADD NBO CAI BAH AMM TBS GYD EVN MCT KWI RUH JED DOH ISB KTM DAC NQZ FRU".split(" ");

let ready: Promise<void> | null = null;
async function sql() {
  const s = await sqlClient();
  if (!s) return null;
  ready ??= (async () => {
    await s`create table if not exists strategy_log (id bigserial primary key, created_at timestamptz not null default now(),
      search_query text, kind text not null, via text[] not null, label text, lb int, price int, won boolean not null, status text not null)`;
    await s`create table if not exists strategy_rank (key text primary key, tries int not null default 0, wins int not null default 0,
      best_saving int not null default 0, updated_at timestamptz not null default now())`;
  })();
  await ready;
  return s;
}

const rankKeys = (h: Hypothesis) => [`pattern:${h.kind}`, ...h.via.map((v) => `hub:${v}`)];

/** Learned bonus per key: wins count much more than tries; unseen keys get a small exploration bonus. */
async function learned(): Promise<Map<string, number>> {
  const s = await sql().catch(() => null);
  const m = new Map<string, number>();
  if (!s) return m;
  const rows = await s`select key, tries, wins, best_saving from strategy_rank`.catch(() => []);
  for (const r of rows) m.set(r.key as string, (Number(r.wins) * 3 + Math.min(Number(r.best_saving), 2000) / 500) / (1 + Number(r.tries) * 0.15));
  return m;
}

export type MapCtx = {
  g: Graph; origin: string[]; dest: string[];
  departs: string[];               // airports the trip may start from anyway (not a "positioning" flight)
  fromHome: Map<string, number>;   // cheapest bound home -> X
  toDest: Map<string, number>;     // cheapest bound X -> destination
};

/** Deterministic hypotheses from the price map. */
function heuristics(c: MapCtx): Hypothesis[] {
  const out: Hypothesis[] = [];
  const o = AP[c.origin[0]], d = AP[c.dest[0]];
  if (!o || !d) return out;
  const direct = km(o, d);
  const via = (h: string) => (c.fromHome.get(h) ?? Infinity) + (c.toDest.get(h) ?? Infinity);
  const add = (kind: HypoKind, hubs: string[], label: string) => {
    if (hubs.some((h) => !AP[h] || c.origin.includes(h) || c.dest.includes(h) || c.departs.includes(h))) return;
    const s = hubs.reduce((acc, h) => acc + via(h), 0) / hubs.length;
    if (!Number.isFinite(s)) return;
    out.push({ id: `${kind}:${hubs.join("-")}`, kind, via: hubs, label, score: -s });
  };
  // 1) odd hubs: cheap on the map, rarely in anyone's routing
  for (const h of ODD_HUBS) add("odd-hub", [h], `nietypowy hub ${h} (${AP[h]?.city ?? h})`);
  // 2) positioning: a cheap flight the wrong way (at least 1500 km farther from the destination, in
  // another country) to a hub with a cheap way on from there
  for (const [h, toD] of c.toDest) {
    const a = AP[h];
    if (!a || !Number.isFinite(toD) || km(a, d) <= direct + 1500 || a.cc === o.cc) continue;
    if ((c.fromHome.get(h) ?? Infinity) > 900) continue;
    add("positioning", [h], `lot pozycjonujący do ${a.city} (${h}), stamtąd tani długi lot`);
  }
  // 3) low-cost long-haul chain: European low-cost hub, then a far-side low-cost hub
  const lc = config.lowcostHubs.filter((h) => AP[h]);
  for (const a of lc.filter((h) => AP[h].region === "EUR")) for (const b of lc.filter((h) => AP[h].region !== "EUR")) {
    if (km(AP[b], d) > direct) continue; // the far hub must be on the way
    add("lowcost-chain", [a, b], `tanie linie z dwóch kontynentów: ${a} → ${b}`);
  }
  // 4) open-jaw with a ground leg: arrive at an airport near the destination, finish by bus / ground
  for (const [from, arcs] of c.g) for (const arc of arcs) {
    if (arc.kind !== "ground" || !c.dest.includes(arc.to) || c.dest.includes(from)) continue;
    add("openjaw-ground", [from], `przylot do ${AP[from]?.city ?? from} (${from}) i dalej lądem`);
  }
  return out;
}

const SCHEMA = {
  type: "object", additionalProperties: false, required: ["hypotheses"],
  properties: {
    hypotheses: {
      type: "array",
      items: {
        type: "object", additionalProperties: false, required: ["via", "reason"],
        properties: {
          via: { type: "array", items: { type: "string", description: "IATA airport code" }, description: "1-3 airports the route must pass, in order" },
          reason: { type: "string", description: "Polish, one short phrase" },
        },
      },
    },
  },
};

/** Optional: Claude Haiku proposes unusual routings from a compact summary of the price map. */
async function llmHypotheses(c: MapCtx, have: Hypothesis[]): Promise<Hypothesis[]> {
  if (!config.keys.anthropic) return [];
  const top = (m: Map<string, number>, n: number) => [...m].filter(([k, v]) => Number.isFinite(v) && AP[k]).sort((a, b) => a[1] - b[1]).slice(0, n).map(([k, v]) => `${k}:${Math.round(v)}`).join(" ");
  const summary = [
    `origin ${c.origin.join(",")} destination ${c.dest.slice(0, 8).join(",")}`,
    `cheapest bound PLN from origin to hub: ${top(c.fromHome, 40)}`,
    `cheapest bound PLN from hub to destination: ${top(c.toDest, 40)}`,
    `already planned: ${have.slice(0, 20).map((h) => h.via.join(">")).join(" ")}`,
  ].join("\n");
  try {
    const client = new Anthropic({ apiKey: config.keys.anthropic });
    const res = await client.messages.create({
      model: config.llmModel, max_tokens: 2000,
      output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
      system: "You design cheap self-transfer flight routings. Propose up to 8 non-obvious hub sequences (positioning flights in the wrong direction, odd hubs, low-cost carriers of two continents, open-jaw with a ground leg) that could undercut the obvious routes. Use only IATA codes from the summary or well-known hubs.",
      messages: [{ role: "user", content: summary }],
    } as unknown as Anthropic.MessageCreateParamsNonStreaming);
    const text = res.content.find((b): b is Anthropic.TextBlock => b.type === "text")?.text;
    if (!text || res.stop_reason === "refusal") return [];
    const data = JSON.parse(text) as { hypotheses: { via: string[]; reason: string }[] };
    return data.hypotheses.map((h) => ({ ...h, via: h.via.map((v) => v.toUpperCase()).filter((v) => AP[v]).slice(0, 3) }))
      .filter((h) => h.via.length).map((h) => ({ id: `llm:${h.via.join("-")}`, kind: "llm" as const, via: h.via, label: `AI: ${h.reason}`, score: 0 }));
  } catch { return []; }
}

/** Ranked hypotheses for this search: map heuristics (+ Claude when a key is set), ordered by map bound and learned wins. */
export async function propose(c: MapCtx, limit: number): Promise<Hypothesis[]> {
  const base = heuristics(c);
  const all = [...base, ...(await llmHypotheses(c, base))];
  const learnedScore = await learned();
  for (const h of all) {
    const bonus = rankKeys(h).reduce((s, k) => s + (learnedScore.get(k) ?? 0), 0);
    // map bound in PLN dominates; each learned "point" is worth 150 PLN of bound
    h.score += bonus * 150;
    if (h.kind === "llm") h.score += 10_000; // proposals from the model always get tried
  }
  const seen = new Set<string>();
  const ranked = all.sort((a, b) => b.score - a.score).filter((h) => !seen.has(h.id) && (seen.add(h.id), true));
  // variety: take the best remaining hypothesis of each kind in turn (round robin over kinds)
  const byKind = new Map<string, Hypothesis[]>();
  for (const h of ranked) { if (!byKind.has(h.kind)) byKind.set(h.kind, []); byKind.get(h.kind)!.push(h); }
  const kinds = [...byKind.keys()].sort((a, b) => byKind.get(b)![0].score - byKind.get(a)![0].score);
  const picked: Hypothesis[] = [];
  for (let i = 0; picked.length < limit && kinds.some((k) => byKind.get(k)!.length > i); i++)
    for (const k of kinds) { const h = byKind.get(k)![i]; if (h && picked.length < limit) picked.push(h); }
  return picked;
}

/** The cheapest map path from sources to targets that passes the `via` airports in order (each segment by A*). */
export async function pathThrough(g: Graph, sources: string[], targets: string[], via: string[], maxFlights: number): Promise<Path | null> {
  const stops = [sources, ...via.map((v) => [v]), targets];
  const nodes: string[] = [];
  const arcs: Path["arcs"] = [];
  let flights = 0, lb = 0;
  for (let i = 0; i < stops.length - 1; i++) {
    const from = i === 0 ? stops[0] : [nodes[nodes.length - 1]];
    const left = maxFlights - flights - (stops.length - 2 - i);
    if (left < 1) return null;
    const e = new PathEnumerator(g, from, new Set(stops[i + 1]), left, () => Infinity, 200_000, 200_000);
    let seg: Path | null = null;
    for (let k = 0; k < 8; k++) {
      const cand = await e.next();
      if (!cand) break;
      // simple path overall: the segment may not revisit airports already used (except its start)
      if (cand.nodes.slice(1).some((n) => nodes.includes(n))) continue;
      seg = cand;
      break;
    }
    if (!seg) return null;
    if (!nodes.length) nodes.push(seg.nodes[0]);
    nodes.push(...seg.nodes.slice(1));
    arcs.push(...seg.arcs);
    flights += seg.flights;
    lb += seg.lb;
  }
  return { id: `${nodes.join("-")}:${arcs.map((a) => a.kind[0]).join("")}`, nodes, arcs, lb, flights };
}

/** Log outcomes and update the learned ranking (best effort, never blocks a search). */
export async function record(query: string, outcomes: HypoOutcome[], bestOther: number): Promise<void> {
  const s = await sql().catch(() => null);
  if (!s || !outcomes.length) return;
  const rows = outcomes.map((h) => ({ search_query: query.slice(0, 200), kind: h.kind, via: h.via, label: h.label.slice(0, 200),
    lb: h.lb === null ? null : Math.round(h.lb), price: h.price === null ? null : Math.round(h.price), won: h.won, status: h.status }));
  await s`insert into strategy_log ${s(rows as never)}`.catch(() => {});
  for (const h of outcomes) {
    const saving = h.won && h.price !== null && Number.isFinite(bestOther) ? Math.max(0, Math.round(bestOther - h.price)) : 0;
    for (const key of rankKeys(h)) {
      await s`insert into strategy_rank (key, tries, wins, best_saving) values (${key}, 1, ${h.won ? 1 : 0}, ${saving})
        on conflict (key) do update set tries = strategy_rank.tries + 1, wins = strategy_rank.wins + ${h.won ? 1 : 0},
          best_saving = greatest(strategy_rank.best_saving, ${saving}), updated_at = now()`.catch(() => {});
    }
  }
}

