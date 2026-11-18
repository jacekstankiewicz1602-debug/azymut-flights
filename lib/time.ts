// Timezone helpers: airline APIs return local wall-clock times.
const fmtCache = new Map<string, Intl.DateTimeFormat>();

function tzOffsetMs(utcMs: number, tz: string): number {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    fmtCache.set(tz, f);
  }
  const p: Record<string, number> = {};
  for (const part of f.formatToParts(new Date(utcMs))) if (part.type !== "literal") p[part.type] = Number(part.value);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/** "2027-02-01T06:55[:00]" local in tz -> UTC ms */
export function localToUtc(local: string, tz: string): number {
  const [d, t = "00:00"] = local.replace(" ", "T").split("T");
  const [y, m, day] = d.split("-").map(Number);
  const [hh, mm] = t.split(":").map(Number);
  const guess = Date.UTC(y, m - 1, day, hh, mm);
  let ts = guess - tzOffsetMs(guess, tz);
  ts = guess - tzOffsetMs(ts, tz);
  return ts;
}

/** UTC ms -> local "YYYY-MM-DDTHH:mm" */
export function utcToLocal(ms: number, tz: string): string {
  return new Date(ms + tzOffsetMs(ms, tz)).toISOString().slice(0, 16);
}

export const DAY = 86_400_000;
export const HOUR = 3_600_000;

export function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
export function dayMs(iso: string): number {
  return Date.parse(iso + "T00:00:00Z");
}
export function addDays(iso: string, n: number): string {
  return isoDay(dayMs(iso) + n * DAY);
}
export function monthsBetween(fromIso: string, toIso: string): string[] {
  const out: string[] = [];
  let [y, m] = fromIso.slice(0, 7).split("-").map(Number);
  const end = toIso.slice(0, 7);
  for (;;) {
    const k = `${y}-${String(m).padStart(2, "0")}`;
    out.push(k);
    if (k >= end) break;
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return out;
}
export function monthEnd(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return isoDay(Date.UTC(y, m, 0));
}
