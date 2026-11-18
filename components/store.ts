"use client";
// Tiny external store shared by the DOM overlay and the three.js scene.
import { useSyncExternalStore } from "react";
import type { SearchResult, Trip } from "@/lib/engine";
import type { SearchParams } from "@/lib/types";

export type ArcState = "checking" | "ok" | "rejected" | "best";
export type LiveArc = { key: string; from: string; to: string; state: ArcState; t: number };

export type Stats = { paid: number; free: number; costUsd: number; checked: number; pruned: number; best: number | null };

export type State = {
  phase: "idle" | "parsing" | "searching" | "done" | "error";
  message: string;
  params: SearchParams | null;
  parseVia: string | null;
  problems: string[];
  sources: { serpapi: boolean; duffel: boolean; llm: boolean } | null;
  stats: Stats;
  best: Trip | null;
  result: SearchResult | null;
  selected: number | null;
  journeyKey: number;       // bump to (re)start the flight animation
  journeyPhase: "none" | "flying" | "final";
  /** the flight plays beside the open results and form (picked from the list), not full screen */
  journeyInline: boolean;
  journeyTotal: number;     // running price counter
  panelOpen: boolean;
  /** Phone: how far the results sheet is pulled up while open (closed = peek). */
  sheet: "half" | "full";
  live: {
    gap: number | null; lowerBound: number | null; elapsed: number; steps: number; status: string;
    runner?: string; worker?: { online: boolean; busyWith?: string | null } | null;
    extended?: number | null; // minutes added when a quick search went on in the background (set by the worker)
    deep?: { round: number; chunk: number; chunks: [string, string][]; proven: boolean[] } | null;
  } | null;
  calendar: Record<string, number>; // lowest Google price per departure day seen in the date picker
  /** "gdziekolwiek tanio z Polski": price pins on the globe (null = feature closed) and the picked one */
  pins: Pin[] | null;
  pinPick: string | null;
  /** region search: one price pin per destination city ("Kierunki" view) */
  destPins: Pin[] | null;
  /** leg highlighted in the timeline and on the globe (index into the selected trip's legs) */
  focusLeg: number | null;
  /** expected durations of the search, from similar past searches */
  estimate: { quickSec: number; fullSec: number; samples: number } | null;
  /** live query feed (newest last) */
  feed: FeedLine[];
};
import type { FeedLine } from "./feed";
export type Pin = { code: string; price: number; color: string; deal: boolean; verified: boolean; name?: string };

const initial: State = {
  phase: "idle", message: "", params: null, parseVia: null, problems: [], sources: null,
  stats: { paid: 0, free: 0, costUsd: 0, checked: 0, pruned: 0, best: null },
  best: null, result: null, selected: null, journeyKey: 0, journeyPhase: "none", journeyInline: false, journeyTotal: 0, panelOpen: true, sheet: "half", live: null, calendar: {}, pins: null, pinPick: null, destPins: null, focusLeg: null, estimate: null, feed: [],
};

let state: State = initial;
const subs = new Set<() => void>();
export const getState = () => state;
export function setState(patch: Partial<State> | ((s: State) => Partial<State>)) {
  state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) };
  subs.forEach((f) => f());
}
export function resetSearch() {
  setState({ ...initial, panelOpen: state.panelOpen, sources: state.sources, calendar: state.calendar });
  liveArcs.clear();
}
export function subscribe(f: () => void) { subs.add(f); return () => { subs.delete(f); }; }
export function useStore<T>(sel: (s: State) => T): T {
  return useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => sel(state), () => sel(initial));
}

// Live search arcs live outside React state: the scene reads them every frame.
export const liveArcs = new Map<string, LiveArc>();
export function touchArc(from: string, to: string, st: ArcState) {
  const key = from + to;
  const cur = liveArcs.get(key);
  if (cur && cur.state === "best" && st !== "best") return;
  liveArcs.set(key, { key, from, to, state: st, t: performance.now() });
  if (liveArcs.size > 420) {
    const oldest = [...liveArcs.values()].filter((a) => a.state !== "best").sort((a, b) => a.t - b.t)[0];
    if (oldest) liveArcs.delete(oldest.key);
  }
}
export function markBest(nodes: string[]) {
  for (const a of liveArcs.values()) if (a.state === "best") { a.state = "ok"; a.t = performance.now(); }
  for (let i = 0; i < nodes.length - 1; i++) if (nodes[i] !== nodes[i + 1]) touchArc(nodes[i], nodes[i + 1], "best");
}

// ---------------------------------------------------------------- phone layout

/** Phone layout below this width (the desktop layout is untouched above it). */
export const PHONE_MAX = 720;
export const isPhone = () => typeof window !== "undefined" && window.innerWidth <= PHONE_MAX;
export function useIsPhone(): boolean {
  return useSyncExternalStore((f) => { window.addEventListener("resize", f); return () => window.removeEventListener("resize", f); }, isPhone, () => false);
}
/** Bottom tab bar and the collapsed sheet (px, above the safe area). */
export const TAB_H = 60;
export const PEEK_H = 116;
/** Phone: the sheet's snap position for a state (closed panel = peek). */
export const sheetSnap = (s: Pick<State, "panelOpen" | "sheet">): "peek" | "half" | "full" => (!s.panelOpen ? "peek" : s.sheet);
export const sheetPx = (snap: "peek" | "half" | "full") => (snap === "peek" ? PEEK_H : snap === "half" ? Math.round(window.innerHeight * 0.5) : window.innerHeight);
