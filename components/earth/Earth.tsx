"use client";
// Vector globe (MapLibre GL, globe projection) with a custom style. Routes are arcs rising above the
// globe, drawn on a canvas overlay (./arcs) in sync with each map frame; ground legs stay on the
// surface. The journey animation drives the camera frame by frame along each leg, after the tiles
// along the whole camera path have been loaded.
import maplibregl, { type GeoJSONSource, type Map as MLMap } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useRef, useState } from "react";
import type { Trip, TripLeg } from "@/lib/engine";
import { AIRPORT_POS, fmtDur, fmtPln, fmtTime, gcKm } from "../geo";
import { getState, isPhone, liveArcs, markBest, setState, sheetPx, sheetSnap, subscribe, TAB_H, touchArc } from "../store";
import { carrierCode, cityOf, connBefore, days, logoUrl, svg, ticketOf } from "../trip-info";
import { locale, t as tr, useLang } from "../i18n";
import { ArcCanvas, arcGeom, type ArcGeom, type Colors, type LegDraw, type LiveDraw } from "./arcs";
import { mapStyle, PALETTE, prefetchDem, registerDemProtocol, type Theme } from "./style";

type LngLat = [number, number];
type FC = GeoJSON.FeatureCollection;
const EMPTY: FC = { type: "FeatureCollection", features: [] };
const isGround = (l: TripLeg) => l.source === "flixbus" || l.source === "local" || l.source === "ground";
const R = Math.PI / 180;

/** Great circle a -> b, densely sampled, longitudes unwrapped so lines never jump across the map. */
function greatCircle(from: string, to: string, n = 160): LngLat[] {
  const a = AIRPORT_POS[from], b = AIRPORT_POS[to];
  const [l1, p1, l2, p2] = [a.lon * R, a.lat * R, b.lon * R, b.lat * R];
  const d = 2 * Math.asin(Math.sqrt(Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin((l2 - l1) / 2) ** 2));
  const out: LngLat[] = [];
  for (let i = 0; i <= n; i++) {
    const f = i / n;
    if (d < 1e-6) { out.push([a.lon, a.lat]); continue; }
    const A = Math.sin((1 - f) * d) / Math.sin(d), B = Math.sin(f * d) / Math.sin(d);
    const x = A * Math.cos(p1) * Math.cos(l1) + B * Math.cos(p2) * Math.cos(l2);
    const y = A * Math.cos(p1) * Math.sin(l1) + B * Math.cos(p2) * Math.sin(l2);
    const z = A * Math.sin(p1) + B * Math.sin(p2);
    let lon = Math.atan2(y, x) / R;
    const lat = Math.atan2(z, Math.sqrt(x * x + y * y)) / R;
    if (out.length) { const prev = out[out.length - 1][0]; while (lon - prev > 180) lon -= 360; while (lon - prev < -180) lon += 360; }
    out.push([lon, lat]);
  }
  return out;
}

function partial(pts: LngLat[], p: number): LngLat[] {
  if (p <= 0) return [pts[0], pts[0]];
  const f = p * (pts.length - 1), n = Math.floor(f);
  const out = pts.slice(0, n + 1);
  if (n < pts.length - 1) { const [a, b] = [pts[n], pts[n + 1]]; out.push([a[0] + (b[0] - a[0]) * (f - n), a[1] + (b[1] - a[1]) * (f - n)]); }
  return out.length > 1 ? out : [pts[0], pts[0]];
}

const bearing = (a: LngLat, b: LngLat) => {
  const [l1, p1, l2, p2] = [a[0] * R, a[1] * R, b[0] * R, b[1] * R];
  return Math.atan2(Math.sin(l2 - l1) * Math.cos(p2), Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(l2 - l1)) / R;
};
/** Camera bearing: leans up to 25° towards eastbound/westbound flights; north stays roughly up. */
const tilt = (heading: number) => 25 * Math.sin(heading * R);
const lerpAngle = (a: number, b: number, t: number) => { const d = ((b - a + 540) % 360) - 180; return a + d * t; };
const ease = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const line = (coords: LngLat[], props: Record<string, unknown> = {}): GeoJSON.Feature => ({ type: "Feature", properties: props, geometry: { type: "LineString", coordinates: coords } });
const point = (c: LngLat, props: Record<string, unknown> = {}): GeoJSON.Feature => ({ type: "Feature", properties: props, geometry: { type: "Point", coordinates: c } });

type Fly = { kind: "fly"; leg: TripLeg; pts: LngLat[]; geom: ArcGeom | null; start: number; dur: number; km: number };
type Seg = Fly | { kind: "pause"; leg: TripLeg; next: TripLeg; start: number; dur: number } | { kind: "final"; start: number; dur: number };

function timeline(trip: Trip): Seg[] {
  const segs: Seg[] = [];
  let t = 1.4;
  trip.legs.forEach((leg, i) => {
    const km = gcKm(leg.from, leg.to);
    const pts = isGround(leg) ? greatCircle(leg.from, leg.to, 24) : greatCircle(leg.from, leg.to);
    const dur = isGround(leg) ? 2.2 : 3.0 + Math.min(4.5, km / 2400);
    segs.push({ kind: "fly", leg, pts, geom: arcGeom(leg.from, leg.to, isGround(leg) ? 0 : 1), start: t, dur, km });
    t += dur;
    const next = trip.legs[i + 1];
    if (next) { const d = next.dir !== leg.dir ? 2.6 : 2.1; segs.push({ kind: "pause", leg, next, start: t, dur: d }); t += d; }
  });
  segs.push({ kind: "final", start: t, dur: 3.5 });
  return segs;
}

/** Phone: routes are framed no closer than this, so the globe's curve shows and the arcs rise over it as
 *  on the laptop (closer in, a narrow screen flattens the earth and the arcs look like straight strokes). */
const PHONE_ZOOM = 2.6;

