// Package server is cuxdeck's HTTP surface: the embedded mobile panel,
// the deck snapshot API, and the allowlisted action endpoint. It binds
// to 127.0.0.1 only — the outside world reaches it exclusively through
// the tunnel the tunnel package supervises.
package server

import (
	"embed"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/centrual/cuxdeck/internal/auth"
	"github.com/centrual/cuxdeck/internal/cuxcli"
	"github.com/centrual/cuxdeck/internal/cuxdata"
)

//go:embed web/index.html
var webFS embed.FS

// Server wires the pieces together.
type Server struct {
	Auth    *auth.Store
	Version string
}

// Handler returns the full route table.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /", s.panel)
	mux.HandleFunc("POST /api/pair", s.pair)
	mux.HandleFunc("GET /api/deck", s.authed(s.deck))
	mux.HandleFunc("POST /api/action", s.authed(s.action))
	mux.HandleFunc("GET /api/devices", s.authed(s.devices))
	mux.HandleFunc("POST /api/devices/revoke", s.authed(s.revoke))
	return securityHeaders(mux)
}

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("Content-Security-Policy", "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'")
		next.ServeHTTP(w, r)
	})
}

func (s *Server) panel(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/" {
		http.NotFound(w, r)
		return
	}
	b, _ := webFS.ReadFile("web/index.html")
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_, _ = w.Write(b)
}

// authed guards an endpoint with the device-token check. The token
// travels in the Authorization header; nothing sensitive ever rides
// the URL, so tunnel/browser logs stay clean.
func (s *Server) authed(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tok := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		if tok == "" || !s.Auth.Authenticate(tok) {
			http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
			return
		}
		next(w, r)
	}
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

func (s *Server) pair(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Code string `json:"code"`
		Name string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		http.Error(w, `{"error":"bad request"}`, http.StatusBadRequest)
		return
	}
	token, err := s.Auth.Pair(strings.ToUpper(strings.TrimSpace(in.Code)), in.Name)
	if err != nil {
		time.Sleep(time.Second) // pairing brute force is pointless too
		http.Error(w, `{"error":"invalid or expired code"}`, http.StatusForbidden)
		return
	}
	writeJSON(w, map[string]string{"token": token})
}

func (s *Server) deck(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, cuxdata.Snapshot(s.Version, time.Now))
}

func (s *Server) action(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Action string            `json:"action"`
		Args   map[string]string `json:"args"`
	}
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		http.Error(w, `{"error":"bad request"}`, http.StatusBadRequest)
		return
	}
	res, err := cuxcli.Do(in.Action, in.Args)
	if err != nil {
		http.Error(w, `{"error":"`+err.Error()+`"}`, http.StatusBadRequest)
		return
	}
	writeJSON(w, res)
}

func (s *Server) devices(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, s.Auth.Devices())
}

func (s *Server) revoke(w http.ResponseWriter, r *http.Request) {
	var in struct {
		ID string `json:"id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		http.Error(w, `{"error":"bad request"}`, http.StatusBadRequest)
		return
	}
	s.Auth.Revoke(in.ID)
	writeJSON(w, map[string]bool{"ok": true})
}
