// Lazy enumeration of simple paths in nondecreasing lower-bound order (A* with an exact
// relaxed heuristic). Each popped path is the next cheapest, so branch and bound can stop
// as soon as a popped path's lower bound reaches the incumbent.
import type { Arc, Graph } from "./map";

export type Path = { id: string; nodes: string[]; arcs: Arc[]; lb: number; flights: number };

export class Heap<T> {
  private a: T[] = [];
  constructor(private key: (x: T) => number) {}
  get size() { return this.a.length; }
  /** Keep the `keep` items with the lowest keys; returns the lowest key dropped (Infinity: none). */
  shrink(keep: number): number {
    if (this.a.length <= keep) return Infinity;
    const all = this.a.sort((x, y) => this.key(x) - this.key(y)); // a sorted array is a valid min-heap
    const cut = this.key(all[keep]);
    all.length = keep;
    return cut;
  }
  push(x: T) {
    const a = this.a; a.push(x);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.key(a[p]) <= this.key(a[i])) break;
      [a[p], a[i]] = [a[i], a[p]]; i = p;
    }
  }
  pop(): T | undefined {
    const a = this.a;
    if (!a.length) return undefined;
    const top = a[0], last = a.pop()!;
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && this.key(a[l]) < this.key(a[m])) m = l;
        if (r < a.length && this.key(a[r]) < this.key(a[m])) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]]; i = m;
      }
    }
    return top;
  }
  peek(): T | undefined { return this.a[0]; }
}

/** Cheapest cost from every node to any target, ignoring leg limits (admissible + consistent). */
function heuristic(graph: Graph, targets: Set<string>): Map<string, number> {
  const rev = new Map<string, { from: string; w: number }[]>();
  for (const [from, arcs] of graph) for (const a of arcs) {
    if (!rev.has(a.to)) rev.set(a.to, []);
    rev.get(a.to)!.push({ from, w: a.lb });
  }
  const dist = new Map<string, number>();
  const h = new Heap<[string, number]>((x) => x[1]);
  for (const t of targets) { dist.set(t, 0); h.push([t, 0]); }
  while (h.size) {
    const [n, d] = h.pop()!;
    if (d > (dist.get(n) ?? Infinity)) continue;
    for (const { from, w } of rev.get(n) ?? []) {
      const nd = d + w;
      if (nd < (dist.get(from) ?? Infinity)) { dist.set(from, nd); h.push([from, nd]); }
    }
  }
  return dist;
}

/**
 * States live in typed arrays (struct of arrays, ~40 bytes each) instead of objects (~400 bytes
 * with parent links and heap overhead), so memory is no longer the limit; the 1.5M cap bounds step replay time (larger caps left steps no time for live queries).
 */
class StateStore {
  cap = 1 << 16; n = 0;
  node = new Int32Array(this.cap); parent = new Int32Array(this.cap);
  cost = new Float64Array(this.cap); f = new Float64Array(this.cap);
  flights = new Uint8Array(this.cap); depth = new Uint8Array(this.cap);
  arc: (Arc | null)[] = [];
  private grow() {
    const c = this.cap * 2;
    const g = <T extends Int32Array | Float64Array | Uint8Array>(a: T): T => { const b = new (a.constructor as any)(c); b.set(a); return b; };
    this.node = g(this.node); this.parent = g(this.parent); this.cost = g(this.cost);
    this.f = g(this.f); this.flights = g(this.flights); this.depth = g(this.depth); this.cap = c;
  }
  /** Keep only the states `live` marks (queued states and their ancestors); returns old -> new index (-1: gone). */
  compact(live: Uint8Array): Int32Array {
    const n = this.n, map = new Int32Array(n).fill(-1);
    let m = 0;
    for (let i = 0; i < n; i++) if (live[i]) map[i] = m++;
    const cap = Math.max(1 << 16, m * 2);
    const node = new Int32Array(cap), parent = new Int32Array(cap), cost = new Float64Array(cap), f = new Float64Array(cap);
    const flights = new Uint8Array(cap), depth = new Uint8Array(cap);
    const arc: (Arc | null)[] = new Array(m);
    for (let i = 0; i < n; i++) {
      const j = map[i];
      if (j < 0) continue;
      node[j] = this.node[i]; parent[j] = this.parent[i] < 0 ? -1 : map[this.parent[i]]; cost[j] = this.cost[i]; f[j] = this.f[i];
      flights[j] = this.flights[i]; depth[j] = this.depth[i]; arc[j] = this.arc[i];
    }
    Object.assign(this, { node, parent, cost, f, flights, depth, arc, cap, n: m });
    return map;
  }
  add(node: number, parent: number, cost: number, f: number, arc: Arc | null, flights: number, depth: number): number {
    if (this.n === this.cap) this.grow();
    const i = this.n++;
    this.node[i] = node; this.parent[i] = parent; this.cost[i] = cost; this.f[i] = f;
    this.flights[i] = flights; this.depth[i] = depth; this.arc.push(arc);
    return i;
  }
}

