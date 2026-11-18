// Aviasales' public price calendars (no key): the flights Kiwi and Google don't sell at all, Russian
// domestic routes on Aeroflot, S7, Pobeda… (Moskwa → Kamczatka). Prices are cached cheapest fares per
// day in roubles; the direct-flight schedule (Ariadne) gives the carrier and the departure time.
import { AP, km } from "../airports";
import { ratesPln, toPln } from "../fx";
import { knownDuration } from "../durations";
import { addDays, localToUtc, utcToLocal } from "../time";
import type { FlightOption } from "../types";
import { cachedJson, Meter, politeFetch, priceTtl, randomUA } from "./http";

/** Aviasales searches by city: Moscow's airports are one city. */
const CITY: Record<string, string> = { SVO: "MOW", VKO: "MOW", DME: "MOW", ZIA: "MOW", LED: "LED" };
export const avsCity = (c: string) => CITY[c] ?? c;

type Day = { date: string; rub: number; direct: boolean };

async function getJson<T>(url: string, init: RequestInit, meter: Meter): Promise<T | null> {
  if (!meter.can("aviasales")) return null;
  meter.add("aviasales", false);
  const text = await politeFetch(url, { ...init, headers: { "user-agent": randomUA(), accept: "application/json", ...(init.headers ?? {}) } }, "aviasales", 2, 30_000);
  try { return text ? (JSON.parse(text) as T) : null; } catch { return null; }
}

/** Cheapest one-way fare per day: the 90-day chart (knows direct vs connecting) plus month calendars further out. */
async function days(from: string, to: string, months: string[], meter: Meter): Promise<Day[] | null> {
  const [a, b] = [avsCity(from), avsCity(to)];
  const { value } = await cachedJson<Day[]>(`avs:days:${a}:${b}:${months.join(",")}`, priceTtl(months[0] + "-01"), async () => {
    const chart = getJson<{ prices?: { depart_date: string; value: number; number_of_changes: number }[] }>(
      `https://explore-api.aviasales.ru/aggregated/v1/web/aviasales/city/price_chart.json?brand=AS&currency=rub&origin=${a}&origin_type=city&destination=${b}&destination_type=city&one_way=true&market=ru`, {}, meter);
    const cals = months.map((m) => getJson<{ prices?: { depart_date: string; price: number }[] }>(
      `https://explore-api.aviasales.ru/aggregated/v2/web/aviasales/city/calendar.json?origin_iata=${a}&destination_iata=${b}&brand=AS&locale=ru&currency=rub&one_way=true&depart_months[]=${m}-01`, {}, meter));
    const [c, ...ms] = await Promise.all([chart, ...cals]);
    if (!c && ms.every((x) => !x)) return null;
    const out = new Map<string, Day>();
    for (const x of c?.prices ?? []) out.set(x.depart_date, { date: x.depart_date, rub: x.value, direct: x.number_of_changes === 0 });
    for (const x of ms.flatMap((m) => m?.prices ?? [])) if (!out.has(x.depart_date)) out.set(x.depart_date, { date: x.depart_date, rub: x.price, direct: false });
    return [...out.values()];
  });
  return value;
}

type Sched = { date: string; rub: number | null; flights: { from: string; to: string; dep: string; airline: string }[] };

/** Direct flights per day (carrier, airport, departure time) and the cheapest direct fare when known;
 *  Ariadne answers at most about a month per request. */
async function schedule(from: string, to: string, d0: string, d1: string, meter: Meter): Promise<Sched[] | null> {
  const w: [string, string][] = [];
  for (let d = d0; d <= d1; d = addDays(d, 30)) w.push([d, addDays(d, 29) < d1 ? addDays(d, 29) : d1]);
  const parts = await Promise.all(w.map(([a, b]) => scheduleMonth(from, to, a, b, meter)));
  return parts.some(Boolean) ? parts.flatMap((x) => x ?? []) : null;
}

