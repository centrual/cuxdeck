// The fleet lives entirely in the browser: a list of decks, each a
// (tunnel URL, device token) pair for one machine. There is no central
// server — the phone holds this list, fetches every deck directly, and
// merges the results. Persisted in localStorage so pairings survive
// reloads and tunnel-address changes (the URL is updated in place when
// a deck reports a new one).

export type Deck = {
  id: string;        // stable client-side id (deckId once known, else the origin)
  url: string;       // tunnel origin, no trailing slash; "" means this same origin
  token: string;     // device token for this deck
  hostname?: string; // filled from the first successful /api/deck
};

const KEY = "cuxdeck.decks";
const LEGACY_TOKEN = "cuxdeck.token"; // single-deck storage from before the fleet

function load(): Deck[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw) as Deck[];
  } catch { /* fall through to migration */ }
  // Migrate the pre-fleet single token into a one-deck fleet on this origin.
  const legacy = localStorage.getItem(LEGACY_TOKEN);
  if (legacy) {
    const migrated: Deck[] = [{ id: "self", url: "", token: legacy }];
    save(migrated);
    return migrated;
  }
  return [];
}

export function save(decks: Deck[]) {
  localStorage.setItem(KEY, JSON.stringify(decks));
}

let decks: Deck[] = load();

export function getDecks(): Deck[] { return decks; }
export function hasDecks(): boolean { return decks.length > 0; }

// upsert adds or updates a deck. Identity is the tunnel URL (one deck
// per machine per tunnel); a re-pair of the same URL replaces its token.
export function upsertDeck(d: Deck) {
  const i = decks.findIndex((x) => x.url === d.url);
  if (i >= 0) decks[i] = { ...decks[i], ...d };
  else decks.push(d);
  save(decks);
}

export function removeDeck(id: string) {
  decks = decks.filter((d) => d.id !== id);
  save(decks);
}

// noteDeckMeta records the hostname/deckId learned from a live fetch,
// so the fleet list has real machine names before the user labels them.
export function noteDeckMeta(url: string, deckId: string, hostname: string) {
  const d = decks.find((x) => x.url === url);
  if (d && (d.hostname !== hostname || d.id !== deckId)) {
    d.hostname = hostname;
    if (deckId) d.id = deckId;
    save(decks);
  }
}

// parsePairLink pulls the origin and one-time code out of a pairing
// link like "https://x.trycloudflare.com/#p=ABC123". Returns null if it
// isn't a usable https/localhost URL with a code.
export function parsePairLink(raw: string): { url: string; code: string } | null {
  raw = raw.trim();
  const m = raw.match(/[#?&]p=([A-Za-z0-9]+)/);
  if (!m) return null;
  let base: string;
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" && u.hostname !== "127.0.0.1" && u.hostname !== "localhost") return null;
    base = u.origin;
  } catch { return null; }
  return { url: base, code: m[1] };
}
