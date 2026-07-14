// The conversation view — a faithful rendering of Claude Code's own
// terminal transcript: "❯" user bars, flowing assistant markdown,
// "⏺ Tool(arg)" calls with "⎿ result" lines paired by tool_use id,
// "✳ Worked for …" turn boundaries and the live status line at the
// bottom. Fed by the server's SSE stream (backlog → caught-up → tail).

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { sseURL } from "./api";
import type { Deck } from "./decks";
import { t } from "./i18n";
import { firstln, fmtDur, fmtTok, md } from "./util";

type Ev = {
  role: string; kind?: string; text?: string; tool?: string;
  detail?: string; full?: string; id?: string; ts?: string; tokens?: number;
};

type ResPart = { sum: string; more?: string; full?: string; err?: boolean };
type Item =
  | { k: "user"; key: number; text: string; chip: "" | "queued" | "mid" }
  | { k: "assist"; key: number; html: string }
  | { k: "think"; key: number; text: string }
  | { k: "image"; key: number; user: boolean }
  | { k: "tool"; key: number; name: string; arg: string; full?: string; res?: ResPart }
  | { k: "ask"; key: number; head: string; q: string; opts?: string }
  | { k: "answer"; key: number; text: string }
  | { k: "divider"; key: number; kind: "command" | "interrupt" | "plain" | "worked"; text: string }
  | { k: "res"; key: number; res: ResPart }; // result whose call is unknown

type Task = { id: string; subject: string; status: string };

// Mutable stream state, kept in a ref and flushed to React in batches —
// a 10MB backlog arrives as thousands of events, and one setState per
// event would crawl.
type Stream = {
  items: Item[];
  nextKey: number;
  toolIdx: Map<string, number>;
  queued: Map<string, { idx: number; st: "pending" | "removed" | "done" }>;
  tasks: Map<string, Task>;
  todos: Task[] | null;
  snap: boolean;
  caughtUp: boolean;
  lastTs: number; turnStart: number; lastAssistTs: number; turnTokens: number;
  last: Ev | null;
  dirty: boolean;
};

function newStream(): Stream {
  return {
    items: [], nextKey: 1, toolIdx: new Map(), queued: new Map(),
    tasks: new Map(), todos: null, snap: false, caughtUp: false,
    lastTs: 0, turnStart: 0, lastAssistTs: 0, turnTokens: 0, last: null, dirty: true,
  };
}

function push(st: Stream, item: Omit<Item, "key">) {
  (item as Item).key = st.nextKey++;
  st.items.push(item as Item);
}

/* A queued message's delivery echoes back as a mid-turn reminder, a
   next-turn prompt, or a slash command. First echo after queueing is the
   same message coming around (dedup); later identical texts are the user
   genuinely repeating themselves. */
function markDelivered(st: Stream, text: string): boolean {
  const e = st.queued.get(text);
  if (!e) return false;
  if (e.st === "done") { st.queued.delete(text); return false; }
  const it = st.items[e.idx];
  if (it && it.k === "user") st.items[e.idx] = { ...it, chip: "mid" };
  e.st = "done";
  return true;
}

function applyTaskEvent(st: Stream, ev: Ev) {
  if (ev.kind === "snapshot") {
    // Authoritative on-disk state — other sessions (even other seats)
    // update it, so it replaces anything transcript-derived, including
    // with emptiness when the list was cleaned up.
    st.snap = true;
    st.tasks = new Map();
    try { (JSON.parse(ev.text || "[]") as Task[]).forEach((tb) => st.tasks.set(tb.id, tb)); } catch {}
  } else if (ev.kind === "todos") {
    try {
      st.todos = (JSON.parse(ev.text || "[]") as any[]).map((tb, i) => ({ id: String(i + 1), subject: tb.content, status: tb.status }));
    } catch {}
  } else if (st.snap) {
    return; // transcript replay can't override the store
  } else if (ev.kind === "task-create") {
    st.tasks.set(ev.tool || "", { id: ev.tool || "", subject: ev.text || "", status: "pending" });
  } else if (ev.kind === "task-update") {
    const tb = st.tasks.get(ev.tool || "") || { id: ev.tool || "", subject: ev.detail || "task #" + ev.tool, status: "pending" };
    if (ev.text) tb.status = ev.text;
    if (ev.detail) tb.subject = ev.detail;
    st.tasks.set(ev.tool || "", tb);
  }
}

