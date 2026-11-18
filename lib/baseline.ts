// The Google Flights baseline: the cheapest ordinary offer for the same search (every departure
// airport in range, the same date window, the same trip type). It is both the comparison shown with
// the result and a candidate trip, so a result is never more expensive than Google.
//
// Google's date graph (GetCalendarGraph) picks the cheapest dates per departure airport (it answers
// only for routes Google has fares cached for; small airports often return nothing). The candidate
// dates (graph minima plus the dates of the best trips found so far) are then priced on Google's
// result page with all departure and destination airports at once, which is what a person searching
// Google Flights would see. When that fails: retries, then one request per departure airport, and
// as a last resort Kiwi's cheapest bookable combination for the same window.
import { AP } from "./airports";
import { googleOneWayCheapest, googleOwGrid, googleRoundTrip, googleRtGrid, type GResult } from "./sources/google";
import type { Meter } from "./sources/http";
import { KIWI_MAX, kiwiOneWay, kiwiReturn, type KItin, type KReturn } from "./sources/kiwi";

export type BaselineSource = "google" | "google-split" | "kiwi";
export type BaselineOffer = {
  price: number; url: string; outDate: string; retDate: string | null; origins: string[]; dests: string[]; source: BaselineSource;
  outbound?: GResult;   // Google: the offer's outbound flight (airport names, times)
  kiwiOw?: KItin;       // Kiwi fallback
  kiwiRt?: KReturn;
};
export type BaselineStatus = { ok: boolean; source: BaselineSource | null; note?: string; queried: number };

type Win = { outFrom: string; outTo: string; retFrom: string; retTo: string; stayMin: number; stayMax: number; oneWay: boolean };

const chunk = <T,>(a: T[], n: number) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));
const addDays = (d: string, n: number) => new Date(Date.parse(d) + n * 86400_000).toISOString().slice(0, 10);

/**
 * Cheapest Google offers for the window. `origins` are all departure airports in range (home first,
 * then by access cost); `dests` the destination airports (main ones first); `hint` the date pairs of
 * the best trips found so far (always priced too).
 */
export async function googleBaseline(origins: string[], dests: string[], w: Win, hint: [string, string | null][], meter: Meter,
  log: (s: string) => void = () => {}, quick = false): Promise<{ offers: BaselineOffer[]; status: BaselineStatus }> {
  if (quick) return quickBaseline(origins, dests, w, hint, meter);
  let queried = 0;
  const pairs = new Map<string, number>(); // "out|ret" -> best graph price (Infinity: a hint)
  const add = (o: string, r: string | null, price: number) => {
    if (o < w.outFrom || o > w.outTo) return;
    if (r && (r < w.retFrom || r > w.retTo)) return;
    if (r) { const s = (Date.parse(r) - Date.parse(o)) / 86400_000; if (s < w.stayMin || s > w.stayMax) return; }
    const k = `${o}|${r ?? ""}`;
    pairs.set(k, Math.min(pairs.get(k) ?? Infinity, price));
  };
  for (const [o, r] of hint) add(o, w.oneWay ? null : r, Infinity);

  // 1) date graph per departure airport (home + the biggest ones) and main destination, all at once
  // (a route Google has no fares cached for answers in ~30 s; one after another that took 10 minutes)
  const gFrom = origins.slice(0, 3), gTo = dests.slice(0, 2);
  const grids = gFrom.flatMap((f) => gTo.map((t) => [f, t] as const)).filter(([f, t]) => f !== t && AP[f] && AP[t]);
  const gridRows = await Promise.all(grids.map(([f, t]) =>
    (w.oneWay ? googleOwGrid(f, t, w.outFrom, w.outTo, meter) : googleRtGrid(f, t, w.outFrom, w.outTo, w.stayMin, w.stayMax, meter)).catch(() => null)));
  for (const rows of gridRows) {
    queried++;
    for (const r of (rows ?? []).sort((a, b) => a.price - b.price).slice(0, 4)) add(r.out, w.oneWay ? null : r.ret, r.price);
  }
  // no graph answer and no trip yet: a spread of dates over the window
  if (!pairs.size) {
    const span = Math.max(0, (Date.parse(w.outTo) - Date.parse(w.outFrom)) / 86400_000);
    for (const k of [0.15, 0.5, 0.85]) { const o = addDays(w.outFrom, Math.round(span * k)); add(o, w.oneWay ? null : addDays(o, Math.round((w.stayMin + w.stayMax) / 2)), Infinity); }
  }
  const dates = [...pairs].sort((a, b) => a[1] - b[1]).slice(0, 5).map(([k]) => k.split("|") as [string, string]);
  log(`baseline: ${dates.length} terminów, ${gFrom.length} lotnisk w siatce dat`);

  // 2) Google's result page for each candidate date pair, all airports at once (Google takes up to 7 per side)
  const offers: BaselineOffer[] = [];
  const page = async (from: string[], to: string[], o: string, r: string, source: BaselineSource) => {
    queried++;
    const res = w.oneWay ? await googleOneWayCheapest(from, to, o, meter).catch(() => null) : await googleRoundTrip(from, to, o, r, meter).catch(() => null);
    if (res?.outbound) offers.push({ price: res.price, url: res.url, outDate: o, retDate: w.oneWay ? null : r, origins: from, dests: to, source, outbound: res.outbound });
    return !!res;
  };
  const destGroups = chunk(dests.slice(0, 7), 7);
  const originGroups = chunk(origins.slice(0, 21), 7);
  // one pass over the dates; retries and the per-airport split only when nothing came back at all
  // (an empty answer for a date is normal: Google has no fare cached for it)
  await Promise.all(dates.flatMap(([o, r]) => originGroups.flatMap((from) => destGroups.map((to) => meter.canGoogle() ? page(from, to, o, r, "google") : null))));
  if (!offers.length && dates.length && meter.canGoogle()) {
    const [o, r] = dates[0];
    await Promise.all(originGroups.flatMap((from) => destGroups.map(async (to) => {
      if (!(await page(from, to, o, r, "google"))) await Promise.all(from.slice(0, 4).map((f) => page([f], to, o, r, "google-split")));
    })));
  }
  if (offers.length) {
    const src = offers.some((x) => x.source === "google") ? "google" : "google-split";
    return { offers: offers.sort((a, b) => a.price - b.price), status: { ok: true, source: src, queried } };
  }

  // 3) last resort: Kiwi's cheapest bookable combination for the same window
  const from = origins.slice(0, 12), to = dests.slice(0, 20);
  if (w.oneWay) {
    const its = await kiwiOneWay(from, to, w.outFrom, w.outTo, KIWI_MAX, meter).catch(() => null);
    queried++;
    const it = (its ?? []).filter((x) => x.segs.every((s) => AP[s.from] && AP[s.to])).sort((a, b) => a.price - b.price)[0];
    if (it) return { offers: [{ price: it.price, url: it.link, outDate: it.segs[0].depLocal.slice(0, 10), retDate: null, origins: from, dests: to, source: "kiwi", kiwiOw: it }],
      status: { ok: true, source: "kiwi", queried, note: "Google Flights nie odpowiedział; cena bazowa z Kiwi (najtańsza gotowa kombinacja)." } };
  } else {
    const its = await kiwiReturn(from, to, w.outFrom, w.outTo, w.retFrom, w.retTo, meter).catch(() => null);
    queried++;
    const it = (its ?? []).filter((x) => [...x.out, ...x.ret].every((s) => AP[s.from] && AP[s.to])).sort((a, b) => a.price - b.price)[0];
    if (it) return { offers: [{ price: it.price, url: it.link, outDate: it.out[0].depLocal.slice(0, 10), retDate: it.ret[0].depLocal.slice(0, 10), origins: from, dests: to, source: "kiwi", kiwiRt: it }],
      status: { ok: true, source: "kiwi", queried, note: "Google Flights nie odpowiedział; cena bazowa z Kiwi (najtańsza gotowa kombinacja tam i z powrotem)." } };
  }
  return { offers: [], status: { ok: false, source: null, queried,
    note: "Brak ceny bazowej: Google Flights nie zwrócił oferty mimo ponowień i zapytań per lotnisko, Kiwi też nie. Wynik nie jest porównany z Google." } };
}

