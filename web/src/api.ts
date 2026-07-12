// Device-token auth + JSON fetch wrapper. The token lives in
// localStorage; a 401 anywhere flips the app back to the pairing screen
// via the onUnauthorized hook App registers.

export let TOK = localStorage.getItem("cuxdeck.token") || "";

let onUnauthorized: () => void = () => {};
export function setUnauthorizedHandler(fn: () => void) { onUnauthorized = fn; }

export function setToken(t: string) {
  TOK = t;
  localStorage.setItem("cuxdeck.token", t);
}

export async function api<T = any>(path: string, opts: RequestInit = {}): Promise<T> {
  opts.headers = { Authorization: "Bearer " + TOK, "Content-Type": "application/json", ...(opts.headers as any) };
  const r = await fetch(path, opts);
  if (r.status === 401) { onUnauthorized(); throw new Error("unauthorized"); }
  if (!r.ok) throw new Error((await r.json().catch(() => ({} as any))).error || "HTTP " + r.status);
  return r.json();
}

export function deviceName(): string {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return "Android";
  if (/Mac/.test(ua)) return "Mac";
  return (navigator as { platform?: string }).platform || "device";
}