/** Phone: camera padding so the map's centre is the free area — below the search pill, above the
 *  results sheet (its snap height) and the tab bar; nothing under a full sheet or during a journey. */
function phonePad(s: ReturnType<typeof getState>) {
  const journey = s.journeyPhase !== "none" && !s.journeyInline;
  const top = journey ? 0 : 76;
  const sheet = s.pins !== null ? Math.round(window.innerHeight * 0.55)
    : journey || s.phase === "idle" ? 0 : Math.min(sheetPx(sheetSnap(s)), Math.round(window.innerHeight * 0.55));
  return { top, right: 0, bottom: (journey ? 0 : TAB_H) + sheet, left: 0 };
}

function readTheme(): Theme {
  try { return localStorage.getItem("azymut-theme") === "light" ? "light" : "dark"; } catch { return "dark"; }
}

const cruiseZoom = (s: Fly) => Math.max(1.7, Math.min(5.6, 6.1 - Math.log2(Math.max(s.km, 150) / 260)));
const nearZoom = (s: Fly) => Math.min(isGround(s.leg) ? 7.2 : 6.6, cruiseZoom(s) + 2.4);
const LEAD = 1.0; // seconds at the first airport before take-off

/** Camera over a leg at progress p (0..1): close over the airports, high in cruise, facing the flight. */
function camAt(s: Fly, p: number, heading: number) {
  const k = ease(p);
  const head = partial(s.pts, k);
  const at = head[head.length - 1];
  const shape = Math.pow(Math.sin(Math.PI * p), 0.6);
  return { center: at, zoom: nearZoom(s) + (cruiseZoom(s) - nearZoom(s)) * shape, bearing: tilt(heading), pitch: 44 - 20 * shape };
}

function colors(theme: Theme): Colors {
  const c = PALETTE[theme];
  return theme === "dark"
    ? { arc: c.arc, head: c.arcHead, ground: c.ground, dot: c.airport, halo: "#0d2347", rgb: "255,122,89", groundRgb: "160,172,195" }
    : { arc: c.arc, head: c.arcHead, ground: c.ground, dot: c.airport, halo: "#fffdfa", rgb: "228,105,78", groundRgb: "150,140,128" };
}

const idle = (map: MLMap, ms: number) => new Promise<void>((res) => {
  const done = () => { clearTimeout(tm); map.off("idle", done); res(); };
  const tm = setTimeout(done, ms);
  map.on("idle", done);
});

/** Rounded price-pill bitmap (2x) with a soft drop shadow, for the stretchable "pill" icon. */
function pillImage(fill: string, shadow: number): ImageData {
  const W = 80, H = 64, cv = document.createElement("canvas");
  cv.width = W; cv.height = H;
  const g = cv.getContext("2d")!;
  g.shadowColor = `rgba(60, 40, 20, ${shadow})`; g.shadowBlur = 10; g.shadowOffsetY = 3;
  g.fillStyle = fill;
  g.beginPath(); g.roundRect(12, 10, W - 24, H - 26, (H - 26) / 2); g.fill();
  return g.getImageData(0, 0, W, H);
}

/** Mix a hex color with white (readable rank colors on the dark price pills). */
const lighten = (hex: string, k: number) => "#" + [1, 3, 5].map((i) => Math.round(parseInt(hex.slice(i, i + 2), 16) * (1 - k) + 255 * k).toString(16).padStart(2, "0")).join("");

const esc = (t: string) => t.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);
/** Rounded airport badge: IATA pill + city. */
const apBadge = (code: string, small = false) => `<span class="ap-badge${small ? " small" : ""}" data-code="${code}"><span class="iata">${code}</span><span class="cty">${esc(cityOf(code))}</span></span>`;
/** Connection badge under an airport: clock for a connection, bed for a stopover, bus for a change of airport. */
function connBadges(trip: Trip, i: number): string {
  const c = connBefore(trip, i);
  if (!c || c.kind === "turn") return "";
  const out = [`<span class="conn-badge${c.kind === "stay" ? " stay" : ""}">${svg(c.kind === "stay" ? "bed" : "clock")}${esc(c.kind === "stay" ? c.title : tr("Przesiadka {dur}", { dur: c.title.split(" · ")[1] }))}</span>`];
  for (const ch of c.chips) if (ch.icon === "ticket" || ch.icon === "bus" || ch.icon === "shield") out.push(`<span class="conn-badge${ch.tone === "warn" ? " warn" : ch.tone === "ok" ? " ok" : ""}">${svg(ch.icon)}${esc(ch.label)}</span>`);
  return out.join("");
}

/** Overlays live in the style; they are re-added after a theme switch with the data they last had. */
class EarthController {
  private data: Record<string, FC> = { airports: EMPTY, pins: EMPTY };
  private lastPins: unknown = null;
  private pinsFramed = false;
  private journey: { trip: Trip; key: number; segs: Seg[]; t0: number; done: number; final: boolean; heading: number } | null = null;
  private arcs: ArcCanvas;
  private preloadKey = -1;           // journey whose tiles are being loaded (camera paused meanwhile)
  private readyUntil = Infinity;     // journey time up to which every tile is in the cache
  private wasDrawing = false;
  private markers: maplibregl.Marker[] = [];
  private pauseMarker: maplibregl.Marker | null = null;
  private preview: { trip: Trip; key: string } | null = null;
  private lastRest: string | null = null;
  private previewMarkers: maplibregl.Marker[] = [];
  private previewBy = new Map<string, { mk: maplibregl.Marker; el: HTMLElement; rank: number }>();
  private lastFocus: number | null = null;
  private lastInteract = 0;
  private lastPhase = "";
  private lastLive = 0;
  private raf = 0;
  private unsub: () => void;
  private prevT = performance.now();