async function scheduleMonth(from: string, to: string, d0: string, d1: string, meter: Meter): Promise<Sched[] | null> {
  const [a, b] = [avsCity(from), avsCity(to)];
  const { value } = await cachedJson<Sched[]>(`avs:sched:${a}:${b}:${d0}:${d1}`, priceTtl(d0), async () => {
    const query = `{ direct_flights_v1(brand: AS, input:{origin_iata:"${a}", origin_type: CITY, destination_iata:"${b}", destination_type: CITY, market:"ru", currency:"rub", dates:{depart_date_from:"${d0}", depart_date_to:"${d1}"}}) { schedule { depart_date min_price{value} flights{origin_airport_iata destination_airport_iata departure_date_time airline} } } }`;
    const j = await getJson<{ data?: { direct_flights_v1?: { schedule?: { depart_date: string; min_price: { value: number } | null; flights: { origin_airport_iata: string; destination_airport_iata: string; departure_date_time: string; airline: string }[] | null }[] } } }>(
      "https://ariadne.aviasales.ru/api/gql", { method: "POST", body: JSON.stringify({ query }), headers: { "content-type": "application/json" } }, meter);
    const s = j?.data?.direct_flights_v1?.schedule;
    if (!s) return null;
    return s.map((d) => ({ date: d.depart_date, rub: d.min_price?.value ?? null,
      flights: (d.flights ?? []).map((f) => ({ from: f.origin_airport_iata, to: f.destination_airport_iata, dep: f.departure_date_time.slice(0, 16).replace(" ", "T"), airline: f.airline })) }));
  });
  return value;
}

const monthsOf = (d0: string, d1: string) => {
  const out: string[] = [];
  for (let m = d0.slice(0, 7); m <= d1.slice(0, 7); ) { out.push(m); const [y, mo] = m.split("-").map(Number); m = mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, "0")}`; }
  return out;
};
const ddmm = (d: string) => d.slice(8, 10) + d.slice(5, 7);

/**
 * Direct flights from → to in [d0, d1] with a fare, cheapest first: the departure time from the
 * schedule, the arrival from the known block time (else distance at 780 km/h plus 30 min, so
 * "estimated"). The fare is Aviasales' cached cheapest direct one; a day with only a connecting
 * fare in the calendar uses it as an estimate.
 */
export async function aviasalesDirect(from: string, to: string, d0: string, d1: string, meter: Meter): Promise<FlightOption[] | null> {
  const [ds, sc, rates] = await Promise.all([days(from, to, monthsOf(d0, d1), meter), schedule(from, to, d0, d1, meter), ratesPln()]);
  if (!sc || !rates) return null;
  const byDay = new Map((ds ?? []).map((d) => [d.date, d]));
  const out: FlightOption[] = [];
  for (const s of sc) {
    if (s.date < d0 || s.date > d1) continue;
    const cal = byDay.get(s.date);
    const rub = s.rub ?? (cal?.direct ? cal.rub : null) ?? cal?.rub ?? null;
    if (rub === null) continue;
    const exact = s.rub !== null || !!cal?.direct;
    for (const f of s.flights) {
      const A = AP[f.from], B = AP[f.to];
      if (!A || !B) continue;
      const min = (await knownDuration(f.from, f.to)) ?? Math.round(km(A, B) / 780 * 60 + 30);
      const dep = localToUtc(f.dep, A.tz), arr = dep + min * 60_000;
      out.push({
        from: f.from, to: f.to, dep, arr, depLocal: f.dep, arrLocal: utcToLocal(arr, B.tz),
        price: Math.round(toPln(rub, "RUB", rates)), carrier: f.airline, flightNo: "", source: "aviasales",
        link: `https://www.aviasales.ru/search/${avsCity(f.from)}${ddmm(s.date)}${avsCity(f.to)}1`, estimated: !exact,
      });
    }
  }
  return out.sort((a, b) => a.price - b.price);
}

