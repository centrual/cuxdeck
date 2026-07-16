// Full terminal access to a cux session — xterm.js over the WebSocket
// bridge to the wrapper's PTY socket. Everything a keyboard can do
// works here: typing, Enter, Ctrl+C, arrows. A quick-key bar covers
// what mobile keyboards can't type.

import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { wsURL } from "./api";
import { t } from "./i18n";
import type { Deck } from "./decks";

const FRAME_OUT = 0, FRAME_INPUT = 1, FRAME_RESIZE = 2, FRAME_SIZE = 4;

function frame(type: number, payload: Uint8Array): Uint8Array {
  const f = new Uint8Array(5 + payload.length);
  f[0] = type;
  new DataView(f.buffer).setUint32(1, payload.length);
  f.set(payload, 5);
  return f;
}

const QUICK: Array<[string, string]> = [
  ["esc", "\x1b"], ["tab", "\t"], ["mode", "\x1b[Z"], ["^C", "\x03"], ["^D", "\x04"],
  ["↑", "\x1b[A"], ["↓", "\x1b[B"], ["←", "\x1b[D"], ["→", "\x1b[C"], ["⏎", "\r"],
];
// "mode" sends CSI Z (shift+tab / backtab) — Claude Code's own cycle key
// for auto/plan/manual mode. Same byte sequence a physical keyboard's
// shift+tab produces, so it needs no special handling on the host side.

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
    let timer: ReturnType<typeof setTimeout> | null = null;
    const apply = () => {
      const gap = window.innerHeight - vv.height - vv.offsetTop;
      setH(gap > 60 ? gap : 0); // ignore noise (address bar show/hide, rotation)
    };
    // Debounced: a real keyboard open/close holds its final height for
    // a while, but Chrome's URL-bar hide/show is a multi-frame animation
    // that transiently drags window.innerHeight through the same gap —
    // sampling only once it settles keeps that from flipping the bar on.
    const update = () => { if (timer) clearTimeout(timer); timer = setTimeout(apply, 120); };
    apply();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      if (timer) clearTimeout(timer);
      vv.removeEventListener("resize", update); vv.removeEventListener("scroll", update);
    };
  }, []);
  return h;
}

