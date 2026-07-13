// Full terminal access to a cux session — xterm.js over the WebSocket
// bridge to the wrapper's PTY socket. Everything a keyboard can do
// works here: typing, Enter, Ctrl+C, arrows. A quick-key bar covers
// what mobile keyboards can't type.

import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { TOK } from "./api";

const FRAME_OUT = 0, FRAME_INPUT = 1, FRAME_RESIZE = 2;

function frame(type: number, payload: Uint8Array): Uint8Array {
  const f = new Uint8Array(5 + payload.length);
  f[0] = type;
  new DataView(f.buffer).setUint32(1, payload.length);
  f.set(payload, 5);
  return f;
}

const QUICK: Array<[string, string]> = [
  ["esc", "\x1b"], ["tab", "\t"], ["^C", "\x03"], ["^D", "\x04"],
  ["↑", "\x1b[A"], ["↓", "\x1b[B"], ["←", "\x1b[D"], ["→", "\x1b[C"], ["⏎", "\r"],
];

const BAR_H = 44; // .qkeys height when visible (padding + button height)

/* Tracks the on-screen keyboard via visualViewport: how far the
   layout viewport's bottom edge sits above the visible one is the
   keyboard height. iOS Safari keeps `position:fixed` pinned to the
   layout viewport, so callers use this to lift the quick-key bar
   above the keyboard instead of letting it hide underneath. */
function useKeyboardHeight(): number {
  const [h, setH] = useState(0);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => {
      const gap = window.innerHeight - vv.height - vv.offsetTop;
      setH(gap > 60 ? gap : 0); // ignore noise (address bar show/hide, rotation)
    };
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => { vv.removeEventListener("resize", update); vv.removeEventListener("scroll", update); };
  }, []);
  return h;
}

export function Term({ pid, title, onClose }: { pid: number; title: string; onClose: () => void }) {
  const holder = useRef<HTMLDivElement>(null);
  const head = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reflowRef = useRef<() => void>(() => {});
  const kbHeight = useKeyboardHeight();
  // The bar only earns its keep for what an on-screen keyboard can't
  // type — a physical keyboard (desktop, or a phone with one attached)
  // never opens visualViewport's keyboard gap, so the bar stays gone.
  const barVisible = kbHeight > 0;

  // Keep the terminal sized to what's actually visible: full flex
  // height while the keyboard is closed, or (visualViewport − header
  // − bar) once it opens, so the last lines never end up hidden
  // behind the keyboard or the bar sitting above it.
  useEffect(() => {
    if (!holder.current) return;
    if (!barVisible) {
      holder.current.style.flex = "1";
      holder.current.style.height = "";
    } else {
      // visualViewport.height already excludes the open keyboard —
      // it's the truly visible area, so only the header and the bar
      // itself need to be carved out of it.
      const vh = window.visualViewport?.height ?? window.innerHeight;
      const headH = head.current?.offsetHeight ?? 60;
      holder.current.style.flex = "0 0 auto";
      holder.current.style.height = Math.max(80, vh - headH - BAR_H) + "px";
    }
    reflowRef.current();
  }, [barVisible]);

  useEffect(() => {
    const term = new Terminal({
      fontSize: 12,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      theme: { background: "#0c0a09", foreground: "#f2ece1", cursor: "#f0662f" },
      cursorBlink: true,
      scrollback: 4000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(holder.current!);
    fit.fit();

    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(proto + "//" + location.host + "/api/session/" + pid + "/term?token=" + encodeURIComponent(TOK));
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;
    const enc = new TextEncoder();

    const sendResize = () => {
      if (ws.readyState !== WebSocket.OPEN) return;
      const p = new Uint8Array(4);
      const dv = new DataView(p.buffer);
      dv.setUint16(0, term.rows);
      dv.setUint16(2, term.cols);
      ws.send(frame(FRAME_RESIZE, p));
    };

    ws.onopen = sendResize;
    ws.onmessage = (e) => {
      const d = new Uint8Array(e.data as ArrayBuffer);
      if (d.length >= 5 && d[0] === FRAME_OUT) term.write(d.subarray(5));
    };
    ws.onclose = () => term.write("\r\n\x1b[33m[cuxdeck] bağlantı kapandı\x1b[0m\r\n");

    term.onData((s: string) => { if (ws.readyState === WebSocket.OPEN) ws.send(frame(FRAME_INPUT, enc.encode(s))); });

    const onResize = () => { fit.fit(); sendResize(); };
    reflowRef.current = onResize;
    window.addEventListener("resize", onResize);
    document.body.classList.add("chat-open");
    // Focus so the mobile on-screen keyboard comes up; on a physical
    // keyboard this is a no-op as far as the bar is concerned — it
    // only reacts to visualViewport actually shrinking.
    setTimeout(() => term.focus(), 300);

    return () => {
      window.removeEventListener("resize", onResize);
      document.body.classList.remove("chat-open");
      ws.close();
      term.dispose();
    };
  }, [pid]);

  const sendKeys = (bytes: string) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(frame(FRAME_INPUT, new TextEncoder().encode(bytes)));
  };

  return (
    <div id="chat" className="show" style={{ background: "#0c0a09" }}>
      <div className="chead" ref={head}>
        <button className="back" onClick={onClose}>‹</button>
        <div className="grow"><h2>{title}</h2><div className="sub">live terminal — full control</div></div>
      </div>
      <div ref={holder} style={{ flex: 1, minHeight: 0, padding: "6px 4px 0 8px" }} />
      {/* Input-accessory-style bar: invisible until an on-screen
          keyboard actually opens (visualViewport shrinks), then
          docked right above it. A physical keyboard never triggers
          that shrink, so the bar never appears for it. mousedown is
          preventDefault'd so tapping a key never steals focus (and
          closes the keyboard) away from the terminal. */}
      <div className={"qkeys" + (barVisible ? " show" : "")}
        style={{ "--kb-height": kbHeight + "px" } as React.CSSProperties}>
        {QUICK.map(([label, bytes]) => (
          <button key={label} onMouseDown={(e) => e.preventDefault()} onClick={() => sendKeys(bytes)}>{label}</button>
        ))}
      </div>
    </div>
  );
}
