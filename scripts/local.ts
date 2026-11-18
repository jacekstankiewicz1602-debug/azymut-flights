// npm run local: the whole app on this computer, no accounts and no setup. Starts an embedded Postgres
// (data in .azymut/), loads the bundled price map on the first run, then runs the site and the search
// worker side by side. Open http://localhost:3000 (no password). Ctrl+C stops everything.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import postgres from "postgres";

const ROOT = process.cwd();
const DIR = join(ROOT, ".azymut");
const PORT = Number(process.env.PORT || 3000);
const PG_PORT = Number(process.env.AZYMUT_PG_PORT || 54330);
const URL = `postgres://azymut:azymut@127.0.0.1:${PG_PORT}/postgres`;
const log = (s: string) => console.log(`\x1b[38;5;209m[azymut]\x1b[0m ${s}`);

(async () => {
  mkdirSync(DIR, { recursive: true });
  const pg = new EmbeddedPostgres({ databaseDir: join(DIR, "pg"), user: "azymut", password: "azymut", port: PG_PORT, persistent: true, onLog: () => {} });
  if (!existsSync(join(DIR, "pg", "PG_VERSION"))) { log("pierwsze uruchomienie: zakładam bazę w .azymut/"); await pg.initialise(); }
  await pg.start();
  log(`baza działa (port ${PG_PORT})`);

  // the schema comes from lib/db.ts on first use; here only the price map seed
  process.env.AZYMUT_DATABASE_URL = URL;
  const { sqlClient } = await import("../lib/db");
  await sqlClient();
  const sql = postgres(URL, { max: 1, onnotice: () => {} });
  const [{ n, newest }] = await sql`select count(*)::int as n, max(updated_at) as newest from edges`;
  const snap = join(ROOT, "data", "map-snapshot.json.gz");
  if (n === 0 && existsSync(snap)) {
    const rows = JSON.parse(gunzipSync(readFileSync(snap)).toString()) as [string, string, string, number, string, string | null, string][];
    for (let i = 0; i < rows.length; i += 2000) {
      const part = rows.slice(i, i + 2000).map(([origin, dest, month, min_price, source, flight_date, at]) => ({ origin, dest, month, min_price, source, flight_date, updated_at: new Date(at) }));
      await sql`insert into edges ${sql(part)} on conflict do nothing`;
    }
    log(`wczytana mapa cen: ${rows.length.toLocaleString("pl-PL")} połączeń`);
  }
  await sql.end();

  // no password, a fresh worker secret per run; the worker finds new searches through the site's doorbell
  const env = { ...process.env, AZYMUT_DATABASE_URL: URL, DATABASE_URL: URL, APP_PASSWORD: "", APP_URL: `http://localhost:${PORT}`,
    CRON_SECRET: randomBytes(16).toString("hex"), AZYMUT_LOCAL: "1", NEXT_TELEMETRY_DISABLED: "1" };
  const kids: ChildProcess[] = [];
  let stopping = false;
  const run = (name: string, args: string[], oneShot = false) => {
    const k = spawn(process.execPath, args, { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
    const tag = `\x1b[2m[${name}]\x1b[0m `;
    k.stdout!.on("data", (b: Buffer) => process.stdout.write(b.toString().replace(/^(?=.)/gm, tag)));
    k.stderr!.on("data", (b: Buffer) => process.stderr.write(b.toString().replace(/^(?=.)/gm, tag)));
    k.on("exit", (code) => { if (oneShot) { log(`${name}: gotowe`); return; } if (!stopping) { log(`${name} zakończył się (kod ${code}), zamykam`); void stop(); } });
    kids.push(k);
  };
  run("strona", [join(ROOT, "node_modules", "next", "dist", "bin", "next"), "dev", "-p", String(PORT)]);
  // the worker waits for the site to answer before its first doorbell read
  for (let i = 0; i < 120; i++) { if (await fetch(`http://localhost:${PORT}/login`).then(() => true, () => false)) break; await new Promise((r) => setTimeout(r, 1000)); }
  run("worker", ["--max-old-space-size=3000", "--import", "tsx", join(ROOT, "scripts", "worker.ts")]);
  log(`gotowe: \x1b[1mhttp://localhost:${PORT}\x1b[0m  (Ctrl+C zatrzymuje)`);
  // the price map refreshes itself: one batch (~5 min, Ryanair / Wizz / Kiwi) when it is a day old
  if (!newest || Date.now() - new Date(newest).getTime() > 24 * 3600_000) {
    log("odświeżam mapę cen w tle (kilka minut)");
    run("mapa", [join(ROOT, "node_modules", "tsx", "dist", "cli.mjs"), join(ROOT, "scripts", "map-worker.ts")], true);
  }

  const stop = async () => {
    if (stopping) return;
    stopping = true;
    for (const k of kids) k.kill("SIGTERM");
    await pg.stop().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
})().catch((e) => { console.error(e); process.exit(1); });