/** Binary min-heap of state indices keyed by the store's f values. */
class IndexHeap {
  private a = new Int32Array(1 << 16); size = 0;
  constructor(private f: () => Float64Array) {}
  push(x: number) {
    if (this.size === this.a.length) { const b = new Int32Array(this.a.length * 2); b.set(this.a); this.a = b; }
    const a = this.a, f = this.f(), k = f[x];
    let i = this.size++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (f[a[p]] <= k) break;
      a[i] = a[p]; i = p;
    }
    a[i] = x;
  }
  pop(): number {
    const a = this.a, f = this.f(), top = a[0], last = a[--this.size];
    const n = this.size, k = f[last];
    let i = 0;
    for (;;) {
      const l = 2 * i + 1;
      if (l >= n) break;
      const m = l + 1 < n && f[a[l + 1]] < f[a[l]] ? l + 1 : l;
      if (f[a[m]] >= k) break;
      a[i] = a[m]; i = m;
    }
    if (n) a[i] = last;
    return top;
  }
  peek(): number { return this.size ? this.a[0] : -1; }
  entries(): Int32Array { return this.a.subarray(0, this.size); }
  remap(map: Int32Array) { for (let i = 0; i < this.size; i++) this.a[i] = map[this.a[i]]; }
  /** Keep the `keep` states with the lowest f, drop the rest; returns the lowest f dropped. */
  evict(keep: number): number {
    const f = this.f();
    const all = Array.from(this.a.subarray(0, this.size)).sort((x, y) => f[x] - f[y]);
    const cut = f[all[keep]] ?? Infinity;
    this.size = 0;
    for (let i = 0; i < keep && i < all.length; i++) this.push(all[i]);
    return cut;
  }
}

export class PathEnumerator {
  private st = new StateStore();
  private heap = new IndexHeap(() => this.st.f);
  private h: Map<string, number>;
  private names: string[] = [];
  private ids = new Map<string, number>();
  expansions = 0;
  /** True when a memory/time safety cap stopped the search early (then nothing is proven). */
  truncated = false;
  /** When the queue is full the states with the highest bounds are dropped (not the new ones): every
   *  dropped state, and anything it would have led to, costs at least this much. A best trip at or below
   *  it is still proven optimal (see provenBelow). */
  evictedLb = Infinity;
  evictions = 0;
  /** sizes for the memory log */
  get sizes() { return { store: this.st.n, queue: this.heap.size, names: this.names.length }; }
  /** the store (every state ever queued, for the parent chains) is compacted at this size */
  private get maxStore() { return this.maxQueued * 2; }
  /** Free the store: drop the worse half of the queue, then every state no queued path still needs. */
  private reclaim(keep: number): number {
    if (this.heap.size > this.maxQueued >> 1) { this.evictedLb = Math.min(this.evictedLb, this.heap.evict(this.maxQueued >> 1)); this.evictions++; this.truncated = true; }
    const st = this.st, live = new Uint8Array(st.n);
    for (const x of [...this.heap.entries(), keep]) for (let y = x; y >= 0 && !live[y]; y = st.parent[y]) live[y] = 1;
    const map = st.compact(live);
    this.heap.remap(map);
    return map[keep];
  }
  /** Set when the step's deadline stopped the enumeration (a resumed step continues). */
  outOfTime = false;
  deadline = Infinity;
  /**
   * @param bound states whose lower bound reaches this value are never pushed (branch and bound)
   * @param maxExpansions / maxQueued safety caps; hitting them sets `truncated` (no optimality claim)
   */
  constructor(
    private graph: Graph, sources: string[], private targets: Set<string>, private maxFlights: number,
    private bound: () => number = () => Infinity, private maxExpansions = 1_500_000, private maxQueued = 1_500_000,
  ) {
    this.h = heuristic(graph, targets);
    for (const s of sources) {
      const hs = this.h.get(s);
      if (hs !== undefined) this.heap.push(this.st.add(this.id(s), -1, 0, hs, null, 0, 0));
    }
  }

