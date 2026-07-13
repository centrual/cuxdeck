// Package push delivers Web Push notifications straight from this
// machine to the browsers paired with it — no third party in the
// middle. A VAPID keypair (generated once, kept under ~/.cuxdeck)
// identifies this deck to the browsers' push services; subscriptions
// are stored locally and keyed by device token, so revoking a device
// silences it. Payloads are the same small JSON the service worker
// renders as a notification.
package push

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"time"

	webpush "github.com/SherClockHolmes/webpush-go"
	"github.com/centrual/cuxdeck/internal/notify"
)

// Event is re-exported from notify so callers can keep using push.Event
// while the watcher speaks the shared type.
type Event = notify.Event

type sub struct {
	Device       string                `json:"device"` // owning device token (SHA-256 hex)
	Subscription *webpush.Subscription `json:"subscription"`
}

// Store holds the VAPID keys and the live subscriptions.
type Store struct {
	dir  string
	mu   sync.Mutex
	priv string
	pub  string
	subs []sub
}

// Open loads (or creates) the VAPID keypair and any saved subscriptions
// under dir.
func Open(dir string) (*Store, error) {
	s := &Store{dir: dir}
	if err := s.loadVAPID(); err != nil {
		return nil, err
	}
	s.loadSubs()
	return s, nil
}

// PublicKey is handed to the browser so it can subscribe to this deck.
func (s *Store) PublicKey() string { return s.pub }

func (s *Store) loadVAPID() error {
	p := filepath.Join(s.dir, "vapid.json")
	if b, err := os.ReadFile(p); err == nil {
		var v struct{ Priv, Pub string }
		if json.Unmarshal(b, &v) == nil && v.Priv != "" && v.Pub != "" {
			s.priv, s.pub = v.Priv, v.Pub
			return nil
		}
	}
	priv, pub, err := webpush.GenerateVAPIDKeys()
	if err != nil {
		return err
	}
	s.priv, s.pub = priv, pub
	_ = os.MkdirAll(s.dir, 0o700)
	b, _ := json.Marshal(struct{ Priv, Pub string }{priv, pub})
	_ = os.WriteFile(p, b, 0o600)
	return nil
}

func (s *Store) subsPath() string { return filepath.Join(s.dir, "push-subs.json") }

func (s *Store) loadSubs() {
	if b, err := os.ReadFile(s.subsPath()); err == nil {
		_ = json.Unmarshal(b, &s.subs)
	}
}

func (s *Store) saveLocked() {
	b, _ := json.Marshal(s.subs)
	_ = os.WriteFile(s.subsPath(), b, 0o600)
}

// Subscribe records (or refreshes) a browser subscription for a device.
// A device replaces its own prior subscription so re-enabling doesn't
// pile up duplicates.
func (s *Store) Subscribe(device string, w *webpush.Subscription) {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := s.subs[:0]
	for _, e := range s.subs {
		if !(e.Device == device || (e.Subscription != nil && w != nil && e.Subscription.Endpoint == w.Endpoint)) {
			out = append(out, e)
		}
	}
	s.subs = append(out, sub{Device: device, Subscription: w})
	s.saveLocked()
}

// Unsubscribe drops every subscription owned by a device (called on
// device revoke and on explicit disable).
func (s *Store) Unsubscribe(device string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := s.subs[:0]
	for _, e := range s.subs {
		if e.Device != device {
			out = append(out, e)
		}
	}
	s.subs = out
	s.saveLocked()
}

// Has reports whether any subscriptions exist (so the watcher can skip
// work when nobody's listening).
func (s *Store) Has() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.subs) > 0
}

// Notify sends ev to every subscription. Subscriptions the push
// service reports as gone (404/410) are pruned.
func (s *Store) Notify(ev Event) {
	s.mu.Lock()
	priv, pub := s.priv, s.pub
	targets := make([]sub, len(s.subs))
	copy(targets, s.subs)
	s.mu.Unlock()

	payload, _ := json.Marshal(ev)
	var dead []string
	for _, t := range targets {
		if t.Subscription == nil {
			continue
		}
		resp, err := webpush.SendNotification(payload, t.Subscription, &webpush.Options{
			Subscriber:      "cuxdeck@localhost",
			VAPIDPublicKey:  pub,
			VAPIDPrivateKey: priv,
			TTL:             120,
			Urgency:         webpush.UrgencyHigh,
		})
		if err != nil {
			continue
		}
		code := resp.StatusCode
		_ = resp.Body.Close()
		if code == 404 || code == 410 {
			dead = append(dead, t.Subscription.Endpoint)
		}
	}
	if len(dead) > 0 {
		s.pruneEndpoints(dead)
	}
}

func (s *Store) pruneEndpoints(endpoints []string) {
	gone := map[string]bool{}
	for _, e := range endpoints {
		gone[e] = true
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	out := s.subs[:0]
	for _, e := range s.subs {
		if e.Subscription == nil || !gone[e.Subscription.Endpoint] {
			out = append(out, e)
		}
	}
	s.subs = out
	s.saveLocked()
}

// for tests / callers that want a stamped clock without importing time
var _ = time.Now
