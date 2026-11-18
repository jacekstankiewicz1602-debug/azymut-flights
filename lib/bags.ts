// The price with one checked bag (20–23 kg) per person on every ticket. The free sources do not quote bag
// fees per flight, so the fees come from the airlines' published price ranges by flight length (marked
// as estimated); a search run "z bagażem rejestrowanym" already has them in its prices (Kiwi prices the
// bag itself, the low-cost calendars add the published fee).
import { AP, km } from "./airports";
import type { Trip, TripLeg } from "./engine";
import type { SearchParams } from "./types";

const ground = (l: TripLeg) => l.source === "flixbus" || l.source === "local" || l.source === "ground";

/** One checked bag on one flight, PLN, by distance: [< 1000 km, < 2000 km, < 3500 km, longer]. */
const LOWCOST: [RegExp, number[]][] = [
  [/ryanair|buzz|malta air|lauda/i, [150, 190, 230, 230]],
  [/wizz/i, [160, 210, 260, 300]],
  [/easyjet/i, [140, 180, 220, 220]],
  [/norse|level|french bee|arajet|jetsmart|sky airline|wingo|world2fly|plus ultra|flair|spirit|frontier|scoot|airasia|indigo|zipair|play\b/i, [150, 200, 260, 320]],
  [/vueling|transavia|eurowings|norwegian|volotea|jet2|pegasus|sunexpress|flydubai|air arabia|flynas|smartwings|airbaltic|aegean|iberia express|condor|corendon|enter air|bluebird|ajet/i, [140, 180, 230, 280]],
];
/** Full-service economy on short flights is often a "light" fare without a bag; long-haul includes one. */
const FULL_SHORT = 140;
const LONG_KM = 2500;

const dist = (l: TripLeg) => (AP[l.from] && AP[l.to] ? km(AP[l.from], AP[l.to]) : 1500);
const tier = (d: number) => (d < 1000 ? 0 : d < 2000 ? 1 : d < 3500 ? 2 : 3);
const lowcostFee = (carrier: string, d: number) => {
  const first = carrier.split(" + ")[0];
  const hit = LOWCOST.find(([re]) => re.test(first));
  return hit ? hit[1][tier(d)] : null;
};

/** One checked bag on a single flight option (a Google one-way, possibly with stops on one ticket), PLN. */
export function optionBagFee(o: { carrier?: string; from: string; to: string }): number {
  const d = AP[o.from] && AP[o.to] ? km(AP[o.from], AP[o.to]) : 1500;
  const lc = lowcostFee(o.carrier ?? "", d);
  return lc ?? (d > LONG_KM ? 0 : FULL_SHORT);
}

/** Does the source's price already include the bag in a search with a checked bag? */
const bagInPrice = (l: TripLeg) => l.source === "kiwi" || l.source === "ryanair" || l.source === "wizz" || l.bag !== undefined;

/**
 * trip.bagPrice: the total with one checked bag per person on every ticket; bagEstimated when a fee is an
 * estimate. In a search with a checked bag the fees the sources did not include are added to the legs
 * themselves (leg.bag), so the trip's own price is the total with the bag: every comparison, the ranking
 * and the Google comparison are like for like, and a trip rebuilt from some of its legs keeps the right fees.
 */
export function withBags(t: Trip, p: Pick<SearchParams, "baggage" | "pax">): Trip {
  const pax = Math.max(1, p.pax ?? 1);
  const checkedSearch = p.baggage === "checked";
  const fees = new Map<number, number>(); // leg index -> fee for all passengers
  let estimated = false;
  // full-service: one bag per ticket and direction, free when the ticket has a long-haul flight
  const fullDone = new Set<string>();
  const key = (l: TripLeg) => `${l.ticket ?? l.link}|${l.dir}`;
  const longTicket = new Set(t.legs.filter((l) => !ground(l) && dist(l) > LONG_KM).map(key));
  t.legs.forEach((l, i) => {
    if (ground(l)) return; // FlixBus and trains include a hold bag
    if (checkedSearch && bagInPrice(l)) { if (l.source !== "kiwi") estimated = true; return; }
    const lc = lowcostFee(l.carrier ?? "", dist(l));
    if (lc !== null) { fees.set(i, lc * pax); estimated = true; return; }
    const k = key(l);
    if (longTicket.has(k) || fullDone.has(k)) return;
    fullDone.add(k);
    fees.set(i, FULL_SHORT * pax);
    estimated = true;
  });
  const fee = [...fees.values()].reduce((a, b) => a + b, 0);
  if (!checkedSearch) return { ...t, bagPrice: Math.round(t.price + fee), bagEstimated: estimated };
  const legs = t.legs.map((l, i) => (fees.has(i) ? { ...l, price: l.price + fees.get(i)!, bag: fees.get(i)! } : l));
  const total = Math.round(t.price + fee);
  return { ...t, legs, price: total, bagPrice: total, bagEstimated: estimated };
}
