// Google Flights without an API key: the search state is a protobuf in the `tfs` URL parameter
// (same scheme as the fast-flights library); results are read from the accessible labels.
import { ALL_AIRPORTS, AP } from "../airports";
import { recordDuration } from "../durations";
import { localToUtc } from "../time";
import type { FlightOption } from "../types";
import { cachedJson, priceTtl, Meter, pace, politeFetch, randomUA } from "./http";

const varint = (n: number) => { const b: number[] = []; while (n > 127) { b.push((n & 127) | 128); n >>>= 7; } b.push(n); return b; };
const key = (f: number, w: number) => varint((f << 3) | w);
const str = (f: number, s: string) => { const d = [...Buffer.from(s)]; return [...key(f, 2), ...varint(d.length), ...d]; };
const msg = (f: number, bytes: number[]) => [...key(f, 2), ...varint(bytes.length), ...bytes];
const int = (f: number, n: number) => [...key(f, 0), ...varint(n)];

type GLeg = { date: string; from: string[]; to: string[] };

export function tfs(legs: GLeg[], roundTrip: boolean, pax = 1): string {
  let out: number[] = [];
  for (const l of legs) {
    out = out.concat(msg(3, [...str(2, l.date), ...l.from.flatMap((a) => msg(13, str(2, a))), ...l.to.flatMap((a) => msg(14, str(2, a)))]));
  }
  // 8: passengers (adult), 9: seat (economy), 19: trip type (1 round trip, 2 one way)
  const adults = Array.from({ length: Math.max(1, pax) }, () => int(8, 1)).flat();
  return Buffer.from(out.concat(adults, int(9, 1), int(19, roundTrip ? 1 : 2))).toString("base64");
}

export function googleUrl(legs: GLeg[], roundTrip: boolean) {
  return `https://www.google.com/travel/flights?tfs=${encodeURIComponent(tfs(legs, roundTrip))}&hl=en&curr=PLN`;
}

export type GResult = {
  price: number; carriers: string; stops: number;
  fromName?: string; toName?: string; // Google's airport names (several airports per side may be searched)
  depLocal: string; arrLocal: string; // local wall clock at the first / last airport
  layovers?: { name: string; city: string; min: number }[]; // "Layover (1 of 1) is a 8 hr 10 min layover at Oslo lufthavn in Oslo."
};

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function wall(time: string, monthName: string, day: string, refDate: string): string {
  const m = time.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/)!;
  let h = Number(m[1]) % 12;
  if (m[3] === "PM") h += 12;
  const mon = MONTHS.indexOf(monthName) + 1;
  let year = Number(refDate.slice(0, 4));
  if (mon < Number(refDate.slice(5, 7)) - 6) year++; // crossed new year
  return `${year}-${String(mon).padStart(2, "0")}-${day.padStart(2, "0")}T${String(h).padStart(2, "0")}:${m[2]}`;
}

/** A result's transfer airports as codes (undefined when one of them is not recognised). */
export function viaOf(r: GResult): { iata: string; min: number }[] | undefined {
  if (!r.stops || !r.layovers) return undefined;
  const via = r.layovers.map((l) => ({ iata: airportFromGoogle(l.name, l.city), min: l.min }));
  return via.every((v) => v.iata) ? via as { iata: string; min: number }[] : undefined;
}

