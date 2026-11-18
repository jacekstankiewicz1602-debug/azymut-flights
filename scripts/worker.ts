// The laptop worker: a long-running Node process that takes searches from the Neon queue and runs
// them without Vercel's time limits, from the home IP. Vercel only serves the UI and queues jobs.
//   npm run worker            (env from .env.local + .env; see worker/README.md)
import { hostname } from "node:os";
import { execFile } from "node:child_process";
import { config } from "../lib/config";
import { sqlClient } from "../lib/db";
import { runStep } from "../lib/live";
import { sendMail } from "../lib/mail";
import { nightlyJobs } from "../lib/nightly";

process.env.AZ_PHASELOG ??= "1";
const ME = hostname(); // one row per laptop; a restarted worker takes over its own claims
const APP = process.env.APP_URL || "http://localhost:3000";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let current: string | null = null;

/** Desktop notification (Linux notify-send) and, with RESEND_API_KEY + ALERT_EMAIL, a mail. */
async function notify(subject: string, text: string) {
  execFile("notify-send", ["-a", "Azymut", subject, text], () => {});
  const sent = await sendMail(subject, text).catch(() => false);
  console.log(`[notify] ${subject}${sent ? " (mail sent)" : ""}`);
}

async function heartbeat() {
  const sql = await sqlClient();
  if (!sql) return;
  const info = { pid: process.pid, current, rssMb: Math.round(process.memoryUsage().rss / 1e6), version: 1 };
  await sql`insert into workers (id, seen_at, info) values (${ME}, now(), ${sql.json(info as never)})
    on conflict (id) do update set seen_at = now(), info = excluded.info`.catch((e) => console.error("heartbeat", e.message));
}

/** Atomically take the oldest queued worker search (or one whose worker died: no checkpoint for 10 min). */
/** Is a worker search waiting? (lets the nightly job yield without taking the search itself) */
async function pending(): Promise<boolean> {
  const sql = await sqlClient();
  if (!sql) return false;
  const [r] = await sql`select 1 from live_searches where status = 'running' and runner = 'worker'
    and (claimed_by is null or claimed_by = ${ME} or updated_at < now() - interval '10 minutes') limit 1`;
  return !!r;
}

async function claim(): Promise<{ id: string; deep: boolean; researchMin?: number } | null> {
  const sql = await sqlClient();
  if (!sql) return null;
  const [r] = await sql`update live_searches set claimed_by = ${ME}, updated_at = now(), message = 'worker: start'
    where id = (select id from live_searches where status = 'running' and runner = 'worker'
      and (claimed_by is null or claimed_by = ${ME} or updated_at < now() - interval '10 minutes')
      order by created_at limit 1 for update skip locked)
    returning id, params`;
  const pr = r?.params as { depth?: string; researchMin?: number } | undefined;
  return r ? { id: r.id as string, deep: pr?.depth === "deep", researchMin: pr?.researchMin } : null;
}

const fmt = (n: number) => Math.round(n).toLocaleString("pl-PL");

