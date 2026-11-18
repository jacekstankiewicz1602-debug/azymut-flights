// Web Push: a phone with the app installed gets a notification when a search ends, even with the app
// closed. The VAPID key pair is made on first use and kept in Neon, so Vercel and the worker share it.
import webpush, { type PushSubscription } from "web-push";
import { sqlClient } from "./db";

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

export async function subscribe(sub: PushSubscription) {
  const sql = await sqlClient();
  if (!sql || !sub?.endpoint) return;
  await sql`insert into push_subs (endpoint, sub) values (${sub.endpoint}, ${sql.json(sub as never)})
    on conflict (endpoint) do update set sub = excluded.sub, created_at = now()`;
}

export async function unsubscribe(endpoint: string) {
  const sql = await sqlClient();
  if (sql) await sql`delete from push_subs where endpoint = ${endpoint}`;
}

/** Sends to every subscribed device; drops subscriptions the push service no longer knows. */
export async function pushAll(msg: { title: string; body: string; url: string; tag?: string }) {
  const sql = await sqlClient();
  const k = await keys();
  if (!sql || !k) return;
  const rows = await sql`select endpoint, sub from push_subs`;
  await Promise.all(rows.map(async (r) => {
    try {
      await webpush.sendNotification(r.sub as PushSubscription, JSON.stringify(msg), { vapidDetails: { subject: SUBJECT, ...k }, TTL: 24 * 3600, urgency: "high" });
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) await sql`delete from push_subs where endpoint = ${r.endpoint as string}`.catch(() => {});
      else console.error("push", code, (e as Error).message);
    }
  }));
}
