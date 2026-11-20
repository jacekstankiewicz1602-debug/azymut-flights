// Web Push: a phone with the app installed gets a notification when a search ends, even with the app
// closed. The VAPID key pair is made on first use and kept in Neon, so Vercel and the worker share it.
import webpush, { type PushSubscription } from "web-push";
import { sqlClient } from "./db";
import { placesEn } from "./places";
import { rates } from "./rates";

// the push services want an https: or mailto: contact; a local install (http://localhost) uses the project page
const SUBJECT = process.env.APP_URL?.startsWith("https://") ? process.env.APP_URL : "https://github.com/jacekstankiewicz1602-debug/azymut-flights";
type Keys = { publicKey: string; privateKey: string };
let keysP: Promise<Keys | null> | null = null;

async function keys(): Promise<Keys | null> {
  keysP ??= (async () => {
    const sql = await sqlClient();
    if (!sql) return null;
    const fresh = webpush.generateVAPIDKeys();
    await sql`insert into app_kv (key, value) values ('vapid', ${sql.json(fresh as never)}) on conflict (key) do nothing`;
    const [r] = await sql`select value from app_kv where key = 'vapid'`;
    return (r?.value as Keys | undefined) ?? null;
  })().catch(() => { keysP = null; return null; });
  return keysP;
}

export async function publicKey(): Promise<string | null> {
  return (await keys())?.publicKey ?? null;
}

export async function subscribe(sub: PushSubscription, lang: "pl" | "en" = "pl", cur = "PLN") {
  const sql = await sqlClient();
  if (!sql || !sub?.endpoint) return;
  await sql`insert into push_subs (endpoint, sub, lang, cur) values (${sub.endpoint}, ${sql.json(sub as never)}, ${lang}, ${cur})
    on conflict (endpoint) do update set sub = excluded.sub, lang = excluded.lang, cur = excluded.cur, created_at = now()`;
}

/** What a notification is written with: the device's language, its currency, English place names. */
export type PushText = { en: boolean; money: (pln: number) => string; place: (text: string) => string };
type Msg = { title: string; body: string; url: string; tag?: string };

export async function textFor(lang: string, cur: string): Promise<PushText> {
  const en = lang === "en";
  const fx = cur === "PLN" ? null : (await rates())?.rates[cur] ?? null;
  const money = (pln: number) => {
    if (!fx) return `${Math.round(pln).toLocaleString("pl-PL")} zł`;
    const v = pln * fx, d = Math.abs(v) < 10 ? 2 : 0;
    try { return new Intl.NumberFormat(en ? "en-GB" : "pl-PL", { style: "currency", currency: cur, minimumFractionDigits: d, maximumFractionDigits: d }).format(v); }
    catch { return `${Math.round(v)} ${cur}`; }
  };
  return { en, money, place: en ? placesEn : (s) => s };
}

export async function unsubscribe(endpoint: string) {
  const sql = await sqlClient();
  if (sql) await sql`delete from push_subs where endpoint = ${endpoint}`;
}

/** Adds a device to a search's notification list. */
export async function notifySearch(id: string, endpoint: string) {
  const sql = await sqlClient();
  if (sql) await sql`update live_searches set notify = array_append(notify, ${endpoint}) where id = ${id} and not (${endpoint} = any(notify))`;
}

/** Sends to the devices that started the search (not every subscribed phone: friends share the app);
 * drops subscriptions the push service no longer knows. */
export async function pushSearch(id: string, build: (t: PushText) => Msg) {
  const sql = await sqlClient();
  const k = await keys();
  if (!sql || !k) return;
  const rows = await sql`select endpoint, sub, lang, cur from push_subs where endpoint = any(select unnest(notify) from live_searches where id = ${id})`;
  await Promise.all(rows.map(async (r) => {
    try {
      const msg = build(await textFor(r.lang as string, r.cur as string));
      await webpush.sendNotification(r.sub as PushSubscription, JSON.stringify(msg), { vapidDetails: { subject: SUBJECT, ...k }, TTL: 24 * 3600, urgency: "high" });
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) await sql`delete from push_subs where endpoint = ${r.endpoint as string}`.catch(() => {});
      else console.error("push", code, (e as Error).message);
    }
  }));
}