  constructor(private map: MLMap, private theme: Theme, private onVeil: (p: number | null) => void) {
    this.arcs = new ArcCanvas(map);
    map.on("style.load", () => this.addOverlays());
    // the overlay is drawn right after every map frame, with the camera that frame used
    map.on("render", () => this.drawOverlay());
    for (const ev of ["mousedown", "touchstart", "wheel", "dragstart"] as const) map.on(ev, () => (this.lastInteract = performance.now()));
    // a click on a route leg highlights it in the timeline (and here)
    map.on("click", (e) => {
      if (!this.preview) return;
      const i = this.arcs.hit(e.point.x, e.point.y);
      if (i !== null) setState((s) => ({ focusLeg: s.focusLeg === i ? null : i, panelOpen: true }));
    });
    this.unsub = subscribe(() => this.onState());
    const loop = () => { this.frame(); this.raf = requestAnimationFrame(loop); };
    this.raf = requestAnimationFrame(loop);
  }

  destroy() { cancelAnimationFrame(this.raf); this.unsub(); this.clearMarkers(); this.clearPreview(); this.arcs.destroy(); }

  setTheme(theme: Theme) {
    this.theme = theme;
    this.map.setStyle(mapStyle(theme), { diff: false });
    this.lastPins = null; // pin label colors depend on the theme
    this.onState();
  }

  private addOverlays() {
    const m = this.map, c = PALETTE[this.theme];
    for (const [id, fc] of Object.entries(this.data)) if (!m.getSource(id)) m.addSource(id, { type: "geojson", data: fc });
    if (!m.getLayer("airport-codes")) m.addLayer({ id: "airport-codes", type: "symbol", source: "airports",
      layout: { "text-field": ["get", "code"], "text-font": ["Noto Sans Bold"], "text-size": 11.5, "text-letter-spacing": 0.08, "text-offset": [0, -1.1], "text-anchor": "bottom", "text-padding": 2 },
      paint: { "text-color": c.airportText, "text-halo-color": c.halo, "text-halo-width": 1.4 } });
    // "gdziekolwiek tanio" price pins: GL layers (cheap at 60 fps), cheapest drawn on top and kept on collisions
    if (!m.getLayer("pin-price")) {
      // Airbnb-style price pill: a stretchable rounded rectangle with a soft shadow, sized to the text
      if (!m.hasImage("pill")) m.addImage("pill", pillImage(this.theme === "dark" ? "#1a2436" : "#fffdfa", this.theme === "dark" ? 0.45 : 0.16), {
        pixelRatio: 2, stretchX: [[34, 46]], stretchY: [[28, 30]], content: [22, 14, 58, 44],
      });
      m.addLayer({ id: "pin-price", type: "symbol", source: "pins",
        layout: { "text-field": ["get", "label"], "text-font": ["Noto Sans Bold"], "text-size": 12, "text-max-width": 30, "text-anchor": "center",
          "icon-image": "pill", "icon-text-fit": "both", "icon-text-fit-padding": [3, 9, 3, 9],
          "symbol-sort-key": ["get", "price"], "text-padding": 2, "icon-padding": 0 },
        paint: { "text-color": ["get", "color"], "icon-opacity": ["case", ["get", "verified"], 1, 0.75], "text-opacity": ["case", ["get", "verified"], 1, 0.7] } });
      const pick = (e: maplibregl.MapLayerMouseEvent) => { const code = e.features?.[0]?.properties?.code; if (code) setState({ pinPick: code as string }); };
      m.on("click", "pin-price", pick);
      for (const id of ["pin-price"]) {
        m.on("mouseenter", id, () => (m.getCanvas().style.cursor = "pointer"));
        m.on("mouseleave", id, () => (m.getCanvas().style.cursor = ""));
      }
    }
  }

  private set(id: string, fc: FC) {
    this.data[id] = fc;
    (this.map.getSource(id) as GeoJSONSource | undefined)?.setData(fc);
  }