// (cache keys g:ow3 / g:rt3 / g:owc3: results now carry the layover airports)
const toks = (s: string) => new Set(s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").split(/[^a-z]+/).filter((w) => w.length > 2 && !["airport", "international", "lufthavn", "aeroporto", "aeropuerto", "flughafen", "aeroport"].includes(w)));
/** Airport code from Google's airport and city name ("Oslo lufthavn", "Oslo" → OSL); "" when unsure. */
export function airportFromGoogle(name: string, city: string): string {
  const c = toks(city), n = toks(name);
  let best = "", score = 0;
  for (const a of ALL_AIRPORTS) {
    const ac = toks(`${a.city} ${a.cityEn}`), an = toks(`${a.name} ${a.city} ${a.cityEn}`);
    const cityHit = [...c].some((w) => ac.has(w));
    if (!cityHit) continue;
    const sc = 1 + [...n].filter((w) => an.has(w)).length + (a.size === "S" ? 0 : 0.5);
    if (sc > score) { score = sc; best = a.iata; }
  }
  return best;
}

/** Parse Google Flights result labels into structured results. */
export function parseGoogle(html: string, refDate: string): GResult[] {
  const out: GResult[] = [];
  const re = /aria-label="(From (\d+) Polish zlotys[^"]*?Select flight)"/g;
  for (const m of html.matchAll(re)) {
    const label = m[1].replace(/&#39;/g, "'").replace(/&amp;/g, "&");
    const t = label.match(/Leaves (.+?) at (\d{1,2}:\d{2}\s*[AP]M) on \w+, (\w+) (\d{1,2}) and arrives at (.+?) at (\d{1,2}:\d{2}\s*[AP]M) on \w+, (\w+) (\d{1,2})/);
    if (!t) continue;
    const carriers = label.match(/(?:Nonstop|\d+ stops?) flight with (.+?)\./)?.[1]?.replace(/ and /g, " + ") ?? "?";
    const stops = /Nonstop/.test(label) ? 0 : Number(label.match(/(\d+) stops?/)?.[1] ?? 1);
    const layovers = [...label.matchAll(/Layover \(\d+ of \d+\) is a (?:(\d+) hr)? ?(?:(\d+) min)? (?:overnight )?layover at (.+?) in (.+?)\./g)]
      .map((l) => ({ name: l[3], city: l[4], min: Number(l[1] ?? 0) * 60 + Number(l[2] ?? 0) }));
    out.push({
      price: Number(m[2]), carriers, stops, fromName: t[1], toName: t[5], layovers: layovers.length === stops ? layovers : undefined,
      depLocal: wall(t[2], t[3], t[4], refDate), arrLocal: wall(t[6], t[7], t[8], refDate),
    });
  }
  // dedupe identical rows Google repeats in several sections
  const seen = new Set<string>();
  return out.filter((r) => { const k = `${r.price}|${r.depLocal}|${r.arrLocal}|${r.carriers}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

async function fetchGoogle(url: string, meter: Meter): Promise<string | null> {
  if (!meter.canGoogle()) return null;
  await pace("google", 1100 + Math.random() * 700);
  meter.add("google", false);
  return politeFetch(url, {
    headers: {
      "user-agent": randomUA(), "accept-language": "en-US,en;q=0.9", accept: "text/html",
      cookie: "CONSENT=YES+cb; SOCS=CAESHAgBEhJnd3NfMjAyMzA4MTAtMF9SQzIaAmVuIAEaBgiAo_CmBg",
    },
  }, "google");
}

/** One-way Google Flights on one date, as single-ticket options (connections inside are protected). */
export async function googleOneWay(from: string, to: string, date: string, meter: Meter): Promise<FlightOption[] | null> {
  const url = googleUrl([{ date, from: [from], to: [to] }], false);
  const { value } = await cachedJson<GResult[]>(`g:ow3:${from}:${to}:${date}`, priceTtl(date), async () => {
    const html = await fetchGoogle(url, meter);
    return html === null ? null : parseGoogle(html, date);
  });
  if (!value) return null;
  const A = AP[from], B = AP[to];
  const direct = value.find((r) => r.stops === 0);
  if (direct) void recordDuration(from, to, (localToUtc(direct.arrLocal, B.tz) - localToUtc(direct.depLocal, A.tz)) / 60_000);
  return value
    .filter((r) => r.depLocal.slice(0, 10) === date)
    .sort((a, b) => a.price - b.price)
    .slice(0, 8)
    .map((r) => ({
      from, to, dep: localToUtc(r.depLocal, A.tz), arr: localToUtc(r.arrLocal, B.tz), depLocal: r.depLocal, arrLocal: r.arrLocal,
      price: r.price, carrier: r.carriers, flightNo: r.stops ? `${r.stops} przes.` : "", source: "google" as const, link: url, stops: r.stops, via: viaOf(r),
    }));
}

/** Cheapest round-trip total Google shows (several airports per side allowed). */
export async function googleRoundTrip(
  from: string[], to: string[], outDate: string, retDate: string, meter: Meter,
): Promise<{ price: number; url: string; outbound: GResult } | null> {
  const url = googleUrl([{ date: outDate, from, to }, { date: retDate, from: to, to: from }], true);
  const { value } = await cachedJson<{ price: number; url: string; outbound: GResult }>(
    `g:rt3:${from.join(",")}:${to.join(",")}:${outDate}:${retDate}`, priceTtl(outDate), async () => {
      const html = await fetchGoogle(url, meter);
      if (html === null) return null;
      const rows = parseGoogle(html, outDate).sort((a, b) => a.price - b.price);
      return rows.length ? { price: rows[0].price, url, outbound: rows[0] } : null;
    });
  return value;
}

/** Cheapest one-way Google shows (for one-way baselines). */
export async function googleOneWayCheapest(from: string[], to: string[], date: string, meter: Meter): Promise<{ price: number; url: string; outbound?: GResult } | null> {
  const url = googleUrl([{ date, from, to }], false);
  const { value } = await cachedJson<{ price: number; url: string; outbound?: GResult }>(`g:owc3:${from.join(",")}:${to.join(",")}:${date}`, priceTtl(date), async () => {
    const html = await fetchGoogle(url, meter);
    if (html === null) return null;
    const rows = parseGoogle(html, date).sort((a, b) => a.price - b.price);
    return rows.length ? { price: rows[0].price, url, outbound: rows[0] } : null;
  });
  return value;
}

// ---------------- date grid (GetCalendarGraph RPC) ----------------

export type GridRow = { out: string; ret: string; price: number };

/**
 * Round-trip prices for every departure day in [d0, d1] and every trip length in [durMin, durMax]
 * (the "date grid" Google Flights shows). At most 4 lengths per request, so longer ranges are split.
 */
export async function googleRtGrid(from: string, to: string, d0: string, d1: string, durMin: number, durMax: number, meter: Meter): Promise<GridRow[] | null> {
  const buckets: [number, number][] = [];
  for (let a = durMin; a <= durMax; a += 4) buckets.push([a, Math.min(durMax, a + 3)]);
  // the trip-length buckets at once (the grid pool caps the requests in flight)
  const parts = await Promise.all(buckets.map(async ([a, b]) => {
    const { value } = await cachedJson<GridRow[]>(`g:grid2:${from}:${to}:${d0}:${d1}:${a}:${b}`, priceTtl(d0), async () => {
      if (!meter.canGoogle(15)) return null; // keep some budget for the baseline
      await pace("google", 900 + Math.random() * 600);
      meter.add("google", false);
      const wrap = (c: string) => [[[c, 0]]];
      const seg = (x: string, y: string, d: string) => [wrap(x), wrap(y), null, 0, null, null, d, null, null, null, null, null, null, null, 3];
      const ret = new Date(Date.parse(d0) + a * 86400_000).toISOString().slice(0, 10);
      const filters = [null, [null, null, 1, null, [], 1, [1, 0, 0, 0], null, null, null, null, null, null,
        [seg(from, to, d0), seg(to, from, ret)], null, null, null, 1], [d0, d1], null, [a, b]];
      const text = await politeFetch(
        "https://www.google.com/_/FlightsFrontendUi/data/travel.frontend.flights.FlightsFrontendService/GetCalendarGraph?hl=en&curr=PLN",
        { method: "POST", body: "f.req=" + encodeURIComponent(JSON.stringify([null, JSON.stringify(filters)])),
          headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8", "user-agent": randomUA() } }, "google-grid", 2, 45_000);
      if (!text) return null;
      try {
        const line = text.replace(/^\)\]\}'\s*/, "").split("\n").find((l) => l.startsWith("[["));
        const inner = line ? JSON.parse(JSON.parse(line)[0][2] ?? "null") : null;
        // an error answer ([["wrb.fr",null,...,[13]]]) has no payload: unknown, not "no flights"
        if (!inner) return null;
        const rows = inner[inner.length - 1] || [];
        return (rows as [string, string, [[null, number]] | null][])
          .filter((r) => r[2]?.[0]?.[1])
          .map((r) => ({ out: r[0], ret: r[1], price: r[2]![0][1] }));
      } catch { return null; }
    });
    return value;
  }));
  return parts.some(Boolean) ? parts.flatMap((v) => v ?? []) : null;
}

/** One-way prices for every departure day in [d0, d1] (Google's date graph), cheapest first. */
export async function googleOwGrid(from: string, to: string, d0: string, d1: string, meter: Meter): Promise<GridRow[] | null> {
  const { value } = await cachedJson<GridRow[]>(`g:owgrid:${from}:${to}:${d0}:${d1}`, priceTtl(d0), async () => {
    if (!meter.canGoogle(10)) return null;
    await pace("google", 900 + Math.random() * 600);
    meter.add("google", false);
    const wrap = (c: string) => [[[c, 0]]];
    const seg = [wrap(from), wrap(to), null, 0, null, null, d0, null, null, null, null, null, null, null, 3];
    const filters = [null, [null, null, 2, null, [], 1, [1, 0, 0, 0], null, null, null, null, null, null, [seg], null, null, null, 1], [d0, d1], null, null];
    const text = await politeFetch(
      "https://www.google.com/_/FlightsFrontendUi/data/travel.frontend.flights.FlightsFrontendService/GetCalendarGraph?hl=en&curr=PLN",
      { method: "POST", body: "f.req=" + encodeURIComponent(JSON.stringify([null, JSON.stringify(filters)])),
        headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8", "user-agent": randomUA() } }, "google-grid", 2, 45_000);
    if (!text) return null;
    try {
      const line = text.replace(/^\)\]\}'\s*/, "").split("\n").find((l) => l.startsWith("[["));
      const inner = line ? JSON.parse(JSON.parse(line)[0][2] ?? "null") : null;
      if (!inner) return null;
      const rows = inner[inner.length - 1] || [];
      return (rows as [string, string | null, [[null, number]] | null][]).filter((r) => r[2]?.[0]?.[1]).map((r) => ({ out: r[0], ret: "", price: r[2]![0][1] }));
    } catch { return null; }
  });
  return value ? [...value].sort((a, b) => a.price - b.price) : null;
}
