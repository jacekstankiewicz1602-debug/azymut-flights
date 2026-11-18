// The live query feed: source questions (their cache keys) turned into short readable lines.

export type FeedLine = { id: number; src: string; tag: string; route: string; dates: string; note: string; from?: string; to?: string; at?: number; hit?: boolean };

const SRC: Record<string, [string, string]> = {
  kiwi: ["Kiwi", "kiwi"], fr: ["Ryanair", "fr"], wizz: ["Wizz Air", "wizz"], g: ["Google", "g"],
  avs: ["Aviasales", "avs"], flix: ["FlixBus", "flix"], kayak: ["Kayak", "kayak"], serp: ["Google", "g"], duffel: ["Duffel", "g"],
};
const isDay = (s: string | undefined) => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);
const day = (s: string) => `${s.slice(8, 10)}.${s.slice(5, 7)}`;
const span = (a?: string, b?: string) => (isDay(a) ? (isDay(b) && b !== a ? `${day(a!)}–${day(b!)}` : day(a!)) : "");
const codes = (s: string | undefined) => (s ?? "").split(",").filter((c) => /^[A-Z]{3}$/.test(c));
const list = (cs: string[]) => (cs.length > 3 ? `${cs.slice(0, 3).join(" ")} +${cs.length - 3}` : cs.join(" "));

export function feedLine(id: number, key: string, cached: boolean, ms: number, n: number | null): FeedLine {
  const k = key.split(":");
  const [src, tag] = SRC[k[0]] ?? [k[0], "x"];
  let from: string[] = [], to: string[] = [], dates = "", what = "";
  switch (`${k[0]}:${k[1]}`) {
    case "kiwi:rt": from = codes(k[2]); to = codes(k[3]); dates = `${span(k[4], k[5])} ⇄ ${span(k[6], k[7])}`; break;
    case "kiwi:ow": from = codes(k[2]); to = codes(k[3]); dates = span(k[4], k[5]); if (k[3] === "ANY") what = "cały świat"; break;
    case "fr:map": from = codes(k[2]); what = "mapa tras"; break;
    case "fr:days": case "wizz:days": from = codes(k[2]); to = codes(k[3]); dates = span(k[4], k[5]); break;
    case "wizz:map": from = codes(k[2]); what = "mapa tras"; break;
    case "g:ow3": from = codes(k[2]); to = codes(k[3]); dates = span(k[4]); break;
    case "g:owc3": from = codes(k[2]); to = codes(k[3]); dates = span(k[4]); break;
    case "g:grid2": case "g:owgrid": case "g:cal": from = codes(k[2]); to = codes(k[3]); dates = span(k[4], k[5]); what = "kalendarz cen"; break;
    case "avs:days": from = codes(k[2]); to = codes(k[3]); what = "kalendarz cen"; break;
    case "avs:sched": from = codes(k[2]); to = codes(k[3]); dates = span(k[4], k[5]); break;
    case "kayak:explore": from = codes(k[2]); dates = `${span(k[3])} ⇄ ${span(k[4])}`; what = "mapa cen"; break;
    default: {
      if (k[0] === "flix") { what = "autobus"; dates = span(k[3]); break; }
      // any other question: its airports and first dates, as far as the key shows them
      from = codes(k[2]); to = codes(k[3]);
      const ds = k.filter(isDay);
      dates = span(ds[0], ds[1]);
      if (!from.length && !to.length) what = k.slice(1, 3).join(" ");
    }
  }
  const route = from.length || to.length ? `${list(from)}${to.length ? ` → ${list(to)}` : ""}${what ? ` · ${what}` : ""}` : what;
  const note = cached ? "z pamięci" : `${n !== null ? `${n} wyn. · ` : ""}${ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`}`;
  return { id, src, tag, route, dates, note, from: from[0], to: to[0], hit: cached };
}
