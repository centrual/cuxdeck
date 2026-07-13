// Auth + transport, deck-aware. Every call targets a specific deck:
// its tunnel URL (empty string = this same origin) and its device
// token. The fleet is many decks, so there is no single global token
// anymore — callers pass the deck they mean. SSE/WebSocket URLs are
// built the same way so cross-origin streams carry the right token.

import type { Deck } from "./decks";

let onUnauthorized: (deck: Deck) => void = () => {};
export function setUnauthorizedHandler(fn: (deck: Deck) => void) { onUnauthorized = fn; }

// httpBase / wsBase turn a deck + path into an absolute URL. An empty
// deck.url means "this origin" — served over whatever scheme the page
// is on — so a single-machine install needs no tunnel to work locally.
export function httpBase(deck: Deck, path: string): string {
  const origin = deck.url || location.origin;
  return origin.replace(/\/$/, "") + path;
}
export function wsURL(deck: Deck, path: string, token: string): string {
  const origin = deck.url || location.origin;
  const u = new URL(origin.replace(/\/$/, "") + path);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.searchParams.set("token", token);
  return u.toString();
}
// sseURL: EventSource can't set headers, so the token rides the query.
export function sseURL(deck: Deck, path: string): string {
  return httpBase(deck, path) + (path.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(deck.token);
}

export async function api<T = any>(deck: Deck, path: string, opts: RequestInit = {}): Promise<T> {
  opts.headers = { Authorization: "Bearer " + deck.token, "Content-Type": "application/json", ...(opts.headers as any) };
  const r = await fetch(httpBase(deck, path), opts);
  if (r.status === 401) { onUnauthorized(deck); throw new Error("unauthorized"); }
  if (!r.ok) throw new Error((await r.json().catch(() => ({} as any))).error || "HTTP " + r.status);
  return r.json();
}

// pair exchanges a one-time code for a device token on a specific
// deck's origin — cross-origin when adding another machine, which the
// server's CORS on /api/* allows.
export async function pair(url: string, code: string, name: string): Promise<string> {
  const base = (url || location.origin).replace(/\/$/, "");
  const r = await fetch(base + "/api/pair", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, name }),
  });
  if (!r.ok) throw new Error("pair failed");
  return (await r.json()).token as string;
}

export function deviceName(): string {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return "Android";
  if (/Mac/.test(ua)) return "Mac";
  return (navigator as { platform?: string }).platform || "device";
}
