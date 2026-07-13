// Package server is cuxdeck's HTTP surface: the embedded mobile panel,
// the deck snapshot API, and the allowlisted action endpoint. It binds
// to 127.0.0.1 only — the outside world reaches it exclusively through
// the tunnel the tunnel package supervises.
package server

import (
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"encoding/json"
	"net"
	"net/http"
	"strings"
	"time"

	webpush "github.com/SherClockHolmes/webpush-go"
	"github.com/centrual/cuxdeck/internal/auth"
	"github.com/centrual/cuxdeck/internal/cuxcli"
	"github.com/centrual/cuxdeck/internal/cuxdata"
	"github.com/centrual/cuxdeck/internal/push"
	"github.com/centrual/cuxdeck/internal/spawn"
	"github.com/centrual/cuxdeck/internal/telegram"
	"github.com/centrual/cuxdeck/internal/usagelog"
)

//go:generate go run ../../tools/buildweb

//go:embed web
var webFS embed.FS

// Server wires the pieces together.
type Server struct {
	Auth    *auth.Store
	Push    *push.Store
	TG      *telegram.Store
	Usage   *usagelog.Store
	Version string
	// StartAtLogin state + toggle, injected from main (which owns the
	// OS-specific service code). Nil when unavailable.
	StartAtLoginState func() bool
	SetStartAtLogin   func(on bool) error
}

// Handler returns the full route table.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /", s.panel)
	mux.HandleFunc("POST /api/pair", s.pair)
	mux.HandleFunc("GET /api/deck", s.authed(s.deck))
	mux.HandleFunc("GET /api/me", s.authed(s.me))
	mux.HandleFunc("POST /api/invite", s.controlled(s.invite))
	mux.HandleFunc("POST /api/action", s.controlled(s.action))
	mux.HandleFunc("GET /api/session/{pid}/chat", s.authed(s.chatStream))
	mux.HandleFunc("GET /api/conversations", s.authed(s.conversations))
	mux.HandleFunc("GET /api/conversation/{id}/chat", s.authed(s.conversationChat))
	mux.HandleFunc("GET /api/session/{pid}/term", s.controlled(s.termBridge))
	mux.HandleFunc("GET /api/devices", s.authed(s.devices))
	mux.HandleFunc("POST /api/devices/revoke", s.controlled(s.revoke))
	mux.HandleFunc("POST /api/spawn", s.controlled(s.spawn))
	mux.HandleFunc("GET /api/push/key", s.authed(s.pushKey))
	mux.HandleFunc("POST /api/push/subscribe", s.authed(s.pushSubscribe))
	mux.HandleFunc("POST /api/push/unsubscribe", s.authed(s.pushUnsubscribe))
	mux.HandleFunc("GET /api/telegram/status", s.authed(s.tgStatus))
	mux.HandleFunc("POST /api/telegram/token", s.authed(s.tgToken))
	mux.HandleFunc("POST /api/telegram/poll", s.authed(s.tgPoll))
	mux.HandleFunc("POST /api/telegram/disconnect", s.authed(s.tgDisconnect))
	mux.HandleFunc("GET /api/usage/history", s.authed(s.usageHistory))
	mux.HandleFunc("GET /api/service", s.authed(s.serviceGet))
	mux.HandleFunc("POST /api/service", s.controlled(s.serviceSet))
	mux.HandleFunc("POST /local/pairing", s.localOnly(s.newPairing))
	return securityHeaders(mux)
}

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Referrer-Policy", "no-referrer")
		// The fleet view is assembled in the browser: a phone paired to
		// one deck fetches /api/deck (and opens chat/term streams) on
		// every *other* deck's tunnel origin. Those are cross-origin, so
		// the API surface opts into CORS. This is safe because every
		// /api route is bearer-token authed — we trust the token, never
		// the Origin — so "*" grants nothing a valid token wouldn't.
		// The panel HTML and /local/pairing are same-origin/loopback and
		// deliberately excluded.
		if strings.HasPrefix(r.URL.Path, "/api/") {
			h.Set("Access-Control-Allow-Origin", "*")
			h.Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
			h.Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
			h.Set("Access-Control-Max-Age", "600")
			if r.Method == http.MethodOptions {
				w.WriteHeader(http.StatusNoContent)
				return
			}
		}
		// connect-src must allow the other decks the phone talks to:
		// their Quick Tunnels (https/wss) and — for same-machine or
		// dev fleets — loopback. img-src allows the inline data: URI
		// favicon. Everything else stays 'self'.
		h.Set("Content-Security-Policy",
			"default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:; "+
				"connect-src 'self' https://*.trycloudflare.com wss://*.trycloudflare.com "+
				"http://127.0.0.1:* ws://127.0.0.1:* http://localhost:* ws://localhost:*")
		next.ServeHTTP(w, r)
	})
}

