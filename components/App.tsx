"use client";
import dynamic from "next/dynamic";
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { SearchResult, Trip } from "@/lib/engine";
import type { SearchParams } from "@/lib/types";
import { AIRPORT_POS, ccOf, countryName, fmtDate, fmtPln, fmtTime } from "./geo";
import { SearchFormPanel, toSearchForm, type FormState } from "./Form";
import { AnywherePanel, openAnywhere } from "./Anywhere";
import { feedLine, type FeedLine } from "./feed";
import { getState, isPhone, liveArcs, markBest, PEEK_H, resetSearch, setState, sheetPx, sheetSnap, touchArc, useIsPhone, useStore, type Pin, type State, type Stats } from "./store";
import { enablePush, pushState, refreshPush, type PushState } from "./push";
import { locale, plural as plu, setLang, storedLang, t as tr, tx, useLang } from "./i18n";
import { bagOf, bookings, plural, carrierCode, cityOf as tripCity, connBefore, dur, ICONS, isGround as groundLeg, isOneTicket, logoUrl, ticketNumbers } from "./trip-info";

const Scene = dynamic(() => import("./earth/Earth"), { ssr: false });

/** Translated text with React nodes in its {placeholders} (bold prices inside a sentence). */
function rich(key: string, nodes: Record<string, ReactNode>) {
  return tr(key).split(/\{(\w+)\}/).map((p, i) => (i % 2 ? <Fragment key={i}>{nodes[p]}</Fragment> : p));
}

const EXAMPLES = [
  "z Polski do Peru, luty, tam i z powrotem",
  "z Polski do Azji Płd.-Wsch., marzec, w jedną stronę",
  "Poza Europę, w jedną stronę, do 1 200 zł, dowolnie do maja",
];

const b64url = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// ---------------------------------------------------------------- search flow

let source: EventSource | null = null;

async function startSearch(q: string, overrides: Partial<SearchParams> = {}, from?: string) {
  source?.close();
  resetSearch();
  setState({ phase: "parsing", message: "Rozumiem zapytanie" });
  const res = await fetch("/api/parse", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ q, overrides, from }) });
  if (res.status === 401) { location.href = "/login"; return; }
  const parsed = (await res.json()) as { params: SearchParams; via: string; problems: string[] };
  setState({ params: parsed.params, parseVia: parsed.via, problems: parsed.problems });
  if (!parsed.params.dest.length) { setState({ phase: "error", message: parsed.problems.join(" · ") || "Nie rozpoznano celu" }); return; }
  runSearch(parsed.params);
}

/** The form is the primary input: structured fields, parsed without the language model. */
async function startForm(f: FormState) {
  source?.close();
  resetSearch();
  setState({ phase: "parsing", message: "Przygotowuję wyszukiwanie" });
  const res = await fetch("/api/parse", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ q: "form", form: toSearchForm(f) }) });
  if (res.status === 401) { location.href = "/login"; return; }
  const parsed = (await res.json()) as { params: SearchParams; via: string; problems: string[] };
  setState({ params: parsed.params, parseVia: null, problems: parsed.problems });
  if (!parsed.params.dest.length || parsed.problems.length) { setState({ phase: "error", message: parsed.problems.join(" · ") || "Nie rozpoznano celu" }); return; }
  runSearch(parsed.params);
}

type Live = {
  status: "running" | "done" | "limit" | "stopped" | "error"; trips: Trip[]; stats: Partial<Stats> & { bySource?: Record<string, number> } | null;
  gap: number | null; lowerBound: number | null; notes: string[]; baseline: SearchResult["baseline"]; summary: string | null;
  error: string | null; message: string | null; elapsed: number; steps: number; params: SearchParams;
  runner?: string; worker?: { online: boolean; busyWith?: string | null } | null;
  events: { seq: number; event: string; [k: string]: any }[];
};

let poll: ReturnType<typeof setTimeout> | null = null;
/** The last search started in this browser (stopped when the next one starts). */
const LAST_KEY = "azymut-last-search";

/** Start a resumable background search and follow it (the server keeps going in ~165 s steps). */
async function runSearch(params: SearchParams) {
  source?.close();
  if (poll) clearTimeout(poll);
  liveArcs.clear();
  setState({ phase: "searching", message: "Uruchamiam wyszukiwanie w tle", params, best: null, result: null, stats: { paid: 0, free: 0, costUsd: 0, checked: 0, pruned: 0, best: null }, selected: null, journeyPhase: "none", feed: [] });
  void fetch("/api/search/estimate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(params) })
    .then((r) => (r.ok ? r.json() : null)).then((e) => e && setState({ estimate: e })).catch(() => {});
  try { if ("Notification" in window && Notification.permission === "default") void Notification.requestPermission(); } catch { /* unsupported */ }
  // a new search from this browser replaces the one it started before (still running or not: the
  // server stops only a running one), so an old search never holds the worker for nothing
  const prev = (() => { try { return localStorage.getItem(LAST_KEY); } catch { return null; } })();
  if (prev) await fetch("/api/search/stop", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: prev }) }).catch(() => null);
  const res = await fetch("/api/search/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(params) });
  if (res.status === 401) { location.href = "/login"; return; }
  const { id, error } = await res.json();
  if (!id) { setState({ phase: "error", message: error ?? "Nie udało się uruchomić wyszukiwania" }); return; }
  try { localStorage.setItem(LAST_KEY, id); } catch { /* private mode */ }
  followed = id;
  history.pushState(null, "", `#s=${id}`);
  follow(id);
}

function follow(id: string) {
  let since = 0;
  let lastMsg = "";
  let prunedFlick = 0;
  const tick = async () => {
    const r = await fetch(`/api/search/status?id=${id}&since=${since}`).catch(() => null);
    if (!r || !r.ok) { poll = setTimeout(tick, 3000); return; }
    const d = (await r.json()) as Live;
    const lines: FeedLine[] = [];
    // a new phase of the search is a line of its own
    if (d.status === "running" && d.message && d.message !== lastMsg) { lastMsg = d.message; lines.push({ id: -Date.now(), src: "", tag: "phase", route: d.message, dates: "", note: "" }); }
    for (const e of d.events) {
      since = Math.max(since, e.seq);
      if (e.event === "q") {
        lines.push(feedLine(e.seq, e.key, e.cached, e.ms, e.n));
      } else if (e.event === "leg") touchArc(e.from, e.to, e.state === "dead" ? "rejected" : e.state === "ok" ? "ok" : "checking");
      else if (e.event === "candidate") { for (let i = 0; i < e.nodes.length - 1; i++) if (e.nodes[i] !== e.nodes[i + 1]) touchArc(e.nodes[i], e.nodes[i + 1], "checking"); }
      else if (e.event === "verified") {
        if (e.status === "pruned" && ++prunedFlick % 10 !== 0) continue;
        for (let i = 0; i < e.nodes.length - 1; i++) if (e.nodes[i] !== e.nodes[i + 1]) touchArc(e.nodes[i], e.nodes[i + 1], e.status === "ok" ? "ok" : "rejected");
      }
    }
    const running = d.status === "running";
    const best = d.trips[0] ?? null;
    if (!running && getState().live?.status === "running") notifyDone(d.status, best?.price ?? null, d.params);
    // the deep search found clearly cheaper than the preliminary result (once per search)
    const prelim = (d.stats as { prelim?: { price: number } } | null)?.prelim?.price;
    if (running && best && prelim && best.price <= prelim * 0.95 && dropNotified !== id) {
      dropNotified = id;
      notifyDrop(prelim, best.price, d.params);
    }
    // dripped in over the poll interval, each with its arc on the globe: a steady flow, not bursts
    const gap = lines.length ? Math.min(350, 1400 / lines.length) : 0;
    lines.forEach((l, k) => setTimeout(() => {
      if (followed !== id) return;
      if (l.tag !== "phase" && !l.hit && l.from && l.to && l.from !== l.to) touchArc(l.from, l.to, "checking");
      setState((s) => ({ feed: [...s.feed, { ...l, at: Date.now() }].slice(-40) }));
    }, k * gap));
    if (best && getState().best?.id !== best.id) markBest(best.nodes);
    const result: SearchResult = {
      trips: d.trips, baseline: d.baseline, savings: d.baseline && best ? Math.round(d.baseline.price - best.price) : null,
      provenOptimal: d.status === "done", gap: d.gap, summary: d.summary ?? "", notes: d.notes,
      stats: { paid: 0, free: d.stats?.free ?? 0, costUsd: 0, bySource: d.stats?.bySource ?? {}, checked: d.stats?.checked ?? 0, pruned: d.stats?.pruned ?? 0, ms: d.elapsed * 1000 },
      paused: running, lowerBound: d.lowerBound, unverified: 0, truncated: false,
      reasonable: (d.stats as { reasonable?: Trip | null } | null)?.reasonable ?? null,
      strategist: (d.stats as { strategist?: SearchResult["strategist"] } | null)?.strategist,
    };
    setState((s) => ({
      params: s.params ?? d.params,
      phase: running ? "searching" : d.status === "error" ? "error" : "done",
      message: d.status === "error" ? `Błąd: ${d.error}` : running ? (d.message ?? "Szukam") : d.status === "done" ? (d.params?.mode === "anywhere" ? "Lista gotowa" : "Gotowe") : d.status === "stopped" ? "Zatrzymano – pokazuję najlepszy znaleziony wynik" : "Zatrzymano na limicie",
      best, result: d.trips.length || !running ? result : s.result,
      live: { gap: d.gap, lowerBound: d.lowerBound, elapsed: d.elapsed, steps: d.steps, status: d.status, runner: d.runner, worker: d.worker, extended: d.params?.extended ?? null,
        deep: (d.stats as { deep?: NonNullable<State["live"]>["deep"] } | null)?.deep ?? null },
      stats: { ...s.stats, ...(d.stats ?? {}), best: best?.price ?? null },
      panelOpen: s.panelOpen || (!!d.trips.length && s.result === null),
    }));
    // deep searches run for hours on the laptop: poll calmly
    // after "Zatrzymaj" the result shows at once; a few more polls pick up the worker's final best trips
    if (running || (d.status === "stopped" && Date.now() - stopAt < 20_000)) poll = setTimeout(tick, running && d.params?.depth === "deep" ? 5000 : 1500);
  };
  void tick();
}

/** Browser notification when a search the page was following finishes (the tab may be in the background). */
function notifyDone(status: string, price: number | null, params: SearchParams) {
  try {
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    const title = status === "error" ? tr("Azymut: wyszukiwanie przerwane") : `Azymut: ${params.originLabel} → ${params.destLabel}`;
    const body = price ? `${tr("Najtańsza trasa: {price}", { price: fmtPln(price * (params.pax ?? 1)) })}${status === "done" ? ` (${tr("sprawdzone wszystko")})` : ""}` : tr("Zobacz wynik");
    const n = new Notification(title, { body, icon: "/icon.svg", tag: "azymut-search" });
    n.onclick = () => { window.focus(); n.close(); };
  } catch { /* unsupported */ }
}

let dropNotified = "";
function notifyDrop(prelim: number, price: number, params: SearchParams) {
  try {
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    const pax = params.pax ?? 1;
    const n = new Notification(tr("Azymut: taniej o {amount}", { amount: fmtPln((prelim - price) * pax) }), {
      body: tr("{route}: {price} zamiast wstępnych {prelim}. Szukam dalej.", { route: `${params.originLabel} → ${params.destLabel}`, price: fmtPln(price * pax), prelim: fmtPln(prelim * pax) }),
      icon: "/icon.svg", tag: "azymut-drop",
    });
    n.onclick = () => { window.focus(); n.close(); };
  } catch { /* unsupported */ }
}

// reopen a running or finished search after a reload or a link (#s=<id>)
let followed = "";
function followHash() {
  const m = location.hash.match(/s=([\w-]+)/);
  // back to the start page: no search on screen
  if (!m && followed) { followed = ""; source?.close(); if (poll) clearTimeout(poll); resetSearch(); return; }
  if (!m || m[1] === followed) return;
  followed = m[1];
  source?.close();
  if (poll) clearTimeout(poll);
  liveArcs.clear();
  // another search's link in the same tab: drop the previous one's form, results and stats
  setState({ phase: "searching", message: "Wczytuję wyszukiwanie", params: null, best: null, result: null, stats: { paid: 0, free: 0, costUsd: 0, checked: 0, pruned: 0, best: null }, selected: null, journeyPhase: "none", feed: [] });
  follow(m[1]);
}
if (typeof window !== "undefined") {
  setTimeout(followHash, 0);
  window.addEventListener("hashchange", followHash);
}

