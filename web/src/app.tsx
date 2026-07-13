// cuxdeck panel — React root. The fleet is assembled here in the
// browser: a list of decks (machines), each fetched directly over its
// own tunnel with its own token, then shown together. One machine
// renders flat; several render under per-machine headers.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, deviceName, pair, setUnauthorizedHandler } from "./api";
import { getDecks, hasDecks, noteDeckMeta, parsePairLink, removeDeck, upsertDeck, type Deck } from "./decks";
import { Chat } from "./chat";
import { Term } from "./term";
import * as push from "./push";
import { ago, inTime, shortDir } from "./util";

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

// One machine's live state: the connection, its latest snapshot and
// conversations, and whether the last fetch reached it.
type Entry = { deck: Deck; snap: Snapshot | null; convs: Conv[]; online: boolean };

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

export default function App() {
  const [decks, setDecks] = useState<Deck[]>(getDecks());
  const [fleet, setFleet] = useState<Entry[]>([]);
  const [tab, setTab] = useState<"deck" | "seats" | "projects" | "settings">("deck");
  const [chat, setChat] = useState<{ deck: Deck; path: string; title: string; sub: string } | null>(null);
  const [termSess, setTermSess] = useState<{ deck: Deck; pid: number; title: string } | null>(null);
  const [sheet, setSheet] = useState<React.ReactNode | null>(null);
  const [toastMsg, setToastMsg] = useState("");
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(null);
  useNow();

  const toast = useCallback((m: string, ms = 2400) => {
    setToastMsg(m);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastMsg(""), ms);
  }, []);

  // A 401 on a deck drops just that deck from the fleet (its token was
  // revoked); the others keep working.
  useEffect(() => setUnauthorizedHandler((d) => { removeDeck(d.id); setDecks(getDecks()); }), []);

  const refresh = useCallback(async () => {
    const ds = getDecks();
    if (!ds.length) return;
    const entries = await Promise.all(ds.map(async (deck): Promise<Entry> => {
      try {
        const snap = await api<Snapshot>(deck, "/api/deck");
        let convs: Conv[] = [];
        try { convs = (await api<Conv[]>(deck, "/api/conversations")) || []; } catch { /* keep deck online */ }
        noteDeckMeta(deck.url, snap.deckId, snap.hostname);
        return { deck, snap, convs, online: true };
      } catch { return { deck, snap: null, convs: [], online: false }; }
    }));
    setFleet(entries);
    setDecks(getDecks()); // pick up hostnames learned this round
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 4000);
    return () => clearInterval(t);
  }, [refresh, decks.length]);

  const act = useCallback(async (deck: Deck, action: string, args: Record<string, string>, note: string) => {
    toast(note);
    try { await api(deck, "/api/action", { method: "POST", body: JSON.stringify({ action, args }) }); toast("Done ✓"); refresh(); }
    catch (e) { toast("Failed: " + (e as Error).message, 3600); }
  }, [refresh, toast]);

  // Launch a brand-new cux session on a machine, then jump straight
  // into its terminal — start work from the phone, not just watch it.
  const spawnSession = useCallback(async (deck: Deck, dir: string) => {
    setSheet(null);
    toast("Starting cux in " + shortDir(dir) + "…");
    try {
      const { pid } = await api<{ pid: number }>(deck, "/api/spawn", { method: "POST", body: JSON.stringify({ dir }) });
      // Give cux a moment to open its attach socket before we connect.
      setTimeout(() => setTermSess({ deck, pid, title: shortDir(dir) }), 700);
      refresh();
    } catch (e) { toast("Failed: " + (e as Error).message, 3600); }
  }, [refresh, toast]);

  const addMachine = useCallback(async (link: string) => {
    const parsed = parsePairLink(link);
    if (!parsed) { toast("That doesn't look like a cuxdeck link"); return; }
    try {
      const token = await pair(parsed.url, parsed.code, deviceName());
      upsertDeck({ id: parsed.url || "self", url: parsed.url, token });
      setDecks(getDecks());
      setSheet(null);
      toast("Machine added ⌁");
      refresh();
    } catch { toast("Pairing failed — the code may have expired"); }
  }, [refresh, toast]);

  if (!hasDecks()) return <Pair onPaired={() => { setDecks(getDecks()); toast("Paired — welcome aboard ⌁"); }} />;

  const openChat = (deck: Deck, path: string, title: string, sub: string) => setChat({ deck, path, title, sub });
  const anyOnline = fleet.some((e) => e.online);
  const multi = fleet.length > 1;

  return (
    <>
      <header>
        <div className="brand">
          <div className="logo"><Mascot size={24} /></div>
          <h1 className="mono">cuxdeck<span className="cur">_</span></h1>
          <div className="host"><span className={"pulse" + (anyOnline ? "" : " off")}></span>
            <span>{multi ? fleet.length + " machines" : machineName(fleet[0] || { deck: decks[0] } as Entry)}</span></div>
        </div>
      </header>

      <main>
        {!fleet.length && <><div className="skel" /><div className="skel" /><div className="skel" /></>}

        {tab === "deck" && fleet.map((e) => (
          <MachineBlock key={e.deck.id} e={e} showHeader={multi}
            onOpenSession={(s) => openChat(e.deck, "/api/session/" + s.pid + "/chat", shortDir(s.cwd), "seat " + (s.seat ? s.seat.split("@")[0] : "—"))}
            onOpenConv={(c) => openChat(e.deck, "/api/conversation/" + c.id + "/chat", shortDir(c.cwd || "?"), "")}
            onOpenTerm={(s) => setTermSess({ deck: e.deck, pid: s.pid, title: shortDir(s.cwd) })}
            onNewSession={() => setSheet(<SpawnSheet e={e} onStart={(dir) => spawnSession(e.deck, dir)} />)}
            onRefreshUsage={() => act(e.deck, "usage-refresh", {}, "Refreshing usage…")} />
        ))}

        {tab === "seats" && fleet.map((e) => (
          <SeatsBlock key={e.deck.id} e={e} showHeader={multi}
            onSwitch={(a) => setSheet(<ConfirmSwitch label={seatLabel(a)} onCancel={() => setSheet(null)}
              onGo={() => { setSheet(null); act(e.deck, "switch", { target: String(a.slot) }, "Switching seat…"); }} />)} />
        ))}

        {tab === "projects" && fleet.map((e) => (
          <ProjectsBlock key={e.deck.id} e={e} showHeader={multi}
            onCreate={() => setSheet(<ProjectSheet host={machineName(e)} toast={toast}
              create={(name, dir) => { setSheet(null); act(e.deck, "project-create", { name, dir }, "Creating " + name + "…"); }} />)}
            onSeats={(p) => e.snap && setSheet(<SeatSheet project={p} snap={e.snap} deck={e.deck} toast={toast} refresh={refresh} act={act} close={() => setSheet(null)} />)} />
        ))}

        {tab === "settings" && (
          <SettingsTab fleet={fleet} toast={toast} setSheet={setSheet}
            onAddMachine={() => setSheet(<AddMachineSheet add={addMachine} />)}
            onForget={(d) => { removeDeck(d.id); setDecks(getDecks()); toast("Machine forgotten"); }} />
        )}
      </main>

      <nav>
        {(["deck", "seats", "projects", "settings"] as const).map((t) => (
          <button key={t} className={tab === t ? "on" : ""} onClick={() => { setTab(t); window.scrollTo({ top: 0 }); }}>
            <NavIcon name={t} />{t[0].toUpperCase() + t.slice(1)}
          </button>
        ))}
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

// MachineHeader labels a machine's section in the fleet and shows
// whether it's currently reachable.
function MachineHeader({ e }: { e: Entry }) {
  return (
    <div className="mhead">
      <span className={"mdot" + (e.online ? "" : " off")} />
      <span className="mname">{machineName(e)}</span>
      {!e.online && <span className="moff">unreachable</span>}
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

function ProjectCard({ g, onOpenConv, onOpenSession, onOpenTerm }: {
  g: ProjectGroup;
  onOpenConv: (c: Conv) => void; onOpenSession: (s: Session) => void; onOpenTerm: (s: Session) => void;
}) {
  const [open, setOpen] = useState(false);
  const stateColor: Record<string, string> = {
    running: "var(--ok)", "waiting-reset": "var(--warn)", retrying: "var(--bad)", swapping: "var(--info)",
  };
  const live = g.sessions.length;
  const liveHistory = g.history.filter((c) => c.active);
  const past = g.history.filter((c) => !c.active);
  const edge = live || liveHistory.length ? "var(--ok)" : "var(--line)";

  return (
    <div className="card" style={{ borderLeft: "3px solid " + edge }}>
      <div className="row">
        <div className="grow"><h3 className="ellip">{shortDir(g.dir)}</h3>
          <div className="sub">{live
            ? <><b style={{ color: "var(--ok)" }}>● {live} running</b>{live > 1 ? " · " + live + " seats" : ""}</>
            : liveHistory.length ? <b style={{ color: "var(--ok)" }}>● live (outside cux)</b>
              : <>{g.history.length} conversation{g.history.length === 1 ? "" : "s"} · {ago(new Date(g.lastAt).toISOString())} ago</>}
          </div>
        </div>
      </div>

      {g.sessions.map(({ s, conv }) => (
        <div key={s.pid} className="srow tappable" onClick={() => (conv ? onOpenConv(conv) : onOpenSession(s))}>
          <span className="dot" style={{ color: stateColor[s.state] || "var(--dim)" }}>▎</span>
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="ellip" style={{ fontWeight: 600 }}>{conv?.title || "(starting…)"}</div>
            <div className="sub">seat <b>{s.seat ? s.seat.split("@")[0] : "—"}</b> · up {ago(s.startedAt)}
              {s.detail ? " · ↻ " + s.detail : ""}</div>
          </div>
          {s.attachable && (
            <button className="btn ghost small" style={{ flex: "none" }}
              onClick={(ev) => { ev.stopPropagation(); onOpenTerm(s); }}>⌨</button>
          )}
        </div>
      ))}

      {liveHistory.map((c) => (
        <div key={c.id} className="srow tappable" onClick={() => onOpenConv(c)}>
          <span className="dot" style={{ color: "var(--ok)" }}>▎</span>
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="ellip" style={{ fontWeight: 600 }}>{c.title || "(no messages yet)"}</div>
            <div className="sub">not managed by cux · ● live</div>
          </div>
        </div>
      ))}

      {past.length > 0 && (
        <>
          <div className="morebar" onClick={() => setOpen(!open)}>
            {open ? "▾ hide"
              : (live || liveHistory.length)
                ? "▸ " + past.length + " past conversation" + (past.length === 1 ? "" : "s")
                : "▸ show conversations"}
          </div>
          {open && past.map((c) => (
            <div key={c.id} className="srow tappable" onClick={() => onOpenConv(c)}>
              <span className="dot" style={{ color: "var(--faint)" }}>▎</span>
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="ellip">{c.title || "(no messages yet)"}</div>
                <div className="sub">{ago(c.updatedAt)} ago</div>
              </div>
            </div>
          ))}
        </>
      )}
    </div>
  );
}

/* ---------- per-machine tab blocks ---------- */

function MachineBlock({ e, showHeader, onOpenSession, onOpenConv, onOpenTerm, onNewSession, onRefreshUsage }: {
  e: Entry; showHeader: boolean;
  onOpenSession: (s: Session) => void; onOpenConv: (c: Conv) => void; onOpenTerm: (s: Session) => void;
  onNewSession: () => void; onRefreshUsage: () => void;
}) {
  const snap = e.snap;
  const groups = snap ? groupByProject(snap.sessions || [], e.convs) : [];
  return (
    <>
      <div className="row" style={{ alignItems: "center" }}>
        {showHeader ? <MachineHeader e={e} /> : <div className="section-label" style={{ flex: 1 }}>Projects</div>}
        {e.online && <button className="btn ghost small" style={{ marginLeft: "auto" }} onClick={onNewSession}>＋ new session</button>}
      </div>
      {!e.online && <div className="card empty"><div className="art">📡</div><b>Unreachable</b>
        This machine's tunnel is down or it's offline.</div>}
      {e.online && !groups.length && (
        <div className="card empty"><div className="art">🌙</div><b>All quiet</b>
          No sessions or conversations yet.</div>
      )}
      {groups.map((g) => (
        <ProjectCard key={g.dir} g={g} onOpenConv={onOpenConv} onOpenSession={onOpenSession} onOpenTerm={onOpenTerm} />
      ))}
      {snap && !showHeader && (
        <>
          <div className="section-label">This machine</div>
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
      <button className="btn ghost small" onClick={onRefreshUsage}>↻ refresh</button>
    </div></div>
  );
}

function SeatsBlock({ e, showHeader, onSwitch }: { e: Entry; showHeader: boolean; onSwitch: (a: Account) => void }) {
  const snap = e.snap;
  const accts = snap ? Object.values(snap.accounts || {}).sort((a, b) => a.slot - b.slot) : [];
  return (
    <>
      {showHeader ? <MachineHeader e={e} /> : <div className="section-label">Seats</div>}
      {!e.online && <div className="card empty"><div className="art">📡</div><b>Unreachable</b></div>}
      {e.online && !accts.length && (
        <div className="card empty"><div className="art">🪑</div><b>No seats yet</b>
          Log in and run <span className="mono">cux add</span> on the computer.</div>
      )}
      {snap && accts.map((a) => {
        const u = (snap.usage || {})[cacheKey(a)];
        const f = u?.five_hour?.utilization ?? null, d7 = u?.seven_day?.utilization ?? null;
        const resets = ([[u?.five_hour, "5h"], [u?.seven_day, "7d"]] as const)
          .filter(([w]) => w && w.utilization >= 90 && w.resets_at)
          .map(([w, l]) => l + " window frees in " + inTime(w!.resets_at!));
        return (
          <div key={a.slot} className="card">
            <div className="row" style={{ marginBottom: u ? 12 : 0 }}>
              <div className="grow">
                <h3 className="ellip">{seatLabel(a)}</h3>
                <div className="sub ellip">{a.email} · slot {a.slot}</div>
              </div>
              {a.slot === snap.activeSlot
                ? <span className="badge active">active</span>
                : <button className="btn ghost small" onClick={() => onSwitch(a)}>switch</button>}
            </div>
            {u ? (
              <>
                <div className="row" style={{ gap: 22, justifyContent: "center", padding: "4px 0 14px" }}>
                  <Ring pct={f} cap="5H USED" /><Ring pct={d7} cap="7D USED" />
                </div>
                {resets.length > 0 && <div className="sub" style={{ textAlign: "center", marginTop: 6, paddingBottom: 4 }}>⏳ {resets.join(" · ")}</div>}
                {u.token_expired && <div className="sub" style={{ color: "var(--bad)", textAlign: "center" }}>⚠ needs login on the computer</div>}
              </>
            ) : <div className="sub">no usage data yet — tap refresh on the Deck tab</div>}
          </div>
        );
      })}
    </>
  );
}

function ProjectsBlock({ e, showHeader, onSeats, onCreate }: {
  e: Entry; showHeader: boolean; onSeats: (p: Project) => void; onCreate: () => void;
}) {
  const snap = e.snap;
  const ps = snap ? Object.values(snap.projects || {}).sort((a, b) => a.name.localeCompare(b.name)) : [];
  return (
    <>
      <div className="row" style={{ alignItems: "center" }}>
        {showHeader ? <MachineHeader e={e} /> : <div className="section-label" style={{ flex: 1 }}>Projects</div>}
        {e.online && <button className="btn ghost small" style={{ marginLeft: "auto" }} onClick={onCreate}>＋ new</button>}
      </div>
      {!e.online && <div className="card empty"><div className="art">📡</div><b>Unreachable</b></div>}
      {e.online && !ps.length && (
        <div className="card empty"><div className="art">📁</div><b>No projects</b>
          Pin a directory to chosen seats with ＋ new.</div>
      )}
      {snap && ps.map((p) => (
        <div key={p.name} className="card">
          <div className="row">
            <div className="grow"><h3>{p.name}</h3>
              <div className="sub ellip mono" style={{ fontSize: 11.5 }}>{p.dir}</div></div>
            <button className="btn ghost small" onClick={() => onSeats(p)}>seats</button>
          </div>
          <div style={{ marginTop: 10, display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
            {(p.slots || []).length
              ? p.slots!.map((sl) => {
                const a = (snap.accounts || {})[sl];
                return <span key={sl} className="badge active" style={{ textTransform: "none" }}>{a ? seatLabel(a) : "#" + sl}</span>;
              })
              : <span className="sub">no seats pinned — full pool applies</span>}
          </div>
        </div>
      ))}
    </>
  );
}

function SettingsTab({ fleet, toast, setSheet, onAddMachine, onForget }: {
  fleet: Entry[]; toast: (m: string, ms?: number) => void; setSheet: (n: React.ReactNode | null) => void;
  onAddMachine: () => void; onForget: (d: Deck) => void;
}) {
  return (
    <>
      <div className="section-label">Notifications</div>
      <NotifyCard fleet={fleet} toast={toast} />
      <div className="row" style={{ alignItems: "center" }}>
        <div className="section-label" style={{ flex: 1 }}>Machines in this fleet</div>
        <button className="btn ghost small" style={{ marginLeft: "auto" }} onClick={onAddMachine}>＋ add</button>
      </div>
      {fleet.map((e) => (
        <div key={e.deck.id} className="card"><div className="row">
          <div className="grow"><h3>{machineName(e)}</h3>
            <div className="sub">{e.online ? (e.snap ? "● online · " + e.snap.os + " · cuxdeck " + e.snap.version : "● online") : "○ unreachable"}
              {e.deck.url ? "" : " · this device"}</div></div>
          {e.deck.url ? <button className="btn danger small" onClick={() => onForget(e.deck)}>forget</button> : null}
        </div></div>
      ))}
      <div className="section-label">Paired devices (per machine)</div>
      {fleet.filter((e) => e.online).map((e) => (
        <DeviceList key={e.deck.id} entry={e} label={fleet.length > 1 ? machineName(e) : ""} toast={toast} setSheet={setSheet} />
      ))}
      <div className="section-label">About</div>
      <div className="card">
        <h3>⌁ cuxdeck</h3>
        <div className="sub" style={{ marginTop: 6 }}>The fleet is assembled here in your browser — each machine is a
          separate deck with its own tunnel and token. Add another with its pairing link; forget it to drop it.</div>
      </div>
    </>
  );
}

// NotifyCard enrols this browser for push on every reachable machine
// at once — one tap covers the fleet, since each deck pushes through
// its own tunnel to this browser's push service.
function NotifyCard({ fleet, toast }: { fleet: Entry[]; toast: (m: string, ms?: number) => void }) {
  const [on, setOn] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { push.isEnabled().then(setOn); }, []);
  const supported = push.pushSupported();

  const toggle = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const online = fleet.filter((e) => e.online);
      if (on) {
        for (const e of online) await push.disable(e.deck);
        setOn(false); toast("Notifications off");
      } else {
        if (!online.length) { toast("No reachable machine to enable"); return; }
        let ok = 0;
        for (const e of online) { try { if (await push.enable(e.deck)) ok++; } catch (err) { toast((err as Error).message, 3600); } }
        if (ok) { setOn(true); toast("Notifications on for " + ok + " machine" + (ok === 1 ? "" : "s")); }
      }
    } finally { setBusy(false); }
  };

  if (!supported) return (
    <div className="card"><div className="sub">This browser can't do Web Push. Add cuxdeck to your home screen (iOS 16.4+) or use a modern browser to get alerts.</div></div>
  );
  return (
    <div className="card"><div className="row">
      <div className="grow"><h3>Push alerts</h3>
        <div className="sub">Seats exhausted, retries, finished runs, a moved tunnel — pushed to this device.</div></div>
      <button className={"btn small" + (on ? " danger" : "")} disabled={busy} onClick={toggle}>
        {busy ? "…" : on ? "Turn off" : "Enable"}</button>
    </div></div>
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
    try { await api(entry.deck, "/api/devices/revoke", { method: "POST", body: JSON.stringify({ id }) }); toast("Device revoked"); load(); }
    catch (err) { toast("Failed: " + (err as Error).message); }
  };
  return (
    <>
      {label && <div className="sub" style={{ margin: "2px 4px", fontWeight: 700 }}>{label}</div>}
      {devs === null && <div className="skel" />}
      {devs?.map((d) => (
        <div key={d.id} className="card"><div className="row">
          <div className="grow"><h3>{d.name}</h3>
            <div className="sub">paired {new Date(d.createdAt).toLocaleDateString()} · seen {ago(d.lastSeen)} ago</div></div>
          <button className="btn danger small" onClick={() => setSheet(
            <>
              <h2>Revoke {d.name}?</h2>
              <div className="sheet-sub">That device loses access immediately and must pair again with a fresh code.</div>
              <div className="row" style={{ gap: 10 }}>
                <button className="btn ghost" style={{ flex: 1 }} onClick={() => setSheet(null)}>Cancel</button>
                <button className="btn danger" style={{ flex: 1 }} onClick={() => doRevoke(d.id)}>Revoke</button>
              </div>
            </>)}>revoke</button>
        </div></div>
      ))}
      {devs?.length === 0 && <div className="card empty">No devices.</div>}
    </>
  );
}

/* ---------- sheets ---------- */

function ConfirmSwitch({ label, onCancel, onGo }: { label: string; onCancel: () => void; onGo: () => void }) {
  return (
    <>
      <h2>Switch to {label}?</h2>
      <div className="sheet-sub">Running sessions swap to this seat on their next relaunch; new sessions start on it immediately.</div>
      <div className="row" style={{ gap: 10 }}>
        <button className="btn ghost" style={{ flex: 1 }} onClick={onCancel}>Cancel</button>
        <button className="btn" style={{ flex: 1 }} onClick={onGo}>Switch</button>
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
      <h2>New project</h2>
      <div className="sheet-sub">Pin a directory to its own set of seats.</div>
      <div className="field"><label>Name</label>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="clientwork" autoCapitalize="none" autoComplete="off" /></div>
      <div className="field"><label>Directory (absolute path on {host})</label>
        <input value={dir} onChange={(e) => setDir(e.target.value)} placeholder="/Users/you/code/client" autoCapitalize="none" autoComplete="off" /></div>
      <button className="btn" style={{ width: "100%" }}
        onClick={() => { if (!name.trim() || !dir.trim()) { toast("Name and directory are required"); return; } create(name.trim(), dir.trim()); }}>
        Create project</button>
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
      <h2>New session on {machineName(e)}</h2>
      <div className="sheet-sub">cux starts in this directory and opens straight into the terminal. It keeps running after you close the tab.</div>
      <div className="field"><label>Directory (absolute path)</label>
        <input value={dir} onChange={(ev) => setDir(ev.target.value)} placeholder="/Users/you/code/project"
          autoCapitalize="none" autoComplete="off" spellCheck={false} /></div>
      {recent.length > 0 && (
        <div style={{ margin: "2px 0 14px" }}>
          <div className="sub" style={{ marginBottom: 6 }}>Recent</div>
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
        onClick={() => { if (dir.trim().startsWith("/")) onStart(dir.trim()); }}>Start session ⌨</button>
    </>
  );
}

function AddMachineSheet({ add }: { add: (link: string) => void }) {
  const [link, setLink] = useState("");
  return (
    <>
      <h2>Add a machine</h2>
      <div className="sheet-sub">On the other computer run <span className="mono">cuxdeck qr</span> (or read its terminal) and paste the pairing link here — it looks like <span className="mono">https://…trycloudflare.com/#p=CODE</span>.</div>
      <div className="field"><label>Pairing link</label>
        <input value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://…/#p=…" autoCapitalize="none" autoComplete="off" spellCheck={false} /></div>
      <button className="btn" style={{ width: "100%" }} onClick={() => add(link)}>Add machine</button>
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
    if (!adds.length && !dels.length) { toast("No changes"); return; }
    toast("Saving seats…");
    try {
      for (const s of adds) await api(deck, "/api/action", { method: "POST", body: JSON.stringify({ action: "project-assign", args: { name: project.name, seat: String(s) } }) });
      for (const s of dels) await api(deck, "/api/action", { method: "POST", body: JSON.stringify({ action: "project-unassign", args: { name: project.name, seat: String(s) } }) });
      toast("Saved ✓"); refresh();
    } catch (e) { toast("Failed: " + (e as Error).message); }
  };
  return (
    <>
      <h2>{project.name} seats</h2>
      <div className="sheet-sub">Pinned seats form this project's pool. A seat can serve several projects.</div>
      <div>
        {accts.map((a) => (
          <div key={a.slot} className={"choice" + (want.has(a.slot) ? " on" : "")} onClick={() => toggle(a.slot)}>
            <div className="tick">✓</div>
            <div className="grow"><b>{seatLabel(a)}</b> <span className="sub">{a.email}</span></div>
          </div>
        ))}
      </div>
      <div className="row" style={{ gap: 10, marginTop: 14 }}>
        <button className="btn danger" onClick={() => { close(); if (confirm("Remove project " + project.name + "? Accounts stay.")) act(deck, "project-remove", { name: project.name }, "Removing…"); }}>Remove</button>
        <button className="btn" style={{ flex: 1 }} onClick={save}>Save</button>
      </div>
    </>
  );
}

/* ---------- pairing (first deck, this origin) ---------- */

function Pair({ onPaired }: { onPaired: () => void }) {
  const [code, setCode] = useState(() => {
    const m = location.hash.match(/p=([A-Z0-9]+)/i);
    return m ? m[1].toUpperCase() : "";
  });
  const [err, setErr] = useState("");
  const tried = useRef(false);
  const go = useCallback(async (c: string) => {
    if (!c) return;
    setErr("");
    try {
      const token = await pair("", c, deviceName()); // "" = this origin
      upsertDeck({ id: "self", url: "", token });
      history.replaceState(null, "", location.pathname);
      onPaired();
    } catch { setErr("Invalid or expired code — generate a fresh one on the computer."); }
  }, [onPaired]);
  useEffect(() => { if (code && !tried.current) { tried.current = true; go(code); } }, [code, go]);
  return (
    <div id="pair">
      <div className="logo" style={{ width: 118, height: 104 }}><Mascot size={98} /></div>
      <h2 className="mono">cuxdeck<span className="cur">_</span></h2>
      <p>Enter the pairing code shown on your computer to link this device. One scan, one device — that's the whole setup.</p>
      <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="··········"
        autoComplete="off" autoCapitalize="characters" spellCheck={false} />
      <button className="btn" style={{ width: 250 }} onClick={() => go(code.trim())}>Pair this device</button>
      <div id="pairErr">{err}</div>
    </div>
  );
}