  private onState() {
    const s = getState();
    // the globe centres in the free area: below the form, left of the results panel (desktop).
    // Set before any camera move below, so fitBounds uses it; animated only when nothing else moves.
    const wide = window.innerWidth > 900;
    const anyList = s.pins !== null && s.journeyPhase === "none";
    const calm = s.journeyPhase === "none" || s.journeyInline; // the form and the list are on screen
    const panel = wide && calm && (s.phase !== "idle" || anyList) && s.panelOpen;
    // phone: the globe sits in the free area between the search pill and the sheet over the tab bar
    // (the "gdziekolwiek tanio" sheet covers the lower ~58%)
    const pad = isPhone() ? phonePad(s)
      : { top: wide && calm ? 150 : 0, right: panel ? 460 : 0, bottom: !wide && anyList && s.panelOpen ? Math.round(window.innerHeight * 0.55) : 0, left: 0 };
    // phone: a route about to be framed (a picked trip, a finished search) needs the new padding now —
    // its fitBounds would cancel an easing padding half way and leave the route off centre
    const pvNext = s.journeyPhase === "none" && !s.pins && s.selected !== null ? s.result?.trips[s.selected] ?? null : null;
    const reframe = isPhone() && ((pvNext ? `${pvNext.id}|${s.selected}` : "") !== (this.preview?.key ?? "")
      || (s.phase === "done" ? s.result?.trips[0]?.id ?? null : null) !== this.lastRest);
    const cur = this.map.getPadding();
    if (cur.top !== pad.top || cur.right !== pad.right || cur.bottom !== pad.bottom) {
      if (reframe || this.map.isMoving() || s.phase !== this.lastPhase || (!!s.pins && !this.lastPins)) this.map.setPadding(pad);
      else this.map.easeTo({ padding: pad, duration: 700 });
    }
    // the resting route of a finished search appears (or changes) without a camera move
    const restId = s.phase === "done" ? s.result?.trips[0]?.id ?? null : null;
    if (restId !== this.lastRest) {
      this.lastRest = restId;
      this.map.triggerRepaint();
      // phone: the whole finished route in view, zoomed out enough for the arcs to rise over the globe
      const t = restId && isPhone() && !s.destPins && !s.pins ? s.result?.trips[0] : null;
      if (t) {
        const pts = t.legs.flatMap((l) => greatCircle(l.from, l.to, 24));
        const b = new maplibregl.LngLatBounds(pts[0], pts[0]);
        for (const p of pts) b.extend(p);
        this.map.fitBounds(b, { padding: { top: 40, bottom: 40, left: 36, right: 36 }, maxZoom: PHONE_ZOOM, pitch: 0, bearing: 0, duration: 1400, essential: true });
      }
    }
    if (s.phase !== this.lastPhase) {
      this.lastPhase = s.phase;
      if (s.phase === "searching" && s.params) this.frameAirports([...s.params.origin, ...s.params.dest.slice(0, 10)]);
    }
    const pins = s.journeyPhase === "none" ? s.pins ?? (s.selected === null ? s.destPins : null) : null;
    if (pins !== this.lastPins) {
      const fresh = !!pins?.length && !this.pinsFramed;
      if (fresh) this.pinsFramed = true;
      if (!pins) this.pinsFramed = false;
      this.lastPins = pins;
      this.set("pins", { type: "FeatureCollection", features: (pins ?? []).filter((p) => AIRPORT_POS[p.code]).map((p) =>
        point([AIRPORT_POS[p.code].lon, AIRPORT_POS[p.code].lat], { ...p, color: this.theme === "dark" ? lighten(p.color, 0.45) : p.color, label: `${p.name ? `${p.name} · ` : ""}${Math.round(p.price).toLocaleString(locale())} zł` })) });
      if (fresh && s.pins) this.map.easeTo({ center: [10, 22], zoom: wide ? 1.45 : 0.75, padding: pad, duration: 1200 });
      else if (fresh && pins) this.frameAirports([...(s.params?.origin.slice(0, 1) ?? []), ...pins.map((p) => p.code)]);
    }
    const trip = s.selected !== null ? s.result?.trips[s.selected] : null;
    if (trip && s.journeyPhase !== "none" && (!this.journey || this.journey.key !== s.journeyKey)) this.startJourney(trip, s.journeyKey);
    if (s.journeyPhase === "none" && this.journey) this.endJourney();
    else if (this.journey && s.selected === null) setState({ journeyPhase: "none" }); // the list moved on (another view, a filter)
    // preview: the selected trip drawn in full, with airport and connection badges
    const pv = s.journeyPhase === "none" && !s.pins && s.selected !== null ? s.result?.trips[s.selected] ?? null : null;
    const key = pv ? `${pv.id}|${s.selected}` : "";
    if ((this.preview?.key ?? "") !== key) { if (pv) this.showPreview(pv, key); else this.clearPreview(); }
    if (s.focusLeg !== this.lastFocus) {
      this.lastFocus = s.focusLeg;
      const leg = pv && s.focusLeg !== null ? pv.legs[s.focusLeg] : null;
      for (const [code, m] of this.previewBy) {
        m.el.querySelector(".ap-badge")?.classList.toggle("on", !!leg && [leg.from, leg.to].includes(code));
        m.el.querySelectorAll(".conn-badge").forEach((b) => b.remove());
      }
      // the focused leg's connections: before it (at its departure) and after it (at its arrival)
      if (pv && leg && s.focusLeg !== null) {
        const before = connBadges(pv, s.focusLeg), after = connBadges(pv, s.focusLeg + 1);
        if (before) this.previewBy.get(leg.from)?.el.insertAdjacentHTML("beforeend", before);
        if (after) this.previewBy.get(leg.to)?.el.insertAdjacentHTML("beforeend", after);
      }
      if (leg) {
        const pts = greatCircle(leg.from, leg.to, 32);
        const b = new maplibregl.LngLatBounds(pts[0], pts[0]);
        for (const p of pts) b.extend(p);
        this.map.fitBounds(b, { padding: isPhone() ? 36 : 90, maxZoom: isPhone() ? PHONE_ZOOM + 1 : 6, duration: 1100, essential: true });
      }
      this.map.triggerRepaint();
    }
  }

  private showPreview(trip: Trip, key: string) {
    this.clearPreview();
    this.preview = { trip, key };
    const codes = [...new Set(trip.legs.flatMap((l) => [l.from, l.to]))].filter((c) => AIRPORT_POS[c]);
    const ends = new Set([trip.legs[0].from, trip.legs.filter((l) => l.dir === "out").at(-1)?.to ?? ""]);
    for (const c of codes) {
      const a = AIRPORT_POS[c];
      const el = document.createElement("div");
      el.className = "badge-stack";
      el.innerHTML = apBadge(c, !ends.has(c));
      const mk = new maplibregl.Marker({ element: el, anchor: "top-left", offset: [10, -12], subpixelPositioning: true, opacityWhenCovered: "0" }).setLngLat([a.lon, a.lat]).addTo(this.map);
      this.previewMarkers.push(mk);
      this.previewBy.set(c, { mk, el, rank: ends.has(c) ? 2 : 1 });
    }
    const pts = trip.legs.flatMap((l) => greatCircle(l.from, l.to, 24));
    const b = new maplibregl.LngLatBounds(pts[0], pts[0]);
    for (const p of pts) b.extend(p);
    const wide = window.innerWidth > 900;
    // phone: the camera padding already keeps the pill and the sheet free; a margin around the route
    this.map.fitBounds(b, { padding: wide ? { top: 90, bottom: 70, left: 70, right: 150 } : isPhone() ? { top: 40, bottom: 40, left: 36, right: 110 } : { top: 70, bottom: getState().panelOpen ? Math.round(window.innerHeight * 0.5) : 90, left: 30, right: 90 }, maxZoom: isPhone() ? PHONE_ZOOM : 5, pitch: 0, bearing: 0, duration: 1600, essential: true });
    this.lastFocus = null;
  }

  private clearPreview() {
    for (const mk of this.previewMarkers) mk.remove();
    this.previewMarkers = [];
    this.previewBy.clear();
    this.preview = null;
    this.map.triggerRepaint();
  }

