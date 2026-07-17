// cuxdeck panel — React root. The fleet is assembled here in the
// browser: a list of decks (machines), each fetched directly over its
// own tunnel with its own token, then shown together. One machine
// renders flat; several render under per-machine headers.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, deviceName, pair, setUnauthorizedHandler } from "./api";
import { getDecks, hasDecks, noteDeckMeta, parsePairLink, removeDeck, upsertDeck, type Deck } from "./decks";
import { Chat } from "./chat";
import { Term, TermView } from "./term";
import * as push from "./push";
import { ago, inTime, shortDir } from "./util";
import { t, useLang, setLang, LANGS } from "./i18n";

/* ---------- server shapes (one machine's snapshot) ---------- */
type Session = { pid: number; cwd: string; sessionId?: string; seat?: string; state: string; detail?: string; startedAt: string; attachable?: boolean };
type Account = { email: string; alias?: string; slot: number; uuid?: string; orgUuid?: string };
type Usage = { five_hour?: Win; seven_day?: Win; token_expired?: boolean };
type Win = { utilization: number; resets_at?: string };
type Project = { name: string; dir: string; slots?: number[] };
type Snapshot = {
  deckId: string; hostname: string; os: string; version: string;
  sessions: Session[]; accounts: Record<string, Account>;
  usage: Record<string, Usage>; projects?: Record<string, Project>; activeSlot: number;
};
type Conv = { id: string; cwd: string; title: string; updatedAt: string; active: boolean };
type Device = { id: string; name: string; createdAt: string; lastSeen: string };
type PendingInvite = { id: string; role: string; expiresAt: string };

// One machine's live state: the connection, its latest snapshot and
// conversations, whether the last fetch reached it, this device's role
// on it ("control" or "view" — view hides every mutating control), and
// (when unreachable) the moment it first stopped answering.
type Entry = { deck: Deck; snap: Snapshot | null; convs: Conv[]; online: boolean; role: string; offlineSince?: number };

const canControl = (e: Entry) => e.role !== "view";

// A tunnel restart or a blip in connectivity looks identical, at first,
// to the machine being truly gone — both just fail one poll. Reporting
// "unreachable" immediately reads as a hard failure when it's usually
// resolved by the next poll or two; holding the label at "connecting"
// for a short grace window (a few poll cycles) before escalating avoids
// that false alarm, and it costs nothing when the machine really is down
// since "unreachable" still follows once the window elapses.
const RECONNECT_GRACE_MS = 15000;
type ConnState = "online" | "connecting" | "unreachable";
const connState = (e: Entry): ConnState => {
  if (e.online) return "online";
  if (e.offlineSince && Date.now() - e.offlineSince < RECONNECT_GRACE_MS) return "connecting";
  return "unreachable";
};

const cacheKey = (a: Account) => (a.uuid && a.orgUuid ? a.uuid + "|" + a.orgUuid : a.orgUuid || a.email);
const seatLabel = (a: Account) => a.alias || a.email.split("@")[0];
const machineName = (e: Entry) => e.snap?.hostname || e.deck.hostname || "machine";

function useNow(ms = 1000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(t); }, [ms]);
  return now;
}

function Ring({ pct, cap }: { pct: number | null; cap: string }) {
  const p = Math.min(100, Math.max(0, pct ?? 0));
  const R = 26, C = 2 * Math.PI * R;
  const color = p >= 90 ? "var(--bad)" : p >= 70 ? "var(--warn)" : "var(--ok)";
  return (
    <div className="ring">
      <svg width="64" height="64" viewBox="0 0 64 64">
        <circle cx="32" cy="32" r={R} stroke="#ffffff10" strokeWidth="6" fill="none" />
        <circle cx="32" cy="32" r={R} stroke={color} strokeWidth="6" fill="none" strokeLinecap="round"
          strokeDasharray={C} strokeDashoffset={C * (1 - p / 100)}
          style={{ transition: "stroke-dashoffset .9s cubic-bezier(.2,.8,.3,1)" }} />
      </svg>
      <div className="val">{pct == null ? "—" : Math.round(p) + "%"}</div>
      <div className="cap">{cap}</div>
    </div>
  );
}

function Mascot({ size }: { size: number }) {
  return <img src="/onion.svg" width={size} height={size} style={{ imageRendering: "pixelated" }} alt="" />;
}

/* ---------- empty-state icons — line art, not emoji, so they read as
   part of the same system as the nav icons rather than borrowed glyphs
   that render differently per platform/font. ---------- */
function EmptyIconBase({ children }: { children: React.ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="currentColor"
      strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">{children}</svg>
  );
}
// Signal strength, with a diagonal strike when the machine has given up
// reconnecting — "connecting" gets the plain (animated via CSS) version.
function SignalIcon({ down }: { down: boolean }) {
  return (
    <EmptyIconBase>
      <path d="M3 8.5a13 13 0 0 1 18 0" />
      <path d="M6.5 12a8 8 0 0 1 11 0" />
      <path d="M10 15.5a3 3 0 0 1 4 0" />
      <circle cx="12" cy="19" r=".6" fill="currentColor" stroke="none" />
      {down && <path d="M3 3l18 18" />}
    </EmptyIconBase>
  );
}
function MoonIcon() {
  return <EmptyIconBase><path d="M20 14.6A8.5 8.5 0 1 1 9.4 4a7 7 0 0 0 10.6 10.6z" /></EmptyIconBase>;
}
// Same glyph as the Seats tab's nav icon, so an empty seats list points
// visually back at the tab it's describing.
function SeatsGlyph() {
  return <EmptyIconBase><circle cx="12" cy="8" r="3.5" /><path d="M5 20c0-3.5 3-6 7-6s7 2.5 7 6" /></EmptyIconBase>;
}
// Same glyph as the Projects tab's nav icon, for the same reason.
function FolderGlyph() {
  return <EmptyIconBase><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></EmptyIconBase>;
}
function WarnIcon() {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" style={{ verticalAlign: -2, marginRight: 4, flex: "none" }}>
      <path d="M12 3.5 2.5 20h19z" /><path d="M12 9.5v4" /><circle cx="12" cy="17" r=".6" fill="currentColor" stroke="none" />
    </svg>
  );
}
function ClockIcon() {
  return (
    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" style={{ verticalAlign: -1, marginRight: 4, flex: "none" }}>
      <circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" />
    </svg>
  );
}

// The shared "can't reach this machine" card for every tab — reads as
// "connecting…" for a grace window after the first missed poll, only
// escalating to "unable to connect" if that window elapses. See
// connState's comment for why that grace window exists.
function ConnStateCard({ e }: { e: Entry }) {
  if (connState(e) === "connecting") {
    return (
      <div className="card empty"><div className="art connecting"><SignalIcon down={false} /></div>
        <b>{t("Connecting…")}</b>{t("Reaching this machine — hang on a moment.")}</div>
    );
  }
  return (
    <div className="card empty"><div className="art"><SignalIcon down /></div>
      <b>{t("Unable to connect")}</b>{t("This machine's tunnel is down or it's offline.")}</div>
  );
}

// The real Telegram mark (blue disc + paper plane) so the wizard is
// recognizable at a glance.
function TelegramMark({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 240 240" aria-hidden="true" style={{ flex: "none" }}>
      <circle cx="120" cy="120" r="120" fill="#2AABEE" />
      <path fill="#fff" d="M53.6 118.7c35-15.2 58.3-25.3 70-30.2 33.3-13.9 40.3-16.3 44.8-16.4 1 0 3.2.2 4.7 1.4.9.7 1.4 1.9 1.5 3-.1 1-.3 3.2-.5 4.9-2.2 23.4-11.9 80.2-16.9 106.4-2.1 11.1-6.3 14.8-10.3 15.2-8.7.8-15.3-5.8-23.7-11.3-13.2-8.6-20.6-14-33.4-22.4-14.8-9.7-5.2-15 3.2-23.8 2.2-2.3 40.5-37.1 41.2-40.3.1-.4.2-1.9-.7-2.7s-2.3-.5-3.2-.3c-1.4.3-23.5 14.9-66.4 43.9-6.3 4.3-12 6.4-17.1 6.3-5.6-.1-16.4-3.2-24.5-5.8-9.9-3.2-17.7-4.9-17-10.4.3-2.8 4.2-5.7 11.7-8.7z" />
    </svg>
  );
}

