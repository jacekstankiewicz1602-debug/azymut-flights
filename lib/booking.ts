// Booking links for a trip: one link for the whole trip when it is a single booking (Kiwi or Google
// Flights), otherwise one deep link per ticket, prefilled with route, date and passengers, in the order
// to buy them (the most expensive or riskiest first is decided by the UI from `price` and `risk`).
import { AP } from "./airports";
import type { Trip, TripLeg } from "./engine";
import { flixCity } from "./sources/flixbus";
import { tfs } from "./sources/google";

export type BookingTicket = {
  ticket: number; legs: number[]; from: string; to: string; date: string; price: number; url: string;
  source: "ryanair" | "wizz" | "google" | "kiwi" | "flixbus" | "other"; risk: "protected" | "separate";
};
export type Booking = { whole: { url: string; source: "kiwi" | "google"; price: number | null } | null; tickets: BookingTicket[] };

const isGround = (l: TripLeg) => l.source === "flixbus" || l.source === "local" || l.source === "ground";
const ddmmyyyy = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}`;

export const ryanairUrl = (from: string, to: string, date: string, pax: number) =>
  `https://www.ryanair.com/pl/pl/trip/flights/select?adults=${pax}&teens=0&children=0&infants=0&dateOut=${date}&dateIn=&isConnectedFlight=false&isReturn=false&discount=0&promoCode=&originIata=${from}&destinationIata=${to}&tpAdults=${pax}&tpTeens=0&tpChildren=0&tpInfants=0&tpStartDate=${date}&tpEndDate=&tpDiscount=0&tpPromoCode=&tpOriginIata=${from}&tpDestinationIata=${to}`;
export const wizzUrl = (from: string, to: string, date: string, pax: number) =>
  `https://wizzair.com/pl-pl/booking/select-flight/${from}/${to}/${date}/null/${pax}/0/0/null`;
/** Google Flights with the search state in `tfs` (route, dates, passengers), in Polish and PLN. */
export const googleUrl = (legs: { date: string; from: string; to: string }[], roundTrip: boolean, pax: number) =>
  `https://www.google.com/travel/flights?tfs=${encodeURIComponent(tfs(legs.map((l) => ({ date: l.date, from: [l.from], to: [l.to] })), roundTrip, pax))}&hl=pl&curr=PLN`;
export function flixUrl(from: string, to: string, date: string, pax: number): string | null {
  const a = flixCity(from), b = flixCity(to);
  if (!a || !b) return null;
  return `https://shop.flixbus.pl/search?departureCity=${a.id}&arrivalCity=${b.id}&rideDate=${ddmmyyyy(date)}&adult=${pax}&_locale=pl`;
}
const mapsUrl = (from: string, to: string) =>
  `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(`${AP[from]?.name ?? from}`)}&destination=${encodeURIComponent(`${AP[to]?.name ?? to}`)}&travelmode=transit`;
/** A Kiwi booking link from the API (a booking token), not the generic home page. */
const kiwiDeep = (u: string) => /kiwi\.com\/.+booking.+token=/.test(u);
/** The Kiwi booking with the passenger count set (the token itself is for one adult). */
const kiwiPax = (u: string, pax: number) => u.replace(/passengers=\d+-/, `passengers=${pax}-`);