  private frameAirports(codes: string[]) {
    const pts = codes.filter((c) => AIRPORT_POS[c]).map((c) => [AIRPORT_POS[c].lon, AIRPORT_POS[c].lat] as LngLat);
    if (!pts.length) return;
    const b = new maplibregl.LngLatBounds(pts[0], pts[0]);
    for (const p of pts) b.extend(p);
    const narrow = window.innerWidth < 720;
    this.map.fitBounds(b, { padding: narrow ? 30 : { top: 60, bottom: 60, left: 60, right: 60 }, maxZoom: isPhone() ? PHONE_ZOOM : 4, duration: 2400, essential: true, pitch: 0, bearing: 0 });
  }

  /** Search visualisation: every route asked about stays as a low line of the growing network; the
   *  newest ones (asked in the last ~2 s) fly as comets at full height; the best route glows on top. */
  private liveDraws(now: number): LiveDraw[] {
    const out: LiveDraw[] = [];
    for (const a of liveArcs.values()) {
      const age = (now - a.t) / 1000;
      if (a.state === "best") {
        const geom = arcGeom(a.from, a.to, 1);
        if (geom) out.push({ geom, state: "best", alpha: Math.min(1, 0.35 + age * 0.8), phase: (a.key.charCodeAt(0) % 7) / 7, from: a.from, to: a.to });
        continue;
      }
      if (a.state === "checking" && age < 2.2) {
        const geom = arcGeom(a.from, a.to, 1);
        if (geom) out.push({ geom, state: "checking", alpha: Math.max(0, 1 - Math.max(0, age - 1.6) / 0.6), phase: age / 1.1, from: a.from, to: a.to });
      }
      // the network line appears as the comet lands and stays (brighter for a few seconds after)
      if (a.state === "checking" && age < 1.1) continue;
      const geom = arcGeom(a.from, a.to, 0.5, 40);
      if (geom) out.push({ geom, state: a.state, alpha: Math.max(0, 1 - age / 6), phase: 0, net: true, from: a.from, to: a.to });
    }
    return out;
  }

  /** Hides preview badges that would overlap a more important one (endpoints and the focused leg first). */
  private declutter() {
    if (!this.previewBy.size) return;
    const f = getState().focusLeg, leg = f !== null ? this.preview?.trip.legs[f] : null;
    const items = [...this.previewBy.entries()].map(([code, m]) => {
      const pt = this.map.project(m.mk.getLngLat());
      const w = m.el.offsetWidth || 90, h = m.el.offsetHeight || 26;
      return { m, x: pt.x + 10, y: pt.y - 12, w, h, rank: m.rank + (leg && (leg.from === code || leg.to === code) ? 5 : 0) };
    }).sort((a, b) => b.rank - a.rank);
    const kept: typeof items = [];
    for (const it of items) {
      const hit = kept.some((k) => it.x < k.x + k.w + 4 && k.x < it.x + it.w + 4 && it.y < k.y + k.h + 2 && k.y < it.y + it.h + 2);
      it.m.el.style.opacity = hit ? "0" : "";
      it.m.el.style.pointerEvents = hit ? "none" : "";
      if (!hit) kept.push(it);
    }
  }

  /** Draws the arcs for the frame the map just rendered. */
  private drawOverlay() {
    this.declutter();
    const now = performance.now();
    const j = this.journey;
    const pv = !j && this.preloadKey < 0 ? this.preview : null;
    const st = getState();
    // the network grows during every search, also one over several cities (their price pins stay on top)
    const live = !j && !pv && this.preloadKey < 0 && liveArcs.size > 0 && st.phase === "searching";
    // a finished search with nothing selected: its cheapest route rests on the globe
    const rest = !j && !pv && !live && this.preloadKey < 0 && st.phase === "done" && !st.destPins && !st.pins ? st.result?.trips[0] ?? null : null;
    if (!j && !live && !pv && !rest) { if (this.wasDrawing) { this.arcs.clear(); this.wasDrawing = false; } return; }
    if (!this.arcs.begin()) return;
    this.arcs.bend = isPhone() ? 0.17 : 0;
    this.wasDrawing = true;
    const c = colors(this.theme);
    if (live) { this.arcs.live(this.liveDraws(now), c, now); return; }
    if (rest) {
      const legs: LegDraw[] = rest.legs.map((l) => ({ geom: arcGeom(l.from, l.to, isGround(l) ? 0 : 1)!, ground: isGround(l), progress: 1, active: false })).filter((l) => l.geom);
      this.arcs.legs(legs, c, now);
      this.arcs.airports([...new Set(rest.legs.flatMap((l) => [l.from, l.to]))], c, now);
      return;
    }
    if (pv) {
      const f = getState().focusLeg;
      const legs: LegDraw[] = pv.trip.legs.map((l, i) => ({ geom: arcGeom(l.from, l.to, isGround(l) ? 0 : 1)!, ground: isGround(l), progress: 1, active: false, idx: i, focus: f === i, dim: f !== null && f !== i })).filter((l) => l.geom);
      this.arcs.legs(legs, c, now);
      const fl = f !== null ? pv.trip.legs[f] : null;
      this.arcs.airports([...new Set(pv.trip.legs.flatMap((l) => [l.from, l.to]))], c, now, fl?.to);
      return;
    }
    if (!j || this.preloadKey >= 0) return;
    const t = (now - j.t0) / 1000;
    const flights = j.segs.filter((s): s is Fly => s.kind === "fly");
    const final = t >= j.segs[j.segs.length - 1].start;
    let activeCode: string | undefined;
    const legs: LegDraw[] = [];
    for (const s of flights) {
      if (!s.geom) continue;
      const raw = final ? 1 : Math.min(1, Math.max(0, (t - s.start) / s.dur));
      const active = raw > 0 && raw < 1;
      if (active) activeCode = raw < 0.5 ? s.leg.from : s.leg.to;
      legs.push({ geom: s.geom, ground: isGround(s.leg), progress: ease(raw), active });
    }
    if (!activeCode) {
      const pause = j.segs.find((s) => s.kind === "pause" && t >= s.start && t < s.start + s.dur) as Extract<Seg, { kind: "pause" }> | undefined;
      activeCode = pause?.leg.to ?? (t < flights[0].start ? flights[0].leg.from : undefined);
    }
    this.arcs.legs(legs, c, now);
    const codes = [...new Set(j.trip.legs.flatMap((l) => [l.from, l.to]))];
    this.arcs.airports(codes, c, now, activeCode);
  }