export default function App() {
  const [decks, setDecks] = useState<Deck[]>(getDecks());
  const [fleet, setFleet] = useState<Entry[]>([]);
  // Remember the last tab across reloads so a refresh doesn't bounce you
  // back to Deck.
  const [tab, setTab] = useState<"deck" | "seats" | "projects" | "settings">(() => {
    const saved = localStorage.getItem("cuxdeck-tab");
    return saved === "seats" || saved === "projects" || saved === "settings" ? saved : "deck";
  });
  useEffect(() => { try { localStorage.setItem("cuxdeck-tab", tab); } catch { /* ignore */ } }, [tab]);
  const [chat, setChat] = useState<{ deck: Deck; path: string; title: string; sub: string } | null>(null);
  const [termSess, setTermSess] = useState<{ deck: Deck; pid: number; title: string } | null>(null);
  // The workspace: live-terminal tiles the user composes on big screens
  // (pick sessions from the rail, they open side by side / stacked).
  // Persisted so a reload restores the same wall of terminals; a tile
  // whose session has exited just shows the closed-connection notice.
  const [tiles, setTiles] = useState<Array<{ deckId: string; pid: number; title: string; sub: string }>>(() => {
    try { return JSON.parse(localStorage.getItem("cuxdeck-ws-tiles") || "[]"); } catch { return []; }
  });
  const [wsCols, setWsCols] = useState<number>(() => {
    const n = parseInt(localStorage.getItem("cuxdeck-ws-cols") || "1", 10);
    return n >= 1 && n <= 3 ? n : 1;
  });
  useEffect(() => { try { localStorage.setItem("cuxdeck-ws-tiles", JSON.stringify(tiles)); } catch { /* ignore */ } }, [tiles]);
  useEffect(() => { try { localStorage.setItem("cuxdeck-ws-cols", String(wsCols)); } catch { /* ignore */ } }, [wsCols]);
  const tileKey = (deckId: string, pid: number) => deckId + "·" + pid;
  const toggleTile = (deckId: string, pid: number, title: string, sub: string) => {
    setTiles((ts) => ts.some((x) => tileKey(x.deckId, x.pid) === tileKey(deckId, pid))
      ? ts.filter((x) => tileKey(x.deckId, x.pid) !== tileKey(deckId, pid))
      : [...ts, { deckId, pid, title, sub }]);
  };
  // From a card the intent is always "open" — never a toggle that could
  // silently close a tile you forgot was up. The rail rows toggle (they
  // show the on-state); the cards only ever add.
  const addTile = (deckId: string, pid: number, title: string, sub: string) => {
    setTiles((ts) => ts.some((x) => tileKey(x.deckId, x.pid) === tileKey(deckId, pid))
      ? ts : [...ts, { deckId, pid, title, sub }]);
  };
  // One surface, one behavior: on a big screen every session click lands
  // in the Panel's live wall; the full-screen terminal is reached from a
  // tile's expand button as a deliberate escalation. Phones keep the
  // overlay — there's no wall to compose on a 390px screen.
  const desktop = useDesktop();
  const openTerm = (deck: Deck, pid: number, title: string, sub: string) => {
    if (desktop) { addTile(deck.id, pid, title, sub); window.scrollTo({ top: 0, behavior: "smooth" }); }
    else setTermSess({ deck, pid, title });
  };
  const [sheet, setSheet] = useState<React.ReactNode | null>(null);
  const [toastMsg, setToastMsg] = useState("");
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(null);
  useNow();
  const lang = useLang();

  const toast = useCallback((m: string, ms = 2400) => {
    setToastMsg(m);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastMsg(""), ms);
  }, []);

  // A 401 on a deck drops just that deck from the fleet (its token was
  // revoked); the others keep working.
  useEffect(() => setUnauthorizedHandler((d) => { removeDeck(d.id); setDecks(getDecks()); }), []);

  // Tracks the previous round's entries outside React state so refresh()
  // can read each deck's offlineSince without depending on (and thus
  // re-running the polling effect for) fleet itself.
  const fleetRef = useRef<Entry[]>([]);
  const refresh = useCallback(async () => {
    const ds = getDecks();
    if (!ds.length) return;
    const entries = await Promise.all(ds.map(async (deck): Promise<Entry> => {
      const prevOfflineSince = fleetRef.current.find((e) => e.deck.id === deck.id)?.offlineSince;
      try {
        const snap = await api<Snapshot>(deck, "/api/deck");
        let convs: Conv[] = [];
        try { convs = (await api<Conv[]>(deck, "/api/conversations")) || []; } catch { /* keep deck online */ }
        let role = "control";
        try { role = (await api<{ role: string }>(deck, "/api/me")).role || "control"; } catch { /* default control */ }
        noteDeckMeta(deck.url, snap.deckId, snap.hostname);
        return { deck, snap, convs, online: true, role };
      } catch { return { deck, snap: null, convs: [], online: false, role: "control", offlineSince: prevOfflineSince ?? Date.now() }; }
    }));
    fleetRef.current = entries;
    setFleet(entries);
    setDecks(getDecks()); // pick up hostnames learned this round
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 4000);
    return () => clearInterval(t);
  }, [refresh, decks.length]);

  // Mirror the panel's language to every machine so its push / Telegram
  // notifications go out in the same language. Runs on language change
  // and when the deck list changes (a new machine learns it too);
  // best-effort — a view-only or offline deck just 403s / fails quietly.
  useEffect(() => {
    getDecks().forEach((d) => {
      api(d, "/api/lang", { method: "POST", body: JSON.stringify({ lang }) }).catch(() => {});
    });
  }, [lang, decks.length]);

  const act = useCallback(async (deck: Deck, action: string, args: Record<string, string>, note: string) => {
    toast(note);
    try { await api(deck, "/api/action", { method: "POST", body: JSON.stringify({ action, args }) }); toast(t("Done ✓")); refresh(); }
    catch (e) { toast(t("Failed: ") + (e as Error).message, 3600); }
  }, [refresh, toast]);

  // Launch a brand-new cux session on a machine, then jump straight
  // into its terminal — start work from the phone, not just watch it.
  const spawnSession = useCallback(async (deck: Deck, dir: string) => {
    setSheet(null);
    toast(t("Starting cux in ") + shortDir(dir) + "…");
    try {
      const { pid } = await api<{ pid: number }>(deck, "/api/spawn", { method: "POST", body: JSON.stringify({ dir }) });
      // Give cux a moment to open its attach socket before we connect.
      setTimeout(() => setTermSess({ deck, pid, title: shortDir(dir) }), 700);
      refresh();
    } catch (e) { toast(t("Failed: ") + (e as Error).message, 3600); }
  }, [refresh, toast]);

  const addMachine = useCallback(async (link: string) => {
    const parsed = parsePairLink(link);
    if (!parsed) { toast(t("That doesn't look like a cuxdeck link")); return; }
    try {
      const token = await pair(parsed.url, parsed.code, deviceName());
      upsertDeck({ id: parsed.url || "self", url: parsed.url, token });
      setDecks(getDecks());
      setSheet(null);
      toast(t("Machine added ⌁"));
      refresh();
    } catch { toast(t("Pairing failed — the code may have expired")); }
  }, [refresh, toast]);

  if (!hasDecks()) return <Pair onPaired={() => { setDecks(getDecks()); toast(t("Paired — welcome aboard ⌁")); }} />;

  const openChat = (deck: Deck, path: string, title: string, sub: string) => setChat({ deck, path, title, sub });
  const anyOnline = fleet.some((e) => e.online);
  const anyConnecting = !anyOnline && fleet.some((e) => connState(e) === "connecting");
  const multi = fleet.length > 1;

  return (
    <>
      <header>
        <div className="brand">
          <div className="logo"><Mascot size={24} /></div>
          <h1 className="mono">cuxdeck<span className="cur">_</span></h1>
          <div className="host"><span className={"pulse" + (anyOnline ? "" : anyConnecting ? " connecting" : " off")}></span>
            <span>{multi ? fleet.length + " " + t("machines") : machineName(fleet[0] || { deck: decks[0] } as Entry)}</span></div>
        </div>
      </header>

      <main>
        {!fleet.length && <><div className="skel" /><div className="skel" /><div className="skel" /></>}

        {tab === "deck" && desktop && tiles.length > 0 && (
          <Workspace fleet={fleet} tiles={tiles} cols={wsCols} setCols={setWsCols}
            onClose={(deckId, pid) => setTiles((ts) => ts.filter((x) => !(x.deckId === deckId && x.pid === pid)))}
            onExpand={(deck, pid, title) => setTermSess({ deck, pid, title })} />
        )}

        {tab === "deck" && fleet.map((e) => (
          <MachineBlock key={e.deck.id} e={e} showHeader={multi} control={canControl(e)}
            onOpenSession={(s) => openChat(e.deck, "/api/session/" + s.pid + "/chat", shortDir(s.cwd), t("seat ") + (s.seat ? s.seat.split("@")[0] : "—"))}
            onOpenConv={(c) => openChat(e.deck, "/api/conversation/" + c.id + "/chat", shortDir(c.cwd || "?"), "")}
            onOpenTerm={(s) => openTerm(e.deck, s.pid, shortDir(s.cwd), s.seat ? s.seat.split("@")[0] : "—")}
            onNewSession={() => setSheet(<SpawnSheet e={e} onStart={(dir) => spawnSession(e.deck, dir)} />)}
            onRefreshUsage={() => act(e.deck, "usage-refresh", {}, t("Refreshing usage…"))} />
        ))}

        {tab === "seats" && fleet.map((e) => (
          <SeatsBlock key={e.deck.id} e={e} showHeader={multi} control={canControl(e)}
            onSwitch={(a) => setSheet(<ConfirmSwitch label={seatLabel(a)} onCancel={() => setSheet(null)}
              onGo={() => { setSheet(null); act(e.deck, "switch", { target: String(a.slot) }, t("Switching seat…")); }} />)} />
        ))}

        {tab === "projects" && fleet.map((e) => (
          <ProjectsBlock key={e.deck.id} e={e} showHeader={multi} control={canControl(e)}
            onCreate={() => setSheet(<ProjectSheet host={machineName(e)} toast={toast}
              create={(name, dir) => { setSheet(null); act(e.deck, "project-create", { name, dir }, t("Creating ") + name + "…"); }} />)}
            onSeats={(p) => e.snap && setSheet(<SeatSheet project={p} snap={e.snap} deck={e.deck} toast={toast} refresh={refresh} act={act} close={() => setSheet(null)} />)} />
        ))}

        {tab === "settings" && (
          <SettingsTab fleet={fleet} toast={toast} setSheet={setSheet}
            onAddMachine={() => setSheet(<AddMachineSheet add={addMachine} />)}
            onForget={(d) => { removeDeck(d.id); setDecks(getDecks()); toast(t("Machine forgotten")); }} />
        )}
      </main>

      <nav>
        {/* navbrand/navhost render always but only display on ≥1024px,
            where the bar becomes a left rail and the header hides — the
            brand and the live machine status move in here so the rail
            is self-sufficient. Same data as the header, one source. */}
        <div className="navbrand"><div className="logo"><Mascot size={24} /></div>
          <div className="wordmark mono">cuxdeck<span className="cur">_</span></div></div>
        {(["deck", "seats", "projects", "settings"] as const).map((tb) => (
          <button key={tb} className={tab === tb ? "on" : ""} onClick={() => { setTab(tb); window.scrollTo({ top: 0 }); }}>
            <NavIcon name={tb} />{t(tb[0].toUpperCase() + tb.slice(1))}
          </button>
        ))}
        {/* Rail-only session list: every live session across the fleet.
            Same single behavior as the cards — click tiles it into the
            Panel's live wall (highlighted while tiled; click again to
            take it down). The phone never sees this list. */}
        <div className="navsessions">
          <div className="nslabel">{t("Sessions")}</div>
          {fleet.flatMap((e) => (e.online && e.snap ? e.snap.sessions.map((s) => {
            const on = tiles.some((x) => x.deckId === e.deck.id && x.pid === s.pid);
            const seat = s.seat ? s.seat.split("@")[0] : "—";
            const canTerm = s.attachable && canControl(e);
            return (
              <button key={e.deck.id + s.pid} className={"nsrow" + (on ? " on" : "")}
                title={s.cwd + " · " + seat}
                onClick={() => {
                  if (canTerm) { toggleTile(e.deck.id, s.pid, shortDir(s.cwd), seat); setTab("deck"); window.scrollTo({ top: 0, behavior: "smooth" }); }
                  else openChat(e.deck, "/api/session/" + s.pid + "/chat", shortDir(s.cwd), t("seat ") + seat);
                }}>
                <span className="dot" style={{ color: stateColor[s.state] || "var(--dim)" }} />
                <span className="grow ellip">{shortDir(s.cwd)}</span>
                <span className="nsseat">{seat}</span>
              </button>
            );
          }) : []))}
        </div>
        <div className="navhost"><span className={"pulse" + (anyOnline ? "" : anyConnecting ? " connecting" : " off")}></span>
          <span>{multi ? fleet.length + " " + t("machines") : machineName(fleet[0] || { deck: decks[0] } as Entry)}</span></div>
      </nav>

      <div id="veil" className={sheet ? "show" : ""} onClick={() => setSheet(null)} />
      <div id="sheet" className={sheet ? "show" : ""}><div className="grip" />{sheet}</div>
      {chat && <Chat deck={chat.deck} path={chat.path} title={chat.title} sub={chat.sub} onClose={() => setChat(null)} />}
      {termSess && <Term deck={termSess.deck} pid={termSess.pid} title={termSess.title} onClose={() => setTermSess(null)} />}
      <div id="toast" className={toastMsg ? "show" : ""}>{toastMsg}</div>
    </>
  );
}

