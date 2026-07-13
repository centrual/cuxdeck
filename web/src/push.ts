// Web Push enrolment, browser side. Registers the service worker,
// asks permission, subscribes with the deck's VAPID key, and hands the
// subscription back to that deck. All per-deck: each machine pushes
// through its own tunnel to this browser's push service, so enabling
// notifications is a per-machine choice.

import { api, httpBase } from "./api";
import type { Deck } from "./decks";

export function pushSupported(): boolean {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

async function swReg(): Promise<ServiceWorkerRegistration> {
  const existing = await navigator.serviceWorker.getRegistration();
  return existing || navigator.serviceWorker.register("/sw.js");
}

function urlBase64ToUint8Array(b64: string): Uint8Array {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

// enable turns notifications on for one deck. Returns true on success.
export async function enable(deck: Deck): Promise<boolean> {
  if (!pushSupported()) throw new Error("This browser can't do Web Push");
  const perm = await Notification.requestPermission();
  if (perm !== "granted") throw new Error("Notifications were not allowed");
  const reg = await swReg();
  const { publicKey } = await api<{ publicKey: string }>(deck, "/api/push/key");
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey),
  });
  // Post the raw subscription JSON straight through to the deck.
  const r = await fetch(httpBase(deck, "/api/push/subscribe"), {
    method: "POST",
    headers: { Authorization: "Bearer " + deck.token, "Content-Type": "application/json" },
    body: JSON.stringify(sub),
  });
  return r.ok;
}

export async function disable(deck: Deck): Promise<void> {
  await api(deck, "/api/push/unsubscribe", { method: "POST", body: "{}" }).catch(() => {});
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = reg && (await reg.pushManager.getSubscription());
  if (sub) await sub.unsubscribe().catch(() => {});
}

// isEnabled: does this browser currently hold a push subscription?
export async function isEnabled(): Promise<boolean> {
  if (!pushSupported()) return false;
  const reg = await navigator.serviceWorker.getRegistration();
  return !!(reg && (await reg.pushManager.getSubscription()));
}
