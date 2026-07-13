// cuxdeck panel — React root. Tabs (Deck / Seats / Projects / Settings),
// device pairing, bottom sheets and the live conversation overlay.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, deviceName, setToken, setUnauthorizedHandler, TOK } from "./api";
import { Chat } from "./chat";
import { Term } from "./term";
import { ago, inTime, shortDir } from "./util";

/* ---------- server shapes ---------- */
type Session = { pid: number; cwd: string; sessionId?: string; seat?: string; state: string; detail?: string; startedAt: string; attachable?: boolean };
type Account = { email: string; alias?: string; slot: number; uuid?: string; orgUuid?: string };
type Usage = { five_hour?: Win; seven_day?: Win; token_expired?: boolean };
type Win = { utilization: number; resets_at?: string };
type Project = { name: string; dir: string; slots?: number[] };
type Deck = {
  deckId: string; hostname: string; os: string; version: string;
  sessions: Session[]; accounts: Record<string, Account>;
  usage: Record<string, Usage>; projects?: Record<string, Project>; activeSlot: number;
};
type Conv = { id: string; cwd: string; title: string; updatedAt: string; active: boolean };
type Device = { id: string; name: string; createdAt: string; lastSeen: string };

const cacheKey = (a: Account) => (a.uuid && a.orgUuid ? a.uuid + "|" + a.orgUuid : a.orgUuid || a.email);
const seatLabel = (a: Account) => a.alias || a.email.split("@")[0];