  /** A label pinned to the globe. The marker positions its element with a transform, so the card
   *  (which animates its own transform when it appears) sits inside a wrapper. */
  private card(html: string, cls: string, at: LngLat, left = false) {
    const wrap = document.createElement("div");
    const el = document.createElement("div");
    el.className = cls;
    el.innerHTML = html;
    wrap.appendChild(el);
    return new maplibregl.Marker({ element: wrap, anchor: left ? "top-right" : "top-left", offset: left ? [-14, 12] : [12, 10], subpixelPositioning: true, opacityWhenCovered: "0" }).setLngLat(at).addTo(this.map);
  }

  private clearMarkers() {
    for (const mk of this.markers) mk.remove();
    this.markers = [];
    this.pauseMarker?.remove();
    this.pauseMarker = null;
  }

  private startJourney(trip: Trip, key: number) {
    this.endJourney(false);
    const segs = timeline(trip);
    const codes = [...new Set(trip.legs.flatMap((l) => [l.from, l.to]))].filter((c) => AIRPORT_POS[c]);
    const first = segs.find((s): s is Fly => s.kind === "fly")!;
    const heading = bearing(first.pts[0], first.pts[Math.min(8, first.pts.length - 1)]);
    this.journey = { trip, key, segs, t0: Infinity, done: 0, final: false, heading };
    setState({ journeyPhase: "flying", journeyTotal: 0 });
    void this.preload(segs, key, heading).then((ok) => {
      if (!ok || !this.journey || this.journey.key !== key) return;
      this.map.jumpTo(camAt(first, 0, heading));
      this.journey.t0 = performance.now() - (first.start - LEAD) * 1000;
    });
  }

  /** Loads every map tile the journey camera will show into the browser cache (behind a veil), so
   *  nothing comes from the network while the camera flies. The camera path is simulated with the
   *  same timeline; at each position the tiles around the centre are fetched at the tile zoom and the
   *  two coarser levels the globe shows towards the horizon. */
  private async preload(segs: Seg[], key: number, heading: number): Promise<boolean> {
    const map = this.map;
    this.preloadKey = key;
    this.onVeil(0);
    const vec = (map.getSource("omt") as unknown as { tiles?: string[] } | undefined)?.tiles?.[0];
    const urls = new Map<string, number>(); // tile -> journey time it is first on screen
    let when = 0;
    const add = (tpl: string, z: number, x: number, y: number) => {
      const n = 2 ** z;
      if (y < 0 || y >= n) return;
      const u = tpl.replace("{z}", String(z)).replace("{x}", String(((x % n) + n) % n)).replace("{y}", String(y));
      if (!urls.has(u)) urls.set(u, when);
    };
    const around = (lon: number, lat: number, zoom: number) => {
      const la = Math.max(-85, Math.min(85, lat)) * R;
      const tile = (z: number) => [Math.floor(((lon + 180) / 360) * 2 ** z), Math.floor(((1 - Math.log(Math.tan(la) + 1 / Math.cos(la)) / Math.PI) / 2) * 2 ** z)];
      const tz = Math.max(0, Math.floor(zoom));
      for (const [tpl, base, r, max, levels] of [[vec, tz, 2, 14, 1]] as [string | undefined, number, number, number, number][]) {
        if (!tpl) continue;
        for (let dz = 0; dz <= levels; dz++) {
          const z = Math.min(max, base - dz);
          if (z < 0) continue;
          const [cx, cy] = tile(z);
          for (let dx = -r; dx <= r; dx++) for (let dy = -r - 1; dy <= r; dy++) add(tpl, z, cx + dx, cy + dy);
        }
      }
    };
    // the camera path, sampled every 0.2 s of animation
    const flights = segs.filter((s): s is Fly => s.kind === "fly");
    let h = heading;
    for (const s of flights) {
      const n = Math.max(2, Math.ceil(s.dur / 0.2));
      for (let i = 0; i <= n; i++) {
        const p = i / n;
        const pts = partial(s.pts, ease(p));
        const a = pts[pts.length - 1], b = s.pts[Math.min(s.pts.length - 1, Math.round(ease(p) * (s.pts.length - 1)) + 6)];
        if (a[0] !== b[0] || a[1] !== b[1]) h = bearing(a, b);
        const c = camAt(s, p, h);
        when = s.start + p * s.dur;
        around(c.center[0], c.center[1], c.zoom);
      }
    }
    const all = flights.flatMap((s) => s.pts);
    const bounds = new maplibregl.LngLatBounds(all[0], all[0]);
    for (const p of all) bounds.extend(p);
    const fin = map.cameraForBounds(bounds, { padding: { top: 140, bottom: 200, left: 80, right: 80 }, maxZoom: 5 });
    when = segs[segs.length - 1].start;
    if (fin?.center && fin.zoom !== undefined) {
      const c = maplibregl.LngLat.convert(fin.center);
      around(c.lng, c.lat, fin.zoom);
      for (const p of all.filter((_, i) => i % 20 === 0)) around(p[0], p[1], fin.zoom);
    }
    // Fetch in the order the camera needs the tiles. The veil lifts once the first seconds are in;
    // the rest keeps loading ahead of the camera, and the journey clock waits if loading falls behind.
    const list = [...urls.entries()].sort((a, b) => a[1] - b[1]);
    const ok = new Uint8Array(list.length);
    let next = 0, low = 0;
    const t0 = performance.now();
    this.readyUntil = list.length ? -Infinity : Infinity;
    const advance = () => {
      while (low < list.length && ok[low]) low++;
      this.readyUntil = low < list.length ? list[low][1] : Infinity;
    };
    const worker = async () => {
      while (next < list.length && this.journey?.key === key) {
        const i = next++;
        await fetch(list[i][0], { mode: "cors" }).then((r) => r.arrayBuffer()).catch(() => null);
        ok[i] = 1;
        advance();
      }
    };
    const loading = Promise.all(Array.from({ length: 24 }, worker)); // HTTP/2: many requests share one connection
    const startAt = flights[0].start + 2;
    while (this.preloadKey === key && this.readyUntil < startAt && performance.now() - t0 < 8_000) {
      this.onVeil(Math.min(1, Math.max(0, this.readyUntil) / startAt));
      await new Promise((r) => setTimeout(r, 100));
    }
    void loading.then(() => Object.assign(window as object, { __preload: { urls: list.map((x) => x[0]), ms: Math.round(performance.now() - t0) } }));
    if (this.preloadKey !== key) return false;
    // the first view is decoded and drawn before the veil lifts
    map.jumpTo(camAt(flights[0], 0, heading));
    await idle(map, 2500);
    if (this.preloadKey !== key) return false;
    this.preloadKey = -1;
    this.onVeil(null);
    return true;
  }

