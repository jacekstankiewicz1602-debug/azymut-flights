// Shared trip facts for the timeline in the results panel and the badges on the globe: what kind of
// connection sits between two legs, carrier codes for logos, and the small inline icons.
import type { Trip } from "@/lib/engine";
import { AIRPORT_POS, fmtPln } from "./geo";

type Leg = Trip["legs"][number];

export const isGround = (l: { source: string }) => l.source === "flixbus" || l.source === "local" || l.source === "ground";
export const cityOf = (c: string) => AIRPORT_POS[c]?.city ?? c;

/** "3 h 20 min", "45 min" */
export function dur(h: number) {
  const m = Math.round(h * 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}`;
}

/** Polish locative is irregular, so "w {city}" uses the nominative after "w mieście" only when unknown. */
export const days = (n: number) => `${n} ${n === 1 ? "dzień" : "dni"}`;

export const ticketOf = (l: Leg) => (l as Leg & { ticket?: number }).ticket;
/** Booking number of each leg (1, 2, …), from the engine's ticket ids or, for older results, from prices. */
export function ticketNumbers(t: Trip): number[] {
  const out: number[] = [];
  let n = 0, last: number | undefined;
  t.legs.forEach((l, i) => {
    const id = ticketOf(l);
    const same = i > 0 && (id !== undefined ? id === last : l.price === 0);
    if (!same) n++;
    out.push(n);
    last = id;
  });
  return out;
}

export type Conn = {
  kind: "conn" | "stay" | "turn";
  city: string; code: string;
  gapH: number;
  title: string;                 // "Stambuł · 3 h 20 min", "2 dni · Bogota", "Pobyt 14 dni · Lima"
  chips: { label: string; tone: "warn" | "info" | "accent" | "ok" | ""; icon?: keyof typeof ICONS }[];
};

/** The connection before leg i (null for the first leg). */
export function connBefore(t: Trip, i: number, hotelOff = false): Conn | null {
  const leg = t.legs[i], prev = t.legs[i - 1];
  if (!prev) return null;
  const code = prev.to, city = cityOf(code);
  const gapH = Math.max(0, (leg.dep - prev.arr) / 3_600_000);
  if (prev.dir !== leg.dir) return { kind: "turn", city, code, gapH, title: `Pobyt ${days(t.stayDays ?? Math.round(gapH / 24))} · ${city}`, chips: [] };
  const chips: Conn["chips"] = [];
  const air = !isGround(leg) && !isGround(prev);
  // booking groups from the engine (leg.ticket); older results: a leg priced 0 rides on the previous ticket
  const sameTicket = ticketOf(leg) !== undefined && ticketOf(prev) !== undefined ? ticketOf(leg) === ticketOf(prev) : leg.price === 0;
  const separate = air && !sameTicket;
  if (air) chips.push(separate ? { label: "osobny bilet · ryzyko przesiadki", tone: "warn", icon: "ticket" } : { label: "jeden bilet · chroniona przesiadka", tone: "ok", icon: "shield" });
  if (leg.source === "local" || (prev.to !== leg.from)) chips.push({ label: "zmiana lotniska", tone: "", icon: "bus" });
  if (leg.hotel || leg.overnight) chips.push({ label: `nocleg ~${fmtPln(leg.hotel ?? 0)}${hotelOff ? " (poza ceną)" : ""}`, tone: "", icon: "bed" });
  if (separate && gapH < 3) chips.push({ label: "krótka przy osobnych biletach", tone: "warn" });
  const stay = gapH >= 20 && !isGround(leg) && !isGround(prev);
  if (stay) {
    const d = Math.round(gapH / 24) || 1;
    return { kind: "stay", city, code, gapH, title: `${days(d)} · ${city}`, chips };
  }
  return { kind: "conn", city, code, gapH, title: `${city} · ${dur(gapH)}`, chips };
}

const KNOWN: Record<string, string> = { Ryanair: "FR", "Wizz Air": "W6", easyJet: "U2", Lufthansa: "LH", LOT: "LO", "Turkish Airlines": "TK", Pegasus: "PC", Emirates: "EK", Qatar: "QR" };

/** Two-character airline code for a logo, from the flight number ("TK1234") or a known name. */
export function carrierCode(l: Leg): string | null {
  if (isGround(l)) return null;
  const m = l.flightNo?.match(/^([A-Z0-9]{2})(?=\d|\s|$|\/)/);
  if (m && /[A-Z]/.test(m[1])) return m[1];
  const first = l.carrier?.split(" + ")[0] ?? "";
  return KNOWN[first] ?? null;
}
export const logoUrl = (code: string) => `https://pics.avs.io/64/64/${code}.png`;

/** Lucide-style 24px stroke icons as inline SVG markup (used in React via dangerouslySetInnerHTML and on the globe). */
export const ICONS = {
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  bed: '<path d="M3 18V7"/><path d="M3 14h18v4"/><path d="M21 14v-2a3 3 0 0 0-3-3h-7v5"/><circle cx="7" cy="11" r="2"/>',
  bus: '<rect x="4" y="4" width="16" height="13" rx="3"/><path d="M4 11h16"/><path d="M7 17v2M17 17v2"/><circle cx="8" cy="14" r=".6"/><circle cx="16" cy="14" r=".6"/>',
  plane: '<path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z"/>',
  ticket: '<path d="M3 9a3 3 0 0 0 0 6v3h18v-3a3 3 0 0 0 0-6V6H3z"/><path d="M13 6v2M13 11v2M13 16v2"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  play: '<path d="M7 5v14l11-7z"/>',
  chevron: '<path d="m6 15 6-6 6 6"/>',
  arrow: '<path d="M4 12h15M14 6l6 6-6 6"/>',
  pin: '<path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  swap: '<path d="M7 4 3 8l4 4M3 8h14M17 20l4-4-4-4M21 16H7"/>',
  shield: '<path d="M12 3 5 6v5c0 4.5 3 8.3 7 10 4-1.7 7-5.5 7-10V6z"/><path d="m9 12 2 2 4-4"/>',
  bell: '<path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
} as const;

export const svg = (name: keyof typeof ICONS, cls = "ico") =>
  `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;

/** Every direction's flights on one booking (protected connections); the engine's flag or, for older results, the ticket ids. */
export function isOneTicket(t: Trip): boolean {
  const f = (t as Trip & { oneTicket?: boolean }).oneTicket;
  if (f !== undefined) return f;
  return (["out", "ret"] as const).every((d) => {
    const air = t.legs.filter((l) => l.dir === d && !isGround(l));
    return air.length <= 1 || air.every((l) => ticketOf(l) !== undefined && ticketOf(l) === ticketOf(air[0]));
  });
}

/** Number of separate bookings for the flights (bus rides not counted). */
export function bookings(t: Trip): number {
  const n = ticketNumbers(t);
  return new Set(t.legs.map((l, i) => (isGround(l) ? 0 : n[i])).filter(Boolean)).size;
}

/** Price with one checked bag per person (engine's trip.bagPrice), and whether a fee in it is estimated. */
export const bagOf = (t: Trip) => t as Trip & { bagPrice?: number; bagEstimated?: boolean };

/** Polish plural: plural(5, "kraj", "kraje", "krajów") → "5 krajów". */
export function plural(n: number, one: string, few: string, many: string): string {
  const t = n % 10, h = n % 100;
  return `${n} ${n === 1 ? one : t >= 2 && t <= 4 && (h < 12 || h > 14) ? few : many}`;
}
