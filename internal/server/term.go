package server

import (
	"context"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"

	"github.com/centrual/cuxdeck/internal/cuxdata"
	"github.com/coder/websocket"
)

// termBridge connects a browser terminal (xterm.js over WebSocket) to a
// cux session's attach socket. The bridge is deliberately dumb: client
// messages are complete protocol frames written to the socket verbatim;
// socket frames are re-framed one per binary message so the client
// never has to reassemble across message boundaries. All policy —
// input gating, size arbitration, redraw — lives in cux's ptyhost.
func (s *Server) termBridge(w http.ResponseWriter, r *http.Request) {
	pid := r.PathValue("pid")
	if !validConvID(pid) { // digits only in practice; same charset guard
		http.Error(w, "bad pid", http.StatusBadRequest)
		return
	}
	sock := filepath.Join(cuxdata.Root(), "runtime", "attach", pid+".sock")
	if _, err := os.Stat(sock); err != nil {
		http.Error(w, `{"error":"session is not attachable (needs a cux build with attach support)"}`, http.StatusNotFound)
		return
	}
	conn, err := net.Dial("unix", sock)
	if err != nil {
		http.Error(w, `{"error":"attach socket refused"}`, http.StatusBadGateway)
		return
	}
	defer conn.Close()

	ws, err := websocket.Accept(w, r, nil)
	if err != nil {
		return
	}
	defer ws.Close(websocket.StatusNormalClosure, "")
	ctx := r.Context()

	go func() { // browser → cux (frames pass through verbatim)
		defer conn.Close()
		for {
			_, data, err := ws.Read(ctx)
			if err != nil {
				return
			}
			if _, err := conn.Write(data); err != nil {
				return
			}
		}
	}()

	// cux → browser, one frame per message
	for {
		typ, payload, err := readAttachFrame(conn)
		if err != nil {
			return
		}
		msg := append([]byte{typ, 0, 0, 0, 0}, payload...)
		putLen(msg[1:5], uint32(len(payload)))
		if err := ws.Write(ctx, websocket.MessageBinary, msg); err != nil {
			return
		}
	}
}

func putLen(b []byte, n uint32) {
	b[0], b[1], b[2], b[3] = byte(n>>24), byte(n>>16), byte(n>>8), byte(n)
}

func readAttachFrame(r io.Reader) (byte, []byte, error) {
	var hdr [5]byte
	if _, err := io.ReadFull(r, hdr[:]); err != nil {
		return 0, nil, err
	}
	n := uint32(hdr[1])<<24 | uint32(hdr[2])<<16 | uint32(hdr[3])<<8 | uint32(hdr[4])
	if n > 1<<20 {
		return 0, nil, io.ErrUnexpectedEOF
	}
	p := make([]byte, n)
	if _, err := io.ReadFull(r, p); err != nil {
		return 0, nil, err
	}
	return hdr[0], p, nil
}

var _ = context.Background