function NavIcon({ name }: { name: string }) {
  const paths: Record<string, React.ReactNode> = {
    deck: <><rect x="3" y="4" width="18" height="13" rx="2" /><path d="M8 21h8M12 17v4" /></>,
    seats: <><circle cx="12" cy="8" r="3.5" /><path d="M5 20c0-3.5 3-6 7-6s7 2.5 7 6" /></>,
    projects: <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />,
    settings: <><circle cx="12" cy="12" r="3" /><path d="M19 12a7 7 0 0 0-.1-1.2l2-1.5-2-3.4-2.3 1a7 7 0 0 0-2-1.2L14.2 3h-4l-.4 2.7a7 7 0 0 0-2 1.2l-2.3-1-2 3.4 2 1.5a7 7 0 0 0 0 2.4l-2 1.5 2 3.4 2.3-1a7 7 0 0 0 2 1.2l.4 2.7h4l.4-2.7a7 7 0 0 0 2-1.2l2.3 1 2-3.4-2-1.5c.06-.4.1-.8.1-1.2z" /></>,
  };
  return <svg viewBox="0 0 24 24">{paths[name]}</svg>;
}

// useDesktop tracks the same breakpoint the CSS rail uses, so behavior
// (tile vs full-screen) and layout switch together, live on resize.
function useDesktop(): boolean {
  const [d, setD] = useState(() => window.matchMedia("(min-width:1024px)").matches);
  useEffect(() => {
    const m = window.matchMedia("(min-width:1024px)");
    const f = () => setD(m.matches);
    m.addEventListener("change", f);
    return () => m.removeEventListener("change", f);
  }, []);
  return d;
}