// panel serves the React app shell and its two static assets. Anything
// else under / is a 404 — the app is exactly index.html + app.js +
// style.css + the mascot, all embedded in the binary.
func (s *Server) panel(w http.ResponseWriter, r *http.Request) {
	ctype := map[string]string{
		"/":                     "text/html; charset=utf-8",
		"/app.js":               "text/javascript; charset=utf-8",
		"/style.css":            "text/css; charset=utf-8",
		"/onion.svg":            "image/svg+xml",
		"/sw.js":                "text/javascript; charset=utf-8",
		"/manifest.webmanifest": "application/manifest+json",
	}[r.URL.Path]
	if ctype == "" {
		http.NotFound(w, r)
		return
	}
	name := r.URL.Path
	if name == "/" {
		name = "/index.html"
	}
	b, err := webFS.ReadFile("web" + name)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", ctype)
	_, _ = w.Write(b)
}

// authed guards an endpoint with the device-token check. The token
// travels in the Authorization header; nothing sensitive ever rides
// the URL, so tunnel/browser logs stay clean.
func (s *Server) authed(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tok := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		if tok == "" {
			// EventSource (SSE) cannot set headers, so the chat stream
			// passes the device token as a query param over the
			// already-TLS'd tunnel. Same token, same check.
			tok = r.URL.Query().Get("token")
		}
		if tok == "" || !s.Auth.Authenticate(tok) {
			http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
			return
		}
		next(w, r)
	}
}

