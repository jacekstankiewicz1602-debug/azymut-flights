"use client";
// Phone: a bottom panel follows the finger down and closes past a threshold (or on a quick flick).
import { useEffect, useRef, useState } from "react";
import { isPhone } from "./store";

export function useSwipeClose(onClose: () => void) {
  const [el, ref] = useState<HTMLElement | null>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (!el || !isPhone()) return;
    type G = { y0: number; x0: number; scroller: HTMLElement | null; dragging: boolean; pts: [number, number][] };
    let g: G | null = null;
    // the nearest scrolling box under the finger: the panel moves only once it is scrolled to the top
    const scrollerOf = (t: EventTarget | null) => {
      for (let n = t as HTMLElement | null; n && n !== el; n = n.parentElement) {
        if (n.scrollHeight > n.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(n).overflowY)) return n;
      }
      return null;
    };
    const ts = (e: TouchEvent) => {
      if (e.touches.length !== 1) { g = null; return; }
      const t = e.touches[0];
      // form fields keep their own gestures
      if ((e.target as HTMLElement).closest("input, select, textarea")) { g = null; return; }
      g = { y0: t.clientY, x0: t.clientX, scroller: scrollerOf(e.target), dragging: false, pts: [[performance.now(), t.clientY]] };
    };
    const tm = (e: TouchEvent) => {
      if (!g) return;
      const t = e.touches[0];
      const dy = t.clientY - g.y0;
      g.pts.push([performance.now(), t.clientY]);
      if (g.pts.length > 6) g.pts.shift();
      if (!g.dragging) {
        if (Math.abs(dy) < 6 && Math.abs(t.clientX - g.x0) < 6) return;
        // up, sideways, or a list that still has room above: not a close gesture
        if (dy <= 0 || Math.abs(t.clientX - g.x0) > Math.abs(dy) || (g.scroller && g.scroller.scrollTop > 0)) { g = null; return; }
        g.dragging = true;
        g.y0 = t.clientY;
        el.style.animation = "none"; // an entrance animation's fill would override the transform
        el.style.transition = "none";
      }
      if (e.cancelable) e.preventDefault();
      el.style.transform = `translateY(${Math.max(0, t.clientY - g.y0)}px)`;
    };
    const te = () => {
      const d = g;
      g = null;
      if (!d?.dragging) return;
      const [t1, y1] = d.pts[d.pts.length - 1];
      const back = d.pts.filter(([t]) => t1 - t <= 100);
      const [t0, y0] = back.length > 1 ? back[0] : d.pts[0];
      const v = performance.now() - t1 > 120 || t1 <= t0 ? 0 : (y1 - y0) / (t1 - t0);
      const off = y1 - d.y0;
      el.style.transition = "transform 0.28s cubic-bezier(0.2, 0.9, 0.25, 1)";
      if (off > Math.min(120, el.offsetHeight * 0.3) || v > 0.5) {
        el.style.transform = "translateY(100%)";
        setTimeout(() => { el.style.transform = ""; el.style.transition = ""; close.current(); }, 220);
      } else {
        el.style.transform = "";
      }
    };
    el.addEventListener("touchstart", ts, { passive: true });
    el.addEventListener("touchmove", tm, { passive: false });
    el.addEventListener("touchend", te);
    el.addEventListener("touchcancel", te);
    return () => {
      el.removeEventListener("touchstart", ts); el.removeEventListener("touchmove", tm);
      el.removeEventListener("touchend", te); el.removeEventListener("touchcancel", te);
    };
  }, [el]);
  return ref;
}
