// Full terminal access to a cux session — xterm.js over the WebSocket
// bridge to the wrapper's PTY socket. Everything a keyboard can do
// works here: typing, Enter, Ctrl+C, arrows. A quick-key bar covers
// what mobile keyboards can't type.

import { useEffect, useRef } from "react";
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

export function Term({ pid, title, onClose }: { pid: number; title: string; onClose: () => void }) {
  const holder = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);

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
    window.addEventListener("resize", onResize);
    document.body.classList.add("chat-open");
    // Focus so the mobile keyboard comes up.
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
      <div className="chead">
        <button className="back" onClick={onClose}>‹</button>
        <div className="grow"><h2>{title}</h2><div className="sub">live terminal — full control</div></div>
      </div>
      <div ref={holder} style={{ flex: 1, minHeight: 0, padding: "6px 4px 0 8px" }} />
      <div className="qkeys">
        {QUICK.map(([label, bytes]) => (
          <button key={label} onClick={() => sendKeys(bytes)}>{label}</button>
        ))}
      </div>
    </div>
  );
}
