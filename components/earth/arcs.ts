// Flight arcs above the globe, drawn on a 2D canvas over the map. Each leg is a great circle on the
// unit sphere lifted by an altitude profile (gentle climb and descent, higher for longer flights),
// projected with the globe's own view-projection matrix, so arcs sit exactly on the rendered globe
// and hide behind it. Ground legs stay on the surface.
import type { Map as MLMap } from "maplibre-gl";
import { AIRPORT_POS } from "../geo";

export type V3 = [number, number, number];

export const toVec = (lon: number, lat: number): V3 => {
  const l = (lon * Math.PI) / 180, p = (lat * Math.PI) / 180;
  return [Math.cos(p) * Math.sin(l), Math.sin(p), Math.cos(p) * Math.cos(l)];
};
export const toLngLat = (v: V3): [number, number] => [(Math.atan2(v[0], v[2]) * 180) / Math.PI, (Math.asin(Math.max(-1, Math.min(1, v[1]))) * 180) / Math.PI];

/** A leg's geometry: unit vectors along the great circle and the altitude (in earth radii) at each. */
export type ArcGeom = { pts: V3[]; alt: Float32Array; angle: number };

const geomCache = new Map<string, ArcGeom>();

/** lift: 0 = on the ground, 1 = full flight profile, values in between for the low live-search arcs. */
export function arcGeom(from: string, to: string, lift = 1, n?: number): ArcGeom | null {
  const k = `${from}${to}${lift}${n ?? ""}`;
  const hit = geomCache.get(k);
  if (hit) return hit;
  const a = AIRPORT_POS[from], b = AIRPORT_POS[to];
  if (!a || !b) return null;
  const A = toVec(a.lon, a.lat), B = toVec(b.lon, b.lat);
  const dot = Math.max(-1, Math.min(1, A[0] * B[0] + A[1] * B[1] + A[2] * B[2]));
  const angle = Math.acos(dot);
  const count = n ?? Math.max(48, Math.min(220, Math.round(angle * 140)));
  // peak altitude grows with distance: ~0.03 R for a short hop, up to 0.17 R across an ocean
  const H = lift * Math.min(0.17, 0.018 + 0.085 * angle);
  const pts: V3[] = [];
  const alt = new Float32Array(count + 1);
  const s = Math.sin(angle);
  for (let i = 0; i <= count; i++) {
    const t = i / count;
    if (s < 1e-6) pts.push(A);
    else {
      const wa = Math.sin((1 - t) * angle) / s, wb = Math.sin(t * angle) / s;
      pts.push([wa * A[0] + wb * B[0], wa * A[1] + wb * B[1], wa * A[2] + wb * B[2]]);
    }
    // a blend of sin and sin² keeps the top round while take-off and landing stay shallow
    const sn = Math.sin(Math.PI * t);
    alt[i] = H * (0.55 * sn + 0.45 * sn * sn);
  }
  const g = { pts, alt, angle };
  if (geomCache.size > 600) geomCache.clear();
  geomCache.set(k, g);
  return g;
}

/** Screen projection of the current globe camera. */
type Cam = { M: ArrayLike<number>; C: V3; w: number; h: number };

function camera(map: MLMap): Cam | null {
  const tr = map.transform as unknown as Record<string, any>;
  const vp = tr._verticalPerspectiveTransform ?? tr.currentTransform ?? tr;
  const M = vp._globeViewProjMatrixNoCorrection as ArrayLike<number> | undefined;
  const C = vp._cameraPosition as ArrayLike<number> | undefined;
  if (!M || !C || (tr.isGlobeRendering === false)) return null;
  return { M, C: [C[0], C[1], C[2]], w: tr.width, h: tr.height };
}

/** Projected polyline: screen x/y per sample and whether the sample is visible. */
type Proj = { x: Float32Array; y: Float32Array; vis: Uint8Array; n: number };