  private endJourney(reset = true) {
    if (this.preloadKey >= 0) { this.preloadKey = -1; this.onVeil(null); }
    this.readyUntil = Infinity;
    if (!this.journey) return;
    this.journey = null;
    this.clearMarkers();
    this.set("airports", EMPTY);
    this.map.triggerRepaint();
    if (reset) this.map.easeTo({ pitch: 0, bearing: 0, duration: 900 });
  }

  private frame() {
    const now = performance.now();
    const dt = Math.min(0.05, (now - this.prevT) / 1000);
    this.prevT = now;
    const j = this.journey;
    const map = this.map;
    if (this.preloadKey >= 0) return;
    if (!j && liveArcs.size && getState().phase === "searching") map.triggerRepaint(); // animated live arcs
    if (!j) {
      const s = getState();
      // slow drift while nobody touches the globe
      if (now - this.lastInteract > 6000 && (s.phase === "idle" || s.phase === "done") && s.selected === null && !s.destPins && !map.isMoving() && map.getZoom() < 3.2) {
        const c = map.getCenter();
        map.jumpTo({ center: [c.lng + 2.2 * dt, c.lat] });
      }
      return;
    }
    let t = (now - j.t0) / 1000;
    map.triggerRepaint(); // pulsing airports and the plane need a frame even when the camera rests
    if (!(t >= 0)) return; // tiles still loading
    // never fly into tiles that are not loaded yet: hold the clock until the loader is ahead again
    if (t > this.readyUntil - 1) { j.t0 += dt * 1000; t = (now - j.t0) / 1000; }
    const flights = j.segs.filter((s): s is Fly => s.kind === "fly");
    let done = 0, total = 0;
    let active: Fly | null = null, activeP = 0;
    for (const s of flights) {
      const raw = Math.min(1, Math.max(0, (t - s.start) / s.dur));
      if (raw >= 1) { done++; total += s.leg.price + (s.leg.hotel ?? 0); }
      if (raw > 0 && raw < 1) { active = s; activeP = raw; }
    }

    if (done !== j.done) {
      const leg = flights[done - 1].leg;
      const a = AIRPORT_POS[leg.to];
      for (const mk of this.markers) mk.getElement().firstElementChild?.classList.add("compact");
      const what = isGround(leg) ? (leg.source === "flixbus" ? "FlixBus" : tr("transfer lokalny")) : `${leg.carrier} ${leg.flightNo}`.trim();
      const cc = carrierCode(leg);
      const icon = cc ? `<img src="${logoUrl(cc)}" alt="" onerror="this.remove()">` : svg(isGround(leg) ? "bus" : "plane");
      this.markers.push(this.card(`<div class="full"><div class="leg-city"><span class="iata">${leg.to}</span>${esc(a.city)}</div><div class="leg-meta">${icon}${esc(what)}</div>
        <div class="leg-row"><span>${fmtTime(leg.depLocal)} → ${fmtTime(leg.arrLocal)}${leg.arrEstimated ? "*" : ""}</span><span class="leg-price">${leg.price ? fmtPln(leg.price) : tr("w cenie biletu")}</span></div></div>
        <div class="mini">${apBadge(leg.to, true)}</div>`,
        "leg-card", [a.lon, a.lat]));
      j.done = done;
      setState({ journeyTotal: total });
    }

    const pause = j.segs.find((s): s is Extract<Seg, { kind: "pause" }> => s.kind === "pause" && t >= s.start && t < s.start + s.dur);
    if (pause && !this.pauseMarker) {
      const a = AIRPORT_POS[pause.leg.to];
      const gap = (pause.next.dep - pause.leg.arr) / 3_600_000;
      // chips on the stop: [tone, text in the interface language]
      const risk: [string, string][] = [];
      if (pause.next.dir === pause.leg.dir) {
        if (pause.next.source === "flixbus" || pause.leg.source === "flixbus") risk.push(["", tr("autobus")]);
        if (pause.next.source === "local") risk.push(["", tr("zmiana lotniska")]);
        const tn = ticketOf(pause.next), tl = ticketOf(pause.leg);
        if (tn !== undefined && tl !== undefined ? tn !== tl : pause.next.price > 0 && pause.leg.price > 0) risk.push(["warn", tr("osobny bilet")]);
        else if (!isGround(pause.next) && !isGround(pause.leg)) risk.push(["ok", tr("jeden bilet")]);
        if (pause.next.hotel) risk.push(["info", tr("nocleg ~{price}", { price: fmtPln(pause.next.hotel) })]);
        if (gap < 4 && !isGround(pause.next)) risk.push(["warn", tr("krótka przesiadka")]);
      }
      const turn = pause.next.dir !== pause.leg.dir, stay = !turn && gap >= 20 && !isGround(pause.next) && !isGround(pause.leg);
      const title = turn ? tr("{city} · pobyt {n} dni", { city: esc(a.city), n: j.trip.stayDays ?? "?" }) : stay ? tr("{days} w mieście {city}", { days: days(Math.round(gap / 24) || 1), city: esc(a.city) }) : `${esc(a.city)} · ${fmtDur(gap)}`;
      const next = pause.next.price > 0 ? `<span class="pc-sub">${tr("następny odcinek {price}", { price: fmtPln(pause.next.price) })}</span>` : "";
      this.pauseMarker = this.card(`<span class="pc-title">${svg(turn ? "pin" : stay ? "bed" : "clock")}${title}</span>${next}<span class="pc-chips">${risk.map(([tone, r]) => `<span class="chip risk ${tone}">${esc(r)}</span>`).join("")}</span>`, "pause-chip", [a.lon, a.lat], true);
    } else if (!pause && this.pauseMarker) { this.pauseMarker.remove(); this.pauseMarker = null; }

    const finalSeg = j.segs[j.segs.length - 1];
    if (t >= finalSeg.start) {
      if (!j.final) {
        j.final = true;
        const all = flights.flatMap((s) => s.pts);
        const b = new maplibregl.LngLatBounds(all[0], all[0]);
        for (const p of all) b.extend(p);
        this.clearMarkers();
        // picked from the list: straight to the whole route drawn (the preview frames it beside the list), no closing card
        if (getState().journeyInline) { setTimeout(() => { if (this.journey === j) setState({ journeyPhase: "none" }); }, 600); return; }
        map.fitBounds(b, { padding: isPhone() ? { top: 90, bottom: 150, left: 36, right: 36 } : { top: 140, bottom: 200, left: 80, right: 80 }, maxZoom: isPhone() ? PHONE_ZOOM : 5, pitch: 0, bearing: 0, duration: 2800, essential: true });
        setTimeout(() => setState({ journeyPhase: "final", journeyTotal: j.trip.price }), 1800);
      }
      return;
    }
    if (active) {
      const s: Fly = active;
      const k = ease(activeP);
      const drawn = partial(s.pts, k);
      const head = drawn[drawn.length - 1];
      // camera: close over the airports at take-off and landing, high in cruise, facing the flight
      const ahead = s.pts[Math.min(s.pts.length - 1, Math.round(k * (s.pts.length - 1)) + 6)];
      const target = ahead[0] !== head[0] || ahead[1] !== head[1] ? bearing(head, ahead) : j.heading;
      j.heading = lerpAngle(j.heading, target, Math.min(1, dt * 2.5));
      map.jumpTo(camAt(s, activeP, j.heading));
    } else if (pause) {
      const a = AIRPORT_POS[pause.leg.to];
      const s = flights.find((x) => x.leg === pause.next) ?? flights[0];
      j.heading += 6 * dt;
      map.jumpTo({ center: [a.lon, a.lat], zoom: nearZoom(s), bearing: tilt(j.heading), pitch: 44 });
    }
  }
}