// controlled guards mutating endpoints: authed, and the device must
// hold the control role. View-only devices (shared read-only access)
// get 403 here, so a teammate you gave a look can never switch a seat,
// spawn a session, drive a terminal, or invite others.
func (s *Server) controlled(next http.HandlerFunc) http.HandlerFunc {
	return s.authed(func(w http.ResponseWriter, r *http.Request) {
		tok := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		if tok == "" {
			tok = r.URL.Query().Get("token")
		}
		if s.Auth.Role(tok) != auth.RoleControl {
			http.Error(w, `{"error":"this device has view-only access"}`, http.StatusForbidden)
			return
		}
		next(w, r)
	})
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

// spawn launches a new cux session in a chosen directory. The panel
// then opens the terminal view on the returned pid.
func (s *Server) spawn(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Dir  string   `json:"dir"`
		Argv []string `json:"argv,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		http.Error(w, `{"error":"bad request"}`, http.StatusBadRequest)
		return
	}
	pid, err := spawn.Start(in.Dir, in.Argv)
	if err != nil {
		http.Error(w, `{"error":"`+err.Error()+`"}`, http.StatusBadRequest)
		return
	}
	writeJSON(w, map[string]int{"pid": pid})
}

// deviceKey derives a stable per-device id from the bearer token, so a
// push subscription can be tied to (and later cleaned up with) the
// device that made it without storing the raw token.
func deviceKey(r *http.Request) string {
	tok := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	if tok == "" {
		tok = r.URL.Query().Get("token")
	}
	sum := sha256.Sum256([]byte(tok))
	return hex.EncodeToString(sum[:])
}

func (s *Server) pushKey(w http.ResponseWriter, r *http.Request) {
	if s.Push == nil {
		http.Error(w, `{"error":"push unavailable"}`, http.StatusServiceUnavailable)
		return
	}
	writeJSON(w, map[string]string{"publicKey": s.Push.PublicKey()})
}

func (s *Server) pushSubscribe(w http.ResponseWriter, r *http.Request) {
	if s.Push == nil {
		http.Error(w, `{"error":"push unavailable"}`, http.StatusServiceUnavailable)
		return
	}
	var sub webpush.Subscription
	if err := json.NewDecoder(r.Body).Decode(&sub); err != nil || sub.Endpoint == "" {
		http.Error(w, `{"error":"bad subscription"}`, http.StatusBadRequest)
		return
	}
	s.Push.Subscribe(deviceKey(r), &sub)
	writeJSON(w, map[string]bool{"ok": true})
}

func (s *Server) pushUnsubscribe(w http.ResponseWriter, r *http.Request) {
	if s.Push != nil {
		s.Push.Unsubscribe(deviceKey(r))
	}
	writeJSON(w, map[string]bool{"ok": true})
}

func (s *Server) tgStatus(w http.ResponseWriter, r *http.Request) {
	if s.TG == nil {
		writeJSON(w, map[string]any{"hasToken": false, "linked": false})
		return
	}
	writeJSON(w, s.TG.Status())
}

func (s *Server) tgToken(w http.ResponseWriter, r *http.Request) {
	if s.TG == nil {
		http.Error(w, `{"error":"telegram unavailable"}`, http.StatusServiceUnavailable)
		return
	}
	var in struct {
		Token string `json:"token"`
	}
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil || in.Token == "" {
		http.Error(w, `{"error":"bad request"}`, http.StatusBadRequest)
		return
	}
	if err := s.TG.SetToken(r.Context(), strings.TrimSpace(in.Token)); err != nil {
		http.Error(w, `{"error":"`+err.Error()+`"}`, http.StatusBadRequest)
		return
	}
	writeJSON(w, map[string]bool{"ok": true})
}

func (s *Server) tgPoll(w http.ResponseWriter, r *http.Request) {
	if s.TG == nil {
		http.Error(w, `{"error":"telegram unavailable"}`, http.StatusServiceUnavailable)
		return
	}
	linked, err := s.TG.Poll(r.Context())
	if err != nil {
		http.Error(w, `{"error":"`+err.Error()+`"}`, http.StatusBadRequest)
		return
	}
	writeJSON(w, map[string]bool{"linked": linked})
}

func (s *Server) tgDisconnect(w http.ResponseWriter, r *http.Request) {
	if s.TG != nil {
		s.TG.Disconnect()
	}
	writeJSON(w, map[string]bool{"ok": true})
}

func (s *Server) serviceGet(w http.ResponseWriter, r *http.Request) {
	if s.StartAtLoginState == nil {
		writeJSON(w, map[string]any{"supported": false, "enabled": false})
		return
	}
	writeJSON(w, map[string]any{"supported": true, "enabled": s.StartAtLoginState()})
}

func (s *Server) serviceSet(w http.ResponseWriter, r *http.Request) {
	if s.SetStartAtLogin == nil {
		http.Error(w, `{"error":"not supported here"}`, http.StatusServiceUnavailable)
		return
	}
	var in struct {
		Enabled bool `json:"enabled"`
	}
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		http.Error(w, `{"error":"bad request"}`, http.StatusBadRequest)
		return
	}
	if err := s.SetStartAtLogin(in.Enabled); err != nil {
		http.Error(w, `{"error":"`+err.Error()+`"}`, http.StatusInternalServerError)
		return
	}
	writeJSON(w, map[string]bool{"enabled": in.Enabled})
}

func (s *Server) usageHistory(w http.ResponseWriter, r *http.Request) {
	if s.Usage == nil {
		writeJSON(w, map[string]any{})
		return
	}
	writeJSON(w, s.Usage.History())
}

// me tells the panel this device's role so it can hide controls a
// view-only device isn't allowed to use.
func (s *Server) me(w http.ResponseWriter, r *http.Request) {
	tok := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	if tok == "" {
		tok = r.URL.Query().Get("token")
	}
	writeJSON(w, map[string]string{"role": s.Auth.Role(tok)})
}

// invite mints a pairing code from the panel (remotely), with a chosen
// role — this is how a teammate is added without physical access to
// the machine. control-only, via s.controlled.
func (s *Server) invite(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Role string `json:"role"`
	}
	_ = json.NewDecoder(r.Body).Decode(&in)
	writeJSON(w, map[string]string{"code": s.Auth.NewPairingCode(in.Role)})
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

// localOnly guards endpoints that must never be reachable through the
// tunnel. External requests arrive via cloudflared, which always adds
// Cf-* headers and carries the public hostname — a request with a
// loopback Host and no Cf-Connecting-Ip can only have originated on
// this machine, where the caller could read ~/.cuxdeck anyway.
func (s *Server) localOnly(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		host := r.Host
		if h, _, err := netSplitHost(host); err == nil {
			host = h
		}
		if r.Header.Get("Cf-Connecting-Ip") != "" ||
			(host != "127.0.0.1" && host != "localhost" && host != "::1") {
			http.Error(w, `{"error":"local only"}`, http.StatusForbidden)
			return
		}
		next(w, r)
	}
}

// newPairing mints a fresh single-use code for `cuxdeck qr` and the
// menu bar's pair action.
func (s *Server) newPairing(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, map[string]string{"code": s.Auth.NewPairingCode(auth.RoleControl)})
}

func netSplitHost(hostport string) (string, string, error) {
	return net.SplitHostPort(hostport)
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b [20]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	return string(b[i:])
}
