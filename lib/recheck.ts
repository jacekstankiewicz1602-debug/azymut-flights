// Before booking: every ticket of a trip priced again live (no cache), all at once, so the person sees
// whether something got more expensive (or sold out) since the search.
import type { Trip, TripLeg } from "./engine";
import { bookingFor } from "./booking";
import { flixRides } from "./sources/flixbus";
import { googleOneWay, googleRoundTrip } from "./sources/google";
import { fresh, Meter } from "./sources/http";
import { kiwiOneWay, kiwiReturn, KIWI_MAX } from "./sources/kiwi";
import { ryanairDays, wizzDays } from "./sources/lowcost";
import type { FlightOption } from "./types";

export type Recheck = { legs: { index: number; old: number; now: number | null }[]; oldTotal: number; newTotal: number | null; changed: boolean };

const within = <T,>(p: Promise<T>, ms: number): Promise<T | null> => Promise.race([p.catch(() => null), new Promise<null>((r) => setTimeout(() => r(null), ms))]);
const sameTime = (o: FlightOption, l: TripLeg) => o.depLocal.slice(0, 16) === l.depLocal.slice(0, 16);
/** The same flight when it is still there (departure time), else the cheapest on that day. */
const pick = (opts: FlightOption[] | null, l: TripLeg): number | null => {
  if (!opts?.length) return null;
  const day = opts.filter((o) => o.depLocal.slice(0, 10) === l.depLocal.slice(0, 10));
  const same = day.find((o) => sameTime(o, l));
  return same ? same.price : day.length ? Math.min(...day.map((o) => o.price)) : null;
};

export async function recheckTrip(t: Trip, pax = 1, timeoutMs = 18_000): Promise<Recheck> {
  const meter = new Meter();
  const b = bookingFor(t, pax);
  const checked = false;
  const groupPrices = await fresh(() => Promise.all(b.tickets.map(async (tk) => {
    const first = t.legs[tk.legs[0]];
    // the stretch the ticket flies (a round-trip ticket: there, and its return leg in the other direction)
    const last = { to: tk.to };
    const backLeg = tk.legs.map((i) => t.legs[i]).find((l) => l.dir !== first.dir);
    const d = tk.date;
    if (first.estimated || first.source === "estimate" || first.source === "ground" || first.source === "local") return tk.price; // estimates stay as they were
    switch (tk.source) {
      case "ryanair": return pick(await within(ryanairDays(first.from, last.to, d, d, checked, meter), timeoutMs), first);
      case "wizz": return pick(await within(wizzDays(first.from, last.to, d, d, checked, meter), timeoutMs), first);
      case "flixbus": return pick(await within(flixRides(first.from, last.to, d, meter), timeoutMs), first);
      case "kiwi": {
        // a Kiwi booking with both directions on one ticket: its return combination
        const back = backLeg;
        if (back) {
          const rts = await within(kiwiReturn([first.from], [last.to], d, d, back.depLocal.slice(0, 10), back.depLocal.slice(0, 10), meter), timeoutMs);
          if (!rts?.length) return null;
          const same = rts.find((r) => r.out[0]?.depLocal.slice(0, 16) === first.depLocal.slice(0, 16));
          return Math.round((same ?? rts[0]).price);
        }
        const its = await within(kiwiOneWay([first.from], [last.to], d, d, KIWI_MAX, meter), timeoutMs);
        if (!its?.length) return null;
        const same = its.find((it) => it.segs[0]?.depLocal.slice(0, 16) === first.depLocal.slice(0, 16));
        return Math.round((same ?? its[0]).price);
      }
      default: {
        // Google: a round-trip ticket (its return leg rides at 0 on the same link) or a one-way search
        const back = backLeg ?? t.legs.find((l, i) => i > tk.legs[tk.legs.length - 1] && l.price - (l.bag ?? 0) === 0 && l.link === first.link && l.from === last.to);
        if (back) {
          const rt = await within(googleRoundTrip([first.from], [last.to], d, back.depLocal.slice(0, 10), meter), timeoutMs);
          return rt ? rt.price : null;
        }
        return pick(await within(googleOneWay(first.from, last.to, d, meter), timeoutMs), first);
      }
    }
  })));
  const legs: Recheck["legs"] = [];
  b.tickets.forEach((tk, k) => tk.legs.forEach((i, j) => legs.push({ index: i, old: t.legs[i].price, now: groupPrices[k] === null ? null : j === 0 ? groupPrices[k] : 0 })));
  legs.sort((a, c) => a.index - c.index);
  const oldTickets = b.tickets.reduce((s, tk) => s + tk.price, 0);
  const newTotal = groupPrices.some((x) => x === null) ? null : Math.round(t.price - oldTickets + groupPrices.reduce((s: number, x) => s + (x ?? 0), 0));
  return { legs, oldTotal: t.price, newTotal, changed: newTotal === null || Math.abs(newTotal - t.price) >= 1 };
}