  private id(node: string): number {
    let i = this.ids.get(node);
    if (i === undefined) { i = this.names.length; this.names.push(node); this.ids.set(node, i); }
    return i;
  }

  private onPath(s: number, node: number): boolean {
    const st = this.st;
    for (let x = s; x >= 0; x = st.parent[x]) if (st.node[x] === node) return true;
    return false;
  }

  /** Lower bound of the next path this enumerator would return (dropped states included). */
  peekLb(): number {
    const t = this.heap.peek();
    return Math.min(t < 0 ? Infinity : this.st.f[t], this.evictedLb);
  }
  /** Nothing dropped by the memory cap can beat `price`: the expansion cap was not hit and every dropped
   *  state's bound is at least the price. */
  provenBelow(price: number): boolean { return this.expansions < this.maxExpansions && price <= this.evictedLb; }

  /** Next path in bound order. Yields to the event loop regularly and respects the step deadline. */
  async next(): Promise<Path | null> {
    const st = this.st;
    let n = 0;
    while (this.heap.size && this.expansions < this.maxExpansions) {
      if (++n % 20000 === 0) {
        await new Promise((r) => setImmediate(r));
        if (Date.now() > this.deadline) { this.outOfTime = true; return null; }
      }
      let s = this.heap.pop();
      if (st.f[s] >= this.bound()) continue;
      const node = this.names[st.node[s]];
      if (this.targets.has(node) && st.flights[s] > 0) {
        const nodes: string[] = [], arcs: Arc[] = [];
        for (let x = s; x >= 0; x = st.parent[x]) { nodes.unshift(this.names[st.node[x]]); const a = st.arc[x]; if (a) arcs.unshift(a); }
        return { id: nodes.join("-") + ":" + arcs.map((a) => a.kind[0]).join(""), nodes, arcs, lb: st.cost[s], flights: st.flights[s] };
      }
      this.expansions++;
      const lastGround = st.arc[s]?.kind === "ground";
      const lim = this.bound();
      const cost0 = st.cost[s], fl0 = st.flights[s], depth = st.depth[s];
      for (const a of this.graph.get(node) ?? []) {
        if (a.kind === "ground" && lastGround) continue;
        const flights = fl0 + (a.kind === "flight" ? 1 : 0);
        if (flights > this.maxFlights || depth >= this.maxFlights * 2) continue;
        const ht = this.h.get(a.to);
        if (ht === undefined) continue;
        const cost = cost0 + a.lb;
        if (cost + ht >= lim) continue;
        // above the eviction cut: counted as dropped (its bound is already >= evictedLb)
        if (cost + ht >= this.evictedLb) continue;
        const to = this.id(a.to);
        if (this.onPath(s, to)) continue;
        if (st.n >= this.maxStore) s = this.reclaim(s); // the state being expanded survives (its index changes)
        if (st.n >= this.maxStore) { this.evictedLb = Math.min(this.evictedLb, cost + ht); this.truncated = true; continue; }
        if (this.heap.size >= this.maxQueued) {
          // drop the worse half of the queue (highest bounds), keep the new state if it is below the cut
          this.evictedLb = Math.min(this.evictedLb, this.heap.evict(this.maxQueued >> 1));
          this.evictions++;
          this.truncated = true;
          if (cost + ht >= this.evictedLb) continue;
        }
        this.heap.push(st.add(to, s, cost, cost + ht, a, flights, depth + 1));
      }
    }
    if (this.heap.size && this.expansions >= this.maxExpansions) this.truncated = true;
    return null;
  }
}