/**
 * The quick Google price for the first answer (stage 1, a few seconds): no date graph, only Google's
 * result page for the dates of the best trips found so far (plus a spread over the window), from the
 * departure airports closest to home and the biggest ones, all requests at once. The full baseline
 * (date graph, every airport) follows in the background.
 */
async function quickBaseline(origins: string[], dests: string[], w: Win, hint: [string, string | null][], meter: Meter): Promise<{ offers: BaselineOffer[]; status: BaselineStatus }> {
  const inWin = ([o, r]: [string, string | null]) => o >= w.outFrom && o <= w.outTo && (w.oneWay || (!!r && r >= w.retFrom && r <= w.retTo));
  const dates: [string, string | null][] = [];
  const push = (d: [string, string | null]) => { if (inWin(d) && !dates.some((x) => x[0] === d[0] && x[1] === d[1])) dates.push(d); };
  for (const [o, r] of hint) push([o, w.oneWay ? null : r]);
  const span = Math.max(0, (Date.parse(w.outTo) - Date.parse(w.outFrom)) / 86400_000);
  const stay = Math.round((w.stayMin + w.stayMax) / 2);
  for (const k of [0.3, 0.7]) { if (dates.length >= 3) break; const o = addDays(w.outFrom, Math.round(span * k)); push([o, w.oneWay ? null : addDays(o, stay)]); }
  const BIG = ["WAW", "KRK", "BER", "PRG", "VIE", "BUD"];
  const from = [...new Set([...origins.slice(0, 5), ...BIG.filter((c) => origins.includes(c))])].slice(0, 7);
  const to = dests.slice(0, 7);
  let queried = 0;
  const offers: BaselineOffer[] = [];
  await Promise.all(dates.map(async ([o, r]) => {
    if (!meter.canGoogle()) return;
    queried++;
    const res = w.oneWay ? await googleOneWayCheapest(from, to, o, meter).catch(() => null) : await googleRoundTrip(from, to, o, r!, meter).catch(() => null);
    if (res?.outbound) offers.push({ price: res.price, url: res.url, outDate: o, retDate: w.oneWay ? null : r, origins: from, dests: to, source: "google", outbound: res.outbound });
  }));
  return offers.length
    ? { offers: offers.sort((a, b) => a.price - b.price), status: { ok: true, source: "google", queried } }
    : { offers: [], status: { ok: false, source: null, queried, note: "Szybka cena Google jeszcze niegotowa – pełne porównanie trwa." } };
}