function project(cam: Cam, g: ArcGeom, out?: Proj): Proj {
  const n = g.pts.length;
  const p = out && out.x.length >= n ? out : { x: new Float32Array(n), y: new Float32Array(n), vis: new Uint8Array(n), n };
  p.n = n;
  const { M, C, w, h } = cam;
  const cc = C[0] * C[0] + C[1] * C[1] + C[2] * C[2] - 1;
  for (let i = 0; i < n; i++) {
    const r = 1 + g.alt[i];
    const v = g.pts[i];
    const x = v[0] * r, y = v[1] * r, z = v[2] * r;
    const cw = M[3] * x + M[7] * y + M[11] * z + M[15];
    if (cw <= 1e-6) { p.vis[i] = 0; continue; }
    p.x[i] = ((M[0] * x + M[4] * y + M[8] * z + M[12]) / cw * 0.5 + 0.5) * w;
    p.y[i] = (-(M[1] * x + M[5] * y + M[9] * z + M[13]) / cw * 0.5 + 0.5) * h;
    // occluded when the segment camera -> point enters the unit sphere before reaching the point
    const dx = x - C[0], dy = y - C[1], dz = z - C[2];
    const a = dx * dx + dy * dy + dz * dz, b = 2 * (C[0] * dx + C[1] * dy + C[2] * dz);
    const disc = b * b - 4 * a * cc;
    let vis = 1;
    if (disc > 0) {
      const t1 = (-b - Math.sqrt(disc)) / (2 * a);
      if (t1 > 0 && t1 < 1 - 1e-4) vis = 0;
    }
    // and only while the ground below is on the near side: an arc going over the horizon ends at
    // the horizon instead of hooking down behind the globe
    // (with a margin: near the rim a high arc would seem to bend down sharply in perspective)
    if (vis && g.alt[i] > 0) {
      const gx = C[0] - v[0], gy = C[1] - v[1], gz = C[2] - v[2];
      const facing = (v[0] * gx + v[1] * gy + v[2] * gz) / Math.sqrt(gx * gx + gy * gy + gz * gz);
      if (facing < 0.22) vis = 0;
    }
    p.vis[i] = vis;
  }
  return p;
}

/** Path of samples [i0, i1] (fractional end) with breaks where the arc goes behind the globe. */
function tracePath(ctx: CanvasRenderingContext2D, p: Proj, f0: number, f1: number) {
  const last = p.n - 1;
  const a = Math.max(0, Math.min(last, f0 * last)), b = Math.max(0, Math.min(last, f1 * last));
  if (b <= a) return false;
  let pen = false, any = false;
  const at = (f: number): [number, number, boolean] => {
    const i = Math.floor(f), j = Math.min(last, i + 1), u = f - i;
    if (!p.vis[i] || !p.vis[j]) return [p.x[i], p.y[i], !!p.vis[i] && u < 0.5];
    return [p.x[i] + (p.x[j] - p.x[i]) * u, p.y[i] + (p.y[j] - p.y[i]) * u, true];
  };
  const [sx, sy, sv] = at(a);
  if (sv) { ctx.moveTo(sx, sy); pen = true; }
  for (let i = Math.ceil(a); i <= Math.floor(b); i++) {
    if (!p.vis[i]) { pen = false; continue; }
    if (pen) ctx.lineTo(p.x[i], p.y[i]); else { ctx.moveTo(p.x[i], p.y[i]); pen = true; }
    any = true;
  }
  const [ex, ey, ev] = at(b);
  if (ev && pen) { ctx.lineTo(ex, ey); any = true; }
  return any;
}

