"use client";
// "Gdziekolwiek tanio z Polski": the worker's nightly list of the cheapest round trips from Poland,
// as price pins on the globe and a sorted list with filters. A destination opens its price calendar
// and plays the stored route on the globe.
import { Fragment, useEffect, useMemo, useState } from "react";
import type { SearchResult, Trip } from "@/lib/engine";
import { AIRPORT_POS, ccOf, countryName, fmtDate, fmtPln } from "./geo";
import { defaultForm, MonthGrid, PriceChart, scale, useCalendar, type FormState } from "./Form";
import { getState, setState, useStore, type Pin } from "./store";
import { plural, svg } from "./trip-info";
import { locale, t, tx, useLang } from "./i18n";
import { useSwipeClose } from "./swipe";

type Row = {
  dest: string; month: string; stay: string; price: number | null; lb: number | null; nodes: string[] | null;
  outDate: string | null; retDate: string | null; connections: number | null; travelH: number | null; verified: boolean;
  source: string; access: number | null; google: number | null; deal: boolean; norm: number | null; zone?: Zone;
};
type Zone = "eu" | "near" | "world" | "long";
/** the list's sections and their limits (lib/anywhere-cheap ZONES) */
const ZONES: [Zone, string][] = [["eu", "Europa · do 400 zł"], ["near", "Blisko poza Europą · do 1500 zł"], ["world", "Reszta świata · do ~3000 zł"], ["long", "Ameryka Płd. i Australia · do 4000 zł"]];
type Data = { rows: Row[]; run: { startedAt: number; finishedAt: number | null; phase: string } | null };

const monthName = (ym: string) => new Intl.DateTimeFormat(locale(), { month: "long", timeZone: "UTC" }).format(new Date(Date.parse(ym.slice(0, 7) + "-01")));
const REGIONS: [string, string][] = [["", "wszystkie regiony"], ["SAM", "Ameryka Płd."], ["CAR", "Karaiby i Am. Śr."], ["NAM", "Ameryka Płn."],
  ["SEA", "Azja Płd.-Wsch."], ["SAS", "Azja Płd."], ["EAS", "Azja Wsch."], ["CAS", "Azja Środk."], ["MEA", "Bliski Wschód"],
  ["NAF", "Afryka Płn."], ["AFR", "Afryka"], ["OCE", "Oceania"], ["CAU", "Kaukaz"], ["EUR", "Europa"]];
// pin colors (hex: GL layers cannot read CSS variables), green → red by rank
const RAMP = ["#2f7d52", "#5d8a2c", "#9a7414", "#b4602a", "#b0443a"];

const months6 = () => {
  const out: string[] = [];
  const d = new Date();
  for (let i = 0; i < 7; i++) out.push(new Date(Date.UTC(d.getFullYear(), d.getMonth() + i, 1)).toISOString().slice(0, 7));
  return out;
};
const zoneIdx = (z: Zone) => Math.max(0, ZONES.findIndex(([k]) => k === z));
const city = (c: string) => AIRPORT_POS[c]?.city ?? c;
const value = (r: Row) => r.price ?? r.lb ?? 0;

export function openAnywhere() {
  setState({ pins: [], pinPick: null, journeyPhase: "none" });
}

export function AnywhereButton() {
  const phase = useStore((s) => s.phase);
  const pins = useStore((s) => s.pins);
  const journey = useStore((s) => s.journeyPhase);
  useLang();
  if (pins || journey !== "none" || (phase !== "idle" && phase !== "done" && phase !== "error")) return null;
  return <button className="any-btn" onClick={openAnywhere}><span style={{ display: "contents" }} dangerouslySetInnerHTML={{ __html: svg("globe", "") }} />{t("Gdziekolwiek tanio z Polski")}</button>;
}