function play(i: number) {
  setState((s) => ({ selected: i, focusLeg: null, journeyKey: s.journeyKey + 1, journeyPhase: "flying", journeyInline: false, panelOpen: false }));
}
/** Picking a trip flies it on the globe at once; the list and the form stay usable (another pick restarts,
 *  the same one again closes it). On a phone the sheet folds down so the flight is visible. */
const select = (i: number) => setState((s) => s.selected === i
  ? { selected: null, focusLeg: null, journeyPhase: "none" }
  // phone: the sheet folds to its top line and the whole route shows at once (the flight is "Animacja")
  : isPhone() ? { selected: i, focusLeg: null, journeyPhase: "none", panelOpen: false }
  : { selected: i, focusLeg: null, journeyKey: s.journeyKey + 1, journeyPhase: "flying", journeyInline: true, panelOpen: window.innerWidth > 900 ? s.panelOpen : false });

/** Open trip i of the list (the arrows in a card, ← → on the keyboard). */
function pickTrip(i: number) {
  const n = getState().result?.trips.length ?? 0;
  if (i < 0 || i >= n || getState().selected === i) return;
  select(i);
}
if (typeof window !== "undefined") window.addEventListener("keydown", (e) => {
  const t = e.target as HTMLElement | null;
  if (e.altKey || e.metaKey || e.ctrlKey || (t && (t.isContentEditable || /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName)))) return;
  const sel = getState().selected;
  if (e.key === "Escape" && sel !== null) setState({ selected: null, focusLeg: null, journeyPhase: "none" });
  if (sel === null) return;
  if (e.key === "ArrowRight" || e.key === "ArrowDown") { e.preventDefault(); pickTrip(sel + 1); }
  if (e.key === "ArrowLeft" || e.key === "ArrowUp") { e.preventDefault(); pickTrip(sel - 1); }
});

/** Inline icon (see trip-info ICONS). */
function Icon({ name, className = "ico" }: { name: keyof typeof ICONS; className?: string }) {
  return <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" dangerouslySetInnerHTML={{ __html: ICONS[name] }} />;
}

// ---------------------------------------------------------------- pieces

function Brand() {
  return (
    <header className="brand">
      <div className="wordmark">Azymut</div>
      <div className="toolbar">
        <nav className="nav-arrows" aria-label={tr("Poprzednie i następne wyszukiwanie")}>
          <button onClick={() => history.back()} aria-label={tr("Wstecz")} title={tr("Wstecz (poprzednie wyszukiwanie)")}><Icon name="arrow" className="ico flip" /></button>
          <button onClick={() => history.forward()} aria-label={tr("Dalej")} title={tr("Dalej")}><Icon name="arrow" className="ico" /></button>
        </nav>
        <i className="tb-sep" />
        <Recent />
        <button className="radar-btn" onClick={openAnywhere}>{tr("Gdziekolwiek tanio")}</button>
        <RadarButton />
      </div>
      <ThemeSwitch />
      <LangSwitch />
    </header>
  );
}

/** Dark / light: remembered on this device; the globe restyles itself (Earth listens for the event). */
function ThemeSwitch() {
  const [th, setTh] = useState<"dark" | "light">("dark");
  useEffect(() => { setTh(document.documentElement.dataset.theme === "light" ? "light" : "dark"); }, []);
  const set = (t: "dark" | "light") => { setTh(t); window.dispatchEvent(new CustomEvent("azymut-theme", { detail: t })); };
  return (
    <div className="theme-switch" role="group" aria-label={tr("Motyw")}>
      <button className={th === "dark" ? "on" : ""} aria-pressed={th === "dark"} onClick={() => set("dark")}><Icon name="moon" className="" /><span>{tr("Ciemny")}</span></button>
      <button className={th === "light" ? "on" : ""} aria-pressed={th === "light"} onClick={() => set("light")}><Icon name="sun" className="" /><span>{tr("Jasny")}</span></button>
    </div>
  );
}

/** Interface language: Polish or English, remembered on this device. */
function LangSwitch() {
  const lang = useLang();
  return (
    <div className="theme-switch lang-switch" role="group" aria-label={tr("Język")} style={{ marginLeft: 0 }}>
      <button className={lang === "pl" ? "on" : ""} aria-pressed={lang === "pl"} lang="pl" title="Polski" onClick={() => setLang("pl")}>PL</button>
      <button className={lang === "en" ? "on" : ""} aria-pressed={lang === "en"} lang="en" title="English" onClick={() => setLang("en")}>EN</button>
    </div>
  );
}

type RecentItem = { id: string; label: string; status: string; price: number | null; deep: boolean; at: string };
const ago = (iso: string) => {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  return m < 1 ? tr("teraz") : m < 60 ? tr("{n} min temu", { n: m }) : m < 1440 ? tr("{n} h temu", { n: Math.round(m / 60) }) : tr("{n} d temu", { n: Math.round(m / 1440) });
};

/** "Ostatnie": the latest searches, one click back to any of them. */
function useRecentItems(open: boolean) {
  const [items, setItems] = useState<RecentItem[] | null>(null);
  useEffect(() => {
    if (open) void fetch("/api/search/recent").then((r) => (r.ok ? r.json() : null)).then((d) => d && setItems(d.items)).catch(() => {});
  }, [open]);
  return items;
}

function RecentList({ items, onGo }: { items: RecentItem[] | null; onGo: (id: string) => void }) {
  if (!items) return <p className="rc-empty">{tr("Wczytuję…")}</p>;
  if (!items.length) return <p className="rc-empty">{tr("Brak wyszukiwań.")}</p>;
  return <>{items.map((it) => (
    <button key={it.id} role="menuitem" className={`rc-item ${it.id === followed ? "on" : ""}`} onClick={() => onGo(it.id)}>
      <span className={`rc-dot st-${it.status}`} />
      <span className="rc-label">{tx(it.label)}{it.deep ? <em> · research</em> : null}</span>
      <span className="rc-price mono">{it.price ? fmtPln(it.price) : it.status === "running" ? tr("szuka…") : "—"}</span>
      <span className="rc-ago">{ago(it.at)}</span>
    </button>
  ))}</>;
}

const goSearch = (id: string) => { if (id !== followed) location.hash = `s=${id}`; };

function Recent() {
  const [open, setOpen] = useState(false);
  const items = useRecentItems(open);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", close); document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", esc); };
  }, [open]);
  return (
    <div className="recent" ref={ref}>
      <button className={`radar-btn ${open ? "on" : ""}`} onClick={() => setOpen(!open)} aria-expanded={open} aria-haspopup="menu">{tr("Ostatnie")} <Icon name="chevron" className="ico chev" /></button>
      {open && <div className="recent-menu glass" role="menu"><RecentList items={items} onGo={(id) => { setOpen(false); goSearch(id); }} /></div>}
    </div>
  );
}

// ---------------------------------------------------------------- phone chrome
// Phone (≤ 720 px): the map fills the screen; on top a pill with the search (tap: the full form), a menu
// for theme and language, at the bottom the tabs and above them the results sheet (see Results).

/** "Poznań → Islandia · 23.12–31.12 · 1 os." */
function searchSummary(p: SearchParams | null): string {
  if (!p) return tr("Dokąd lecisz?");
  const d = (iso?: string) => (iso ? fmtDate(iso) : "");
  const dates = p.dateFrom ? `${d(p.dateFrom)}${p.dateTo && p.dateTo !== p.dateFrom ? `–${d(p.dateTo)}` : ""}` : "";
  return [`${p.originLabel} → ${p.destLabel}`, dates, tr("{n} os.", { n: p.pax ?? 1 })].filter(Boolean).join(" · ");
}

function PhoneMenu() {
  const [open, setOpen] = useState(false);
  return <>
    <button className="ph-round" onClick={() => setOpen(true)} aria-label={tr("Menu")}><Icon name="menu" className="" /></button>
    {open && <div className="ph-scrim" onClick={() => setOpen(false)}>
      <div className="ph-menu" role="dialog" aria-label={tr("Menu")} onClick={(e) => e.stopPropagation()}>
        <div className="ph-menu-head"><span className="ph-logo">Azymut</span>
          <button className="ph-round flat" onClick={() => setOpen(false)} aria-label={tr("Zamknij")}><Icon name="close" className="" /></button></div>
        <div className="ph-menu-row"><span>{tr("Motyw")}</span><ThemeSwitch /></div>
        <div className="ph-menu-row"><span>{tr("Język")}</span><LangSwitch /></div>
      </div>
    </div>}
  </>;
}

function PhoneRecent({ close }: { close: () => void }) {
  const items = useRecentItems(true);
  return (
    <div className="ph-scrim" onClick={close}>
      <div className="ph-sheet-panel" role="dialog" aria-label={tr("Ostatnie")} onClick={(e) => e.stopPropagation()}>
        <div className="ph-menu-head"><span className="ph-title">{tr("Ostatnie")}</span>
          <button className="ph-round flat" onClick={close} aria-label={tr("Zamknij")}><Icon name="close" className="" /></button></div>
        <div className="ph-sheet-scroll" role="menu"><RecentList items={items} onGo={(id) => { close(); goSearch(id); }} /></div>
      </div>
    </div>
  );
}

function PhoneTabs() {
  const [recent, setRecent] = useState(false);
  const radar = useRadarOpen();
  const journey = useStore((s) => s.journeyPhase !== "none" && !s.journeyInline);
  if (journey) return null;
  return <>
    <nav className="ph-tabs" aria-label={tr("Nawigacja")}>
      <button className={recent ? "on" : ""} onClick={() => setRecent(true)}><Icon name="clock" className="" /><span>{tr("Ostatnie")}</span></button>
      <button onClick={() => { setRadar(false); openAnywhere(); }}><Icon name="globe" className="" /><span>{tr("Gdziekolwiek")}</span></button>
      <button className={radar ? "on" : ""} onClick={() => setRadar(!radar)}><Icon name="radar" className="" /><span>{tr("Radar okazji")}</span></button>
    </nav>
    {recent && <PhoneRecent close={() => setRecent(false)} />}
  </>;
}

function Counter({ value, decimals = 0 }: { value: number; decimals?: number }) {
  const [shown, setShown] = useState(value);
  const ref = useRef(value);
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      ref.current += (value - ref.current) * 0.18;
      if (Math.abs(value - ref.current) < 0.5 / 10 ** decimals) ref.current = value;
      setShown(ref.current);
      if (ref.current !== value) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, decimals]);
  return <>{shown.toLocaleString(locale(), { minimumFractionDigits: decimals, maximumFractionDigits: decimals }).replace(/,(?=\d{3})/g, " ")}</>;
}

type ProgressInfo = { pct: number; etaSec: number | null; combos: number };
type BaselineStatus = { ok: boolean; source: string | null; note?: string };

