"use client";
// The search form (primary input): from / to with suggestions, trip type, passengers, dates with a
// price calendar, and the options that change what a trip may contain.
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { SearchForm } from "@/lib/parse";
import type { Suggestion } from "@/lib/suggest";
import { fmtPln } from "./geo";
import { conv } from "./money";
import { setState, useStore } from "./store";
import { getLang, locale, plural, t, tx, useLang } from "./i18n";

// month and weekday names from Intl in the interface language ("styczeń" / "January", "pn" / "Mo")
const monthName = (ym: string) => new Intl.DateTimeFormat(locale(), { month: "long", timeZone: "UTC" }).format(new Date(Date.parse(ym.slice(0, 7) + "-01")));
const DOW_PL = ["pn", "wt", "śr", "cz", "pt", "so", "nd"];
const dow = () => (getLang() === "pl" ? DOW_PL : Array.from({ length: 7 }, (_, i) => new Intl.DateTimeFormat(locale(), { weekday: "short", timeZone: "UTC" }).format(new Date(Date.UTC(2024, 0, 1 + i))).slice(0, 2)));

const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (s: string, n: number) => iso(new Date(Date.parse(s) + n * 86400_000));
const addMonths = (ym: string, n: number) => { const d = new Date(Date.parse(ym + "-01")); d.setUTCMonth(d.getUTCMonth() + n); return iso(d).slice(0, 7); };
const monthEnd = (ym: string) => addDays(addMonths(ym, 1) + "-01", -1);
const fmtD = (s: string) => new Intl.DateTimeFormat(locale(), { day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(Date.parse(s.slice(0, 10)))).replace(/\.$/, "");
// calendar cells: the number alone, in the display currency
const short = (pln: number) => { const n = conv(pln); return n >= 10000 ? `${Math.round(n / 1000)}k` : String(Math.round(n)); };

export type FormState = SearchForm & { months: string[]; maxAccessH?: number };

export const tomorrow = () => addDays(iso(new Date()), 1);

export function defaultForm(): FormState {
  const m = addMonths(tomorrow().slice(0, 7), 1);
  return {
    from: "Poznań", to: "", toRet: "", type: "rt", dateMode: "month", dateFrom: `${m}-01`, dateTo: monthEnd(m), months: [m],
    stayMin: 7, stayMax: 21, pax: 1, home: "Poznań", access: false, abroad: false, maxAccessH: 4, maxTripH: 96, stopoverDays: 3, countHotel: true, baggage: "cabin", depth: "fast",
  };
}

/** The form as the API wants it: dates from the chosen mode. */
export function toSearchForm(f: FormState): SearchForm {
  const { months, ...rest } = f;
  if (f.dateMode === "month" && months.length) {
    const ms = [...months].sort();
    return { ...rest, dateFrom: `${ms[0]}-01`, dateTo: monthEnd(ms[ms.length - 1]) };
  }
  return rest;
}

// ---------------------------------------------------------------- autocomplete

function PlaceInput({ label, value, onChange, placeholder, autoFocus, extra }: { label: string; value: string; onChange: (v: string) => void; placeholder: string; autoFocus?: boolean; extra?: React.ReactNode }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Suggestion[]>([]);
  const [hi, setHi] = useState(0);
  const seq = useRef(0);
  useEffect(() => {
    if (!open) return;
    const n = ++seq.current;
    const t = setTimeout(() => {
      fetch(`/api/suggest?q=${encodeURIComponent(value)}&lang=${getLang()}`).then((r) => r.json()).then((list: Suggestion[]) => { if (n === seq.current) { setItems(list); setHi(0); } }).catch(() => {});
    }, 110);
    return () => clearTimeout(t);
  }, [value, open]);
  // an airport goes in with its city ("Concord USA"), so a code that is also a country name stays the airport
  const pick = (s: Suggestion) => { onChange(s.label); setOpen(false); };
  return (
    <div className="f-field f-place">
      <label htmlFor={id} className="f-label">{label}</label>
      {extra}
      <input id={id} value={value} placeholder={placeholder} autoFocus={autoFocus} spellCheck={false} autoComplete="off"
        role="combobox" aria-expanded={open && items.length > 0} aria-controls={id + "-list"} aria-autocomplete="list"
        aria-activedescendant={open && items[hi] ? `${id}-o${hi}` : undefined}
        onChange={(e) => { onChange(e.target.value); setOpen(true); }}
        onFocus={(e) => { setOpen(true); e.target.select(); }}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onKeyDown={(e) => {
          if (!open || !items.length) { if (e.key === "ArrowDown") setOpen(true); return; }
          if (e.key === "ArrowDown") { e.preventDefault(); setHi((h) => (h + 1) % items.length); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setHi((h) => (h - 1 + items.length) % items.length); }
          else if (e.key === "Enter" || e.key === "Tab") { if (items[hi] && (e.key === "Enter" || value.trim())) { if (e.key === "Enter") e.preventDefault(); pick(items[hi]); } }
          else if (e.key === "Escape") setOpen(false);
        }} />
      {open && items.length > 0 && (
        <ul className="ac-list" id={id + "-list"} role="listbox">
          {items.map((s, i) => (
            <li key={s.kind + s.value} id={`${id}-o${i}`} role="option" aria-selected={i === hi} className={i === hi ? "on" : ""}
              onMouseDown={(e) => { e.preventDefault(); pick(s); }} onMouseEnter={() => setHi(i)}>
              <span className={`ac-kind k-${s.kind}`}>{s.kind === "airport" ? s.value : s.kind === "country" ? t("kraj") : s.kind === "region" ? t("region") : s.kind === "city" ? t("miasto") : "✦"}</span>
              <span className="ac-main">{s.kind === "airport" ? s.label.replace(/ [A-Z]{3}$/, "") : s.label}</span>
              <span className="ac-sub">{s.sub}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- price calendar

type Cal = { days: Record<string, number>; loading: boolean; error: string | null; key: string };

export function useCalendar(f: FormState, open: boolean, start: string, months: number): Cal {
  const [cal, setCal] = useState<Cal>({ days: {}, loading: false, error: null, key: "" });
  const key = JSON.stringify([f.from, f.to, f.type, f.stayMin, f.stayMax, f.access, f.abroad, f.strict, f.maxAccessH, f.home, start, months]);
  useEffect(() => {
    if (!open || !f.to.trim() || cal.key === key) return;
    let dead = false;
    setCal((c) => ({ ...c, loading: true, error: null }));
    fetch("/api/calendar", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ form: toSearchForm({ ...f, dateMode: "exact" }), start, months }) })
      .then((r) => r.json())
      .then((j: { days?: { date: string; price: number }[]; error?: string }) => {
        if (dead) return;
        const days: Record<string, number> = {};
        for (const d of j.days ?? []) days[d.date] = d.price;
        setCal({ days, loading: false, error: j.error ?? (j.days?.length ? null : t("brak cen w kalendarzu Google")), key });
        setState((s) => ({ calendar: { ...s.calendar, ...days } }));
      })
      .catch(() => { if (!dead) setCal({ days: {}, loading: false, error: t("kalendarz niedostępny"), key }); });
    return () => { dead = true; };
  }, [open, key]); // eslint-disable-line react-hooks/exhaustive-deps
  return cal;
}

/** Green (cheap) to red (expensive) by rank among the visible prices. */
export function scale(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return (v: number) => {
    if (!sorted.length) return "";
    const r = sorted.length > 1 ? sorted.findIndex((x) => x >= v) / (sorted.length - 1) : 0;
    return r < 0.25 ? "p-lo" : r < 0.6 ? "p-mid" : r < 0.85 ? "p-hi" : "p-top";
  };
}

export function MonthGrid({ ym, days, cls, sel, onPick, min }: { ym: string; days: Record<string, number>; cls: (v: number) => string; sel: (d: string) => string; onPick: (d: string) => void; min: string }) {
  const first = new Date(Date.parse(ym + "-01"));
  const lead = (first.getUTCDay() + 6) % 7;
  const n = Number(monthEnd(ym).slice(8, 10));
  return (
    <div className="cal-month">
      <div className="cal-title">{monthName(ym)} {ym.slice(0, 4)}</div>
      <div className="cal-grid">
        {dow().map((d) => <span key={d} className="cal-dow">{d}</span>)}
        {Array.from({ length: lead }, (_, i) => <span key={"l" + i} />)}
        {Array.from({ length: n }, (_, i) => {
          const d = `${ym}-${String(i + 1).padStart(2, "0")}`;
          const p = days[d];
          const off = d < min;
          return (
            <button key={d} type="button" disabled={off} className={`cal-day ${sel(d)} ${p ? cls(p) : ""}`} onClick={() => onPick(d)} aria-label={`${fmtD(d)}${p ? t(", od {price}", { price: fmtPln(p) }) : ""}`}>
              <span className="cd-n">{i + 1}</span>
              <span className="cd-p mono">{p ? short(p) : off ? "" : "·"}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function PriceChart({ days, sel, onPick }: { days: Record<string, number>; sel: string | null; onPick: (d: string) => void }) {
  const list = Object.entries(days).sort((a, b) => a[0].localeCompare(b[0]));
  if (list.length < 3) return null;
  const max = Math.max(...list.map((x) => x[1])), min = Math.min(...list.map((x) => x[1]));
  const W = 100 / list.length;
  return (
    <div className="chart">
      <div className="chart-head"><span>{t("ceny według daty wylotu")}</span><span className="mono">{fmtPln(min)} – {fmtPln(max)}</span></div>
      <svg viewBox="0 0 100 40" preserveAspectRatio="none" role="img" aria-label={t("Wykres cen według daty wylotu")}>
        {list.map(([d, p], i) => {
          const h = 6 + ((p - min) / Math.max(1, max - min)) * 32;
          return <rect key={d} x={i * W + W * 0.15} width={W * 0.7} y={40 - h} height={h} className={d === sel ? "bar sel" : p === min ? "bar min" : "bar"} onClick={() => onPick(d)}><title>{fmtD(d)}: {fmtPln(p)}</title></rect>;
        })}
      </svg>
    </div>
  );
}

function DateGrid({ f, around }: { f: FormState; around: string }) {
  const [cells, setCells] = useState<{ out: string; ret: string; price: number }[] | null>(null);
  useEffect(() => {
    setCells(null);
    fetch("/api/calendar", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ form: toSearchForm({ ...f, dateMode: "exact" }), grid: around }) })
      .then((r) => r.json()).then((j) => setCells(j.cells ?? [])).catch(() => setCells([]));
  }, [around]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!cells) return <p className="cal-note">{t("Wczytuję siatkę dat…")}</p>;
  if (!cells.length) return <p className="cal-note">{t("Brak danych do siatki dat.")}</p>;
  const outs = [...new Set(cells.map((c) => c.out))].sort().slice(0, 15);
  const stays = [...new Set(cells.map((c) => Math.round((Date.parse(c.ret) - Date.parse(c.out)) / 86400_000)))].sort((a, b) => a - b);
  const map = new Map(cells.map((c) => [c.out + "|" + Math.round((Date.parse(c.ret) - Date.parse(c.out)) / 86400_000), c.price]));
  const cls = scale(cells.map((c) => c.price));
  return (
    <div className="dgrid scroll">
      <table>
        <thead><tr><th>{t("wylot \\ dni")}</th>{stays.map((s) => <th key={s} className="mono">{s}</th>)}</tr></thead>
        <tbody>
          {outs.map((o) => (
            <tr key={o}><th>{fmtD(o)}</th>{stays.map((s) => { const p = map.get(o + "|" + s); return <td key={s} className={`mono ${p ? cls(p) : ""}`}>{p ? short(p) : ""}</td>; })}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function StayRange({ f, set }: { f: FormState; set: (p: Partial<FormState>) => void }) {
  return (
    <div className="stay">
      <span>{t("pobyt")} <b className="mono">{f.stayMin}–{f.stayMax}</b> {t("dni")}</span>
      <input type="range" min={1} max={60} value={f.stayMin} aria-label={t("Najkrótszy pobyt")} onChange={(e) => { const v = Number(e.target.value); set({ stayMin: v, stayMax: Math.max(v, f.stayMax ?? v) }); }} />
      <input type="range" min={1} max={60} value={f.stayMax} aria-label={t("Najdłuższy pobyt")} onChange={(e) => { const v = Number(e.target.value); set({ stayMax: v, stayMin: Math.min(v, f.stayMin ?? v) }); }} />
    </div>
  );
}

function DatePanel({ f, set, close }: { f: FormState; set: (p: Partial<FormState>) => void; close: () => void }) {
  const min = tomorrow();
  const [view, setView] = useState((f.dateFrom >= min ? f.dateFrom : min).slice(0, 7));
  const [pickRet, setPickRet] = useState(false);
  const [grid, setGrid] = useState(false);
  const months6 = Array.from({ length: 6 }, (_, i) => addMonths(min.slice(0, 7), i));
  const cal = useCalendar(f, f.dateMode !== "month" && f.dateMode !== "any6", view, 2);
  const tiles = useCalendar(f, f.dateMode === "month", min.slice(0, 7), 6);
  const visible = Object.entries(cal.days).filter(([d]) => d.slice(0, 7) === view || d.slice(0, 7) === addMonths(view, 1)).map((x) => x[1]);
  const cls = useMemo(() => scale(visible), [visible.join(",")]); // eslint-disable-line react-hooks/exhaustive-deps
  const monthMin = (m: string) => { const v = Object.entries(tiles.days).filter(([d]) => d.startsWith(m)).map((x) => x[1]); return v.length ? Math.min(...v) : null; };
  const tileVals = months6.map(monthMin).filter((x): x is number => x !== null);
  const tileCls = scale(tileVals);
  const rt = f.type !== "ow";
  const ret = f.dateMode === "exact" && rt ? f.retDate : undefined;
  const sel = (d: string) => (d === f.dateFrom ? "sel" : d === ret ? "sel ret" : ret && d > f.dateFrom && d < ret ? "in" : "");
  const pick = (d: string) => {
    if (rt && f.dateMode === "exact" && pickRet && d > f.dateFrom) { set({ retDate: d }); setPickRet(false); return; }
    set({ dateFrom: d, dateTo: d, retDate: undefined });
    if (rt && f.dateMode === "exact") setPickRet(true);
  };
  return (
    <div className="datepanel glass-solid" role="dialog" aria-label={t("Daty")}>
      <div className="seg" role="tablist">
        {([["exact", "konkretne"], ["days", "±3 dni"], ["month", "cały miesiąc"], ["any6", "kiedykolwiek (6 mies.)"]] as const).map(([m, l]) => (
          <button key={m} type="button" role="tab" aria-selected={f.dateMode === m} className={f.dateMode === m ? "on" : ""} onClick={() => set({ dateMode: m })}>{t(l)}</button>
        ))}
      </div>
      {(f.dateMode === "exact" || f.dateMode === "days") && <>
        <div className="cal-nav">
          <button type="button" onClick={() => setView(addMonths(view, -1))} disabled={view <= min.slice(0, 7)} aria-label={t("Poprzedni miesiąc")}>‹</button>
          <span className="cal-hint">{cal.loading ? t("wczytuję ceny…") : cal.error ? tx(cal.error) : rt && f.dateMode === "exact" ? (pickRet ? t("wybierz dzień powrotu") : t("wybierz dzień wylotu")) : t("najniższa cena pod każdym dniem (Google, zł/os.)")}</span>
          <button type="button" onClick={() => setView(addMonths(view, 1))} aria-label={t("Następny miesiąc")}>›</button>
        </div>
        <div className="cal-months">
          <MonthGrid ym={view} days={cal.days} cls={cls} sel={sel} onPick={pick} min={min} />
          <MonthGrid ym={addMonths(view, 1)} days={cal.days} cls={cls} sel={sel} onPick={pick} min={min} />
        </div>
        <PriceChart days={Object.fromEntries(Object.entries(cal.days).filter(([d]) => d.slice(0, 7) === view || d.slice(0, 7) === addMonths(view, 1)))} sel={f.dateFrom} onPick={pick} />
      </>}
      {f.dateMode === "month" && <>
        <div className="cal-hint">{tiles.loading ? t("wczytuję ceny miesięcy…") : t("najniższa cena w miesiącu (Google, zł/os.) · zaznacz jeden lub kilka")}</div>
        <div className="tiles">
          {months6.map((m) => {
            const p = monthMin(m);
            const on = f.months.includes(m);
            return (
              <button key={m} type="button" className={`tile ${on ? "on" : ""} ${p ? tileCls(p) : ""}`} aria-pressed={on}
                onClick={() => set({ months: on ? (f.months.length > 1 ? f.months.filter((x) => x !== m) : f.months) : [...f.months, m].sort() })}>
                <span className="t-m">{monthName(m)}</span>
                <span className="t-y">{m.slice(0, 4)}</span>
                <span className="t-p mono">{p ? t("od {price}", { price: fmtPln(p) }) : tiles.loading ? "…" : "—"}</span>
              </button>
            );
          })}
        </div>
      </>}
      {f.dateMode === "any6" && <p className="cal-note">{t("Dowolny wylot od jutra do {date} {year}. Silnik sprawdza całe okno.", { date: fmtD(addDays(min, 181)), year: addDays(min, 181).slice(0, 4) })}</p>}
      {rt && f.dateMode !== "exact" && <StayRange f={f} set={set} />}
      {rt && (f.dateMode === "exact" || f.dateMode === "days") && f.dateFrom && (
        <div className="grid-toggle">
          <button type="button" className="link" onClick={() => setGrid(!grid)}>{grid ? t("ukryj siatkę dat") : t("siatka dat: wylot × długość pobytu")}</button>
          {grid && <DateGrid f={f} around={f.dateFrom} />}
        </div>
      )}
      <div className="dp-foot"><button type="button" className="btn" onClick={close}>{t("gotowe")}</button></div>
    </div>
  );
}

export function dateSummary(f: FormState) {
  if (f.dateMode === "any6") return t("kiedykolwiek w 6 mies.");
  if (f.dateMode === "month") return f.months.map(monthName).join(", ") + ` ${f.months[f.months.length - 1]?.slice(0, 4) ?? ""}`;
  const base = f.type !== "ow" && f.dateMode === "exact" && f.retDate ? `${fmtD(f.dateFrom)} – ${fmtD(f.retDate)}` : fmtD(f.dateFrom);
  return f.dateMode === "days" ? `${base} ${t("±3 dni")}` : base;
}

// ---------------------------------------------------------------- the form

export function SearchFormPanel({ onSearch, onAsk, busy, hidden }: { onSearch: (f: FormState) => void; onAsk: (q: string) => void; busy: boolean; hidden: boolean }) {
  const [f, setF] = useState<FormState>(defaultForm);
  const [dates, setDates] = useState(false);
  const [more, setMore] = useState(false);
  const [ask, setAsk] = useState(false);
  const [q, setQ] = useState("");
  const set = (p: Partial<FormState>) => setF((x) => ({ ...x, ...p }));
  const formRef = useRef<HTMLFormElement>(null);
  const phase = useStore((s) => s.phase);
  useLang(); // re-render the labels when the language switches
  // the result panel sits below the form: publish the form's height
  useEffect(() => {
    const el = formRef.current?.parentElement;
    if (!el) return;
    const ro = new ResizeObserver(() => document.documentElement.style.setProperty("--top", `${Math.round(el.getBoundingClientRect().bottom)}px`));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // a search started from the natural-language field fills the form back
  const params = useStore((s) => s.params);
  useEffect(() => {
    // (also a search opened from a link: the form was still empty)
    if (!params || (params.tripType && f.to)) return;
    const months: string[] = [];
    for (let m = params.dateFrom.slice(0, 7); m <= params.dateTo.slice(0, 7) && months.length < 12; m = addMonths(m, 1)) months.push(m);
    const whole = params.dateFrom.endsWith("-01") && params.dateTo === monthEnd(params.dateTo.slice(0, 7));
    set({ from: tx(params.originLabel), to: tx(params.destLabel), type: params.tripType ?? (params.oneWay ? "ow" : "rt"), stayMin: params.stayMin, stayMax: params.stayMax,
      depth: params.depth ?? "fast", researchMin: params.researchMin, baggage: params.baggage ?? "cabin", pax: params.pax ?? 1, abroad: params.abroad ?? false, strict: params.strict ?? false, maxAccessH: (params as { maxAccessH?: number }).maxAccessH ?? 4, ...(whole ? { dateMode: "month" as const, months, dateFrom: params.dateFrom, dateTo: params.dateTo } : { dateMode: "days" as const, dateFrom: params.dateFrom, dateTo: params.dateTo }) });
  }, [params?.query]); // eslint-disable-line react-hooks/exhaustive-deps
  const submit = () => { if (!f.to.trim() || busy) return; setDates(false); onSearch(f); };
  return (
    <div className={`topform glass ${hidden ? "hidden" : ""} ${phase === "idle" ? "idle" : ""}`}>
      <form ref={formRef} onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <div className="f-row1">
          <div className="seg small" role="radiogroup" aria-label={t("Typ podróży")}>
            {([["rt", "tam i z powrotem"], ["ow", "w jedną stronę"], ["oj", "open-jaw"]] as const).map(([ty, l]) => (
              <button key={ty} type="button" role="radio" aria-checked={f.type === ty} className={f.type === ty ? "on" : ""} onClick={() => set({ type: ty })}>{t(l)}</button>
            ))}
          </div>
          <label className="f-inline">
            <select value={f.pax} onChange={(e) => set({ pax: Number(e.target.value) })} aria-label={t("Liczba osób")}>
              {Array.from({ length: 9 }, (_, i) => <option key={i} value={i + 1}>{i + 1} {plural(i + 1, ["osoba", "osoby", "osób"], ["person", "people"])}</option>)}
            </select>
          </label>
          {/* with a checked bag the engine adds each airline's bag fee to every ticket and finds the cheapest total */}
          <label className="f-inline">
            <select value={f.baggage} onChange={(e) => set({ baggage: e.target.value as "cabin" | "checked" })} aria-label={t("Bagaż")}>
              <option value="cabin">{t("tylko podręczny")}</option>
              <option value="checked">{t("z bagażem rejestrowanym")}</option>
            </select>
          </label>
          {/* how long to dig: the quick search (~12 min), an hour of research, or until the optimum is proven */}
          <label className="f-inline">
            <select value={f.depth === "deep" ? (f.researchMin ? "hour" : "deep") : "fast"} aria-label={t("Czas szukania")}
              onChange={(e) => {
                const v = e.target.value;
                const deep = { depth: "deep" as const, maxTripH: Math.min(f.maxTripH ?? 72, 72), stopoverDays: Math.min(f.stopoverDays ?? 3, 3) };
                set(v === "fast" ? { depth: "fast", researchMin: undefined } : v === "hour" ? { ...deep, researchMin: 60 } : { ...deep, researchMin: undefined });
              }}>
              <option value="fast">{t("szybko · ~12 min")}</option>
              <option value="hour">{t("research · ~1 h")}</option>
              <option value="deep">{t("do skutku · godziny")}</option>
            </select>
          </label>
          <button type="button" className={`more-btn ${more ? "on" : ""}`} onClick={() => setMore(!more)} aria-expanded={more}>{t("Więcej opcji")}</button>
        </div>
        {ask ? (
          <div className="f-row2">
            <div className="f-field f-q">
              <label className="f-label" htmlFor="nlq">{t("zapytanie")}</label>
              <input id="nlq" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("z Polski do Peru, luty, 2–3 tygodnie")} title={t("zapytanie po polsku")} spellCheck={false}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); if (q.trim() && !busy) onAsk(q.trim()); } }} />
            </div>
            <button type="button" className="btn primary" disabled={busy || !q.trim()} onClick={() => onAsk(q.trim())}>{busy ? t("liczę…") : t("szukaj")}</button>
          </div>
        ) : (
          <div className="f-row2">
            <PlaceInput label={t("skąd")} value={f.from} onChange={(v) => set({ from: v })} placeholder={t("miasto, lotnisko, kraj")}
              extra={/* "tylko stąd": only the airports of the typed city or country, none around it (no Berlin for Polska) */
                <label className={`f-strict ${f.strict ? "on" : ""}`} title={t("Tylko lotniska wpisanego miasta lub kraju, bez okolicznych (np. Berlin, Praga, Budapeszt dla Polski)")}>
                  <input type="checkbox" checked={f.strict === true} onChange={(e) => set({ strict: e.target.checked })} />{t("tylko stąd")}
                </label>} />
            <button type="button" className="swap" aria-label={t("Zamień skąd i dokąd")} onClick={() => set({ from: f.to, to: f.from })}>⇄</button>
            <PlaceInput label={f.type === "oj" ? t("przylot do") : t("dokąd")} value={f.to} onChange={(v) => set({ to: v })} placeholder={t("miasto, kraj, region, gdziekolwiek")} />
            {f.type === "oj" && <PlaceInput label={t("powrót z")} value={f.toRet ?? ""} onChange={(v) => set({ toRet: v })} placeholder={t("miasto, kraj")} />}
            <div className="f-field f-dates">
              <span className="f-label">{t("daty")}</span>
              <button type="button" className="f-datebtn" aria-expanded={dates} onClick={() => setDates(!dates)}>{dateSummary(f)}{f.type !== "ow" && f.dateMode !== "exact" ? <span className="dim"> · {t("{min}–{max} dni", { min: f.stayMin ?? "", max: f.stayMax ?? "" })}</span> : null}</button>
            </div>
            <button type="submit" className="btn primary" disabled={busy || !f.to.trim()}>{busy ? t("liczę…") : t("szukaj")}</button>
          </div>
        )}
        {dates && !ask && <DatePanel f={f} set={set} close={() => setDates(false)} />}
        {more && (
          <div className="f-more">
            <div className="fm-group">
              <label className="chk"><input type="checkbox" checked={f.access !== false} onChange={(e) => set({ access: e.target.checked })} /> {t("licz dojazd z")}</label>
              <input className="f-home" value={f.home ?? ""} disabled={f.access === false} onChange={(e) => set({ home: e.target.value })} aria-label={t("Miasto startowe")} size={Math.max(6, (f.home ?? "").length)} />
            </div>
            <div className="fm-group">
              <span className="fm-k">{t("Max dojazd do lotniska")}</span>
              <div className="seg small" role="radiogroup" aria-label={t("Maksymalny czas dojazdu do lotniska")}>
                {([[2, "2 h"], [4, "4 h"], [6, "6 h"], [0, "bez limitu"]] as const).map(([h, l]) => (
                  <button key={h} type="button" role="radio" aria-checked={(f.maxAccessH ?? 4) === h} className={(f.maxAccessH ?? 4) === h ? "on" : ""} onClick={() => set({ maxAccessH: h })}>{t(l)}</button>
                ))}
              </div>
            </div>
            <label className="chk"><input type="checkbox" checked={f.abroad === true && !f.strict} disabled={f.strict === true} onChange={(e) => set({ abroad: e.target.checked })} /> {t("+ lotniska za granicą")}</label>
            <label className="rng">{t("maks. czas podróży")} <b className="mono">{f.depth === "deep" ? `${Math.min(f.maxTripH ?? 72, 72)} h` : `${Math.round((f.maxTripH ?? 96) / 24)} ${Math.round((f.maxTripH ?? 96) / 24) === 1 ? t("dzień") : t("dni")}`}</b>
              {f.depth === "deep"
                ? <input type="range" min={12} max={72} step={6} value={Math.min(f.maxTripH ?? 72, 72)} onChange={(e) => set({ maxTripH: Number(e.target.value) })} />
                : <input type="range" min={1} max={7} value={Math.round((f.maxTripH ?? 96) / 24)} onChange={(e) => set({ maxTripH: Number(e.target.value) * 24 })} />}</label>
            <label className="rng">{t("postoje w mieście do")} <b className="mono">{f.stopoverDays === 0 ? "30 h" : `${f.stopoverDays ?? 3} ${t("dni")}`}</b>
              <input type="range" min={0} max={f.depth === "deep" ? 3 : 7} value={f.stopoverDays ?? 3} onChange={(e) => set({ stopoverDays: Number(e.target.value) })} /></label>
            <label className="chk"><input type="checkbox" checked={f.countHotel !== false} onChange={(e) => set({ countHotel: e.target.checked })} /> {t("doliczaj nocleg na postojach")}</label>
            <button type="button" className="link" onClick={() => setAsk(!ask)}>{ask ? t("wróć do formularza") : t("zapytaj zdaniem")}</button>
          </div>
        )}
      </form>
    </div>
  );
}
