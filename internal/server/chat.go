package server

import (
	"bufio"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/centrual/cuxdeck/internal/chat"
	"github.com/centrual/cuxdeck/internal/cuxdata"
)

// chatStream serves one session's conversation as Server-Sent Events:
// the full backlog first, then new lines as Claude Code appends them.
// Read-only — cuxdeck never writes to the transcript.
//
// The session is identified by its wrapper PID (from the heartbeat
// registry), which gives us the working directory and session id, and
// from those the transcript path Claude Code uses.
func (s *Server) chatStream(w http.ResponseWriter, r *http.Request) {
	pid := r.PathValue("pid")
	path := transcriptForPID(pid)
	if path == "" {
		http.Error(w, `{"error":"no transcript for that session yet"}`, http.StatusNotFound)
		return
	}
	streamTranscript(w, r, path)
}

// conversations lists recent transcripts across all projects, discovered
// straight from disk — visible even when a session was started outside
// cux and so never touched the registry.
func (s *Server) conversations(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(cuxdata.LoadConversations(15))
}

// conversationChat streams one conversation by transcript id.
func (s *Server) conversationChat(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !validConvID(id) {
		http.Error(w, `{"error":"bad conversation id"}`, http.StatusBadRequest)
		return
	}
	path := cuxdata.FindTranscript(id)
	if path == "" {
		http.Error(w, `{"error":"no such conversation"}`, http.StatusNotFound)
		return
	}
	streamTranscript(w, r, path)
}

// validConvID keeps the id strictly to session-uuid characters so it can
// never traverse outside the projects directory.
func validConvID(id string) bool {
	if id == "" || len(id) > 64 {
		return false
	}
	for _, c := range id {
		ok := c == '-' || (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')
		if !ok {
			return false
		}
	}
	return true
}

// streamTranscript is the shared SSE body: full backlog, a caught-up
// marker, then a 700ms tail while the client stays connected.
func streamTranscript(w http.ResponseWriter, r *http.Request, path string) {
	fl, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")

	send := func(ev chat.Event) {
		b, _ := json.Marshal(ev)
		fmt.Fprintf(w, "data: %s\n\n", b)
	}

	f, err := os.Open(path)
	if err != nil {
		http.Error(w, `{"error":"transcript unavailable"}`, http.StatusNotFound)
		return
	}
	defer f.Close()

	reader := bufio.NewReaderSize(f, 1<<20)
	ctx := r.Context()
	// Larger scan buffer: transcript lines (with tool output) can be big.
	emitPending := func() {
		for {
			line, err := reader.ReadBytes('\n')
			if len(line) > 0 && line[len(line)-1] == '\n' {
				for _, ev := range chat.Parse(line) {
					send(ev)
				}
			} else {
				// Partial line (writer mid-append): rewind so we re-read
				// it whole on the next tick.
				if len(line) > 0 {
					_, _ = f.Seek(-int64(len(line)), 1)
					reader.Reset(f)
				}
				return
			}
			if err != nil {
				return
			}
		}
	}

	emitPending() // backlog
	fl.Flush()
	send(chat.Event{Role: "system", Kind: "caught-up"})
	fl.Flush()

	// Tail: poll for growth. SSE keeps the response open; the client
	// closing the tab cancels ctx and ends the goroutine.
	ticker := time.NewTicker(700 * time.Millisecond)
	defer ticker.Stop()
	keepalive := time.NewTicker(20 * time.Second)
	defer keepalive.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			emitPending()
			fl.Flush()
		case <-keepalive.C:
			fmt.Fprint(w, ": ping\n\n") // comment frame keeps proxies from closing
			fl.Flush()
		}
	}
}

// transcriptForPID resolves a wrapper PID to its transcript file via
// the registry (cwd + session id), matching Claude Code's path
// encoding (cwd with separators turned to '-'). Falls back to the
// newest transcript in the project dir when the session id is not yet
// known (a brand-new session before its first Stop).
func transcriptForPID(pid string) string {
	var cwd, sid string
	for _, sess := range cuxdata.LoadSessions() {
		if itoa(sess.PID) == pid {
			cwd, sid = sess.CWD, sess.SessionID
			break
		}
	}
	if cwd == "" {
		return ""
	}
	dir := filepath.Join(cuxdata.ClaudeProjectsDir(), encodeCwd(cwd))
	if sid != "" {
		p := filepath.Join(dir, sid+".jsonl")
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}
	return newestJSONL(dir)
}

func encodeCwd(cwd string) string {
	enc := strings.ReplaceAll(cwd, string(filepath.Separator), "-")
	if !strings.HasPrefix(enc, "-") {
		enc = "-" + enc
	}
	return enc
}

func newestJSONL(dir string) string {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return ""
	}
	var best string
	var bestMod time.Time
	for _, e := range entries {
		if e.IsDir() || filepath.Ext(e.Name()) != ".jsonl" {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		if best == "" || info.ModTime().After(bestMod) {
			best, bestMod = filepath.Join(dir, e.Name()), info.ModTime()
		}
	}
	return best
}