/** The booking links of a trip (computed on read; nothing is stored). */
export function bookingFor(t: Trip, pax = 1): Booking {
  const legs = t.legs;
  // ticket groups in leg order (TripLeg.ticket from the engine; older results: a 0-priced leg rides on the previous one)
  // (a round-trip ticket groups its outbound and its return leg, wherever they sit)
  const groups: { ticket: number; idx: number[] }[] = [];
  legs.forEach((l, i) => {
    const prev = groups[groups.length - 1];
    const own = l.ticket !== undefined ? groups.find((g) => legs[g.idx[0]].ticket === l.ticket) : undefined;
    if (own) own.idx.push(i);
    else if (l.ticket === undefined && prev && l.price === 0 && !isGround(l)) prev.idx.push(i);
    else groups.push({ ticket: l.ticket ?? groups.length + 1, idx: [i] });
  });
  const flightGroups = groups.filter((g) => !isGround(legs[g.idx[0]]));
  // separate tickets in one direction mean an unprotected connection
  const sepDir = new Set<string>();
  for (const d of ["out", "ret"]) if (flightGroups.filter((g) => legs[g.idx[0]].dir === d).length > 1) sepDir.add(d);

  const tickets: BookingTicket[] = groups.map((g) => {
    const first = legs[g.idx[0]];
    // the stretch this ticket flies in its first direction (a round trip returns to where it started)
    const sameDir = g.idx.filter((i) => legs[i].dir === first.dir);
    const last = legs[sameDir[sameDir.length - 1]];
    const date = first.depLocal.slice(0, 10);
    const price = g.idx.reduce((s, i) => s + legs[i].price, 0);
    const risk: BookingTicket["risk"] = isGround(first) || sepDir.has(first.dir) ? "separate" : "protected";
    let source: BookingTicket["source"] = "other";
    let url = "";
    if (first.source === "ryanair") { source = "ryanair"; url = ryanairUrl(first.from, last.to, date, pax); }
    else if (first.source === "wizz") { source = "wizz"; url = wizzUrl(first.from, last.to, date, pax); }
    else if (first.source === "kiwi") { source = "kiwi"; url = kiwiDeep(first.link) ? kiwiPax(first.link, pax) : googleUrl([{ date, from: first.from, to: last.to }], false, pax); }
    else if (first.source === "flixbus") { source = "flixbus"; url = flixUrl(first.from, last.to, date, pax) ?? first.link; }
    else if (isGround(first)) { source = "other"; url = first.link || mapsUrl(first.from, last.to); }
    else if (first.source === "aviasales") { source = "other"; url = first.link; }
    else {
      // Google (and anything else): a one-way search for this stretch; a Google round-trip ticket (its
      // return leg rides at price 0) opens as the round trip it is
      source = "google";
      const backIdx = g.idx.find((i) => legs[i].dir !== first.dir)
        ?? legs.findIndex((l, i) => i > g.idx[g.idx.length - 1] && l.price - (l.bag ?? 0) === 0 && l.source === "google" && l.link === first.link && l.from === last.to);
      const back = backIdx !== undefined && backIdx >= 0 ? legs[backIdx] : undefined;
      url = back ? googleUrl([{ date, from: first.from, to: last.to }, { date: back.depLocal.slice(0, 10), from: back.from, to: back.to }], true, pax)
        : googleUrl([{ date, from: first.from, to: last.to }], false, pax);
    }
    return { ticket: g.ticket, legs: g.idx, from: first.from, to: last.to, date, price, url, source, risk };
  });

  // the whole trip as one booking: all flights on one Kiwi booking, or the plain Google offer
  let whole: Booking["whole"] = null;
  const flights = legs.filter((l) => !isGround(l));
  if (flightGroups.length === 1 && flights.length) {
    const f = flights[0], l = flights[flights.length - 1];
    const ret = flights.find((x) => x.dir === "ret");
    const outLast = [...flights].reverse().find((x) => x.dir === "out") ?? l;
    if (f.source === "kiwi" && kiwiDeep(f.link)) whole = { url: kiwiPax(f.link, pax), source: "kiwi", price: flights.reduce((s, x) => s + x.price, 0) };
    else if (f.source === "google") whole = { url: ret ? googleUrl([{ date: f.depLocal.slice(0, 10), from: f.from, to: outLast.to }, { date: ret.depLocal.slice(0, 10), from: ret.from, to: l.to }], true, pax)
      : googleUrl([{ date: f.depLocal.slice(0, 10), from: f.from, to: l.to }], false, pax), source: "google", price: flights.reduce((s, x) => s + x.price, 0) };
  }
  return { whole, tickets };
}
