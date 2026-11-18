// Exchange rates for pricing on foreign markets: one free daily table (open.er-api.com, no key),
// cached for a day in the shared response cache.
import { cachedJson, fetchJson } from "./sources/http";

/** Units of each currency per 1 PLN. */
export async function ratesPln(): Promise<Record<string, number> | null> {
  const { value } = await cachedJson<Record<string, number>>(`fx:PLN:${new Date().toISOString().slice(0, 10)}`, 26 * 3600, async () => {
    const j = (await fetchJson("https://open.er-api.com/v6/latest/PLN").catch(() => null)) as { result?: string; rates?: Record<string, number> } | null;
    return j?.result === "success" && j.rates ? j.rates : null;
  });
  return value;
}

export const toPln = (amount: number, currency: string, rates: Record<string, number>) =>
  currency === "PLN" ? amount : rates[currency] ? amount / rates[currency] : Infinity;

/** Markets a long leg is priced on: Kiwi market code, currency, Polish adjective ("na rynku kolumbijskim"). */
export const MARKETS: { cc: string; currency: string; label: string }[] = [
  { cc: "pl", currency: "PLN", label: "polskim" }, { cc: "es", currency: "EUR", label: "hiszpańskim" },
  { cc: "pt", currency: "EUR", label: "portugalskim" }, { cc: "pe", currency: "PEN", label: "peruwiańskim" },
  { cc: "co", currency: "COP", label: "kolumbijskim" }, { cc: "br", currency: "BRL", label: "brazylijskim" },
  { cc: "mx", currency: "MXN", label: "meksykańskim" }, { cc: "us", currency: "USD", label: "amerykańskim" },
  { cc: "tr", currency: "TRY", label: "tureckim" }, { cc: "in", currency: "INR", label: "indyjskim" },
];