function applyEvent(st: Stream, ev: Ev) {
  st.dirty = true;
  if (ev.role === "system" && ev.kind === "caught-up") { st.caughtUp = true; return; }
  if (ev.role === "system" && ev.kind === "queue-remove") {
    const e = st.queued.get(ev.text || "");
    if (e && e.st === "pending") {
      const it = st.items[e.idx];
      if (it && it.k === "user") st.items[e.idx] = { ...it, chip: "mid" };
      e.st = "removed";
    }
    return;
  }
  if (ev.role === "task") { applyTaskEvent(st, ev); return; }

  const ts = ev.ts ? Date.parse(ev.ts) || 0 : 0;

  if (ev.role === "user" && ev.kind === "text") {
    if (ev.detail !== "queued" && markDelivered(st, ev.text || "")) { /* deduped */ }
    else {
      // close the previous turn the way the CLI does
      if (!ev.detail && st.turnStart && st.lastAssistTs > st.turnStart) {
        push(st, { k: "divider", kind: "worked", text: t("✳ Worked for ") + fmtDur(st.lastAssistTs - st.turnStart) } as any);
      }
      const chip = ev.detail === "queued" ? "queued" : ev.detail === "sent mid-turn" ? "mid" : "";
      push(st, { k: "user", text: ev.text || "", chip } as any);
      if (chip === "queued") st.queued.set(ev.text || "", { idx: st.items.length - 1, st: "pending" });
    }
    if (ts) st.lastTs = ts;
    st.last = ev;
    if (!ev.detail) { st.turnStart = ts || st.lastTs; st.turnTokens = 0; }
    return;
  }

  switch (ev.role) {
    case "assistant":
      if (ev.kind === "thinking") push(st, { k: "think", text: ev.text || "" } as any);
      else if (ev.kind === "image") push(st, { k: "image", user: false } as any);
      else push(st, { k: "assist", html: md(ev.text || "") } as any);
      break;
    case "user": // image blocks
      if (ev.kind === "image") push(st, { k: "image", user: true } as any);
      break;
    case "tool": {
      const name = (ev.text || "").replace(/^\S+\s/, "");
      push(st, { k: "tool", name, arg: ev.detail ? "(" + ev.detail + ")" : "", full: ev.full } as any);
      if (ev.id) st.toolIdx.set(ev.id, st.items.length - 1);
      break;
    }
    case "result": {
      const res: ResPart = { sum: ev.text || "", more: ev.detail, full: ev.full, err: ev.kind === "error" || ev.kind === "denied" };
      const idx = ev.id ? st.toolIdx.get(ev.id) : undefined;
      const target = idx != null ? st.items[idx] : undefined;
      if (target && target.k === "tool") st.items[idx!] = { ...target, res };
      else push(st, { k: "res", res } as any);
      break;
    }
    case "ask":
      if (ev.kind === "question") push(st, { k: "ask", head: ev.tool || t("question"), q: ev.text || "", opts: ev.detail } as any);
      else push(st, { k: "answer", text: ev.text || "" } as any);
      break;
    case "divider":
      if (ev.kind === "command") { markDelivered(st, ev.text || ""); push(st, { k: "divider", kind: "command", text: ev.text || "" } as any); }
      else if (ev.kind === "interrupt") push(st, { k: "divider", kind: "interrupt", text: t("Interrupted · user sent a new instruction") } as any);
      else push(st, { k: "divider", kind: "plain", text: ev.detail || ev.text || "" } as any);
      break;
  }
  if (ts) st.lastTs = ts;
  st.last = ev;
  if (ev.role === "assistant" || ev.role === "tool" || ev.role === "result") st.lastAssistTs = ts || st.lastTs;
  if (ev.tokens) st.turnTokens += ev.tokens;
}

/* ---------- row components ---------- */

