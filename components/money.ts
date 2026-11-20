"use client";
// Prices: the engine and the server work in PLN; the display converts to the chosen currency.
// English defaults to EUR, Polish to PLN; any currency of the rates list can be picked (and is kept).
// Text with "… zł" in it (dictionaries, server notes) is converted by the filter set in i18n.
import { getLang, locale, refreshText, setTextFilter } from "./i18n";

const KEY = "azymut-currency";
let chosen: string | null | undefined; // undefined: not read from storage yet
let fx: Record<string, number> | null = null;
let loading = false;

function stored(): string | null {
  if (chosen === undefined) {
    try { chosen = localStorage.getItem(KEY); } catch { chosen = null; }
  }
  return chosen;
}

function loadRates() {
  if (fx || loading || typeof window === "undefined") return;
  loading = true;
  fetch("/api/rates").then((r) => (r.ok ? r.json() : null))
    .then((j: { rates?: Record<string, number> } | null) => { if (j?.rates) { fx = j.rates; refreshText(); } })
    .catch(() => {}).finally(() => { loading = false; });
}

/** The currency wanted (stored choice, else by language), even before the rates have loaded. */
export function wantedCurrency(): string {
  return stored() ?? (getLang() === "en" ? "EUR" : "PLN");
}

/** The currency shown now: the wanted one once its rate is known, PLN until then. */
export function currency(): string {
  if (typeof window === "undefined") return "PLN";
  const c = wantedCurrency();
  if (c === "PLN") return c;
  if (!fx) loadRates();
  return fx?.[c] ? c : "PLN";
}

export function setCurrency(c: string) {
  chosen = c;
  try { localStorage.setItem(KEY, c); } catch { /* private mode */ }
  if (c !== "PLN") loadRates();
  refreshText();
}

/** Every currency with a rate (PLN first), for the picker; loads the rates on first use. */
export function currencies(): string[] {
  loadRates();
  return ["PLN", ...Object.keys(fx ?? {}).filter((c) => c !== "PLN").sort()];
}

/** A PLN amount in the shown currency. */
export const conv = (pln: number) => { const c = currency(); return c === "PLN" ? pln : pln * fx![c]; };

/** A PLN amount for display: "1 234 zł", "€289", "US$312". */
export function money(pln: number): string {
  const c = currency();
  if (c === "PLN") return `${Math.round(pln).toLocaleString("pl-PL").replace(/,/g, " ")} zł`;
  const v = conv(pln);
  const d = Math.abs(v) < 10 ? 2 : 0;
  try {
    return new Intl.NumberFormat(locale(), { style: "currency", currency: c, minimumFractionDigits: d, maximumFractionDigits: d }).format(v);
  } catch {
    return `${Math.round(v).toLocaleString(locale())} ${c}`;
  }
}

/** The shown currency's sign ("zł", "€", "US$"). */
export function currencySign(): string {
  const c = currency();
  if (c === "PLN") return "zł";
  try {
    return new Intl.NumberFormat(locale(), { style: "currency", currency: c }).formatToParts(0).find((p) => p.type === "currency")?.value ?? c;
  } catch { return c; }
}

/** "EUR · euro" in the interface language. */
export function currencyName(c: string): string {
  try { return `${c} · ${new Intl.DisplayNames([locale()], { type: "currency" }).of(c) ?? ""}`.replace(/ · $/, ""); } catch { return c; }
}

/** A price typed in the shown currency back to PLN (filters). */
export const toPln = (v: number) => { const c = currency(); return c === "PLN" ? v : v / fx![c]; };

// "1 234 zł", "−420 zł", "1,234 zł" inside a text → the shown currency; a bare "zł" (as in "zł/os.") → its sign
const AMOUNT = /(\d{1,3}(?:[   ,]\d{3})+|\d+)(?:[.,]\d{1,2})?\s?zł(?![\p{L}])/gu;
const BARE = /(^|[^\p{L}])zł(?![\p{L}])/gu;
setTextFilter((s) => {
  if (!s.includes("zł") || currency() === "PLN") return s;
  return s.replace(AMOUNT, (_, n: string) => money(Number(n.replace(/[   ,]/g, "")))).replace(BARE, (_, pre: string) => pre + currencySign());
});