export function AnywherePanel({ onSearch }: { onSearch: (f: FormState) => void }) {
  const pins = useStore((s) => s.pins);
  const pick = useStore((s) => s.pinPick);
  const journey = useStore((s) => s.journeyPhase);
  const open = useStore((s) => s.panelOpen);
  useLang(); // re-render the labels when the language switches
  const [f, setF] = useState({ month: "", stay: "", region: "", max: "", conn: "", far: false, scope: "zones" as "zones" | "far" | "all", access: true });
  const [data, setData] = useState<Data | null>(null);
  const [err, setErr] = useState("");
  const active = pins !== null;
  const qs = new URLSearchParams({ pc: "0", month: f.month, stay: f.stay, region: f.region, max: f.max, conn: f.conn, far: f.scope === "far" ? "1" : "0", zones: f.scope === "zones" ? "1" : "0", access: f.access ? "1" : "0" });
  useEffect(() => {
    if (!active) return;
    let dead = false;
    setErr("");
    fetch(`/api/anywhere-cheap?${qs}`).then((r) => r.json()).then((d: Data) => { if (!dead) setData(d); }).catch(() => !dead && setErr(t("nie udało się wczytać listy")));
    return () => { dead = true; };
  }, [active, qs.toString()]); // eslint-disable-line react-hooks/exhaustive-deps

  const rows = useMemo(() => (data?.rows ?? []).filter((r) => AIRPORT_POS[r.dest]), [data]);
  // one entry per country: its cheapest destination first, the other cities behind it
  const groups = useMemo(() => {
    const by = new Map<string, Row[]>();
    for (const r of [...rows].sort((a, b) => value(a) - value(b))) {
      const cc = ccOf(r.dest);
      const g = by.get(cc);
      if (!g) by.set(cc, [r]); else if (!g.some((x) => city(x.dest) === city(r.dest))) g.push(r);
    }
    return [...by.entries()].map(([cc, list]) => ({ cc, best: list[0], list, zone: list[0].zone ?? "world" }));
  }, [rows]);
  const [openCc, setOpenCc] = useState<string | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  // pins: verified prices colored by rank; bounds (no live price yet) dimmed
  useEffect(() => {
    if (!active) return;
    const p: Pin[] = groups.slice(0, 160).map((g, k) => ({ code: g.best.dest, price: value(g.best), name: city(g.best.dest),
      color: RAMP[Math.min(RAMP.length - 1, Math.floor((k / Math.max(1, groups.length)) * RAMP.length))], deal: g.best.deal, verified: g.best.verified }));
    setState({ pins: p });
  }, [groups, active]);
  // a pin on the globe opens its country in the list
  useEffect(() => {
    if (!pick) return;
    setOpenCc(ccOf(pick)); setDetail(null); setState({ pinPick: null, panelOpen: true });
    setTimeout(() => document.getElementById(`cc-${ccOf(pick)}`)?.scrollIntoView({ block: "start", behavior: "smooth" }), 80);
  }, [pick]);
  const swipe = useSwipeClose(() => { setState({ pins: null, pinPick: null }); setDetail(null); });
  if (!active || journey !== "none") return null;
  const sel = detail ? rows.find((r) => r.dest === detail) ?? null : null;
  const close = () => { setState({ pins: null, pinPick: null }); setDetail(null); };
  return (
    <section ref={swipe} className={`results glass anyc ${open ? "open" : "closed"}`} aria-label={t("Gdziekolwiek tanio z Polski")}>
      <div className="r-handle any-head">
        <button className="any-title" onClick={() => setState((s) => ({ panelOpen: !s.panelOpen }))} aria-expanded={open}>
          <span className="r-grip" />{t("Gdziekolwiek tanio z Polski")}
        </button>
        <button className="any-close" onClick={close} aria-label={t("Zamknij")}>×</button>
      </div>
      {open && (sel ? <Detail r={sel} access={f.access} back={() => setDetail(null)} onSearch={onSearch} /> : (
        <div className="r-body scroll">
          <div className="any-filters">
            <select value={f.month} onChange={(e) => setF({ ...f, month: e.target.value })} aria-label={t("Miesiąc")}>
              <option value="">{t("każdy miesiąc")}</option>
              {months6().map((m) => <option key={m} value={m}>{monthName(m)} {m.slice(0, 4)}</option>)}
            </select>
            <select value={f.stay} onChange={(e) => setF({ ...f, stay: e.target.value })} aria-label={t("Długość pobytu")}>
              <option value="">{t("pobyt 5–21 dni")}</option><option value="5-9">{t("{min}–{max} dni", { min: 5, max: 9 })}</option><option value="10-14">{t("{min}–{max} dni", { min: 10, max: 14 })}</option><option value="15-21">{t("{min}–{max} dni", { min: 15, max: 21 })}</option>
            </select>
            <select value={f.region} onChange={(e) => setF({ ...f, region: e.target.value, scope: e.target.value === "EUR" && f.scope === "far" ? "zones" : f.scope })} aria-label={t("Region")}>
              {REGIONS.map(([k, l]) => <option key={k} value={k}>{t(l)}</option>)}
            </select>
            <select value={f.conn} onChange={(e) => setF({ ...f, conn: e.target.value })} aria-label={t("Przesiadki")}>
              <option value="">{t("dowolne przesiadki")}</option><option value="0">{t("bez przesiadek")}</option><option value="1">{t("max 1 przesiadka")}</option><option value="2">{t("max {n} przesiadki", { n: 2 })}</option><option value="3">{t("max {n} przesiadki", { n: 3 })}</option>
            </select>
            <label className="any-max"><span>max</span><input inputMode="numeric" value={f.max} placeholder="zł" onChange={(e) => setF({ ...f, max: e.target.value.replace(/\D/g, "") })} aria-label={t("Cena maksymalna")} /></label>
            <select value={f.scope} onChange={(e) => setF({ ...f, scope: e.target.value as typeof f.scope })} aria-label={t("Zasięg")}>
              <option value="zones">{t("cały świat, tanio dla regionu")}</option><option value="far">{t("tylko dalekie (poza Europą, 3500+ km)")}</option><option value="all">{t("cały świat, bez progów cen")}</option>
            </select>
            <label className="chk"><input type="checkbox" checked={f.access} onChange={(e) => setF({ ...f, access: e.target.checked })} /> {t("dojazd z Poznania")}</label>
          </div>
          <div className="any-meta">
            {err || (data?.run ? `${plural(groups.length, "kraj", "kraje", "krajów")}, ${plural(rows.length, "miasto", "miasta", "miast")} · ${data.run.finishedAt ? t("policzone {ago}", { ago: fmtAgo(data.run.finishedAt) }) : t("liczę teraz ({phase})", { phase: tx(data.run.phase) })}` : data ? t("lista jeszcze nie policzona – worker liczy ją w nocy") : t("wczytuję…"))}
          </div>
          <ol className="any-list">
            {(f.scope === "zones" ? [...groups].sort((a, b) => zoneIdx(a.zone) - zoneIdx(b.zone)) : groups).slice(0, 160).map(({ cc, best: r, list, zone }, k, all) => {
              const open = openCc === cc;
              const head = f.scope === "zones" && (k === 0 || all[k - 1].zone !== zone);
              return (
                <Fragment key={cc}>
                {head && <li className="any-zone">{t(ZONES[zoneIdx(zone)][1])}</li>}
                <li id={`cc-${cc}`} className={open ? "open" : ""}>
                  <button className="any-row" onClick={() => setOpenCc(open ? null : cc)} aria-expanded={open}>
                    <span className="ar-main">
                      <span className="ar-city">{countryName(cc)}{r.deal && <span className="ar-deal">{t("okazja")}</span>}</span>
                      <span className="ar-sub">{city(r.dest)}{r.outDate && r.retDate ? ` · ${fmtDate(r.outDate)} – ${fmtDate(r.retDate)}` : ""}
                        {r.connections !== null && ` · ${r.connections === 0 ? t("bez przesiadek") : t("{n} przes.", { n: r.connections })}`}
                        {list.length > 1 ? ` · +${plural(list.length - 1, "miasto", "miasta", "miast")}` : ""}</span>
                    </span>
                    <span className={`ar-price mono ${r.verified ? "" : "est"}`}>{r.verified ? "" : t("od ~")}{fmtPln(value(r))}</span>
                    <span className="ar-chev" aria-hidden="true" />
                  </button>
                  {open && (
                    <ul className="any-cities">
                      {list.map((c) => (
                        <li key={c.dest}>
                          <button className="any-city" onClick={() => { setDetail(c.dest); }}>
                            <span className="ac-name">{city(c.dest)} <span className="ar-code mono">{c.dest}</span>{c.deal && <span className="ar-deal">{t("okazja")}</span>}</span>
                            <span className="ac-when">{c.outDate && c.retDate ? `${fmtDate(c.outDate)} – ${fmtDate(c.retDate)}` : monthName(c.month)}
                              {c.connections !== null && ` · ${c.connections === 0 ? t("bez przesiadek") : t("{n} przes.", { n: c.connections })}`}</span>
                            <span className={`ac-price mono ${c.verified ? "" : "est"}`}>{c.verified ? "" : t("od ~")}{fmtPln(value(c))}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
                </Fragment>
              );
            })}
          </ol>
        </div>
      ))}
    </section>
  );
}

function fmtAgo(at: number) {
  const h = Math.round((Date.now() - at) / 3600_000);
  return h < 1 ? t("przed chwilą") : h < 24 ? t("{n} h temu", { n: h }) : t("{n} dni temu", { n: Math.round(h / 24) });
}

/** One destination: its price calendar (Google, from Poznań area) and the stored route on the globe. */
function Detail({ r, access, back, onSearch }: { r: Row; access: boolean; back: () => void; onSearch: (f: FormState) => void }) {
  const start = r.month;
  const form: FormState = { ...defaultForm(), from: "Polska", to: r.dest, type: "rt", stayMin: 5, stayMax: 21, access, months: [r.month], dateFrom: `${r.month}-01` };
  const cal = useCalendar(form, true, start, 2);
  const values = Object.values(cal.days);
  const cls = scale(values);
  const next = new Date(Date.parse(start + "-01"));
  next.setUTCMonth(next.getUTCMonth() + 1);
  const ym2 = next.toISOString().slice(0, 7);
  const [busy, setBusy] = useState(false);
  const play = async () => {
    setBusy(true);
    const j = await fetch(`/api/anywhere-cheap?trip=${r.dest}&month=${r.month}&stay=${r.stay}&access=${access ? 1 : 0}`).then((x) => x.json()).catch(() => null);
    setBusy(false);
    const t = j?.trip as Trip | null;
    if (!t) return;
    const result = { trips: [t], baseline: r.google ? { price: r.google, url: "", summary: "", origins: [], outDate: t.outDate, retDate: t.retDate } : null,
      savings: null, provenOptimal: false, gap: null, summary: "", stats: getState().stats, notes: [], paused: false, lowerBound: null, unverified: 0, truncated: false } as unknown as SearchResult;
    setState((s) => ({ result, selected: 0, journeyKey: s.journeyKey + 1, journeyPhase: "flying", panelOpen: true }));
  };
  const searchDay = (d: string) => onSearch({ ...form, dateMode: "days", dateFrom: d, dateTo: d });
  return (
    <div className="r-body scroll any-detail">
      <button className="any-back" onClick={back}>← {t("Lista")}</button>
      <div className="ad-head">
        <div className="ad-city">{city(r.dest)} <span className="mono">{r.dest}</span>{r.deal && <span className="ar-deal">{t("okazja")}{r.norm ? ` ${t("(norma ~{price})", { price: fmtPln(r.norm) })}` : ""}</span>}</div>
        <div className="ad-price mono">{r.verified ? "" : t("od ~")}{fmtPln(value(r))}</div>
      </div>
      <div className="ad-sub">
        {r.outDate && r.retDate ? `${fmtDate(r.outDate)} – ${fmtDate(r.retDate)}` : t("termin do sprawdzenia")}
        {r.nodes ? ` · ${r.nodes.filter((n, i, a) => n !== a[i - 1]).join(" – ")}` : ""}
        {r.travelH ? ` · ${t("do {h} h w jedną stronę", { h: r.travelH })}` : ""}
        {r.access ? ` · ${t("dojazd ~{price}", { price: fmtPln(r.access) })}` : ""}
        {r.google ? ` · Google ${fmtPln(r.google)}` : ""}
        {!r.verified && ` · ${t("dolna granica z mapy cen, bez potwierdzenia na żywo")}`}
      </div>
      <div className="ad-actions">
        <button className="btn-primary" disabled={!r.verified || busy} onClick={() => void play()}>{busy ? t("wczytuję…") : t("pokaż trasę na globusie")}</button>
        <button onClick={() => onSearch({ ...form, dateMode: "month", months: [r.month] })}>{t("szukaj dokładnie")}</button>
      </div>
      <div className="ad-cal-title">{t("kalendarz cen (lot tam i z powrotem, pobyt 5–21 dni) – kliknij dzień, by szukać")}</div>
      {cal.loading && <div className="pg-msg">{t("wczytuję kalendarz…")}</div>}
      {cal.error && !cal.loading && <div className="pg-msg err">{tx(cal.error)}</div>}
      <div className="ad-cal">
        <MonthGrid ym={start} days={cal.days} cls={cls} sel={() => ""} onPick={searchDay} min={new Date().toISOString().slice(0, 10)} />
        <MonthGrid ym={ym2} days={cal.days} cls={cls} sel={() => ""} onPick={searchDay} min={new Date().toISOString().slice(0, 10)} />
      </div>
      <PriceChart days={cal.days} sel={null} onPick={searchDay} />
    </div>
  );
}