/** Screen point and heading at fraction f of a projected arc (null when hidden). */
function pointAt(p: Proj, f: number): { x: number; y: number; ang: number } | null {
  const last = p.n - 1;
  const fi = Math.max(0, Math.min(last, f * last));
  const i = Math.min(last - 1, Math.floor(fi)), u = fi - i;
  if (!p.vis[i] || !p.vis[i + 1]) return null;
  const x = p.x[i] + (p.x[i + 1] - p.x[i]) * u, y = p.y[i] + (p.y[i + 1] - p.y[i]) * u;
  // heading from a short span around the point (smooth even where samples are dense)
  const i0 = Math.max(0, i - 2), i1 = Math.min(last, i + 3);
  const ang = p.vis[i0] && p.vis[i1] ? Math.atan2(p.y[i1] - p.y[i0], p.x[i1] - p.x[i0]) : Math.atan2(p.y[i + 1] - p.y[i], p.x[i + 1] - p.x[i]);
  return { x, y, ang };
}

// plane silhouette pointing along +x, unit length ~2
const PLANE: [number, number][] = [
  [1.0, 0], [0.86, 0.07], [0.22, 0.1], [-0.18, 0.86], [-0.36, 0.86], [-0.16, 0.1], [-0.66, 0.09], [-0.84, 0.36], [-0.97, 0.36], [-0.88, 0.0],
];

export type Colors = { arc: string; head: string; ground: string; dot: string; halo: string; rgb: string; groundRgb: string };

export type LegDraw = { geom: ArcGeom; ground: boolean; progress: number; active: boolean; idx?: number; focus?: boolean; dim?: boolean };
/** net: a route already asked about, kept as a thin low line of the network the search is building. */
export type LiveDraw = { geom: ArcGeom; state: "checking" | "ok" | "rejected" | "best"; alpha: number; phase: number; net?: boolean; from?: string; to?: string };

export class ArcCanvas {
  readonly el: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private dpr = 1;
  private cam: Cam | null = null;
  private buf: Proj = { x: new Float32Array(256), y: new Float32Array(256), vis: new Uint8Array(256), n: 0 };
  private dirty = false;
  /** screen polylines of the legs drawn in the last frame, for clicks on a route */
  private hits: { idx: number; x: Float32Array; y: Float32Array; vis: Uint8Array; n: number }[] = [];

  constructor(private map: MLMap) {
    this.el = document.createElement("canvas");
    this.el.className = "arc-canvas";
    map.getCanvasContainer().appendChild(this.el);
    this.ctx = this.el.getContext("2d")!;
    this.resize();
    map.on("resize", () => this.resize());
  }

  destroy() { this.el.remove(); }

  private resize() {
    const c = this.map.getCanvas();
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = c.clientWidth, h = c.clientHeight;
    this.el.width = Math.round(w * this.dpr);
    this.el.height = Math.round(h * this.dpr);
    this.el.style.width = `${w}px`;
    this.el.style.height = `${h}px`;
  }