// Workspace is the Panel's live wall on big screens: every tile is one
// live terminal (its own socket, its own grid), laid out in 1–3 columns
// the user picks — three stacked panes, a 2×2 wall, whatever the run
// needs. Any session click (card row or rail list) lands here; expand
// pops the same session into the full-screen Term without disturbing
// its siblings (separate mount, the PTY multicasts to both). Rendered
// only when at least one tile is up, so an empty Panel stays cards-only.
function Workspace({ fleet, tiles, cols, setCols, onClose, onExpand }: {
  fleet: Entry[]; tiles: Array<{ deckId: string; pid: number; title: string; sub: string }>;
  cols: number; setCols: (n: number) => void;
  onClose: (deckId: string, pid: number) => void;
  onExpand: (deck: Deck, pid: number, title: string) => void;
}) {
  return (
    <>
      <div className="row wsbar">
        <div className="section-label" style={{ flex: 1, margin: 0 }}>{t("Grid")}</div>
        <div className="seg wscols">
          {[1, 2, 3].map((n) => (
            <button key={n} className={"segbtn" + (cols === n ? " on" : "")} onClick={() => setCols(n)}>{n}</button>
          ))}
        </div>
      </div>
      {tiles.length > 0 && (
        <div className="wswrap" style={{ "--wscols": cols } as React.CSSProperties}>
          {tiles.map(({ deckId, pid, title, sub }) => {
            const e = fleet.find((x) => x.deck.id === deckId);
            const alive = e && e.online && e.snap?.sessions.some((s) => s.pid === pid);
            const state = e?.snap?.sessions.find((s) => s.pid === pid)?.state;
            return (
              <div key={deckId + "·" + pid} className="wstile">
                <div className="wthead">
                  <span className="dot" style={{ color: alive ? stateColor[state || ""] || "var(--dim)" : "var(--faint)" }} />
                  <b className="ellip">{title}</b>
                  <span className="sub ellip">{sub}</span>
                  <span className="grow" />
                  {e && <button className="wtbtn" title={t("full screen")}
                    onClick={() => onExpand(e.deck, pid, title)}>
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2"
                      strokeLinecap="round"><path d="M9 3H3v6M15 3h6v6M9 21H3v-6M15 21h6v-6" /></svg>
                  </button>}
                  <button className="wtbtn" title={t("close tile")} onClick={() => onClose(deckId, pid)}>
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2"
                      strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
                  </button>
                </div>
                <div className="wtbody">
                  {e && alive
                    ? <TermView deck={e.deck} pid={pid} />
                    : <div className="empty" style={{ padding: "30px 16px" }}>
                      <b>{e ? t("session ended") : t("unable to connect")}</b></div>}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

// MachineHeader labels a machine's section in the fleet and shows
// whether it's currently reachable.
function MachineHeader({ e }: { e: Entry }) {
  const cs = connState(e);
  return (
    <div className="mhead">
      <span className={"mdot" + (cs === "online" ? "" : cs === "connecting" ? " connecting" : " off")} />
      <span className="mname">{machineName(e)}</span>
      {cs === "connecting" && <span className="mconnecting">{t("connecting…")}</span>}
      {cs === "unreachable" && <span className="moff">{t("unreachable")}</span>}
      {e.snap && <span className="msub">{e.snap.os}</span>}
    </div>
  );
}

/* ---------- project grouping (per machine) ---------- */

type ProjectGroup = { dir: string; sessions: Array<{ s: Session; conv?: Conv }>; history: Conv[]; lastAt: number };

function groupByProject(sessions: Session[], convs: Conv[]): ProjectGroup[] {
  const groups = new Map<string, ProjectGroup>();
  const get = (dir: string) => {
    let g = groups.get(dir);
    if (!g) { g = { dir, sessions: [], history: [], lastAt: 0 }; groups.set(dir, g); }
    return g;
  };
  const claimed = new Set<string>();
  for (const s of sessions) {
    let c = s.sessionId ? convs.find((x) => x.id === s.sessionId) : undefined;
    c = c || convs.find((x) => x.active && !claimed.has(x.id) && x.cwd === s.cwd);
    if (c) claimed.add(c.id);
    const g = get(s.cwd);
    g.sessions.push({ s, conv: c });
    g.lastAt = Math.max(g.lastAt, Date.parse(s.startedAt) || 0, c ? Date.parse(c.updatedAt) || 0 : 0);
  }
  for (const c of convs) {
    if (claimed.has(c.id)) continue;
    const g = get(c.cwd || "?");
    g.history.push(c);
    g.lastAt = Math.max(g.lastAt, Date.parse(c.updatedAt) || 0);
  }
  for (const g of groups.values()) g.history.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  return [...groups.values()].sort((a, b) => {
    if (!!a.sessions.length !== !!b.sessions.length) return a.sessions.length ? -1 : 1;
    return b.lastAt - a.lastAt;
  });
}

// stateColor maps a session's wrapper state to its dot color, shared by
// the project cards, the rail's session list, and workspace tile heads.
const stateColor: Record<string, string> = {
  running: "var(--ok)", "waiting-reset": "var(--warn)", retrying: "var(--bad)", swapping: "var(--info)",
};

function ProjectCard({ g, control, onOpenConv, onOpenSession, onOpenTerm }: {
  g: ProjectGroup; control: boolean;
  onOpenConv: (c: Conv) => void; onOpenSession: (s: Session) => void; onOpenTerm: (s: Session) => void;
}) {
  const [open, setOpen] = useState(false);
  const live = g.sessions.length;
  const liveHistory = g.history.filter((c) => c.active);
  const past = g.history.filter((c) => !c.active);
  const isLive = live > 0 || liveHistory.length > 0;

  return (
    <div className="card">
      <div className="row" style={{ alignItems: "flex-start" }}>
        <div className="grow"><h3 className="ellip">{shortDir(g.dir)}</h3>
          {!live && (
            <div className="sub">{liveHistory.length
              ? t("not managed by cux")
              : <>{g.history.length} conversation{g.history.length === 1 ? "" : "s"} · {ago(new Date(g.lastAt).toISOString())} {t("ago")}</>}
            </div>
          )}
        </div>
        {isLive && <span className="badge running">{live > 0 ? live + " " + t("running") : t("live")}</span>}
      </div>

      {g.sessions.map(({ s, conv }) => {
        // An attachable session opens straight into its live terminal on
        // tap — that's the full view of what it's doing, so there's no
        // separate button to get squeezed by a long title. The ⌨ hint
        // sits on the meta line, which the title never crowds.
        const canTerm = s.attachable && control;
        return (
          <div key={s.pid} className="srow tappable"
            onClick={() => (canTerm ? onOpenTerm(s) : conv ? onOpenConv(conv) : onOpenSession(s))}>
            <span className="dot" style={{ color: stateColor[s.state] || "var(--dim)" }} />
            <div className="grow" style={{ minWidth: 0 }}>
              <div className="ellip" style={{ fontWeight: 600 }}>{conv?.title || t("(starting…)")}</div>
              <div className="sub">{t("seat ")}<b>{s.seat ? s.seat.split("@")[0] : "—"}</b> · {t("up")} {ago(s.startedAt)}
                {s.detail ? " · ↻ " + s.detail : ""}
                {canTerm ? <> · <span style={{ color: "var(--acc)", fontWeight: 700 }}>⌨ {t("terminal")}</span></> : null}</div>
            </div>
          </div>
        );
      })}

      {liveHistory.map((c) => (
        <div key={c.id} className="srow tappable" onClick={() => onOpenConv(c)}>
          <span className="dot" style={{ color: "var(--ok)" }} />
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="ellip" style={{ fontWeight: 600 }}>{c.title || t("(no messages yet)")}</div>
            <div className="sub">{t("not managed by cux")}</div>
          </div>
        </div>
      ))}

      {past.length > 0 && (
        <>
          <div className="morebar" onClick={() => setOpen(!open)}>
            {open ? t("▾ hide")
              : (live || liveHistory.length)
                ? "▸ " + past.length + " past conversation" + (past.length === 1 ? "" : "s")
                : t("▸ show conversations")}
          </div>
          {open && past.map((c) => (
            <div key={c.id} className="srow tappable" onClick={() => onOpenConv(c)}>
              <span className="dot" style={{ color: "var(--faint)" }} />
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="ellip">{c.title || t("(no messages yet)")}</div>
                <div className="sub">{ago(c.updatedAt)} {t("ago")}</div>
              </div>
            </div>
          ))}
        </>
      )}
    </div>
  );
}

/* ---------- per-machine tab blocks ---------- */

function MachineBlock({ e, showHeader, control, onOpenSession, onOpenConv, onOpenTerm, onNewSession, onRefreshUsage }: {
  e: Entry; showHeader: boolean; control: boolean;
  onOpenSession: (s: Session) => void; onOpenConv: (c: Conv) => void; onOpenTerm: (s: Session) => void;
  onNewSession: () => void; onRefreshUsage: () => void;
}) {
  const snap = e.snap;
  const groups = snap ? groupByProject(snap.sessions || [], e.convs) : [];
  return (
    <>
      <div className="row" style={{ alignItems: "center" }}>
        {showHeader ? <MachineHeader e={e} /> : <div className="section-label" style={{ flex: 1 }}>{t("Sessions")}</div>}
        {e.online && control && <button className="btn ghost small" style={{ marginLeft: "auto" }} onClick={onNewSession}>{t("＋ new session")}</button>}
      </div>
      {!e.online && <ConnStateCard e={e} />}
      {e.online && !groups.length && (
        <div className="card empty"><div className="art"><MoonIcon /></div><b>{t("All quiet")}</b>
          {t("No sessions or conversations yet.")}</div>
      )}
      {groups.map((g) => (
        <ProjectCard key={g.dir} g={g} control={control} onOpenConv={onOpenConv} onOpenSession={onOpenSession} onOpenTerm={onOpenTerm} />
      ))}
      {snap && !showHeader && (
        <>
          <div className="section-label">{t("This machine")}</div>
          <MachineFooter snap={snap} onRefreshUsage={onRefreshUsage} />
        </>
      )}
    </>
  );
}

function MachineFooter({ snap, onRefreshUsage }: { snap: Snapshot; onRefreshUsage: () => void }) {
  const accts = Object.values(snap.accounts || {});
  const active = accts.find((a) => a.slot === snap.activeSlot);
  const n = (snap.sessions || []).length;
  return (
    <div className="card"><div className="row">
      <div className="grow">
        <h3>{snap.hostname}</h3>
        <div className="sub">{n} live session{n === 1 ? "" : "s"} · {accts.length} seat{accts.length === 1 ? "" : "s"} · active: <b>{active ? seatLabel(active) : "—"}</b></div>
      </div>
      <button className="btn ghost small" onClick={onRefreshUsage}>{t("↻ refresh")}</button>
    </div></div>
  );
}

// Spark is a bare utilization trend line — one series, so no legend and
// no axes; the surrounding card already says whose it is. cux-orange,
// thin, anchored to a 0–100 baseline, with a dot on the latest point.
function Spark({ pts }: { pts: number[] }) {
  if (pts.length < 2) return null;
  const W = 100, H = 28;
  const n = pts.length;
  const x = (i: number) => (i / (n - 1)) * W;
  const y = (v: number) => H - (Math.max(0, Math.min(100, v)) / 100) * (H - 3) - 1.5;
  const line = pts.map((v, i) => (i ? "L" : "M") + x(i).toFixed(1) + " " + y(v).toFixed(1)).join(" ");
  const area = "M0 " + H + " " + line.replace(/^M/, "L") + " L" + W + " " + H + " Z";
  const last = pts[n - 1];
  const col = last >= 90 ? "var(--bad)" : last >= 70 ? "var(--warn)" : "var(--acc)";
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ width: "100%", height: 28, display: "block" }}>
      <path d={area} fill={col} opacity={0.12} />
      <path d={line} fill="none" stroke={col} strokeWidth={1.6} vectorEffect="non-scaling-stroke"
        strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={x(n - 1)} cy={y(last)} r={2} fill={col} />
    </svg>
  );
}

function SeatsBlock({ e, showHeader, control, onSwitch }: { e: Entry; showHeader: boolean; control: boolean; onSwitch: (a: Account) => void }) {
  const snap = e.snap;
  const accts = snap ? Object.values(snap.accounts || {}).sort((a, b) => a.slot - b.slot) : [];
  const [hist, setHist] = useState<Record<string, Array<{ five: number }>>>({});
  useEffect(() => {
    if (!e.online) return;
    api<Record<string, Array<{ five: number }>>>(e.deck, "/api/usage/history").then(setHist).catch(() => {});
  }, [e.deck, e.online]);
  return (
    <>
      {showHeader ? <MachineHeader e={e} /> : <div className="section-label">{t("Seats")}</div>}
      {!e.online && <ConnStateCard e={e} />}
      {e.online && !accts.length && (
        <div className="card empty"><div className="art"><SeatsGlyph /></div><b>{t("No seats yet")}</b>
          {t("Log in and run ")}<span className="mono">cux add</span>{t(" on the computer.")}</div>
      )}
      {snap && accts.map((a) => {
        const u = (snap.usage || {})[cacheKey(a)];
        const f = u?.five_hour?.utilization ?? null, d7 = u?.seven_day?.utilization ?? null;
        const resets = ([[u?.five_hour, "5h"], [u?.seven_day, "7d"]] as const)
          .filter(([w]) => w && w.utilization >= 90 && w.resets_at)
          .map(([w, l]) => l + " " + t("window frees in") + " " + inTime(w!.resets_at!));
        return (
          <div key={a.slot} className="card">
            <div className="row" style={{ marginBottom: u ? 12 : 0 }}>
              <div className="grow">
                <h3 className="ellip">{seatLabel(a)}</h3>
                <div className="sub ellip">{a.email} · {t("slot")} {a.slot}</div>
              </div>
              {a.slot === snap.activeSlot
                ? <span className="badge active">{t("active")}</span>
                : control ? <button className="btn ghost small" onClick={() => onSwitch(a)}>{t("switch")}</button> : null}
            </div>
            {u ? (
              <>
                <div className="row" style={{ gap: 22, justifyContent: "center", padding: "16px 0 20px", borderTop: "1px solid var(--line)" }}>
                  <Ring pct={f} cap={t("5H USED")} /><Ring pct={d7} cap={t("7D USED")} />
                </div>
                {resets.length > 0 && <div className="sub" style={{ textAlign: "center", marginTop: 6, paddingBottom: 4 }}><ClockIcon />{resets.join(" · ")}</div>}
                {u.token_expired && <div className="sub" style={{ color: "var(--bad)", textAlign: "center" }}><WarnIcon />{t("needs login on the computer")}</div>}
                {(hist[cacheKey(a)]?.length ?? 0) >= 2 && (
                  <div style={{ marginTop: 4 }}>
                    <div className="sub" style={{ fontSize: 10.5, marginBottom: 2 }}>{t("5H TREND")}</div>
                    <Spark pts={hist[cacheKey(a)].map((p) => p.five)} />
                  </div>
                )}
              </>
            ) : <div className="sub">{t("no usage data yet — tap refresh on the Deck tab")}</div>}
          </div>
        );
      })}
    </>
  );
}

function ProjectsBlock({ e, showHeader, control, onSeats, onCreate }: {
  e: Entry; showHeader: boolean; control: boolean; onSeats: (p: Project) => void; onCreate: () => void;
}) {
  const snap = e.snap;
  const ps = snap ? Object.values(snap.projects || {}).sort((a, b) => a.name.localeCompare(b.name)) : [];
  return (
    <>
      <div className="row" style={{ alignItems: "center" }}>
        {showHeader ? <MachineHeader e={e} /> : <div className="section-label" style={{ flex: 1 }}>{t("Projects")}</div>}
        {e.online && control && <button className="btn ghost small" style={{ marginLeft: "auto" }} onClick={onCreate}>{t("＋ new")}</button>}
      </div>
      {!e.online && <ConnStateCard e={e} />}
      {e.online && !ps.length && (
        <div className="card empty"><div className="art"><FolderGlyph /></div><b>{t("No projects")}</b>
          {t("Pin a directory to chosen seats with ＋ new.")}</div>
      )}
      {snap && ps.map((p) => (
        <div key={p.name} className="card">
          <div className="row">
            <div className="grow"><h3>{p.name}</h3>
              <div className="sub ellip mono" style={{ fontSize: 11.5 }}>{p.dir}</div></div>
            {control && <button className="btn ghost small" onClick={() => onSeats(p)}>{t("seats")}</button>}
          </div>
          <div style={{ marginTop: 10, display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
            {(p.slots || []).length
              ? p.slots!.map((sl) => {
                const a = (snap.accounts || {})[sl];
                return <span key={sl} className="badge active" style={{ textTransform: "none" }}>{a ? seatLabel(a) : "#" + sl}</span>;
              })
              : <span className="sub">{t("no seats pinned — full pool applies")}</span>}
          </div>
        </div>
      ))}
    </>
  );
}

// LanguageCard switches the whole panel's language. The names stay in
// their own language (English, Türkçe, …) — you recognise your own
// language regardless of the current UI language.
function LanguageCard() {
  const lang = useLang();
  return (
    <div className="card">
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        {LANGS.map((l) => (
          <button key={l.code} className={"btn small" + (lang === l.code ? "" : " ghost")}
            onClick={() => setLang(l.code)}>{l.label}</button>
        ))}
      </div>
    </div>
  );
}

function SettingsTab({ fleet, toast, setSheet, onAddMachine, onForget }: {
  fleet: Entry[]; toast: (m: string, ms?: number) => void; setSheet: (n: React.ReactNode | null) => void;
  onAddMachine: () => void; onForget: (d: Deck) => void;
}) {
  // Bumped whenever an invite is created or revoked so every
  // PendingInvitesCard refetches, regardless of which machine's sheet
  // triggered it.
  const [inviteReload, setInviteReload] = useState(0);
  return (
    <>
      <div className="section-label">{t("Language")}</div>
      <LanguageCard />
      <div className="section-label">{t("Add a phone")}</div>
      <PairPhoneCard toast={toast} />
      <div className="section-label">{t("This machine")}</div>
      {fleet.filter((e) => e.online && canControl(e)).map((e) => (
        <MachineNameCard key={e.deck.id} e={e} toast={toast} />
      ))}
      <div className="section-label">{t("Startup")}</div>
      {fleet.filter((e) => e.online && canControl(e)).map((e) => (
        <StartupCard key={e.deck.id} e={e} label={fleet.length > 1 ? machineName(e) : ""} toast={toast} />
      ))}
      <div className="section-label">{t("Software update")}</div>
      {fleet.filter((e) => e.online && canControl(e)).map((e) => (
        <UpdateCard key={e.deck.id} e={e} label={fleet.length > 1 ? machineName(e) : ""} toast={toast} />
      ))}
      <div className="section-label">{t("Notifications")}</div>
      <NotifyCard fleet={fleet} toast={toast} />
      <TelegramCard fleet={fleet} toast={toast} setSheet={setSheet} />
      <div className="row" style={{ alignItems: "center", marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--line)" }}>
        <div className="section-label" style={{ flex: 1, margin: 0 }}>{t("Machines in this fleet")}</div>
        <button className="btn ghost small" style={{ marginLeft: "auto" }} onClick={onAddMachine}>{t("＋ add")}</button>
      </div>
      {fleet.map((e) => {
        const cs = connState(e);
        const label = cs === "online"
          ? (e.snap ? e.snap.os + " · cuxdeck " + e.snap.version : t("online"))
          : cs === "connecting" ? t("connecting…") : t("unable to connect");
        return (
          <div key={e.deck.id} className="card"><div className="row">
            <div className="grow"><h3>{machineName(e)}</h3>
              <div className="sub row" style={{ gap: 6 }}>
                <span className={"mdot" + (cs === "online" ? "" : cs === "connecting" ? " connecting" : " off")}
                  style={{ width: 6, height: 6 }} />
                {label}{e.deck.url ? "" : " · " + t("this device")}
              </div></div>
            {e.deck.url ? <button className="btn danger small" onClick={() => onForget(e.deck)}>{t("forget")}</button> : null}
          </div></div>
        );
      })}
      <div className="section-label">{t("Share & team access")}</div>
      {fleet.filter((e) => e.online && canControl(e)).map((e) => (
        <div key={e.deck.id} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div className="card"><div className="row">
            <div className="grow"><h3>{machineName(e)}</h3>
              <div className="sub">{t("Invite someone to watch or help drive this machine.")}</div></div>
            <button className="btn ghost small" onClick={() => setSheet(<InviteSheet e={e} toast={toast}
              onCreated={() => setInviteReload((n) => n + 1)} />)}>{t("invite")}</button>
          </div></div>
          <PendingInvitesCard e={e} toast={toast} reloadKey={inviteReload} />
        </div>
      ))}
      {fleet.some((e) => e.online && !canControl(e)) && (
        <div className="card"><div className="sub">{t("You have ")}<b>{t("view-only")}</b>{t(" access to ")}{fleet.filter((e) => !canControl(e)).map(machineName).join(", ")}{t(" — watch and read, but controls are hidden.")}</div></div>
      )}
      <div className="section-label">{t("Paired devices (per machine)")}</div>
      {fleet.filter((e) => e.online && canControl(e)).map((e) => (
        <DeviceList key={e.deck.id} entry={e} label={fleet.length > 1 ? machineName(e) : ""} toast={toast} setSheet={setSheet} />
      ))}
      <div className="section-label">{t("About")}</div>
      <div className="card">
        <h3>⌁ cuxdeck</h3>
        <div className="sub" style={{ marginTop: 6 }}>{t("The fleet is assembled here in your browser — each machine is a separate deck with its own tunnel and token. Add another with its pairing link; forget it to drop it.")}</div>
      </div>
    </>
  );
}

// StartupCard toggles start-at-login for one machine, remotely — the
// same switch as the tray's "Start at login", reachable from the phone.
function StartupCard({ e, label, toast }: { e: Entry; label: string; toast: (m: string, ms?: number) => void }) {
  const [state, setState] = useState<{ supported: boolean; enabled: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    api<{ supported: boolean; enabled: boolean }>(e.deck, "/api/service").then(setState).catch(() => {});
  }, [e.deck]);
  useEffect(load, [load]);
  if (state && !state.supported) return null;
  const toggle = async () => {
    if (busy || !state) return;
    setBusy(true);
    try {
      await api(e.deck, "/api/service", { method: "POST", body: JSON.stringify({ enabled: !state.enabled }) });
      setState({ ...state, enabled: !state.enabled });
      toast(!state.enabled ? t("Will start at login") : t("Won't start at login"));
    } catch (err) { toast(t("Failed: ") + (err as Error).message, 3600); }
    finally { setBusy(false); }
  };
  return (
    <div className="card"><div className="row">
      <div className="grow"><h3>{t("Start at login")}{label ? " · " + label : ""}</h3>
        <div className="sub">{state?.enabled ? t("● launches when the computer starts") : t("Launch cuxdeck automatically on boot.")}</div></div>
      <button className={"btn small" + (state?.enabled ? " danger" : "")} disabled={busy || !state} onClick={toggle}>
        {busy ? "…" : state?.enabled ? t("Turn off") : t("Enable")}</button>
    </div></div>
  );
}

// UpdateCard shows the installed vs latest version, lets you pick how
// updates behave (off / notify / auto), and — on a Homebrew install —
// offers a one-tap "Update now" when a newer release is out.
type UpdateInfo = { current: string; latest: string; available: boolean; mode: string; method: string };
function UpdateCard({ e, label, toast }: { e: Entry; label: string; toast: (m: string, ms?: number) => void }) {
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    api<UpdateInfo>(e.deck, "/api/update").then(setInfo).catch(() => {});
  }, [e.deck]);
  useEffect(load, [load]);
  const setMode = async (mode: string) => {
    if (!info || info.mode === mode) return;
    setInfo({ ...info, mode });
    try {
      await api(e.deck, "/api/update", { method: "POST", body: JSON.stringify({ mode }) });
      toast(mode === "auto" ? t("Updates install automatically") : mode === "notify" ? t("You'll be told when an update is out") : t("Update checks off"));
    } catch (err) { toast(t("Failed: ") + (err as Error).message, 3600); load(); }
  };
  const install = async () => {
    setBusy(true);
    try {
      await api(e.deck, "/api/update", { method: "POST", body: JSON.stringify({ action: "install" }) });
      toast(t("Updating… the deck will restart in a moment"), 5000);
    } catch (err) { toast(t("Failed: ") + (err as Error).message, 3600); }
    finally { setBusy(false); }
  };
  if (!info) return null;
  const modes: Array<[string, string]> = [["off", t("Off")], ["notify", t("Notify")], ["auto", t("Auto")]];
  return (
    <div className="card">
      <div className="row">
        <div className="grow">
          <h3>cuxdeck {info.current}{label ? " · " + label : ""}</h3>
          <div className="sub">
            {info.available
              ? "● v" + info.latest + " " + t("available")
              : info.latest && info.latest !== info.current
                ? t("up to date") + " (latest v" + info.latest + ")"
                : t("up to date")}
          </div>
        </div>
        {info.available && (info.method === "homebrew"
          ? <button className="btn small" disabled={busy} onClick={install}>{busy ? "…" : t("Update now")}</button>
          : <a className="btn small" style={{ textDecoration: "none" }} href="https://github.com/centrual/cuxdeck/releases/latest" target="_blank" rel="noopener">{t("Download")}</a>)}
      </div>
      <div className="seg" style={{ marginTop: 10 }}>
        {modes.map(([m, lbl]) => (
          <button key={m} className={"segbtn" + (info.mode === m ? " on" : "")} onClick={() => setMode(m)}>{lbl}</button>
        ))}
      </div>
      <div className="sub" style={{ marginTop: 6 }}>
        {info.mode === "auto"
          ? (info.method === "homebrew" ? t("Installs new releases automatically, then restarts.") : t("Auto-install needs a Homebrew install; you'll be notified instead."))
          : info.mode === "notify" ? t("Checks for new releases and tells you — you install.") : t("No update checks.")}
      </div>
    </div>
  );
}

// PairPhoneCard shows the QR to add a phone. The QR only exists on the
// computer's own panel (it's a live credential served loopback-only),
// so on a phone it explains where to find it instead of failing.
function PairPhoneCard({ toast }: { toast: (m: string, ms?: number) => void }) {
  const isLocal = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  const [info, setInfo] = useState<{ url: string; link: string; qr: string } | null>(null);
  const [err, setErr] = useState("");
  const load = useCallback(async () => {
    setErr("");
    try {
      const r = await fetch("/local/pair-info");
      if (!r.ok) throw new Error(String(r.status));
      setInfo(await r.json());
    } catch { setErr(t("Couldn't load the pairing QR.")); }
  }, []);
  useEffect(() => { if (isLocal) load(); }, [isLocal, load]);
  if (!isLocal) {
    return (
      <div className="card"><div className="sub">{t("To add a phone, open cuxdeck's panel ")}<b>{t("on the computer itself")}</b>{t(" (menu-bar icon → “Open panel · pair a phone”). The scannable QR shows there.")}</div></div>
    );
  }
  const isTunnel = /^https:\/\//.test(info?.url || "");
  return (
    <div className="card" style={{ textAlign: "center" }}>
      <div className="sub" style={{ marginBottom: 10 }}>{t("Scan with your phone's camera — it opens cuxdeck on your phone, already paired.")}</div>
      {err ? <div className="sub" style={{ color: "var(--bad)" }}>{err}</div>
        : info ? <img src={info.qr} width={200} height={200} alt={t("pairing QR")}
            style={{ borderRadius: 14, background: "#fff", padding: 10 }} />
        : <div className="sub">{t("loading…")}</div>}
      {info && (
        <div style={{ marginTop: 12 }}>
          {/* The written address, so a phone that can't scan can just type
              it — and so it's obvious which tunnel URL is current (the
              trycloudflare address rotates on every restart, which is what
              strands a phone on a dead URL / Error 1033). */}
          <div className="sub" style={{ marginBottom: 4 }}>{isTunnel ? t("Or open this address on the phone:") : t("Local address (no public tunnel yet):")}</div>
          <div className="mono" style={{ wordBreak: "break-all", fontSize: 13, padding: "8px 10px", background: "var(--card)", border: "1px solid var(--line)", borderRadius: 10 }}>{info.url}</div>
          <div className="row" style={{ gap: 8, marginTop: 8, justifyContent: "center" }}>
            <button className="btn small" onClick={() => { navigator.clipboard?.writeText(info.link); toast(t("Pairing link copied — valid 10 min")); }}>{t("Copy pairing link")}</button>
            <button className="btn ghost small" onClick={() => { load(); toast(t("Fresh QR & link")); }}>{t("↻ new")}</button>
          </div>
        </div>
      )}
    </div>
  );
}

// MachineNameCard renames a machine (overrides the OS hostname in the
// fleet view). Blank restores the hostname.
function MachineNameCard({ e, toast }: { e: Entry; toast: (m: string, ms?: number) => void }) {
  const [name, setName] = useState("");
  const [saved, setSaved] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api<{ name: string }>(e.deck, "/api/name").then((r) => { setName(r.name || ""); setSaved(r.name || ""); }).catch(() => {});
  }, [e.deck]);
  const save = async () => {
    setBusy(true);
    try {
      await api(e.deck, "/api/name", { method: "POST", body: JSON.stringify({ name: name.trim() }) });
      setSaved(name.trim());
      toast(name.trim() ? t("Renamed to ") + name.trim() : t("Name reset to hostname"));
    } catch (err) { toast(t("Failed: ") + (err as Error).message, 3600); }
    finally { setBusy(false); }
  };
  return (
    <div className="card">
      <div className="sub" style={{ marginBottom: 6 }}>{t("Shown across your fleet. Currently ")}<b>{machineName(e)}</b>{e.snap?.os ? " · " + e.snap.os : ""}.</div>
      <div className="row" style={{ gap: 8 }}>
        <input style={{ flex: 1, background: "var(--card)", border: "1px solid var(--line)", color: "var(--fg)", padding: "10px 12px", borderRadius: 11, outline: "none" }}
          value={name} onChange={(ev) => setName(ev.target.value)} placeholder={t("e.g. mac-studio")} autoCapitalize="none" spellCheck={false} />
        <button className="btn small" disabled={busy || name.trim() === saved} onClick={save}>{t("Save")}</button>
      </div>
    </div>
  );
}

// NotifyCard enrols this browser for push on every reachable machine
// at once — one tap covers the fleet, since each deck pushes through
// its own tunnel to this browser's push service.
function NotifyCard({ fleet, toast }: { fleet: Entry[]; toast: (m: string, ms?: number) => void }) {
  const [on, setOn] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const online = fleet.filter((e) => e.online);
  // On load, if this browser already holds a subscription, re-register
  // it with every reachable deck — so a re-pair or a daemon restart
  // doesn't leave the toggle stuck on "Enable" while notifications are
  // actually still live in the browser.
  useEffect(() => {
    (async () => {
      if (!(await push.isEnabled())) { setOn(false); return; }
      for (const e of online) await push.resync(e.deck).catch(() => {});
      setOn(true);
    })();
    // re-run when the set of reachable decks changes
  }, [online.map((e) => e.deck.url).join(",")]);
  const supported = push.pushSupported();

  const toggle = async () => {
    if (busy) return;
    setBusy(true);
    try {
      if (on) {
        for (const e of online) await push.disable(e.deck);
        setOn(false); toast(t("Notifications off"));
      } else {
        if (!online.length) { toast(t("No reachable machine to enable")); return; }
        let ok = 0;
        for (const e of online) { try { if (await push.enable(e.deck)) ok++; } catch (err) { toast((err as Error).message, 3600); } }
        if (ok) { setOn(true); toast(t("Notifications on for ") + ok + " machine" + (ok === 1 ? "" : "s")); }
      }
    } finally { setBusy(false); }
  };

  if (!supported) return (
    <div className="card"><div className="sub">{t("This browser can't do Web Push. Add cuxdeck to your home screen (iOS 16.4+) or use a modern browser to get alerts.")}</div></div>
  );
  return (
    <div className="card"><div className="row">
      <div className="grow"><h3>{t("Push alerts")}</h3>
        <div className="sub">{t("Seats exhausted, retries, finished runs, a moved tunnel — pushed to this device.")}</div></div>
      <button className={"btn small" + (on ? " danger" : "")} disabled={busy} onClick={toggle}>
        {busy ? "…" : on ? t("Turn off") : t("Enable")}</button>
    </div></div>
  );
}

// TelegramCard connects a bot on the primary (first-listed) machine —
// Telegram is a single channel per deck, not per-device, so one link
// covers everyone. The wizard: paste BotFather token → send the bot a
// message → cuxdeck catches the chat id.
function TelegramCard({ fleet, toast, setSheet }: {
  fleet: Entry[]; toast: (m: string, ms?: number) => void; setSheet: (n: React.ReactNode | null) => void;
}) {
  const deck = fleet.find((e) => e.online)?.deck;
  const [status, setStatus] = useState<{ hasToken: boolean; linked: boolean } | null>(null);
  const load = useCallback(() => {
    if (!deck) return;
    api<{ hasToken: boolean; linked: boolean }>(deck, "/api/telegram/status").then(setStatus).catch(() => {});
  }, [deck]);
  useEffect(load, [load]);
  if (!deck) return null;

  const disconnect = async () => {
    await api(deck, "/api/telegram/disconnect", { method: "POST", body: "{}" }).catch(() => {});
    toast(t("Telegram disconnected")); load();
  };
  return (
    <div className="card"><div className="row">
      <TelegramMark size={34} />
      <div className="grow" style={{ marginLeft: 10 }}><h3>Telegram</h3>
        <div className="sub">{status?.linked
          ? t("● linked — alerts also go to your Telegram chat")
          : t("Get the same alerts in a Telegram chat that outlives any phone.")}</div></div>
      {status?.linked
        ? <button className="btn danger small" onClick={disconnect}>{t("unlink")}</button>
        : <button className="btn ghost small" onClick={() => setSheet(
          <TelegramWizard deck={deck} toast={toast} onDone={() => { setSheet(null); load(); }} />)}>{t("connect")}</button>}
    </div></div>
  );
}

// A numbered step with an illustrative visual — the "screenshot" is a
// faithful mock of the Telegram chat, since a real screenshot can't be
// embedded, but the layout matches what the user will see.
function Step({ n, title, children }: { n: number; title: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="tgstep">
      <div className="tgnum">{n}</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="tgtitle">{title}</div>
        {children}
      </div>
    </div>
  );
}

// A tiny Telegram-style chat bubble mock used to illustrate each step.
function TgBubble({ from, children }: { from?: string; children: React.ReactNode }) {
  return (
    <div className="tgchat">
      {from && <div className="tgfrom">{from}</div>}
      <div className="tgmsg">{children}</div>
    </div>
  );
}

function TelegramWizard({ deck, toast, onDone }: { deck: Deck; toast: (m: string, ms?: number) => void; onDone: () => void }) {
  const [step, setStep] = useState<1 | 2>(1);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const polling = useRef(false);

  const saveToken = async () => {
    if (busy || !token.trim()) return;
    setBusy(true);
    try {
      await api(deck, "/api/telegram/token", { method: "POST", body: JSON.stringify({ token: token.trim() }) });
      setStep(2);
      startPolling();
    } catch (e) { toast((e as Error).message, 3600); }
    finally { setBusy(false); }
  };

  const startPolling = () => {
    if (polling.current) return;
    polling.current = true;
    let tries = 0;
    const tick = async () => {
      if (!polling.current) return;
      tries++;
      try {
        const { linked } = await api<{ linked: boolean }>(deck, "/api/telegram/poll", { method: "POST", body: "{}" });
        if (linked) { polling.current = false; toast(t("Telegram linked ✓")); onDone(); return; }
      } catch { /* keep trying */ }
      if (tries < 90) setTimeout(tick, 2000); else { polling.current = false; toast(t("No message received — send your bot /start and retry")); }
    };
    setTimeout(tick, 1500);
  };
  useEffect(() => () => { polling.current = false; }, []);

  return (
    <>
      <div className="row" style={{ gap: 10, marginBottom: 4 }}>
        <TelegramMark size={30} />
        <h2 style={{ margin: 0 }}>{t("Connect Telegram")}</h2>
      </div>
      <div className="sheet-sub">{t("Free, ~1 minute. You make a personal bot, then paste its token — alerts arrive as chat messages.")}</div>

      {step === 1 ? (
        <div style={{ maxHeight: "60vh", overflowY: "auto" }}>
          <Step n={1} title={<>{t("Open ")}<b>BotFather</b>{t(" in Telegram")}</>}>
            <div className="sub">{t("Telegram's official bot for making bots — the blue ✓ verified one.")}</div>
            {/* t.me works everywhere a browser does (desktop included),
                unlike a tg:// deep link which needs the app installed. If a
                network blocks t.me at the DNS level, the manual note below
                still gets you there. */}
            <a className="btn small" style={{ display: "inline-block", marginTop: 6, textDecoration: "none" }}
              href="https://t.me/BotFather" target="_blank" rel="noopener">{t("Open @BotFather ›")}</a>
            <div className="sub" style={{ marginTop: 6 }}>{t("Button not working? Open Telegram and search ")}<span className="mono">@BotFather</span>{t(" by hand.")}</div>
          </Step>
          <Step n={2} title={<>{t("Send it ")}<span className="mono">/newbot</span></>}>
            <TgBubble from={t("You")}>/newbot</TgBubble>
            <TgBubble from="BotFather">{t("Alright, a new bot. How are we going to call it? Please choose a name…")}</TgBubble>
            <div className="sub" style={{ marginTop: 4 }}>{t("Answer its two questions: a name (anything, e.g. ")}<i>my cuxdeck</i>{t(") and a username ending in ")}<span className="mono">bot</span>{t(" (e.g. ")}<span className="mono">oguz_cuxdeck_bot</span>).</div>
          </Step>
          <Step n={3} title={<>{t("Copy the token it sends back")}</>}>
            <TgBubble from="BotFather">{t("Done! Use this token to access the HTTP API:")}<br /><span className="mono" style={{ color: "var(--acc)" }}>7654321:AAH<span style={{ opacity: .6 }}>Ex4mpl3-tok3n-k33p-secret</span></span></TgBubble>
          </Step>
          <div className="field" style={{ marginTop: 12 }}><label>{t("Paste the bot token here")}</label>
            <input value={token} onChange={(e) => setToken(e.target.value)} placeholder="7654321:AAH…"
              autoCapitalize="none" autoComplete="off" spellCheck={false} /></div>
          <button className="btn" style={{ width: "100%" }} disabled={busy} onClick={saveToken}>{busy ? t("Checking token…") : t("Save & continue")}</button>
        </div>
      ) : (
        <div>
          <Step n={4} title={<>{t("Open your new bot and tap ")}<b>{t("Start")}</b></>}>
            <div className="sub">{t("Find it by the username you chose, open the chat, and press the big ")}<b>{t("Start")}</b>{t(" button (or send any message). That's how it learns where to send your alerts.")}</div>
            <div className="tgstart">▶  START</div>
          </Step>
          <div className="cstat" style={{ justifyContent: "center", padding: "16px 0" }}>
            <span className="spin">✳</span> {t("waiting for your message…")}
          </div>
        </div>
      )}
    </>
  );
}

function DeviceList({ entry, label, toast, setSheet }: {
  entry: Entry; label: string; toast: (m: string, ms?: number) => void; setSheet: (n: React.ReactNode | null) => void;
}) {
  const [devs, setDevs] = useState<Device[] | null>(null);
  const load = useCallback(() => { api<Device[]>(entry.deck, "/api/devices").then(setDevs).catch(() => {}); }, [entry.deck]);
  useEffect(load, [load]);
  const doRevoke = async (id: string) => {
    setSheet(null);
    try { await api(entry.deck, "/api/devices/revoke", { method: "POST", body: JSON.stringify({ id }) }); toast(t("Device revoked")); load(); }
    catch (err) { toast(t("Failed: ") + (err as Error).message); }
  };
  return (
    <>
      {label && <div className="sub" style={{ margin: "2px 4px", fontWeight: 700 }}>{label}</div>}
      {devs === null && <div className="skel" />}
      {devs?.map((d) => (
        <div key={d.id} className="card"><div className="row">
          <div className="grow"><h3>{d.name}</h3>
            <div className="sub">{t("paired ")}{new Date(d.createdAt).toLocaleDateString()}{t(" · seen ")}{ago(d.lastSeen)} {t("ago")}</div></div>
          <button className="btn danger small" onClick={() => setSheet(
            <>
              <h2>{t("Revoke ")}{d.name}?</h2>
              <div className="sheet-sub">{t("That device loses access immediately and must pair again with a fresh code.")}</div>
              <div className="row" style={{ gap: 10 }}>
                <button className="btn ghost" style={{ flex: 1 }} onClick={() => setSheet(null)}>{t("Cancel")}</button>
                <button className="btn danger" style={{ flex: 1 }} onClick={() => doRevoke(d.id)}>{t("Revoke")}</button>
              </div>
            </>)}>{t("revoke")}</button>
        </div></div>
      ))}
      {devs?.length === 0 && <div className="card empty">{t("No devices.")}</div>}
    </>
  );
}

/* ---------- sheets ---------- */

function ConfirmSwitch({ label, onCancel, onGo }: { label: string; onCancel: () => void; onGo: () => void }) {
  return (
    <>
      <h2>{t("Switch to ")}{label}?</h2>
      <div className="sheet-sub">{t("Running sessions swap to this seat on their next relaunch; new sessions start on it immediately.")}</div>
      <div className="row" style={{ gap: 10 }}>
        <button className="btn ghost" style={{ flex: 1 }} onClick={onCancel}>{t("Cancel")}</button>
        <button className="btn" style={{ flex: 1 }} onClick={onGo}>{t("Switch")}</button>
      </div>
    </>
  );
}

function ProjectSheet({ host, create, toast }: {
  host: string; create: (name: string, dir: string) => void; toast: (m: string) => void;
}) {
  const [name, setName] = useState("");
  const [dir, setDir] = useState("");
  return (
    <>
      <h2>{t("New project")}</h2>
      <div className="sheet-sub">{t("Pin a directory to its own set of seats.")}</div>
      <div className="field"><label>{t("Name")}</label>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="clientwork" autoCapitalize="none" autoComplete="off" /></div>
      <div className="field"><label>{t("Directory (absolute path on ")}{host})</label>
        <input value={dir} onChange={(e) => setDir(e.target.value)} placeholder="/Users/you/code/client" autoCapitalize="none" autoComplete="off" /></div>
      <button className="btn" style={{ width: "100%" }}
        onClick={() => { if (!name.trim() || !dir.trim()) { toast(t("Name and directory are required")); return; } create(name.trim(), dir.trim()); }}>
        {t("Create project")}</button>
    </>
  );
}

function SpawnSheet({ e, onStart }: { e: Entry; onStart: (dir: string) => void }) {
  // Suggest directories the machine has actually worked in — every cwd
  // seen in a live session or a past conversation, most-recent first.
  const recent = useMemo(() => {
    const seen = new Map<string, number>();
    for (const s of e.snap?.sessions || []) seen.set(s.cwd, Math.max(seen.get(s.cwd) || 0, Date.parse(s.startedAt) || 0));
    for (const c of e.convs) if (c.cwd) seen.set(c.cwd, Math.max(seen.get(c.cwd) || 0, Date.parse(c.updatedAt) || 0));
    return [...seen.entries()].sort((a, b) => b[1] - a[1]).map(([d]) => d).slice(0, 8);
  }, [e]);
  const [dir, setDir] = useState(recent[0] || "");
  return (
    <>
      <h2>{t("New session on ")}{machineName(e)}</h2>
      <div className="sheet-sub">{t("cux starts in this directory and opens straight into the terminal. It keeps running after you close the tab.")}</div>
      <div className="field"><label>{t("Directory (absolute path)")}</label>
        <input value={dir} onChange={(ev) => setDir(ev.target.value)} placeholder="/Users/you/code/project"
          autoCapitalize="none" autoComplete="off" spellCheck={false} /></div>
      {recent.length > 0 && (
        <div style={{ margin: "2px 0 14px" }}>
          <div className="sub" style={{ marginBottom: 6 }}>{t("Recent")}</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {recent.map((d) => (
              <div key={d} className="choice" style={{ padding: "9px 6px" }} onClick={() => setDir(d)}>
                <div className="grow ellip mono" style={{ fontSize: 12 }}>{d}</div>
              </div>
            ))}
          </div>
        </div>
      )}
      <button className="btn" style={{ width: "100%" }}
        onClick={() => { if (dir.trim().startsWith("/")) onStart(dir.trim()); }}>{t("Start session ⌨")}</button>
    </>
  );
}

// InviteSheet mints a pairing link (remotely, from the panel) with a
// chosen role, so a teammate can be added without touching the machine.
function InviteSheet({ e, toast, onCreated }: { e: Entry; toast: (m: string, ms?: number) => void; onCreated: () => void }) {
  const [role, setRole] = useState<"view" | "control">("view");
  const [link, setLink] = useState("");
  const [inviteId, setInviteId] = useState("");
  const [busy, setBusy] = useState(false);
  const [revoked, setRevoked] = useState(false);
  const make = async () => {
    if (busy) return;
    setBusy(true);
    try {
      // The server hands back the public tunnel URL — a teammate can't
      // reach localhost, so never build the link from this origin.
      const { code, id, url } = await api<{ code: string; id: string; url: string }>(e.deck, "/api/invite", { method: "POST", body: JSON.stringify({ role }) });
      const origin = (url || e.deck.url || location.origin).replace(/\/$/, "");
      if (!/^https:\/\//.test(origin)) {
        toast(t("This machine has no public tunnel yet — can't invite remotely"), 4000);
        return;
      }
      setLink(origin + "/#p=" + code);
      setInviteId(id);
      onCreated();
    } catch (err) { toast(t("Failed: ") + (err as Error).message, 3600); }
    finally { setBusy(false); }
  };
  const copy = async () => { try { await navigator.clipboard.writeText(link); toast(t("Link copied")); } catch { toast(t("Copy failed — long-press to select")); } };
  const revokeNow = async () => {
    try {
      await api(e.deck, "/api/invites/revoke", { method: "POST", body: JSON.stringify({ id: inviteId }) });
      setRevoked(true);
      toast(t("Invite link revoked"));
      onCreated();
    } catch (err) { toast(t("Failed: ") + (err as Error).message, 3600); }
  };
  return (
    <>
      <h2>{t("Invite to ")}{machineName(e)}</h2>
      {!link ? (
        <>
          <div className="sheet-sub">{t("Pick what they can do, then share the one-time link. It works for 10 minutes and links one device.")}</div>
          <div style={{ margin: "4px 0 14px" }}>
            {([["view", t("View only"), t("Watch sessions, read conversations. No switching, spawning, or terminal.")],
               ["control", t("Full control"), t("Everything you can do — switch seats, start sessions, drive terminals.")]] as const).map(([r, title, desc]) => (
              <div key={r} className={"choice" + (role === r ? " on" : "")} onClick={() => setRole(r)}>
                <div className="tick">✓</div>
                <div className="grow"><b>{title}</b><div className="sub">{desc}</div></div>
              </div>
            ))}
          </div>
          <button className="btn" style={{ width: "100%" }} disabled={busy} onClick={make}>{busy ? "…" : t("Create invite link")}</button>
        </>
      ) : revoked ? (
        <div className="sub" style={{ textAlign: "center", padding: "10px 0" }}>{t("This link no longer works.")}</div>
      ) : (
        <>
          <div className="sheet-sub">{t("Send this to your teammate — one device, 10 minutes, ")}<b>{role === "view" ? t("view-only") : t("full control")}</b>.</div>
          <div className="field"><input readOnly value={link} onFocus={(ev) => ev.currentTarget.select()} /></div>
          <button className="btn" style={{ width: "100%" }} onClick={copy}>{t("Copy link")}</button>
          <button className="btn danger" style={{ width: "100%", marginTop: 8 }} onClick={revokeNow}>{t("Revoke this link")}</button>
        </>
      )}
    </>
  );
}

// PendingInvitesCard lists invite links minted from this machine that
// haven't been scanned yet (role + time left, never the code itself —
// same "shown once, then just an identity" treatment as device tokens),
// with a revoke button so one sent to the wrong person, or just no
// longer wanted, can be killed before anyone uses it.
function PendingInvitesCard({ e, toast, reloadKey }: { e: Entry; toast: (m: string, ms?: number) => void; reloadKey: number }) {
  const [invites, setInvites] = useState<PendingInvite[] | null>(null);
  const load = useCallback(() => {
    api<PendingInvite[]>(e.deck, "/api/invites").then(setInvites).catch(() => {});
  }, [e.deck]);
  useEffect(load, [load, reloadKey]);
  // Poll so an invite that hits its own TTL server-side (pruned on the
  // next PendingInvites call) drops out of this list on its own, instead
  // of lingering at "expires in now" until the next create/revoke.
  useEffect(() => {
    const id = setInterval(load, 15000);
    return () => clearInterval(id);
  }, [load]);
  useNow(10000);
  const revoke = async (id: string) => {
    try {
      await api(e.deck, "/api/invites/revoke", { method: "POST", body: JSON.stringify({ id }) });
      toast(t("Invite link revoked"));
      load();
    } catch (err) { toast(t("Failed: ") + (err as Error).message, 3600); }
  };
  if (!invites || !invites.length) return null;
  return (
    <div className="card">
      <div className="sub" style={{ fontWeight: 700, marginBottom: 2 }}>{t("Pending invite links")}</div>
      {invites.map((inv) => (
        <div key={inv.id} className="srow">
          <div className="grow">
            <span className="badge active" style={{ textTransform: "none" }}>
              {inv.role === "view" ? t("View only") : t("Full control")}</span>
            <div className="sub" style={{ marginTop: 4 }}><ClockIcon />{t("expires in ")}{inTime(inv.expiresAt)}</div>
          </div>
          <button className="btn danger small" onClick={() => revoke(inv.id)}>{t("revoke")}</button>
        </div>
      ))}
    </div>
  );
}

function AddMachineSheet({ add }: { add: (link: string) => void }) {
  const [link, setLink] = useState("");
  return (
    <>
      <h2>{t("Add a machine")}</h2>
      <div className="sheet-sub">{t("On the other computer run ")}<span className="mono">cuxdeck qr</span>{t(" (or read its terminal) and paste the pairing link here — it looks like ")}<span className="mono">https://…trycloudflare.com/#p=CODE</span>.</div>
      <div className="field"><label>{t("Pairing link")}</label>
        <input value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://…/#p=…" autoCapitalize="none" autoComplete="off" spellCheck={false} /></div>
      <button className="btn" style={{ width: "100%" }} onClick={() => add(link)}>{t("Add machine")}</button>
    </>
  );
}

function SeatSheet({ project, snap, deck, toast, refresh, act, close }: {
  project: Project; snap: Snapshot; deck: Deck; toast: (m: string) => void; refresh: () => void;
  act: (deck: Deck, a: string, args: Record<string, string>, note: string) => void; close: () => void;
}) {
  const had = useMemo(() => new Set(project.slots || []), [project]);
  const [want, setWant] = useState(() => new Set(project.slots || []));
  const accts = Object.values(snap.accounts || {}).sort((a, b) => a.slot - b.slot);
  const toggle = (slot: number) => setWant((w) => { const n = new Set(w); n.has(slot) ? n.delete(slot) : n.add(slot); return n; });
  const save = async () => {
    close();
    const adds = [...want].filter((s) => !had.has(s)), dels = [...had].filter((s) => !want.has(s));
    if (!adds.length && !dels.length) { toast(t("No changes")); return; }
    toast(t("Saving seats…"));
    try {
      for (const s of adds) await api(deck, "/api/action", { method: "POST", body: JSON.stringify({ action: "project-assign", args: { name: project.name, seat: String(s) } }) });
      for (const s of dels) await api(deck, "/api/action", { method: "POST", body: JSON.stringify({ action: "project-unassign", args: { name: project.name, seat: String(s) } }) });
      toast(t("Saved ✓")); refresh();
    } catch (e) { toast(t("Failed: ") + (e as Error).message); }
  };
  return (
    <>
      <h2>{project.name} {t("seats")}</h2>
      <div className="sheet-sub">{t("Pinned seats form this project's pool. A seat can serve several projects.")}</div>
      <div>
        {accts.map((a) => (
          <div key={a.slot} className={"choice" + (want.has(a.slot) ? " on" : "")} onClick={() => toggle(a.slot)}>
            <div className="tick">✓</div>
            <div className="grow"><b>{seatLabel(a)}</b> <span className="sub">{a.email}</span></div>
          </div>
        ))}
      </div>
      <div className="row" style={{ gap: 10, marginTop: 14 }}>
        <button className="btn danger" onClick={() => { close(); if (confirm(t("Remove project ") + project.name + t("? Accounts stay."))) act(deck, "project-remove", { name: project.name }, t("Removing…")); }}>{t("Remove")}</button>
        <button className="btn" style={{ flex: 1 }} onClick={save}>{t("Save")}</button>
      </div>
    </>
  );
}

/* ---------- pairing (first deck, this origin) ---------- */

// On this computer (loopback) the pairing code is already ours to
// mint, so the panel shows a QR to scan with a phone plus a one-tap
// "pair this computer" — no code to copy anywhere. On a phone (opened
// via the scanned link) the URL carries the code and it pairs itself;
// a manual code box is the cameraless fallback.
function Pair({ onPaired }: { onPaired: () => void }) {
  const isLocal = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  const [code, setCode] = useState(() => {
    const m = location.hash.match(/p=([A-Z0-9]+)/i);
    return m ? m[1].toUpperCase() : "";
  });
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const tried = useRef(false);

  const go = useCallback(async (c: string) => {
    if (!c) return;
    setErr("");
    try {
      const token = await pair("", c, deviceName()); // "" = this origin
      upsertDeck({ id: "self", url: "", token });
      history.replaceState(null, "", location.pathname);
      onPaired();
    } catch { setErr(t("Invalid or expired code — generate a fresh one on the computer.")); }
  }, [onPaired]);

  // Phone arriving via a scanned link: pair automatically.
  useEffect(() => { if (code && !tried.current) { tried.current = true; go(code); } }, [code, go]);

  // "Pair this computer": mint a loopback code and pair in one tap.
  const pairSelf = useCallback(async () => {
    setBusy(true); setErr("");
    try {
      const r = await fetch("/local/pairing", { method: "POST" });
      const { code } = await r.json();
      await go(code);
    } catch { setErr(t("Couldn't pair — is the daemon running?")); }
    finally { setBusy(false); }
  }, [go]);

  return (
    <div id="pair">
      <div className="logo" style={{ width: 118, height: 104 }}><Mascot size={98} /></div>
      <h2 className="mono">cuxdeck<span className="cur">_</span></h2>
      {isLocal ? (
        <>
          <p>{t("Scan this with your phone to add it — or pair this computer with one tap.")}</p>
          <img src="/local/qr.png" width={220} height={220} alt={t("pairing QR")}
            style={{ borderRadius: 16, background: "#fff", padding: 10 }}
            onError={(e) => { (e.currentTarget.style.display = "none"); }} />
          <button className="btn" style={{ width: 250 }} disabled={busy} onClick={pairSelf}>
            {busy ? "…" : t("Pair this computer")}</button>
          <div className="sub" style={{ fontSize: 12 }}>{t("The QR opens the phone straight onto your tunnel — no code to type.")}</div>
        </>
      ) : (
        <>
          <p>{t("Enter the pairing code shown on your computer, or scan its QR. One device, one code — that's the whole setup.")}</p>
          <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="··········"
            autoComplete="off" autoCapitalize="characters" spellCheck={false} />
          <button className="btn" style={{ width: 250 }} onClick={() => go(code.trim())}>{t("Pair this device")}</button>
        </>
      )}
      <div id="pairErr">{err}</div>
    </div>
  );
}