async function runOne(id: string, deep: boolean, researchMin?: number) {
  const sql = (await sqlClient())!;
  current = id;
  const t0 = Date.now();
  let alerted = false;
  console.log(`[search] ${id} ${deep ? `deep${researchMin ? ` ${researchMin} min` : ""}` : "fast"}`);
  // deep: no time limit: each round runs until its branch and bound is finished (or the user presses
  // "Zatrzymaj"); rounds go on (next week of the range when the map search hits its memory cap) until
  // the optimum is proven, the source budgets run out, or rounds stop improving anything
  // a fast search has a time limit (then the best trip found and the gap to the bound); a deep one none
  // "research ~1 h": a deep search with its own time cap
  const max = !deep ? config.worker.fastMinutes : researchMin ? researchMin : config.worker.maxHours > 0 ? config.worker.maxHours * 60 : Infinity;
  let opts = { stepSeconds: Infinity, hardSeconds: Infinity, maxMinutes: max, unlimited: true };
  // during the search: one notification when it clearly beats the preliminary answer (≥ 5 % cheaper)
  let beatPrelim = false;
  const watch = setInterval(async () => {
    const [w] = await sql`select trips->0->>'price' as best, stats->'prelim' as prelim, params->>'query' as q from live_searches where id = ${id}`.catch(() => [] as never[]);
    const b = Number((w as { best?: string } | undefined)?.best), pre = (w as { prelim?: { price: number } | null } | undefined)?.prelim?.price;
    if (beatPrelim || !pre || !Number.isFinite(b) || b > pre * 0.95) return;
    beatPrelim = true;
    await notify(`Azymut: ${fmt(b)} zł – o ${fmt(pre - b)} zł taniej niż wstępny wynik`, `${(w as { q?: string }).q ?? id}\nSzukanie trwa dalej.\n${APP}/#s=${id}`);
  }, 30_000);
  try {
    for (let round = 1; ; round++) {
      const more = await runStep(id, opts);
      const [row] = await sql`select status, trips, baseline, params, summary, stats from live_searches where id = ${id}`;
      const st = row?.stats as { reasonable?: { price: number } | null; strategist?: { checked: number; hypotheses: { label: string; status: string; price: number | null; won: boolean }[] }; deep?: { proven: boolean[]; chunk: number } } | null;
      if (st) console.log(`[search] ${id} rozsądna ${st.reasonable?.price ?? "-"} | strateg ${st.strategist?.checked ?? 0} hipotez, ok ${st.strategist?.hypotheses.filter((h) => h.status === "ok").length ?? 0}, wygrane: ${st.strategist?.hypotheses.filter((h) => h.won).map((h) => h.label).join("; ") || "-"} | tygodnie z dowodem ${st.deep ? st.deep.proven.filter(Boolean).length + "/" + st.deep.proven.length : "-"}`);
      const best = (row?.trips as { price: number }[] | undefined)?.[0]?.price;
      const google = (row?.baseline as { price: number } | null)?.price;
      console.log(`[search] ${id} round ${round}: ${row?.status} best ${best ?? "-"} google ${google ?? "-"} (${Math.round((Date.now() - t0) / 60000)} min)`);
      const q = (row?.params as { query?: string })?.query ?? id;
      // a quick search that ran out of time with a gap goes on in the background (runStep marks it "extended")
      const ext = (row?.params as { extended?: number } | undefined)?.extended;
      if (!deep && ext && opts.maxMinutes === max) opts = { ...opts, maxMinutes: max + ext };
      if (!alerted && best && google && best <= google * 0.85 && google - best >= 300) {
        alerted = true;
        await notify(`Azymut: ${fmt(best)} zł – o ${fmt(google - best)} zł taniej niż Google`, `${q}\nSzukanie trwa dalej.\n${APP}/#s=${id}`);
      }
      if (!more) {
        await notify(`Azymut: wyszukiwanie zakończone${best ? ` – ${fmt(best)} zł` : ""}`,
          `${q}\n${best ? `Najtaniej ${fmt(best)} zł` : "Brak wyniku"}${google ? `, Google ${fmt(google)} zł` : ""}, ${Math.round((Date.now() - t0) / 60000)} min.\n${APP}/#s=${id}`);
        break;
      }
    }
  } finally { clearInterval(watch); }
  current = null;
}

(async () => {
  if (!config.databaseUrl) throw new Error("DATABASE_URL missing (load .env.local)");
  console.log(`[worker] ${ME} up`);
  // Neon suspends after 5 idle minutes and bills the time it is awake, so the idle worker does not
  // query it: it reads the doorbell on Vercel (rung when a worker search is queued) and touches the
  // database only when it rings, for 10 minutes after a search, and in a sweep every 30 minutes
  // (heartbeat, missed rings, nightly jobs). During a search the heartbeat runs every 15 s.
  setInterval(() => { if (current) void heartbeat(); }, 15_000);
  let lastBell: number | null = null, hotUntil = 0, lastSweep = 0;
  const bell = async (): Promise<number | null> => {
    try {
      const r = await fetch(`${APP}/api/cron/bell`, { headers: { authorization: `Bearer ${config.cronSecret}` }, signal: AbortSignal.timeout(10_000) });
      return r.ok ? ((await r.json()) as { bell: number }).bell : null;
    } catch { return null; }
  };
  for (;;) {
    const b = await bell();
    const rang = b !== null && lastBell !== null && b !== lastBell;
    if (b !== null) lastBell = b;
    const sweep = Date.now() - lastSweep > (b === null ? 5 : 30) * 60_000; // no doorbell: sweep every 5 min
    if (rang || sweep || Date.now() < hotUntil) {
      if (sweep) lastSweep = Date.now();
      if (rang || sweep) await heartbeat();
      const job = await claim().catch((e) => { console.error("claim", e.message); return null; });
      if (job) {
        await runOne(job.id, job.deep, job.researchMin).catch((e) => console.error("search", job.id, e));
        hotUntil = Date.now() + 10 * 60_000;
        continue;
      }
      if (rang) hotUntil = Math.max(hotUntil, Date.now() + 60_000); // the ring may beat the insert's commit
      // the nightly "anywhere cheap" list and other periodic jobs (they check their own schedule)
      if (sweep) await nightlyJobs(pending).catch((e) => console.error("nightly", e));
    }
    await sleep(Date.now() < hotUntil ? 3000 : 10_000);
  }
})();