  /** Start a frame; returns false when the globe camera is unavailable. */
  begin(): boolean {
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.el.width, this.el.height);
    this.dirty = false;
    this.hits = [];
    this.cam = camera(this.map);
    if (!this.cam) return false;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    return true;
  }

  /** Clear once and stay empty until the next draw. */
  clear() {
    if (!this.dirty && this.cam === null) return;
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, this.el.width, this.el.height);
    this.cam = null;
  }

  /** Leg under a screen point (CSS px), within 14 px of its drawn line. */
  hit(x: number, y: number): number | null {
    let best: number | null = null, bd = 14 * 14;
    for (const h of this.hits) {
      for (let i = 0; i < h.n - 1; i++) {
        if (!h.vis[i] || !h.vis[i + 1]) continue;
        const ax = h.x[i], ay = h.y[i], bx = h.x[i + 1], by = h.y[i + 1];
        const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
        const u = L ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L)) : 0;
        const ex = ax + u * dx - x, ey = ay + u * dy - y, d = ex * ex + ey * ey;
        if (d < bd) { bd = d; best = h.idx; }
      }
    }
    return best;
  }

  private proj(g: ArcGeom) { this.buf = project(this.cam!, g, this.buf); return this.buf; }

  /** Live search: the network of every route asked about grows on the globe (thin low lines, airports
   *  as nodes sized by how many routes meet there); the routes being asked right now fly over it as
   *  comets with a landing ring, and the best route so far glows on top with a pulse running along it. */
  live(arcs: LiveDraw[], c: Colors, now: number) {
    if (!this.cam) return;
    const ctx = this.ctx;
    this.dirty = true;
    const order = (a: LiveDraw) => (a.state === "best" ? 2 : a.net ? 0 : 1);
    arcs.sort((a, b) => order(a) - order(b));
    const ends: { x: number; y: number; a: number; phase: number }[] = [];
    const nodes = new Map<string, { x: number; y: number; deg: number; hot: number }>();
    const node = (code: string | undefined, pt: { x: number; y: number } | null, hot: number) => {
      if (!code || !pt) return;
      const n = nodes.get(code);
      if (n) { n.deg++; n.hot = Math.max(n.hot, hot); } else nodes.set(code, { x: pt.x, y: pt.y, deg: 1, hot });
    };
    // the network: one path per colour, so hundreds of lines cost a few strokes
    const groups: Record<string, LiveDraw[]> = { rejected: [], seen: [], ok: [] };
    for (const a of arcs) if (a.net) groups[a.state === "rejected" ? "rejected" : a.state === "ok" ? "ok" : "seen"].push(a);
    const style: Record<string, [string, number]> = { rejected: [`rgba(${c.groundRgb},0.16)`, 0.8], seen: [`rgba(${c.rgb},0.22)`, 0.9], ok: [`rgba(${c.rgb},0.42)`, 1.1] };
    for (const [k, list] of Object.entries(groups)) {
      if (!list.length) continue;
      ctx.beginPath();
      for (const a of list) {
        const p = this.proj(a.geom);
        tracePath(ctx, p, 0, 1);
        node(a.from, pointAt(p, 0), a.alpha); node(a.to, pointAt(p, 0.999), a.alpha);
      }
      ctx.strokeStyle = style[k][0]; ctx.lineWidth = style[k][1]; ctx.stroke();
    }
    for (const a of arcs) {
      if (a.net) continue;
      const p = this.proj(a.geom);
      if (a.state === "best") {
        ctx.beginPath();
        if (!tracePath(ctx, p, 0, 1)) continue;
        ctx.save();
        ctx.globalAlpha = a.alpha;
        ctx.strokeStyle = `rgba(${c.rgb},0.2)`; ctx.lineWidth = 12; ctx.stroke();
        ctx.shadowColor = `rgba(${c.rgb},0.9)`; ctx.shadowBlur = 16;
        ctx.strokeStyle = c.arc; ctx.lineWidth = 3; ctx.stroke();
        ctx.restore();
        node(a.from, pointAt(p, 0), 1); node(a.to, pointAt(p, 0.999), 1);
        const f = ((now / 2400) + a.phase) % 1;
        this.comet(p, f, 0.22, c, a.alpha, 3.6);
        continue;
      }
      // asked right now: a comet over its own faint trace
      ctx.beginPath();
      if (!tracePath(ctx, p, 0, 1)) continue;
      ctx.lineWidth = 1;
      ctx.strokeStyle = `rgba(${c.rgb},${0.3 * a.alpha})`;
      ctx.stroke();
      const f = Math.min(1, a.phase);
      this.comet(p, f, 0.3, c, a.alpha, 2.6);
      node(a.from, pointAt(p, 0), 1);
      const tip = pointAt(p, Math.min(0.999, f));
      if (tip) ends.push({ x: tip.x, y: tip.y, a: a.alpha, phase: 0 });
      if (f >= 1) { const e = pointAt(p, 0.999); if (e) ends.push({ x: e.x, y: e.y, a: a.alpha, phase: a.phase - 1 }); }
    }
    // airports as nodes: size by the routes meeting there, the busy hubs with a glow
    for (const n of nodes.values()) {
      const r = 1.4 + Math.min(4.2, Math.sqrt(n.deg) * 0.9);
      ctx.save();
      if (n.deg >= 4 || n.hot > 0.9) { ctx.shadowColor = `rgba(${c.rgb},0.9)`; ctx.shadowBlur = 8 + r * 2; }
      ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
      ctx.fillStyle = n.deg >= 4 ? c.head : `rgba(${c.rgb},${0.55 + 0.45 * Math.min(1, n.hot)})`; ctx.fill();
      ctx.restore();
    }
    // landing rings: a soft ring opens where a route being asked arrives
    for (const e of ends) {
      if (e.phase <= 0) { ctx.beginPath(); ctx.arc(e.x, e.y, 2.4, 0, Math.PI * 2); ctx.fillStyle = `rgba(${c.rgb},${0.9 * e.a})`; ctx.fill(); continue; }
      const k = Math.min(1, e.phase / 0.8);
      ctx.beginPath(); ctx.arc(e.x, e.y, 3 + 16 * k, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(${c.rgb},${(1 - k) * 0.8 * e.a})`; ctx.lineWidth = 1.5; ctx.stroke();
    }
  }

  /** A bright head at fraction f with a tail of length len fading behind it. */
  private comet(p: Proj, f: number, len: number, c: Colors, alpha: number, width: number) {
    const ctx = this.ctx;
    const steps = 6;
    for (let k = 0; k < steps; k++) {
      const a0 = Math.max(0, f - len * (1 - k / steps)), a1 = Math.max(0, f - len * (1 - (k + 1) / steps));
      if (a1 <= a0) continue;
      ctx.beginPath();
      if (!tracePath(ctx, p, a0, a1)) continue;
      const u = (k + 1) / steps;
      ctx.strokeStyle = `rgba(${c.rgb},${alpha * u * u})`;
      ctx.lineWidth = width * (0.45 + 0.55 * u);
      ctx.stroke();
    }
    const h = pointAt(p, Math.min(0.999, f));
    if (h && f < 1) {
      ctx.save();
      ctx.shadowColor = c.head; ctx.shadowBlur = 10;
      ctx.beginPath(); ctx.arc(h.x, h.y, width * 0.9, 0, Math.PI * 2);
      ctx.fillStyle = c.halo; ctx.globalAlpha = alpha; ctx.fill();
      ctx.restore();
    }
  }

  /** Journey: dashed dim route ahead, bright trail behind, plane (or bus) at the head. */
  legs(legs: LegDraw[], c: Colors, now: number) {
    if (!this.cam) return;
    const ctx = this.ctx;
    this.dirty = true;
    let head: { x: number; y: number; ang: number; ground: boolean } | null = null;
    for (const l of legs) {
      const p = this.proj(l.geom);
      const k = Math.max(0, Math.min(1, l.progress));
      // ahead: dashed and dimmed
      if (k < 1) {
        ctx.beginPath();
        if (tracePath(ctx, p, k, 1)) {
          ctx.setLineDash(l.ground ? [3, 5] : [5, 6]);
          ctx.strokeStyle = l.ground ? `rgba(${c.groundRgb},0.55)` : `rgba(${c.rgb},0.38)`;
          ctx.lineWidth = l.ground ? 1.4 : 1.5;
          ctx.stroke();
          ctx.setLineDash([]);
        }
      }
      if (k <= 0) continue;
      if (l.ground) {
        ctx.beginPath();
        if (tracePath(ctx, p, 0, k)) {
          ctx.setLineDash([3, 4]);
          ctx.strokeStyle = `rgba(${c.groundRgb},0.95)`; ctx.lineWidth = 2; ctx.stroke();
          ctx.setLineDash([]);
        }
      } else {
        // behind: a soft coral glow and a gradient core (deeper at the start, peach at the tip)
        ctx.beginPath();
        if (tracePath(ctx, p, 0, k)) {
          const tail = pointAt(p, 0), tip = pointAt(p, k);
          let stroke: string | CanvasGradient = c.arc;
          if (tail && tip && Math.hypot(tip.x - tail.x, tip.y - tail.y) > 4) {
            const g = ctx.createLinearGradient(tail.x, tail.y, tip.x, tip.y);
            g.addColorStop(0, `rgba(${c.rgb},${l.active ? 0.5 : 0.85})`); g.addColorStop(0.55, c.arc); g.addColorStop(1, c.head);
            stroke = g;
          }
          const a = l.dim ? 0.32 : 1;
          ctx.save();
          ctx.globalAlpha = a;
          ctx.strokeStyle = `rgba(${c.rgb},${l.focus ? 0.22 : 0.12})`; ctx.lineWidth = l.focus ? 14 : l.active ? 11 : 8; ctx.stroke();
          ctx.shadowColor = `rgba(${c.rgb},0.55)`; ctx.shadowBlur = l.focus ? 16 : 8;
          ctx.strokeStyle = stroke; ctx.lineWidth = l.focus ? 3.8 : l.active ? 3 : 2.5; ctx.stroke();
          ctx.restore();
        }
      }
      if (l.idx !== undefined && k > 0) this.hits.push({ idx: l.idx, x: p.x.slice(0, p.n), y: p.y.slice(0, p.n), vis: p.vis.slice(0, p.n), n: p.n });
      if (l.active && k < 1) {
        const pt = pointAt(p, k);
        if (pt) head = { ...pt, ground: l.ground };
      }
    }
    if (head) {
      if (head.ground) this.bus(head.x, head.y, c);
      else this.plane(head.x, head.y, head.ang, c);
    }
    void now;
  }

  /** Route airports as clean Apple Maps-style markers: a white disc with a soft shadow and an accent
   *  centre; the active one (where the camera is) slightly larger. No pulsing rings. */
  airports(codes: string[], c: Colors, now: number, active?: string) {
    if (!this.cam) return;
    const ctx = this.ctx;
    this.dirty = true;
    void now;
    for (const code of codes) {
      const g = arcGeom(code, code, 0, 1);
      if (!g) continue;
      const p = this.proj(g);
      if (!p.vis[0]) continue;
      const x = p.x[0], y = p.y[0];
      const big = code === active;
      const r = big ? 7.5 : 6;
      ctx.save();
      ctx.shadowColor = "rgba(40, 30, 20, 0.28)"; ctx.shadowBlur = 6; ctx.shadowOffsetY = 1.5;
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = c.halo; ctx.fill();
      ctx.restore();
      ctx.beginPath(); ctx.arc(x, y, r - 2.6, 0, Math.PI * 2);
      ctx.fillStyle = c.arc; ctx.fill();
    }
  }

  private plane(x: number, y: number, ang: number, c: Colors) {
    const ctx = this.ctx;
    const s = 9;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(ang);
    ctx.beginPath();
    ctx.arc(0, 0, 16, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(${c.rgb},0.16)`;
    ctx.fill();
    ctx.beginPath();
    PLANE.forEach(([px, py], i) => (i ? ctx.lineTo(px * s, py * s) : ctx.moveTo(px * s, py * s)));
    for (let i = PLANE.length - 1; i >= 0; i--) ctx.lineTo(PLANE[i][0] * s, -PLANE[i][1] * s);
    ctx.closePath();
    ctx.fillStyle = c.head;
    ctx.strokeStyle = c.halo;
    ctx.lineWidth = 1.2;
    ctx.stroke();
    ctx.fill();
    ctx.restore();
  }

  private bus(x: number, y: number, c: Colors) {
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(x, y);
    ctx.beginPath();
    ctx.roundRect(-8, -6, 16, 11, 2.5);
    ctx.fillStyle = c.ground; ctx.fill();
    ctx.strokeStyle = c.halo; ctx.lineWidth = 1.2; ctx.stroke();
    ctx.fillStyle = c.halo;
    ctx.fillRect(-6, -4, 5, 3.5); ctx.fillRect(1, -4, 5, 3.5);
    ctx.beginPath(); ctx.arc(-4.5, 5, 1.6, 0, Math.PI * 2); ctx.arc(4.5, 5, 1.6, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }
}