function Expandable({ full, children, className }: { full?: string; children: React.ReactNode; className: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={className + (full ? " has-full" : "")} onClick={full ? () => setOpen(!open) : undefined}>
      {children}
      {full && open && <div className="tfull" style={{ display: "block" }} onClick={(e) => e.stopPropagation()}>{full}</div>}
    </div>
  );
}

function Row({ it }: { it: Item }) {
  const [open, setOpen] = useState(false);
  switch (it.k) {
    case "user":
      return (
        <div className="uline"><span className="pfx">❯</span>
          <span style={{ minWidth: 0 }}>{it.text}
            {it.chip && <span className="chip">{it.chip === "queued" ? t("⏳ queued — waiting for Claude") : t("⏱ sent mid-turn")}</span>}
          </span>
        </div>
      );
    case "assist":
      return <div className="aline" dangerouslySetInnerHTML={{ __html: it.html }} />;
    case "think":
      return (
        <div className={"think" + (open ? " open" : "")} onClick={() => setOpen(!open)}>
          <span className="tprev">{t("✻ Thinking… ")}{firstln(it.text)}</span>
          <span className="tbody">✻ {it.text}</span>
        </div>
      );
    case "image":
      return it.user
        ? <div className="uline"><span className="pfx">❯</span><span>{t("[Image]")}</span></div>
        : <div className="aline">{t("[Image]")}</div>;
    case "tool":
      return (
        <div className={"tline" + (it.res ? "" : " pending")}>
          <Expandable full={it.full} className="trowwrap">
            <div className="trow" style={{ cursor: it.full ? "pointer" : undefined }}>
              <span className="dot" style={it.res?.err ? { color: "var(--bad)" } : undefined}>⏺</span>
              <span className="tname">{it.name}</span>
              <span className="targ">{it.arg}</span>
            </div>
          </Expandable>
          {it.res && <ResRow res={it.res} />}
        </div>
      );
    case "res":
      return <ResRow res={it.res} />;
    case "ask":
      return (
        <div className="cask">
          <div className="qhead">{it.head}</div>
          <span dangerouslySetInnerHTML={{ __html: md(it.q) }} />
          {it.opts && <div className="qopts">◦ {it.opts}</div>}
        </div>
      );
    case "answer":
      return <div className="cask answer"><div className="qhead">{t("answered")}</div>{it.text}</div>;
    case "divider":
      if (it.kind === "command") return <div className="cdiv command"><span style={{ color: "var(--faint)" }}>❯</span> {it.text}</div>;
      if (it.kind === "worked") return <div className="worked">{it.text}</div>;
      if (it.kind === "interrupt") return <div className="cdiv">⎿ {it.text}</div>;
      return <div className="cdiv">⏵ {it.text}</div>;
  }
}

function ResRow({ res }: { res: ResPart }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <div className={"tres" + (res.err ? " err" : "") + (res.full ? " has-full" : "")}
        onClick={res.full ? () => setOpen(!open) : undefined}>
        <span className="elb">⎿</span>
        <span className="rsum">{res.sum}</span>
        {res.more && <span className="more">{res.more}</span>}
      </div>
      {res.full && open && <div className="tfull" style={{ display: "block" }}>{res.full}</div>}
    </>
  );
}

