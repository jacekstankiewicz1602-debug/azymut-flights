// Interface language: Polish (the source text) or English. Strings stay written in Polish in the code
// and t("…") looks up the English version; text that comes from the server (engine phases, notes,
// flags) goes through tx(), which also knows the patterns with numbers and places in them.
import { useSyncExternalStore } from "react";
import { EN_APP } from "./i18n/en-app";
import { EN_UI } from "./i18n/en-ui";
import { EN_SERVER, SERVER_PATTERNS } from "./i18n/en-server";

export type Lang = "pl" | "en";
const KEY = "azymut-lang";
const EN: Record<string, string> = { ...EN_SERVER, ...EN_UI, ...EN_APP };

// "pl" while the page hydrates (the server renders Polish); the stored or browser language right after
let lang: Lang = "pl";
const subs = new Set<() => void>();

export function storedLang(): Lang {
  try {
    const s = localStorage.getItem(KEY);
    if (s === "pl" || s === "en") return s;
  } catch { /* private mode */ }
  return typeof navigator !== "undefined" && !/^pl\b/i.test(navigator.language) ? "en" : "pl";
}
export function getLang(): Lang { return lang; }
export function setLang(l: Lang, remember = true) {
  if (remember) try { localStorage.setItem(KEY, l); } catch { /* private mode */ }
  if (l === lang) return;
  lang = l;
  document.documentElement.lang = l;
  subs.forEach((f) => f());
}
export function useLang(): Lang {
  return useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f); }; }, () => lang, () => "pl");
}

const fill = (s: string, vars?: Record<string, string | number>) => (vars ? s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : s);

/** UI text: written in Polish with {name} placeholders; the English version from the dictionaries. */
export function t(pl: string, vars?: Record<string, string | number>): string {
  return fill(lang === "en" ? EN[pl] ?? pl : pl, vars);
}

/** Text from the server (engine messages, notes, flags): exact matches first, then the patterns. */
export function tx(text: string | null | undefined): string {
  if (!text || lang === "pl") return text ?? "";
  const hit = EN[text] ?? EN[text.replace(/[.…]+$/, "")];
  if (hit) return hit;
  let out = text;
  for (const [re, to] of SERVER_PATTERNS) out = out.replace(re, to as never);
  return out;
}

/** "1 lotnisko / 2 lotniska / 5 lotnisk" in Polish, "1 airport / 2 airports" in English. */
export function plural(n: number, pl: [string, string, string], en: [string, string]): string {
  if (lang === "en") return n === 1 ? en[0] : en[1];
  const d = n % 10, h = n % 100;
  return n === 1 ? pl[0] : d >= 2 && d <= 4 && (h < 12 || h > 14) ? pl[1] : pl[2];
}

/** Locale for dates and numbers. */
export const locale = () => (lang === "en" ? "en-GB" : "pl-PL");