/* Re-render once a second so relative times tick without any DOM hacks —
   this is the whole data-tick machinery from the vanilla panel, gone. */
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
  const [paired, setPaired] = useState(!!TOK);
  const [deck, setDeck] = useState<Deck | null>(null);
  const [convs, setConvs] = useState<Conv[]>([]);
  const [online, setOnline] = useState(true);
  const [tab, setTab] = useState<"deck" | "seats" | "projects" | "settings">("deck");
  const [chat, setChat] = useState<{ url: string; title: string; sub: string } | null>(null);
  const [termSess, setTermSess] = useState<{ pid: number; title: string } | null>(null);
  const [sheet, setSheet] = useState<React.ReactNode | null>(null);
  const [toastMsg, setToastMsg] = useState("");
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(null);
  useNow(); // 1s re-render: every ago()/inTime() in the tree ticks

  const toast = useCallback((m: string, ms = 2400) => {
    setToastMsg(m);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastMsg(""), ms);
  }, []);

  useEffect(() => setUnauthorizedHandler(() => setPaired(false)), []);

  const refresh = useCallback(async () => {
    if (!TOK) return;
    try {
      setDeck(await api<Deck>("/api/deck"));
      try { setConvs((await api<Conv[]>("/api/conversations")) || []); } catch { setConvs([]); }
      setOnline(true);
    } catch (e) { if ((e as Error).message !== "unauthorized") setOnline(false); }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 4000);
    return () => clearInterval(t);
  }, [refresh, paired]);

  const act = useCallback(async (action: string, args: Record<string, string>, note: string) => {
    toast(note);
    try { await api("/api/action", { method: "POST", body: JSON.stringify({ action, args }) }); toast("Done ✓"); refresh(); }
    catch (e) { toast("Failed: " + (e as Error).message, 3600); }
  }, [refresh, toast]);

  if (!paired) return <Pair onPaired={() => { setPaired(true); toast("Paired — welcome aboard ⌁"); }} />;

  return (
    <>
      <header>
        <div className="brand">
          <div className="logo"><Mascot size={24} /></div>
          <h1 className="mono">cuxdeck<span className="cur">_</span></h1>
          <div className="host"><span className={"pulse" + (online ? "" : " off")}></span><span>{deck?.hostname || "—"}</span></div>
        </div>
      </header>

      <main>
        {!deck && <><div className="skel" /><div className="skel" /><div className="skel" /></>}
        {deck && tab === "deck" && (
          <DeckTab deck={deck} convs={convs}
            onOpenSession={(s) => setChat({ url: "/api/session/" + s.pid + "/chat", title: shortDir(s.cwd), sub: "seat " + (s.seat ? s.seat.split("@")[0] : "—") })}
            onOpenConv={(c) => setChat({ url: "/api/conversation/" + c.id + "/chat", title: shortDir(c.cwd || "?"), sub: "" })}
            onOpenTerm={(s) => setTermSess({ pid: s.pid, title: shortDir(s.cwd) })}
            onRefreshUsage={() => act("usage-refresh", {}, "Refreshing usage…")} />
        )}
        {deck && tab === "seats" && (
          <SeatsTab deck={deck} onSwitch={(a) => setSheet(
            <ConfirmSwitch label={seatLabel(a)} onCancel={() => setSheet(null)}
              onGo={() => { setSheet(null); act("switch", { target: String(a.slot) }, "Switching seat…"); }} />)} />
        )}
        {deck && tab === "projects" && (
          <ProjectsTab deck={deck}
            onSeats={(p) => setSheet(<SeatSheet project={p} deck={deck} toast={toast} refresh={refresh} act={act} close={() => setSheet(null)} />)} />
        )}
        {deck && tab === "settings" && <SettingsTab deck={deck} toast={toast} setSheet={setSheet} />}
      </main>

      {tab === "projects" && (
        <button className="btn fab" onClick={() => setSheet(
          <ProjectSheet host={deck?.hostname || ""}
            create={(name, dir) => { setSheet(null); act("project-create", { name, dir }, "Creating " + name + "…"); }} toast={toast} />)}>＋</button>
      )}

      <nav>
        {(["deck", "seats", "projects", "settings"] as const).map((t) => (
          <button key={t} className={tab === t ? "on" : ""} onClick={() => { setTab(t); window.scrollTo({ top: 0 }); }}>
            <NavIcon name={t} />{t[0].toUpperCase() + t.slice(1)}
          </button>
        ))}
      </nav>

      <div id="veil" className={sheet ? "show" : ""} onClick={() => setSheet(null)} />
      <div id="sheet" className={sheet ? "show" : ""}><div className="grip" />{sheet}</div>
      {chat && <Chat url={chat.url} title={chat.title} sub={chat.sub} onClose={() => setChat(null)} />}
      {termSess && <Term pid={termSess.pid} title={termSess.title} onClose={() => setTermSess(null)} />}
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

/* ---------- tabs ---------- */

// A directory is the unit a person thinks in — "the project I'm working
// on" — so the deck groups by it. cux can run several seats against one
// directory at once (project pools), and each shows up as its own
// wrapper PID; grouping collapses those into a single project card with
// a row per live session, instead of N cards that look like N projects.
type ProjectGroup = {
  dir: string;
  sessions: Array<{ s: Session; conv?: Conv }>;
  history: Conv[]; // transcripts here with no live session of their own
  lastAt: number;
};

function groupByProject(sessions: Session[], convs: Conv[]): ProjectGroup[] {
  const groups = new Map<string, ProjectGroup>();
  const get = (dir: string) => {
    let g = groups.get(dir);
    if (!g) { g = { dir, sessions: [], history: [], lastAt: 0 }; groups.set(dir, g); }
    return g;
  };
  // Pair each live session with its transcript (by session id, else the
  // freshest unclaimed live transcript in the same dir) so a session
  // carries its conversation title and that transcript isn't also
  // listed as history.
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
    // Projects with a live session float up; then most-recent first.
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
  const liveHistory = g.history.filter((c) => c.active); // claude running outside cux
  const past = g.history.filter((c) => !c.active);
  const edge = live ? "var(--ok)" : liveHistory.length ? "var(--ok)" : "var(--line)";

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

      {/* One row per live cux session: which seat, doing what, with its
          own terminal handle. This is the 4-accounts-one-project view. */}
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
              onClick={(e) => { e.stopPropagation(); onOpenTerm(s); }}>⌨</button>
          )}
        </div>
      ))}

      {/* claude running here outside cux (desktop app), if any */}
      {liveHistory.map((c) => (
        <div key={c.id} className="srow tappable" onClick={() => onOpenConv(c)}>
          <span className="dot" style={{ color: "var(--ok)" }}>▎</span>
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="ellip" style={{ fontWeight: 600 }}>{c.title || "(no messages yet)"}</div>
            <div className="sub">not managed by cux · ● live</div>
          </div>
        </div>
      ))}

      {/* history, collapsed behind a toggle so a busy directory doesn't
          bury everything else */}
      {past.length > 0 && (
        <>
          <div className="morebar" onClick={() => setOpen(!open)}>
            {open ? "▾ hide"
              // header already counts them when the project has no live
              // rows, so don't repeat the number there
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

function DeckTab({ deck, convs, onOpenSession, onOpenConv, onOpenTerm, onRefreshUsage }: {
  deck: Deck; convs: Conv[];
  onOpenSession: (s: Session) => void; onOpenConv: (c: Conv) => void;
  onOpenTerm: (s: Session) => void; onRefreshUsage: () => void;
}) {
  const accts = Object.values(deck.accounts || {});
  const active = accts.find((a) => a.slot === deck.activeSlot);
  const groups = groupByProject(deck.sessions || [], convs);
  const activeCount = (deck.sessions || []).length;

  return (
    <>
      <div className="section-label">Projects</div>
      {!groups.length && (
        <div className="card empty"><div className="art">🌙</div><b>All quiet</b>
          No sessions or conversations yet.<br />Start one with <span className="mono">cux</span> on {deck.hostname}.</div>
      )}
      {groups.map((g) => (
        <ProjectCard key={g.dir} g={g}
          onOpenConv={onOpenConv} onOpenSession={onOpenSession} onOpenTerm={onOpenTerm} />
      ))}

      <div className="section-label">This machine</div>
      <div className="card"><div className="row">
        <div className="grow">
          <h3>{deck.hostname}</h3>
          <div className="sub">{activeCount} live session{activeCount === 1 ? "" : "s"} · {accts.length} seat{accts.length === 1 ? "" : "s"} · active: <b>{active ? seatLabel(active) : "—"}</b></div>
        </div>
        <button className="btn ghost small" onClick={onRefreshUsage}>↻ refresh</button>
      </div></div>
    </>
  );
}

function SeatsTab({ deck, onSwitch }: { deck: Deck; onSwitch: (a: Account) => void }) {
  const accts = Object.values(deck.accounts || {}).sort((a, b) => a.slot - b.slot);
  if (!accts.length) return (
    <div className="card empty"><div className="art">🪑</div><b>No seats yet</b>
      Log in and run <span className="mono">cux add</span> on the computer.</div>
  );
  return (
    <>
      <div className="section-label">Seats</div>
      {accts.map((a) => {
        const u = (deck.usage || {})[cacheKey(a)];
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
              {a.slot === deck.activeSlot
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

function ProjectsTab({ deck, onSeats }: { deck: Deck; onSeats: (p: Project) => void }) {
  const ps = Object.values(deck.projects || {}).sort((a, b) => a.name.localeCompare(b.name));
  if (!ps.length) return (
    <div className="card empty"><div className="art">📁</div><b>No projects</b>
      Projects pin a directory to chosen seats.<br />Tap ＋ to create your first.</div>
  );
  return (
    <>
      <div className="section-label">Projects</div>
      {ps.map((p) => (
        <div key={p.name} className="card">
          <div className="row">
            <div className="grow"><h3>{p.name}</h3>
              <div className="sub ellip mono" style={{ fontSize: 11.5 }}>{p.dir}</div></div>
            <button className="btn ghost small" onClick={() => onSeats(p)}>seats</button>
          </div>
          <div style={{ marginTop: 10, display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
            {(p.slots || []).length
              ? p.slots!.map((sl) => {
                const a = (deck.accounts || {})[sl];
                return <span key={sl} className="badge active" style={{ textTransform: "none" }}>{a ? seatLabel(a) : "#" + sl}</span>;
              })
              : <span className="sub">no seats pinned — full pool applies</span>}
          </div>
        </div>
      ))}
    </>
  );
}

function SettingsTab({ deck, toast, setSheet }: {
  deck: Deck; toast: (m: string, ms?: number) => void; setSheet: (n: React.ReactNode | null) => void;
}) {
  const [devs, setDevs] = useState<Device[] | null>(null);
  const load = useCallback(() => { api<Device[]>("/api/devices").then(setDevs).catch(() => {}); }, []);
  useEffect(load, [load]);
  const doRevoke = async (id: string) => {
    setSheet(null);
    try { await api("/api/devices/revoke", { method: "POST", body: JSON.stringify({ id }) }); toast("Device revoked"); load(); }
    catch (e) { toast("Failed: " + (e as Error).message); }
  };
  return (
    <>
      <div className="section-label">Paired devices</div>
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
      <div className="section-label">About</div>
      <div className="card">
        <h3>⌁ cuxdeck <span className="sub">{deck.version}</span></h3>
        <div className="sub" style={{ marginTop: 6 }}>Deck <span className="mono">{deck.deckId}</span> on {deck.hostname} ({deck.os}).
          To watch another machine, install cuxdeck there and scan its QR.</div>
      </div>
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

function SeatSheet({ project, deck, toast, refresh, act, close }: {
  project: Project; deck: Deck; toast: (m: string) => void; refresh: () => void;
  act: (a: string, args: Record<string, string>, note: string) => void; close: () => void;
}) {
  const had = useMemo(() => new Set(project.slots || []), [project]);
  const [want, setWant] = useState(() => new Set(project.slots || []));
  const accts = Object.values(deck.accounts || {}).sort((a, b) => a.slot - b.slot);
  const toggle = (slot: number) => setWant((w) => { const n = new Set(w); n.has(slot) ? n.delete(slot) : n.add(slot); return n; });
  const save = async () => {
    close();
    const adds = [...want].filter((s) => !had.has(s)), dels = [...had].filter((s) => !want.has(s));
    if (!adds.length && !dels.length) { toast("No changes"); return; }
    toast("Saving seats…");
    try {
      for (const s of adds) await api("/api/action", { method: "POST", body: JSON.stringify({ action: "project-assign", args: { name: project.name, seat: String(s) } }) });
      for (const s of dels) await api("/api/action", { method: "POST", body: JSON.stringify({ action: "project-unassign", args: { name: project.name, seat: String(s) } }) });
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
        <button className="btn danger" onClick={() => { close(); if (confirm("Remove project " + project.name + "? Accounts stay.")) act("project-remove", { name: project.name }, "Removing…"); }}>Remove</button>
        <button className="btn" style={{ flex: 1 }} onClick={save}>Save</button>
      </div>
    </>
  );
}

/* ---------- pairing ---------- */

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
      const r = await fetch("/api/pair", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: c, name: deviceName() }),
      });
      if (!r.ok) throw 0;
      setToken((await r.json()).token);
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
