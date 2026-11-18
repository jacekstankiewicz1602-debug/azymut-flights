// Phone notifications: the service worker plus a Web Push subscription. On an iPhone push works only
// in the app added to the home screen (iOS 16.4+), so there the first step is installing it.
export type PushState = "unsupported" | "install" | "denied" | "on" | "off";

const standalone = () => matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;
const ios = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

function b64(s: string) {
  const raw = atob((s + "=".repeat((4 - (s.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

let reg: Promise<ServiceWorkerRegistration | null> | null = null;
export function registerSW() {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return Promise.resolve(null);
  reg ??= navigator.serviceWorker.register("/sw.js").catch(() => null);
  return reg;
}

export async function pushState(): Promise<PushState> {
  if (typeof window === "undefined") return "unsupported";
  if (ios() && !standalone()) return "install";
  if (!("PushManager" in window) || !("Notification" in window) || !("serviceWorker" in navigator)) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  const r = await registerSW();
  const sub = await r?.pushManager.getSubscription().catch(() => null);
  return sub && Notification.permission === "granted" ? "on" : "off";
}

async function send(sub: PushSubscription) {
  await fetch("/api/push", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(sub.toJSON()) });
}

/** Asks for permission (call from a tap: iOS requires a user gesture) and subscribes this device. */
export async function enablePush(): Promise<PushState> {
  const r = await registerSW();
  if (!r) return "unsupported";
  if ((await Notification.requestPermission()) !== "granted") return Notification.permission === "denied" ? "denied" : "off";
  const { key } = (await fetch("/api/push").then((x) => x.json())) as { key: string | null };
  if (!key) return "off";
  const sub = (await r.pushManager.getSubscription()) ?? (await r.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(key) }));
  await send(sub);
  return "on";
}

/** On load: keep an existing subscription known to the server (it can change when the browser rotates it). */
export async function refreshPush() {
  const r = await registerSW();
  if (!r || typeof Notification === "undefined" || Notification.permission !== "granted") return;
  const sub = await r.pushManager.getSubscription().catch(() => null);
  if (sub) await send(sub).catch(() => {});
}