const clock = (sec: number) => {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), x = Math.floor(sec % 60);
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(x).padStart(2, "0")}` : `${String(m).padStart(2, "0")}:${String(x).padStart(2, "0")}`;
};
const eta = (sec: number) => sec < 60 ? "< 1 min" : sec < 3600 ? `~${Math.round(sec / 60)} min` : `~${Math.floor(sec / 3600)} h ${Math.round((sec % 3600) / 60)} min`;

let stopAt = 0;
async function stopSearch() {
  const id = followed;
  if (!id) return;
  stopAt = Date.now();
  setState({ message: "Zatrzymuję – za chwilę pokażę wynik" });
  await fetch("/api/search/stop", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id }) }).catch(() => null);
}

/** A city picked on a region's list gets its own full search (separate tickets, hubs, the Google
 *  offer), same dates: the list is a shallow preview, the city's search finds the real cheapest. */
async function searchCity(city: string, code: string) {
  const s = getState(), p = s.params;
  if (!p) return;
  if (s.live?.status === "running") await stopSearch(); // the worker runs one search at a time
  const codes = p.dest.filter((c) => tripCity(c) === tripCity(code));
  history.pushState(null, "", location.hash); // "back" returns to the region's list
  const q: SearchParams = { ...p, dest: codes.length ? codes : [code], destLabel: city, query: `${p.originLabel} → ${city}` };
  delete q.mode; delete q.budget; delete q.destRet; delete q.destRetLabel;
  void runSearch(q);
}

/** Engine phase messages are technical: show the person what it means for them. */
function friendly(message: string, prelim: number | null, cheaper: boolean, running: boolean) {
  if (!running) return say(message);
  if (/kolejce|worker|Wczytuję|Uruchamiam|Rozumiem|Przygotowuję|Zatrzymuję/i.test(message)) return say(message);
  if (cheaper) return tr("Znalazłem taniej niż wstępnie – szukam dalej…");
  return prelim !== null ? tr("Wstępnie: {price} · szukam taniej…", { price: fmtPln(prelim) }) : tr("Szukam najtańszej trasy");
}

/** The status line is kept in Polish in the store (phase checks match on it) and translated for display. */
function say(message: string) {
  if (message.startsWith("Błąd: ")) return tr("Błąd: {error}", { error: tx(message.slice(6)) });
  const whole = tx(message);
  return whole !== message ? whole : message.split(" · ").map(tx).join(" · ");
}

/** "−240 zł vs wstępny", replayed (price-drop animation) whenever the price falls again. */
function DropChip({ prelim, best }: { prelim: number; best: number }) {
  return <span key={best} className="pg-drop mono">{tr("−{amount} vs wstępny", { amount: fmtPln(prelim - best) })}</span>;
}

function Progress() {
  const live = useStore((x) => x.live);
  const s = useStore((x) => x.stats);
  const phase = useStore((x) => x.phase);
  const message = useStore((x) => x.message);
  const result = useStore((x) => x.result);
  const p = useStore((x) => x.params);
  const est = useStore((x) => x.estimate);
  const anywhere = p?.mode === "anywhere";
  if (phase === "idle") return null;
  const ext = s as typeof s & { progress?: ProgressInfo; baselineStatus?: BaselineStatus; phase?: "quick" | "full"; prelim?: { price: number; sec: number } | null };
  const done = live?.status === "done";
  const running = live?.status === "running" || phase === "parsing" || (phase === "searching" && !live);
  const best = s.best;
  const pax = p?.pax ?? 1;
  let pct = done ? 100 : ext.progress ? Math.max(1, Math.min(99.9, ext.progress.pct))
    : best && live?.lowerBound ? Math.max(4, Math.min(99, (live.lowerBound / best) * 100)) : phase === "parsing" ? 2 : 4;
  const google = result?.baseline?.price ?? null;
  const gb = result?.baseline as (NonNullable<SearchResult["baseline"]> & { flight?: number; access?: number }) | null | undefined;
  const bs = ext.baselineStatus;
  // "taniej się nie da" only for a finished proof; a stopped or limited search keeps its bound (or none)
  const gap = done ? 0 : live?.gap != null && live.gap > 0 ? live.gap : null;
  // stage 1 result (engine's stats.prelim; older searches: the first price once the quick phase is over)
  const prelim = anywhere ? null : ext.prelim?.price ?? (best !== null && ext.phase === "full" ? best : null);
  // time left: the engine's estimate, else the research cap, else from the pace so far, else similar searches
  const elapsed = live?.elapsed ?? 0;
  const cap = p?.depth === "deep" && p.researchMin ? p.researchMin * 60 : null;
  if (cap && running) pct = Math.max(pct, Math.min(99, (elapsed / cap) * 100));
  const guess = cap ? Math.max(0, cap - elapsed) : ext.progress?.etaSec ?? (pct >= 5 && elapsed > 20 ? (elapsed * (100 - pct)) / pct : est ? Math.max(60, est.fullSec - elapsed) : null);
  // a quick search stops at its time limit (~12 min) whatever the pace says
  // the background extension is decided by the worker mid-search: it comes with the status, not the form
  const extMin = live?.extended ?? p?.extended ?? 0;
  const left = guess != null && p?.depth !== "deep" && live?.runner === "worker" ? Math.min(guess, Math.max(0, FAST_SEC + extMin * 60 - elapsed)) : guess;
  // the percent agrees with the clock: never below the share of time already spent
  if (running && left != null && elapsed > 30) pct = Math.max(pct, Math.min(99, (elapsed / (elapsed + left)) * 100));
  const bySrc = ((s as { bySource?: Record<string, number> }).bySource ?? {}) as Record<string, number>;
  const srcs = Object.entries(bySrc).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  const queries = srcs.reduce((n, [, v]) => n + v, 0) || s.free + s.paid;
  const cheaper = prelim !== null && best !== null && best < prelim;
  return (
    <div className={`progress ${running ? "is-running" : "is-done"}`}>
      <div className="pg-top">
        <div className={`pg-msg ${running ? "pulse" : ""} ${phase === "error" ? "err" : ""}`}>{friendly(message, prelim !== null ? prelim * pax : null, cheaper, running)}</div>
        {live?.status === "running" && !anywhere && <button className="pg-stop" onClick={() => void stopSearch()}>{tr("Zatrzymaj i pokaż wynik")}</button>}
      </div>
      {running && <div className="pg-hero">
        <Ring pct={pct} />
        <div className="pg-hero-txt">
          <div className="pg-left mono">{left != null ? (left < 60 ? "< 1 min" : `${Math.round(left / 60)} min`) : "…"}</div>
          <div className="pg-k">{left != null ? tr("do końca (szacunek)") : tr("szacuję czas do końca")}</div>
          <div className="pg-time mono">
            <span>{clock(live?.elapsed ?? 0)}</span>
            <span><Counter value={queries} /> {tr("zapytań")}</span>
            {(ext.progress?.combos ?? 0) > 0 && <span><Counter value={ext.progress!.combos} /> {tr("kombinacji")}</span>}
          </div>
        </div>
      </div>}
      {running && <Feed queries={queries} />}
      {running && srcs.length > 0 && <div className="pg-src">{srcs.map(([k, v]) => <span key={k} className={`src-chip s-${k}`}><i />{SRC_NAME[k] ?? k} <b className="mono">{v}</b></span>)}</div>}
      <div className="pg-prices">
        <div><span className="pg-k">{running ? (cheaper || prelim === null ? tr("Najlepsza do tej pory") : tr("Wstępnie")) : tr("Najtańsza trasa")}</span>
          <span className={`pg-v mono big ${cheaper ? "down" : ""}`}>{best !== null ? <><Counter key="b" value={best * pax} /> zł</> : "—"}</span>
          {cheaper && <DropChip prelim={prelim! * pax} best={best! * pax} />}</div>
        <div><span className="pg-k">Google</span><span className="pg-v mono">{google ? fmtPln(google * pax) : running ? (bs && !bs.ok ? tr("brak ceny") : tr("sprawdzam…")) : "—"}</span>
          {google && gb?.access ? <span className="pg-sub mono">{tr("z dojazdem {price}", { price: fmtPln(gb.access * pax) })}</span> : null}</div>
      </div>
      {!anywhere && best !== null && <p className={`pg-gap ${gap === 0 ? "ok" : ""}`}>
        {gap === 0 ? tr("Sprawdziłem wszystko: taniej się nie da.") : gap != null && gap > 0 ? <>{rich("Może być jeszcze do {gap} taniej", { gap: <b className="mono">{fmtPln(gap * pax)}</b> })}{running ? ` – ${tr("szukam")}` : ""}.</> : running ? tr("Szukam, czy da się taniej.") : tr("Nie sprawdziłem wszystkiego, może być taniej.")}
      </p>}
      {running && extMin ? <p className="pg-note">{tr("Szybkie 12 min nie wystarczyło do dowodu, więc szukam dalej w tle – do {n} min więcej. Najlepsza trasa jest już widoczna niżej.", { n: extMin })}</p> : null}
      {running && <NotifyMe />}
      {bs && !bs.ok && (running ? <p className="pg-warn">{tr("Brak ceny Google do porównania")}{bs.note ? `: ${tx(bs.note)}` : ""}.</p>
        : <p className="pg-note">{tr("Google Flights nie podał ceny na tę trasę, więc nie ma z czym porównać.")}</p>)}
      {p?.depth === "deep" && <DeepInfo />}
      {!running && live && <div className="pg-foot">{clock(live.elapsed)} · {(ext.progress?.combos ?? s.checked).toLocaleString(locale())} {tr("sprawdzonych kombinacji")} · $0{live.status === "stopped" ? ` · ${tr("zatrzymane przez Ciebie")}` : ""}</div>}
    </div>
  );
}

/** While a search runs: "notify me when it is done", so the app can be closed. */
function NotifyMe() {
  const [st, setSt] = useState<PushState | "busy" | null>(null);
  useEffect(() => { void pushState().then(setSt); }, []);
  if (st === null || st === "unsupported") return <p className="pg-note">{tr("Możesz zamknąć stronę – szukanie trwa dalej, a po powrocie zobaczysz aktualny wynik.")}</p>;
  if (st === "on") return <p className="pg-notify on"><Icon name="check" className="ico" />{tr("Dam znać powiadomieniem, gdy skończę – możesz zamknąć aplikację.")}</p>;
  if (st === "install") return <p className="pg-notify">{tr("Chcesz powiadomienie na iPhonie? Dodaj Azymut do ekranu początkowego (Udostępnij → Do ekranu początkowego) i szukaj z tej ikony.")}</p>;
  if (st === "denied") return <p className="pg-notify">{tr("Powiadomienia są zablokowane w ustawieniach przeglądarki dla tej strony. Szukanie i tak trwa dalej po zamknięciu.")}</p>;
  return (
    <button className="pg-notify btn-notify" disabled={st === "busy"} onClick={() => { setSt("busy"); void enablePush().then(setSt).catch(() => setSt("off")); }}>
      <Icon name="bell" className="ico" />{st === "busy" ? tr("Włączam…") : tr("Powiadom mnie, gdy skończy")}<span className="dim">· {tr("możesz zamknąć aplikację")}</span>
    </button>
  );
}

const FAST_SEC = 12 * 60;
const SRC_NAME: Record<string, string> = { kiwi: "Kiwi", google: "Google", ryanair: "Ryanair", wizz: "Wizz Air", flixbus: "FlixBus", aviasales: "Aviasales", kayak: "Kayak", serpapi: "SerpApi", duffel: "Duffel" };

/** Progress as a ring with the percentage inside. */
function Ring({ pct }: { pct: number }) {
  const r = 30, c = 2 * Math.PI * r; // progress; ticks and a scanning arc around and inside it
  return (
    <div className="pg-ring" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)} aria-label={tr("Postęp szukania")}>
      <svg viewBox="0 0 72 72" width="72" height="72">
        <circle cx="36" cy="36" r="35" className="rg-ticks" />
        <circle cx="36" cy="36" r={r} className="rg-bg" />
        <circle cx="36" cy="36" r="24" className="rg-scan" />
        <circle cx="36" cy="36" r={r} className="rg-fg" strokeDasharray={c} strokeDashoffset={c * (1 - pct / 100)} />
      </svg>
      <span className="mono">{Math.floor(pct)}<small>%</small></span>
    </div>
  );
}

/** The live query log: what the search is asking right now, newest at the bottom, in a small terminal. */
const hms = (t?: number) => (t ? new Date(t).toLocaleTimeString(locale(), { hour12: false }).slice(3) : "--:--");
function Feed({ queries }: { queries: number }) {
  const feed = useStore((x) => x.feed);
  // pace over the last 20 s of lines shown
  const now = feed.length ? feed[feed.length - 1].at ?? Date.now() : Date.now();
  const recent = feed.filter((l) => l.tag !== "phase" && (l.at ?? 0) > now - 20_000).length;
  const rate = Math.round((recent / 20) * 60);
  return (
    <div className="term">
      <div className="term-bar mono">
        <span className="term-live"><i />live</span>
        <span className="term-path">azymut@worker<span className="dim">{tr(":~/szukanie$")}</span></span>
        <span className="term-rate"><b>{rate}</b>/min · <b><Counter value={queries} /></b> {tr("zap.")}</span>
      </div>
      <div className="feed mono" aria-live="off">
        {!feed.length && <div className="fd-line phase"><span className="fd-route">{tr("łączę się ze źródłami")}<span className="fd-caret" /></span></div>}
        {feed.slice(-11).map((l, i, a) => {
          const last = i === a.length - 1;
          return l.tag === "phase"
            ? <div key={l.id} className="fd-line phase"><span className="fd-t">{hms(l.at)}</span><span className="fd-route">» {tx(l.route)}{last && <span className="fd-caret" />}</span></div>
            : <div key={l.id} className={`fd-line s-${l.tag} ${l.hit ? "hit" : ""} ${last ? "now" : ""}`}>
                <span className="fd-t">{hms(l.at)}</span>
                <span className="fd-src">{l.src}</span>
                <span className="fd-route">{l.route}</span>
                {l.dates && <span className="fd-dates">{l.dates}</span>}
                <span className="fd-note">{l.note}{last && <span className="fd-caret" />}</span>
              </div>;
        })}
      </div>
    </div>
  );
}

function RouteLine({ t }: { t: Trip }) {
  const dirs = (["out", "ret"] as const).map((d) => t.legs.filter((l) => l.dir === d)).filter((l) => l.length);
  return <>{dirs.map((legs, k) => (
    <div key={k} className="tr-route">
      <span className="ddir">{k === 0 ? tr("tam") : tr("powrót")}</span>
      {[legs[0].from, ...legs.map((l) => l.to)].map((c, i) => <span key={i} style={{ display: "contents" }}>{i > 0 && <Icon name="arrow" className="arrow" />}<span className="code" title={tripCity(c)}>{c}</span></span>)}
    </div>
  ))}</>;
}

function routeCodes(t: Trip) {
  const dirs: string[] = [];
  for (const d of ["out", "ret"] as const) {
    const legs = t.legs.filter((l) => l.dir === d);
    if (!legs.length) continue;
    dirs.push([legs[0].from, ...legs.map((l) => l.to)].join(" – "));
  }
  return dirs;
}

const isGround = (l: { source: string }) => l.source === "flixbus" || l.source === "local" || l.source === "ground";

/** Departure (and return) airport of a trip, and the bus / train to it from home (or back): price and duration. */
function access(t: Trip, dir: "out" | "ret") {
  const legs = t.legs.filter((l) => l.dir === dir);
  if (!legs.length) return null;
  const k = dir === "out" ? legs.findIndex((l) => !isGround(l)) : legs.length - 1 - [...legs].reverse().findIndex((l) => !isGround(l));
  if (k < 0 || k >= legs.length) return null;
  const bus = (dir === "out" ? legs.slice(0, k) : legs.slice(k + 1)).filter(isGround);
  const airport = dir === "out" ? legs[k].from : legs[k].to;
  const hours = bus.length ? (bus[bus.length - 1].arr - bus[0].dep) / 3_600_000 : 0;
  return { airport, city: AIRPORT_POS[airport]?.city ?? airport, cc: AIRPORT_POS[airport]?.cc ?? "", cost: bus.reduce((s, l) => s + l.price, 0), hours, bus: bus.length > 0 };
}

/** "Wylot z Berlina · dojazd 3 h 10 min, 74 zł" */
function accessText(a: NonNullable<ReturnType<typeof access>>, dir: "out" | "ret", counted: boolean) {
  const what = dir === "out" ? tr("Wylot z: {city}", { city: a.city }) : tr("Powrót na: {city}", { city: a.city });
  if (!a.bus) return what;
  return `${what} · ${tr("dojazd")} ${a.hours > 0 ? `${dur(a.hours)}, ` : ""}${counted ? fmtPln(a.cost) : tr("nieliczony")}`;
}

function AccessLine({ t }: { t: Trip }) {
  const p = useStore((s) => s.params);
  const out = access(t, "out"), ret = access(t, "ret");
  if (!out) return null;
  const counted = p?.access !== false;
  return (
    <div className="tr-access">
      <span>{accessText(out, "out", counted)}</span>
      {ret && <span>{accessText(ret, "ret", counted)}</span>}
    </div>
  );
}

/** On the card itself: a departure (or return) airport abroad, stated plainly. */
function AbroadLine({ t }: { t: Trip }) {
  const p = useStore((s) => s.params);
  const homeCc = AIRPORT_POS[p?.home ?? p?.origin[0] ?? ""]?.cc ?? "PL";
  const out = access(t, "out"), ret = access(t, "ret");
  const items = ([[out, "out"], [ret, "ret"]] as const).filter(([a]) => a && a.cc && a.cc !== homeCc);
  if (!items.length) return null;
  return <div className="tr-abroad">{items.map(([a, d]) => <span key={d}>{accessText(a!, d, p?.access !== false)}</span>)}</div>;
}

/** Flighty-style vertical timeline: times, carrier, duration, connections between legs, price per leg, sum. */
function Timeline({ t, pax }: { t: Trip; pax: number }) {
  const hotelOff = useStore((s) => s.params?.countHotel === false);
  const focus = useStore((s) => s.focusLeg);
  const refs = useRef<(HTMLDivElement | null)[]>([]);
  useEffect(() => { if (focus !== null) refs.current[focus]?.scrollIntoView({ block: "nearest", behavior: "smooth" }); }, [focus]);
  const ticketsPln = t.legs.filter((l) => !groundLeg(l)).reduce((a, l) => a + l.price, 0);
  const ground = t.legs.filter(groundLeg).reduce((a, l) => a + l.price, 0);
  const hotels = hotelOff ? 0 : t.legs.reduce((a, l) => a + (l.hotel ?? 0), 0);
  const tickets = ticketNumbers(t);
  const nTickets = Math.max(...tickets);
  return (
    <div className="tl">
      {t.legs.map((l, i) => {
        const c = connBefore(t, i, hotelOff);
        const cc = carrierCode(l);
        const h = (l.arr - l.dep) / 3_600_000;
        const dayShift = l.arrLocal.slice(0, 10) !== l.depLocal.slice(0, 10);
        return (
          <div key={i}>
            {i === 0 && <div className="tl-dir">{tr("Wylot")} · {fmtDate(t.outDate)}</div>}
            {c && c.kind === "turn" && <>
              <div className="tl-conn turn"><span /><span className="rail"><b /></span><div className="box"><Icon name="pin" /><b>{c.title}</b></div></div>
              <div className="tl-dir">{tr("Powrót")} · {fmtDate(t.retDate ?? l.depLocal.slice(0, 10))}</div>
            </>}
            {c && c.kind !== "turn" && (
              <div className={`tl-conn ${c.kind === "stay" ? "stay" : ""}`}>
                <span /><span className="rail"><b /></span>
                <div className="box">
                  <Icon name={c.kind === "stay" ? "bed" : "clock"} />
                  <span>{c.kind === "stay" ? <>{rich("{stay} w mieście {city}", { stay: <b>{c.title.split(" · ")[0]}</b>, city: c.city })}</> : <>{tr("Przesiadka")} · <b>{dur(c.gapH)}</b> · {c.city}</>}</span>
                  {c.chips.map((ch) => <span key={ch.label} className={`chip ${ch.tone}`}>{ch.icon && <Icon name={ch.icon} className="" />}{ch.label}</span>)}
                </div>
              </div>
            )}
            <div ref={(el) => { refs.current[i] = el; }} role="button" tabIndex={0} className={`tl-leg ${groundLeg(l) ? "ground" : ""} ${focus === i ? "on" : ""}`}
              onClick={() => setState((s) => ({ focusLeg: s.focusLeg === i ? null : i }))} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setState((s) => ({ focusLeg: s.focusLeg === i ? null : i })); } }}>
              <div className="tl-times"><span>{fmtTime(l.depLocal)}</span><span>{fmtTime(l.arrLocal)}{l.arrEstimated ? "*" : ""}{dayShift ? <sup> +1</sup> : null}</span></div>
              <div className="tl-rail"><i /><b /><i /></div>
              <div className="tl-body">
                <div className="tl-route">{tripCity(l.from)}<span className="code">{l.from}</span> → {tripCity(l.to)}<span className="code">{l.to}</span></div>
                <div className="tl-carrier">
                  {cc ? <img className="logo" src={logoUrl(cc)} alt="" loading="lazy" onError={(e) => { (e.target as HTMLImageElement).style.visibility = "hidden"; }} />
                    : <span className="logo-ph"><Icon name={groundLeg(l) ? "bus" : "plane"} className="" /></span>}
                  {nTickets > 1 && !groundLeg(l) && <span className="tl-ticket" title={tr("Odcinki z tym samym numerem są na jednym bilecie")}>{tr("bilet {n}", { n: tickets[i] })}</span>}
                  <span className="txt">{groundLeg(l) ? (l.source === "flixbus" ? `FlixBus · ${l.flightNo}` : l.source === "local" ? tr("zmiana lotniska (transfer)") : tr("autobus / pociąg (szac.)")) : `${l.carrier} ${l.flightNo}`.trim()} · {dur(h)}</span>
                </div>
                {(l.market || l.rtAsOw || l.note) && <div className="tl-tech">
                  {l.market && <div>{tr("kup na rynku {market} w {currency} ({amount} {currency})", { market: tx(l.market.label), currency: l.market.currency, amount: Math.round(l.market.local).toLocaleString(locale()) })}</div>}
                  {l.rtAsOw && <div>{tr("bilet tam i z powrotem użyty w jedną stronę (nie leć powrotnym)")}</div>}
                  {l.note && <div className="dim">{tx(l.note)}</div>}
                </div>}
              </div>
              <div className="tl-price">
                {l.price && l.price === l.bag ? <span className="incl">{tr("bagaż ~{price}", { price: fmtPln(l.bag * pax) })}</span>
                  : l.price ? <span>{fmtPln(l.price * pax)}{l.bag ? <small className="incl"> {tr("w tym bagaż ~{price}", { price: fmtPln(l.bag * pax) })}</small> : null}</span>
                  : <span className="incl">{tr("w cenie biletu")}</span>}
                <a href={l.link} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>{groundLeg(l) ? tr("trasa") : tr("kup")} ↗</a>
              </div>
            </div>
          </div>
        );
      })}
      <div className="tl-sum">
        <div><span>{tr("bilety lotnicze")} ({nTickets} {plu(nTickets, ["rezerwacja", "rezerwacje", "rezerwacji"], ["booking", "bookings"])})</span><span>{fmtPln(ticketsPln * pax)}</span></div>
        {ground > 0 && <div><span>{tr("dojazd i transfery")}</span><span>{fmtPln(ground * pax)}</span></div>}
        {hotels > 0 && <div><span>{tr("noclegi na postojach")}</span><span>{fmtPln(hotels * pax)}</span></div>}
        <div className="total"><span>{tr("Razem")}{pax > 1 ? ` ${tr("({n} os.)", { n: pax })}` : ""}</span><span>{fmtPln(t.price * pax)}</span></div>
      </div>
      {t.legs.some((l) => l.arrEstimated) && <div className="tl-note">{tr("* godzina przylotu wyliczona z odległości")}</div>}
    </div>
  );
}

/** "Wylot 3 dni później: −640 zł": the date picker's calendar near the best trip's departure. */
function CheaperDates() {
  const r = useStore((s) => s.result);
  const cal = useStore((s) => s.calendar);
  const p = useStore((s) => s.params);
  const t = r?.trips[0];
  if (!t || !p || p.mode === "anywhere" || p.dateMode === "exact") return null;
  const here = cal[t.outDate];
  if (!here) return null;
  let best: { d: number; price: number } | null = null;
  for (let d = -3; d <= 3; d++) {
    if (!d) continue;
    const day = new Date(Date.parse(t.outDate) + d * 86400_000).toISOString().slice(0, 10);
    const v = cal[day];
    if (v && v < here && (!best || v < best.price)) best = { d, price: v };
  }
  if (!best || here - best.price < 150) return null;
  const n = Math.abs(best.d);
  return (
    <p className="r-hint">{tr(best.d > 0 ? "Wylot {n} {days} później:" : "Wylot {n} {days} wcześniej:", { n, days: plu(n, ["dzień", "dni", "dni"], ["day", "days"]) })} <b className="mono">−{fmtPln((here - best.price) * (p.pax ?? 1))}</b> <span className="dim">({tr("kalendarz Google")})</span></p>
  );
}

const TECH_ORDER = ["strategist", "market", "rt-as-ow", "split", "hub-rt", "lowcost-hub", "radar", "memory", "separate"];

/** Deep search: rounds on the laptop worker, week by week, with a notification at the end. */
function DeepInfo() {
  const live = useStore((x) => x.live);
  const message = useStore((x) => x.message);
  if (!live) return null;
  const d = live.deep;
  const waiting = live.status === "running" && live.runner === "worker" && (!live.worker?.online || /czekam na worker|w kolejce/.test(message));
  return (
    <div className="pg-deep">
      {waiting
        ? <p>{live.worker?.online ? tr("Czeka w kolejce na workerze (najpierw kończy poprzednie wyszukiwanie).") : tr("Worker na laptopie jest wyłączony: wyszukiwanie czeka w kolejce i ruszy, gdy go uruchomisz (npm run worker).")}</p>
        : d ? <p className="mono">{tr("runda {n}", { n: d.round })}{d.chunks.length > 1 ? ` · ${tr("tydzień {i}/{n}", { i: d.chunk + 1, n: d.chunks.length })} (${fmtDate(d.chunks[d.chunk][0])} – ${fmtDate(d.chunks[d.chunk][1])}) · ${tr("{done}/{n} tygodni z dowodem", { done: d.proven.filter(Boolean).length, n: d.chunks.length })}` : ` · ${fmtDate(d.chunks[0][0])} – ${fmtDate(d.chunks[0][1])}, ${tr("każdy dzień")}`}</p> : null}
      {live.status === "running" && <p className="dim">{tr("Tryb głęboki może trwać kilka godzin. Możesz zamknąć przeglądarkę – dostaniesz powiadomienie.")}</p>}
      {live.status === "running" && <p className="dim">worker: {live.worker?.online ? "online" : "offline"}</p>}
    </div>
  );
}

/** The cheapest trip vs the cheapest "rozsądna" one (≤ 24 h and ≤ 3 connections per direction). */
function Reasonable({ r, pax }: { r: SearchResult; pax: number }) {
  const t = r.reasonable, best = r.trips[0];
  if (!best) return null;
  if (!t) return <p className="r-note">{tr("Nie znaleziono trasy rozsądnej (do 24 h i maks. 3 przesiadki w każdą stronę) wśród sprawdzonych.")}</p>;
  if (t.id === best.id || t.price <= best.price) return <p className="r-note">{tr("Najtańsza trasa jest też rozsądna (do 24 h i maks. 3 przesiadki w każdą stronę).")}</p>;
  return (
    <div className="reasonable">
      <div className="tr-top">
        <span className="rs-k">{tr("najtańsza rozsądna")}</span>
        <span className="mono tr-price">{fmtPln(t.price * pax)}</span>
        <span className="mono tr-save neg">{tr("+{amount} vs najtańsza", { amount: fmtPln((t.price - best.price) * pax) })}</span>
      </div>
      <RouteLine t={t} />
      <div className="tr-meta">{fmtDate(t.outDate)}{t.retDate ? ` – ${fmtDate(t.retDate)} · ${t.stayDays} ${plu(t.stayDays ?? 0, ["dzień", "dni", "dni"], ["day", "days"])}` : ""} · {tr("{h} h w drodze", { h: t.travelH })} · {tr("do 24 h i maks. 3 przesiadki w każdą stronę")}</div>
    </div>
  );
}

function StrategistLine({ r }: { r: SearchResult }) {
  const s = r.strategist;
  if (!s?.checked) return null;
  const won = s.hypotheses.filter((h) => h.won);
  const live = s.hypotheses.filter((h) => h.status === "ok").length;
  return <p className="r-note">{tr("Strateg: {n} hipotez, {live} potwierdzonych na żywo", { n: s.checked, live })}{won.length ? tr(", wygrała: {list}", { list: won.map((h) => tx(h.label)).join("; ") }) : tr(", żadna nie pobiła najlepszej trasy")}.</p>;
}

/** Connections in one direction: between flights plus the stops inside each ticket (a Google offer "1 przesiadka"). -1 when there is no such direction. */
const connections = (t: Trip, d: "out" | "ret") => {
  const fl = t.legs.filter((l) => l.dir === d && !groundLeg(l));
  return fl.length ? fl.length - 1 + fl.reduce((a, l) => a + (l.stops ?? 0), 0) : -1;
};

/** Destination city of a trip: the last outbound flight's arrival (metro airports merged by city). */
const destCode = (t: Trip) => { const out = t.legs.filter((l) => l.dir === "out" && !groundLeg(l)); return out.at(-1)?.to ?? t.nodes[t.nodes.length - 1]; };
const destCity = (t: Trip) => tripCity(destCode(t));
// pin colors on the globe (hex: GL layers cannot read CSS variables), soft green to soft red by rank
export const PIN_RAMP = ["#2f7d52", "#5d8a2c", "#9a7414", "#b4602a", "#b0443a"];

type DestRow = { city: string; code: string; best: Trip | null; n: number; checked: boolean };

function useDestinations(r: SearchResult | null, params: SearchParams | null): DestRow[] {
  const dests = useStore((s) => (s.stats as { destinations?: { code: string; city: string; checked: boolean; best: number | null }[] }).destinations);
  return useMemo(() => {
    const by = new Map<string, DestRow>();
    for (const t of r?.trips ?? []) {
      const city = destCity(t);
      const row = by.get(city);
      if (!row) by.set(city, { city, code: destCode(t), best: t, n: 1, checked: true });
      else { row.n++; if (t.price < row.best!.price) row.best = t; }
    }
    for (const d of dests ?? []) {
      const city = d.city || tripCity(d.code);
      if (!by.has(city)) by.set(city, { city, code: d.code, best: null, n: 0, checked: d.checked });
    }
    return [...by.values()].sort((a, b) => (a.best ? a.best.price : Infinity) - (b.best ? b.best.price : Infinity) || a.city.localeCompare(b.city, "pl"));
  }, [r, dests, params]);
}

type BookTicket = { ticket: number; legs: number[]; from: string; to: string; date: string; price: number; url: string; source: string; risk: "protected" | "separate" };
type Booking = { whole: { url: string; source: "kiwi" | "google"; price: number | null } | null; tickets: BookTicket[] };
type Recheck = { legs: { index: number; old: number; now: number | null }[]; oldTotal: number; newTotal: number | null; changed: boolean };

const SOURCE_PL: Record<string, string> = { ryanair: "Ryanair", wizz: "Wizz Air", google: "Google Flights", kiwi: "Kiwi.com", flixbus: "FlixBus", other: "przewoźnika" };

/** Tickets of a trip: from the engine's booking plan, or (older results) grouped from the legs. */
function bookingOf(t: Trip): Booking {
  const b = (t as Trip & { booking?: Booking }).booking;
  if (b) return b;
  const nums = ticketNumbers(t);
  const tickets: BookTicket[] = [];
  t.legs.forEach((l, i) => {
    const last = tickets[tickets.length - 1];
    if (last && last.ticket === nums[i]) { last.legs.push(i); last.to = l.to; last.price += l.price; return; }
    tickets.push({ ticket: nums[i], legs: [i], from: l.from, to: l.to, date: l.depLocal.slice(0, 10), price: l.price, url: l.link, source: l.source === "estimate" ? "google" : l.source, risk: "separate" });
  });
  for (const k of tickets) k.risk = k.legs.length > 1 ? "protected" : "separate";
  return { whole: null, tickets };
}

/** Google Flights only shows offers: which flights to pick there, which fare, and what our price contains. */
function GoogleSteps({ t, pax }: { t: Trip; pax: number }) {
  const withBag = useStore((s) => s.params?.baggage === "checked");
  const fly = t.legs.filter((l) => !groundLeg(l));
  const dirs = (["out", "ret"] as const).map((d) => fly.filter((l) => l.dir === d)).filter((ls) => ls.length);
  const bag = fly.reduce((s, l) => s + (l.bag ?? 0), 0);
  const fare = fly.reduce((s, l) => s + l.price, 0) - bag;
  return (
    <div className="book-steps">
      <p>{tr("Google nie sprzedaje biletu: pokaże listę lotów. Wybierz w niej:")}</p>
      {dirs.map((ls, i) => {
        const f = ls[0], l = ls[ls.length - 1], via = ls.slice(1).map((x) => tripCity(x.from));
        return <div key={i} className="bs-dir">{i + 1}. <b>{i ? tr("Powrót") : tr("Wylot")} {fmtDate(f.depLocal)}</b>: {f.carrier} {fmtTime(f.depLocal)} → {fmtTime(l.arrLocal)}, {via.length ? tr("przesiadka w: {cities}", { cities: via.join(", ") }) : tr("bez przesiadki")}</div>;
      })}
      <p>{tr("Potem „Rezerwuj” u linii ({carrier}) albo u pośrednika – kupujesz na ich stronie.", { carrier: fly[0]?.carrier ?? "" })}
        {withBag && bag > 0 ? <> {rich("Wybierz taryfę {fare}.", { fare: <b>{tr("z bagażem rejestrowanym")}</b> })} {tr("Nasza cena {price} to bilet {fare} (tyle pokaże Google) + bagaż ~{bag} (szacunek wg cennika linii).", { price: fmtPln(t.price * pax), fare: fmtPln(fare * pax), bag: fmtPln(bag * pax) })}</> : null}</p>
    </div>
  );
}

function Booking({ t, pax, sid }: { t: Trip; pax: number; sid: string }) {
  const b = bookingOf(t);
  const [open, setOpen] = useState(false);
  const [check, setCheck] = useState<Recheck | "busy" | "error" | null>(null);
  const key = `azymut-bought-${sid}-${t.id}`;
  const [bought, setBought] = useState<number[]>(() => { try { return JSON.parse(localStorage.getItem(key) ?? "[]"); } catch { return []; } });
  const toggle = (n: number) => {
    const next = bought.includes(n) ? bought.filter((x) => x !== n) : [...bought, n];
    setBought(next);
    try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* private mode */ }
  };
  // live re-price of every ticket before booking
  const recheck = async () => {
    setCheck("busy");
    const r = await fetch("/api/booking/recheck", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: sid, trip: t }) }).catch(() => null);
    setCheck(r && r.ok ? ((await r.json()) as Recheck) : "error");
  };
  const start = () => { setOpen(true); if (!check) void recheck(); };
  // the riskiest and most expensive first: separate tickets, then by price
  const order = [...b.tickets].filter((k) => k.price > 0 || k.legs.some((i) => !groundLeg(t.legs[i]))).sort((a, c) => (a.risk === c.risk ? c.price - a.price : a.risk === "separate" ? -1 : 1));
  const paid = order.filter((k) => bought.includes(k.ticket)).reduce((a, k) => a + k.price, 0);
  const total = order.reduce((a, k) => a + k.price, 0);
  const separate = b.tickets.length > 1;
  const nowOf = (k: BookTicket) => (check && typeof check === "object" ? k.legs.map((i) => check.legs.find((x) => x.index === i)).filter(Boolean) : []);
  return (
    <div className="book">
      <div className="book-actions">
        {b.whole && <a className="btn primary" href={b.whole.url} target="_blank" rel="noreferrer"><Icon name="ticket" className="" />{b.whole.source === "google" ? tr("Rezerwuj przez Google Flights") : tr("Zarezerwuj całość")}{b.whole.price ? ` · ${fmtPln(b.whole.price * pax)}` : ""}</a>}
        {(!b.whole || separate) && <button className={`btn ${b.whole ? "" : "primary"}`} onClick={() => (open ? setOpen(false) : start())}><Icon name="ticket" className="" />{tr("Zarezerwuj krok po kroku")}</button>}
        <button className="btn ghost" onClick={() => play(Number(getState().selected))}><Icon name="play" className="" />{tr("Animacja")}</button>
      </div>
      {b.whole?.source === "google" && <GoogleSteps t={t} pax={pax} />}
      {open && (
        <div className="book-list">
          {separate && <p className="book-warn">{tr("Osobne bilety: linia nie gwarantuje przesiadki między nimi, a bagaż odbierasz i nadajesz sam. Kupuj od najbardziej ryzykownego.")}</p>}
          {check === "busy" && <p className="book-note pulse">{tr("Sprawdzam aktualne ceny wszystkich biletów…")}</p>}
          {check === "error" && <p className="book-note">{tr("Nie udało się sprawdzić cen na żywo.")} <button className="link" onClick={() => void recheck()}>{tr("Spróbuj ponownie")}</button></p>}
          {check && typeof check === "object" && (check.changed
            ? <p className="book-warn">{tr("Ceny się zmieniły: teraz {now} zamiast {old}.", { now: check.newTotal != null ? fmtPln(check.newTotal * pax) : tr("część biletów niedostępna"), old: fmtPln(check.oldTotal * pax) })}</p>
            : <p className="book-ok">{tr("Ceny sprawdzone przed chwilą: bez zmian.")}</p>)}
          <ol className="book-steps">
            {order.map((k, n) => {
              const done = bought.includes(k.ticket);
              const now = nowOf(k);
              const newPrice = now.length && now.every((x) => x!.now != null) ? now.reduce((a, x) => a + x!.now!, 0) : null;
              return (
                <li key={k.ticket} className={done ? "done" : ""}>
                  <label className="bs-check"><input type="checkbox" checked={done} onChange={() => toggle(k.ticket)} aria-label={tr("Kupiony bilet {route}", { route: `${k.from}–${k.to}` })} /></label>
                  <div className="bs-main">
                    <div className="bs-route">{n + 1}. {tripCity(k.from)} → {tripCity(k.to)} <span className="bs-date">{fmtDate(k.date)}</span></div>
                    <div className="bs-sub">{k.legs.length > 1 ? tr("{flights} na jednym bilecie · chroniona przesiadka", { flights: `${k.legs.length} ${plu(k.legs.length, ["lot", "loty", "lotów"], ["flight", "flights"])}` }) : tr("osobny bilet")} · {tr(SOURCE_PL[k.source] ?? k.source)}</div>
                  </div>
                  <div className="bs-right">
                    <span className="bs-price mono">{newPrice != null && newPrice !== k.price ? <><s>{fmtPln(k.price * pax)}</s> {fmtPln(newPrice * pax)}</> : fmtPln(k.price * pax)}</span>
                    <a className="bs-link" href={k.url} target="_blank" rel="noreferrer">{tr("Otwórz")} ↗</a>
                  </div>
                </li>
              );
            })}
          </ol>
          <div className="book-sum"><span>{tr("Zapłacone {amount}", { amount: fmtPln(paid * pax) })}</span><span>{tr("Zostało {amount}", { amount: fmtPln((total - paid) * pax) })}</span></div>
        </div>
      )}
    </div>
  );
}

function TripCard({ t, i, r, pax, anywhere, best, label }: { t: Trip; i: number; r: SearchResult; pax: number; anywhere: boolean; best: boolean; label?: string }) {
  const selected = useStore((s) => s.selected);
  const save = r.baseline ? r.baseline.price - t.price : null;
  const savings = [...(t.savings ?? [])].filter((x) => x.pln >= 1).sort((a, b) => TECH_ORDER.indexOf(a.technique) - TECH_ORDER.indexOf(b.technique));
  const on = selected === i;
  const ref = useRef<HTMLLIElement>(null);
  useEffect(() => { if (on) setTimeout(() => ref.current?.scrollIntoView({ block: "start", behavior: "smooth" }), 60); }, [on]);
  const conns = (["out", "ret"] as const).map((d) => connections(t, d)).filter((n) => n >= 0);
  const maxConn = Math.max(0, ...conns);
  const one = isOneTicket(t), nb = bookings(t), bag = bagOf(t);
  const withBag = useStore((s) => s.params?.baggage === "checked"); // the price already includes the bag fees
  const bagFee = t.legs.reduce((s, l) => s + (l.bag ?? 0), 0);
  return (
    <li ref={ref} className={`${on ? "sel" : ""} ${best || label ? "best" : ""}`}>
      <button className="trip" onClick={() => select(i)} aria-expanded={on}>
        {(best || label) && <div className="tr-badge">{label ?? tr("Najlepsza oferta")}</div>}
        <div className="tr-top">
          <span className="mono tr-price">{fmtPln(t.price * pax)}</span>
          {save !== null && save > 0 && <span className="mono tr-save">{tr("{amount} taniej niż Google", { amount: fmtPln(save * pax) })}</span>}
          {save !== null && save <= 0 && <span className="tr-google">{save === 0 || t.google ? tr("tyle co Google") : tr("{amount} vs Google", { amount: `+${fmtPln(-save * pax)}` })}</span>}
        </div>
        {anywhere && <div className="tr-dest">{destCity(t)}</div>}
        <AbroadLine t={t} />
        <div className="tr-meta">
          <span>{fmtDate(t.outDate)}{t.retDate ? ` – ${fmtDate(t.retDate)}` : ""}</span>
          <span>{tr("{h} h w drodze", { h: t.travelH })}</span>
          <span>{maxConn === 0 ? tr("bez przesiadek") : `${maxConn} ${plu(maxConn, ["przesiadka", "przesiadki", "przesiadek"], ["connection", "connections"])}`}</span>
        </div>
        <div className="tr-tickets">
          {maxConn > 0 || nb > 1
            ? <span className={`chip ${one ? "ok" : "warn"}`}><Icon name={one ? "shield" : "ticket"} />{one ? tr("jeden bilet") : `${nb} ${plu(nb, ["osobny bilet", "osobne bilety", "osobnych biletów"], ["separate ticket", "separate tickets"])}`}</span>
            : null}
          {withBag ? <span className="tr-bag">{tr("cena z bagażem rejestrowanym")}{bagFee > 0 ? <> ({tr("w tym bagaż")} ~<b className="mono">{fmtPln(bagFee * pax)}</b>)</> : null}</span>
            : bag.bagPrice ? <span className="tr-bag">{tr("z bagażem rejestrowanym")} <b className="mono">{bag.bagEstimated ? "~" : ""}{fmtPln(bag.bagPrice * pax)}</b></span> : null}
        </div>
      </button>
      {on && <div className="tr-more">
        <div className="tr-step">
          <button onClick={() => pickTrip(i - 1)} disabled={i === 0} aria-label={tr("Poprzednia trasa")}><Icon name="arrow" className="ico flip" /> {tr("tańsza")}</button>
          <span className="mono">{i + 1} / {r.trips.length}</span>
          <button onClick={() => pickTrip(i + 1)} disabled={i >= r.trips.length - 1} aria-label={tr("Następna trasa")}>{tr("droższa")} <Icon name="arrow" className="ico" /></button>
        </div>
        <RouteLine t={t} />
        <AccessLine t={t} />
        {savings.length > 0 && <div className="tr-savings">{savings.slice(0, 2).map((x) => <span key={x.technique + x.label} className="chip ok">{tx(x.label)}: −{fmtPln(x.pln * pax)}</span>)}</div>}
        <Booking t={t} pax={pax} sid={followed} />
        <Timeline t={t} pax={pax} />
      </div>}
    </li>
  );
}

/** When the cheapest trip needs separate bookings: the cheapest one on a single ticket (protected connections), with the extra cost. */
function OneTicket({ r, shown, pax, anywhere }: { r: SearchResult; shown: { t: Trip; i: number }[]; pax: number; anywhere: boolean }) {
  const stats = useStore((s) => s.stats) as { oneTicket?: Trip | null };
  if (!shown.length || isOneTicket(shown[0].t)) return null;
  const ids = new Set(shown.map((x) => x.t.id));
  const want = stats.oneTicket && ids.has(stats.oneTicket.id) ? stats.oneTicket.id : null;
  const hit = shown.find(({ t }) => (want ? t.id === want : isOneTicket(t)));
  if (!hit) return null;
  const extra = hit.t.price - shown[0].t.price;
  return (
    <div className="one-ticket">
      <p className="ot-head">{extra > 0 ? rich("Wolisz bez ryzyka przesiadki? Na jednym bilecie drożej o {extra}:", { extra: <b className="mono">{fmtPln(extra * pax)}</b> }) : tr("Wolisz bez ryzyka przesiadki? Na jednym bilecie w tej samej cenie:")}</p>
      <ol className="trips"><TripCard t={hit.t} i={hit.i} r={r} pax={pax} anywhere={anywhere} best={false} label={tr("Na jednym bilecie")} /></ol>
    </div>
  );
}

function DestRowButton({ d, k, pax, onPick, sub, chev, open }: { d: DestRow; k: number; pax: number; onPick: () => void; sub?: string; chev?: boolean; open?: boolean }) {
  const t = d.best;
  const conns = t ? Math.max(0, connections(t, "out")) : 0;
  return (
    <button className={`dest ${t ? "" : "none"}`} onClick={() => t && onPick()} disabled={!t} aria-expanded={chev ? open : undefined}>
      <span className="d-rank">{t ? k + 1 : "–"}</span>
      <span className="d-main">
        <span className="d-city">{sub ? countryName(ccOf(d.code)) : d.city}{!sub && <span className="code">{d.code}</span>}</span>
        <span className="d-sub">{t ? `${sub ? `${sub} · ` : ""}${fmtDate(t.outDate)}${t.retDate ? ` – ${fmtDate(t.retDate)}` : ""} · ${conns === 0 ? tr("bez przesiadek") : tr("{n} przes.", { n: conns })} · ${t.travelH} h` : d.checked ? tr("sprawdzone, brak trasy w oknie dat") : tr("jeszcze nie sprawdzone")}</span>
      </span>
      <span className="d-right">
        <span className="d-price mono">{t ? fmtPln(t.price * pax) : "—"}</span>
        {!sub && d.n > 1 && <span className="d-n">{plural(d.n, "wariant", "warianty", "wariantów")}</span>}
      </span>
      {chev && <span className="ar-chev" aria-hidden="true" />}
    </button>
  );
}

type CountryGroup = { cc: string; rows: DestRow[] };
/** Destination rows grouped by country, cheapest country first (rows inside stay sorted by price). */
function byCountry(rows: DestRow[]): CountryGroup[] {
  const m = new Map<string, DestRow[]>();
  for (const d of rows) { const cc = ccOf(d.code); m.set(cc, [...(m.get(cc) ?? []), d]); }
  return [...m.entries()].map(([cc, r]) => ({ cc, rows: r })).sort((a, b) => (a.rows[0].best?.price ?? Infinity) - (b.rows[0].best?.price ?? Infinity));
}

function Destinations({ rows, pax, onPick, countries, openCc, setOpenCc }: { rows: DestRow[]; pax: number; onPick: (city: string) => void; countries: boolean; openCc: string | null; setOpenCc: (cc: string | null) => void }) {
  if (!countries) return (
    <ol className="dests">
      {rows.map((d, k) => <li key={d.city}><DestRowButton d={d} k={k} pax={pax} onPick={() => onPick(d.city)} /></li>)}
    </ol>
  );
  return (
    <ol className="dests">
      {byCountry(rows).map((g, k) => {
        const open = openCc === g.cc, best = g.rows[0], more = g.rows.filter((d) => d.best).length - 1;
        return (
          <li key={g.cc} id={`dc-${g.cc}`} className={open ? "open" : ""}>
            <DestRowButton d={best} k={k} pax={pax} sub={`${best.city}${more > 0 ? ` · +${plural(more, "miasto", "miasta", "miast")}` : ""}`} chev open={open} onPick={() => setOpenCc(open ? null : g.cc)} />
            {open && (
              <ul className="any-cities">
                {g.rows.map((d) => (
                  <li key={d.city}>
                    <button className="any-city" onClick={() => d.best && onPick(d.city)} disabled={!d.best}>
                      <span className="ac-name">{d.city} <span className="ar-code">{d.code}</span></span>
                      <span className="ac-when">{d.best ? `${fmtDate(d.best.outDate)}${d.best.retDate ? ` – ${fmtDate(d.best.retDate)}` : ""} · ${d.best.travelH} h${d.n > 1 ? ` · ${plural(d.n, "wariant", "warianty", "wariantów")}` : ""}` : d.checked ? tr("brak trasy w oknie dat") : tr("nie sprawdzone")}</span>
                      <span className={`ac-price mono ${d.best ? "" : "est"}`}>{d.best ? fmtPln(d.best.price * pax) : "—"}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </li>
        );
      })}
    </ol>
  );
}

/** Phone: tap on the handle steps peek → half → full → peek. */
function stepSheet() {
  setState((s) => (!s.panelOpen ? { panelOpen: true, sheet: "half" } : s.sheet === "half" ? { sheet: "full" } : { panelOpen: false }));
}

/** Phone: the results sheet follows the finger 1:1 (transform only, no React render per frame) and
 *  springs to peek / half / full where the flick would carry it. The whole sheet is a handle, except the
 *  list when the sheet is full: there it scrolls, and pulling down at its top drags the sheet (iOS). A
 *  tap on the handle steps the snaps. The resting positions are CSS (translateY of the sheet's height). */
function useSheetDrag(snap: "peek" | "half" | "full") {
  // a callback ref: the sheet mounts only once a search exists, and the listeners follow the element
  const [el, sheetRef] = useState<HTMLElement | null>(null);
  const snapRef = useRef(snap);
  snapRef.current = snap;
  useEffect(() => {
    if (!el) return;
    type G = { y0: number; off0: number; dragging: boolean; body: HTMLElement | null; onHandle: boolean; pts: [number, number][]; id: number | "t" };
    let g: G | null = null;
    const offsetNow = () => new DOMMatrixReadOnly(getComputedStyle(el).transform).m42;
    const targets = () => {
      const H = el.getBoundingClientRect().height;
      return { peek: Math.max(0, H - PEEK_H), half: Math.max(0, H - window.innerHeight * 0.5), full: 0 };
    };
    const start = (y: number, target: EventTarget | null, id: number | "t") => {
      const t = target as HTMLElement | null;
      el.style.transition = "none";
      const off0 = offsetNow();
      el.style.transform = `translateY(${off0}px)`; // freeze a spring still running
      g = { y0: y, off0, dragging: false, body: t?.closest(".r-body") as HTMLElement | null, onHandle: !!t?.closest(".ph-handle"), pts: [[performance.now(), y]], id };
    };
    // true when the gesture is (or becomes) a sheet drag; false leaves it to the list's own scroll
    const move = (y: number): boolean => {
      if (!g) return false;
      const dy = y - g.y0;
      g.pts.push([performance.now(), y]);
      if (g.pts.length > 6) g.pts.shift();
      if (!g.dragging) {
        if (Math.abs(dy) < 6) return false;
        // a full sheet's list scrolls; only a pull down from its very top moves the sheet
        if (g.body && snapRef.current === "full" && !(dy > 0 && g.body.scrollTop <= 0)) { release(); return false; }
        g.dragging = true;
        g.y0 = y; // no jump by the 6 px dead zone
      }
      const tg = targets();
      let off = g.off0 + (y - g.y0);
      // rubber band past the ends
      if (off < 0) off = -Math.sqrt(-off) * 3;
      if (off > tg.peek) off = tg.peek + Math.sqrt(off - tg.peek) * 3;
      el.style.transform = `translateY(${off}px)`;
      return true;
    };
    const release = () => { el.style.transition = ""; el.style.transform = ""; g = null; };
    const end = () => {
      if (!g) return;
      const d = g;
      g = null;
      if (!d.dragging) { el.style.transition = ""; el.style.transform = ""; if (d.onHandle) stepSheet(); return; }
      // velocity over the last ~100 ms of movement (not of the clock: the finger may rest before lifting
      // only if it really rested), px per ms, + = down; at least two samples
      const [t1, y1] = d.pts[d.pts.length - 1];
      const rested = performance.now() - t1 > 120;
      const back = d.pts.filter(([t]) => t1 - t <= 100);
      const [t0, y0] = back.length > 1 ? back[0] : d.pts[Math.max(0, d.pts.length - 2)];
      const v = rested || t1 <= t0 ? 0 : (y1 - y0) / (t1 - t0);
      const off = offsetNow(), tg = targets();
      const aim = off + v * 260;
      const to = (Object.entries(tg) as ["peek" | "half" | "full", number][]).reduce((a, b) => (Math.abs(b[1] - aim) < Math.abs(a[1] - aim) ? b : a))[0];
      // the spring: faster after a quick flick, a soft overshoot-free settle
      const dur = Math.max(0.26, Math.min(0.5, Math.abs(tg[to] - off) / Math.max(1.2, Math.abs(v) * 1.6) / 1000 * 2.2));
      el.style.transition = `transform ${dur}s cubic-bezier(0.2, 0.9, 0.25, 1)`;
      el.style.transform = `translateY(${tg[to]}px)`;
      const done = () => { el.removeEventListener("transitionend", done); if (!g) { el.style.transition = ""; el.style.transform = ""; } };
      el.addEventListener("transitionend", done);
      setTimeout(done, dur * 1000 + 80);
      setState(to === "peek" ? { panelOpen: false } : { panelOpen: true, sheet: to });
    };
    const ts = (e: TouchEvent) => { if (e.touches.length === 1) start(e.touches[0].clientY, e.target, "t"); };
    const tm = (e: TouchEvent) => { if (g && move(e.touches[0].clientY) && e.cancelable) e.preventDefault(); };
    const te = () => end();
    // mouse (a narrow desktop window, tests): the same gesture
    const pd = (e: PointerEvent) => { if (e.pointerType === "mouse" && e.button === 0) start(e.clientY, e.target, e.pointerId); };
    const pm = (e: PointerEvent) => { if (e.pointerType === "mouse" && g && g.id === e.pointerId && move(e.clientY)) e.preventDefault(); };
    const pu = (e: PointerEvent) => { if (e.pointerType === "mouse" && g && g.id === e.pointerId) end(); };
    el.addEventListener("touchstart", ts, { passive: true });
    el.addEventListener("touchmove", tm, { passive: false });
    el.addEventListener("touchend", te);
    el.addEventListener("touchcancel", te);
    el.addEventListener("pointerdown", pd);
    window.addEventListener("pointermove", pm);
    window.addEventListener("pointerup", pu);
    return () => {
      el.removeEventListener("touchstart", ts); el.removeEventListener("touchmove", tm); el.removeEventListener("touchend", te); el.removeEventListener("touchcancel", te);
      el.removeEventListener("pointerdown", pd); window.removeEventListener("pointermove", pm); window.removeEventListener("pointerup", pu);
    };
  }, [el]);
  return { sheetRef };
}

/** "bez przesiadek" / "1 przesiadka" for the outbound (the busier direction when it is a round trip). */
function peekStops(t: Trip) {
  const n = Math.max(...(["out", "ret"] as const).map((d) => Math.max(0, t.legs.filter((l) => l.dir === d).length - 1)));
  return n === 0 ? tr("bez przesiadek") : `${n} ${plu(n, ["przesiadka", "przesiadki", "przesiadek"], ["connection", "connections"])}`;
}

/** Phone: the collapsed sheet's one line — the best price, the city and the saving against Google. */
function PeekLine({ r, pax, params }: { r: SearchResult | null; pax: number; params: SearchParams | null }) {
  const live = useStore((s) => s.live);
  const phase = useStore((s) => s.phase);
  const running = live?.status === "running" || phase === "parsing" || (phase === "searching" && !live);
  const best = r?.trips[0] ?? null;
  const google = r?.baseline?.price ?? null;
  const save = best && google && google > best.price ? Math.round((google - best.price) * pax) : 0;
  const city = best ? destCity(best) : params?.destLabel ?? "";
  return (
    <span className="pk">
      <span className="pk-left">
        <span className="pk-city">{city || tr("Wyniki")}</span>
        <span className="pk-sub">{running ? <><i className="pk-dot" />{tr("Szukam najtańszej trasy")}</>
          : best ? [`${fmtDate(best.outDate)}${best.retDate ? `–${fmtDate(best.retDate)}` : ""}`, peekStops(best)].filter(Boolean).join(" · ") : tr("Brak trasy")}</span>
      </span>
      <span className="pk-right">
        {best && <span className="pk-price">{fmtPln(best.price * pax)}</span>}
        {save > 0 && <span className="pk-save">−{fmtPln(save)} {tr("vs Google")}</span>}
      </span>
    </span>
  );
}

function Results() {
  const r = useStore((s) => s.result);
  const phase = useStore((s) => s.phase);
  const open = useStore((s) => s.panelOpen);
  const params = useStore((s) => s.params);
  const pins = useStore((s) => s.pins);
  const pinPick = useStore((s) => s.pinPick);
  const destPins = useStore((s) => s.destPins);
  const journey = useStore((s) => s.journeyPhase);
  const inline = useStore((s) => s.journeyInline);
  const [view, setView] = useState<"dest" | "all">("dest");
  const [city, setCity] = useState<string | null>(null);
  const phone = useIsPhone();
  const snap = useStore(sheetSnap);
  const { sheetRef } = useSheetDrag(snap);
  const [openCc, setOpenCc] = useState<string | null>(null);
  const rows = useDestinations(r, params);
  // a region spanning several countries shows one entry per country; a single country one per city
  const countries = new Set(rows.map((d) => ccOf(d.code))).size > 1;
  const multi = rows.filter((d) => d.best).length > 1 || rows.length > 2;
  const pax = params?.pax ?? 1;
  const anywhere = params?.mode === "anywhere";
  // a new search starts in "Kierunki"
  useEffect(() => { setView("dest"); setCity(null); setOpenCc(null); }, [params?.query, params?.dateFrom, params?.destLabel]);
  // one price pin per city on the globe while "Kierunki" is shown
  useEffect(() => {
    const show = multi && view === "dest" && open && !pins;
    if (!show) { if (getState().destPins) setState({ destPins: null }); return; }
    const priced = (countries ? byCountry(rows).map((g) => g.rows[0]) : rows).filter((d) => d.best && AIRPORT_POS[d.code]);
    const p: Pin[] = priced.map((d, k) => ({ code: d.code, price: d.best!.price * pax, name: countries ? d.city : undefined,
      color: PIN_RAMP[Math.min(PIN_RAMP.length - 1, Math.floor((k / Math.max(1, priced.length)) * PIN_RAMP.length))], deal: false, verified: true }));
    setState({ destPins: p });
  }, [rows, multi, view, open, pins, pax, countries]);
  useEffect(() => () => setState({ destPins: null }), []);
  // a pin on the globe opens that city's routes
  useEffect(() => {
    if (!pinPick || !destPins) return;
    if (countries) {
      // a country pin opens that country's cities in the list
      const cc = ccOf(pinPick);
      setOpenCc(cc); setState({ pinPick: null, panelOpen: true });
      setTimeout(() => document.getElementById(`dc-${cc}`)?.scrollIntoView({ block: "start", behavior: "smooth" }), 80);
      return;
    }
    // a city pin: the routes to that city this search found (a deeper search of the city is a button there)
    const d = rows.find((x) => x.city === tripCity(pinPick));
    setState({ pinPick: null, panelOpen: true, selected: null });
    if (d) { setCity(d.city); setView("all"); }
  }, [pinPick, destPins, countries, rows]);
  if (phase === "idle" || pins) return null;
  const n = r?.trips.length ?? 0;
  const shown = r ? r.trips.map((t, i) => ({ t, i })).filter(({ t }) => !city || destCity(t) === city) : [];
  // a city of a region: the routes to it found so far, at once (no new search: after "Zatrzymaj" the
  // result stays the result); "Szukaj dokładniej" runs that city's own full search
  const pick = (c: string) => { setCity(c); setView("all"); setState({ selected: null }); };
  const deeper = (c: string) => { const d = rows.find((x) => x.city === c); if (d) void searchCity(c, d.code); };
  const body = <>
          <Progress />
          {r && <>
            {pax > 1 && <p className="r-note">{tr("Ceny za {people} (cena za osobę × {n}).", { people: `${pax} ${plu(pax, ["osobę", "osoby", "osób"], ["person", "people"])}`, n: pax })}</p>}
            <CheaperDates />
            {!r.trips.length && !r.paused && <p className="r-note">{tr("Brak trasy w tym oknie dat. Spróbuj szerszego zakresu dat albo dłuższego czasu podróży.")}</p>}
            {multi && n > 0 && (
              <div className="r-views">
                <div className="seg" role="tablist" aria-label={tr("Widok wyników")}>
                  <button role="tab" aria-selected={view === "dest"} className={view === "dest" ? "on" : ""} onClick={() => { setView("dest"); setState({ selected: null }); }}>{tr("Kierunki")}</button>
                  <button role="tab" aria-selected={view === "all"} className={view === "all" ? "on" : ""} onClick={() => setView("all")}>{tr("Wszystkie trasy")}</button>
                </div>
              </div>
            )}
            {multi && view === "dest" ? <Destinations rows={rows} pax={pax} onPick={pick} countries={countries} openCc={openCc} setOpenCc={setOpenCc} /> : <>
              {city && <div className="r-filter"><Icon name="pin" /><span>{tr("Trasy do:")} <b>{city}</b> · {shown.length}</span><button onClick={() => { setCity(null); setState({ selected: null }); }}>{tr("wszystkie miasta")}</button></div>}
              {city && multi && <div className="r-deeper">
                {!shown.length && <span>{tr("Tej trasy nie ma na liście najlepszych wyników.")}</span>}
                <button className="link" onClick={() => deeper(city)}>{tr("Szukaj dokładniej: {city}", { city })} →</button>
              </div>}
              {/* the cheapest, then (when it needs separate bookings) the cheapest on one ticket, then the rest */}
              <ol className="trips">
                {shown.slice(0, 1).map(({ t, i }) => <TripCard key={t.id} t={t} i={i} r={r} pax={pax} anywhere={anywhere || (multi && !city)} best={i === 0} />)}
              </ol>
              <OneTicket r={r} shown={shown} pax={pax} anywhere={anywhere || (multi && !city)} />
              {shown.length > 1 && <ol className="trips rest">
                {shown.slice(1).map(({ t, i }) => <TripCard key={t.id} t={t} i={i} r={r} pax={pax} anywhere={anywhere || (multi && !city)} best={i === 0} />)}
              </ol>}
            </>}
            <Reasonable r={r} pax={pax} />
            {(r.summary || r.notes.length > 0) && <details className="r-more">
              <summary>{tr("Szczegóły wyszukiwania")}</summary>
              {r.summary && <p className="r-summary">{tx(r.summary)}</p>}
              <StrategistLine r={r} />
              {r.notes.filter((nt) => !nt.startsWith("Strateg:")).map((nt) => <p key={nt} className="r-note">{tx(nt)}</p>)}
            </details>}
          </>}
  </>;
  if (phone) return (
    <section ref={sheetRef} className={`results glass ph-sheet sheet-${snap}`} aria-label={tr("Wyniki")} hidden={journey !== "none" && !inline}>
      <div className="r-handle ph-handle" role="button" tabIndex={0} aria-expanded={open} aria-label={tr("Wyniki")}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); stepSheet(); } }}>
        <span className="r-grip" />
        <PeekLine r={r} pax={pax} params={params} />
      </div>
      {/* always there, so a drag reveals it; it scrolls only when the sheet is full */}
      <div className="r-body scroll">{body}</div>
    </section>
  );
  return (
    <section className={`results glass ${open ? "open" : "closed"}`} aria-label={tr("Wyniki")} hidden={journey !== "none" && !inline}>
      <button className="r-handle" onClick={() => setState((s) => ({ panelOpen: !s.panelOpen }))} aria-expanded={open}>
        <span className="r-grip" />
        <span className="r-title">{params ? `${params.originLabel} → ${params.destLabel}` : tr("Wyniki")}</span>
        <span className="mono">{n ? `${multi ? (countries ? `${plural(byCountry(rows).filter((g) => g.rows[0].best).length, "kraj", "kraje", "krajów")}, ` : "") + plural(rows.filter((d) => d.best).length, "miasto", "miasta", "miast") : plural(n, "trasa", "trasy", "tras")} · ${tr("od {price}", { price: fmtPln(r!.trips[0].price * pax) })}` : ""}</span>
        <span className="r-chev"><Icon name="chevron" className="" /></span>
      </button>
      {open && (
        <div className="r-body scroll">
          {body}
        </div>
      )}
    </section>
  );
}


function JourneyOverlay() {
  const phase = useStore((s) => s.journeyPhase);
  const total = useStore((s) => s.journeyTotal);
  const r = useStore((s) => s.result);
  const sel = useStore((s) => s.selected);
  const inline = useStore((s) => s.journeyInline);
  if (phase === "none" || inline || sel === null || !r) return null;
  const t = r.trips[sel];
  const save = r.baseline ? Math.round(r.baseline.price - t.price) : null;
  return (
    <>
      {phase === "flying" && (
        <div className="j-counter">
          <span className="caps">{tr("Suma")}</span>
          <span className="mono"><Counter value={total} /> zł</span>
        </div>
      )}
      {phase === "final" && (
        <div className="j-final">
          <div className="j-card">
            <div className="j-route">{routeCodes(t).map((c) => <div key={c}>{c}</div>)}</div>
            <div className="j-price mono"><Counter value={t.price} /> <span>zł</span></div>
            <div className={`j-save mono ${save !== null && save < 0 ? "neg" : ""}`}>{save !== null ? tr("{amount} vs Google", { amount: `${save >= 0 ? "−" : "+"}${fmtPln(Math.abs(save))}` }) : tr("brak ceny bazowej Google")}</div>
            {t.estimated && <div className="j-warn">{tr("część odcinków ma cenę szacunkową")}</div>}
            <div className="j-actions">
              <button onClick={() => play(sel)}>{tr("Odtwórz ponownie")}</button>
              <button className="primary" onClick={() => setState({ journeyPhase: "none", panelOpen: true })}>{tr("Szczegóły trasy")}</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function TopForm() {
  const phase = useStore((s) => s.phase);
  const journey = useStore((s) => s.journeyPhase);
  const inline = useStore((s) => s.journeyInline);
  const picked = useStore((s) => s.selected !== null);
  const anyOpen = useStore((s) => s.pins !== null);
  const open = useStore((s) => s.panelOpen);
  const busy = phase === "parsing" || (phase === "searching" && getState().live?.status === "running");
  const phone = useIsPhone();
  const [formOpen, setFormOpen] = useState(false);
  const params = useStore((s) => s.params);
  const full = useStore((s) => sheetSnap(s) === "full" && s.phase !== "idle");
  if (phone) return (
    <div className={`top ph-top ${journey !== "none" && !inline ? "hidden" : ""} ${full && !formOpen ? "under-sheet" : ""}`}>
      {formOpen ? (
        <div className="ph-form" role="dialog" aria-label={tr("Wyszukiwanie")}>
          <div className="ph-menu-head"><span className="ph-title">{tr("Wyszukiwanie")}</span>
            <button className="ph-round flat" onClick={() => setFormOpen(false)} aria-label={tr("Zamknij")}><Icon name="close" className="" /></button></div>
          <SearchFormPanel busy={busy} hidden={false}
            onSearch={(f) => { setFormOpen(false); setState({ sheet: "half" }); void startForm(f); }}
            onAsk={(q) => { setFormOpen(false); setState({ sheet: "half" }); void startSearch(q); }} />
        </div>
      ) : (
        <div className="ph-bar">
          <button className="ph-pill" onClick={() => setFormOpen(true)}>
            <Icon name="search" className="" />
            <span className={params ? "" : "ph-pill-empty"}>{searchSummary(params)}</span>
          </button>
          <PhoneMenu />
        </div>
      )}
    </div>
  );
  return (
    <div className={`top ${journey !== "none" && !inline ? "hidden" : ""} ${anyOpen ? "any-open" : ""} ${phase !== "idle" && (open || picked || journey !== "none") ? "folded" : ""}`}>
      <Brand />
      <SearchFormPanel onSearch={(f) => void startForm(f)} onAsk={(q) => void startSearch(q)} busy={busy} hidden={false} />
    </div>
  );
}

export default function App() {
  const lang = useLang();
  const phone = useIsPhone();
  useEffect(() => { void refreshPush(); }, []);
  useEffect(() => setLang(storedLang(), false), []);
  return (
    <main>
      <Scene />
      {/* everything but the globe re-renders in the new language */}
      <Fragment key={lang}>
        <TopForm />
        <Results />
        <AnywherePanel onSearch={(f) => void startForm(f)} />
        <JourneyOverlay />
        <Radar />
        {phone && <PhoneTabs />}
      </Fragment>
    </main>
  );
}


// ---------------------------------------------------------------- stopovers

function StopoverSlider({ value, disabled, onChange }: { value: number; disabled: boolean; onChange: (d: number) => void }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <label className="stopover">
      <span>{tr("przesiadki do {max}", { max: v === 0 ? "30 h" : `${v} ${plu(v, ["dnia", "dni", "dni"], ["day", "days"])}` })}</span>
      <input type="range" min={0} max={7} step={1} value={v} disabled={disabled} aria-label={tr("Najdłuższa przesiadka w dniach")}
        onChange={(e) => setV(Number(e.target.value))} onPointerUp={() => v !== value && onChange(v)} onKeyUp={() => v !== value && onChange(v)} />
    </label>
  );
}

// ---------------------------------------------------------------- radar

type RadarDeal = {
  id: string; kind: "anomaly" | "deal"; origin: string; dest: string; date: string | null; month: string | null; price: number;
  norm: number | null; pct: number | null; feederFrom: string | null; feederPrice: number | null; total: number; source: string; link: string; title: string | null;
};
type RadarData = { deals: RadarDeal[]; watch: { id: number; label: string; codes: string[] }[]; hubs: Record<string, { hub: string; score: number; feed: number; onward: number; to: string }[]> };

const radarOpen = { v: false, subs: new Set<(v: boolean) => void>() };
const setRadar = (v: boolean) => { radarOpen.v = v; radarOpen.subs.forEach((f) => f(v)); };
function useRadarOpen() {
  const [v, setV] = useState(radarOpen.v);
  useEffect(() => { radarOpen.subs.add(setV); return () => { radarOpen.subs.delete(setV); }; }, []);
  return v;
}

function RadarButton() {
  const open = useRadarOpen();
  return <button className={`radar-btn ${open ? "on" : ""}`} onClick={() => setRadar(!open)}>{tr("Radar okazji")}</button>;
}

const cityOf = (c: string) => AIRPORT_POS[c]?.city ?? c;
const REGION_PL: Record<string, string> = { SAM: "Ameryka Płd.", CAR: "Karaiby", NAM: "Ameryka Płn.", SEA: "Azja Płd.-Wsch.", SAS: "Azja Płd.", EAS: "Azja Wsch.", MEA: "Bliski Wschód", AFR: "Afryka", NAF: "Afryka Płn.", OCE: "Oceania", CAU: "Kaukaz", CAS: "Azja Środk." };

function Radar() {
  const open = useRadarOpen();
  const [sort, setSort] = useState<"price" | "pct">("price");
  const [data, setData] = useState<RadarData | null>(null);
  const [watch, setWatch] = useState("");
  const [err, setErr] = useState("");
  const load = (s = sort) => fetch(`/api/radar?sort=${s}`).then((r) => r.json()).then(setData).catch(() => setErr(tr("nie udało się wczytać radaru")));
  useEffect(() => { if (open) void load(); }, [open, sort]);
  if (!open) return null;
  const add = async () => {
    if (!watch.trim()) return;
    const r = await fetch("/api/radar", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ watch }) });
    const j = await r.json();
    if (!r.ok) setErr(j.error ? tx(j.error) : tr("błąd")); else { setErr(""); setWatch(""); void load(); }
  };
  const remove = async (id: number) => { await fetch("/api/radar", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ unwatch: id }) }); void load(); };
  return (
    <section className="radar glass fade-in">
      <div className="rd-head">
        <div className="caps">{tr("radar okazji")}</div>
        <div className="rd-sort mono">
          <button className={sort === "price" ? "on" : ""} onClick={() => setSort("price")}>{tr("cena")}</button>
          <button className={sort === "pct" ? "on" : ""} onClick={() => setSort("pct")}>{tr("% poniżej normy")}</button>
        </div>
        <button className="rd-close caps" onClick={() => setRadar(false)}>{tr("zamknij")}</button>
      </div>
      <div className="rd-body scroll">
        {!data && !err && <p className="r-note">{tr("Wczytuję…")}</p>}
        {err && <p className="r-note">{err}</p>}
        {data && !data.deals.length && <p className="r-note">{tr("Brak aktualnych okazji. Radar skanuje mapę raz dziennie, kanały okazji co 4 godziny.")}</p>}
        <ol className="rd-list">
          {data?.deals.map((d) => (
            <li key={d.id}>
              <a href={d.link} target="_blank" rel="noreferrer" className="rd-deal">
                <div className="rd-top">
                  <span className="mono rd-route">{d.origin}→{d.dest}</span>
                  <span className="mono rd-price">{fmtPln(d.price)}</span>
                  {d.pct !== null && <span className="mono rd-pct">−{d.pct}%</span>}
                </div>
                <div className="rd-sub">
                  {cityOf(d.origin)} → {cityOf(d.dest)}{d.date ? ` · ${fmtDate(d.date)}.${d.date.slice(0, 4)}` : ""}
                  {d.feederPrice ? <> · + {tr("dolot z {from}", { from: d.feederFrom ?? tr("Polski") })} {fmtPln(d.feederPrice)} = <b>{fmtPln(d.total)}</b></> : null}
                </div>
                <div className="rd-meta dim">{d.kind === "anomaly" ? `${tr("norma {price}", { price: fmtPln(d.norm ?? 0) })} · ${d.source}` : `${d.source}: ${d.title ?? ""}`}</div>
              </a>
            </li>
          ))}
        </ol>
        <div className="rd-section caps">{tr("obserwowane kierunki (mail przy okazji poniżej 50% normy)")}</div>
        <div className="rd-watch">
          {data?.watch.map((w) => <span key={w.id} className="mono">{w.label}<button aria-label={tr("Usuń {label}", { label: w.label })} onClick={() => remove(w.id)}>×</button></span>)}
          <form onSubmit={(e) => { e.preventDefault(); void add(); }}>
            <input value={watch} onChange={(e) => setWatch(e.target.value)} placeholder={tr("np. Peru, Tajlandia, BKK")} aria-label={tr("Dodaj obserwowany kierunek")} />
          </form>
        </div>
        {data && Object.keys(data.hubs).length > 0 && <>
          <div className="rd-section caps">{tr("najtańsze huby z Polski (dolot + dalej)")}</div>
          {["SAM", "SEA", "SAS", "EAS", "CAR", "NAM"].filter((r) => data.hubs[r]).map((r) => (
            <div key={r} className="rd-hubs mono"><span className="dim">{tr(REGION_PL[r])}</span> {data.hubs[r].slice(0, 5).map((h) => `${h.hub} ${h.score}`).join(" · ")}</div>
          ))}
        </>}
      </div>
    </section>
  );
}
