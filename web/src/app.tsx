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

function DeckTab({ deck, convs, onOpenSession, onOpenConv, onOpenTerm, onRefreshUsage }: {
  deck: Deck; convs: Conv[];
  onOpenSession: (s: Session) => void; onOpenConv: (c: Conv) => void;
  onOpenTerm: (s: Session) => void; onRefreshUsage: () => void;
}) {
  const accts = Object.values(deck.accounts || {});
  const active = accts.find((a) => a.slot === deck.activeSlot);
  const stateColor: Record<string, string> = {
    running: "var(--ok)", "waiting-reset": "var(--warn)", retrying: "var(--bad)", swapping: "var(--info)",
  };

  // A running cux session and its transcript are one thing, not two:
  // pair each session with its conversation (by session id when the
  // registry has it, else the freshest unclaimed live transcript in
  // the same directory). The session card then carries the
  // conversation's title, and the paired transcript disappears from
  // the list below — no more seeing yourself twice.
  const claimed = new Set<string>();
  const convFor = (s: Session): Conv | undefined => {
    let c = s.sessionId ? convs.find((x) => x.id === s.sessionId) : undefined;
    c = c || convs.find((x) => x.active && !claimed.has(x.id) && x.cwd === s.cwd);
    if (c) claimed.add(c.id);
    return c;
  };
  const paired = (deck.sessions || []).map((s) => ({ s, conv: convFor(s) }));
  const restConvs = convs.filter((c) => !claimed.has(c.id));

  return (
    <>
      <div className="section-label">Live sessions</div>
      {!deck.sessions?.length && (
        <div className="card empty"><div className="art">🌙</div><b>All quiet</b>
          No cux sessions right now.<br />Start one with <span className="mono">cux</span> on {deck.hostname}.</div>
      )}
      {paired.map(({ s, conv }) => (
        <div key={s.pid} className="card tappable" style={{ borderLeft: "3px solid " + (stateColor[s.state] || "var(--dim)") }}
          onClick={() => (conv ? onOpenConv(conv) : onOpenSession(s))}>
          <div className="row">
            <div className="grow">
              <h3 className="ellip">{conv?.title || shortDir(s.cwd)}</h3>
              <div className="sub ellip">{shortDir(s.cwd)} · seat <b>{s.seat ? s.seat.split("@")[0] : "—"}</b> · up {ago(s.startedAt)}</div>
            </div>
            <span className={"badge " + s.state}>{s.state.replace("-", " ")}</span>
          </div>
          {s.detail && <div className="sub" style={{ marginTop: 8, paddingTop: 8, borderTop: "1px solid var(--line)" }}>↻ {s.detail}</div>}
          <div className="row" style={{ marginTop: 8, gap: 14 }}>
            <span className="sub" style={{ color: "var(--acc)", fontWeight: 700 }}>conversation ›</span>
            {s.attachable && (
              <span className="sub" style={{ color: "var(--ok)", fontWeight: 700 }}
                onClick={(e) => { e.stopPropagation(); onOpenTerm(s); }}>⌨ terminal ›</span>
            )}
          </div>
        </div>
      ))}

      {/* whatever a live session didn't claim: history, plus any claude
          running outside cux (desktop app tabs) whose transcript is
          still being written — those keep their ● live dot here. */}
      <div className="section-label">Other conversations</div>
      {!restConvs.length && (
        <div className="card empty"><div className="art">💬</div><b>No conversations yet</b>
          Claude Code transcripts on this machine appear here.</div>
      )}
      {restConvs.map((c) => (
        <div key={c.id} className="card tappable" style={{ borderLeft: "3px solid " + (c.active ? "var(--ok)" : "var(--line)") }}
          onClick={() => onOpenConv(c)}>
          <div className="row"><div className="grow">
            <h3 className="ellip">{c.title || "(no messages yet)"}</h3>
            <div className="sub ellip">{shortDir(c.cwd || "?")} · {c.active
              ? <span style={{ color: "var(--ok)", fontWeight: 700 }}>● live</span>
              : ago(c.updatedAt) + " ago"}</div>
          </div></div>
        </div>
      ))}

      <div className="section-label">This machine</div>
      <div className="card"><div className="row">
        <div className="grow">
          <h3>{deck.hostname}</h3>
          <div className="sub">{accts.length} seat{accts.length === 1 ? "" : "s"} · active: <b>{active ? seatLabel(active) : "—"}</b> · {deck.os}</div>
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