function TasksBar({ tasks, todos, snap }: { tasks: Task[]; todos: Task[] | null; snap: boolean }) {
  const [open, setOpen] = useState(false);
  let items = tasks;
  if (!items.length && !snap && todos) items = todos;
  if (!items.length) return null;
  const done = items.filter((tb) => tb.status === "completed").length;
  const mark = (s: string) => (s === "completed" ? "✓" : s === "in_progress" ? "◐" : "○");
  return (
    <div id="ctasks" className={"show" + (open ? " open" : "")} onClick={() => setOpen(!open)}>
      <div className="thead"><span>{t("☑ Tasks")}</span><span className="prog">{done}/{items.length} {t("done")}</span>
        <span className="prog" style={{ marginLeft: "auto" }}>▾</span></div>
      <div className="tlist">
        {items.map((tb) => (
          <div key={tb.id} className={"titem " + (tb.status || "pending")}>
            <span className="mark">{mark(tb.status)}</span><span>{tb.subject}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* CLI-style status: "✳ Running Bash… (42s · turn 10m · ↓ 38k tokens)" */
function statusLine(st: Stream, now: number): { line: string; busy: boolean } {
  if (!st.last || !st.lastTs) return { line: t("live"), busy: false };
  const idle = now - st.lastTs;
  const turn = st.turnStart ? fmtDur(now - st.turnStart) : "";
  const tok = st.turnTokens ? " · ↓ " + fmtTok(st.turnTokens) + t(" tokens") : "";
  if (idle > 150000) return { line: t("Idle · last activity ") + fmtDur(idle) + t(" ago"), busy: false };
  if (st.last.role === "tool" || st.last.role === "result") {
    const name = ((st.last.role === "tool" ? st.last.tool : st.last.text) || "tool").split("__").pop();
    const head = st.last.role === "tool" ? t("Running ") + name + "… (" + fmtDur(idle) : t("Working… (") + fmtDur(idle);
    return { line: head + (turn ? t(" · turn ") + turn : "") + tok + ")", busy: true };
  }
  if (st.last.role === "user") return { line: t("Thinking… (") + fmtDur(idle) + tok + ")", busy: true };
  return { line: t("Working… (") + (turn || fmtDur(idle)) + tok + ")", busy: true };
}

export function Chat({ deck, path, title, sub, onClose }: {
  deck: Deck; path: string; title: string; sub: string; onClose: () => void;
}) {
  const streamRef = useRef<Stream>(newStream());
  const [, setTick] = useState(0); // flush counter — the stream ref holds the data
  const [now, setNow] = useState(Date.now());
  const logRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);

  useEffect(() => {
    streamRef.current = newStream();
    const es = new EventSource(sseURL(deck, path));
    let got = false;
    // A reconnect replays the whole transcript; start the render over so
    // nothing shows up twice.
    es.onopen = () => { if (got) { streamRef.current = newStream(); got = false; } };
    es.onmessage = (e) => {
      got = true;
      try { applyEvent(streamRef.current, JSON.parse(e.data)); } catch {}
    };
    const flush = setInterval(() => {
      if (streamRef.current.dirty) { streamRef.current.dirty = false; setTick((tb) => tb + 1); }
    }, 120);
    const clock = setInterval(() => setNow(Date.now()), 1000);
    // Lock the page behind the overlay so inner and outer scrolling
    // never fight — restored (with scroll position) on close.
    const scrollY = window.scrollY;
    document.body.classList.add("chat-open");
    return () => {
      es.close(); clearInterval(flush); clearInterval(clock);
      document.body.classList.remove("chat-open");
      window.scrollTo(0, scrollY);
    };
  }, [deck.url, path]);

  useLayoutEffect(() => {
    const log = logRef.current;
    if (log && atBottom.current) log.scrollTop = log.scrollHeight;
  });

  const st = streamRef.current;
  const { line, busy } = useMemo(() => statusLine(st, now), [st.items.length, st.caughtUp, now]);
  const pending = [...st.queued.values()].filter((e) => e.st === "pending").length;
  const qsuf = pending ? " · ⏳ " + pending + t(" queued") : "";
  const subLine = !st.caughtUp ? t("loading history…") : (sub ? sub + " · " : "") + (busy ? "✳ " : "") + line + qsuf;

  return (
    <div id="chat" className="show">
      <div className="chead">
        <button className="back" onClick={onClose}>‹</button>
        <div className="grow"><h2>{title}</h2><div className="sub">{subLine}</div></div>
      </div>
      <TasksBar tasks={[...st.tasks.values()]} todos={st.todos} snap={st.snap} />
      <div id="clog" ref={logRef}
        onScroll={() => { const l = logRef.current!; atBottom.current = l.scrollHeight - l.scrollTop - l.clientHeight < 80; }}>
        <div className="readonly">{t("👁 read-only — sending comes next")}</div>
        {st.items.map((it) => <Row key={it.key} it={it} />)}
        {st.caughtUp && (
          <div className="cstat">
            {busy ? <><span className="spin">✳</span> {line}<span className="sdetail">{t(" · live")}</span></>
              : <><span className="pulse"></span><span className="sdetail">{t("live — watching for new messages")}</span></>}
          </div>
        )}
      </div>
    </div>
  );
}