export function Term({ deck, pid, title, onClose }: { deck: Deck; pid: number; title: string; onClose: () => void }) {
  const holder = useRef<HTMLDivElement>(null);
  const head = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reflowRef = useRef<() => void>(() => {});
  const kbHeight = useKeyboardHeight();
  // manualOpen is the explicit toggle in the header — the bar otherwise
  // only ever appears because the on-screen keyboard opened, which means
  // esc/arrows/mode were unreachable without first tapping into a text
  // input. Either signal shows it; --kb-height stays whatever the real
  // keyboard height is (0 when it's not up), so a manual open with no
  // keyboard docks the bar to the screen's bottom edge, and it still
  // slides up correctly if the keyboard opens afterward.
  const [manualOpen, setManualOpen] = useState(false);
  const barVisible = kbHeight > 0 || manualOpen;

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

    const ws = new WebSocket(wsURL(deck, "/api/session/" + pid + "/term", deck.token));
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;
    const enc = new TextEncoder();

    const sendResize = () => {
      if (ws.readyState !== WebSocket.OPEN || term.cols < 1 || term.rows < 1) return;
      const p = new Uint8Array(4);
      const dv = new DataView(p.buffer);
      dv.setUint16(0, term.rows);
      dv.setUint16(2, term.cols);
      ws.send(frame(FRAME_RESIZE, p));
    };

    // Refit and, only when the grid actually changed, tell the PTY its new
    // size. Claude Code addresses the screen by absolute column, so the
    // PTY width must match what xterm renders exactly — a stale count
    // scrambles the layout (words break, cursor lands in the wrong place).
    let lastCols = 0, lastRows = 0;
    const refit = () => {
      try { fit.fit(); } catch { /* holder not laid out yet */ }
      if (term.cols !== lastCols || term.rows !== lastRows) {
        lastCols = term.cols;
        lastRows = term.rows;
        sendResize();
      }
    };
    // Fitting synchronously at open can measure a stale monospace cell and
    // over-count columns. Fit once the container is laid out (next frame)
    // and again once font metrics are final, then keep it correct with a
    // ResizeObserver — that also covers the on-screen keyboard and rotation.
    requestAnimationFrame(refit);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(refit).catch(() => {});
    const ro = new ResizeObserver(() => refit());
    ro.observe(holder.current!);

    ws.onopen = () => { refit(); sendResize(); };
    ws.onmessage = (e) => {
      const d = new Uint8Array(e.data as ArrayBuffer);
      if (d.length < 5) return;
      const payload = d.subarray(5);
      if (d[0] === FRAME_OUT) {
        term.write(payload);
      } else if (d[0] === FRAME_SIZE && payload.length >= 4) {
        // The host's shared PTY may have negotiated down to a size smaller
        // than what we asked for (another attached client is narrower —
        // the tmux rule). Without this, our own grid stays at our stale
        // guess while the stream arriving is already formatted for the
        // real, smaller size — wrapped lines land at the wrong columns
        // and scrollback ends up a jumble of both grids. Snap to what the
        // host actually settled on; record it as our own last-known size
        // too, so the next real refit() doesn't mistake this for a change
        // it needs to report back.
        const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
        const rows = dv.getUint16(0), cols = dv.getUint16(2);
        if (rows > 0 && cols > 0 && (rows !== term.rows || cols !== term.cols)) {
          term.resize(cols, rows);
          lastCols = cols;
          lastRows = rows;
        }
      }
    };
    ws.onclose = () => term.write("\r\n\x1b[33m" + t("[cuxdeck] connection closed") + "\x1b[0m\r\n");

    term.onData((s: string) => { if (ws.readyState === WebSocket.OPEN) ws.send(frame(FRAME_INPUT, enc.encode(s))); });

    // Mobile touch scrolling: xterm doesn't turn a finger swipe into
    // scrolling on its own. Translate a vertical swipe into scrollback in
    // the normal buffer, or into mouse-wheel escapes in the alternate
    // buffer (a full-screen TUI like Claude Code, which scrolls on wheel).
    const el = holder.current!;
    let lastY = 0, accum = 0;
    const cellH = () => {
      const h = (term as unknown as { _core?: { _renderService?: { dimensions?: { css?: { cell?: { height?: number } } } } } })
        ._core?._renderService?.dimensions?.css?.cell?.height;
      return h && h > 4 ? h : 17;
    };
    const cellW = () => {
      const w = (term as unknown as { _core?: { _renderService?: { dimensions?: { css?: { cell?: { width?: number } } } } } })
        ._core?._renderService?.dimensions?.css?.cell?.width;
      return w && w > 2 ? w : 8;
    };
    const onTouchStart = (e: TouchEvent) => { lastY = e.touches[0].clientY; accum = 0; };
    const onTouchMove = (e: TouchEvent) => {
      const touch = e.touches[0];
      const y = touch.clientY;
      accum += lastY - y;
      lastY = y;
      const lines = Math.trunc(accum / cellH());
      if (lines === 0) return;
      accum -= lines * cellH();
      if (term.buffer.active.type === "alternate") {
        // SGR wheel: button 64 = up, 65 = down. Cap the burst so a fast
        // flick can't fire a hundred escapes at once. A real mouse wheel
        // always carries the pointer's position, and a full-screen TUI
        // can (and Claude Code does) route wheel input only to whatever
        // scrollable region sits under that position — a wheel event
        // that always claims row 1, col 1 lands outside it and gets
        // silently dropped, which is exactly "scroll works with a real
        // mouse on the PC, does nothing from the phone." Convert the
        // actual touch point to a cell coordinate instead of hardcoding
        // the corner.
        const rect = el.getBoundingClientRect();
        const col = Math.max(1, Math.round((touch.clientX - rect.left) / cellW()) + 1);
        const row = Math.max(1, Math.round((touch.clientY - rect.top) / cellH()) + 1);
        const btn = lines > 0 ? 65 : 64;
        const seq = `\x1b[<${btn};${col};${row}M`.repeat(Math.min(Math.abs(lines), 6));
        if (ws.readyState === WebSocket.OPEN) ws.send(frame(FRAME_INPUT, enc.encode(seq)));
      } else {
        term.scrollLines(lines);
      }
      e.preventDefault();
    };
    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: false });

    const onResize = () => { refit(); };
    reflowRef.current = onResize;
    window.addEventListener("resize", onResize);
    document.body.classList.add("chat-open");
    // Focus so the mobile on-screen keyboard comes up; on a physical
    // keyboard this is a no-op as far as the bar is concerned — it
    // only reacts to visualViewport actually shrinking.
    setTimeout(() => term.focus(), 300);

    return () => {
      ro.disconnect();
      window.removeEventListener("resize", onResize);
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      document.body.classList.remove("chat-open");
      ws.close();
      term.dispose();
    };
  }, [deck.url, pid]);

  const sendKeys = (bytes: string) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(frame(FRAME_INPUT, new TextEncoder().encode(bytes)));
  };

  return (
    <div id="chat" className="show" style={{ background: "#0c0a09" }}>
      <div className="chead" ref={head}>
        <button className="back" onClick={onClose}>‹</button>
        <div className="grow"><h2>{title}</h2><div className="sub">{t("live terminal — full control")}</div></div>
        <button className={"kbtoggle" + (manualOpen ? " on" : "")} onClick={() => setManualOpen((o) => !o)}
          aria-label={t("terminal controls")}>
          <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor"
            strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="6" width="18" height="12" rx="2" />
            <path d="M7 10h.01M11 10h.01M15 10h.01M17 10h.01M7 14h6M15 14h2" />
          </svg>
        </button>
      </div>
      <div ref={holder} style={{ flex: 1, minHeight: 0, padding: "6px 4px 0 8px", touchAction: "none" }} />
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