export default function Earth() {
  const host = useRef<HTMLDivElement>(null);
  const ctl = useRef<EarthController | null>(null);
  const [theme, setTheme] = useState<Theme>("light");
  const [noGl, setNoGl] = useState(false);
  const [veil, setVeil] = useState<number | null>(null);
  useLang(); // re-render the veil text when the language switches
  useEffect(() => {
    const th = readTheme();
    setTheme(th);
    document.documentElement.dataset.theme = th;
    const home = AIRPORT_POS[getState().params?.origin[0] ?? "POZ"];
    let map: MLMap;
    registerDemProtocol();
    try {
      map = new maplibregl.Map({
        container: host.current!, style: mapStyle(th), center: [home.lon - 18, home.lat - 6], zoom: 1.55,
        canvasContextAttributes: { antialias: true }, pixelRatio: Math.min(window.devicePixelRatio || 1, 2), maxPitch: 70,
        attributionControl: false, renderWorldCopies: false, fadeDuration: 200,
        maxTileCacheSize: 1200, maxTileCacheZoomLevels: 12, // keeps every tile the journey preload fetched
      });
    } catch (e) {
      // no WebGL (blocked GPU, old device): the app works without the globe
      console.warn("globe unavailable", e);
      setNoGl(true);
      return;
    }
    map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-right");
    map.once("idle", () => void prefetchDem());
    ctl.current = new EarthController(map, th, setVeil);
    // for screenshots / debugging (QA scripts drive live arcs through these)
    Object.assign(window as object, { __map: map, __earth: { liveArcs, touchArc, markBest, setState, getState } });
    return () => { ctl.current?.destroy(); map.remove(); };
  }, []);
  // the switch lives in the header (App); it sends the theme it wants
  useEffect(() => {
    const on = (e: Event) => apply((e as CustomEvent<Theme>).detail);
    window.addEventListener("azymut-theme", on);
    return () => window.removeEventListener("azymut-theme", on);
  });
  const apply = (next: Theme) => {
    if (next === theme) return;
    setTheme(next);
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("azymut-theme", next); } catch { /* private mode */ }
    ctl.current?.setTheme(next);
  };
  return (
    <div className="stage">
      <div ref={host} className="earth" />
      {veil !== null && (
        <div className="route-veil" role="status">
          <span>{tr("Wczytuję trasę")}</span>
          <span className="rv-bar"><i style={{ transform: `scaleX(${veil})` }} /></span>
        </div>
      )}
      {noGl && <div className="no-gl caps">{tr("globus niedostępny w tej przeglądarce (brak WebGL)")}</div>}
    </div>
  );
}
